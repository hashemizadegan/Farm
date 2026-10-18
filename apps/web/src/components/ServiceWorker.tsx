"use client";
import { useEffect } from "react";
import { API_URL } from "@/lib/api";

/** Registers the service worker (public/sw.js) in production builds. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DISABLE_SW === "1" || !("serviceWorker" in navigator)) return;
    const api = new URL(API_URL, window.location.href).origin;
    navigator.serviceWorker.register(`/sw.js?api=${encodeURIComponent(api)}`, { scope: "/" }).catch(() => {
      /* unsupported or blocked: the app still works online */
    });
  }, []);
  return null;
}
