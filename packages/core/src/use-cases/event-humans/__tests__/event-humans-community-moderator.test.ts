import { describe, expect, it, vi } from "vitest";

import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type { EventRecord } from "@th/ports/repos/events";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import {
  attachEventHuman,
  type AttachEventHumanDeps,
} from "../attach-event-human";
import {
  detachEventHuman,
  type DetachEventHumanDeps,
} from "../detach-event-human";
import {
  listEventHumans,
  type ListEventHumansDeps,
} from "../list-event-humans";
import {
  reorderEventHumans,
  type ReorderEventHumansDeps,
} from "../reorder-event-humans";
import {
  getPerformerShareLinks,
  type GetPerformerShareLinksDeps,
} from "../get-performer-share-links";

/**
 * LINEUP PARITY FOR OWNERLESS COMMUNITY LISTINGS.
 *
 * Community listings are authored in the same `EventBuilder` as ticketed
 * events, but every event-humans use case ended in `NOT_RESOURCE_OWNER` for an
 * ownerless row (`orgId` AND `humanId` both null), so the builder had to hide
 * the lineup panel. `ensureOwnerOrCommunityModerator` gives all four a
 * COMMUNITY + `COMMUNITY_MODERATION_ROLES` arm.
 *
 * Three things are pinned here and all three matter:
 *  1. a moderator can list / attach / detach / reorder a DRAFT listing;
 *  2. a signed-in NON-moderator gets the SAME refusal they got before the arm
 *     existed — same code, same meta, same short-circuit — so the arm is not
 *     itself a signal, and cannot tell a draft listing apart from a missing
 *     event any better than they always could;
 *  3. the OWNED path is byte-identical: `hasStaffRole` is never even called.
 */

const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const EVENT_HUMAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const OTHER_HUMAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";

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
    slug: null,
    ...overrides,
  });
}

function orgOwnedEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    stewardship: "OWNED",
    status: "PUBLISHED",
    ...overrides,
  });
}

function humanOwnedEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: null,
    humanId: ACTOR_ID,
    stewardship: "OWNED",
    status: "PUBLISHED",
    ...overrides,
  });
}

function eventHuman(overrides: Partial<EventHumanRecord> = {}) {
  return {
    id: EVENT_HUMAN_ID,
    eventId: EVENT_ID,
    humanId: null,
    externalName: "Opener",
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 0,
    profileSlug: null,
    humanDisplayName: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as EventHumanRecord;
}

/**
 * ONE repo object, handed to BOTH `repos.*` and the `repos.tx(fn)` callback,
 * so a spy fires whichever surface the use case reaches for. A `{ tx }`-only
 * fake would go green over a guard that never ran.
 */
function makeHarness(options: {
  event: EventRecord | null;
  moderator?: boolean;
  orgRole?: string | null;
  eventHumans?: EventHumanRecord[];
  eventHumanRecord?: EventHumanRecord | null;
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
  const attach = vi.fn(async (input: Record<string, unknown>) =>
    eventHuman(input as Partial<EventHumanRecord>),
  );
  const detach = vi.fn(async () => undefined);
  const reorder = vi.fn(async () => undefined);
  const listByEvent = vi.fn(async () => options.eventHumans ?? []);
  const getEventHumanById = vi.fn(async () =>
    "eventHumanRecord" in options ? options.eventHumanRecord : eventHuman(),
  );
  const auditLog = vi.fn(async () => undefined);

  const surface = {
    events: { getById },
    eventHumans: {
      attach,
      detach,
      reorder,
      listByEvent,
      getById: getEventHumanById,
    },
    humans: { getByIds: vi.fn(async () => []) },
    authz: { getOrgMembership, getHumanDelegation: vi.fn(async () => null) },
    audit: { log: auditLog },
    // Open calls (FR-019): no call covers a community listing, so the
    // removal settles no pick.
    eventApplications: { getOpenCall: vi.fn(async () => null) },
    seriesOccurrences: { getCalendarInfoForEventIds: vi.fn(async () => []) },
  };

  const repos = {
    ...surface,
    tx: vi.fn(async (fn: (tx: unknown) => unknown) => fn(surface)),
  };

  const deps = {
    repos,
    authz: { hasStaffRole },
    clock: { now: () => NOW },
  };

  return {
    deps,
    spies: {
      getById,
      getOrgMembership,
      hasStaffRole,
      attach,
      detach,
      reorder,
      listByEvent,
      auditLog,
    },
  };
}

const asList = (h: ReturnType<typeof makeHarness>) =>
  h.deps as unknown as ListEventHumansDeps;
const asAttach = (h: ReturnType<typeof makeHarness>) =>
  h.deps as unknown as AttachEventHumanDeps;
const asDetach = (h: ReturnType<typeof makeHarness>) =>
  h.deps as unknown as DetachEventHumanDeps;
const asReorder = (h: ReturnType<typeof makeHarness>) =>
  h.deps as unknown as ReorderEventHumansDeps;

const ATTACH_INPUT = {
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  externalName: "Opener",
  role: "PERFORMER" as const,
  sortOrder: 0,
};

const MODERATION_ROLES = expect.arrayContaining([
  "COMMUNITY_MODERATOR",
  "ADMIN",
]);

// ─────────────────────────────────────────────────────────────────────────────
// The moderator can work the lineup
// ─────────────────────────────────────────────────────────────────────────────

describe("event-humans COMMUNITY moderator branch — the moderator path", () => {
  it("listEventHumans returns the lineup of a DRAFT community listing", async () => {
    const h = makeHarness({
      event: communityDraft(),
      moderator: true,
      eventHumans: [eventHuman()],
    });

    const result = await listEventHumans(asList(h), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(EVENT_HUMAN_ID);
    // The SAME role set community.createListing / updateListing / publish and
    // getEventForEdit use — imported, never re-listed.
    expect(h.spies.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR_ID,
      requiredRoles: MODERATION_ROLES,
    });
  });

  it("attachEventHuman adds a performer to a DRAFT community listing and audits it", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: true });

    const result = await attachEventHuman(asAttach(h), ATTACH_INPUT);

    expect(result.externalName).toBe("Opener");
    expect(h.spies.attach).toHaveBeenCalledTimes(1);
    expect(h.spies.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_human",
        action: "attached",
        data: expect.objectContaining({ actorHumanId: ACTOR_ID }),
      }),
    );
  });

  it("reorderEventHumans reorders a DRAFT community listing's lineup", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: true });

    await reorderEventHumans(asReorder(h), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      orderedIds: [EVENT_HUMAN_ID],
    });

    expect(h.spies.reorder).toHaveBeenCalledWith(EVENT_ID, [EVENT_HUMAN_ID]);
  });

  it("detachEventHuman removes a lineup entry from a DRAFT community listing", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: true });

    await detachEventHuman(asDetach(h), {
      actorHumanId: ACTOR_ID,
      eventHumanId: EVENT_HUMAN_ID,
    });

    expect(h.spies.detach).toHaveBeenCalledWith(EVENT_HUMAN_ID);
  });

  it("a PUBLISHED community listing is editable too — the arm is not DRAFT-only", async () => {
    // Lineup is NOT in SUGGESTION_EDITABLE_FIELDS, so a DRAFT-only gate would
    // freeze it forever the moment a listing goes live. Parity means the
    // moderator keeps the panel after publish.
    const h = makeHarness({
      event: communityDraft({ status: "PUBLISHED", publishedAt: NOW }),
      moderator: true,
    });

    await expect(attachEventHuman(asAttach(h), ATTACH_INPUT)).resolves.toEqual(
      expect.objectContaining({ externalName: "Opener" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The non-moderator is exactly where they were
// ─────────────────────────────────────────────────────────────────────────────

describe("event-humans COMMUNITY moderator branch — the refusal that must not have moved", () => {
  const REFUSAL = { code: "NOT_RESOURCE_OWNER", meta: { entity: "event" } };

  it("listEventHumans refuses a signed-in stranger with the SAME error as before", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: false });

    await expect(
      listEventHumans(asList(h), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject(REFUSAL);
    // Short-circuits before any org lookup or any read of the lineup itself.
    expect(h.spies.getOrgMembership).not.toHaveBeenCalled();
    expect(h.spies.listByEvent).not.toHaveBeenCalled();
  });

  it("attachEventHuman refuses a non-moderator and writes nothing", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: false });

    await expect(
      attachEventHuman(asAttach(h), ATTACH_INPUT),
    ).rejects.toMatchObject(REFUSAL);
    expect(h.spies.attach).not.toHaveBeenCalled();
    expect(h.spies.auditLog).not.toHaveBeenCalled();
  });

  it("reorderEventHumans refuses a non-moderator and writes nothing", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: false });

    await expect(
      reorderEventHumans(asReorder(h), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        orderedIds: [EVENT_HUMAN_ID],
      }),
    ).rejects.toMatchObject(REFUSAL);
    expect(h.spies.reorder).not.toHaveBeenCalled();
    expect(h.spies.auditLog).not.toHaveBeenCalled();
  });

  it("detachEventHuman refuses a non-moderator and writes nothing", async () => {
    const h = makeHarness({ event: communityDraft(), moderator: false });

    await expect(
      detachEventHuman(asDetach(h), {
        actorHumanId: ACTOR_ID,
        eventHumanId: EVENT_HUMAN_ID,
      }),
    ).rejects.toMatchObject(REFUSAL);
    expect(h.spies.detach).not.toHaveBeenCalled();
    expect(h.spies.auditLog).not.toHaveBeenCalled();
  });

  it("being an EDITOR of some unrelated org buys nothing on an ownerless listing", async () => {
    const h = makeHarness({
      event: communityDraft(),
      moderator: false,
      orgRole: "OWNER",
    });

    await expect(
      listEventHumans(asList(h), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject(REFUSAL);
    expect(h.spies.getOrgMembership).not.toHaveBeenCalled();
  });

  // ── THE NON-ORACLE PIN ───────────────────────────────────────────────────
  //
  // These use cases have ALWAYS answered EVENT_NOT_FOUND for an id that is not
  // there and NOT_RESOURCE_OWNER for an event you cannot touch — on OWNED rows
  // exactly as much as community ones. The moderator arm must neither widen
  // nor narrow that: the refusal a stranger gets for a DRAFT community listing
  // has to be the pre-existing NOT_RESOURCE_OWNER, field for field, and the id
  // that does not exist has to keep answering the pre-existing
  // EVENT_NOT_FOUND. Collapsing either into the other would be a behaviour
  // change dressed up as hardening.
  describe("the stranger's view of a community draft is unchanged, and so is the missing-event view", () => {
    const capture = async (event: EventRecord | null) => {
      const h = makeHarness({ event, moderator: false });
      let thrown: unknown;
      try {
        await listEventHumans(asList(h), {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
        });
      } catch (err) {
        thrown = err;
      }
      const e = thrown as {
        code?: string;
        meta?: unknown;
        category?: unknown;
      };
      return {
        observable: {
          code: e?.code,
          meta: e?.meta,
          category: e?.category,
          message: (thrown as Error | undefined)?.message,
        },
        lineupReads: h.spies.listByEvent.mock.calls.length,
      };
    };

    it("a DRAFT community listing still refuses with NOT_RESOURCE_OWNER, byte for byte", async () => {
      const draft = await capture(communityDraft());
      // The pre-existing refusal on an ownerless row, unchanged by the arm.
      const ownedStranger = await capture(
        humanOwnedEvent({ humanId: OTHER_HUMAN_ID }),
      );

      expect(draft.observable.code).toBe("NOT_RESOURCE_OWNER");
      expect(draft.observable).toEqual(ownedStranger.observable);
      expect(draft.lineupReads).toBe(0);
    });

    it("a missing event still answers EVENT_NOT_FOUND, and nothing is read", async () => {
      const missing = await capture(null);

      expect(missing.observable.code).toBe("EVENT_NOT_FOUND");
      expect(missing.lineupReads).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The owned path did not move
// ─────────────────────────────────────────────────────────────────────────────

describe("event-humans COMMUNITY moderator branch — the OWNED path is untouched", () => {
  it("an org EDITOR still lists an org-owned event's lineup, with NO staff probe", async () => {
    const h = makeHarness({
      event: orgOwnedEvent(),
      orgRole: "EDITOR",
      eventHumans: [eventHuman()],
    });

    await expect(
      listEventHumans(asList(h), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).resolves.toHaveLength(1);
    expect(h.spies.getOrgMembership).toHaveBeenCalledTimes(1);
    // The community arm costs the owned path exactly nothing.
    expect(h.spies.hasStaffRole).not.toHaveBeenCalled();
  });

  it("a non-member still gets INSUFFICIENT_ROLE on an org-owned event", async () => {
    const h = makeHarness({ event: orgOwnedEvent(), orgRole: null });

    await expect(
      attachEventHuman(asAttach(h), ATTACH_INPUT),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(h.spies.hasStaffRole).not.toHaveBeenCalled();
    expect(h.spies.attach).not.toHaveBeenCalled();
  });

  it("a VIEWER still gets INSUFFICIENT_ROLE (ORG_EDIT_ROLES unchanged)", async () => {
    const h = makeHarness({ event: orgOwnedEvent(), orgRole: "VIEWER" });

    await expect(
      reorderEventHumans(asReorder(h), {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        orderedIds: [EVENT_HUMAN_ID],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(h.spies.reorder).not.toHaveBeenCalled();
  });

  it("the human owner still passes, with NO staff probe", async () => {
    const h = makeHarness({ event: humanOwnedEvent() });

    await expect(
      attachEventHuman(asAttach(h), ATTACH_INPUT),
    ).resolves.toEqual(expect.objectContaining({ externalName: "Opener" }));
    expect(h.spies.hasStaffRole).not.toHaveBeenCalled();
  });

  it("a stranger on a human-owned event still gets NOT_RESOURCE_OWNER, with NO staff probe", async () => {
    const h = makeHarness({
      event: humanOwnedEvent({ humanId: OTHER_HUMAN_ID }),
      moderator: true,
    });

    await expect(
      attachEventHuman(asAttach(h), ATTACH_INPUT),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "event" },
    });
    // Being a community moderator buys NOTHING on an OWNED event — the arm is
    // selected by stewardship, not by role.
    expect(h.spies.hasStaffRole).not.toHaveBeenCalled();
  });

  it("detachEventHuman still 404s on a missing lineup row before any authz work", async () => {
    const h = makeHarness({
      event: communityDraft(),
      moderator: true,
      eventHumanRecord: null,
    });

    await expect(
      detachEventHuman(asDetach(h), {
        actorHumanId: ACTOR_ID,
        eventHumanId: EVENT_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_HUMAN_NOT_FOUND" });
    expect(h.spies.hasStaffRole).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The one that stayed shut
// ─────────────────────────────────────────────────────────────────────────────

describe("getPerformerShareLinks stays refused on an ownerless listing", () => {
  it("even a COMMUNITY_MODERATOR gets NOT_RESOURCE_OWNER", async () => {
    // Share links mint `?ref=` attribution URLs that only the CHECKOUT flow
    // reads. A community listing is RSVP-only — no checkout, no order, no
    // payee — so the panel would credit nobody for nothing. Deliberately left
    // closed; the builder hides it in community mode. If this ever flips,
    // `events.inviteLineupHumanToRegister` (Stripe Connect payout-line invite,
    // same editor, same reasoning) has to be reconsidered with it.
    const h = makeHarness({
      event: communityDraft({ status: "PUBLISHED", publishedAt: NOW }),
      moderator: true,
    });

    await expect(
      getPerformerShareLinks(
        h.deps as unknown as GetPerformerShareLinksDeps,
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "event" },
    });
    expect(h.spies.hasStaffRole).not.toHaveBeenCalled();
  });
});
