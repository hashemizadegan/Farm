/**
 * The domain's ContentStore on the API's object storage: one object per SHA-256 under
 * `tenants/<tenantId>/content/<sha256>`. Content-addressed, so a stored object can only ever hold
 * the bytes its key names; every read is re-hashed before it is returned.
 */
import { ContentIntegrityError, contentHash, isSha256Hex, type ContentStore } from "@metafarm/domain";
import type { ObjectStorage } from "./object-storage";

const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

export function contentKey(tenantId: string, sha256: string): string {
  if (!TENANT.test(tenantId) || !isSha256Hex(sha256)) throw new Error("invalid content key components");
  return `tenants/${tenantId}/content/${sha256}`;
}

async function readAll(body: NodeJS.ReadableStream | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export function createObjectContentStore(storage: ObjectStorage, tenantId: string, o: { maxBytes?: number } = {}): ContentStore {
  const maxBytes = o.maxBytes ?? 20 * 1024 * 1024;
  return {
    async put(bytes, mediaType) {
      if (!MEDIA_TYPE.test(mediaType)) throw new RangeError("mediaType must be a type/subtype");
      if (bytes.length > maxBytes) throw new RangeError(`content is larger than ${maxBytes} bytes`);
      const sha256 = await contentHash(bytes);
      const key = contentKey(tenantId, sha256);
      // Same key, same bytes: nothing to do if it is already there.
      if (!(await storage.head(key))) await storage.putObject(key, Buffer.from(bytes), mediaType);
      return { sha256, size: bytes.length, mediaType, ref: `sha256:${sha256}` };
    },
    async get(sha256) {
      if (!isSha256Hex(sha256)) return null;
      const obj = await storage.getObject(contentKey(tenantId, sha256));
      if (!obj) return null;
      const bytes = new Uint8Array(await readAll(obj.body));
      if ((await contentHash(bytes)) !== sha256) throw new ContentIntegrityError(sha256);
      return bytes;
    },
    async has(sha256) {
      return isSha256Hex(sha256) && !!(await storage.head(contentKey(tenantId, sha256)));
    },
  };
}
