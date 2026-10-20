/**
 * Content-addressed storage for large off-chain data (snapshots, telemetry windows, media, scene
 * bundles). An item's address is the SHA-256 of its bytes, so it cannot change without its address
 * changing, and every read is checked against the address before it is returned.
 *
 * This module defines the port and an in-memory implementation for tests and local development.
 * A production adapter would sit on the API's existing S3-compatible ObjectStorage under keys
 * `<prefix>/<sha256>` (the form `checkStorageRef` accepts); it is not part of this change.
 */
import { contentHash, isSha256Hex } from "./commitments";

export interface ContentRef {
  sha256: string;
  size: number;
  mediaType: string;
  /** `sha256:<hex>`: the reference to record in a data commitment. */
  ref: string;
}

export class ContentIntegrityError extends Error {
  constructor(readonly sha256: string) {
    super(`stored bytes for ${sha256} do not match their address`);
    this.name = "ContentIntegrityError";
  }
}

export interface ContentStore {
  /** Stores bytes and returns their address. Storing the same bytes twice is harmless. */
  put(bytes: Uint8Array, mediaType: string): Promise<ContentRef>;
  /** The bytes, checked against the address; null when absent. Throws ContentIntegrityError on corruption. */
  get(sha256: string): Promise<Uint8Array | null>;
  has(sha256: string): Promise<boolean>;
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

export interface MemoryContentStore extends ContentStore {
  /** For tests: replace stored bytes without changing the address, as a faulty disk would. */
  corrupt(sha256: string, bytes: Uint8Array): void;
  readonly size: number;
}

export function createMemoryContentStore(o: { maxBytes?: number } = {}): MemoryContentStore {
  const maxBytes = o.maxBytes ?? 50 * 1024 * 1024;
  const items = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  return {
    async put(bytes, mediaType) {
      if (!MEDIA_TYPE.test(mediaType)) throw new RangeError("mediaType must be a type/subtype");
      if (bytes.length > maxBytes) throw new RangeError(`content is larger than ${maxBytes} bytes`);
      const sha256 = await contentHash(bytes);
      if (!items.has(sha256)) items.set(sha256, { bytes: new Uint8Array(bytes), mediaType });
      return { sha256, size: bytes.length, mediaType: items.get(sha256)!.mediaType, ref: `sha256:${sha256}` };
    },
    async get(sha256) {
      if (!isSha256Hex(sha256)) return null;
      const item = items.get(sha256);
      if (!item) return null;
      if ((await contentHash(item.bytes)) !== sha256) throw new ContentIntegrityError(sha256);
      return new Uint8Array(item.bytes);
    },
    async has(sha256) {
      return isSha256Hex(sha256) && items.has(sha256);
    },
    corrupt(sha256, bytes) {
      const item = items.get(sha256);
      if (item) item.bytes = new Uint8Array(bytes);
    },
    get size() {
      return items.size;
    },
  };
}
