import { describe, expect, it } from "vitest";
import { verifyMerkleInclusion } from "./commitments";
import {
  SNAPSHOT_SCHEME,
  buildFarmSnapshot,
  plainJsonProblem,
  reconstructFarmSnapshot,
  serializeFarmSnapshot,
  snapshotEntityProof,
  verifyFarmSnapshot,
  type SnapshotEntityInput,
} from "./snapshot";

const FARM = "6b0c6f4e-8d1a-4c4e-9a43-0d1b2f3c4a5b";
const takenAt = new Date("2026-10-20T12:00:00Z");
const entities = (): SnapshotEntityInput[] => [
  { type: "plot", id: "11111111-1111-4111-8111-111111111111", data: { name: "Block A", areaM2: 1234.5, crop: "pistachio" } },
  { type: "machine", id: "22222222-2222-4222-8222-222222222222", data: { name: "Tractor 2", hourMeter: 4310, maintenance: [{ due: "2026-11-01", kind: "oil" }] } },
  { type: "animal", id: "33333333-3333-4333-8333-333333333333", data: { tag: "LV-7", species: "sheep", born: "2025-03-02" } },
  { type: "inventory", id: "44444444-4444-4444-8444-444444444444", data: { item: "Urea 46%", quantityKg: 800, lot: null } },
  { type: "structure", id: "55555555-5555-4555-8555-555555555555", data: { name: "Cold store 1", kind: "storage_unit", capacityT: 40 } },
  { type: "crop", id: "66666666-6666-4666-8666-666666666666", data: { season: "2026", stage: "harvest", parcelLabel: "A" } },
];

describe("farm snapshots", () => {
  it("are canonical: the same state in any order gives the same id, root and bytes", async () => {
    const a = await buildFarmSnapshot({ farmId: FARM, takenAt, entities: entities() });
    const b = await buildFarmSnapshot({ farmId: FARM, takenAt, entities: [...entities()].reverse() });
    expect(a.scheme).toBe(SNAPSHOT_SCHEME);
    expect(a.entityCount).toBe(6);
    expect(a.entities.map((e) => e.type)).toEqual(["animal", "crop", "inventory", "machine", "plot", "structure"]);
    expect(b.snapshotId).toBe(a.snapshotId);
    expect(serializeFarmSnapshot(b)).toBe(serializeFarmSnapshot(a));
    expect((await verifyFarmSnapshot(a)).ok).toBe(true);
  });

  it("changes id and root when any fact, the farm or the time changes", async () => {
    const a = await buildFarmSnapshot({ farmId: FARM, takenAt, entities: entities() });
    const changed = entities();
    (changed[1]!.data as { hourMeter: number }).hourMeter = 4311;
    const b = await buildFarmSnapshot({ farmId: FARM, takenAt, entities: changed });
    expect(b.root).not.toBe(a.root);
    expect(b.snapshotId).not.toBe(a.snapshotId);
    expect((await buildFarmSnapshot({ farmId: "other-farm", takenAt, entities: entities() })).snapshotId).not.toBe(a.snapshotId);
    expect((await buildFarmSnapshot({ farmId: FARM, takenAt: new Date("2026-10-20T12:00:01Z"), entities: entities() })).snapshotId).not.toBe(a.snapshotId);
  });

  it("reconstructs from its serialised bytes and verifies end to end", async () => {
    const s = await buildFarmSnapshot({ farmId: FARM, takenAt, entities: entities() });
    const { snapshot, check } = await reconstructFarmSnapshot(serializeFarmSnapshot(s));
    expect(check).toEqual({ ok: true, problems: [] });
    expect(snapshot).toEqual(s);
  });

  it("detects tampering with data, hashes, order, root and id", async () => {
    const s = await buildFarmSnapshot({ farmId: FARM, takenAt, entities: entities() });
    const clone = () => JSON.parse(serializeFarmSnapshot(s)) as typeof s;
    const data = clone();
    (data.entities[0]!.data as { tag: string }).tag = "LV-8";
    expect((await verifyFarmSnapshot(data)).problems).toContain("animal/33333333-3333-4333-8333-333333333333: hash does not match its data");
    const order = clone();
    order.entities.reverse();
    expect((await verifyFarmSnapshot(order)).problems).toContain("entities are not in (type, id) order or repeat");
    const root = clone();
    root.root = "0".repeat(64);
    expect((await verifyFarmSnapshot(root)).problems).toEqual(["root does not match the entity hashes", "snapshotId does not match the header"]);
    const id = clone();
    id.takenAt = "2026-10-21T00:00:00.000Z";
    expect((await verifyFarmSnapshot(id)).problems).toEqual(["snapshotId does not match the header"]);
    const count = clone();
    count.entityCount = 5;
    expect((await verifyFarmSnapshot(count)).ok).toBe(false);
  });

  it("proves one entity without disclosing the others", async () => {
    const s = await buildFarmSnapshot({ farmId: FARM, takenAt, entities: entities() });
    const p = await snapshotEntityProof(s, "machine", "22222222-2222-4222-8222-222222222222");
    expect(p?.entity.data).toMatchObject({ name: "Tractor 2" });
    expect(await verifyMerkleInclusion(p!.proof)).toBe(true);
    expect(await snapshotEntityProof(s, "machine", "nope")).toBeNull();
  });

  it("refuses duplicates, unknown types, bad ids and data that would not survive JSON", async () => {
    const build = (e: SnapshotEntityInput[]) => buildFarmSnapshot({ farmId: FARM, takenAt, entities: e });
    const one = entities()[0]!;
    await expect(build([one, { ...one }])).rejects.toThrow(/duplicate/);
    await expect(build([{ ...one, type: "wallet" as never }])).rejects.toThrow(/unknown entity type/);
    await expect(build([{ ...one, id: "has space" }])).rejects.toThrow(/not valid/);
    await expect(build([{ ...one, data: { x: Number.NaN } }])).rejects.toThrow(/finite/);
    await expect(build([{ ...one, data: { x: [1, undefined as never] } }])).rejects.toThrow(/not plain JSON/);
    await expect(build([{ ...one, data: { at: new Date() as never } }])).rejects.toThrow(/not plain JSON/);
    await expect(build([])).rejects.toThrow(/at least one/);
    expect(plainJsonProblem({ a: [1, "b", true, null, { c: 2 }] })).toBeNull();
  });
});
