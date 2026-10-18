/** Small byte helpers shared by the codecs. */

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const utf8 = (s: string) => new TextEncoder().encode(s);

export const U64_MAX = (1n << 64n) - 1n;

export function u64le(n: bigint): Uint8Array {
  if (n < 0n || n > U64_MAX) throw new RangeError(`${n} does not fit in a u64`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

export const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
export const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
export const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const fromHex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));
