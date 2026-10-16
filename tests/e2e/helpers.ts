import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const tokensPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tokens.json");

export function tokens(): { owner: string; other: string } {
  return JSON.parse(readFileSync(tokensPath, "utf8"));
}

/** Signs in through the development sign-in form (keyboard only). */
export async function signIn(page: Page, who: "owner" | "other" = "owner") {
  await page.goto("/sign-in");
  await page.getByLabel("Development token").fill(tokens()[who]);
  await page.getByRole("button", { name: "Sign in" }).press("Enter");
  await page.waitForURL("**/farms");
}

export const API = process.env.E2E_API_URL ?? "http://localhost:4000";

/** Unique name so repeated runs against the same database do not collide. */
export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}`;

/** Random small square far from previous runs, so duplicate-geometry checks do not trip. */
export function randomCoords() {
  const lat = 30 + Math.random() * 20;
  const lon = -10 + Math.random() * 40;
  return { lat: lat.toFixed(6), lon: lon.toFixed(6) };
}
