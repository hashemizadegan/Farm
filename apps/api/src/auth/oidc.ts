import { createRemoteJWKSet, jwtVerify } from "jose";
import { AuthError, type AuthProvider, type VerifiedIdentity } from "./provider";

/**
 * Generic OIDC access-token verifier.
 *
 * TODO(provider-config): set OIDC_ISSUER_URL, OIDC_AUDIENCE and (optionally)
 * OIDC_JWKS_URL for your identity provider. Confirm which claims your
 * provider puts in access tokens (some only include `sub`); if `email` is
 * needed, fetch it from the userinfo endpoint instead of trusting the token.
 */
export function createOidcProvider(opts: { issuerUrl: string; audience: string; jwksUrl?: string }): AuthProvider {
  const issuer = opts.issuerUrl.replace(/\/$/, "");
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl ?? `${issuer}/.well-known/jwks.json`), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
  });

  return {
    name: "oidc",
    async verify(token: string): Promise<VerifiedIdentity> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: [issuer, `${issuer}/`],
          audience: opts.audience,
          algorithms: ["RS256", "ES256", "PS256", "EdDSA"],
          clockTolerance: 30,
        });
        if (!payload.sub) throw new AuthError("token has no subject");
        return {
          issuer,
          subject: payload.sub,
          email: typeof payload.email === "string" && payload.email_verified === true ? payload.email : undefined,
          name: typeof payload.name === "string" ? payload.name : undefined,
        };
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw new AuthError("invalid token");
      }
    },
  };
}
