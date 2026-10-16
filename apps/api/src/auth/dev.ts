import { SignJWT, jwtVerify } from "jose";
import { AuthError, type AuthProvider, type VerifiedIdentity } from "./provider";

/**
 * Placeholder provider for local development and automated tests.
 * Tokens are HS256 JWTs signed with DEV_AUTH_SECRET. The config package
 * refuses to start staging/production with this provider enabled.
 */
const DEV_ISSUER = "dev";
const DEV_AUDIENCE = "metafarm-dev";

export function createDevProvider(secret: string): AuthProvider {
  const key = new TextEncoder().encode(secret);
  return {
    name: "dev",
    async verify(token: string): Promise<VerifiedIdentity> {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: DEV_ISSUER,
          audience: DEV_AUDIENCE,
          algorithms: ["HS256"],
        });
        if (!payload.sub) throw new AuthError("token has no subject");
        return {
          issuer: DEV_ISSUER,
          subject: payload.sub,
          name: typeof payload.name === "string" ? payload.name : undefined,
        };
      } catch {
        throw new AuthError("invalid token");
      }
    },
  };
}

export async function mintDevToken(secret: string, subject: string, name?: string, ttl = "8h"): Promise<string> {
  return new SignJWT(name ? { name } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(DEV_ISSUER)
    .setAudience(DEV_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(new TextEncoder().encode(secret));
}
