import { describe, expect, it, vi } from "vitest";
import { getEffectiveQuota } from "../get-effective-quota";
import type { GetEffectiveQuotaDeps } from "../get-effective-quota";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

function makeDeps(overrides?: {
  limitValue?: bigint;
  currentUsage?: bigint;
  isOverride?: boolean;
  hasPending?: boolean;
  trustLevel?: 0 | 1 | 2 | 3;
  /** When false, getOrgMembership resolves null (actor is not a member). */
  isMember?: boolean;
}): GetEffectiveQuotaDeps {
  return {
    repos: {
      resourceQuotas: {
        getEffectiveQuota: vi.fn(async () => ({
          kind: "EVENTS_PER_ORG" as const,
          limitValue: overrides?.limitValue ?? 50n,
          currentUsage: overrides?.currentUsage ?? 10n,
          isOverride: overrides?.isOverride ?? false,
          trustLevel: overrides?.trustLevel,
        })),
        hasPendingExpansionRequest: vi.fn(
          async () => overrides?.hasPending ?? false,
        ),
      },
      authz: {
        getOrgMembership: vi.fn(async ({ orgId, humanId }) =>
          (overrides?.isMember ?? true)
            ? { orgId, humanId, role: "EDITOR" as const }
            : null,
        ),
      },
    } as any,
  };
}

function validInput(overrides?: Partial<Record<string, unknown>>) {
  return {
    actorHumanId: ACTOR_ID,
    subjectType: "ORG",
    subjectId: "org-1",
    kind: "EVENTS_PER_ORG",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("getEffectiveQuota", () => {
  it("returns serialized quota with no pending request", async () => {
    const deps = makeDeps({ limitValue: 50n, currentUsage: 10n });
    const result = await getEffectiveQuota(deps, validInput());

    expect(result).toEqual({
      kind: "EVENTS_PER_ORG",
      limitValue: "50",
      currentUsage: "10",
      isOverride: false,
      hasPendingExpansionRequest: false,
    });
  });

  it("returns hasPendingExpansionRequest when pending", async () => {
    const deps = makeDeps({ hasPending: true });
    const result = await getEffectiveQuota(deps, validInput());

    expect(result.hasPendingExpansionRequest).toBe(true);
  });

  it("reflects isOverride from repo", async () => {
    const deps = makeDeps({ isOverride: true });
    const result = await getEffectiveQuota(deps, validInput());

    expect(result.isOverride).toBe(true);
  });

  it("calls getEffectiveQuota and hasPendingExpansionRequest with correct params", async () => {
    const deps = makeDeps();
    await getEffectiveQuota(deps, validInput());

    expect(deps.repos.resourceQuotas.getEffectiveQuota).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: "org-1",
      kind: "EVENTS_PER_ORG",
    });
    expect(
      deps.repos.resourceQuotas.hasPendingExpansionRequest,
    ).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: "org-1",
      kind: "EVENTS_PER_ORG",
    });
  });

  it("throws on invalid input (missing kind)", async () => {
    const deps = makeDeps();
    await expect(
      getEffectiveQuota(deps, {
        actorHumanId: ACTOR_ID,
        subjectType: "ORG",
        subjectId: "org-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("passes through trustLevel when repo returns it", async () => {
    const deps = makeDeps({ trustLevel: 2, limitValue: 250n });
    const result = await getEffectiveQuota(deps, validInput());

    expect(result.trustLevel).toBe(2);
    expect(result.limitValue).toBe("250");
  });

  it("omits trustLevel when repo does not set it", async () => {
    const deps = makeDeps();
    const result = await getEffectiveQuota(deps, validInput());

    expect(result.trustLevel).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cross-tenant authorization (IDOR closed)
  // ───────────────────────────────────────────────────────────────────────────

  it("throws when reading a HUMAN subject that is not the actor", async () => {
    const deps = makeDeps();

    await expect(
      getEffectiveQuota(
        deps,
        validInput({
          subjectType: "HUMAN",
          subjectId: "00000000-0000-4000-8000-0000000000ff",
          kind: "ORGS_OWNED",
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("returns quota when reading the actor's own HUMAN subject", async () => {
    const deps = makeDeps();
    const result = await getEffectiveQuota(
      deps,
      validInput({
        subjectType: "HUMAN",
        subjectId: ACTOR_ID,
        kind: "ORGS_OWNED",
      }),
    );

    expect(result.kind).toBe("EVENTS_PER_ORG");
  });

  it("throws when reading an ORG subject the actor is not a member of", async () => {
    const deps = makeDeps({ isMember: false });

    await expect(
      getEffectiveQuota(deps, validInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
