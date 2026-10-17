"use client";
import { ROLE_PERMISSIONS, type Permission } from "@metafarm/domain";
import { useTenant } from "./tenant";

/**
 * Whether the current user's role in the selected workspace grants a
 * permission. UI hint only: the API enforces every permission itself.
 */
export function useCan(): (permission: Permission) => boolean {
  const { me, tenantId } = useTenant();
  const role = me?.tenants.find((t) => t.tenantId === tenantId)?.role;
  return (permission) => (role ? ROLE_PERMISSIONS[role].has(permission) : false);
}
