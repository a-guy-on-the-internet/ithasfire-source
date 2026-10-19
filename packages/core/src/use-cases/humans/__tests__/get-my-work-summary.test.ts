import { describe, expect, it, vi } from "vitest";

import { getMyWorkSummary } from "../get-my-work-summary";
import type { GetMyWorkSummaryDeps } from "../get-my-work-summary";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ENABLED_AT = new Date("2026-05-01T00:00:00.000Z");

type RepoOverrides = {
  human?: unknown;
  performerProfile?: unknown;
  memberships?: unknown;
  placeClaimCount?: number;
  editSuggestionCount?: number;
  /** Called with the full input so tests can assert owner unioning. */
  countForPerformer?: ReturnType<typeof vi.fn>;
  countForPerformerInbox?: ReturnType<typeof vi.fn>;
};

function enabledProfile(acceptsBookingRequests = false) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    ownerType: "human" as const,
    ownerId: ACTOR_ID,
    enabledAt: ENABLED_AT,
    disabledAt: null,
    acceptsBookingRequests,
    createdAt: ENABLED_AT,
    updatedAt: ENABLED_AT,
  };
}

function makeDeps(
  overrides: RepoOverrides = {},
  extra: Partial<Pick<GetMyWorkSummaryDeps, "logger" | "reportError">> = {},
): GetMyWorkSummaryDeps {
  const countForPerformer = overrides.countForPerformer ?? vi.fn(async () => 0);
  const countForPerformerInbox =
    overrides.countForPerformerInbox ?? vi.fn(async () => 0);

  return {
    repos: {
      humans: {
        getById: vi.fn(async () => overrides.human ?? null),
      },
      performerProfiles: {
        getByOwner: vi.fn(async () => overrides.performerProfile ?? null),
      },
      authz: {
        listOrgMembershipsByHumanId: vi.fn(
          async () => overrides.memberships ?? [],
        ),
      },
      placeVerificationRequests: {
        countByClaimant: vi.fn(async () => overrides.placeClaimCount ?? 0),
      },
      eventEditSuggestions: {
        countBySubmitter: vi.fn(async () => overrides.editSuggestionCount ?? 0),
      },
      bookingRequests: {
        countForPerformer,
        countForPerformerInbox,
      },
    } as unknown as GetMyWorkSummaryDeps["repos"],
    ...extra,
  };
}

describe("getMyWorkSummary", () => {
  it("returns an all-zero summary for a human with no work footprint", async () => {
    const deps = makeDeps({ human: { jobs: [] } });

    const result = await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

    expect(result).toEqual({
      performerEnabled: false,
      acceptsBookingRequests: false,
      hasWorkRoles: false,
      degraded: false,
      sentBookingRequestCount: 0,
      receivedBookingRequestCount: 0,
      pendingReceivedBookingRequestCount: 0,
      placeClaimCount: 0,
      editSuggestionCount: 0,
    });
  });

  it("aggregates the full footprint for a working human", async () => {
    // Sent = 4; received = 3 total of which 2 are still open (the badge).
    const countForPerformer = vi.fn(async () => 4);
    const countForPerformerInbox = vi.fn(
      async (input: { statuses?: string[] }) => (input.statuses ? 2 : 3),
    );

    const deps = makeDeps({
      human: { jobs: ["MUSICIAN", "SOUND_ENGINEER"] },
      performerProfile: enabledProfile(true),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "OWNER" }],
      placeClaimCount: 1,
      editSuggestionCount: 7,
      countForPerformer,
      countForPerformerInbox,
    });

    const result = await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

    expect(result).toEqual({
      performerEnabled: true,
      acceptsBookingRequests: true,
      hasWorkRoles: true,
      degraded: false,
      sentBookingRequestCount: 4,
      receivedBookingRequestCount: 3,
      pendingReceivedBookingRequestCount: 2,
      placeClaimCount: 1,
      editSuggestionCount: 7,
    });
  });

  it("scopes booking counts to the ACTOR, never their administered orgs", async () => {
    // This is the guard on the product rule that account settings must not
    // widen on org administration. The settings nav gates the personal "Your
    // work" scope on request history, so a unioned count would let an org-only
    // admin in through the back door. It would also make the pending badge
    // uncountable-down: the row's list is `owner={{ownerType:"human"}}`, so an
    // org request in the number could never be cleared from that page.
    const countForPerformer = vi.fn(async () => 0);
    const countForPerformerInbox = vi.fn(async () => 0);

    const deps = makeDeps({
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" }],
      countForPerformer,
      countForPerformerInbox,
    });

    await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

    const expectedOwners = [{ ownerType: "human", ownerId: ACTOR_ID }];
    expect(countForPerformer).toHaveBeenCalledWith({ owners: expectedOwners });
    expect(countForPerformerInbox).toHaveBeenCalledWith({
      owners: expectedOwners,
    });
    // The badge query is the same owner set, narrowed to awaiting-response.
    expect(countForPerformerInbox).toHaveBeenCalledWith({
      owners: expectedOwners,
      statuses: ["PENDING", "VIEWED"],
    });
    // ORG_ID must appear in no owner set at all.
    for (const call of [
      ...countForPerformer.mock.calls,
      ...countForPerformerInbox.mock.calls,
    ]) {
      expect(JSON.stringify(call)).not.toContain(ORG_ID);
    }
  });

  it("does not read org memberships at all", async () => {
    // The union was the only reason this use case touched `authz`. Dropping it
    // dropped the read; `authz` is no longer even in its deps type.
    const deps = makeDeps();

    await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

    expect(
      (deps.repos as unknown as { authz: { listOrgMembershipsByHumanId: unknown } })
        .authz.listOrgMembershipsByHumanId,
    ).not.toHaveBeenCalled();
  });

  it("does not treat a disabled performer profile as performer mode", async () => {
    const deps = makeDeps({
      performerProfile: {
        ...enabledProfile(true),
        disabledAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    const result = await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

    expect(result.performerEnabled).toBe(false);
    // The stored gate survives an off/on round-trip, so it is reported raw.
    expect(result.acceptsBookingRequests).toBe(true);
  });

  it("rejects an unknown input key (strict schema)", async () => {
    const deps = makeDeps();

    await expect(
      getMyWorkSummary(deps, {
        actorHumanId: ACTOR_ID,
        targetHumanId: ORG_ID,
      }),
    ).rejects.toThrow();
  });

  // ── Deliberate-swallow reporting (CLAUDE.md convention) ────────────────────
  describe("degraded sub-reads", () => {
    it("degrades a failed count to 0, reports it, and keeps the rest", async () => {
      // Without the reporter this would render as "you have no edit
      // suggestions" forever — exactly the silent-outage class the
      // ReporterPort convention exists to prevent.
      const boom = new Error("db down");
      const deps = makeDeps({
        human: { jobs: ["PROMOTER"] },
        placeClaimCount: 2,
      });
      deps.repos.eventEditSuggestions.countBySubmitter = vi.fn(async () => {
        throw boom;
      });
      const reportError = vi.fn();
      deps.reportError = reportError;

      const result = await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

      expect(result.editSuggestionCount).toBe(0);
      expect(result.placeClaimCount).toBe(2);
      expect(result.hasWorkRoles).toBe(true);
      // The whole point of the flag: the consumer must be able to tell this
      // substituted 0 apart from a real "you have no edit suggestions", because
      // the settings nav routes people away on a zero.
      expect(result.degraded).toBe(true);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(boom, {
        tags: { useCase: "getMyWorkSummary", part: "editSuggestions" },
        extra: { actorHumanId: ACTOR_ID },
      });
    });

    it("logs the swallow at error level (warn is not captured by Sentry)", async () => {
      const deps = makeDeps();
      deps.repos.placeVerificationRequests.countByClaimant = vi.fn(async () => {
        throw new Error("db down");
      });
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
        withTime: vi.fn(),
      };
      deps.logger = logger as unknown as GetMyWorkSummaryDeps["logger"];

      await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

      expect(logger.error).toHaveBeenCalledWith(
        "humans.get_my_work_summary.part_failed",
        expect.objectContaining({
          part: "placeClaims",
          actorHumanId: ACTOR_ID,
        }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("a throwing reporter never breaks the degraded result", async () => {
      const deps = makeDeps();
      deps.repos.bookingRequests.countForPerformer = vi.fn(async () => {
        throw new Error("db down");
      });
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      deps.reportError = reportError;

      await expect(
        getMyWorkSummary(deps, { actorHumanId: ACTOR_ID }),
      ).resolves.toMatchObject({ sentBookingRequestCount: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("still degrades when reportError is not wired at all", async () => {
      const deps = makeDeps();
      deps.repos.humans.getById = vi.fn(async () => {
        throw new Error("db down");
      });

      const result = await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

      expect(result.hasWorkRoles).toBe(false);
    });

    it("keeps the other counts when one booking read fails", async () => {
      // One unhappy repo must hide one row, not 500 the whole settings page.
      const countForPerformer = vi.fn(async () => 1);
      const deps = makeDeps({ countForPerformer });
      deps.repos.bookingRequests.countForPerformerInbox = vi.fn(async () => {
        throw new Error("db down");
      });
      const reportError = vi.fn();
      deps.reportError = reportError;

      const result = await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

      expect(result.degraded).toBe(true);
      expect(result.sentBookingRequestCount).toBe(1);
      expect(result.receivedBookingRequestCount).toBe(0);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: {
            useCase: "getMyWorkSummary",
            part: "receivedBookingRequests",
          },
        }),
      );
    });

    it("does not report on the clean path", async () => {
      const reportError = vi.fn();
      const deps = makeDeps({ human: { jobs: [] } }, { reportError });

      const result = await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

      expect(reportError).not.toHaveBeenCalled();
      // A clean read must NOT set the flag, or the consumer would fail open
      // forever and the flag would buy nothing.
      expect(result.degraded).toBe(false);
    });

    it("sets degraded from any part, including one with no exported count", async () => {
      // `performerProfile` has no count of its own — it feeds two booleans.
      // A failure there still has to be visible to the consumer.
      const deps = makeDeps();
      deps.repos.performerProfiles.getByOwner = vi.fn(async () => {
        throw new Error("db down");
      });

      const result = await getMyWorkSummary(deps, { actorHumanId: ACTOR_ID });

      expect(result.degraded).toBe(true);
      expect(result.performerEnabled).toBe(false);
    });
  });
});
