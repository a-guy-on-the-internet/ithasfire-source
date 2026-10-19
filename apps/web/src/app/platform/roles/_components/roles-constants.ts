/**
 * Local mirror of the `HumanRole` enum (packages/db/prisma/enums.prisma).
 *
 * The web app doesn't depend on `@th/ports`, so — matching the rest of the
 * /platform/humans UI (which mirrors server shapes with local interfaces
 * instead of importing server types) — this list is a plain client-side
 * constant. Keep in sync with `HumanRole` if the enum ever changes.
 */
export const ALL_HUMAN_ROLES = [
  "USER",
  "REVIEWER",
  "ADMIN",
  "DEVELOPER",
  "SUPPORT",
  "COMMUNITY_MODERATOR",
] as const;

export type HumanRoleValue = (typeof ALL_HUMAN_ROLES)[number];
