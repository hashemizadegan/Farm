/**
 * Provider-neutral chain events (webhooks). A provider tells the platform that something happened on chain; the
 * platform never takes its word for ownership. A normalized event is a **hint**: for an asset the platform tracks,
 * it asks the ownership indexer to re-read that asset from the verified chain source (Y0 cluster identity), which
 * remains the only writer of ownership. So a lying, replaying or misconfigured provider can cause, at most, an extra
 * read of the chain, never a wrong holding.
 *
 * Contract `metafarm-chain-event/1`, the internal shape every adapter produces:
 * - transaction identity (signature, slot, instruction position);
 * - chain/network and rail, and the asset (Token-2022 mint or Bubblegum asset id);
 * - an ownership change (mint/transfer/burn, from, to, amount as a decimal string) or a metadata update;
 * - the provider's finality claim and timestamp;
 * - a raw reference: provider, provider event id and the SHA-256 of the exact request body (the body itself is not
 *   kept, following the platform's retention rule for third-party payloads).
 *
 * Adapters map one provider's payloads to this contract. The only adapter shipped is `metafarm-relay`, which accepts
 * the contract itself (a relay or integration posts canonical events); vendor adapters are added per provider,
 * with fixtures, when one is chosen. Pure and deterministic: no I/O.
 */
import { NETWORKS, RAILS, RAIL_NETWORKS, type Network, type Rail } from "./rwa/model";

export const CHAIN_EVENT_SCHEME = "metafarm-chain-event/1";
export const CHAIN_EVENT_KINDS = ["ownership_change", "metadata_update"] as const;
export type ChainEventKind = (typeof CHAIN_EVENT_KINDS)[number];
export const CHAIN_FINALITY = ["processed", "confirmed", "finalized"] as const;
export type ChainFinality = (typeof CHAIN_FINALITY)[number];
/** Only these rails have chain events the platform can use today (Solana); TRON events are refused. */
export const CHAIN_EVENT_RAILS: readonly Rail[] = ["SOLANA_TOKEN_2022", "SOLANA_BUBBLEGUM_CNFT"];

export interface NormalizedChainEvent {
  scheme: typeof CHAIN_EVENT_SCHEME;
  kind: ChainEventKind;
  network: Network;
  rail: Rail;
  assetId: string;
  transaction: { signature: string; slot: string; ixIndex: number };
  ownership: { change: "mint" | "transfer" | "burn"; from: string | null; to: string | null; amount: string } | null;
  metadata: { uri: string | null; contentSha256: string | null } | null;
  finality: ChainFinality;
  providerTimestamp: string;
  rawReference: { provider: string; eventId: string; payloadSha256: string };
}

export type ChainEventRefusalCode = "malformed" | "unsupported_event" | "unsupported_network" | "network_mismatch";

export class ChainEventRefusal extends Error {
  constructor(
    readonly code: ChainEventRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "ChainEventRefusal";
  }
}

/** What an adapter receives: the parsed webhook body and facts the route established. */
export interface ChainEventInput {
  provider: string;
  body: unknown;
  /** SHA-256 (hex) of the exact request bytes the signature covered. */
  payloadSha256: string;
}

/** Maps one provider's payloads to the contract. Throws ChainEventRefusal for anything it cannot map exactly. */
export interface ChainEventProviderAdapter {
  readonly id: string;
  normalize(input: ChainEventInput): NormalizedChainEvent[];
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const U64_MAX = 18446744073709551615n;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,200}$/;

const refuse = (code: ChainEventRefusalCode, message: string): never => {
  throw new ChainEventRefusal(code, message);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function exactKeys(what: string, o: Record<string, unknown>, allowed: readonly string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) refuse("malformed", `${what} has an unknown field ${k}`);
}
function str(what: string, v: unknown, re: RegExp): string {
  if (typeof v !== "string" || !re.test(v)) refuse("malformed", `${what} is missing or malformed`);
  return v as string;
}
function decimal(what: string, v: unknown, min: bigint, max: bigint): string {
  if (typeof v !== "string" || !/^(0|[1-9]\d{0,19})$/.test(v)) refuse("malformed", `${what} must be a decimal string`);
  const n = BigInt(v as string);
  if (n < min || n > max) refuse("malformed", `${what} is out of range`);
  return v as string;
}

/**
 * Checks a contract-shaped event (the `data` of a canonical webhook) and returns it normalized. Exact keys, no
 * defaults: anything unknown, missing or inconsistent is refused, so nothing is guessed.
 */
export function parseChainEvent(data: unknown, ref: NormalizedChainEvent["rawReference"]): NormalizedChainEvent {
  if (!isObject(data)) return refuse("malformed", "the event is not an object");
  exactKeys("event", data, ["kind", "network", "rail", "assetId", "transaction", "ownership", "metadata", "finality", "providerTimestamp"]);
  const kind = data.kind;
  if (!(CHAIN_EVENT_KINDS as readonly unknown[]).includes(kind)) refuse("unsupported_event", `unsupported event kind ${String(kind)}`);
  if (!(NETWORKS as readonly unknown[]).includes(data.network)) refuse("unsupported_network", `unknown network ${String(data.network)}`);
  if (!(RAILS as readonly unknown[]).includes(data.rail)) refuse("malformed", `unknown rail ${String(data.rail)}`);
  const network = data.network as Network;
  const rail = data.rail as Rail;
  if (!CHAIN_EVENT_RAILS.includes(rail)) refuse("unsupported_network", `events of rail ${rail} are not accepted`);
  if (!RAIL_NETWORKS[rail].includes(network)) refuse("malformed", `rail ${rail} does not run on ${network}`);
  const assetId = str("assetId", data.assetId, B58);

  const tx = data.transaction;
  if (!isObject(tx)) return refuse("malformed", "transaction is missing");
  exactKeys("transaction", tx, ["signature", "slot", "ixIndex"]);
  const signature = str("transaction.signature", tx.signature, SIG);
  const slot = decimal("transaction.slot", tx.slot, 0n, U64_MAX);
  if (typeof tx.ixIndex !== "number" || !Number.isInteger(tx.ixIndex) || tx.ixIndex < 0 || tx.ixIndex > 65535) refuse("malformed", "transaction.ixIndex must be an integer 0-65535");

  let ownership: NormalizedChainEvent["ownership"] = null;
  let metadata: NormalizedChainEvent["metadata"] = null;
  if (kind === "ownership_change") {
    if (data.metadata !== undefined && data.metadata !== null) refuse("malformed", "an ownership change carries no metadata");
    const o = data.ownership;
    if (!isObject(o)) return refuse("malformed", "an ownership change needs ownership");
    exactKeys("ownership", o, ["change", "from", "to", "amount"]);
    const change = o.change;
    if (change !== "mint" && change !== "transfer" && change !== "burn") return refuse("malformed", "ownership.change must be mint, transfer or burn");
    const from = o.from === null ? null : str("ownership.from", o.from, B58);
    const to = o.to === null ? null : str("ownership.to", o.to, B58);
    if ((change === "mint") !== (from === null) || (change === "burn") !== (to === null)) refuse("malformed", "from/to do not match the change (mint has no from, burn has no to)");
    if (change === "transfer" && from === to) refuse("malformed", "a transfer moves between two different owners");
    const amount = decimal("ownership.amount", o.amount, 1n, U64_MAX);
    if (rail === "SOLANA_BUBBLEGUM_CNFT" && amount !== "1") refuse("malformed", "a compressed NFT moves with amount 1");
    ownership = { change, from, to, amount };
  } else {
    if (data.ownership !== undefined && data.ownership !== null) refuse("malformed", "a metadata update carries no ownership");
    const m = data.metadata;
    if (!isObject(m)) return refuse("malformed", "a metadata update needs metadata");
    exactKeys("metadata", m, ["uri", "contentSha256"]);
    const uri = m.uri === null ? null : typeof m.uri === "string" && m.uri.length <= 200 && /^https:\/\//.test(m.uri) ? m.uri : refuse("malformed", "metadata.uri must be https and at most 200 characters");
    const contentSha256 = m.contentSha256 === null ? null : str("metadata.contentSha256", m.contentSha256, HEX64);
    if (uri === null && contentSha256 === null) refuse("malformed", "a metadata update names a uri or a content hash");
    metadata = { uri, contentSha256 };
  }
  if (!(CHAIN_FINALITY as readonly unknown[]).includes(data.finality)) refuse("malformed", "finality must be processed, confirmed or finalized");
  const providerTimestamp = str("providerTimestamp", data.providerTimestamp, RFC3339);
  if (Number.isNaN(Date.parse(providerTimestamp))) refuse("malformed", "providerTimestamp is not a valid time");

  return {
    scheme: CHAIN_EVENT_SCHEME,
    kind: kind as ChainEventKind,
    network,
    rail,
    assetId,
    transaction: { signature, slot, ixIndex: tx.ixIndex as number },
    ownership,
    metadata,
    finality: data.finality as ChainFinality,
    providerTimestamp,
    rawReference: ref,
  };
}

/** The canonical relay: the webhook body is `{ id, type: "chain.<kind>", data: <contract event> }`. */
export const relayChainEventAdapter: ChainEventProviderAdapter = {
  id: "metafarm-relay",
  normalize({ provider, body, payloadSha256 }) {
    if (!isObject(body)) return refuse("malformed", "the body is not an object");
    exactKeys("body", body, ["id", "type", "data"]);
    const eventId = str("id", body.id, EVENT_ID);
    if (typeof body.type !== "string" || !body.type.startsWith("chain.")) return refuse("unsupported_event", `unsupported event type ${String(body.type)}`);
    if (!isObject(body.data) || body.data.kind !== body.type.slice("chain.".length)) refuse("malformed", "type and data.kind disagree");
    if (!HEX64.test(payloadSha256)) refuse("malformed", "payload hash missing");
    return [parseChainEvent(body.data, { provider, eventId, payloadSha256 })];
  },
};

/** Adapters by provider name (the `:provider` of POST /v1/webhooks/:provider). Vendor adapters register here. */
export const CHAIN_EVENT_ADAPTERS: Readonly<Record<string, ChainEventProviderAdapter>> = {
  "metafarm-relay": relayChainEventAdapter,
};

/**
 * Whether the event's network is the one this deployment serves. Events for any other network (mainnet on a devnet
 * deployment, or the reverse) are refused before anything is stored.
 */
export function assertChainEventNetwork(e: NormalizedChainEvent, configured: Network): void {
  if (e.network !== configured) refuse("network_mismatch", `the event is for ${e.network}; this deployment serves ${configured}`);
}

/** An ownership hint is acted on only once the provider claims at least `confirmed`; `processed` can still roll back. */
export const isActionableOwnershipHint = (e: NormalizedChainEvent) => e.kind === "ownership_change" && e.finality !== "processed";
