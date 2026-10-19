import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import {
  reviewExpansionRequest,
  type ReviewExpansionRequestDeps,
} from "../review-expansion-request";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = randomUUID();
const REQUEST_ID = randomUUID();

function makeExpansionRequest(overrides?: { status?: string }) {
  return {
    id: REQUEST_ID,
    subjectType: "HUMAN" as const,
    subjectId: randomUUID(),
    kind: "ORGS_OWNED" as const,
    currentLimitValue: 3n,
    requestedLimitValue: 10n,
    reason: "Need more orgs for my business",
    status: overrides?.status ?? "PENDING",
    requestedByHumanId: randomUUID(),
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeDeps(overrides?: {
  isAdmin?: boolean;
  requestStatus?: string;
  requestExists?: boolean;
}): ReviewExpansionRequestDeps {
  const request =
    (overrides?.requestExists ?? true)
      ? makeExpansionRequest({ status: overrides?.requestStatus })
      : null;

  const rqMock = {
    getExpansionRequestById: vi.fn(async () => request),
    reviewExpansionRequest: vi.fn(async (input: any) => ({
      ...request!,
      status: input.status,
      reviewedByHumanId: input.reviewedByHumanId,
      reviewedAt: new Date(),
      reviewNote: input.reviewNote ?? null,
    })),
    upsertOverride: vi.fn(async (input: any) => ({
      id: randomUUID(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      limitValue: input.limitValue,
      note: input.note,
      grantedByHumanId: input.grantedByHumanId,
      updatedAt: new Date(),
      createdAt: new Date(),
    })),
  };

  const auditMock = { log: vi.fn(async () => {}) };
  const txRepos = { resourceQuotas: rqMock, audit: auditMock };
  const repos = {
    tx: vi.fn(async (fn: any) => fn(txRepos)),
  } as unknown as Repos;

  const authz: AuthZPort = {
    hasOrgRole: vi.fn(),
    requireOrgRole: vi.fn(),
    canEditEvent: vi.fn(),
    canManagePlace: vi.fn(),
    canFinanceOrg: vi.fn(),
    hasStaffRole: vi.fn(async () => ({
      allowed: overrides?.isAdmin !== false,
    })),
  };

  return { repos, authz };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewExpansionRequest", () => {
  it("approves a request and creates an override", async () => {
    const deps = makeDeps();
    const result = await reviewExpansionRequest(deps, {
      actorHumanId: ACTOR_ID,
      expansionRequestId: REQUEST_ID,
      decision: "APPROVED",
      reviewNote: "Looks good",
    });

    expect(result.status).toBe("APPROVED");
    expect(result.newLimitValue).toBe("10");
  });

  it("rejects a request without creating an override", async () => {
    const deps = makeDeps();
    const result = await reviewExpansionRequest(deps, {
      actorHumanId: ACTOR_ID,
      expansionRequestId: REQUEST_ID,
      decision: "REJECTED",
      reviewNote: "Too aggressive",
    });

    expect(result.status).toBe("REJECTED");
    expect(result.newLimitValue).toBeUndefined();
  });

  it("throws forbidden when actor is not platform admin", async () => {
    const deps = makeDeps({ isAdmin: false });

    await expect(
      reviewExpansionRequest(deps, {
        actorHumanId: ACTOR_ID,
        expansionRequestId: REQUEST_ID,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws not_found when expansion request does not exist", async () => {
    const deps = makeDeps({ requestExists: false });

    await expect(
      reviewExpansionRequest(deps, {
        actorHumanId: ACTOR_ID,
        expansionRequestId: REQUEST_ID,
        decision: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "EXPANSION_REQUEST_NOT_FOUND" });
  });

  it("throws conflict when request is already reviewed", async () => {
    const deps = makeDeps({ requestStatus: "APPROVED" });

    await expect(
      reviewExpansionRequest(deps, {
        actorHumanId: ACTOR_ID,
        expansionRequestId: REQUEST_ID,
        decision: "REJECTED",
      }),
    ).rejects.toMatchObject({ code: "EXPANSION_REQUEST_ALREADY_REVIEWED" });
  });
});
