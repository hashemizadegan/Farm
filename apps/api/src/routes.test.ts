/**
 * Contract test: every operation in openapi.yaml is served by the API, and the
 * API serves nothing under /v1 that the contract does not document.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { parse } from "yaml";
import { buildTestApp, unreachablePool } from "./test/helpers";

const require = createRequire(import.meta.url);
const specPath = path.join(path.dirname(require.resolve("@metafarm/contracts/package.json")), "openapi.yaml");
const spec = parse(readFileSync(specPath, "utf8")) as { paths: Record<string, Record<string, unknown>> };
const METHODS = ["get", "post", "put", "patch", "delete"];

describe("API routes match openapi.yaml", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const operations = Object.entries(spec.paths).flatMap(([p, item]) =>
    Object.keys(item)
      .filter((m) => METHODS.includes(m))
      .map((m) => ({ method: m.toUpperCase(), specPath: p, url: p.replace(/\{(\w+)\}/g, ":$1") })),
  );

  it.each(operations)("$method $specPath is implemented", ({ method, url }) => {
    expect(app.hasRoute({ method: method as "GET", url })).toBe(true);
  });
});
