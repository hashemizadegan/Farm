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

export function createLogger(opts: CreateLoggerOptions): Logger {
  return pino({
    level: opts.level ?? "info",
    base: { service: opts.service, env: opts.environment ?? "development" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport: opts.pretty ? { target: "pino-pretty", options: { colorize: true } } : undefined,
  });
}

export type { Logger };
