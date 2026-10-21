/**
 * A small metrics registry that renders the Prometheus text format (version 0.0.4). No dependencies.
 *
 * Counters, gauges and histograms with fixed label names. Series per metric are capped
 * (`maxSeries`): past the cap, new label combinations are dropped and counted in
 * `metafarm_metrics_series_dropped_total`, so a bug that puts an unbounded value in a label can never
 * grow memory without limit or fail the request that is being measured. Recording never throws.
 */

export type LabelValues = Record<string, string | number>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const escapeHelp = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  return String(n);
}

function labelText(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const parts = names.map((n, i) => `${n}="${escapeLabel(values[i]!)}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

interface Rendered {
  /** Runs before any metric is rendered (gauge collection), so one scrape is consistent. */
  prepare?(): Promise<void>;
  render(): Promise<string[]>;
}

abstract class Metric<S> implements Rendered {
  protected readonly series = new Map<string, { values: string[]; state: S }>();

  constructor(
    protected readonly registry: MetricsRegistry,
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "gauge" | "histogram",
    readonly labelNames: readonly string[],
  ) {}

  /** The series for these labels, or undefined when the labels are wrong or the cap is reached. */
  protected seriesFor(labels: LabelValues | undefined, init: () => S): S | undefined {
    const values: string[] = [];
    const given = labels ?? {};
    if (Object.keys(given).length !== this.labelNames.length) return this.registry.reject(this.name);
    for (const n of this.labelNames) {
      const v = given[n];
      if (v === undefined) return this.registry.reject(this.name);
      values.push(String(v));
    }
    const key = values.join("\u0000");
    const found = this.series.get(key);
    if (found) return found.state;
    if (this.series.size >= this.registry.maxSeries) return this.registry.reject(this.name);
    const created = { values, state: init() };
    this.series.set(key, created);
    return created.state;
  }

  protected header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract render(): Promise<string[]>;
}

export class Counter extends Metric<{ value: number }> {
  inc(labels?: LabelValues, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) return; // counters only go up
    const s = this.seriesFor(labels, () => ({ value: 0 }));
    if (s) s.value += by;
  }

  async render(): Promise<string[]> {
    const lines = this.header();
    for (const { values, state } of this.series.values()) lines.push(`${this.name}${labelText(this.labelNames, values)} ${formatNumber(state.value)}`);
    return lines;
  }
}

export class Gauge extends Metric<{ value: number }> {
  constructor(
    registry: MetricsRegistry,
    name: string,
    help: string,
    labelNames: readonly string[],
    /** Called on every render; it sets the current values. A failing collect leaves the last values. */
    private readonly collect?: (gauge: Gauge) => Promise<void> | void,
  ) {
    super(registry, name, help, "gauge", labelNames);
  }

  set(labels: LabelValues | undefined, value: number): void {
    const s = this.seriesFor(labels, () => ({ value: 0 }));
    if (s) s.value = value;
  }

  async prepare(): Promise<void> {
    if (!this.collect) return;
    try {
      await this.collect(this);
    } catch {
      this.registry.collectFailed(this.name);
    }
  }

  async render(): Promise<string[]> {
    const lines = this.header();
    for (const { values, state } of this.series.values()) lines.push(`${this.name}${labelText(this.labelNames, values)} ${formatNumber(state.value)}`);
    return lines;
  }
}

export class Histogram extends Metric<{ counts: number[]; sum: number; count: number }> {
  constructor(
    registry: MetricsRegistry,
    name: string,
    help: string,
    labelNames: readonly string[],
    readonly buckets: readonly number[],
  ) {
    super(registry, name, help, "histogram", labelNames);
  }

  observe(labels: LabelValues | undefined, value: number): void {
    if (!Number.isFinite(value)) return;
    const s = this.seriesFor(labels, () => ({ counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    if (!s) return;
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.counts[i] = (s.counts[i] ?? 0) + 1;
    s.sum += value;
    s.count++;
  }

  async render(): Promise<string[]> {
    const lines = this.header();
    for (const { values, state } of this.series.values()) {
      // Bucket counts are cumulative by construction: a value is counted in every bucket it fits.
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${labelText(this.labelNames, values, ["le", formatNumber(b)])} ${state.counts[i]}`));
      lines.push(`${this.name}_bucket${labelText(this.labelNames, values, ["le", "+Inf"])} ${state.count}`);
      lines.push(`${this.name}_sum${labelText(this.labelNames, values)} ${formatNumber(state.sum)}`);
      lines.push(`${this.name}_count${labelText(this.labelNames, values)} ${state.count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Rendered & { name: string }>();
  private readonly dropped: Counter;
  private readonly collectErrors: Counter;

  constructor(readonly maxSeries = 1_000) {
    this.dropped = this.counter("metafarm_metrics_series_dropped_total", "Samples dropped because of wrong labels or the per-metric series cap.", ["metric"]);
    this.collectErrors = this.counter("metafarm_metrics_collect_errors_total", "Gauge collections that failed; the gauge keeps its last values.", ["metric"]);
  }

  private add<M extends Rendered & { name: string; labelNames: readonly string[] }>(m: M): M {
    if (!NAME.test(m.name)) throw new Error(`invalid metric name ${m.name}`);
    for (const l of m.labelNames) if (!LABEL.test(l) || l === "le" || l.startsWith("__")) throw new Error(`invalid label name ${l} on ${m.name}`);
    if (this.metrics.has(m.name)) throw new Error(`metric ${m.name} is already registered`);
    this.metrics.set(m.name, m);
    return m;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(this, name, help, "counter", labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = [], collect?: (g: Gauge) => Promise<void> | void): Gauge {
    return this.add(new Gauge(this, name, help, labelNames, collect));
  }

  histogram(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]): Histogram {
    const sorted = [...buckets].sort((a, b) => a - b);
    if (sorted.length === 0 || sorted.some((b, i) => !Number.isFinite(b) || (i > 0 && b === sorted[i - 1]))) throw new Error(`invalid buckets for ${name}`);
    return this.add(new Histogram(this, name, help, labelNames, sorted));
  }

  /** @internal */
  reject(metric: string): undefined {
    if (metric !== this.dropped.name) this.dropped.inc({ metric });
    return undefined;
  }

  /** @internal */
  collectFailed(metric: string): void {
    this.collectErrors.inc({ metric });
  }

  /** Names of every registered metric. */
  names(): string[] {
    return [...this.metrics.keys()];
  }

  /** The Prometheus text exposition of every metric. */
  async render(): Promise<string> {
    await Promise.all([...this.metrics.values()].map((m) => m.prepare?.()));
    const out: string[] = [];
    for (const m of this.metrics.values()) out.push(...(await m.render()));
    return out.join("\n") + "\n";
  }
}

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
