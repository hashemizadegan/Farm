import type { Schemas } from "./api";

export type Role = Schemas["Role"];

/** Plain-language names and what each role can do, for the team and settings screens. */
export const ROLE_LABELS: Record<Role, { label: string; summary: string }> = {
  owner: { label: "Owner", summary: "Everything an admin can do, and manage other owners." },
  admin: { label: "Admin", summary: "Manage members and settings, read the audit log, and edit all farm data." },
  manager: { label: "Manager", summary: "Create and edit farms, boundaries, plans and observations." },
  verifier: { label: "Verifier", summary: "Review boundaries and verify them by attaching evidence such as a survey." },
  viewer: { label: "Viewer", summary: "Read farm data. Cannot change anything." },
};

export const ROLE_ORDER: Role[] = ["owner", "admin", "manager", "verifier", "viewer"];
