import { describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { moderatorApplicationsRouter } from "../moderator-applications";
import { createTestLogger } from "@th/test-utils";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const APPLICANT_ID = "22222222-2222-4222-8222-222222222222";
const APPLICATION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const pendingApplication = {
  id: APPLICATION_ID,
  applicantHumanId: APPLICANT_ID,
  statement: "I run three open mics.",
  status: "PENDING" as const,
  reviewedByHumanId: null,
  reviewedAt: null,
  reviewNote: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const buildCtx = (overrides?: Partial<Ctx>): Ctx =>
  ({
    repos: {} as Ctx["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"],
    clock: { now: () => NOW } as Ctx["clock"],
    rateLimit: withConsumeMany({
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    }) as unknown as Ctx["rateLimit"],
    logger: createTestLogger(),
    actorHumanId: ADMIN_ID,
    auth: { userId: "user-1", sessionId: null, token: "token" },
    authToken: "token",
    apiKey: null,
    ...overrides,
  }) as unknown as Ctx;

const callerFor = (ctx: Ctx) =>
  trpcRouter({
    moderatorApplications: router(moderatorApplicationsRouter),
  }).createCaller(ctx);

describe("moderatorApplications.list", () => {
  it("forbids non-admins", async () => {
    const listPending = vi.fn();
    const repos = { communityModeratorApplications: { listPending } };
    const caller = callerFor(
      buildCtx({ repos: repos as unknown as Ctx["repos"] }),
    );

    await expect(caller.moderatorApplications.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(listPending).not.toHaveBeenCalled();
  });

  it("returns the PENDING queue for platform ADMIN", async () => {
    const listPending = vi.fn(async () => ({
      items: [pendingApplication],
      nextCursor: "cursor-2",
    }));
    const getByIds = vi.fn(async () => [{ id: APPLICANT_ID, name: "Rosa Diaz" }]);
    const repos = {
      communityModeratorApplications: { listPending },
      humans: {
        hasSecondFactorEnrolled: vi.fn(async () => true),
        getByIds,
      },
    };
    const hasStaffRole = vi.fn(async () => ({ allowed: true }));
    const caller = callerFor(
      buildCtx({
        repos: repos as unknown as Ctx["repos"],
        authz: { hasStaffRole } as unknown as Ctx["authz"],
      }),
    );

    const result = await caller.moderatorApplications.list({ limit: 25 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(APPLICATION_ID);
    expect(result.items[0].applicantName).toBe("Rosa Diaz");
    expect(result.items[0].applicantMissing).toBe(false);
    expect(result.nextCursor).toBe("cursor-2");
    expect(hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ADMIN_ID,
      requiredRoles: ["ADMIN"],
    });
    expect(listPending).toHaveBeenCalledWith({ cursor: null, limit: 25 });
    expect(getByIds).toHaveBeenCalledWith([APPLICANT_ID]);
  });

  it("marks a deleted applicant as missing (no human row)", async () => {
    const listPending = vi.fn(async () => ({
      items: [pendingApplication],
      nextCursor: null,
    }));
    const repos = {
      communityModeratorApplications: { listPending },
      humans: {
        hasSecondFactorEnrolled: vi.fn(async () => true),
        getByIds: vi.fn(async () => []),
      },
    };
    const caller = callerFor(
      buildCtx({
        repos: repos as unknown as Ctx["repos"],
        authz: {
          hasStaffRole: vi.fn(async () => ({ allowed: true })),
        } as unknown as Ctx["authz"],
      }),
    );

    const result = await caller.moderatorApplications.list({
      direction: "forward",
    });

    expect(result.items[0]).toMatchObject({
      applicantHumanId: APPLICANT_ID,
      applicantName: null,
      applicantMissing: true,
    });
  });
});

describe("moderatorApplications.review", () => {
  it("forbids non-admin reviewers (ADMIN check lives in the use case)", async () => {
    const caller = callerFor(buildCtx());

    await expect(
      caller.moderatorApplications.review({
        applicationId: APPLICATION_ID,
        decision: "APPROVE",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("approves an application: claims, grants the role, audits", async () => {
    const approved = {
      ...pendingApplication,
      status: "APPROVED" as const,
      reviewedByHumanId: ADMIN_ID,
      reviewedAt: NOW,
    };
    const grantHumanRole = vi.fn(async () => ({ granted: true }));
    const txRepos = {
      communityModeratorApplications: {
        getById: vi.fn(async () => pendingApplication),
        claimPendingForReview: vi.fn(async () => pendingApplication),
        markReviewed: vi.fn(async () => approved),
      },
      humans: { getById: vi.fn(async () => ({ id: APPLICANT_ID })) },
      authz: { grantHumanRole },
      audit: { log: vi.fn(async () => undefined) },
    };
    const repos = {
      tx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txRepos)),
      humans: { hasSecondFactorEnrolled: vi.fn(async () => true) },
    };
    const caller = callerFor(
      buildCtx({
        repos: repos as unknown as Ctx["repos"],
        authz: {
          hasStaffRole: vi.fn(async () => ({ allowed: true })),
        } as unknown as Ctx["authz"],
      }),
    );

    const result = await caller.moderatorApplications.review({
      applicationId: APPLICATION_ID,
      decision: "APPROVE",
    });

    expect(result.application.status).toBe("APPROVED");
    expect(grantHumanRole).toHaveBeenCalledWith({
      humanId: APPLICANT_ID,
      role: "COMMUNITY_MODERATOR",
    });
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "moderator_application.reviewed" }),
    );
  });
});
