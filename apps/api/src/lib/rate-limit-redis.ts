import { Redis } from "ioredis";
import type { Logger } from "@metafarm/observability";

/**
 * The Redis connection for shared rate-limit counters (RATE_LIMIT_STORE=redis). It is separate from the
 * queue's connection, which waits indefinitely for Redis; rate limiting must instead give up quickly so
 * that, with `skipOnError`, a Redis outage lets requests through rather than stalling them.
 */
export function createRateLimitRedis(url: string, logger: Pick<Logger, "warn">): Redis {
  const redis = new Redis(url, {
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    family: 0,
  });
  let reported = false;
  redis.on("error", (err: Error) => {
    // Log once per outage: an unreachable Redis emits an error on every reconnect attempt.
    if (reported) return;
    reported = true;
    logger.warn({ err: err.message }, "rate-limit store unreachable; requests are served without limits until it recovers");
  });
  redis.on("ready", () => {
    reported = false;
  });
  return redis;
}
