"use client";
/**
 * Offline outbox. Writes made in the field without signal (completing a task, recording an
 * observation or a harvest) are kept on the device and sent, in order, when the connection is
 * back. Each carries an Idempotency-Key, so a resend after a dropped response never records twice.
 *
 * Entries belong to the person who made them: only they see and send them, with their own sign-in.
 * Photos need a connection, so they are not queued.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { API_URL } from "./api";
import { session } from "./auth";
import { outcomeOf } from "./outbox-outcome";

export type OutboxKind = "task" | "observation" | "harvest";

export interface OutboxEntry {
  /** Also the Idempotency-Key. */
  id: string;
  userId: string;
  tenantId: string;
  kind: OutboxKind;
  /** Shown to the person, e.g. the task title or "Soil moisture 0.21". */
  label: string;
  path: string;
  body: unknown;
  createdAt: string;
  status: "pending" | "failed";
  error?: string;
}

const KEY = "metafarm.outbox.v1";
const listeners = new Set<() => void>();
let snapshot: OutboxEntry[] | undefined;

function read(): OutboxEntry[] {
  if (snapshot) return snapshot;
  try {
    const raw = window.localStorage.getItem(KEY);
    snapshot = raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
  } catch {
    snapshot = [];
  }
  return snapshot;
}

function write(entries: OutboxEntry[]) {
  snapshot = entries;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* storage full or blocked: the entries still live in memory for this visit */
  }
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  // Another tab changed the outbox.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    snapshot = undefined;
    listeners.forEach((l) => l());
  });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const EMPTY: OutboxEntry[] = [];

/** This person's queued writes, oldest first. */
export function useOutbox(userId: string | undefined): OutboxEntry[] {
  const all = useSyncExternalStore(subscribe, read, () => EMPTY);
  return userId ? all.filter((e) => e.userId === userId) : EMPTY;
}

export function discard(id: string) {
  write(read().filter((e) => e.id !== id));
}

async function post(path: string, body: unknown, key: string): Promise<Response> {
  const token = session.getToken();
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function errorMessage(res: Response): Promise<string> {
  const b = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
  return b?.message ?? res.statusText ?? String(res.status);
}

export type SendResult<T> = { queued: false; data: T } | { queued: true };

/**
 * Sends a write now, or keeps it for later when there is no connection.
 * Throws (with the server's message) when the server refuses it.
 */
export async function sendOrQueue<T>(w: { userId: string; tenantId: string; kind: OutboxKind; label: string; path: string; body: unknown }): Promise<SendResult<T>> {
  const id = crypto.randomUUID();
  const queue = (): SendResult<T> => {
    write([...read(), { ...w, id, createdAt: new Date().toISOString(), status: "pending" }]);
    return { queued: true };
  };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return queue();
  let res: Response;
  try {
    res = await post(w.path, w.body, id);
  } catch {
    return queue();
  }
  if (res.ok) return { queued: false, data: (await res.json()) as T };
  if (res.status >= 500 || res.status === 408) return queue();
  throw Object.assign(new Error(await errorMessage(res)), { status: res.status });
}

let flushing: Promise<number> | undefined;

/** Sends this person's pending entries in order. Resolves to how many were sent. */
export function flush(userId: string): Promise<number> {
  flushing ??= (async () => {
    let sent = 0;
    try {
      for (const e of read().filter((x) => x.userId === userId && x.status === "pending")) {
        let status: number | "network";
        let res: Response | undefined;
        try {
          res = await post(e.path, e.body, e.id);
          status = res.status;
        } catch {
          status = "network";
        }
        const outcome = outcomeOf(status);
        if (outcome === "retry-later") break;
        if (outcome === "sent") {
          sent++;
          write(read().filter((x) => x.id !== e.id));
        } else {
          const error = res ? await errorMessage(res) : undefined;
          write(read().map((x) => (x.id === e.id ? { ...x, status: "failed", error } : x)));
        }
      }
    } finally {
      flushing = undefined;
    }
    return sent;
  })();
  return flushing;
}

/** Whether the browser thinks it has a connection, kept current. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
