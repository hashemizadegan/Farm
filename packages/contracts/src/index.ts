/**
 * Typed API client generated from openapi.yaml.
 *
 * `src/generated/api.ts` is produced by `pnpm contracts:openapi` (also run on
 * install via the root `postinstall`). Do not edit it by hand.
 */
import createClient, { type Middleware } from "openapi-fetch";
import type { components, operations, paths } from "./generated/api";

export type { components, operations, paths };
export type Schemas = components["schemas"];

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns a bearer token for the current user, or undefined when signed out. */
  getToken?: () => Promise<string | undefined> | string | undefined;
  fetch?: typeof fetch;
}

export function createApiClient(opts: ApiClientOptions) {
  const client = createClient<paths>({ baseUrl: opts.baseUrl, fetch: opts.fetch });
  const auth: Middleware = {
    async onRequest({ request }) {
      const token = await opts.getToken?.();
      if (token) request.headers.set("authorization", `Bearer ${token}`);
      return request;
    },
  };
  client.use(auth);
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
