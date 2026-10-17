"use client";
/**
 * Where to send the user after sign-in. Only same-site relative paths are
 * accepted, so a crafted ?next= value cannot redirect off-site.
 */
const KEY = "metafarm.returnTo";

export function safePath(path: string | null | undefined): string | undefined {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return undefined;
  return path;
}

export function rememberReturnTo(path: string | null | undefined) {
  const safe = safePath(path);
  try {
    if (safe) window.sessionStorage.setItem(KEY, safe);
  } catch {
    /* storage unavailable: the user lands on the overview instead */
  }
}

export function takeReturnTo(): string {
  try {
    const v = safePath(window.sessionStorage.getItem(KEY));
    window.sessionStorage.removeItem(KEY);
    return v ?? "/";
  } catch {
    return "/";
  }
}
