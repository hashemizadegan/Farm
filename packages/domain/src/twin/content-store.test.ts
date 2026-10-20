import { describe, expect, it } from "vitest";
import { checkStorageRef, contentHash } from "./commitments";
import { ContentIntegrityError, createMemoryContentStore } from "./content-store";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("memory content store", () => {
  it("addresses content by its SHA-256 and returns it checked", async () => {
    const store = createMemoryContentStore();
    const ref = await store.put(bytes("hello farm"), "text/plain");
    expect(ref).toEqual({ sha256: await contentHash("hello farm"), size: 10, mediaType: "text/plain", ref: `sha256:${await contentHash("hello farm")}` });
    expect(checkStorageRef(ref.ref, ref.sha256)).toEqual({ kind: "hash" });
    expect(new TextDecoder().decode((await store.get(ref.sha256))!)).toBe("hello farm");
    expect(await store.has(ref.sha256)).toBe(true);
  });

  it("stores the same bytes once", async () => {
    const store = createMemoryContentStore();
    await store.put(bytes("x"), "text/plain");
    await store.put(bytes("x"), "application/octet-stream");
    expect(store.size).toBe(1);
  });

  it("refuses to return bytes that no longer match their address", async () => {
    const store = createMemoryContentStore();
    const ref = await store.put(bytes("original"), "text/plain");
    store.corrupt(ref.sha256, bytes("changed"));
    await expect(store.get(ref.sha256)).rejects.toThrow(ContentIntegrityError);
  });

  it("answers null for unknown or malformed addresses and refuses bad input", async () => {
    const store = createMemoryContentStore({ maxBytes: 4 });
    expect(await store.get("a".repeat(64))).toBeNull();
    expect(await store.get("../etc/passwd")).toBeNull();
    expect(await store.has("nothex")).toBe(false);
    await expect(store.put(bytes("toolong"), "text/plain")).rejects.toThrow(RangeError);
    await expect(store.put(bytes("ok"), "not a type")).rejects.toThrow(RangeError);
  });
});
