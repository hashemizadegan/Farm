/**
 * Carries out the legs we sign. Each tick: start issuance for paid subscriptions and approved
 * registrations, create the Merkle trees registrations need, give every live intent an attempt, move
 * every unfinished attempt one step along its lifecycle
 * (requested → policy_approved → prepared → submitted → observed → confirmed → business_completed),
 * and confirm minted compressed NFTs through DAS.
 *
 * Crash-safe by construction: the signed transaction is stored before it is sent, it is only ever
 * re-sent byte for byte, and a new attempt is made only after the previous one provably expired.
 * Network and signing calls happen outside database transactions; each result is written under a
 * row lock after checking the attempt is still where it was.
 *
 * An attempt observed as expired or failed is not taken as proof that nothing happened on chain:
 * before a tree is given up or a leaf position is handed to another mint, the tree is read back at
 * finalized commitment once its blockhash can no longer land. Until that answer is definitive the
 * work stays where it is; a position the chain shows as taken opens a reconciliation case.
 */
import {
  activateLeaf,
  activateMerkleTree,
  assignTree,
  complianceView,
  createIssuanceIntent,
  currentMerkleTree,
  failMerkleTree,
  getMerkleTree,
  getRegistration,
  leafForConfirmation,
  leavesToConfirm,
  markMerkleTreeCreating,
  openReconciliationCases,
  planMerkleTree,
  recordLeafMinted,
  recordPlannedLeaf,
  registrationsToAdvance,
  releasePlannedLeaf,
  treesToDrive,
  createOperation,
  createSettlementIntent,
  getOperation,
  getOrder,
  getRepresentation,
  intentsToDrive,
  issuanceContext,
  latestOperation,
  moveOperation,
  noteOperation,
  plannedLeafOfIntent,
  operationsToDrive,
  orderForReconciliation,
  ordersToAdvance,
  setIntentStatus,
  setOrderStatus,
  settlementContext,
  withSystem,
  withTenant,
  type OperationRow,
  type Pool,
  type TenantTx,
} from "@metafarm/db";
import {
  ORDER_LEGS,
  complianceDecision,
  firstLegMayStart,
  legNeedsAttention,
  networkAllowed,
  railOf,
  secondLegMayStart,
  stepsAfterObservation,
  treeAcceptsMint,
  type AssetIssuancePort,
  type ChainObservationPort,
  type CompressedAssetPort,
  type CompressedIssuancePort,
  type CompliancePolicy,
  type Network,
  type OperationState,
  type PreparedTransaction,
  type SettlementPort,
} from "@metafarm/domain";

/** Compressed NFTs (Bubblegum) on the Solana rail: trees, leaves and the DAS index that confirms them. */
export interface CompressedRail {
  issuance: CompressedIssuancePort;
  assets: CompressedAssetPort;
  /** The platform signer: every tree's creator, so the only one who can mint into it. */
  creator: string;
  /** Shape of each new tree (from planTree); capacity is 2^maxDepth. */
  treeShape: { maxDepth: number; maxBufferSize: number; canopyDepth: number; capacity: number };
}

export interface Rails {
  solana?: { network: Network; issuance: AssetIssuancePort; observer: ChainObservationPort; compressed?: CompressedRail };
  /** Payouts leave from the treasury, which is the TRON signer. */
  tron?: { network: Network; settlement: SettlementPort; observer: ChainObservationPort; treasury: string };
}

export interface EngineDeps {
  pool: Pool;
  rails: Rails;
  policy: CompliancePolicy;
  mainnetEnabled: boolean;
  now: () => Date;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface TickSummary {
  started: number;
  attempts: number;
  moves: number;
  /** Compressed NFTs DAS confirmed this tick. */
  confirmed: number;
}

export async function runTick(d: EngineDeps): Promise<TickSummary> {
  const started = (await advanceOrders(d)) + (await advanceRegistrations(d));
  const attempts = (await driveTrees(d)) + (await driveIntents(d));
  const moves = await driveOperations(d);
  const confirmed = await confirmLeaves(d);
  return { started, attempts, moves, confirmed };
}

/** Runs `fn` in a savepoint; a unique violation (someone else got there first) is undone and reported as false. */
async function unlessTaken(tx: TenantTx, name: string, fn: () => Promise<unknown>): Promise<boolean> {
  await tx.query(`SAVEPOINT ${name}`);
  try {
    await fn();
    await tx.query(`RELEASE SAVEPOINT ${name}`);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return false;
  }
}

/**
 * Starts the leaf of each approved registration: plans a tree when the workspace has none, waits
 * for it to be created, then puts the leaf in it and creates its one mint intent. The database
 * keeps one mint in flight per tree (the next leaf index is the tree's count), so a registration
 * whose tree is busy simply waits for a later tick.
 */
async function advanceRegistrations(d: EngineDeps): Promise<number> {
  const solana = d.rails.solana;
  const c = solana?.compressed;
  if (!solana || !c) return 0;
  let n = 0;
  for (const o of await withSystem(d.pool, (tx) => registrationsToAdvance(tx))) {
    n += await withTenant(d.pool, o.tenant_id, async (tx) => {
      const reg = await getRegistration(tx, o.id, true);
      if (!reg || reg.status !== "issuing" || reg.network !== solana.network) return 0;
      const view = await orderForReconciliation(tx, o.id);
      if (!view) return 0;
      if (legNeedsAttention(view.order, view.intents)) {
        await setOrderStatus(tx, o.id, "exception");
        return 0;
      }
      if (!firstLegMayStart(view.order, view.intents)) return 0;
      // A leaf is put in a tree only together with its mint intent, so one already in a tree here is unexpected.
      if (reg.tree_id) return 0;
      const tree = await currentMerkleTree(tx, solana.network);
      if (!tree) {
        const s = c.treeShape;
        const planned = await unlessTaken(tx, "plan_tree", () =>
          planMerkleTree(tx, { network: solana.network, maxDepth: s.maxDepth, maxBufferSize: s.maxBufferSize, canopyDepth: s.canopyDepth, capacity: BigInt(s.capacity), creatorAddress: c.creator, createdBy: null }),
        );
        return planned ? 1 : 0;
      }
      if (!treeAcceptsMint({ status: tree.status, mintedCount: BigInt(tree.minted_count), capacity: BigInt(tree.capacity) })) return 0;
      const started = await unlessTaken(tx, "start_leaf", async () => {
        if (!(await assignTree(tx, reg.representation_id, tree.id))) throw new Error("the leaf is already in another tree");
        await createIssuanceIntent(tx, {
          representationId: reg.representation_id,
          action: "mint",
          amount: 1n,
          holder: reg.custodian_address,
          reconciliationId: reg.reconciliation_id,
          partyId: reg.party_id,
          decision: { reason: "registration approved by a second person" },
        });
      });
      return started ? 1 : 0;
    });
  }
  return n;
}

/**
 * Gives each planned tree one creation attempt and settles the tree from its outcome. An attempt
 * that did not succeed fails the tree only once the chain shows the tree was never created (its
 * address was a key generated for that attempt only, so nothing else can create it later); one that
 * landed anyway activates the tree. The next registration plans a new tree after a failure.
 */
async function driveTrees(d: EngineDeps): Promise<number> {
  const solana = d.rails.solana;
  const c = solana?.compressed;
  if (!solana || !c) return 0;
  let n = 0;
  for (const t of await withSystem(d.pool, (tx) => treesToDrive(tx))) {
    try {
      n += await driveTree(d, solana.network, c, t.tenant_id, t.id);
    } catch (err) {
      d.log.warn({ treeId: t.id, err: (err as Error).message }, "Merkle tree step failed");
    }
  }
  return n;
}

const UNSUCCESSFUL: ReadonlySet<OperationState> = new Set(["failed", "expired", "policy_rejected"]);

async function driveTree(d: EngineDeps, network: Network, c: CompressedRail, tenantId: string, id: string): Promise<number> {
  const seen = await withTenant(d.pool, tenantId, async (tx) => {
    const tree = await getMerkleTree(tx, id);
    if (!tree || tree.network !== network || (tree.status !== "planned" && tree.status !== "creating")) return undefined;
    return { tree, last: await latestOperation(tx, "tree", id) };
  });
  if (!seen) return 0;
  const { tree, last } = seen;

  let action: "create" | "activate" | "fail" | undefined;
  let note: string | undefined;
  if (!last) action = tree.status === "planned" ? "create" : undefined;
  else if (last.state === "business_completed") action = "activate";
  else if (UNSUCCESSFUL.has(last.state)) {
    if (!tree.address) action = "fail"; // never prepared: no transaction could create it
    else {
      const landed = await treeLanded(d, c, network, tree.address, last);
      if (landed === undefined) return 0;
      action = landed ? "activate" : "fail";
      if (landed) note = `the tree exists on chain although this attempt was recorded as ${last.state}`;
    }
  }
  if (!action) return 0;

  return withTenant(d.pool, tenantId, async (tx) => {
    const now = await getMerkleTree(tx, id, true);
    const op = await latestOperation(tx, "tree", id);
    if (!now || now.status !== tree.status || op?.id !== last?.id || op?.state !== last?.state) return 0;
    if (action === "create") {
      await createOperation(tx, "tree", id, 1, now.network);
      return 1;
    }
    if (action === "activate") {
      if (!(await activateMerkleTree(tx, id))) return 0;
      if (note && last) {
        await noteOperation(tx, last.id, note);
        d.log.warn({ treeId: id, operationId: last.id, state: last.state }, "tree creation landed although it was not observed to");
      }
      return 1;
    }
    return (await failMerkleTree(tx, id)) ? 1 : 0;
  });
}

/**
 * Whether a tree whose creation did not end well exists on chain: true or false once that is
 * definitive, undefined while the transaction could still land or the chain cannot be read.
 */
async function treeLanded(d: EngineDeps, c: CompressedRail, network: Network, address: string, op: OperationRow): Promise<boolean | undefined> {
  let s;
  try {
    s = await c.issuance.readTree(network, address);
  } catch (err) {
    d.log.warn({ tree: address, err: (err as Error).message }, "could not read the tree from the chain; trying again later");
    return undefined;
  }
  if (s.tree) {
    if (s.tree.creator === c.creator) return true;
    d.log.warn({ tree: address, creator: s.tree.creator }, "the tree on chain was created by someone else; leaving it for a person");
    return undefined;
  }
  if (!stillCouldLand(op, s.finalizedBlockHeight)) return false;
  return undefined;
}

/** True while the attempt's blockhash is still valid at the finalized height, or its validity is unknown. */
function stillCouldLand(op: OperationRow, finalizedBlockHeight: bigint): boolean {
  if (op.signed_wire === null) return false; // never signed: nothing could land
  if (op.last_valid_block_height === null) return true;
  return finalizedBlockHeight <= BigInt(op.last_valid_block_height);
}

/**
 * Confirms minted leaves through DAS: the indexed asset must be the expected asset id, in the
 * expected tree at the expected index, owned by the custodian, and its proof (checked against the
 * roots the tree accepts on chain) must carry the leaf hash computed when the mint was prepared,
 * which commits to the owner and the metadata. Until the indexer catches up, or while its proof is
 * stale, nothing happens; anything else opens a reconciliation case for a person to look at.
 */
async function confirmLeaves(d: EngineDeps): Promise<number> {
  const solana = d.rails.solana;
  const c = solana?.compressed;
  if (!solana || !c) return 0;
  let n = 0;
  for (const ref of await withSystem(d.pool, (tx) => leavesToConfirm(tx))) {
    try {
      const leaf = await withTenant(d.pool, ref.tenant_id, (tx) => leafForConfirmation(tx, ref.id));
      if (!leaf || leaf.network !== solana.network) continue;
      const asset = await c.assets.getAsset(leaf.network, leaf.das_asset_id);
      if (!asset) continue;
      const expected = { assetId: leaf.das_asset_id, tree: leaf.merkle_tree, leafIndex: leaf.leaf_index, owner: leaf.owner, leafHash: leaf.leaf_hash };
      let observed: Record<string, string | number | null> = { assetId: asset.id, tree: asset.tree, leafIndex: asset.leafIndex, owner: asset.owner, burnt: asset.burnt ? "yes" : "no" };
      let matches =
        asset.id === leaf.das_asset_id && asset.compressed && !asset.burnt && asset.tree === leaf.merkle_tree && String(asset.leafIndex) === leaf.leaf_index && asset.owner === leaf.owner;
      if (matches) {
        // Throws while the indexer is behind the chain (stale proof): tried again next tick.
        const proof = await c.assets.getAssetProof(leaf.network, leaf.das_asset_id);
        const proofIndex = proof.nodeIndex - 2 ** proof.proof.length;
        observed = { ...observed, leafHash: proof.leaf, proofTree: proof.tree, proofLeafIndex: proofIndex, root: proof.root };
        matches = leaf.leaf_hash !== null && proof.leaf === leaf.leaf_hash && proof.tree === leaf.merkle_tree && String(proofIndex) === leaf.leaf_index;
      }
      n += await withTenant(d.pool, ref.tenant_id, async (tx) => {
        if (matches) return (await activateLeaf(tx, ref.id)) ? 1 : 0;
        await openReconciliationCases(tx, leaf.reconciliation_id, [{ kind: "asset_mismatch", expected, observed }]);
        return 0;
      });
    } catch (err) {
      d.log.warn({ representationId: ref.id, err: (err as Error).message }, "compressed NFT confirmation failed");
    }
  }
  return n;
}

/**
 * Starts the next leg of each order in play: a paid subscription's mint; an approved redemption's
 * burn, then its payout; an approved distribution's payout. A leg that ended without completing
 * stops the order for a person to look at.
 */
async function advanceOrders(d: EngineDeps): Promise<number> {
  let n = 0;
  for (const o of await withSystem(d.pool, (tx) => ordersToAdvance(tx))) {
    n += await withTenant(d.pool, o.tenant_id, async (tx) => {
      const order = await getOrder(tx, o.id, true);
      if (!order || (order.status !== "issuing" && order.status !== "settling")) return 0;
      const view = await orderForReconciliation(tx, o.id);
      if (!view) return 0;
      if (legNeedsAttention(view.order, view.intents)) {
        await setOrderStatus(tx, o.id, "exception");
        return 0;
      }
      const legs = ORDER_LEGS[order.kind];
      const leg = firstLegMayStart(view.order, view.intents) ? legs.first : secondLegMayStart(view.order, view.intents) ? legs.second : null;
      if (!leg) return 0;

      if (leg.side === "issuance") {
        const solana = d.rails.solana;
        if (!solana || !order.representation_id || !order.investor_solana_address || !order.share_amount) return 0;
        const rep = await getRepresentation(tx, order.representation_id);
        if (!rep?.mint_address || rep.network !== solana.network) return 0;
        await createIssuanceIntent(tx, {
          representationId: rep.id,
          action: leg.action,
          amount: BigInt(order.share_amount),
          holder: order.investor_solana_address,
          reconciliationId: order.reconciliation_id,
          partyId: order.party_id,
          decision: { reason: order.kind === "subscription" ? "subscription payment verified on chain" : "approved by a second person" },
        });
        if (order.status !== "issuing") await setOrderStatus(tx, o.id, "issuing");
        return 1;
      }
      // Investors pay subscriptions themselves; the engine only pays out.
      if (leg.purpose === "subscription") return 0;
      const tron = d.rails.tron;
      if (!tron || tron.network !== order.settlement_network || !order.investor_tron_address) return 0;
      await createSettlementIntent(tx, {
        network: order.settlement_network,
        tokenContract: order.token_contract,
        purpose: leg.purpose === "redemption" ? "redemption" : "distribution",
        payer: tron.treasury,
        payee: order.investor_tron_address,
        amount: BigInt(order.settlement_amount),
        reconciliationId: order.reconciliation_id,
        partyId: order.party_id,
        decision: { reason: "approved by a second person" },
      });
      if (order.status !== "settling") await setOrderStatus(tx, o.id, "settling");
      return 1;
    });
  }
  return n;
}

/**
 * Every live intent has exactly one live attempt; finished attempts settle the intent. A compressed
 * mint that did not succeed keeps its leaf position until the chain shows the position unused: only
 * then is it given back (or tried again). A position the chain shows as taken ends the intent and
 * opens a case: the leaf may exist, so it is neither minted again nor handed to another asset.
 */
async function driveIntents(d: EngineDeps): Promise<number> {
  let n = 0;
  for (const i of await withSystem(d.pool, (tx) => intentsToDrive(tx))) {
    try {
      n += await driveIntent(d, i.tenant_id, i.type, i.id);
    } catch (err) {
      d.log.warn({ intentId: i.id, err: (err as Error).message }, "RWA intent step failed");
    }
  }
  return n;
}

const SETTLED = { business_completed: "completed", failed: "failed", policy_rejected: "policy_rejected" } as const;

async function driveIntent(d: EngineDeps, tenantId: string, type: "issuance" | "settlement", id: string): Promise<number> {
  const seen = await withTenant(d.pool, tenantId, async (tx) => ({
    last: await latestOperation(tx, type, id),
    leaf: type === "issuance" ? await plannedLeafOfIntent(tx, id) : undefined,
  }));
  const { last, leaf } = seen;

  // A compressed mint that did not succeed: has its leaf position been used on chain?
  let taken: { numMinted: bigint } | false = false;
  if (last && leaf && UNSUCCESSFUL.has(last.state)) {
    const fate = await leafFate(d, leaf, last);
    if (fate === undefined) return 0; // not definitive yet: hold the position (and so the tree)
    taken = fate;
  }

  return withTenant(d.pool, tenantId, async (tx) => {
    const table = type === "issuance" ? "issuance_intents" : "settlement_intents";
    const live = await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND id = $2 AND status IN ('approved', 'in_progress') FOR UPDATE`, [tx.tenantId, id]);
    if (!live.rowCount) return 0;
    const now = await latestOperation(tx, type, id);
    if (now?.id !== last?.id || now?.state !== last?.state) return 0;

    if (taken && last && leaf) {
      await setIntentStatus(tx, type, id, "failed");
      await noteOperation(tx, last.id, `leaf ${leaf.leaf_index} of tree ${leaf.merkle_tree} is in use on chain although this attempt was recorded as ${last.state}`);
      // The leaf exists on chain, so it counts toward the tree's capacity whatever a person decides.
      await recordLeafMinted(tx, leaf.tree_id);
      await openReconciliationCases(tx, leaf.reconciliation_id, [
        {
          kind: "orphan_chain_tx",
          expected: { outcome: `not minted (attempt ${last.attempt} ${last.state})`, tree: leaf.merkle_tree, leafIndex: leaf.leaf_index, assetId: leaf.das_asset_id, txRef: last.tx_ref },
          observed: { treeNumMinted: taken.numMinted.toString(), note: "the leaf position was used on chain; check the asset through DAS before releasing or retrying" },
        },
      ]);
      d.log.warn({ intentId: id, operationId: last.id, tree: leaf.merkle_tree, leafIndex: leaf.leaf_index }, "compressed mint landed although it was not observed to; reconciliation case opened");
      return 0;
    }
    if (last && last.state in SETTLED) {
      const status = SETTLED[last.state as keyof typeof SETTLED];
      await setIntentStatus(tx, type, id, status);
      // Definitively unused on chain: the position goes back to the next mint into this tree.
      if (status !== "completed" && leaf) await releasePlannedLeaf(tx, leaf.representation_id);
      return 0;
    }
    if (last && last.state !== "expired") return 0;
    const network = await intentNetwork(tx, type, id);
    if (!network) return 0;
    await createOperation(tx, type, id, (last?.attempt ?? 0) + 1, network);
    await setIntentStatus(tx, type, id, "in_progress");
    return 1;
  });
}

/**
 * Whether a compressed mint's leaf position was used on chain: the tree's finalized mint count is
 * past the planned index (one mint in flight per tree, and only the platform signer may mint, so
 * that is this mint), `false` once the position is definitively unused, undefined while unknown.
 */
async function leafFate(d: EngineDeps, leaf: { network: Network; merkle_tree: string; leaf_index: string }, op: OperationRow): Promise<{ numMinted: bigint } | false | undefined> {
  const solana = d.rails.solana;
  const c = solana?.compressed;
  if (!c || solana.network !== leaf.network) return undefined;
  let s;
  try {
    s = await c.issuance.readTree(leaf.network, leaf.merkle_tree);
  } catch (err) {
    d.log.warn({ tree: leaf.merkle_tree, err: (err as Error).message }, "could not read the tree from the chain; trying again later");
    return undefined;
  }
  if (!s.tree) {
    d.log.warn({ tree: leaf.merkle_tree }, "the tree of a planned leaf is not on chain; leaving it for a person");
    return undefined;
  }
  if (s.tree.numMinted > BigInt(leaf.leaf_index)) return { numMinted: s.tree.numMinted };
  return stillCouldLand(op, s.finalizedBlockHeight) ? undefined : false;
}

async function intentNetwork(tx: TenantTx, type: "issuance" | "settlement", id: string): Promise<Network | undefined> {
  if (type === "issuance") return (await issuanceContext(tx, id))?.network;
  return (await tx.query<{ network: Network }>(`SELECT network FROM settlement_intents WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id])).rows[0]?.network;
}

function observerFor(d: EngineDeps, network: Network): ChainObservationPort | undefined {
  if (railOf(network) === "solana") return d.rails.solana?.network === network ? d.rails.solana.observer : undefined;
  return d.rails.tron?.network === network ? d.rails.tron.observer : undefined;
}

/** What a prepare call returns: the transaction, plus what a tree or leaf adds about itself. */
type Prepared = PreparedTransaction & { treeAddress?: string; assetId?: string; leafIndex?: bigint; leafHash?: string };

/** What an attempt needs to know about its intent, whichever rail it is on. */
interface Work {
  partyId: string | null;
  /** The investor's wallet the transaction pays or credits (checked by the gate); none for platform-internal work. */
  wallet: { network: Network; address: string } | null;
  prepare: () => Promise<Prepared> | undefined;
  /** Written in the same transaction that records the attempt as prepared. Throwing undoes both. */
  onPrepared?: (tx: TenantTx, prepared: Prepared) => Promise<void>;
  /** Written in the same transaction that completes the attempt. Throwing undoes both (retried next tick). */
  onConfirmed?: (tx: TenantTx) => Promise<void>;
}

async function workFor(d: EngineDeps, tx: TenantTx, op: OperationRow): Promise<Work | undefined> {
  if (op.intent_type === "tree") {
    const tree = await getMerkleTree(tx, op.intent_id);
    if (!tree) return undefined;
    const solana = d.rails.solana;
    return {
      // Platform-internal: no investor and no wallet credited, so only the network gate applies.
      partyId: null,
      wallet: null,
      prepare: () =>
        solana?.compressed && solana.network === op.network && tree.status === "planned"
          ? solana.compressed.issuance.prepareCreateTree({ network: op.network, maxDepth: tree.max_depth, maxBufferSize: tree.max_buffer_size, canopyDepth: tree.canopy_depth })
          : undefined,
      onPrepared: async (tx, prepared) => {
        if (!prepared.treeAddress || !(await markMerkleTreeCreating(tx, tree.id, prepared.treeAddress))) throw new Error("the tree moved on while its creation was being prepared");
      },
    };
  }
  if (op.intent_type === "issuance") {
    const c = await issuanceContext(tx, op.intent_id);
    if (!c) return undefined;
    const solana = d.rails.solana;
    if (c.tree_id) {
      // A compressed NFT: one leaf, minted into its tree, with the metadata fixed at registration.
      const compressed = solana?.compressed;
      const treeAddress = c.tree_address;
      const metadata = c.cnft_metadata;
      const treeId = c.tree_id;
      return {
        partyId: c.party_id,
        wallet: { network: c.network, address: c.holder_address },
        prepare: () =>
          compressed && solana.network === op.network && c.action === "mint" && c.tree_status === "active" && treeAddress && metadata
            ? compressed.issuance.prepareMint({
                network: op.network,
                merkleTree: treeAddress,
                owner: c.holder_address,
                metadata: { name: metadata.name, symbol: metadata.symbol, uri: metadata.uri },
              })
            : undefined,
        onPrepared: async (tx, prepared) => {
          if (!treeAddress || prepared.leafIndex === undefined || !prepared.assetId) throw new Error("the mint did not say which leaf it creates");
          const leaf = { merkleTree: treeAddress, leafIndex: prepared.leafIndex, assetId: prepared.assetId, ...(prepared.leafHash ? { leafHash: prepared.leafHash } : {}) };
          if (!(await recordPlannedLeaf(tx, c.representation_id, leaf))) throw new Error("the leaf is no longer planned");
        },
        onConfirmed: async (tx) => {
          if (!(await recordLeafMinted(tx, treeId))) throw new Error(`tree ${treeId} is not active, so its new leaf cannot be counted`);
        },
      };
    }
    return {
      partyId: c.party_id,
      wallet: { network: c.network, address: c.holder_address },
      prepare: () =>
        solana && solana.network === op.network && c.mint_address && c.decimals !== null
          ? solana.issuance.prepareIssuance({
              network: op.network,
              action: c.action,
              mintAddress: c.mint_address,
              decimals: c.decimals,
              holderAddress: c.holder_address,
              ...(c.amount ? { amount: BigInt(c.amount) } : {}),
            })
          : undefined,
    };
  }
  const c = await settlementContext(tx, op.intent_id);
  if (!c) return undefined;
  const tron = d.rails.tron;
  return {
    partyId: c.party_id,
    wallet: { network: c.network, address: c.payee_address },
    prepare: () =>
      tron && tron.network === op.network && c.payer_address === tron.treasury
        ? tron.settlement.prepareTransfer({ network: op.network, tokenContract: c.token_contract, from: c.payer_address, to: c.payee_address, amount: BigInt(c.amount) })
        : undefined,
  };
}

function preparedFrom(op: OperationRow): PreparedTransaction {
  return {
    network: op.network,
    txRef: op.tx_ref!,
    wire: op.signed_wire!,
    validity: { ...(op.last_valid_block_height ? { lastValidBlockHeight: BigInt(op.last_valid_block_height) } : {}), ...(op.expires_at ? { expiresAt: op.expires_at } : {}) },
    fees: {},
    summary: {},
  };
}

/** Writes a step if the attempt is still in the state we acted on. */
async function step(d: EngineDeps, tenantId: string, op: OperationRow, apply: (tx: TenantTx) => Promise<void>): Promise<boolean> {
  return withTenant(d.pool, tenantId, async (tx) => {
    const now = await getOperation(tx, op.id, true);
    if (!now || now.state !== op.state) return false;
    await apply(tx);
    return true;
  });
}

async function driveOperations(d: EngineDeps): Promise<number> {
  let moves = 0;
  for (const ref of await withSystem(d.pool, (tx) => operationsToDrive(tx))) {
    try {
      moves += await driveOne(d, ref.tenant_id, ref.id);
    } catch (err) {
      // One stuck attempt must not hold up the others; it is tried again next tick.
      d.log.warn({ operationId: ref.id, err: (err as Error).message }, "RWA operation step failed");
    }
  }
  return moves;
}

async function driveOne(d: EngineDeps, tenantId: string, id: string): Promise<number> {
  const loaded = await withTenant(d.pool, tenantId, async (tx) => {
    const op = await getOperation(tx, id);
    return op ? { op, work: await workFor(d, tx, op) } : undefined;
  });
  if (!loaded?.work) return 0;
  const { op, work } = loaded;
  const table = op.intent_type === "issuance" ? "issuance_intents" : op.intent_type === "settlement" ? "settlement_intents" : null;

  switch (op.state) {
    case "requested": {
      // Compliance and network gates, decided now (KYC or screenings may have changed since the order).
      const verdict = await withTenant(d.pool, tenantId, async (tx) => {
        if (!networkAllowed(op.network, { mainnetEnabled: d.mainnetEnabled })) return { allowed: false, reasons: ["network_not_enabled"] };
        // Platform-internal work (creating a tree) moves no money and credits no wallet.
        if (!work.wallet) return op.intent_type === "tree" ? { allowed: true, reasons: [] } : { allowed: false, reasons: ["no_wallet"] };
        if (!work.partyId) return { allowed: false, reasons: ["no_party"] };
        const view = await complianceView(tx, work.partyId, [work.wallet]);
        return view ? complianceDecision(view.party, view.wallets, d.policy, d.now()) : { allowed: false, reasons: ["no_party"] };
      });
      const ok = await step(d, tenantId, op, async (tx) => {
        if (table) {
          await tx.query(`UPDATE ${table} SET policy_decision = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
            tx.tenantId,
            op.intent_id,
            JSON.stringify({ ...verdict, at: d.now().toISOString() }),
          ]);
        }
        await moveOperation(tx, op.id, verdict.allowed ? "policy_approved" : "policy_rejected", verdict.allowed ? {} : { error: verdict.reasons.join(", ") });
      });
      return ok ? 1 : 0;
    }
    case "policy_approved": {
      const pending = work.prepare();
      if (!pending) return 0;
      const prepared = await pending;
      const ok = await step(d, tenantId, op, async (tx) => {
        await moveOperation(tx, op.id, "prepared", {
          txRef: prepared.txRef,
          signedWire: prepared.wire,
          ...(prepared.validity.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: prepared.validity.lastValidBlockHeight } : {}),
          ...(prepared.validity.expiresAt ? { expiresAt: prepared.validity.expiresAt } : {}),
          ...(prepared.fees.priorityFeeMicroLamports !== undefined ? { priorityFee: prepared.fees.priorityFeeMicroLamports } : {}),
          ...(prepared.fees.feeLimitSun !== undefined ? { feeLimitSun: prepared.fees.feeLimitSun } : {}),
          ...(prepared.fees.estimatedEnergy !== undefined ? { estimatedEnergy: prepared.fees.estimatedEnergy } : {}),
          ...(prepared.fees.estimatedBandwidth !== undefined ? { estimatedBandwidth: prepared.fees.estimatedBandwidth } : {}),
          summary: prepared.summary,
        });
        await work.onPrepared?.(tx, prepared);
      });
      return ok ? 1 : 0;
    }
    case "prepared": {
      const observer = observerFor(d, op.network);
      if (!observer) return 0;
      try {
        await observer.submit(preparedFrom(op));
      } catch (err) {
        if ((err as { definitive?: boolean }).definitive) {
          return (await step(d, tenantId, op, (tx) => moveOperation(tx, op.id, "failed", { error: (err as Error).message }))) ? 1 : 0;
        }
        // Not definitive: it may or may not have reached the network. Let the chain decide.
        return observeAndMove(d, tenantId, op, observer);
      }
      return (await step(d, tenantId, op, (tx) => moveOperation(tx, op.id, "submitted"))) ? 1 : 0;
    }
    case "submitted":
    case "observed": {
      const observer = observerFor(d, op.network);
      return observer ? observeAndMove(d, tenantId, op, observer) : 0;
    }
    case "confirmed":
      return (await step(d, tenantId, op, async (tx) => {
        await moveOperation(tx, op.id, "business_completed");
        await work.onConfirmed?.(tx);
      }))
        ? 1
        : 0;
    default:
      return 0;
  }
}

async function observeAndMove(d: EngineDeps, tenantId: string, op: OperationRow, observer: ChainObservationPort): Promise<number> {
  const obs = await observer.observe({
    network: op.network,
    txRef: op.tx_ref!,
    ...(op.last_valid_block_height ? { lastValidBlockHeight: BigInt(op.last_valid_block_height) } : {}),
    ...(op.expires_at ? { expiresAt: op.expires_at } : {}),
  });
  const steps = stepsAfterObservation(op.state, obs);
  if (steps.length === 0) {
    // Still pending: re-send the very same signed bytes (it cannot land twice).
    if (obs.status === "pending" || obs.status === "not_found") await observer.submit(preparedFrom(op)).catch(() => undefined);
    return 0;
  }
  const ok = await step(d, tenantId, op, async (tx) => {
    for (const s of steps) {
      await moveOperation(tx, op.id, s, {
        ...(obs.slotOrBlock !== undefined ? { slotOrBlock: obs.slotOrBlock } : {}),
        ...(obs.confirmations !== undefined ? { confirmations: obs.confirmations } : {}),
        ...(obs.feePaid !== undefined ? { feePaid: obs.feePaid } : {}),
        ...(obs.error ? { error: obs.error } : {}),
      });
    }
  });
  return ok ? steps.length : 0;
}
