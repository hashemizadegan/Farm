import type { ObjectStorage, StoredObjectInfo } from "./object-storage";

/** In-memory storage for tests and offline development. Not usable when deployed. */
export function createMemoryStorage() {
  const objects = new Map<string, StoredObjectInfo>();
  const storage: ObjectStorage & { put(key: string, info: StoredObjectInfo): void } = {
    async presignPut(key, { contentType, ttlSeconds }) {
      return {
        url: `memory://uploads/${encodeURIComponent(key)}`,
        method: "PUT",
        headers: { "content-type": contentType },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      };
    },
    async presignGet(key) {
      return `memory://uploads/${encodeURIComponent(key)}`;
    },
    async head(key) {
      return objects.get(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async ping() {
      return true;
    },
    put(key, info) {
      objects.set(key, info);
    },
  };
  return storage;
}
