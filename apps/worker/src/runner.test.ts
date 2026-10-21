import { describe, expect, it } from "vitest";
import { NonRetryableJobError } from "@metafarm/domain";
import { MetricsRegistry, createJobMetrics, createLogger } from "@metafarm/observability";
import { wrapHandler, type DeadLetterSink, type JobRunStore } from "./runner";

function memoryStore(): JobRunStore & { runs: Map<string, string> } {
  const runs = new Map<string, string>();
  return {
    runs,
    async claim(key) {
      if (runs.get(key) === "completed") return "completed";
      runs.set(key, "running");
      return "claimed";
    },
    async complete(key) {
      runs.set(key, "completed");
    },
    async fail(key, _e, dead) {
      runs.set(key, dead ? "dead-lettered" : "failed");
    },
  };
}

function dlq(): DeadLetterSink & { entries: unknown[] } {
  const entries: unknown[] = [];
  return { entries, async send(e) { entries.push(e); } };
}

const logger = createLogger({ service: "test", level: "silent" });
const job = (data: object, attemptsMade = 0, attempts = 3) => {
  let discarded = false;
  return {
    id: "1",
    name: "n",
    data: { idempotencyKey: "k1", ...data },
    attemptsMade,
    opts: { attempts },
    discard: () => {
      discarded = true;
    },
    get discarded() {
      return discarded;
    },
  };
};

describe("wrapHandler", () => {
  it("runs a job once and skips duplicate deliveries", async () => {
    const store = memoryStore();
    let calls = 0;
    const run = wrapHandler("q", async () => ++calls, { store, deadLetter: dlq(), logger });
    await run(job({}));
    const second = await run(job({}));
    expect(calls).toBe(1);
    expect(second).toEqual({ skipped: true });
  });

  it("retries transient failures without dead-lettering until the last attempt", async () => {
    const store = memoryStore();
    const dead = dlq();
    const run = wrapHandler("q", async () => {
      throw new Error("transient");
    }, { store, deadLetter: dead, logger });
    await expect(run(job({}, 0, 3))).rejects.toThrow("transient");
    expect(dead.entries).toHaveLength(0);
    expect(store.runs.get("k1")).toBe("failed");
    await expect(run(job({}, 2, 3))).rejects.toThrow("transient");
    expect(dead.entries).toHaveLength(1);
    expect(store.runs.get("k1")).toBe("dead-lettered");
  });

  it("dead-letters non-retryable errors immediately and stops retries", async () => {
    const dead = dlq();
    const j = job({}, 0, 5);
    const run = wrapHandler("q", async () => {
      throw new NonRetryableJobError("bad input");
    }, { store: memoryStore(), deadLetter: dead, logger });
    await expect(run(j)).rejects.toThrow("bad input");
    expect(j.discarded).toBe(true);
    expect(dead.entries).toHaveLength(1);
  });

  it("allows a retry after a failure to complete the job", async () => {
    const store = memoryStore();
    let n = 0;
    const run = wrapHandler("q", async () => {
      if (++n === 1) throw new Error("once");
      return "ok";
    }, { store, deadLetter: dlq(), logger });
    await expect(run(job({}, 0))).rejects.toThrow();
    expect(await run(job({}, 1))).toBe("ok");
    expect(store.runs.get("k1")).toBe("completed");
  });

  it("counts outcomes per queue and times attempts", async () => {
    const registry = new MetricsRegistry();
    const metrics = createJobMetrics(registry);
    const store = memoryStore();
    let n = 0;
    const run = wrapHandler("ownership-index", async () => {
      if (++n === 1) throw new Error("once");
      return "ok";
    }, { store, deadLetter: dlq(), logger, metrics });
    await expect(run(job({}, 0, 3))).rejects.toThrow();
    await run(job({}, 1, 3));
    await run(job({}, 2, 3)); // already completed
    const last = wrapHandler("other", async () => {
      throw new Error("no");
    }, { store: memoryStore(), deadLetter: dlq(), logger, metrics });
    await expect(last(job({}, 0, 1))).rejects.toThrow();
    const text = await registry.render();
    expect(text).toContain('metafarm_jobs_total{queue="ownership-index",outcome="failed"} 1\n');
    expect(text).toContain('metafarm_jobs_total{queue="ownership-index",outcome="completed"} 1\n');
    expect(text).toContain('metafarm_jobs_total{queue="ownership-index",outcome="skipped"} 1\n');
    expect(text).toContain('metafarm_jobs_total{queue="other",outcome="failed"} 1\n');
    expect(text).toContain('metafarm_jobs_total{queue="other",outcome="dead_lettered"} 1\n');
    expect(text).toContain('metafarm_job_duration_seconds_count{queue="ownership-index"} 2\n');
  });
});
