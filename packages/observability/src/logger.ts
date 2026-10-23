import { createRequire } from "node:module";
import { pino, type Logger, type LoggerOptions } from "pino";

/**
 * Keys whose values must never reach logs. Matching is by pino's redact paths,
 * which cover common header and body locations.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-webhook-signature']",
  "headers.authorization",
  "headers.cookie",
  "*.password",
  "*.secret",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.privateKey",
  "*.signature",
  "*.apiKey",
  "*.sensorCredential",
  "*.email",
];

export interface CreateLoggerOptions {
  service: string;
  level?: LoggerOptions["level"];
  environment?: string;
  pretty?: boolean;
}

/**
 * pino-pretty is a development dependency: present in a workspace checkout, absent from the production images. A
 * development configuration running from such an image (the isolated preview: APP_ENV=development) logs plain JSON
 * instead of failing at start-up.
 */
export function prettyAvailable(resolve: (id: string) => string = createRequire(import.meta.url).resolve): boolean {
  try {
    resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  return pino({
    level: opts.level ?? "info",
    base: { service: opts.service, env: opts.environment ?? "development" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport: opts.pretty && prettyAvailable() ? { target: "pino-pretty", options: { colorize: true } } : undefined,
  });
}

export type { Logger };
