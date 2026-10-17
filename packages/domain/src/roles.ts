/**
 * Role-based permissions, evaluated per tenant membership. A user has at most
 * one role per tenant. Platform operators do not get implicit tenant access:
 * support access goes through an audited, time-boxed membership.
 */
export const ROLES = ["owner", "admin", "manager", "verifier", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "farm:read",
  "farm:write",
  "boundary:submit",
  "boundary:verify",
  "plan:write",
  "scenario:write",
  "asset:read",
  "asset:write",
  "observation:read",
  "observation:write",
  "alert:read",
  "alert:ack",
  "media:upload",
  "audit:read",
  "member:manage",
  "nft:manage",
  "sensor:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ["farm:read", "asset:read", "observation:read", "alert:read"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(READ),
  // Verifiers upload the evidence file that verification requires.
  verifier: new Set([...READ, "boundary:verify", "media:upload"]),
  manager: new Set([
    ...READ,
    "farm:write",
    "boundary:submit",
    "plan:write",
    "scenario:write",
    "asset:write",
    "observation:write",
    "alert:ack",
    "media:upload",
    "sensor:manage",
  ]),
  admin: new Set([
    ...READ,
    "farm:write",
    "boundary:submit",
    "plan:write",
    "scenario:write",
    "asset:write",
    "observation:write",
    "alert:ack",
    "media:upload",
    "sensor:manage",
    "audit:read",
    "member:manage",
    "nft:manage",
  ]),
  owner: new Set(PERMISSIONS),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
