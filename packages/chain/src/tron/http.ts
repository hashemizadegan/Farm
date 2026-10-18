/** The TRON full-node HTTP API (e.g. TronGrid), JSON over HTTPS. */

export interface TronHttp {
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
}

export class TronHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TronHttpError";
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function httpTron(baseUrl: string, opts: { apiKey?: string; fetchImpl?: Fetch } = {}): TronHttp {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as Fetch);
  return {
    async post<T>(path: string, body: Record<string, unknown>) {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.apiKey ? { "TRON-PRO-API-KEY": opts.apiKey } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new TronHttpError(res.status, `TRON ${path} returned HTTP ${res.status}`);
      return (await res.json()) as T;
    },
  };
}

/** TRON returns error messages hex-encoded. */
export function tronMessage(m: string | undefined): string {
  if (!m) return "";
  return /^([0-9a-f]{2})+$/i.test(m) ? new TextDecoder().decode(Uint8Array.from(Buffer.from(m, "hex"))) : m;
}
