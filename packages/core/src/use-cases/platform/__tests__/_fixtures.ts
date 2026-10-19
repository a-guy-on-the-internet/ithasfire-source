/**
 * Shared test fixtures for platform admin human management use cases.
 *
 * Keeps the four test files DRY without pulling in external packages.
 */

import { vi } from "vitest";

export const NOW = new Date("2026-07-01T12:00:00.000Z");

export function makeClock() {
  return { now: vi.fn(() => NOW) };
}

/** hasStaffRole fake honouring a per-human role map (role intersection). */
export function makeStaffAuthz(rolesByHuman: Record<string, string[]> = {}) {
  return {
    hasStaffRole: vi.fn(
      async ({
        actorHumanId,
        requiredRoles,
      }: {
        actorHumanId: string;
        requiredRoles: string[];
      }) => ({
        allowed: (rolesByHuman[actorHumanId] ?? []).some((role) =>
          requiredRoles.includes(role),
        ),
      }),
    ),
  };
}

export const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
export const TARGET_ID = "22222222-2222-4222-8222-222222222222";
export const TARGET_EMAIL = "jane@example.com";

export function makeHumanFixture(overrides: { emailVerified?: boolean } = {}) {
  return {
    human: {
      id: TARGET_ID,
      name: "Jane Doe",
      status: "ACTIVE" as const,
      roles: ["USER"],
      locale: null,
      phone: null,
      billingAddressLine1: null,
      billingAddressLine2: null,
      billingCity: null,
      billingState: null,
      billingPostalCode: null,
      billingCountry: null,
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
      trustTier: "NEW" as const,
      trustBadgeLabel: null,
      trustBadgeIcon: null,
      createdAt: new Date(),
    },
    identity: {
      authUserId: "aa-bb-cc",
      email: TARGET_EMAIL,
      emailVerified: overrides.emailVerified ?? true,
      phone: null,
      phoneVerified: false,
      username: null,
      displayUsername: null,
      image: null,
    },
  };
}

export type HumanFixture = ReturnType<typeof makeHumanFixture>;
