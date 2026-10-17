import type { Schemas } from "./api";

export type Role = Schemas["Role"];

/** Roles from most to least access. Names and descriptions are translated in i18n/messages (`roles`). */
export const ROLE_ORDER: Role[] = ["owner", "admin", "manager", "verifier", "viewer"];
