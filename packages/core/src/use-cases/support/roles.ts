import type { HumanRole } from "@th/ports/authz";

/**
 * Platform staff roles allowed to operate the support inbox (read any thread,
 * reply, change status). Mirrors the `PLATFORM_STAFF_ROLES` set used across the
 * platform router / settlements use cases. SUPPORT is the primary role; ADMIN
 * and DEVELOPER are superset operators.
 */
export const SUPPORT_STAFF_ROLES: readonly HumanRole[] = [
  "ADMIN",
  "SUPPORT",
  "DEVELOPER",
] as const;
