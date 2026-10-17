import { SignJWT } from "jose";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mints development tokens for the seeded users (see packages/db/src/scripts/seed.ts).
 * Uses the same issuer/audience as apps/api/src/auth/dev.ts.
 */
export default async function globalSetup() {
  const secret = process.env.DEV_AUTH_SECRET;
  if (!secret) throw new Error("DEV_AUTH_SECRET must be set for e2e tests (see .env.example)");
  const mint = (sub: string) =>
    new SignJWT({ name: sub })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("dev")
      .setAudience("metafarm-dev")
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(new TextEncoder().encode(secret));

  // "invitee" is used only by the invitation test, so joining a workspace never affects isolation tests.
  const tokens = { owner: await mint("dev-user"), other: await mint("dev-other"), invitee: await mint(`dev-invitee-${Date.now().toString(36)}`) };
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tokens.json");
  writeFileSync(out, JSON.stringify(tokens));
}
