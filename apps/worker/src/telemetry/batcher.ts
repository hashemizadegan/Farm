/**
 * Collects readings from many messages and writes them together: when `maxRows` are waiting or
 * `maxWaitMs` after the first one arrived. A message is acknowledged only after its readings are
 * stored, so a failed write leaves it unacknowledged for the broker to deliver again.
 */
export interface BatcherOptions<Row> {
  maxRows: number;
  maxWaitMs: number;
  write: (rows: Row[]) => Promise<void>;
  onError: (err: unknown, rows: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class TelemetryBatcher<Row> {
  private rows: Row[] = [];
  private acks: (() => void)[] = [];
  private timer: unknown;
  private chain: Promise<void> = Promise.resolve();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly o: BatcherOptions<Row>) {
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get pending(): number {
    return this.rows.length;
  }

  add(rows: Row[], ack: () => void): void {
    this.rows.push(...rows);
    this.acks.push(ack);
    if (this.rows.length >= this.o.maxRows) void this.flush();
    else if (this.timer === undefined) this.timer = this.setTimer(() => void this.flush(), this.o.maxWaitMs);
  }

  /** Writes what is waiting (one write at a time, in arrival order). */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const rows = this.rows;
    const acks = this.acks;
    this.rows = [];
    this.acks = [];
    if (acks.length === 0) return this.chain;
    this.chain = this.chain.then(async () => {
      try {
        if (rows.length) await this.o.write(rows);
        for (const a of acks) a();
      } catch (err) {
        this.o.onError(err, rows.length);
      }
    });
    return this.chain;
  }
}
