import type { Logger } from "pino";

export type ShutdownHook = { name: string; close: () => Promise<void> | void };

/**
 * Registers SIGTERM/SIGINT handlers that close resources in reverse order of
 * registration, bounded by a grace period. Railway sends SIGTERM before
 * stopping a deployment; the process must exit before the platform's own
 * timeout or it will be killed.
 */
export function installGracefulShutdown(logger: Logger, graceMs: number) {
  const hooks: ShutdownHook[] = [];
  let shuttingDown = false;

  const run = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, graceMs }, "shutdown started");

    const timer = setTimeout(() => {
      logger.error({ signal }, "shutdown grace period exceeded; forcing exit");
      process.exit(1);
    }, graceMs);
    timer.unref();

    for (const hook of [...hooks].reverse()) {
      try {
        await hook.close();
        logger.info({ hook: hook.name }, "closed");
      } catch (err) {
        logger.error({ err, hook: hook.name }, "error while closing");
      }
    }
    clearTimeout(timer);
    logger.info("shutdown complete");
    process.exit(0);
  };

  process.once("SIGTERM", () => void run("SIGTERM"));
  process.once("SIGINT", () => void run("SIGINT"));

  return {
    register(hook: ShutdownHook) {
      hooks.push(hook);
    },
    get isShuttingDown() {
      return shuttingDown;
    },
  };
}
