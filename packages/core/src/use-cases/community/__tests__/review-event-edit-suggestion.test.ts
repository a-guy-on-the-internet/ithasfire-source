import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  reviewEventEditSuggestion,
  type ReviewEventEditSuggestionDeps,
} from "../review-event-edit-suggestion";

// FR-018 boundary (booking holds): the line mechanics are pinned by the
// helper's own suite; here WHEN an approve calls it and how the result rides
// the output is pinned. The mock routes to the real helper unless a case
// overrides it, so every other case in this file is unaffected.
const { settleHeldDatesForEvent } = vi.hoisted(() => ({ settleHeldDatesForEvent: vi.fn() }));
vi.mock("../../booking-holds/settle-held-dates-for-published-event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../booking-holds/settle-held-dates-for-published-event")>();
  settleHeldDatesForEvent.mockImplementation(actual.settleHeldDatesForEvent);
  return {
    ...actual,
    settleHeldDatesForEvent: (...args: unknown[]) => settleHeldDatesForEvent(...args),
  };
});
import type { EventRecord } from "@th/ports/repos/events";
import type { EventEditSuggestionRecord } from "@th/ports/repos/event-edit-suggestions";
import type { ImageRecord } from "@th/ports/repos/images";
import type { OrgMembership } from "@th/ports/repos/authz";
import {
  ADMIN_ID,
  EVENT_ID,
  IMAGE_ID,
  MODERATOR_ID,
  NOW,
  ORG_ID,
  OWNER_ID,
  SUGGESTION_ID,
  USER_ID,
  makeBaseVersion,
  makeCommunityEvent,
  makeContentFilter,
  makeCtaBody,
  makeImage,
  makeOrgEvent,
  makePersonalEvent,
  makeStaffAuthz,
  makeSuggestion,
  makeXssCtaBody,
  makeClock,
} from "./helpers";

function buildDeps(
  overrides: {
    suggestion?: EventEditSuggestionRecord | null;
    event?: EventRecord | null;
    /** When false the claim is "lost" (returns null). */
    claimSucceeds?: boolean;
    membership?: OrgMembership | null;
    rolesByHuman?: Record<string, string[]>;
    image?: ImageRecord | null;
    currentContent?: unknown | null;
    eventImages?: ImageRecord[];
    blockedTexts?: string[];
  } = {},
) {
  const suggestion =
    overrides.suggestion !== undefined
      ? overrides.suggestion
      : makeSuggestion();
  const event =
    overrides.event !== undefined ? overrides.event : makeCommunityEvent();
  const claimSucceeds = overrides.claimSucceeds ?? true;

  const getById = vi.fn(async () => suggestion);
  const claimPendingForReview = vi.fn(async () =>
    claimSucceeds && suggestion
      ? { ...suggestion, reviewedByHumanId: MODERATOR_ID, reviewedAt: NOW }
      : null,
  );
  const markReviewed = vi.fn(
    async (input: Record<string, unknown>) =>
      ({
        ...suggestion!,
        status: input.status,
        reviewedByHumanId: input.reviewedByHumanId,
        reviewedAt: input.reviewedAt,
        reviewNote: (input.reviewNote as string | null) ?? null,
        appliedFields:
          (input.appliedFields as Record<string, unknown> | null) ?? null,
        conflictedFields: (input.conflictedFields as string[] | null) ?? null,
      }) as EventEditSuggestionRecord,
  );

  // Returns the row as the adapter would: the current event with the applied
  // fields folded in.
  const applyCommunityEdit = vi.fn(
    async (input: { fields?: Record<string, unknown> }) =>
      ({ ...event!, ...(input.fields ?? {}) }) as EventRecord,
  );
  // Ordered log of the row lock and the event read, to pin their order.
  const eventCalls: string[] = [];
  const eventsRepo = {
    getById: vi.fn(async (id: string) => {
      eventCalls.push(`events.getById:${id}`);
      return event;
    }),
    getContent: vi.fn(async () => overrides.currentContent ?? null),
    applyCommunityEdit,
    lockRows: vi.fn(async (args: { ids: string[]; mode: string }) => {
      eventCalls.push(`lockRows:${args.ids.join(",")}:${args.mode}`);
    }),
  };
  const calendarsRepo = { findById: vi.fn(async () => null) };

  const imagesRepo = {
    getById: vi.fn(async () =>
      overrides.image !== undefined ? overrides.image : makeImage(),
    ),
    listByEventId: vi.fn(async () => overrides.eventImages ?? []),
    attach: vi.fn(async () => undefined),
  };

  const authzRepo = {
    getHumanDelegation: vi.fn(async () => null),
    getOrgMembership: vi.fn(async () =>
      overrides.membership !== undefined ? overrides.membership : null,
    ),
  };

  const audit = { log: vi.fn() };

  const eventChangeNoticesCreate = vi.fn(async () => ({
    id: "notice-1",
    createdAt: NOW,
  }));

  const notificationsCreate = vi.fn(async () => ({
    id: "notif-1",
    createdAt: NOW,
  }));

  const txRepos = {
    eventEditSuggestions: { getById, claimPendingForReview, markReviewed },
    events: eventsRepo,
    images: imagesRepo,
    authz: authzRepo,
    audit,
    eventChangeNotices: { create: eventChangeNoticesCreate },
    calendars: calendarsRepo,
  };

  const deps: ReviewEventEditSuggestionDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
      notifications: { create: notificationsCreate },
    } as unknown as ReviewEventEditSuggestionDeps["repos"],
    authz: makeStaffAuthz(
      overrides.rolesByHuman ?? {
        [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
        [ADMIN_ID]: ["ADMIN"],
      },
    ),
    clock: makeClock(),
    contentFilter: makeContentFilter(overrides.blockedTexts),
  };

  return {
    deps,
    mocks: {
      getById,
      claimPendingForReview,
      markReviewed,
      applyCommunityEdit,
      imagesRepo,
      authzRepo,
      audit,
      notificationsCreate,
      eventChangeNoticesCreate,
      calendarsRepo,
      eventCalls,
    },
  };
}

const APPROVE_INPUT = {
  actorHumanId: MODERATOR_ID,
  suggestionId: SUGGESTION_ID,
  decision: "APPROVE" as const,
};

describe("reviewEventEditSuggestion", () => {
  it("APPROVE applies the diff in one tx and audits before/after per field", async () => {
    const event = makeCommunityEvent();
    const suggestion = makeSuggestion({
      fields: { title: "Weekly Open Mic & Jam", ageLimit: 18 },
      baseVersion: makeBaseVersion(event),
    });
    const { deps, mocks } = buildDeps({ suggestion, event });

    const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

    expect(mocks.applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: expect.objectContaining({
        title: "Weekly Open Mic & Jam",
        ageLimit: 18,
      }),
    });
    expect(result.appliedFields.sort()).toEqual(["ageLimit", "title"]);
    expect(result.conflictedFields).toEqual([]);
    expect(result.suggestion.status).toBe("APPROVED");

    // Version-history audit row: before/after + non-material marker.
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "event_edit.applied",
        data: expect.objectContaining({
          suggestionId: SUGGESTION_ID,
          actorHumanId: MODERATOR_ID,
          material: false,
          changes: expect.objectContaining({
            title: {
              before: "Weekly Open Mic",
              after: "Weekly Open Mic & Jam",
            },
          }),
        }),
        at: NOW,
      }),
    );
  });

  it("stamps material:true when the applied diff touches schedule/venue (FR-013)", async () => {
    const event = makeCommunityEvent();
    const suggestion = makeSuggestion({
      fields: {
        startsAt: "2026-08-08T20:00:00.000Z",
        endsAt: "2026-08-08T23:00:00.000Z",
      },
      baseVersion: makeBaseVersion(event),
    });
    const { deps, mocks } = buildDeps({ suggestion, event });

    await reviewEventEditSuggestion(deps, APPROVE_INPUT);

    const eventAudit = mocks.audit.log.mock.calls
      .map((call) => call[0] as { action: string; data: { material?: boolean } })
      .find((entry) => entry.action === "event_edit.applied");
    expect(eventAudit?.data.material).toBe(true);
  });

  it("re-reviewing an already reviewed suggestion is a no-op error (claim guard)", async () => {
    const { deps, mocks } = buildDeps({
      suggestion: makeSuggestion({ status: "APPROVED" }),
    });

    await expect(
      reviewEventEditSuggestion(deps, APPROVE_INPUT),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_ALREADY_REVIEWED" });
    expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    expect(mocks.markReviewed).not.toHaveBeenCalled();
  });

  it("losing the concurrent claim race reports ALREADY_REVIEWED without applying", async () => {
    const { deps, mocks } = buildDeps({ claimSucceeds: false });

    await expect(
      reviewEventEditSuggestion(deps, APPROVE_INPUT),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_ALREADY_REVIEWED" });
    expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("unknown suggestion → EDIT_SUGGESTION_NOT_FOUND", async () => {
    const { deps } = buildDeps({ suggestion: null });

    await expect(
      reviewEventEditSuggestion(deps, APPROVE_INPUT),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_NOT_FOUND" });
  });

  it("REJECT records the decision without touching the event", async () => {
    const { deps, mocks } = buildDeps();

    const result = await reviewEventEditSuggestion(deps, {
      ...APPROVE_INPUT,
      decision: "REJECT",
      reviewNote: "duplicate of another suggestion",
    });

    expect(result.suggestion.status).toBe("REJECTED");
    expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    expect(mocks.markReviewed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "REJECTED",
        reviewNote: "duplicate of another suggestion",
      }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_edit_suggestion",
        action: "event_edit_suggestion.reviewed",
        data: expect.objectContaining({ decision: "REJECT" }),
      }),
    );
  });

  describe("FR-009 conflicts", () => {
    it("skips + flags stale fields, applies non-conflicting ones", async () => {
      const event = makeCommunityEvent();
      // Suggestion drafted when title was different — title drifted since.
      const staleBase = makeBaseVersion(
        makeCommunityEvent({ title: "Old Title" }),
      );
      const suggestion = makeSuggestion({
        fields: { title: "New Title", ageLimit: 21 },
        baseVersion: staleBase,
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.conflictedFields).toEqual(["title"]);
      expect(result.appliedFields).toEqual(["ageLimit"]);
      expect(mocks.applyCommunityEdit).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        fields: { ageLimit: 21 },
      });
      expect(mocks.markReviewed).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "APPROVED",
          appliedFields: { ageLimit: 21 },
          conflictedFields: ["title"],
        }),
      );
    });

    it("all-conflicted APPROVE stays APPROVED with empty appliedFields and no event write", async () => {
      const event = makeCommunityEvent();
      const staleBase = makeBaseVersion(
        makeCommunityEvent({ title: "Old Title" }),
      );
      const suggestion = makeSuggestion({
        fields: { title: "New Title" },
        baseVersion: staleBase,
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.suggestion.status).toBe("APPROVED");
      expect(result.appliedFields).toEqual([]);
      expect(result.conflictedFields).toEqual(["title"]);
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
      // No version-history row when nothing changed.
      const eventAudit = mocks.audit.log.mock.calls
        .map((call) => call[0] as { action: string })
        .find((entry) => entry.action === "event_edit.applied");
      expect(eventAudit).toBeUndefined();
    });

    it("schedule group conflicts as a whole: one drifted bound conflicts BOTH proposed bounds (no split pair)", async () => {
      // Current event runs Jul 10 → Jul 12.
      const event = makeCommunityEvent({
        startsAt: new Date("2026-07-10T20:00:00.000Z"),
        endsAt: new Date("2026-07-12T23:00:00.000Z"),
      });
      // Suggestion drafted when the event ran Jul 1 → Jul 12 (endsAt matches
      // current, startsAt drifted since). Proposes Jul 2 → Jul 3 — a valid
      // pair against each other, so ensureProposedScheduleValid passes.
      const staleBase = makeBaseVersion(
        makeCommunityEvent({
          startsAt: new Date("2026-07-01T20:00:00.000Z"),
          endsAt: new Date("2026-07-12T23:00:00.000Z"),
        }),
      );
      const suggestion = makeSuggestion({
        fields: {
          startsAt: "2026-07-02T20:00:00.000Z",
          endsAt: "2026-07-03T23:00:00.000Z",
          title: "Kept Title",
        },
        baseVersion: { ...staleBase, title: makeCommunityEvent().title },
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      // Per-field filtering would apply the lone endsAt Jul 3 against the
      // current startsAt Jul 10 (event runs Jul 10 → Jul 3). The group must
      // conflict BOTH bounds instead.
      expect(result.conflictedFields.sort()).toEqual(["endsAt", "startsAt"]);
      expect(result.appliedFields).toEqual(["title"]);
      expect(mocks.applyCommunityEdit).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        fields: { title: "Kept Title" },
      });
      // Schedule invariant holds post-apply: neither bound was written, so
      // the applied diff carries no startsAt/endsAt at all.
      const appliedDiff = (
        mocks.applyCommunityEdit as unknown as {
          mock: { calls: Array<[{ fields: Record<string, unknown> }]> };
        }
      ).mock.calls[0]![0];
      expect(appliedDiff.fields.startsAt).toBeUndefined();
      expect(appliedDiff.fields.endsAt).toBeUndefined();
    });

    it("schedule group — mirror: a drifted endsAt conflicts a proposed pair whose lone startsAt would invert", async () => {
      // Current event runs Jul 1 → Jul 5 (owner shortened it from Jul 12).
      const event = makeCommunityEvent({
        startsAt: new Date("2026-07-01T20:00:00.000Z"),
        endsAt: new Date("2026-07-05T23:00:00.000Z"),
      });
      // Suggestion drafted against Jul 1 → Jul 12; proposes Jul 6 → Jul 8
      // (valid pair against each other; startsAt did NOT drift). Per-field
      // filtering would apply the lone startsAt Jul 6 against the current
      // endsAt Jul 5 → inverted schedule.
      const staleBase = makeBaseVersion(
        makeCommunityEvent({
          startsAt: new Date("2026-07-01T20:00:00.000Z"),
          endsAt: new Date("2026-07-12T23:00:00.000Z"),
        }),
      );
      const suggestion = makeSuggestion({
        fields: {
          startsAt: "2026-07-06T20:00:00.000Z",
          endsAt: "2026-07-08T23:00:00.000Z",
        },
        baseVersion: staleBase,
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.conflictedFields.sort()).toEqual(["endsAt", "startsAt"]);
      expect(result.appliedFields).toEqual([]);
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
      expect(result.suggestion.status).toBe("APPROVED");
    });

    it("geo group conflicts as a whole: any drifted geo field flags every proposed geo field", async () => {
      const event = makeCommunityEvent();
      const staleBase = makeBaseVersion(
        makeCommunityEvent({ postalCode: "78702" }),
      );
      const suggestion = makeSuggestion({
        fields: { addressText: "456 New St", title: "Kept Title" },
        baseVersion: { ...staleBase, title: event.title },
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.conflictedFields).toEqual(["addressText"]);
      expect(result.appliedFields).toEqual(["title"]);
      expect(mocks.applyCommunityEdit).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        fields: { title: "Kept Title" },
      });
    });
  });

  describe("FR-008 authz routing (before claim)", () => {
    it("COMMUNITY: non-moderator gets STAFF_ONLY and the claim is never burned", async () => {
      const { deps, mocks } = buildDeps();

      await expect(
        reviewEventEditSuggestion(deps, {
          ...APPROVE_INPUT,
          actorHumanId: USER_ID,
        }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });
      expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    });

    it("COMMUNITY: org membership grants nothing — an org EDITOR without the moderator role cannot review", async () => {
      // FR-008: COMMUNITY suggestions route to capability roles only. Being
      // an EDITOR of some org must never confer review rights on ownerless
      // rows — org membership isn't even consulted on the COMMUNITY branch.
      const { deps, mocks } = buildDeps({
        membership: { orgId: ORG_ID, humanId: USER_ID, role: "EDITOR" },
        rolesByHuman: { [USER_ID]: [] },
      });

      await expect(
        reviewEventEditSuggestion(deps, {
          ...APPROVE_INPUT,
          actorHumanId: USER_ID,
        }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });
      expect(mocks.authzRepo.getOrgMembership).not.toHaveBeenCalled();
      expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    });

    it("COMMUNITY: platform ADMIN may review", async () => {
      const { deps } = buildDeps();

      await expect(
        reviewEventEditSuggestion(deps, {
          ...APPROVE_INPUT,
          actorHumanId: ADMIN_ID,
        }),
      ).resolves.toBeTruthy();
    });

    it("ORG event: a COMMUNITY_MODERATOR who is NOT an org member cannot review", async () => {
      const { deps, mocks } = buildDeps({
        event: makeOrgEvent(),
        membership: null,
      });

      await expect(
        reviewEventEditSuggestion(deps, {
          ...APPROVE_INPUT,
          actorHumanId: MODERATOR_ID,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
    });

    it("ORG event: an org EDITOR may review", async () => {
      const { deps, mocks } = buildDeps({
        event: makeOrgEvent(),
        membership: { orgId: ORG_ID, humanId: USER_ID, role: "EDITOR" },
      });

      await expect(
        reviewEventEditSuggestion(deps, {
          ...APPROVE_INPUT,
          actorHumanId: USER_ID,
        }),
      ).resolves.toBeTruthy();
      expect(mocks.applyCommunityEdit).toHaveBeenCalled();
    });

    it("PERSONAL event: only the humanId owner may review", async () => {
      const { deps: ownerDeps } = buildDeps({ event: makePersonalEvent() });
      await expect(
        reviewEventEditSuggestion(ownerDeps, {
          ...APPROVE_INPUT,
          actorHumanId: OWNER_ID,
        }),
      ).resolves.toBeTruthy();

      const { deps: strangerDeps, mocks } = buildDeps({
        event: makePersonalEvent(),
      });
      await expect(
        reviewEventEditSuggestion(strangerDeps, {
          ...APPROVE_INPUT,
          actorHumanId: MODERATOR_ID,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
    });

    // A listing that is over (taken down, archived, completed) takes no
    // edits: APPROVE is refused before the claim, so the suggestion stays
    // PENDING; REJECT still closes it out.
    describe("listing that is over", () => {
      it.each([
        ["CANCELLED", "EVENT_ALREADY_CANCELLED"],
        ["ARCHIVED", "EVENT_ARCHIVED"],
        ["COMPLETED", "EVENT_ALREADY_COMPLETED"],
      ] as const)(
        "APPROVE on a %s listing is refused with %s, claim never burned",
        async (status, code) => {
          const { deps, mocks } = buildDeps({
            event: makeCommunityEvent({ status }),
          });

          await expect(
            reviewEventEditSuggestion(deps, APPROVE_INPUT),
          ).rejects.toMatchObject({ code });
          expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
          expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
          expect(mocks.markReviewed).not.toHaveBeenCalled();
        },
      );

      it("a non-moderator on a CANCELLED listing gets STAFF_ONLY, not EVENT_ALREADY_CANCELLED", async () => {
        const { deps, mocks } = buildDeps({
          event: makeCommunityEvent({ status: "CANCELLED" }),
        });

        await expect(
          reviewEventEditSuggestion(deps, {
            ...APPROVE_INPUT,
            actorHumanId: USER_ID,
          }),
        ).rejects.toMatchObject({ code: "STAFF_ONLY" });
        expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
      });

      it.each(["CANCELLED", "ARCHIVED", "COMPLETED"] as const)(
        "REJECT on a %s listing still closes the suggestion out",
        async (status) => {
          const { deps, mocks } = buildDeps({
            event: makeCommunityEvent({ status }),
          });

          await expect(
            reviewEventEditSuggestion(deps, {
              ...APPROVE_INPUT,
              decision: "REJECT",
            }),
          ).resolves.toBeTruthy();
          expect(mocks.claimPendingForReview).toHaveBeenCalled();
          expect(mocks.markReviewed).toHaveBeenCalledWith(
            expect.objectContaining({ status: "REJECTED" }),
          );
          expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
        },
      );
    });

    describe("self-approval guard (S3-d)", () => {
      it("COMMUNITY: a moderator cannot APPROVE their OWN suggestion (FORBIDDEN, claim never burned)", async () => {
        const { deps, mocks } = buildDeps({
          suggestion: makeSuggestion({ submitterHumanId: MODERATOR_ID }),
        });

        await expect(
          reviewEventEditSuggestion(deps, {
            ...APPROVE_INPUT,
            actorHumanId: MODERATOR_ID,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(mocks.claimPendingForReview).not.toHaveBeenCalled();
        expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
      });

      it("COMMUNITY: a moderator MAY REJECT their own suggestion (self-withdrawal is allowed)", async () => {
        const { deps, mocks } = buildDeps({
          suggestion: makeSuggestion({ submitterHumanId: MODERATOR_ID }),
        });

        await expect(
          reviewEventEditSuggestion(deps, {
            actorHumanId: MODERATOR_ID,
            suggestionId: SUGGESTION_ID,
            decision: "REJECT",
          }),
        ).resolves.toBeTruthy();
        expect(mocks.markReviewed).toHaveBeenCalledWith(
          expect.objectContaining({ status: "REJECTED" }),
        );
      });

      it("ORG event: self-approval is ALLOWED (policy is COMMUNITY-only; the reviewer already has direct edit rights)", async () => {
        const { deps, mocks } = buildDeps({
          event: makeOrgEvent(),
          suggestion: makeSuggestion({ submitterHumanId: USER_ID }),
          membership: { orgId: ORG_ID, humanId: USER_ID, role: "EDITOR" },
        });

        await expect(
          reviewEventEditSuggestion(deps, {
            ...APPROVE_INPUT,
            actorHumanId: USER_ID,
          }),
        ).resolves.toBeTruthy();
        expect(mocks.applyCommunityEdit).toHaveBeenCalled();
      });
    });
  });

  describe("re-validation at approve (never trust stored Json)", () => {
    it("rejects stored fields poisoned with a forbidden key — nothing applies", async () => {
      const suggestion = makeSuggestion({
        fields: { title: "ok", orgId: ORG_ID },
      });
      const { deps, mocks } = buildDeps({ suggestion });

      await expect(
        reviewEventEditSuggestion(deps, APPROVE_INPUT),
      ).rejects.toMatchObject({
        code: "EDIT_SUGGESTION_INVALID_FIELDS",
        // The whitelist parse failure keeps its own typed reason (it is NOT
        // remapped to stored_fields_revalidation_failed).
        meta: { reason: "unsupported_fields", fields: ["orgId"] },
      });
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
      expect(mocks.markReviewed).not.toHaveBeenCalled();
    });

    it("rejects a stored body carrying a javascript: cta href injected post-submit", async () => {
      const event = makeCommunityEvent();
      const suggestion = makeSuggestion({
        fields: { content: makeXssCtaBody() },
        baseVersion: makeBaseVersion(event),
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      await expect(
        reviewEventEditSuggestion(deps, APPROVE_INPUT),
      ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    });

    it("rejects a stored http(s) cta href tampered post-submit with attribute-breaking characters", async () => {
      const event = makeCommunityEvent();
      const suggestion = makeSuggestion({
        // Simulates a stored suggestion whose href was tampered after submit:
        // http(s) protocol passes the allowlist, but the raw quote would break
        // out of the renderer's <a href="..."> attribute.
        fields: {
          content: makeCtaBody('https://example.com/" onmouseover="alert(1)'),
        },
        baseVersion: makeBaseVersion(event),
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      await expect(
        reviewEventEditSuggestion(deps, APPROVE_INPUT),
      ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    });

    it("re-runs the content filter on stored text at approve", async () => {
      const suggestion = makeSuggestion({
        fields: { title: "now contains slurword" },
      });
      const { deps, mocks } = buildDeps({
        suggestion,
        blockedTexts: ["slurword"],
      });

      await expect(
        reviewEventEditSuggestion(deps, APPROVE_INPUT),
      ).rejects.toMatchObject({
        code: "EDIT_SUGGESTION_INVALID_FIELDS",
        meta: { reason: "blocked_content", fields: ["title"] },
      });
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    });

    // Mirror of the submit-path test. APPROVE is the path that actually WRITES
    // the address onto the live event, so the geographic exemption has to hold
    // here too — FR-006 requires submit-time and apply-time validation to
    // AGREE. Structurally they share ensureSuggestionTextAllowed, but if
    // someone later adds a "defence in depth" inline address check next to the
    // approve-time call, submit would keep accepting "1200 Dickerson Pike"
    // while every approve threw blocked_content — leaving the row permanently
    // unapprovable, with the rest of the suite green.
    it("does NOT content-filter addressText / region / locality at approve either", async () => {
      const event = makeCommunityEvent();
      const suggestion = makeSuggestion({
        fields: {
          addressText: "1200 Dickerson Pike, Nashville, TN",
          locality: "Penistone",
        },
        baseVersion: makeBaseVersion(event),
      });
      const { deps, mocks } = buildDeps({
        suggestion,
        event,
        // Casing matches the fixture: makeContentFilter is a case-sensitive
        // `includes`, so lowercase tokens would make the reject half inert.
        blockedTexts: ["Dickerson", "Penistone"],
      });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.suggestion.status).toBe("APPROVED");
      expect(result.conflictedFields).toEqual([]);
      expect(mocks.applyCommunityEdit).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        fields: expect.objectContaining({
          addressText: "1200 Dickerson Pike, Nashville, TN",
          locality: "Penistone",
        }),
      });

      // ...and the filter was never even asked about the address.
      for (const call of deps.contentFilter.hasBlockedContent.mock.calls) {
        expect(call[0]!.text).not.toContain("Dickerson");
        expect(call[0]!.text).not.toContain("Penistone");
      }
    });

    it("re-checks hero rules at approve (image detached from event since submit)", async () => {
      const suggestion = makeSuggestion({
        submitterHumanId: USER_ID,
        fields: { heroImageId: IMAGE_ID },
      });
      const { deps, mocks } = buildDeps({
        suggestion,
        image: makeImage({
          attached: false,
          createdByHumanId: "12121212-1212-4121-8121-121212121212",
        }),
      });

      await expect(
        reviewEventEditSuggestion(deps, APPROVE_INPUT),
      ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
      expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    });
  });

  it("attaches a suggestion-borne unattached hero image in the same tx on APPROVE", async () => {
    const event = makeCommunityEvent();
    const suggestion = makeSuggestion({
      submitterHumanId: USER_ID,
      fields: { heroImageId: IMAGE_ID },
      baseVersion: makeBaseVersion(event),
    });
    const image = makeImage({ attached: false, createdByHumanId: USER_ID });
    const { deps, mocks } = buildDeps({ suggestion, event, image });

    const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

    expect(result.appliedFields).toEqual(["heroImageId"]);
    expect(mocks.applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { heroImageId: IMAGE_ID },
    });
    expect(mocks.imagesRepo.attach).toHaveBeenCalledWith({
      ownerId: EVENT_ID,
      imageIds: [IMAGE_ID],
      attachedAt: NOW,
    });
  });

  describe("change-notice outbox (Unit 4, FR-013)", () => {
    it("APPROVE of a material schedule change writes a RESCHEDULED notice from the applied bounds", async () => {
      const event = makeCommunityEvent();
      const suggestion = makeSuggestion({
        fields: {
          startsAt: "2026-08-08T20:00:00.000Z",
          endsAt: "2026-08-08T23:00:00.000Z",
        },
        baseVersion: makeBaseVersion(event),
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.appliedFields.sort()).toEqual(["endsAt", "startsAt"]);
      expect(mocks.eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
      expect(mocks.eventChangeNoticesCreate).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        changeType: "RESCHEDULED",
        payload: {
          eventTitle: "Weekly Open Mic",
          newStartsAt: "2026-08-08T20:00:00.000Z",
          newEndsAt: "2026-08-08T23:00:00.000Z",
        },
      });
    });

    it("APPROVE of a material geo-only change writes a VENUE_CHANGED notice with the event's current schedule", async () => {
      const event = makeCommunityEvent();
      const suggestion = makeSuggestion({
        fields: { addressText: "456 New St, Austin, TX" },
        baseVersion: makeBaseVersion(event),
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.appliedFields).toEqual(["addressText"]);
      expect(mocks.eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
      expect(mocks.eventChangeNoticesCreate).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        changeType: "VENUE_CHANGED",
        payload: {
          eventTitle: "Weekly Open Mic",
          // Falls back to the event's current (unchanged) schedule.
          newStartsAt: "2026-08-01T20:00:00.000Z",
          newEndsAt: "2026-08-01T23:00:00.000Z",
        },
      });
    });

    it("APPROVE that moves BOTH schedule and venue writes TWO notices (RESCHEDULED + VENUE_CHANGED)", async () => {
      const event = makeCommunityEvent();
      const suggestion = makeSuggestion({
        fields: {
          startsAt: "2026-08-08T20:00:00.000Z",
          endsAt: "2026-08-08T23:00:00.000Z",
          addressText: "456 New St, Austin, TX",
        },
        baseVersion: makeBaseVersion(event),
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.appliedFields.sort()).toEqual([
        "addressText",
        "endsAt",
        "startsAt",
      ]);
      // Both semantic changes are communicated — one notice per group.
      expect(mocks.eventChangeNoticesCreate).toHaveBeenCalledTimes(2);
      expect(mocks.eventChangeNoticesCreate).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        changeType: "RESCHEDULED",
        payload: {
          eventTitle: "Weekly Open Mic",
          newStartsAt: "2026-08-08T20:00:00.000Z",
          newEndsAt: "2026-08-08T23:00:00.000Z",
        },
      });
      expect(mocks.eventChangeNoticesCreate).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        changeType: "VENUE_CHANGED",
        payload: {
          eventTitle: "Weekly Open Mic",
          newStartsAt: "2026-08-08T20:00:00.000Z",
          newEndsAt: "2026-08-08T23:00:00.000Z",
        },
      });
    });

    it("APPROVE of a NON-material change (title) writes NO notice", async () => {
      const event = makeCommunityEvent();
      const suggestion = makeSuggestion({
        fields: { title: "Weekly Open Mic & Jam" },
        baseVersion: makeBaseVersion(event),
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(mocks.eventChangeNoticesCreate).not.toHaveBeenCalled();
    });

    it("REJECT writes no notice", async () => {
      const { deps, mocks } = buildDeps();

      await reviewEventEditSuggestion(deps, {
        ...APPROVE_INPUT,
        decision: "REJECT",
      });

      expect(mocks.eventChangeNoticesCreate).not.toHaveBeenCalled();
    });

    it("an all-conflicted material APPROVE applies nothing and writes no notice", async () => {
      const event = makeCommunityEvent();
      // startsAt drifted since the suggestion was drafted → schedule group
      // conflicts as a whole, nothing applies, so no material change occurs.
      const staleBase = makeBaseVersion(
        makeCommunityEvent({
          startsAt: new Date("2026-07-20T20:00:00.000Z"),
        }),
      );
      const suggestion = makeSuggestion({
        fields: {
          startsAt: "2026-08-09T20:00:00.000Z",
          endsAt: "2026-08-09T23:00:00.000Z",
        },
        baseVersion: staleBase,
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.appliedFields).toEqual([]);
      expect(mocks.eventChangeNoticesCreate).not.toHaveBeenCalled();
    });
  });

  describe("submitter notification (Requirement B)", () => {
    it("APPROVE notifies an authed submitter with a SUCCESS notification", async () => {
      const event = makeCommunityEvent();
      const suggestion = makeSuggestion({
        submitterHumanId: USER_ID,
        fields: { title: "Weekly Open Mic & Jam" },
        baseVersion: makeBaseVersion(event),
      });
      const { deps, mocks } = buildDeps({ suggestion, event });

      await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(mocks.notificationsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: USER_ID,
          kind: "SUCCESS",
          tags: ["suggestion"],
          metadata: expect.objectContaining({
            eventId: EVENT_ID,
            suggestionId: SUGGESTION_ID,
            decision: "APPROVE",
          }),
          // Slug path — `/events/<uuid>` 404s on the public page.
          action: {
            label: "View event",
            route:
              "/events/event/us/austin/weekly-open-mic-2026-08-01-2000--abc123",
          },
        }),
      );
    });

    it("REJECT notifies an authed submitter with an INFO notification carrying the reviewer note", async () => {
      const suggestion = makeSuggestion({ submitterHumanId: USER_ID });
      const { deps, mocks } = buildDeps({ suggestion });

      await reviewEventEditSuggestion(deps, {
        ...APPROVE_INPUT,
        decision: "REJECT",
        reviewNote: "duplicate of another suggestion",
      });

      expect(mocks.notificationsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: USER_ID,
          kind: "INFO",
          metadata: expect.objectContaining({ decision: "REJECT" }),
        }),
      );
      const body = (
        mocks.notificationsCreate.mock.calls[0]![0] as { body: string }
      ).body;
      expect(body).toContain("duplicate of another suggestion");
    });

    it("does NOT notify an anonymous submitter (submitterHumanId null)", async () => {
      // Default makeSuggestion has submitterHumanId: null.
      const { deps, mocks } = buildDeps();

      await reviewEventEditSuggestion(deps, {
        ...APPROVE_INPUT,
        decision: "REJECT",
      });

      expect(mocks.notificationsCreate).not.toHaveBeenCalled();
    });

    it("a notification failure never fails the review (best-effort)", async () => {
      const suggestion = makeSuggestion({ submitterHumanId: USER_ID });
      const { deps, mocks } = buildDeps({ suggestion });
      mocks.notificationsCreate.mockRejectedValueOnce(new Error("notif down"));

      const result = await reviewEventEditSuggestion(deps, {
        ...APPROVE_INPUT,
        decision: "REJECT",
      });

      expect(result.suggestion.status).toBe("REJECTED");
    });
  });

  describe("held dates (booking-holds FR-018)", () => {
    const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const HOLD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const OWED = {
      confirmed: [],
      released: [{ id: HOLD_ID }],
      intents: [
        { kind: "hold.released", bookingRequestId: REQUEST_ID, holdId: HOLD_ID, audience: "act", date: "2026-08-08", reason: "EVENT_SCHEDULED" },
      ],
      staffRecipientHint: { assigneeHumanId: null, placedByHumanId: MODERATOR_ID, orgId: ORG_ID, placeId: "33333333-3333-4333-8333-333333333333" },
    };
    const dateMove = (event: EventRecord) =>
      makeSuggestion({
        fields: { startsAt: "2026-08-08T20:00:00.000Z", endsAt: "2026-08-08T23:00:00.000Z" },
        baseVersion: makeBaseVersion(event),
      });

    beforeEach(() => {
      settleHeldDatesForEvent.mockClear();
    });

    it("a date-moving APPROVE on a PUBLISHED listing with a calendar calls the settle inside the tx — with the applied row, the moderator, and the community owner — and the intents ride the output", async () => {
      const event = makeCommunityEvent({ calendarId: CALENDAR_ID } as Partial<EventRecord>);
      const { deps, mocks } = buildDeps({ suggestion: dateMove(event), event });
      settleHeldDatesForEvent.mockResolvedValueOnce(OWED);

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.appliedFields.sort()).toEqual(["endsAt", "startsAt"]);
      expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
      const [tx, args] = settleHeldDatesForEvent.mock.calls[0]!;
      expect(tx).toMatchObject({ events: expect.anything(), audit: expect.anything() });
      expect(args).toMatchObject({
        event: expect.objectContaining({ id: EVENT_ID, calendarId: CALENDAR_ID, startsAt: new Date("2026-08-08T20:00:00.000Z") }),
        now: NOW,
        actorHumanId: MODERATOR_ID,
        owner: { kind: "community" },
      });
      // Applied first, then taken: the settle sees the row the tx will commit.
      expect(mocks.applyCommunityEdit.mock.invocationCallOrder[0]!).toBeLessThan(
        settleHeldDatesForEvent.mock.invocationCallOrder[0]!,
      );
      expect(result.notificationIntents).toEqual(OWED.intents);
      expect(result.staffRecipientHint).toEqual(OWED.staffRecipientHint);
    });

    it("without a calendar the settle touches nothing: not a single holds read, and the output carries no intents key", async () => {
      const event = makeCommunityEvent();
      const { deps, mocks } = buildDeps({ suggestion: dateMove(event), event });

      const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

      expect(result.appliedFields.sort()).toEqual(["endsAt", "startsAt"]);
      expect(mocks.calendarsRepo.findById).not.toHaveBeenCalled();
      expect("notificationIntents" in result).toBe(false);
      expect("staffRecipientHint" in result).toBe(false);
    });

    it("a title-only APPROVE never reaches the settle; neither does a date move on a DRAFT (pencil-in)", async () => {
      const published = makeCommunityEvent({ calendarId: CALENDAR_ID } as Partial<EventRecord>);
      const titleOnly = buildDeps({
        suggestion: makeSuggestion({ fields: { title: "Renamed" }, baseVersion: makeBaseVersion(published) }),
        event: published,
      });
      await reviewEventEditSuggestion(titleOnly.deps, APPROVE_INPUT);
      expect(settleHeldDatesForEvent).not.toHaveBeenCalled();

      const draft = makeOrgEvent({ status: "DRAFT", publishedAt: null, calendarId: CALENDAR_ID } as Partial<EventRecord>);
      const draftDeps = buildDeps({
        suggestion: dateMove(draft),
        event: draft,
        membership: { orgId: ORG_ID, humanId: OWNER_ID, role: "ADMIN" },
      });
      await reviewEventEditSuggestion(draftDeps.deps, { ...APPROVE_INPUT, actorHumanId: OWNER_ID });
      expect(settleHeldDatesForEvent).not.toHaveBeenCalled();
    });

    it("an org-owned event names its org as the owner the settle re-checks", async () => {
      const event = makeOrgEvent({ calendarId: CALENDAR_ID } as Partial<EventRecord>);
      const { deps } = buildDeps({
        suggestion: dateMove(event),
        event,
        membership: { orgId: ORG_ID, humanId: OWNER_ID, role: "ADMIN" },
      });
      settleHeldDatesForEvent.mockResolvedValueOnce(OWED);

      await reviewEventEditSuggestion(deps, { ...APPROVE_INPUT, actorHumanId: OWNER_ID });

      expect(settleHeldDatesForEvent.mock.calls[0]![1]).toMatchObject({
        actorHumanId: OWNER_ID,
        owner: { kind: "org", orgId: ORG_ID },
      });
    });

    it("the settle refusing (open challenge on the new line) propagates: the approve rolls back, the suggestion is not marked APPROVED", async () => {
      const event = makeCommunityEvent({ calendarId: CALENDAR_ID } as Partial<EventRecord>);
      const { deps, mocks } = buildDeps({ suggestion: dateMove(event), event });
      settleHeldDatesForEvent.mockRejectedValueOnce({ code: "HOLD_LINE_HAS_OPEN_CHALLENGE", meta: {} });

      await expect(reviewEventEditSuggestion(deps, APPROVE_INPUT)).rejects.toMatchObject({ code: "HOLD_LINE_HAS_OPEN_CHALLENGE" });
      expect(mocks.markReviewed).not.toHaveBeenCalled();
      expect(mocks.notificationsCreate).not.toHaveBeenCalled();
    });
  });
});

describe("reviewEventEditSuggestion on an event linked to a place", () => {
  const LINKED_PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("REFUSES approving an address suggestion on a linked listing and writes nothing", async () => {
    const event = makeCommunityEvent({ placeId: LINKED_PLACE_ID });
    const suggestion = makeSuggestion({
      fields: { addressText: "88 Elsewhere Ave, Austin, TX", lat: 30.3, lng: -97.7 },
      baseVersion: makeBaseVersion(event),
    });
    const { deps, mocks } = buildDeps({ suggestion, event });

    await expect(
      reviewEventEditSuggestion(deps, APPROVE_INPUT),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: {
        reason: "unsupported_fields",
        fields: ["addressText", "lat", "lng"],
      },
    });
    expect(mocks.applyCommunityEdit).not.toHaveBeenCalled();
    expect(mocks.markReviewed).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
    expect(mocks.eventChangeNoticesCreate).not.toHaveBeenCalled();
  });

  it("applies the same address suggestion on an UNLINKED listing", async () => {
    const event = makeCommunityEvent({ placeId: null });
    const suggestion = makeSuggestion({
      fields: { addressText: "88 Elsewhere Ave, Austin, TX", lat: 30.3, lng: -97.7 },
      baseVersion: makeBaseVersion(event),
    });
    const { deps, mocks } = buildDeps({ suggestion, event });

    const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

    expect(mocks.applyCommunityEdit).toHaveBeenCalledTimes(1);
    expect(result.appliedFields.sort()).toEqual(["addressText", "lat", "lng"]);
  });

  it("still applies a title-only suggestion on a linked listing", async () => {
    const event = makeCommunityEvent({ placeId: LINKED_PLACE_ID });
    const suggestion = makeSuggestion({
      fields: { title: "Weekly Open Mic & Jam" },
      baseVersion: makeBaseVersion(event),
    });
    const { deps, mocks } = buildDeps({ suggestion, event });

    const result = await reviewEventEditSuggestion(deps, APPROVE_INPUT);

    expect(mocks.applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { title: "Weekly Open Mic & Jam" },
    });
    expect(result.appliedFields).toEqual(["title"]);
  });
});

describe("reviewEventEditSuggestion row lock", () => {
  it("locks the event row FOR UPDATE before reading it", async () => {
    const event = makeCommunityEvent();
    const suggestion = makeSuggestion({
      fields: { title: "Weekly Open Mic & Jam" },
      baseVersion: makeBaseVersion(event),
    });
    const { deps, mocks } = buildDeps({ suggestion, event });

    await reviewEventEditSuggestion(deps, APPROVE_INPUT);

    expect(mocks.eventCalls.slice(0, 2)).toEqual([
      `lockRows:${EVENT_ID}:update`,
      `events.getById:${EVENT_ID}`,
    ]);
  });
});
