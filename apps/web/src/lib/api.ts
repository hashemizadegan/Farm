"use client";
import { createApiClient, type Schemas } from "@metafarm/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { session } from "./auth";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const api = createApiClient({ baseUrl: API_URL, getToken: () => session.getToken() });

export type { Schemas };

export interface ApiErrorShape {
  error: string;
  message: string;
  details?: unknown;
}

/** Normalises openapi-fetch results into data-or-throw. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (error || !response.ok) {
    const e = (error ?? { error: "http_error", message: response.statusText }) as ApiErrorShape;
    throw Object.assign(new Error(e.message), { status: response.status, body: e });
  }
  return data as T;
}

export interface QueryState<T> {
  data: T | undefined;
  error: (Error & { status?: number; body?: ApiErrorShape }) | undefined;
  loading: boolean;
  reload: () => void;
}

/** Minimal data hook: fetch on mount and when `key` changes; optional polling. */
export function useQuery<T>(key: string | null, fn: () => Promise<T>, opts: { pollMs?: number } = {}): QueryState<T> {
  const [state, setState] = useState<Omit<QueryState<T>, "reload">>({ data: undefined, error: undefined, loading: !!key });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fnRef
      .current()
      .then((data) => !cancelled && setState({ data, error: undefined, loading: false }))
      .catch((error) => !cancelled && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  // Records queued offline reached the server (components/OfflineStatus): refresh.
  useEffect(() => {
    if (!key) return;
    const refresh = () => setTick((t) => t + 1);
    window.addEventListener("metafarm:synced", refresh);
    return () => window.removeEventListener("metafarm:synced", refresh);
  }, [key]);

  useEffect(() => {
    if (!key || !opts.pollMs) return;
    const id = setInterval(() => setTick((t) => t + 1), opts.pollMs);
    return () => clearInterval(id);
  }, [key, opts.pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
