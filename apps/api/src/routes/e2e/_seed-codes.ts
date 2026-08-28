/**
 * Stable, hardcoded ticket codes used across e2e seeds.
 *
 * These codes are deterministic (no timestamps / no UUIDs) so:
 *   - e2e tests can assert on them without reading the seed response,
 *   - dev users can pre-print QR codes against a seeded DB.
 *
 * Each seed deletes its own codes before recreating, so reseeds are
 * idempotent. Don't reuse the same code across two seeds.
 */
export const SEED_TICKET_CODES = {
  /** seed-admin-tables → "E2E Published Concert" event. */
  ADMIN_CONCERT: [
    "TKT-E2E-CONCERT-001",
    "TKT-E2E-CONCERT-002",
    "TKT-E2E-CONCERT-003",
  ],
  /** seed-platform-tables → "E2E Platform Concert" event. */
  PLATFORM_CONCERT: ["TKT-E2E-PLATFORM-001"],
} as const;

export const ALL_SEED_TICKET_CODES: readonly string[] = [
  ...SEED_TICKET_CODES.ADMIN_CONCERT,
  ...SEED_TICKET_CODES.PLATFORM_CONCERT,
];
