/**
 * Machine-readable inventory of the HTTP API and its consumers (docs/api-inventory.json):
 * - endpoints: every path and method in openapi.yaml;
 * - consumers: the web app (typed `api.<METHOD>("…")` calls, and template-literal paths for fetch/outbox calls)
 *   and the Unity starter (paths its read clients build);
 * - the worker and the scheduler call no HTTP endpoint: they use the database and the job queue directly.
 *
 * Paths are compared with parameter names erased (`/farms/{farmId}` = `/farms/{}`). Erasable TypeScript only (no
 * dependencies), so it also runs with `node --experimental-strip-types`. Regenerate the committed file from the repo root:
 *   node --experimental-strip-types --input-type=module -e "import {writeFileSync} from 'node:fs'; import {buildInventory} from './packages/contracts/src/api-inventory.ts'; writeFileSync('docs/api-inventory.json', JSON.stringify(buildInventory(process.cwd()), null, 2) + '\\n')"
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface Endpoint {
  method: Method;
  path: string;
  operationId: string | null;
}
export interface ConsumerCall {
  consumer: "web" | "unity";
  /** Null when the method is not visible at the call site (a template path handed to fetch/outbox). */
  method: Method | null;
  path: string;
  file: string;
}

const METHODS: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const normalizePath = (p: string) => p.replace(/\{[^}]*\}/g, "{}").replace(/\$\{[^}]*\}/g, "{}");

/** openapi.yaml paths and methods, read line by line (two-space path keys, four-space method keys). */
export function readEndpoints(openapiText: string): Endpoint[] {
  const out: Endpoint[] = [];
  let current: string | null = null;
  let pending: Endpoint | null = null;
  for (const line of openapiText.split("\n")) {
    const p = /^ {2}(\/[^:\s]*):\s*$/.exec(line);
    if (p) {
      current = p[1]!;
      continue;
    }
    if (/^\S/.test(line)) current = null;
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (current && m) {
      pending = { method: m[1]!.toUpperCase() as Method, path: current, operationId: null };
      out.push(pending);
      continue;
    }
    const op = /^ {6}operationId:\s*(\S+)/.exec(line);
    if (pending && op) pending.operationId = op[1]!;
  }
  return out;
}

function files(dir: string, ext: RegExp, skip: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (skip.test(full)) continue;
    if (statSync(full).isDirectory()) out.push(...files(full, ext, skip));
    else if (ext.test(name)) out.push(full);
  }
  return out.sort();
}

export function readWebCalls(root: string): ConsumerCall[] {
  const out: ConsumerCall[] = [];
  for (const f of files(path.join(root, "apps/web/src"), /\.(ts|tsx)$/, /node_modules|\.test\.|generated/)) {
    const text = readFileSync(f, "utf8");
    const rel = path.relative(root, f);
    for (const m of text.matchAll(/api\.(GET|POST|PUT|PATCH|DELETE)\("([^"]+)"/g)) out.push({ consumer: "web", method: m[1] as Method, path: m[2]!, file: rel });
    // Template paths for fetch/outbox (method set elsewhere): `/v1/...${x}...`, query strings dropped.
    for (const m of text.matchAll(/`(?:\$\{API_URL\})?(\/v1\/[^`?]*)/g)) out.push({ consumer: "web", method: null, path: normalizePath(m[1]!), file: rel });
  }
  return out;
}

/** The base each Unity read client prepends to the paths it passes to GetAsync/GetBodyAsync. */
const UNITY_BASES: Record<string, string> = {
  "TwinReadClient.cs": "/v1/tenants/{}/twin",
  "YieldReadClient.cs": "/v1/tenants/{}/yield",
};

export function readUnityCalls(root: string): ConsumerCall[] {
  const out: ConsumerCall[] = [];
  for (const f of files(path.join(root, "clients/unity-starter/Runtime/Core"), /\.cs$/, /Mocks/)) {
    const text = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const rel = path.relative(root, f);
    const base = UNITY_BASES[path.basename(f)];
    const clean = (p: string) =>
      normalizePath(p.replace(/\{(query|PlanQuery\([^)]*\))\}/g, "").replace(/\{[^{}]*\(([^,)]+)[^{}]*\)\}/g, "{$1}"))
        .split("?")[0]!;
    if (base) {
      for (const m of text.matchAll(/(?:GetAsync<\w+>|GetBodyAsync)\(\$"(\/[^"]*)"/g)) out.push({ consumer: "unity", method: "GET", path: normalizePath(base + clean(m[1]!)), file: rel });
    }
    for (const m of text.matchAll(/\$"(\/v1\/[^"]*)"/g)) {
      if (base && m[1]!.endsWith("Path}")) continue; // the client's own base + {path}
      out.push({ consumer: "unity", method: "GET", path: clean(m[1]!), file: rel });
    }
  }
  return out;
}

export interface Inventory {
  scheme: "metafarm-api-inventory/1";
  note: string;
  endpoints: { method: Method; path: string; operationId: string | null; consumers: ("web" | "unity")[] }[];
  /** Client calls with no documented endpoint (must be empty). */
  undocumentedCalls: ConsumerCall[];
  summary: { endpoints: number; consumedByWeb: number; consumedByUnity: number; withoutClientConsumer: number };
}

export function buildInventory(root: string): Inventory {
  const endpoints = readEndpoints(readFileSync(path.join(root, "packages/contracts/openapi.yaml"), "utf8"));
  const calls = [...readWebCalls(root), ...readUnityCalls(root)];
  const key = (method: string, p: string) => `${method} ${normalizePath(p)}`;
  const byKey = new Map(endpoints.map((e) => [key(e.method, e.path), e]));
  const byPath = new Set(endpoints.map((e) => normalizePath(e.path)));
  const consumers = new Map<string, Set<"web" | "unity">>();
  const undocumented: ConsumerCall[] = [];
  for (const c of calls) {
    const matches = c.method ? (byKey.has(key(c.method, c.path)) ? [key(c.method, c.path)] : []) : METHODS.map((m) => key(m, c.path)).filter((k) => byKey.has(k));
    if (matches.length === 0 && !(c.method === null && byPath.has(normalizePath(c.path)))) undocumented.push(c);
    for (const k of matches) {
      if (!consumers.has(k)) consumers.set(k, new Set());
      consumers.get(k)!.add(c.consumer);
    }
  }
  const rows = endpoints.map((e) => ({ method: e.method, path: e.path, operationId: e.operationId, consumers: [...(consumers.get(key(e.method, e.path)) ?? [])].sort() }));
  return {
    scheme: "metafarm-api-inventory/1",
    note: "Generated by packages/contracts/src/api-inventory.ts; the worker and scheduler use the database and job queue, not the HTTP API. An endpoint without a client consumer may serve integrations, sensors, webhooks or operators.",
    endpoints: rows,
    undocumentedCalls: undocumented.sort((a, b) => `${a.file}${a.path}`.localeCompare(`${b.file}${b.path}`)),
    summary: {
      endpoints: rows.length,
      consumedByWeb: rows.filter((r) => r.consumers.includes("web")).length,
      consumedByUnity: rows.filter((r) => r.consumers.includes("unity")).length,
      withoutClientConsumer: rows.filter((r) => r.consumers.length === 0).length,
    },
  };
}
