import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInventory, normalizePath, readEndpoints } from "./api-inventory";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("API usage inventory", () => {
  it("reads paths, methods and operation ids from the OpenAPI document", () => {
    const text = ["paths:", "  /v1/a/{id}:", "    get:", "      operationId: getA", "    post:", "      operationId: postA", "components:", "  schemas:", "    X: {}"].join("\n");
    expect(readEndpoints(text)).toEqual([
      { method: "GET", path: "/v1/a/{id}", operationId: "getA" },
      { method: "POST", path: "/v1/a/{id}", operationId: "postA" },
    ]);
    expect(normalizePath("/v1/tenants/{tenantId}/farms/${farmId}")).toBe("/v1/tenants/{}/farms/{}");
  });

  it("every path the web app and the Unity client call is documented in openapi.yaml", () => {
    const inv = buildInventory(root);
    expect(inv.undocumentedCalls, JSON.stringify(inv.undocumentedCalls, null, 2)).toEqual([]);
    // The Unity read clients cover the twin, yield and media reads they implement.
    const unity = inv.endpoints.filter((e) => e.consumers.includes("unity")).map((e) => `${e.method} ${e.path}`);
    expect(unity).toContain("GET /v1/tenants/{tenantId}/yield/cycles/{cycleId}");
    expect(unity).toContain("GET /v1/tenants/{tenantId}/twin/farms/{farmId}/scene");
    expect(unity).toContain("GET /v1/tenants/{tenantId}/media/{mediaId}/content");
  });

  it("docs/api-inventory.json is current (regenerate: see the file's note)", () => {
    const committed = JSON.parse(readFileSync(new URL("docs/api-inventory.json", `file://${root}`), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildInventory(root))));
  });
});
