import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Repos, TxRepos } from "@th/ports/repos";
import {
  requestQuotaExpansion,
  type RequestQuotaExpansionDeps,
} from "../request-quota-expansion";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = randomUUID();
const EXPANSION_ID = randomUUID();

function makeResourceQuotasMock(overrides?: {
  hasPending?: boolean;
  limitValue?: bigint;
}) {
  return {
    hasPendingExpansionRequest: vi.fn(
      async () => overrides?.hasPending ?? false,
    ),
    getEffectiveQuota: vi.fn(async () => ({
      kind: "ORGS_OWNED",
      limitValue: overrides?.limitValue ?? 3n,
      currentUsage: 3n,
      isOverride: false,
    })),
    createExpansionRequest: vi.fn(async (input: any) => ({
      id: EXPANSION_ID,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      currentLimitValue: input.currentLimitValue,
      requestedLimitValue: input.requestedLimitValue,
      reason: input.reason,
      status: "PENDING",
      requestedByHumanId: input.requestedByHumanId,
      reviewedByHumanId: null,
      reviewedAt: null,
      reviewNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  };
}

function makeDeps(overrides?: {
  hasPending?: boolean;
  limitValue?: bigint;
  /** When false, getOrgMembership resolves null (actor is not a member). */
  isMember?: boolean;
  /** Org role the membership mock reports (defaults to EDITOR). */
  memberRole?: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" | "FINANCE" | "SCANNER";
}): RequestQuotaExpansionDeps {
  const rqMock = makeResourceQuotasMock(overrides);
  const auditMock = { log: vi.fn(async () => {}) };

  const authzMock = {
    getOrgMembership: vi.fn(async ({ orgId, humanId }: any) =>
      (overrides?.isMember ?? true)
        ? { orgId, humanId, role: overrides?.memberRole ?? "EDITOR" }
        : null,
    ),
  };

  const txRepos = {
    resourceQuotas: rqMock,
    audit: auditMock,
    authz: authzMock,
  };

  const repos = {
    authz: authzMock,
    tx: vi.fn(async (fn: any) => fn(txRepos)),
  } as unknown as Repos;

  return { repos };
}

function validInput(overrides?: Record<string, unknown>) {
  return {
    actorHumanId: ACTOR_ID,
    subjectType: "HUMAN",
    subjectId: ACTOR_ID,
    kind: "ORGS_OWNED",
    requestedLimitValue: 10,
    reason: "I need more orgs for my events business",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("requestQuotaExpansion", () => {
  it("creates an expansion request on happy path", async () => {
    const deps = makeDeps();
    const result = await requestQuotaExpansion(deps, validInput());

    expect(result.expansionRequestId).toBe(EXPANSION_ID);
    expect(result.status).toBe("PENDING");
  });

  it("throws conflict when a PENDING request already exists", async () => {
    const deps = makeDeps({ hasPending: true });

    await expect(
      requestQuotaExpansion(deps, validInput()),
    ).rejects.toMatchObject({ code: "EXPANSION_REQUEST_ALREADY_PENDING" });
  });

  it("throws invalid_input when requested limit is not higher than current", async () => {
    const deps = makeDeps({ limitValue: 10n });

    await expect(
      requestQuotaExpansion(deps, validInput({ requestedLimitValue: 5 })),
    ).rejects.toMatchObject({ code: "REQUESTED_LIMIT_NOT_HIGHER" });
  });

  it("throws invalid_input when requested limit equals current", async () => {
    const deps = makeDeps({ limitValue: 10n });

    await expect(
      requestQuotaExpansion(deps, validInput({ requestedLimitValue: 10 })),
    ).rejects.toMatchObject({ code: "REQUESTED_LIMIT_NOT_HIGHER" });
  });

  it("rejects reason shorter than 10 chars", async () => {
    const deps = makeDeps();

    await expect(
      requestQuotaExpansion(deps, validInput({ reason: "short" })),
    ).rejects.toThrow();
  });

  it("rejects reason longer than 1000 chars", async () => {
    const deps = makeDeps();

    await expect(
      requestQuotaExpansion(deps, validInput({ reason: "x".repeat(1001) })),
    ).rejects.toThrow();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Cross-tenant authorization (IDOR closed)
  // ───────────────────────────────────────────────────────────────────────────

  it("throws when filing against a HUMAN subject that is not the actor", async () => {
    const deps = makeDeps();

    await expect(
      requestQuotaExpansion(
        deps,
        validInput({ subjectId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    // The authz guard must run before any tx/mutation work.
    expect(deps.repos.tx).not.toHaveBeenCalled();
  });

  it("throws when filing against an ORG subject the actor is not a member of", async () => {
    const deps = makeDeps({ isMember: false });

    await expect(
      requestQuotaExpansion(
        deps,
        validInput({
          subjectType: "ORG",
          subjectId: "org-1",
          kind: "EVENTS_PER_ORG",
        }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(deps.repos.tx).not.toHaveBeenCalled();
  });

  it("creates an expansion request for an ORG subject the actor is a member of", async () => {
    const deps = makeDeps();
    const result = await requestQuotaExpansion(
      deps,
      validInput({
        subjectType: "ORG",
        subjectId: "org-1",
        kind: "EVENTS_PER_ORG",
      }),
    );

    expect(result.expansionRequestId).toBe(EXPANSION_ID);
    expect(result.status).toBe("PENDING");
  });

  it.each(["VIEWER", "SCANNER"] as const)(
    "throws when a read-only %s org member files an expansion request",
    async (memberRole) => {
      const deps = makeDeps({ memberRole });

      await expect(
        requestQuotaExpansion(
          deps,
          validInput({
            subjectType: "ORG",
            subjectId: "org-1",
            kind: "EVENTS_PER_ORG",
          }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

      expect(deps.repos.tx).not.toHaveBeenCalled();
    },
  );
});
