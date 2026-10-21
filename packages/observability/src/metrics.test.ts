import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./metrics";
import { PLATFORM_METRIC_NAMES, createHttpMetrics, createJobMetrics, createQueueDepthGauge, metricsAuthorized } from "./standard-metrics";

describe("MetricsRegistry", () => {
  it("renders counters, gauges and histograms in the Prometheus text format", async () => {
    const r = new MetricsRegistry();
    const c = r.counter("t_requests_total", "Requests.", ["route"]);
    c.inc({ route: "/a" });
    c.inc({ route: "/a" }, 2);
    c.inc({ route: 'quote"back\\slash\nline' });
    const g = r.gauge("t_depth", "Depth.");
    g.set({}, 7);
    const h = r.histogram("t_seconds", "Time.", ["q"], [1, 0.1]);
    h.observe({ q: "x" }, 0.05);
    h.observe({ q: "x" }, 0.5);
    h.observe({ q: "x" }, 3);
    const text = await r.render();
    expect(text).toContain("# HELP t_requests_total Requests.\n# TYPE t_requests_total counter\n");
    expect(text).toContain('t_requests_total{route="/a"} 3\n');
    expect(text).toContain('t_requests_total{route="quote\\"back\\\\slash\\nline"} 1\n');
    expect(text).toContain("# TYPE t_depth gauge\nt_depth 7\n");
    // Buckets are sorted and cumulative; +Inf equals the count.
    expect(text).toContain(['t_seconds_bucket{q="x",le="0.1"} 1', 't_seconds_bucket{q="x",le="1"} 2', 't_seconds_bucket{q="x",le="+Inf"} 3', 't_seconds_sum{q="x"} 3.55', 't_seconds_count{q="x"} 3'].join("\n"));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("never throws while recording: wrong labels, negative counts and the series cap are dropped and counted", async () => {
    const r = new MetricsRegistry(2);
    const c = r.counter("t_total", "T.", ["k"]);
    c.inc({ k: "1" });
    c.inc({ k: "2" });
    c.inc({ k: "3" }); // over the cap
    c.inc({}); // missing label
    c.inc({ k: "1", extra: "x" }); // unknown label
    c.inc({ k: "1" }, -5); // counters only go up
    c.inc({ k: "1" }, Number.NaN);
    const text = await r.render();
    expect(text).toContain('t_total{k="1"} 1\n');
    expect(text).not.toContain('k="3"');
    expect(text).toContain('metafarm_metrics_series_dropped_total{metric="t_total"} 3\n');
  });

  it("refuses invalid names, reserved labels, duplicate metrics and bad buckets at registration", () => {
    const r = new MetricsRegistry();
    expect(() => r.counter("bad-name", "x")).toThrow();
    expect(() => r.counter("ok_total", "x", ["le"])).toThrow();
    expect(() => r.counter("ok2_total", "x", ["__x"])).toThrow();
    r.counter("dup_total", "x");
    expect(() => r.counter("dup_total", "x")).toThrow();
    expect(() => r.histogram("h1", "x", [], [])).toThrow();
    expect(() => r.histogram("h2", "x", [], [1, 1])).toThrow();
    expect(() => r.histogram("h3", "x", [], [1, Infinity])).toThrow();
  });

  it("collects gauges at render time and keeps the last values when collecting fails", async () => {
    const r = new MetricsRegistry();
    let fail = false;
    let n = 0;
    r.gauge("t_live", "Live.", ["q"], (g) => {
      if (fail) throw new Error("redis down");
      g.set({ q: "a" }, ++n);
    });
    expect(await r.render()).toContain('t_live{q="a"} 1\n');
    fail = true;
    const text = await r.render();
    expect(text).toContain('t_live{q="a"} 1\n');
    expect(text).toContain('metafarm_metrics_collect_errors_total{metric="t_live"} 1\n');
  });
});

describe("platform metrics", () => {
  it("registers exactly the names the alert rules may use", () => {
    const r = new MetricsRegistry();
    createHttpMetrics(r);
    createJobMetrics(r);
    createQueueDepthGauge(r, async () => undefined);
    expect(r.names().sort()).toEqual([...PLATFORM_METRIC_NAMES].sort());
  });

  it("authorizes only the configured bearer token", () => {
    const token = "m".repeat(40);
    expect(metricsAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(metricsAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(metricsAuthorized(`bearer ${token}`, token)).toBe(false);
    expect(metricsAuthorized(token, token)).toBe(false);
    expect(metricsAuthorized(undefined, token)).toBe(false);
    expect(metricsAuthorized(`Bearer ${token}`, undefined)).toBe(false);
    expect(metricsAuthorized("Bearer ", "")).toBe(false);
  });
});
