import { describe, expect, it, vi } from "vitest";

import {
  applyToBeModerator,
  type ApplyToBeModeratorDeps,
} from "../apply-to-be-moderator";
import {
  reviewModeratorApplication,
  type ReviewModeratorApplicationDeps,
} from "../review-moderator-application";
import type { CommunityModeratorApplicationRecord } from "@th/ports/repos/community-moderator-applications";
import {
  ADMIN_ID,
  APPLICATION_ID,
  MODERATOR_ID,
  NOW,
  USER_ID,
  makeApplication,
  makeClock,
  makeContentFilter,
  makeStaffAuthz,
} from "./helpers";

// ─── applyToBeModerator ──────────────────────────────────────────────────────

function buildApplyDeps(
  overrides: {
    rolesByHuman?: Record<string, string[]>;
    pending?: CommunityModeratorApplicationRecord | null;
    blockedTexts?: string[];
  } = {},
) {
  const create = vi.fn(async (input: Record<string, unknown>) =>
    makeApplication({
      applicantHumanId: input.applicantHumanId as string,
      statement: (input.statement as string | null) ?? null,
    }),
  );
  const findPendingByApplicant = vi.fn(async () => overrides.pending ?? null);
  const audit = { log: vi.fn() };

  const txRepos = {
    communityModeratorApplications: { create, findPendingByApplicant },
    audit,
  };

  const deps: ApplyToBeModeratorDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as ApplyToBeModeratorDeps["repos"],
    authz: makeStaffAuthz(
      overrides.rolesByHuman ?? { [MODERATOR_ID]: ["COMMUNITY_MODERATOR"] },
    ),
    clock: makeClock(),
    contentFilter: makeContentFilter(overrides.blockedTexts),
  };

  return { deps, create, audit };
}

describe("applyToBeModerator", () => {
  it("creates a PENDING application and audits it", async () => {
    const { deps, create, audit } = buildApplyDeps();

    const result = await applyToBeModerator(deps, {
      actorHumanId: USER_ID,
      statement: "I want to help",
    });

    expect(result.application.status).toBe("PENDING");
    expect(create).toHaveBeenCalledWith({
      applicantHumanId: USER_ID,
      statement: "I want to help",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "community_moderator_application",
        action: "moderator_application.created",
        at: NOW,
      }),
    );
  });

  it("rejects when an application is already PENDING", async () => {
    const { deps, create } = buildApplyDeps({ pending: makeApplication() });

    await expect(
      applyToBeModerator(deps, { actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "MODERATOR_APPLICATION_ALREADY_PENDING" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an existing moderator with CONFLICT (already_moderator)", async () => {
    const { deps, create } = buildApplyDeps();

    await expect(
      applyToBeModerator(deps, { actorHumanId: MODERATOR_ID }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "already_moderator" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  // "Already a moderator" is a fact about the role, not a grant: a moderator
  // with no second factor enrolled must not be able to apply a second time.
  it("asks for the role without the second-factor rule", async () => {
    const { deps } = buildApplyDeps();

    await expect(
      applyToBeModerator(deps, { actorHumanId: MODERATOR_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deps.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: MODERATOR_ID,
      requiredRoles: ["COMMUNITY_MODERATOR"],
      allowWithoutSecondFactor: true,
    });
  });

  it("content-filters the statement", async () => {
    const { deps, create } = buildApplyDeps({ blockedTexts: ["slurword"] });

    await expect(
      applyToBeModerator(deps, {
        actorHumanId: USER_ID,
        statement: "totally slurword",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(create).not.toHaveBeenCalled();
  });
});

// ─── reviewModeratorApplication ──────────────────────────────────────────────

function buildReviewDeps(
  overrides: {
    application?: CommunityModeratorApplicationRecord | null;
    claimSucceeds?: boolean;
    applicantExists?: boolean;
    grantResult?: { granted: boolean };
    rolesByHuman?: Record<string, string[]>;
  } = {},
) {
  const application =
    overrides.application !== undefined
      ? overrides.application
      : makeApplication();
  const claimSucceeds = overrides.claimSucceeds ?? true;

  const getById = vi.fn(async () => application);
  const claimPendingForReview = vi.fn(async () =>
    claimSucceeds && application
      ? { ...application, reviewedByHumanId: ADMIN_ID, reviewedAt: NOW }
      : null,
  );
  const markReviewed = vi.fn(
    async (input: Record<string, unknown>) =>
      ({
        ...application!,
        status: input.status,
        reviewedByHumanId: input.reviewedByHumanId,
        reviewedAt: input.reviewedAt,
        reviewNote: (input.reviewNote as string | null) ?? null,
      }) as CommunityModeratorApplicationRecord,
  );
  const grantHumanRole = vi.fn(
    async () => overrides.grantResult ?? { granted: true },
  );
  const humansGetById = vi.fn(async () =>
    (overrides.applicantExists ?? true) ? { id: USER_ID, status: "ACTIVE" } : null,
  );
  const audit = { log: vi.fn() };

  const txRepos = {
    communityModeratorApplications: {
      getById,
      claimPendingForReview,
      markReviewed,
    },
    humans: { getById: humansGetById },
    authz: { grantHumanRole },
    audit,
  };

  const deps: ReviewModeratorApplicationDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as ReviewModeratorApplicationDeps["repos"],
    authz: makeStaffAuthz(
      overrides.rolesByHuman ?? {
        [ADMIN_ID]: ["ADMIN"],
        [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      },
    ),
    clock: makeClock(),
  };

  return {
    deps,
    mocks: { claimPendingForReview, markReviewed, grantHumanRole, audit, humansGetById },
  };
}

const REVIEW_INPUT = {
  actorHumanId: ADMIN_ID,
  applicationId: APPLICATION_ID,
  decision: "APPROVE" as const,
};

describe("reviewModeratorApplication", () => {
  it("APPROVE grants COMMUNITY_MODERATOR and audits decision + granted", async () => {
    const { deps, mocks } = buildReviewDeps();

    const result = await reviewModeratorApplication(deps, REVIEW_INPUT);

    expect(result.application.status).toBe("APPROVED");
    expect(mocks.grantHumanRole).toHaveBeenCalledWith({
      humanId: USER_ID,
      role: "COMMUNITY_MODERATOR",
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "community_moderator_application",
        action: "moderator_application.reviewed",
        data: expect.objectContaining({
          decision: "APPROVE",
          granted: true,
          applicantHumanId: USER_ID,
        }),
        at: NOW,
      }),
    );
  });

  it("verifies the applicant human exists BEFORE granting (ambiguous granted:false)", async () => {
    const { deps, mocks } = buildReviewDeps({ applicantExists: false });

    await expect(
      reviewModeratorApplication(deps, REVIEW_INPUT),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
    expect(mocks.grantHumanRole).not.toHaveBeenCalled();
    expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
  });

  it("treats granted:false after existence check as idempotent already-held", async () => {
    const { deps, mocks } = buildReviewDeps({
      grantResult: { granted: false },
    });

    const result = await reviewModeratorApplication(deps, REVIEW_INPUT);

    expect(result.application.status).toBe("APPROVED");
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ granted: false }),
      }),
    );
  });

  it("REJECT succeeds for a dangling applicant (deleted human) — the row must not stay PENDING forever", async () => {
    const { deps, mocks } = buildReviewDeps({ applicantExists: false });

    const result = await reviewModeratorApplication(deps, {
      ...REVIEW_INPUT,
      decision: "REJECT",
      reviewNote: "applicant account no longer exists",
    });

    expect(result.application.status).toBe("REJECTED");
    expect(mocks.grantHumanRole).not.toHaveBeenCalled();
    // The existence guard is APPROVE-only, so REJECT never even reads humans.
    expect(mocks.humansGetById).not.toHaveBeenCalled();
  });

  it("REJECT never grants the role", async () => {
    const { deps, mocks } = buildReviewDeps();

    const result = await reviewModeratorApplication(deps, {
      ...REVIEW_INPUT,
      decision: "REJECT",
      reviewNote: "not enough context",
    });

    expect(result.application.status).toBe("REJECTED");
    expect(mocks.grantHumanRole).not.toHaveBeenCalled();
  });

  it("requires platform ADMIN (a moderator cannot review applications)", async () => {
    const { deps, mocks } = buildReviewDeps();

    await expect(
      reviewModeratorApplication(deps, {
        ...REVIEW_INPUT,
        actorHumanId: MODERATOR_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
  });

  it("already-reviewed applications report MODERATOR_APPLICATION_ALREADY_REVIEWED", async () => {
    const { deps } = buildReviewDeps({
      application: makeApplication({ status: "APPROVED" }),
    });

    await expect(
      reviewModeratorApplication(deps, REVIEW_INPUT),
    ).rejects.toMatchObject({ code: "MODERATOR_APPLICATION_ALREADY_REVIEWED" });
  });

  it("missing application reports MODERATOR_APPLICATION_NOT_FOUND", async () => {
    const { deps } = buildReviewDeps({ application: null });

    await expect(
      reviewModeratorApplication(deps, REVIEW_INPUT),
    ).rejects.toMatchObject({ code: "MODERATOR_APPLICATION_NOT_FOUND" });
  });

  it("losing the claim race reports ALREADY_REVIEWED without granting", async () => {
    const { deps, mocks } = buildReviewDeps({ claimSucceeds: false });

    await expect(
      reviewModeratorApplication(deps, REVIEW_INPUT),
    ).rejects.toMatchObject({ code: "MODERATOR_APPLICATION_ALREADY_REVIEWED" });
    expect(mocks.grantHumanRole).not.toHaveBeenCalled();
  });
});
