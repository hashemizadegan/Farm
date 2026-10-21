/**
 * The platform's metrics: names, labels and buckets in one place, so the services, the alert rules
 * (`ops/alerts/metafarm.rules.yml`) and their tests agree. Label values are bounded: HTTP routes are
 * route templates (never raw URLs), queues and outcomes are fixed sets.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Counter, Gauge, Histogram, MetricsRegistry } from "./metrics";

/** Seconds; request handling. */
export const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
/** Seconds; background jobs, which include chain reads. */
export const JOB_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] as const;

export interface HttpMetrics {
  requests: Counter;
  duration: Histogram;
}

export function createHttpMetrics(r: MetricsRegistry): HttpMetrics {
  return {
    requests: r.counter("metafarm_http_requests_total", "HTTP requests served, by route template and status code.", ["method", "route", "status"]),
    duration: r.histogram("metafarm_http_request_duration_seconds", "Time to serve an HTTP request, by route template.", ["method", "route"], HTTP_DURATION_BUCKETS),
  };
}

/** How a job attempt ended. `dead_lettered` is also counted as `failed`. */
export type JobOutcome = "completed" | "skipped" | "failed" | "dead_lettered";

export interface JobMetrics {
  jobs: Counter;
  duration: Histogram;
}

export function createJobMetrics(r: MetricsRegistry): JobMetrics {
  return {
    jobs: r.counter("metafarm_jobs_total", "Job attempts by queue and outcome (completed, skipped, failed, dead_lettered).", ["queue", "outcome"]),
    duration: r.histogram("metafarm_job_duration_seconds", "Time a job attempt ran, by queue.", ["queue"], JOB_DURATION_BUCKETS),
  };
}

export const QUEUE_STATES = ["waiting", "active", "delayed", "failed"] as const;

/** Jobs per queue and state, read when the metrics are scraped. */
export function createQueueDepthGauge(r: MetricsRegistry, collect: (g: Gauge) => Promise<void>): Gauge {
  return r.gauge("metafarm_queue_jobs", "Jobs in each queue by state, read at scrape time.", ["queue", "state"], collect);
}

/** Every metric name the services register, for the alert-rule consistency test. */
export const PLATFORM_METRIC_NAMES = [
  "metafarm_http_requests_total",
  "metafarm_http_request_duration_seconds",
  "metafarm_jobs_total",
  "metafarm_job_duration_seconds",
  "metafarm_queue_jobs",
  "metafarm_metrics_series_dropped_total",
  "metafarm_metrics_collect_errors_total",
] as const;

/**
 * Whether an Authorization header carries the metrics token (`Bearer <token>`). Compared in constant
 * time over SHA-256 digests, so neither the token's content nor its length leaks through timing.
 * Without a configured token, nothing is authorized: the metrics endpoint is off.
 */
export function metricsAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}
