import { describe, expect, it } from "vitest";
import { TelemetryBatcher } from "./batcher";

function fakeTimers() {
  const timers: { fn: () => void; ms: number }[] = [];
  return { timers, setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }), clearTimer: () => timers.splice(0) };
}

describe("telemetry batcher", () => {
  it("writes when the batch is full and acknowledges only after the write", async () => {
    const writes: number[][] = [];
    const acked: string[] = [];
    let release!: () => void;
    const b = new TelemetryBatcher<number>({
      maxRows: 3,
      maxWaitMs: 1_000,
      write: (rows) => new Promise<void>((r) => ((release = r), writes.push(rows))),
      onError: () => undefined,
      ...fakeTimers(),
    });
    b.add([1, 2], () => acked.push("a"));
    expect(writes).toEqual([]);
    b.add([3], () => acked.push("b"));
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual([[1, 2, 3]]);
    expect(acked).toEqual([]);
    release();
    await b.flush();
    expect(acked).toEqual(["a", "b"]);
  });

  it("writes after the wait even when the batch is small", async () => {
    const t = fakeTimers();
    const writes: number[][] = [];
    const b = new TelemetryBatcher<number>({ maxRows: 100, maxWaitMs: 250, write: async (r) => void writes.push(r), onError: () => undefined, ...t });
    b.add([7], () => undefined);
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(250);
    t.timers[0]!.fn();
    await b.flush();
    expect(writes).toEqual([[7]]);
  });

  it("leaves messages unacknowledged when the write fails", async () => {
    const acked: string[] = [];
    const errors: number[] = [];
    const b = new TelemetryBatcher<number>({
      maxRows: 10,
      maxWaitMs: 1_000,
      write: async () => Promise.reject(new Error("db down")),
      onError: (_e, rows) => errors.push(rows),
      ...fakeTimers(),
    });
    b.add([1, 2], () => acked.push("a"));
    await b.flush();
    expect(acked).toEqual([]);
    expect(errors).toEqual([2]);
    expect(b.pending).toBe(0);
  });

  it("acknowledges messages that carried no storable readings with the next write", async () => {
    const acked: string[] = [];
    const b = new TelemetryBatcher<number>({ maxRows: 10, maxWaitMs: 1_000, write: async () => undefined, onError: () => undefined, ...fakeTimers() });
    b.add([], () => acked.push("empty"));
    await b.flush();
    expect(acked).toEqual(["empty"]);
  });
});
