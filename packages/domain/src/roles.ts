/**
 * Role-based permissions, evaluated per tenant membership. A user has at most
 * one role per tenant. Platform operators do not get implicit tenant access:
 * support access goes through an audited, time-boxed membership.
 */
export const ROLES = ["owner", "admin", "manager", "verifier", "worker", "viewer"] as const;
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
  /** Create, assign, edit and cancel field tasks. */
  "task:manage",
  /** Start and complete tasks assigned to oneself (or unassigned ones). */
  "task:work",
  /** Record a harvest batch (published for traceability). */
  "harvest:record",
  /** Void a harvest batch and retry its registration. */
  "harvest:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ["farm:read", "asset:read", "observation:read", "alert:read"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(READ),
  // Field workers run the day-to-day work: their tasks, observations and photos. They cannot change the farm's setup.
  worker: new Set([...READ, "observation:write", "media:upload", "task:work", "harvest:record"]),
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
    "task:manage",
    "task:work",
    "harvest:record",
    "harvest:manage",
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
    "task:manage",
    "task:work",
    "harvest:record",
    "harvest:manage",
  ]),
  owner: new Set(PERMISSIONS),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
