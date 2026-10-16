/**
 * Authentication integration point. The API never handles passwords: it
 * accepts bearer tokens issued by an OpenID Connect provider and maps the
 * (issuer, subject) pair to a local user record.
 */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
}

export interface AuthProvider {
  readonly name: string;
  verify(token: string): Promise<VerifiedIdentity>;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
