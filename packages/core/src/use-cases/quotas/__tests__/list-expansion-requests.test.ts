import { describe, expect, it, vi } from "vitest";
import { listExpansionRequests } from "../list-expansion-requests";
import type { ListExpansionRequestsDeps } from "../list-expansion-requests";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

const SAMPLE_ITEM = {
  id: "exp-1",
  subjectType: "ORG" as const,
  subjectId: "org-1",
  kind: "EVENTS_PER_ORG" as const,
  currentLimitValue: 50n,
  requestedLimitValue: 100n,
  reason: "Need more events for music festival",
  status: "PENDING" as const,
  requestedByHumanId: "h-2",
  reviewedByHumanId: null,
  reviewedAt: null,
  reviewNote: null,
  createdAt: new Date("2025-01-15T10:00:00Z"),
};

function makeDeps(overrides?: {
  staffAllowed?: boolean;
  items?: (typeof SAMPLE_ITEM)[];
  total?: number;
}): ListExpansionRequestsDeps {
  return {
    authz: {
      hasStaffRole: vi.fn(async () => ({
        allowed: overrides?.staffAllowed ?? true,
      })),
    } as any,
    repos: {
      resourceQuotas: {
        listExpansionRequests: vi.fn(async () => ({
          items: overrides?.items ?? [SAMPLE_ITEM],
          total: overrides?.total ?? overrides?.items?.length ?? 1,
        })),
      },
    } as any,
  };
}

function validInput(overrides?: Partial<Record<string, unknown>>) {
  return {
    actorHumanId: ACTOR_ID,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("listExpansionRequests", () => {
  it("returns paginated items with bigint values serialized", async () => {
    const deps = makeDeps();
    const result = await listExpansionRequests(deps, validInput());

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "exp-1",
      kind: "EVENTS_PER_ORG",
      currentLimitValue: "50",
      requestedLimitValue: "100",
      status: "PENDING",
    });
    expect(result.total).toBe(1);
  });

  it("passes status filter and pagination to repo", async () => {
    const deps = makeDeps();
    await listExpansionRequests(
      deps,
      validInput({ status: "PENDING", limit: 10, offset: 5 }),
    );

    expect(
      deps.repos.resourceQuotas.listExpansionRequests,
    ).toHaveBeenCalledWith({
      status: "PENDING",
      limit: 10,
      offset: 5,
    });
  });

  it("uses default limit and offset when not provided", async () => {
    const deps = makeDeps();
    await listExpansionRequests(deps, validInput());

    expect(
      deps.repos.resourceQuotas.listExpansionRequests,
    ).toHaveBeenCalledWith({
      limit: 20,
      offset: 0,
    });
  });

  it("throws platform_staff_required when actor lacks staff role", async () => {
    const deps = makeDeps({ staffAllowed: false });
    await expect(
      listExpansionRequests(deps, validInput()),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("checks for ADMIN, REVIEWER, SUPPORT roles", async () => {
    const deps = makeDeps();
    await listExpansionRequests(deps, validInput());

    expect(deps.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: ["ADMIN", "REVIEWER", "SUPPORT"],
    });
  });

  it("returns empty list when no requests exist", async () => {
    const deps = makeDeps({ items: [], total: 0 });
    const result = await listExpansionRequests(deps, validInput());

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});
