import { describe, expect, it, vi } from "vitest";

import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";

import { getPerformerStatus } from "../get-performer-status";
import type { GetPerformerStatusDeps } from "../get-performer-status";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ENABLED_AT = new Date("2026-05-01T00:00:00.000Z");

function profileFor(
  ownerType: "human" | "organization",
  ownerId: string,
  enabled: boolean,
  acceptsBookingRequests = false,
): PerformerProfileRecord {
  return {
    id: `${ownerId.slice(0, 8)}-0000-4000-8000-000000000000`,
    ownerType,
    ownerId,
    enabledAt: ENABLED_AT,
    disabledAt: enabled ? null : new Date("2026-06-01T00:00:00.000Z"),
    acceptsBookingRequests,
    createdAt: ENABLED_AT,
    updatedAt: ENABLED_AT,
  };
}

/** Minimal stats-row stub — only `totalEventsPerformed` drives eligibility. */
function statsRow(totalEventsPerformed: number) {
  return { totalEventsPerformed };
}

describe("getPerformerStatus", () => {
  it("returns the actor's status plus statuses for administered orgs", async () => {
    const profiles = new Map<string, PerformerProfileRecord>([
      [`human:${ACTOR_ID}`, profileFor("human", ACTOR_ID, true, true)],
      [`organization:${ORG_ID}`, profileFor("organization", ORG_ID, false)],
    ]);

    const deps: GetPerformerStatusDeps = {
      repos: {
        performerProfiles: {
          getByOwner: vi.fn(
            async ({
              ownerType,
              ownerId,
            }: {
              ownerType: string;
              ownerId: string;
            }) => profiles.get(`${ownerType}:${ownerId}`) ?? null,
          ),
        },
        authz: {
          listOrgMembershipsByHumanId: vi.fn(async () => [
            { orgId: ORG_ID, humanId: ACTOR_ID, role: "OWNER" },
          ]),
        },
        humanStats: { findByHumanId: vi.fn(async () => statsRow(5)) },
      } as unknown as GetPerformerStatusDeps["repos"],
    };

    const result = await getPerformerStatus(deps, { actorHumanId: ACTOR_ID });

    expect(result.human).toEqual({
      ownerId: ACTOR_ID,
      enabled: true,
      enabledAt: ENABLED_AT,
      acceptsBookingRequests: true,
      statsEligible: true,
    });
    expect(result.orgs).toEqual([
      {
        ownerId: ORG_ID,
        enabled: false,
        enabledAt: null,
        acceptsBookingRequests: false,
      },
    ]);
  });

  // The acceptance GATE is reported raw (organizer-booking-requests FR-002):
  // disabling performer mode does NOT clear the stored value — the EFFECTIVE
  // receive gate is `enabled && acceptsBookingRequests` (create checks both),
  // so the toggle survives a performer-mode off/on round-trip.
  it("reports the stored acceptance gate even while performer mode is off", async () => {
    const profiles = new Map<string, PerformerProfileRecord>([
      [`human:${ACTOR_ID}`, profileFor("human", ACTOR_ID, false, true)],
      [`organization:${ORG_ID}`, profileFor("organization", ORG_ID, true, true)],
    ]);

    const deps: GetPerformerStatusDeps = {
      repos: {
        performerProfiles: {
          getByOwner: vi.fn(
            async ({
              ownerType,
              ownerId,
            }: {
              ownerType: string;
              ownerId: string;
            }) => profiles.get(`${ownerType}:${ownerId}`) ?? null,
          ),
        },
        authz: {
          listOrgMembershipsByHumanId: vi.fn(async () => [
            { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" },
          ]),
        },
        humanStats: { findByHumanId: vi.fn(async () => null) },
      } as unknown as GetPerformerStatusDeps["repos"],
    };

    const result = await getPerformerStatus(deps, { actorHumanId: ACTOR_ID });

    expect(result.human.enabled).toBe(false);
    expect(result.human.acceptsBookingRequests).toBe(true);
    expect(result.orgs).toEqual([
      {
        ownerId: ORG_ID,
        enabled: true,
        enabledAt: ENABLED_AT,
        acceptsBookingRequests: true,
      },
    ]);
  });

  it("treats a missing profile as disabled (default-off, no jobs[] inference)", async () => {
    const deps: GetPerformerStatusDeps = {
      repos: {
        performerProfiles: { getByOwner: vi.fn(async () => null) },
        authz: { listOrgMembershipsByHumanId: vi.fn(async () => []) },
        humanStats: { findByHumanId: vi.fn(async () => null) },
      } as unknown as GetPerformerStatusDeps["repos"],
    };

    const result = await getPerformerStatus(deps, { actorHumanId: ACTOR_ID });

    expect(result.human.enabled).toBe(false);
    expect(result.orgs).toEqual([]);
  });

  // statsEligible mirrors isPerformerStatsEligible (MIN_SHOWS_FOR_STATS = 3):
  // it drives whether booking surfaces render the verified-stats opt-in at all.
  it.each([
    { label: "3+ completed shows", stats: statsRow(3), expected: true },
    { label: "fewer than 3 shows", stats: statsRow(2), expected: false },
    { label: "no stats row", stats: null, expected: false },
  ])(
    "reports statsEligible=$expected with $label",
    async ({ stats, expected }) => {
      const deps: GetPerformerStatusDeps = {
        repos: {
          performerProfiles: { getByOwner: vi.fn(async () => null) },
          authz: { listOrgMembershipsByHumanId: vi.fn(async () => []) },
          humanStats: { findByHumanId: vi.fn(async () => stats) },
        } as unknown as GetPerformerStatusDeps["repos"],
      };

      const result = await getPerformerStatus(deps, { actorHumanId: ACTOR_ID });

      expect(result.human.statsEligible).toBe(expected);
      expect(
        deps.repos.humanStats.findByHumanId,
      ).toHaveBeenCalledWith(ACTOR_ID);
    },
  );
});
