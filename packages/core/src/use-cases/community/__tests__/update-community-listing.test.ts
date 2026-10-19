import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  updateCommunityListing,
  type UpdateCommunityListingDeps,
} from "../update-community-listing";

// FR-018 boundary (booking holds): the line mechanics are pinned by the
// helper's own suite; here WHEN a direct save calls it and how the result
// rides the output is pinned. The mock routes to the real helper unless a
// case overrides it, so every other case in this file is unaffected. Same
// shape as `review-event-edit-suggestion.test.ts` — both paths run the same
// post-apply pipeline, so both suites pin it the same way.
const { settleHeldDatesForEvent } = vi.hoisted(() => ({
  settleHeldDatesForEvent: vi.fn(),
}));
vi.mock("../../booking-holds/settle-held-dates-for-published-event", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../booking-holds/settle-held-dates-for-published-event")
    >();
  settleHeldDatesForEvent.mockImplementation(actual.settleHeldDatesForEvent);
  return {
    ...actual,
    settleHeldDatesForEvent: (...args: unknown[]) =>
      settleHeldDatesForEvent(...args),
  };
});

import type { EventRecord } from "@th/ports/repos/events";
import {
  ADMIN_ID,
  EVENT_ID,
  IMAGE_ID,
  MODERATOR_ID,
  NOW,
  ORG_ID,
  USER_ID,
  makeClock,
  makeCommunityEvent,
  makeContentFilter,
  makeImage,
  makeOrgEvent,
  makeStaffAuthz,
  makeValidBody,
  makeXssCtaBody,
} from "./helpers";

const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOLD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";

/** What the settle returns when it actually took a line off somebody. */
const OWED = {
  confirmed: [],
  released: [{ id: HOLD_ID }],
  intents: [
    {
      kind: "hold.released",
      bookingRequestId: REQUEST_ID,
      holdId: HOLD_ID,
      audience: "act",
      date: "2026-08-08",
      reason: "EVENT_SCHEDULED",
    },
  ],
  staffRecipientHint: {
    assigneeHumanId: null,
    placedByHumanId: MODERATOR_ID,
    orgId: ORG_ID,
    placeId: PLACE_ID,
  },
};

function makeDraftListing(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeCommunityEvent({
    status: "DRAFT",
    publishedAt: null,
    ...overrides,
  });
}

function buildDeps(
  overrides: {
    event?: EventRecord | null;
    blockedTexts?: string[];
    image?: ReturnType<typeof makeImage> | null;
    currentContent?: unknown | null;
    eventImages?: ReturnType<typeof makeImage>[];
  } = {},
) {
  const event = "event" in overrides ? overrides.event : makeDraftListing();
  const image = "image" in overrides ? overrides.image : makeImage();

  const getById = vi.fn(async () => event);
  const getContent = vi.fn(async () => overrides.currentContent ?? null);
  const applyCommunityEdit = vi.fn(
    async ({ eventId, fields }: { eventId: string; fields: Record<string, unknown> }) =>
      ({ ...(event as EventRecord), id: eventId, ...fields }) as EventRecord,
  );
  const audit = { log: vi.fn() };
  const images = {
    getById: vi.fn(async () => image),
    listByEventId: vi.fn(async () => overrides.eventImages ?? []),
    attach: vi.fn(async () => undefined),
  };
  const eventChangeNoticesCreate = vi.fn(async () => ({
    id: "notice-1",
    createdAt: NOW,
  }));
  const calendars = { findById: vi.fn(async () => null) };

  const txRepos = {
    events: {
      getById,
      getContent,
      applyCommunityEdit,
      // The direct edit row-locks the listing before reading it.
      lockRows: vi.fn(async () => undefined),
    },
    images,
    audit,
    eventChangeNotices: { create: eventChangeNoticesCreate },
    calendars,
  };

  const deps: UpdateCommunityListingDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as UpdateCommunityListingDeps["repos"],
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: makeClock(),
    contentFilter: makeContentFilter(overrides.blockedTexts),
  };

  return {
    deps,
    getById,
    getContent,
    applyCommunityEdit,
    audit,
    images,
    eventChangeNoticesCreate,
    calendars,
  };
}

const input = (fields: Record<string, unknown>) => ({
  actorHumanId: MODERATOR_ID,
  eventId: EVENT_ID,
  fields,
});

/** The `event_edit.applied` version-history row, or undefined. */
function appliedAuditRow(audit: { log: { mock: { calls: unknown[][] } } }) {
  return audit.log.mock.calls
    .map((call) => call[0] as { action: string; data: Record<string, unknown> })
    .find((entry) => entry.action === "event_edit.applied");
}

beforeEach(() => {
  settleHeldDatesForEvent.mockClear();
});

describe("updateCommunityListing", () => {
  it("writes a whitelisted field diff through applyCommunityEdit", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    const result = await updateCommunityListing(
      deps,
      input({ title: "Weekly Open Mic & Jam", ageLimit: 21 }),
    );

    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { title: "Weekly Open Mic & Jam", ageLimit: 21 },
    });
    expect(result.updatedFields.sort()).toEqual(["ageLimit", "title"]);
  });

  it("persists the NORMALIZED body, not the raw proposal", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    await updateCommunityListing(deps, input({ content: makeValidBody() }));

    const written = applyCommunityEdit.mock.calls[0]![0].fields as {
      content: { sections: Array<{ style?: unknown }> };
    };
    // sanitizeEventBody applies schema defaults (e.g. section style).
    expect(written.content.sections[0]!.style).toBeDefined();
  });

  it("audits the editor with the serialized diff", async () => {
    const { deps, audit } = buildDeps();
    // Before the fixture's endsAt (2026-08-01T23:00Z) — a lone startsAt is
    // still checked against the listing's current other bound.
    const startsAt = new Date("2026-08-01T19:00:00.000Z");

    await updateCommunityListing(deps, input({ startsAt }));

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "community_listing.updated",
        data: expect.objectContaining({
          actorHumanId: MODERATOR_ID,
          updatedFields: ["startsAt"],
          // Dates serialized so the audit Json round-trips.
          fields: { startsAt: startsAt.toISOString() },
        }),
        at: NOW,
      }),
    );
  });

  it("attaches a newly-referenced hero image in the SAME transaction", async () => {
    const { deps, images } = buildDeps({
      image: makeImage({ attached: false, createdByHumanId: MODERATOR_ID }),
    });

    await updateCommunityListing(deps, input({ heroImageId: IMAGE_ID }));

    expect(images.attach).toHaveBeenCalledWith({
      ownerId: EVENT_ID,
      imageIds: [IMAGE_ID],
      attachedAt: NOW,
    });
  });

  it("allows a platform ADMIN as well as a community moderator", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    await expect(
      updateCommunityListing(deps, {
        ...input({ title: "Renamed" }),
        actorHumanId: ADMIN_ID,
      }),
    ).resolves.toBeTruthy();
    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
  });

  it("rejects non-moderators with STAFF_ONLY and never writes", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    await expect(
      updateCommunityListing(deps, {
        ...input({ title: "Renamed" }),
        actorHumanId: USER_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("rejects an unknown field name", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    await expect(
      updateCommunityListing(deps, input({ status: "PUBLISHED" })),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("rejects an empty diff", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    await expect(updateCommunityListing(deps, input({}))).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
    });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("rejects a body with a javascript: cta href", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    await expect(
      updateCommunityListing(deps, input({ content: makeXssCtaBody() })),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("rejects filter-blocked title text", async () => {
    const { deps, applyCommunityEdit } = buildDeps({ blockedTexts: ["slurword"] });

    await expect(
      updateCommunityListing(deps, input({ title: "Totally slurword night" })),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("rejects a lone endsAt that lands before the listing's current start", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    await expect(
      updateCommunityListing(
        deps,
        input({ endsAt: new Date("2026-07-01T00:00:00.000Z") }),
      ),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("rejects a missing event with EVENT_NOT_FOUND", async () => {
    const { deps, applyCommunityEdit } = buildDeps({ event: null });

    await expect(
      updateCommunityListing(deps, input({ title: "Renamed" })),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("refuses an OWNED event", async () => {
    const { deps, applyCommunityEdit } = buildDeps({
      event: makeOrgEvent({ status: "DRAFT", publishedAt: null }),
    });

    await expect(
      updateCommunityListing(deps, input({ title: "Renamed" })),
    ).rejects.toMatchObject({ code: "EVENT_NOT_COMMUNITY" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STATUS BOUNDARIES. DRAFT (authoring) and PUBLISHED (fixing a live listing)
  // are both editable. The three END states are not, and answer the same codes
  // `setEventTags` answers for the same listing in the same states.
  // ───────────────────────────────────────────────────────────────────────────
  it.each([
    ["CANCELLED", "EVENT_NOT_EDITABLE"],
    ["COMPLETED", "EVENT_NOT_EDITABLE"],
    ["ARCHIVED", "EVENT_ARCHIVED"],
  ] as const)(
    "refuses to edit a %s listing (%s) and never writes",
    async (status, code) => {
      const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
        buildDeps({ event: makeCommunityEvent({ status }) });

      await expect(
        updateCommunityListing(deps, input({ title: "Renamed" })),
      ).rejects.toMatchObject({ code, meta: { status } });
      expect(applyCommunityEdit).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    },
  );

  // ───────────────────────────────────────────────────────────────────────────
  // THE DRAFT PATH IS UNCHANGED. A pencil-in is invisible, un-RSVP-able, holds
  // no calendar line and is not in the search index, so it owes none of the
  // post-apply pipeline. Pinned so a future change to the PUBLISHED branch
  // cannot quietly start charging a draft save for reads and notices.
  // ───────────────────────────────────────────────────────────────────────────
  describe("DRAFT save", () => {
    it("writes community_listing.updated and NOTHING from the shared pipeline", async () => {
      const { deps, audit, eventChangeNoticesCreate, getContent, images } =
        buildDeps();

      await updateCommunityListing(
        deps,
        input({
          startsAt: new Date("2026-08-08T20:00:00.000Z"),
          endsAt: new Date("2026-08-08T23:00:00.000Z"),
        }),
      );

      const actions = audit.log.mock.calls.map(
        (call) => (call[0] as { action: string }).action,
      );
      expect(actions).toEqual(["community_listing.updated"]);
      expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
      expect(settleHeldDatesForEvent).not.toHaveBeenCalled();
      // The pre-edit snapshot reads only a live listing pays for.
      expect(getContent).not.toHaveBeenCalled();
      expect(images.listByEventId).not.toHaveBeenCalled();
    });

    it("carries no hold-notification keys on its output", async () => {
      const { deps } = buildDeps({
        event: makeDraftListing({ calendarId: CALENDAR_ID } as Partial<EventRecord>),
      });

      const result = await updateCommunityListing(
        deps,
        input({
          startsAt: new Date("2026-08-08T20:00:00.000Z"),
          endsAt: new Date("2026-08-08T23:00:00.000Z"),
        }),
      );

      expect(result).not.toHaveProperty("notificationIntents");
      expect(result).not.toHaveProperty("staffRecipientHint");
      expect(settleHeldDatesForEvent).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // A LIVE LISTING. A moderator edits it directly — no suggestion filed, no
  // self-approval — and it owes everything an approved suggestion owes,
  // through the SAME shared pipeline.
  // ───────────────────────────────────────────────────────────────────────────
  describe("PUBLISHED listing", () => {
    const publishedListing = (overrides: Partial<EventRecord> = {}) =>
      makeCommunityEvent({ status: "PUBLISHED", ...overrides });

    it("a non-material edit (title) applies, writes the version-history row, and sends NO change notice", async () => {
      const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
        buildDeps({ event: publishedListing() });

      const result = await updateCommunityListing(
        deps,
        input({ title: "Weekly Open Mic & Jam" }),
      );

      expect(applyCommunityEdit).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        fields: { title: "Weekly Open Mic & Jam" },
      });
      expect(result.updatedFields).toEqual(["title"]);

      const applied = appliedAuditRow(audit);
      expect(applied).toBeDefined();
      expect(applied!.data).toMatchObject({
        material: false,
        changes: {
          title: { before: "Weekly Open Mic", after: "Weekly Open Mic & Jam" },
        },
      });
      // A title change is not material to an attendee — nobody is told.
      expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    });

    it("a material edit (start time) writes exactly ONE RESCHEDULED notice, in the same tx", async () => {
      const { deps, audit, eventChangeNoticesCreate } = buildDeps({
        event: publishedListing(),
      });
      const startsAt = new Date("2026-08-01T19:00:00.000Z");

      await updateCommunityListing(deps, input({ startsAt }));

      expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
      expect(eventChangeNoticesCreate).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        changeType: "RESCHEDULED",
        payload: {
          eventTitle: "Weekly Open Mic",
          newStartsAt: startsAt.toISOString(),
          // No endsAt in the diff — falls back to the listing's current end.
          newEndsAt: "2026-08-01T23:00:00.000Z",
        },
      });
      expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
    });

    it("an edit that moves BOTH the schedule and the venue writes TWO notices, never one", async () => {
      const { deps, eventChangeNoticesCreate } = buildDeps({
        event: publishedListing(),
      });

      await updateCommunityListing(
        deps,
        input({
          startsAt: new Date("2026-08-08T20:00:00.000Z"),
          endsAt: new Date("2026-08-08T23:00:00.000Z"),
          addressText: "88 Elsewhere Ave, Austin, TX",
          lat: 30.3,
          lng: -97.7,
        }),
      );

      expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(2);
      expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ changeType: "RESCHEDULED" }),
      );
      expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ changeType: "VENUE_CHANGED" }),
      );
    });

    it("a venue-only move writes VENUE_CHANGED alone and never settles held dates", async () => {
      const { deps, eventChangeNoticesCreate } = buildDeps({
        event: publishedListing({ calendarId: CALENDAR_ID } as Partial<EventRecord>),
      });

      await updateCommunityListing(
        deps,
        input({ addressText: "88 Elsewhere Ave, Austin, TX" }),
      );

      expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
      expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ changeType: "VENUE_CHANGED" }),
      );
      expect(settleHeldDatesForEvent).not.toHaveBeenCalled();
    });

    // ── A typed address edit: the pin OR the street line ─────────────────
    // Re-picking the same address from the suggestions returns a pin a few
    // metres off and its own formatting. That is saved and audited, but it is
    // no venue change: a false "venue changed" alert trains RSVPers to ignore
    // the real one. A different street address is one, even at the same pin.
    // Decided server-side, whatever the client sends.
    describe("typed address edit (no place link)", () => {
      it("address text + postcode with the pin moved under 50 m: applied and audited, NOT material, no notice", async () => {
        const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
          buildDeps({ event: publishedListing() });

        // 0.0003° of latitude is about 33 m from the stored 30.27, -97.74.
        const result = await updateCommunityListing(
          deps,
          input({
            addressText: "123 Main Street, Austin, TX 78701, USA",
            postalCode: "78702",
            lat: 30.2703,
            lng: -97.74,
          }),
        );

        expect(applyCommunityEdit).toHaveBeenCalledWith({
          eventId: EVENT_ID,
          fields: {
            addressText: "123 Main Street, Austin, TX 78701, USA",
            postalCode: "78702",
            lat: 30.2703,
            lng: -97.74,
          },
        });
        expect(result.updatedFields).toEqual(
          expect.arrayContaining(["addressText", "postalCode", "lat", "lng"]),
        );
        expect(appliedAuditRow(audit)!.data).toMatchObject({
          material: false,
          changes: {
            postalCode: { before: "78701", after: "78702" },
          },
        });
        expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
      });

      it("the same pin with the SAME street line reformatted is NOT material", async () => {
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing(),
        });

        await updateCommunityListing(
          deps,
          input({
            addressText: "123 Main St., Austin, Texas",
            lat: 30.27,
            lng: -97.74,
          }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: false });
        expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
      });

      it("address text WITHOUT a pin: the cautious rule, material, ONE VENUE_CHANGED notice", async () => {
        // The pin cannot speak for text sent alone (the text may name another
        // building while the pin stays put), so any address field written is
        // a venue change.
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing(),
        });

        await updateCommunityListing(
          deps,
          input({ addressText: "2 Broadway, Austin" }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
        expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
        expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
          expect.objectContaining({ changeType: "VENUE_CHANGED" }),
        );
      });

      it("a DIFFERENT street address at the same pin: material, ONE VENUE_CHANGED notice", async () => {
        // The pin cannot tell a building from its neighbour; the text can.
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing(),
        });

        await updateCommunityListing(
          deps,
          input({ addressText: "2 Broadway, Austin, TX", lat: 30.27, lng: -97.74 }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
        expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
        expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
          expect.objectContaining({ changeType: "VENUE_CHANGED" }),
        );
      });

      // The incident listing (Nashville, 2026-10-14).
      const INCIDENT = {
        addressText:
          "211 27th Avenue North, Nashville, TN 37203, United States of America",
        locality: "Nashville",
        region: "TN",
        postalCode: "37203",
        lat: 36.1497,
        lng: -86.8126,
      } as Partial<EventRecord>;
      // ~1 m of latitude in degrees.
      const METRE = 1 / 111_195;

      it("unlock-then-lock: the unchanged pin reverse-geocoded to another street address is material", async () => {
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing(INCIDENT),
        });

        await updateCommunityListing(
          deps,
          input({
            addressText: "245 25th Avenue North, Nashville, TN 37203",
            postalCode: "37203",
            lat: 36.1497,
            lng: -86.8126,
          }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
        expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
        expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
          expect.objectContaining({ changeType: "VENUE_CHANGED" }),
        );
      });

      it("the same street abbreviated, country dropped, postcode changed, pin 10 m off: NOT material", async () => {
        // THE reported bug, server side.
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing(INCIDENT),
        });

        await updateCommunityListing(
          deps,
          input({
            addressText: "211 27th Ave N, Nashville, TN 37209",
            postalCode: "37209",
            lat: 36.1497 + 10 * METRE,
            lng: -86.8126,
          }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: false });
        expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
      });

      it("the next-door address with the pin within 30 m: material", async () => {
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing(INCIDENT),
        });

        await updateCommunityListing(
          deps,
          input({
            addressText: "213 27th Avenue North, Nashville, TN 37203",
            postalCode: "37203",
            lat: 36.1497 + 25 * METRE,
            lng: -86.8126,
          }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
        expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
          expect.objectContaining({ changeType: "VENUE_CHANGED" }),
        );
      });

      it("the pin moved over 50 m: material, ONE VENUE_CHANGED notice", async () => {
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing(),
        });

        // 0.0006° of latitude is about 67 m.
        await updateCommunityListing(
          deps,
          input({
            addressText: "123 Main St, Austin, TX",
            lat: 30.2706,
            lng: -97.74,
          }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
        expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
        expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
          expect.objectContaining({ changeType: "VENUE_CHANGED" }),
        );
      });

      it("a pin appearing where the listing had none: material, VENUE_CHANGED", async () => {
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing({ lat: null, lng: null }),
        });

        await updateCommunityListing(
          deps,
          input({ addressText: "123 Main St, Austin, TX", lat: 30.27, lng: -97.74 }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
        expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
          expect.objectContaining({ changeType: "VENUE_CHANGED" }),
        );
      });

      it("a sub-50 m address edit alongside a schedule move sends RESCHEDULED only", async () => {
        const { deps, audit, eventChangeNoticesCreate } = buildDeps({
          event: publishedListing(),
        });

        await updateCommunityListing(
          deps,
          input({
            startsAt: new Date("2026-08-08T20:00:00.000Z"),
            endsAt: new Date("2026-08-08T23:00:00.000Z"),
            postalCode: "78702",
            lat: 30.2703,
            lng: -97.74,
          }),
        );

        expect(appliedAuditRow(audit)!.data).toMatchObject({ material: true });
        expect(eventChangeNoticesCreate).toHaveBeenCalledTimes(1);
        expect(eventChangeNoticesCreate).toHaveBeenCalledWith(
          expect.objectContaining({ changeType: "RESCHEDULED" }),
        );
      });
    });

    it("the version-history row is DISTINGUISHABLE from a suggestion apply: suggestionId is explicitly null", async () => {
      const { deps, audit } = buildDeps({ event: publishedListing() });

      await updateCommunityListing(deps, input({ title: "Renamed" }));

      const applied = appliedAuditRow(audit)!;
      expect(applied).toMatchObject({
        entity: "event",
        entityId: EVENT_ID,
        action: "event_edit.applied",
        at: NOW,
      });
      // The key is PRESENT and null — "a moderator changed this directly" —
      // not absent, so a reader never has to guess.
      expect(Object.keys(applied.data)).toContain("suggestionId");
      expect(applied.data.suggestionId).toBeNull();
      expect(applied.data).toMatchObject({
        actorHumanId: MODERATOR_ID,
        conflictedFields: [],
      });
    });

    it("writes ONE audit row: the richer event_edit.applied, not also community_listing.updated", async () => {
      const { deps, audit } = buildDeps({ event: publishedListing() });

      await updateCommunityListing(deps, input({ title: "Renamed" }));

      const actions = audit.log.mock.calls.map(
        (call) => (call[0] as { action: string }).action,
      );
      expect(actions).toEqual(["event_edit.applied"]);
    });

    it("a schedule move settles held dates inside the tx — applied row, moderator, community owner — and the intents ride the output", async () => {
      const { deps, applyCommunityEdit } = buildDeps({
        event: publishedListing({ calendarId: CALENDAR_ID } as Partial<EventRecord>),
      });
      settleHeldDatesForEvent.mockResolvedValueOnce(OWED);

      const result = await updateCommunityListing(
        deps,
        input({
          startsAt: new Date("2026-08-08T20:00:00.000Z"),
          endsAt: new Date("2026-08-08T23:00:00.000Z"),
        }),
      );

      expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
      const [tx, args] = settleHeldDatesForEvent.mock.calls[0]!;
      expect(tx).toMatchObject({
        events: expect.anything(),
        audit: expect.anything(),
      });
      expect(args).toMatchObject({
        event: expect.objectContaining({
          id: EVENT_ID,
          calendarId: CALENDAR_ID,
          startsAt: new Date("2026-08-08T20:00:00.000Z"),
        }),
        now: NOW,
        actorHumanId: MODERATOR_ID,
        owner: { kind: "community" },
      });
      // Applied first, then taken: the settle sees the row the tx will commit.
      expect(applyCommunityEdit.mock.invocationCallOrder[0]!).toBeLessThan(
        settleHeldDatesForEvent.mock.invocationCallOrder[0]!,
      );
      expect(result.notificationIntents).toEqual(OWED.intents);
      expect(result.staffRecipientHint).toEqual(OWED.staffRecipientHint);
    });

    it("a title-only edit never reaches the settle, and a listing with no calendar owes no intents", async () => {
      const withCalendar = buildDeps({
        event: publishedListing({ calendarId: CALENDAR_ID } as Partial<EventRecord>),
      });
      await updateCommunityListing(withCalendar.deps, input({ title: "Renamed" }));
      expect(settleHeldDatesForEvent).not.toHaveBeenCalled();

      const noCalendar = buildDeps({ event: publishedListing() });
      const result = await updateCommunityListing(
        noCalendar.deps,
        input({
          startsAt: new Date("2026-08-08T20:00:00.000Z"),
          endsAt: new Date("2026-08-08T23:00:00.000Z"),
        }),
      );
      // The real helper runs: no calendar → not a single holds read.
      expect(settleHeldDatesForEvent).toHaveBeenCalledTimes(1);
      expect(result).not.toHaveProperty("notificationIntents");
      expect(noCalendar.calendars.findById).not.toHaveBeenCalled();
    });

    it("a settle refusal (open challenge on the new line) rolls the whole save back — no audit row, no notice", async () => {
      const { deps, audit, eventChangeNoticesCreate } = buildDeps({
        event: publishedListing({ calendarId: CALENDAR_ID } as Partial<EventRecord>),
      });
      settleHeldDatesForEvent.mockRejectedValueOnce({
        code: "HOLD_LINE_HAS_OPEN_CHALLENGE",
        meta: {},
      });

      await expect(
        updateCommunityListing(
          deps,
          input({
            startsAt: new Date("2026-08-08T20:00:00.000Z"),
            endsAt: new Date("2026-08-08T23:00:00.000Z"),
          }),
        ),
      ).rejects.toMatchObject({ code: "HOLD_LINE_HAS_OPEN_CHALLENGE" });
      expect(audit.log).not.toHaveBeenCalled();
      expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    });

    it("a non-moderator is still refused on a live listing, and nothing is written", async () => {
      const { deps, applyCommunityEdit, audit, eventChangeNoticesCreate } =
        buildDeps({ event: publishedListing() });

      await expect(
        updateCommunityListing(deps, {
          ...input({ startsAt: new Date("2026-08-08T20:00:00.000Z") }),
          actorHumanId: USER_ID,
        }),
      ).rejects.toMatchObject({ code: "STAFF_ONLY" });
      expect(applyCommunityEdit).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(eventChangeNoticesCreate).not.toHaveBeenCalled();
    });

    it("the before/after row reads the body and hero from the PRE-edit row", async () => {
      const heroImage = makeImage({
        attached: true,
        publicUrl: "https://cdn.example/hero.jpg",
      });
      const { deps, audit, getContent, images } = buildDeps({
        event: publishedListing({ heroImageUrl: "https://cdn.example/hero.jpg" }),
        currentContent: { version: 1, sections: [] },
        eventImages: [heroImage],
        image: makeImage({ id: IMAGE_ID, attached: true }),
      });

      await updateCommunityListing(deps, input({ title: "Renamed" }));

      expect(getContent).toHaveBeenCalledWith({ eventId: EVENT_ID });
      expect(images.listByEventId).toHaveBeenCalledWith(EVENT_ID);
      // The whole pre-edit snapshot is available, so a later field's `before`
      // is real rather than null.
      expect(appliedAuditRow(audit)!.data.changes).toEqual({
        title: { before: "Weekly Open Mic", after: "Renamed" },
      });
    });
  });
});
