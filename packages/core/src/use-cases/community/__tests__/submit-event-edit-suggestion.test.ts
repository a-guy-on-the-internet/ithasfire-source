import { describe, expect, it, vi } from "vitest";

import {
  MAX_PENDING_PER_IP_24H,
  submitEventEditSuggestion,
  type SubmitEventEditSuggestionDeps,
} from "../submit-event-edit-suggestion";
import type { EventRecord } from "@th/ports/repos/events";
import type { ImageRecord } from "@th/ports/repos/images";
import type { OrgRole } from "@th/ports/repos/authz";
import {
  EVENT_ID,
  IMAGE_ID,
  MODERATOR_ID,
  NOW,
  USER_ID,
  makeClock,
  makeCommunityEvent,
  makeContentFilter,
  makeCtaBody,
  makeImage,
  makeOrgEvent,
  makePersonalEvent,
  makeSuggestion,
  makeValidBody,
  makeXssCtaBody,
} from "./helpers";
import { createNetworkIdentityHasher } from "../../../lib/security/network-identity";

const IP_HASH_SECRET = "k".repeat(48);
const IP_HASH = createNetworkIdentityHasher(IP_HASH_SECRET).hashSuggestionIp(
  "203.0.113.7",
);

function buildDeps(
  overrides: {
    event?: EventRecord | null;
    pendingByIp?: number;
    image?: ImageRecord | null;
    blockedTexts?: string[];
    content?: unknown | null;
    eventImages?: ImageRecord[];
    /** Community moderators returned by the forward staff-role lookup. */
    moderatorIds?: string[];
    /** Platform ADMINs returned by the forward staff-role lookup (fallback). */
    adminIds?: string[];
    /** Org members (default role EDITOR) returned by listMembers. */
    orgMemberIds?: string[];
    /** Org members with explicit roles (overrides orgMemberIds). */
    orgMembers?: { humanId: string; role: OrgRole }[];
  } = {},
) {
  const event =
    overrides.event !== undefined ? overrides.event : makeCommunityEvent();

  const eventsRepo = {
    getById: vi.fn(async () => event),
    getContent: vi.fn(async () => overrides.content ?? null),
    applyCommunityEdit: vi.fn(),
  };

  const imagesRepo = {
    getById: vi.fn(async () =>
      overrides.image !== undefined ? overrides.image : makeImage(),
    ),
    listByEventId: vi.fn(async () => overrides.eventImages ?? []),
  };

  const createMock = vi.fn(
    async (input: Record<string, unknown>) =>
      makeSuggestion({
        eventId: input.eventId as string,
        submitterHumanId: (input.submitterHumanId as string | null) ?? null,
        submitterIpHash: (input.submitterIpHash as string | null) ?? null,
        fields: input.fields as Record<string, unknown>,
        baseVersion: input.baseVersion as Record<string, unknown>,
        note: (input.note as string | null) ?? null,
      }),
  );
  const countPendingByIp = vi.fn(async () => overrides.pendingByIp ?? 0);
  const audit = { log: vi.fn() };

  const notificationsCreate = vi.fn(async () => ({
    id: "notif-1",
    createdAt: NOW,
  }));
  const listHumanIdsByStaffRole = vi.fn(async (role: string) => {
    if (role === "COMMUNITY_MODERATOR") return overrides.moderatorIds ?? [];
    if (role === "ADMIN") return overrides.adminIds ?? [];
    return [];
  });
  const orgMembers =
    overrides.orgMembers ??
    (overrides.orgMemberIds ?? []).map((humanId) => ({
      humanId,
      role: "EDITOR" as OrgRole,
    }));
  const listMembers = vi.fn(async () => ({
    items: orgMembers.map((member) => ({
      humanId: member.humanId,
      name: null,
      email: null,
      role: member.role,
      joinedAt: NOW,
    })),
    total: orgMembers.length,
  }));

  const txRepos = {
    eventEditSuggestions: { create: createMock, countPendingByIp },
    audit,
  };

  const deps: SubmitEventEditSuggestionDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
      events: eventsRepo,
      images: imagesRepo,
      eventEditSuggestions: { countPendingByIp, create: createMock },
      notifications: { create: notificationsCreate },
      organizations: { listMembers },
      authz: { listHumanIdsByStaffRole },
    } as unknown as SubmitEventEditSuggestionDeps["repos"],
    clock: makeClock(),
    contentFilter: makeContentFilter(overrides.blockedTexts),
    identitySecret: IP_HASH_SECRET,
    reportError: vi.fn(),
  };

  return {
    deps,
    createMock,
    countPendingByIp,
    audit,
    eventsRepo,
    imagesRepo,
    notificationsCreate,
    listHumanIdsByStaffRole,
    listMembers,
  };
}

describe("submitEventEditSuggestion", () => {
  it("anonymous submission lands PENDING and NEVER mutates the event", async () => {
    const { deps, createMock, audit, eventsRepo } = buildDeps();

    const result = await submitEventEditSuggestion(deps, {
      eventId: EVENT_ID,
      fields: { title: "Better title" },
      note: "The venue renamed the night",
    });

    expect(result.suggestion.status).toBe("PENDING");
    expect(result.suggestion.submitterHumanId).toBeNull();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        submitterHumanId: null,
        fields: { title: "Better title" },
      }),
    );
    // Base snapshot captured for FR-009.
    const baseVersion = createMock.mock.calls[0]![0]
      .baseVersion as Record<string, unknown>;
    expect(baseVersion.title).toBe("Weekly Open Mic");
    expect(typeof baseVersion.startsAt).toBe("string");

    // No event mutation on submit — ever.
    expect(eventsRepo.applyCommunityEdit).not.toHaveBeenCalled();

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_edit_suggestion",
        action: "event_edit_suggestion.created",
        data: expect.objectContaining({ anonymous: true }),
        at: NOW,
      }),
    );
  });

  it("rejects a non-whitelisted field with reason unsupported_fields + the smuggled keys", async () => {
    const { deps, createMock } = buildDeps();

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "x", admissionTaxRateBps: 0 },
      }),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: {
        reason: "unsupported_fields",
        fields: ["admissionTaxRateBps"],
      },
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  // Suggestions are COMMUNITY-only (product decision 2026-07-20, reversing
  // FR-006's universal scope): OWNED events collapse to EVENT_NOT_FOUND
  // exactly like drafts/private events — no stewardship probing.
  it("rejects an OWNED (org) PUBLISHED PUBLIC event with EVENT_NOT_FOUND — suggestions are COMMUNITY-only", async () => {
    const { deps, createMock, notificationsCreate } = buildDeps({
      event: makeOrgEvent(),
    });

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        submitterHumanId: USER_ID,
        fields: { ageLimit: 18 },
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(createMock).not.toHaveBeenCalled();
    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it("rejects an OWNED PERSONAL (human-owned) PUBLISHED PUBLIC event with EVENT_NOT_FOUND", async () => {
    const { deps, createMock, eventsRepo } = buildDeps({
      event: makePersonalEvent(),
    });

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "Corrected house-show title" },
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(createMock).not.toHaveBeenCalled();
    expect(eventsRepo.applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("404s on a PRIVATE event (no existence leak)", async () => {
    const { deps } = buildDeps({
      event: makeCommunityEvent({ visibility: "PRIVATE" }),
    });

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "x" },
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("404s on a non-PUBLISHED event", async () => {
    const { deps } = buildDeps({
      event: makeOrgEvent({ status: "DRAFT" }),
    });

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "x" },
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("enforces the soft per-IP cap with RATE_LIMITED", async () => {
    const { deps, createMock, countPendingByIp } = buildDeps({
      pendingByIp: MAX_PENDING_PER_IP_24H,
    });

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        submitterIp: "203.0.113.7",
        fields: { title: "x" },
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // Counted on the keyed hash — never the IP.
    expect(countPendingByIp).toHaveBeenCalledWith({
      submitterIpHash: IP_HASH,
      since: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  // Ban that sticks round 3: the raw IP never reaches the repo.
  it("stores only the keyed hash of the submitter's IP", async () => {
    const { deps, createMock } = buildDeps();
    await submitEventEditSuggestion(deps, {
      eventId: EVENT_ID,
      submitterIp: "203.0.113.7",
      fields: { title: "x" },
    });
    const created = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.submitterIpHash).toBe(IP_HASH);
    expect(created).not.toHaveProperty("submitterIp");
    expect(JSON.stringify(created)).not.toContain("203.0.113");
  });

  it("without a usable secret: no hash, no cap, reported — the submission still goes through", async () => {
    const { deps, createMock, countPendingByIp } = buildDeps({
      pendingByIp: MAX_PENDING_PER_IP_24H,
    });
    const noSecret = { ...deps, identitySecret: null };
    await submitEventEditSuggestion(noSecret, {
      eventId: EVENT_ID,
      submitterIp: "203.0.113.7",
      fields: { title: "x" },
    });
    expect(countPendingByIp).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(
      (createMock.mock.calls[0]![0] as Record<string, unknown>).submitterIpHash,
    ).toBeNull();
  });

  it("stays under the cap: N-1 pending from the IP still submits", async () => {
    const { deps, createMock } = buildDeps({
      pendingByIp: MAX_PENDING_PER_IP_24H - 1,
    });

    await submitEventEditSuggestion(deps, {
      eventId: EVENT_ID,
      submitterIp: "203.0.113.7",
      fields: { title: "x" },
    });

    expect(createMock).toHaveBeenCalled();
  });

  it("rejects a lone endsAt before the CURRENT startsAt (cross-field, both directions)", async () => {
    const { deps } = buildDeps();

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        // Current startsAt is 2026-08-01T20:00Z.
        fields: { endsAt: "2026-08-01T19:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
  });

  it("rejects a lone startsAt moved past the CURRENT endsAt", async () => {
    const { deps } = buildDeps();

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        // Current endsAt is 2026-08-01T23:00Z.
        fields: { startsAt: "2026-08-02T01:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
  });

  it("stores the NORMALIZED body in fields and rejects javascript: cta hrefs", async () => {
    const { deps, createMock } = buildDeps();

    await submitEventEditSuggestion(deps, {
      eventId: EVENT_ID,
      fields: { content: makeValidBody() },
    });
    const stored = createMock.mock.calls[0]![0].fields as {
      content: { sections: Array<{ style?: unknown }> };
    };
    expect(stored.content.sections[0]!.style).toBeDefined();

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { content: makeXssCtaBody() },
      }),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
  });

  it("rejects an http(s) cta href carrying attribute-breaking characters at submit (belt-and-braces)", async () => {
    const { deps, createMock } = buildDeps();

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: {
          content: makeCtaBody('https://example.com/" onmouseover="alert(1)'),
        },
      }),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("content-filters the note and proposed body text, attributing the field", async () => {
    const { deps } = buildDeps({ blockedTexts: ["slurword"] });

    // note has no propose-form field → attributed to `note`.
    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "Fine title" },
        note: "contains slurword here",
      }),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "blocked_content", fields: ["note"] },
    });

    // Body text hits attribute to `content` (the propose-form body/detail).
    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { content: makeValidBody("body with slurword inside") },
      }),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "blocked_content", fields: ["content"] },
    });
  });

  it("content-filters the proposed title and attributes the title field", async () => {
    const { deps, createMock } = buildDeps({ blockedTexts: ["slurword"] });

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "slurword night" },
      }),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "blocked_content", fields: ["title"] },
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  // Geographic fields are EXEMPT from the content filter. Place names are
  // given, not authored — "1200 Dickerson Pike" is a real Nashville
  // thoroughfare the profanity matcher rejected.
  //
  // Blocked tokens match the fixture's casing on purpose: makeContentFilter
  // does a case-sensitive `includes`, so lowercase "dick" would never hit
  // "Dickerson" and the reject half of this test would be inert.
  it("does NOT content-filter the proposed addressText / region / locality", async () => {
    const { deps, createMock } = buildDeps({
      blockedTexts: ["Dickerson", "Middlesex"],
    });

    await submitEventEditSuggestion(deps, {
      eventId: EVENT_ID,
      fields: {
        addressText: "1200 Dickerson Pike, Nashville, TN",
        locality: "Middlesex",
      },
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0]!.fields).toMatchObject({
      addressText: "1200 Dickerson Pike, Nashville, TN",
      locality: "Middlesex",
    });

    // ...and the filter was never even asked about the address.
    for (const call of deps.contentFilter.hasBlockedContent.mock.calls) {
      expect(call[0]!.text).not.toContain("Dickerson");
      expect(call[0]!.text).not.toContain("Middlesex");
    }
  });

  it("surfaces the matched term in meta when the filter reports it (findBlocked)", async () => {
    const { deps } = buildDeps();
    // Swap in a content filter that implements the richer findBlocked contract.
    deps.contentFilter = {
      hasBlockedContent: vi.fn(async () => true),
      findBlocked: vi.fn(async () => ({
        blocked: true,
        matches: ["slurword", "other"],
      })),
    };

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "slurword night" },
      }),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "blocked_content", fields: ["title"], term: "slurword" },
    });
  });

  describe("heroImageId rules", () => {
    it("anonymous may reference an ATTACHED event image", async () => {
      const { deps, createMock } = buildDeps({
        image: makeImage({ attached: true }),
      });

      await submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { heroImageId: IMAGE_ID },
      });
      expect(createMock).toHaveBeenCalled();
    });

    it("anonymous may NOT reference an unattached image", async () => {
      const { deps, createMock } = buildDeps({
        image: makeImage({ attached: false }),
      });

      await expect(
        submitEventEditSuggestion(deps, {
          eventId: EVENT_ID,
          fields: { heroImageId: IMAGE_ID },
        }),
      ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("rejects a requested-but-never-uploaded image (uploadedAt null), even the submitter's own", async () => {
      const { deps, createMock } = buildDeps({
        image: makeImage({
          attached: false,
          createdByHumanId: USER_ID,
          uploadedAt: null,
          publicUrl: "",
        }),
      });

      await expect(
        submitEventEditSuggestion(deps, {
          eventId: EVENT_ID,
          submitterHumanId: USER_ID,
          fields: { heroImageId: IMAGE_ID },
        }),
      ).rejects.toMatchObject({
        code: "EDIT_SUGGESTION_INVALID_FIELDS",
        meta: expect.objectContaining({ reason: "upload_not_finalized" }),
      });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("signed-in submitter may reference their OWN unattached upload", async () => {
      const { deps, createMock } = buildDeps({
        image: makeImage({ attached: false, createdByHumanId: USER_ID }),
      });

      await submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        submitterHumanId: USER_ID,
        fields: { heroImageId: IMAGE_ID },
      });
      expect(createMock).toHaveBeenCalled();
    });

    it("signed-in submitter may NOT reference someone ELSE's unattached upload", async () => {
      const { deps } = buildDeps({
        image: makeImage({
          attached: false,
          createdByHumanId: "12121212-1212-4121-8121-121212121212",
        }),
      });

      await expect(
        submitEventEditSuggestion(deps, {
          eventId: EVENT_ID,
          submitterHumanId: USER_ID,
          fields: { heroImageId: IMAGE_ID },
        }),
      ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    });

    it("rejects an image belonging to a DIFFERENT event", async () => {
      const { deps } = buildDeps({
        image: makeImage({
          attached: true,
          eventId: "13131313-1313-4131-8131-131313131313",
        }),
      });

      await expect(
        submitEventEditSuggestion(deps, {
          eventId: EVENT_ID,
          fields: { heroImageId: IMAGE_ID },
        }),
      ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    });
  });

  describe("approver-side notification (Requirement A)", () => {
    const MOD_A = MODERATOR_ID;
    const MOD_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    it("COMMUNITY event: notifies every moderator and skips the submitter", async () => {
      // A signed-in submitter who is ALSO a moderator must not notify itself.
      const { deps, notificationsCreate, listHumanIdsByStaffRole } = buildDeps({
        moderatorIds: [MOD_A, USER_ID, MOD_B],
      });

      await submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        submitterHumanId: USER_ID,
        fields: { title: "Better title" },
      });

      expect(listHumanIdsByStaffRole).toHaveBeenCalledWith("COMMUNITY_MODERATOR");
      const notifiedHumanIds = notificationsCreate.mock.calls.map(
        (call) => (call[0] as { humanId: string }).humanId,
      );
      expect(notifiedHumanIds.sort()).toEqual([MOD_A, MOD_B].sort());
      expect(notifiedHumanIds).not.toContain(USER_ID);
      expect(notificationsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "New edit suggestion",
          kind: "INFO",
          tags: ["community", "suggestion"],
          metadata: expect.objectContaining({ eventId: EVENT_ID }),
          action: { label: "Review suggestion", route: "/moderate/suggestions" },
        }),
      );
    });

    it("COMMUNITY event WITH moderators: notifies moderators and does NOT ping admins (fallback dormant)", async () => {
      // Dedicated moderators exist → admins must not be looked up for recipients
      // nor notified, preserving the anti-noise intent.
      const ADMIN_ONLY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const { deps, notificationsCreate, listHumanIdsByStaffRole } = buildDeps({
        moderatorIds: [MOD_A, MOD_B],
        adminIds: [ADMIN_ONLY],
      });

      await submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "Better title" },
      });

      expect(listHumanIdsByStaffRole).toHaveBeenCalledWith("COMMUNITY_MODERATOR");
      // Fallback stays dormant — ADMIN role is never resolved.
      expect(listHumanIdsByStaffRole).not.toHaveBeenCalledWith("ADMIN");
      const notifiedHumanIds = notificationsCreate.mock.calls.map(
        (call) => (call[0] as { humanId: string }).humanId,
      );
      expect(notifiedHumanIds.sort()).toEqual([MOD_A, MOD_B].sort());
      expect(notifiedHumanIds).not.toContain(ADMIN_ONLY);
    });

    it("COMMUNITY event with NO moderators: falls back to notifying platform ADMINs", async () => {
      // Seeded/early-prod reality: no dedicated COMMUNITY_MODERATOR exists, so
      // the fallback fires and the ADMIN reviewers get pinged — the queue is
      // never left unwatched.
      const ADMIN_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const ADMIN_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const { deps, notificationsCreate, listHumanIdsByStaffRole } = buildDeps({
        moderatorIds: [],
        adminIds: [ADMIN_A, ADMIN_B],
      });

      await submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "Better title" },
      });

      expect(listHumanIdsByStaffRole).toHaveBeenCalledWith("COMMUNITY_MODERATOR");
      expect(listHumanIdsByStaffRole).toHaveBeenCalledWith("ADMIN");
      const notifiedHumanIds = notificationsCreate.mock.calls.map(
        (call) => (call[0] as { humanId: string }).humanId,
      );
      expect(notifiedHumanIds.sort()).toEqual([ADMIN_A, ADMIN_B].sort());
      expect(notificationsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: { label: "Review suggestion", route: "/moderate/suggestions" },
        }),
      );
    });

    it("COMMUNITY fallback still skips the submitter (a signed-in ADMIN who filed it)", async () => {
      const ADMIN_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const { deps, notificationsCreate } = buildDeps({
        moderatorIds: [],
        adminIds: [USER_ID, ADMIN_OTHER],
      });

      await submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        submitterHumanId: USER_ID,
        fields: { title: "Better title" },
      });

      const notifiedHumanIds = notificationsCreate.mock.calls.map(
        (call) => (call[0] as { humanId: string }).humanId,
      );
      expect(notifiedHumanIds).toEqual([ADMIN_OTHER]);
      expect(notifiedHumanIds).not.toContain(USER_ID);
    });

    // NOTE: the ORG/PERSONAL routing branches of notifySuggestionSubmitted are
    // unreachable from submit since suggestions went COMMUNITY-only (OWNED
    // events 404 before any notification) — their routing tests were removed
    // with that change.

    it("a notification failure never fails the submission (best-effort)", async () => {
      const { deps, notificationsCreate } = buildDeps({
        moderatorIds: [MOD_A],
      });
      notificationsCreate.mockRejectedValueOnce(new Error("notif down"));

      const result = await submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "Better title" },
      });

      expect(result.suggestion.status).toBe("PENDING");
    });
  });
});
