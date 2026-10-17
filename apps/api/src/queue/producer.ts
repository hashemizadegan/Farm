import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, idempotencyKey, jobIdFromKey, type JobPayloads } from "@metafarm/domain";
import type { JobProducer } from "../deps";

/**
 * BullMQ producer. The job id is derived from the idempotency key, so
 * enqueueing the same logical job twice while the first is still queued is a
 * no-op at the queue level; the worker's job_runs table covers the rest.
 */
export function createBullProducer(redisUrl: string, prefix: string, maxAttempts = 5, backoffMs = 2_000): JobProducer {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true, family: 0 });
  const queues = new Map<string, Queue>();
  const getQueue = (name: string) => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection, prefix });
      queues.set(name, q);
    }
    return q;
  };

  const defaults: JobsOptions = {
    attempts: maxAttempts,
    backoff: { type: "exponential", delay: backoffMs },
    removeOnComplete: { age: 24 * 3600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };

  return {
    async enqueue(queue, payload) {
      const key = idempotencyKey(queue, payload);
      await getQueue(queue).add(queue, { ...payload, idempotencyKey: key }, { ...defaults, jobId: jobIdFromKey(key) });
    },
    async ping() {
      return (await connection.ping()) === "PONG";
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
      await connection.quit();
    },
  };
}

/** Records enqueued jobs; used by tests. */
export function createMemoryProducer() {
  const jobs: { queue: keyof JobPayloads; payload: unknown; key: string }[] = [];
  const producer: JobProducer & { jobs: typeof jobs } = {
    jobs,
    async enqueue(queue, payload) {
      const key = idempotencyKey(queue, payload);
      if (!jobs.some((j) => j.key === key)) jobs.push({ queue, payload, key });
    },
    async ping() {
      return true;
    },
    async close() {},
  };
  return producer;
}

export { QUEUES };
