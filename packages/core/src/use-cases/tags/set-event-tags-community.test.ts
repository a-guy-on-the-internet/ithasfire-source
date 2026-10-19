import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { setEventTags, type SetEventTagsDeps } from "./set-event-tags";

/**
 * TAG PARITY FOR OWNERLESS COMMUNITY LISTINGS.
 *
 * `setEventTags` carried the same `ensureEventAccessible` shape every
 * event-humans use case did — org member OR human owner, else
 * `NOT_RESOURCE_OWNER` — which an ownerless COMMUNITY row can never satisfy.
 * It now routes through `ensureOwnerOrCommunityModerator`, so a community
 * moderator can tag a listing in the same builder they author it in.
 *
 * Note there is no read counterpart to gate: `tags.getEventTags` is a
 * `publicProcedure` with no authz at all, so the builder's tag panel already
 * reads fine on a community listing. Only the write needed opening.
 */

const EVENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const ACTOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const OTHER_HUMAN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
const TAG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";

const NOW = new Date("2026-09-01T12:00:00.000Z");

function communityDraft(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: null,
    humanId: null,
    stewardship: "COMMUNITY",
    attendanceMode: "RSVP",
    status: "DRAFT",
    publishedAt: null,
    ...overrides,
  });
}

function makeHarness(options: {
  event: EventRecord | null;
  moderator?: boolean;
  orgRole?: string | null;
}) {
  const getById = vi.fn(async () => options.event);
  const getOrgMembership = vi.fn(async () =>
    options.orgRole
      ? { orgId: ORG_ID, humanId: ACTOR_ID, role: options.orgRole }
      : null,
  );
  const hasStaffRole = vi.fn(async () => ({
    allowed: options.moderator === true,
  }));
  const setTags = vi.fn(
    async (_eventId: string, tags: Array<{ slug: string; name: string }>) =>
      tags.map((t, i) => ({
        id: `${TAG_ID}${i}`,
        eventId: EVENT_ID,
        tagId: TAG_ID,
        sortOrder: i,
        createdAt: NOW,
        tag: { id: TAG_ID, slug: t.slug, name: t.name, createdAt: NOW },
      })),
  );
  const auditLog = vi.fn(async () => undefined);

  // ONE surface for both `repos.*` and the tx callback, so every spy fires
  // wherever the use case reaches.
  const surface = {
    events: { getById },
    authz: { getOrgMembership, getHumanDelegation: vi.fn(async () => null) },
    tags: { setEventTags: setTags },
    audit: { log: auditLog },
  };

  const deps = {
    repos: {
      ...surface,
      tx: vi.fn(async (fn: (tx: unknown) => unknown) => fn(surface)),
    },
    authz: { hasStaffRole },
    clock: { now: () => NOW },
  } as unknown as SetEventTagsDeps;

  return {
    deps,
    spies: { getById, getOrgMembership, hasStaffRole, setTags, auditLog },
  };
}

const TAGS_INPUT = {
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  tags: [{ slug: "live-music", name: "Live Music" }],
};

describe("setEventTags COMMUNITY moderator branch", () => {
  it("a COMMUNITY_MODERATOR can tag a DRAFT community listing", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: true });

    const result = await setEventTags(h.deps, TAGS_INPUT);

    expect(result.tags).toEqual([
      { id: TAG_ID, slug: "live-music", name: "Live Music" },
    ]);
    // Same role set as getEventForEdit / community.updateListing — imported,
    // not re-listed.
    expect(h.spies.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
    });
    expect(h.spies.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "tags_set",
        data: expect.objectContaining({ actorHumanId: ACTOR_ID }),
      }),
    );
  });

  it("a PUBLISHED community listing can still be tagged (the arm is not DRAFT-only)", async () => {
    const h = makeHarness({
      event: communityDraft({ status: "PUBLISHED", publishedAt: NOW }),
      moderator: true,
    });

    await expect(setEventTags(h.deps, TAGS_INPUT)).resolves.toMatchObject({
      eventId: EVENT_ID,
    });
  });

  it("a signed-in non-moderator gets the SAME NOT_RESOURCE_OWNER as before, and nothing is written", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: false });

    await expect(setEventTags(h.deps, TAGS_INPUT)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "event" },
    });
    expect(h.spies.setTags).not.toHaveBeenCalled();
    expect(h.spies.auditLog).not.toHaveBeenCalled();
    expect(h.spies.getOrgMembership).not.toHaveBeenCalled();
  });

  it("a missing event still answers EVENT_NOT_FOUND — the refusals were already distinct and stay so", async () => {
    const h = makeHarness({ event: null, moderator: false });

    await expect(setEventTags(h.deps, TAGS_INPUT)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
    expect(h.spies.setTags).not.toHaveBeenCalled();
  });

  it("a stranger's refusal on a community draft is identical to one on a human-owned event", async () => {
    const capture = async (event: EventRecord | null) => {
      const h = makeHarness({ event, moderator: false });
      let thrown: unknown;
      try {
        await setEventTags(h.deps, TAGS_INPUT);
      } catch (err) {
        thrown = err;
      }
      const e = thrown as { code?: string; meta?: unknown; category?: unknown };
      return {
        code: e?.code,
        meta: e?.meta,
        category: e?.category,
        message: (thrown as Error | undefined)?.message,
      };
    };

    const draft = await capture(communityDraft());
    const ownedStranger = await capture(
      makeStubEventRecord({
        id: EVENT_ID,
        orgId: null,
        humanId: OTHER_HUMAN_ID,
        stewardship: "OWNED",
      }),
    );

    expect(draft.code).toBe("NOT_RESOURCE_OWNER");
    expect(draft).toEqual(ownedStranger);
  });

  it.each(["ARCHIVED", "CANCELLED", "COMPLETED"] as const)(
    "refuses even a MODERATOR on a %s community listing — the status rule applies to everyone",
    async (status) => {
      // The community arm opens WHO may set tags, never on WHAT.
      // ensureEventAllowsTagMutation still runs, unchanged, for every actor.
      const h = makeHarness({ event: communityDraft({ status }), moderator: true });

      await expect(setEventTags(h.deps, TAGS_INPUT)).rejects.toMatchObject({
        code: status === "ARCHIVED" ? "EVENT_ARCHIVED" : "EVENT_NOT_EDITABLE",
      });
      expect(h.spies.setTags).not.toHaveBeenCalled();
    },
  );

  it("the OWNED path is untouched: an org EDITOR passes with NO staff probe", async () => {
    const h = makeHarness({
      event: makeStubEventRecord({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        stewardship: "OWNED",
        status: "DRAFT",
      }),
      orgRole: "EDITOR",
    });

    await expect(setEventTags(h.deps, TAGS_INPUT)).resolves.toMatchObject({
      eventId: EVENT_ID,
    });
    expect(h.spies.getOrgMembership).toHaveBeenCalledTimes(1);
    expect(h.spies.hasStaffRole).not.toHaveBeenCalled();
  });

  it("the OWNED path is untouched: a VIEWER still gets INSUFFICIENT_ROLE", async () => {
    const h = makeHarness({
      event: makeStubEventRecord({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        stewardship: "OWNED",
        status: "DRAFT",
      }),
      orgRole: "VIEWER",
      moderator: true,
    });

    await expect(setEventTags(h.deps, TAGS_INPUT)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    // Being a community moderator buys nothing on an OWNED event.
    expect(h.spies.hasStaffRole).not.toHaveBeenCalled();
  });
});
