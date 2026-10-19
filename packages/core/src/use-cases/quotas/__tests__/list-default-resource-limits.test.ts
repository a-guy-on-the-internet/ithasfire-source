import { describe, expect, it, vi } from "vitest";
import { listDefaultResourceLimits } from "../list-default-resource-limits";
import type { ListDefaultResourceLimitsDeps } from "../list-default-resource-limits";
import {
  ALL_RESOURCE_LIMIT_KINDS,
  DEFAULT_RESOURCE_LIMITS,
} from "@th/types/repos/resource-quotas";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

const SAMPLE_LIMITS = [
  {
    kind: "ORGS_OWNED" as const,
    limitValue: 5n,
    updatedAt: new Date(),
    createdAt: new Date(),
  },
  {
    kind: "EVENTS_PER_ORG" as const,
    limitValue: 100n,
    updatedAt: new Date(),
    createdAt: new Date(),
  },
];

function makeDeps(overrides?: {
  staffAllowed?: boolean;
  limits?: typeof SAMPLE_LIMITS;
}): ListDefaultResourceLimitsDeps {
  return {
    authz: {
      hasStaffRole: vi.fn(async () => ({
        allowed: overrides?.staffAllowed ?? true,
      })),
    } as any,
    repos: {
      resourceQuotas: {
        listDefaultLimits: vi.fn(
          async () => overrides?.limits ?? SAMPLE_LIMITS,
        ),
      },
    } as any,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("listDefaultResourceLimits", () => {
  it("returns all resource kinds, merging DB rows with fallbacks", async () => {
    const deps = makeDeps();
    const result = await listDefaultResourceLimits(deps, {
      actorHumanId: ACTOR_ID,
    });

    // Must return every known kind, in order.
    expect(result.items.map((i) => i.kind)).toEqual([
      ...ALL_RESOURCE_LIMIT_KINDS,
    ]);

    // DB-configured rows should be marked isConfigured=true with their DB value.
    const orgsOwned = result.items.find((i) => i.kind === "ORGS_OWNED")!;
    expect(orgsOwned.limitValue).toBe("5");
    expect(orgsOwned.isConfigured).toBe(true);

    const eventsPerOrg = result.items.find((i) => i.kind === "EVENTS_PER_ORG")!;
    expect(eventsPerOrg.limitValue).toBe("100");
    expect(eventsPerOrg.isConfigured).toBe(true);

    // Kinds without a DB row should use the fallback and be marked isConfigured=false.
    const orgsJoined = result.items.find((i) => i.kind === "ORGS_JOINED")!;
    expect(orgsJoined.limitValue).toBe(
      DEFAULT_RESOURCE_LIMITS.ORGS_JOINED.toString(),
    );
    expect(orgsJoined.isConfigured).toBe(false);
  });

  it("returns all fallback values when no DB rows exist", async () => {
    const deps = makeDeps({ limits: [] });
    const result = await listDefaultResourceLimits(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result.items).toHaveLength(ALL_RESOURCE_LIMIT_KINDS.length);
    for (const item of result.items) {
      expect(item.isConfigured).toBe(false);
      expect(item.limitValue).toBe(
        DEFAULT_RESOURCE_LIMITS[
          item.kind as keyof typeof DEFAULT_RESOURCE_LIMITS
        ].toString(),
      );
    }
  });

  it("throws platform_staff_required when actor lacks staff role", async () => {
    const deps = makeDeps({ staffAllowed: false });
    await expect(
      listDefaultResourceLimits(deps, { actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("checks for ADMIN, REVIEWER, SUPPORT roles", async () => {
    const deps = makeDeps();
    await listDefaultResourceLimits(deps, { actorHumanId: ACTOR_ID });

    expect(deps.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "REVIEWER", "SUPPORT"],
    });
  });

  it("rejects invalid input (missing actorHumanId)", async () => {
    const deps = makeDeps();
    await expect(listDefaultResourceLimits(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
