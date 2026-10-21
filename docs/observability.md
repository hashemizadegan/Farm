# Metrics and alerts

Status: implemented on a draft branch, with automated tests. **Off by default and not deployed.** No
metrics backend (Prometheus or similar) is set up anywhere yet; choosing and running one is an
operations decision.

## What is measured

Logs (pino, with redaction) and health probes (`/healthz`, `/readyz`) were already in place. This adds
counters, gauges and histograms in the Prometheus text format. They come from a small registry in
`packages/observability` with no extra dependencies. The names, labels and buckets are defined in one
file, `standard-metrics.ts`.

| Metric | Type | Labels | Where |
| --- | --- | --- | --- |
| `metafarm_http_requests_total` | counter | `method`, `route`, `status` | API, every response |
| `metafarm_http_request_duration_seconds` | histogram | `method`, `route` | API |
| `metafarm_jobs_total` | counter | `queue`, `outcome` (`completed`, `skipped`, `failed`, `dead_lettered`) | worker, every job attempt |
| `metafarm_job_duration_seconds` | histogram | `queue` | worker |
| `metafarm_queue_jobs` | gauge | `queue`, `state` (`waiting`, `active`, `delayed`, `failed`) | worker, read from Redis at scrape time |
| `metafarm_metrics_series_dropped_total` | counter | `metric` | both: samples dropped by the series cap or wrong labels |
| `metafarm_metrics_collect_errors_total` | counter | `metric` | both: failed gauge collections (for example, Redis unreachable) |

Label values are bounded:
- `route` is the route template (`/v1/tenants/:tenantId/farms`), never the URL, so ids and tenants
  never appear. Requests that match no route are `unmatched`.
- Queues and outcomes are fixed sets.
- Each metric is capped at 1,000 series. Anything past the cap is dropped and counted, never raised as
  an error.

Recording never fails a request or a job. A `dead_lettered` attempt is also counted as `failed`.

## Exposure (off by default)

| Service | Endpoint | Setting |
| --- | --- | --- |
| api | `GET /metrics` on the API port | `METRICS_TOKEN` |
| worker | `GET /metrics` on `HEALTH_PORT` | `METRICS_TOKEN` |

- With `METRICS_TOKEN` unset, both endpoints answer 404, and the worker opens no extra Redis
  connections for queue depth.
- When it is set, a scrape needs `Authorization: Bearer <METRICS_TOKEN>` (401 otherwise). The token is
  compared in constant time and must be at least 32 characters.
- It is a platform secret: never commit it or put it in a URL. Authorization headers are already
  redacted from logs.
- The output holds counts and timings per route template and queue, and no tenant data.
- The scheduler has no metrics: it only registers schedules.

## Alerts

`infra/alerts/metafarm.rules.yml` holds Prometheus alerting rules: API down, 5xx rate, slow requests,
sustained rate limiting; worker down, dead-lettered jobs, failure rate per queue, backlog, stalled
queues; and dropped or failing metrics. `page` means act now, and `ticket` means look within a working
day.

The thresholds are starting points and have not been tuned against real traffic. The rules assume
scrape jobs named `metafarm-api` and `metafarm-worker`.

`apps/api/src/alert-rules.test.ts` checks that every rule is complete and uses only metrics the services
register. PromQL syntax is not checked in CI (no Prometheus there): run `promtool check rules` before
loading the rules.

## Tests

- `packages/observability/src/metrics.test.ts`: the text format (escaping, cumulative buckets), the
  series cap, registration checks, gauge collection, token checks.
- `packages/observability/src/health.test.ts`: the worker endpoint (404 when off, 401, 200).
- `apps/api/src/metrics.test.ts`: off by default, the token, route templates instead of URLs, scrapes
  not counted.
- `apps/worker/src/runner.test.ts`: job outcomes and durations per queue.

## Not done

- No metrics backend, scrape configuration or alert routing. That needs an operations decision and a
  deploy, and deploys are on hold.
- No domain gauges (such as ownership index lag or snapshot schedule freshness). They need a per-scrape
  database read; add them when there is a backend to read them.
- The web app and the scheduler expose no metrics.
