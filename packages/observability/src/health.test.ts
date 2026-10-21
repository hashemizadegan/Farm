import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { startHealthServer } from "./health";

const TOKEN = "worker-metrics-token-0123456789abcdef";
const servers: ReturnType<typeof startHealthServer>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(metrics?: { token: string | undefined; render: () => Promise<string> }) {
  const server = startHealthServer({ port: 0, host: "127.0.0.1", checks: [], isDraining: () => false, ...(metrics ? { metrics } : {}) });
  servers.push(server);
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return (path: string, authorization?: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: authorization ? { authorization } : {} });
}

describe("health server metrics", () => {
  it("serves metrics only with the configured token", async () => {
    const get = await serve({ token: TOKEN, render: async () => "metafarm_queue_jobs 0\n" });
    expect((await get("/metrics")).status).toBe(401);
    expect((await get("/metrics", "Bearer wrong")).status).toBe(401);
    const r = await get("/metrics", `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await r.text()).toBe("metafarm_queue_jobs 0\n");
    expect((await get("/healthz")).status).toBe(200);
  });

  it("is 404 without a token, and without metrics at all", async () => {
    expect((await (await serve({ token: undefined, render: async () => "x" }))("/metrics", `Bearer ${TOKEN}`)).status).toBe(404);
    expect((await (await serve())("/metrics", `Bearer ${TOKEN}`)).status).toBe(404);
  });
});
