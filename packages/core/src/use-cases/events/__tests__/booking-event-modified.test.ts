import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { SavedLocationRecord } from "@th/ports/repos/saved-locations";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";

import { saveEventForOrg } from "../save-event-for-org";
import {
  BOOKING_TRACKED_EVENT_FIELDS,
  diffBookingTrackedEventFields,
} from "../_shared/booking-event-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING TIMELINE — `booking_event.modified` (step 2, the last hop).
//
// "…then we get to see the event get created or modified and it gets logged
// into that booking request." The event save path has no idea it is editing a
// booked show, so what these tests pin is: it finds the thread through the
// REVERSE lookup (there is no `Event.agreementId` column), it writes only when
// something a counterparty cares about actually moved, and it costs a normal
// event nothing.
// ─────────────────────────────────────────────────────────────────────────────

const AGREEMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A typed address, exactly as the event editor's autocomplete submits one. */
const FREEFORM_ADDRESS = {
  addressText: "1402 Bramble Ave, Nashville, TN 37206",
  lat: 36.18,
  lng: -86.73,
  locality: "Nashville",
  region: "TN",
  countryCode: "US",
  postalCode: "37206",
} as const;

/** The SavedLocation that address normalizes to (dedup by owner + address). */
const SAVED_LOCATION: SavedLocationRecord = {
  id: "sl-1",
  name: "1402 Bramble Ave, Nashville",
  address: FREEFORM_ADDRESS.addressText,
  countryCode: FREEFORM_ADDRESS.countryCode,
  region: FREEFORM_ADDRESS.region,
  locality: FREEFORM_ADDRESS.locality,
  postalCode: FREEFORM_ADDRESS.postalCode,
  lat: FREEFORM_ADDRESS.lat,
  lng: FREEFORM_ADDRESS.lng,
  ownerType: "ORGANIZATION",
  ownerId: DEFAULT_ORG_ID,
  usageCount: 3,
  admissionTaxRateBps: 975,
  taxRateFetchedAt: new Date("2024-01-01T00:00:00.000Z"),
  taxRateSource: "fake",
};

function makeExistingEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "DRAFT",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date("2024-02-01T18:00:00.000Z"),
    endsAt: new Date("2024-02-01T19:00:00.000Z"),
    placeId: DEFAULT_PLACE_ID,
    savedLocationId: null,
    spaceId: null,
    calendarId: null,
    categoryId: null,
    categorySeoType: null,
    addressText: null,
    countryCode: null,
    region: null,
    locality: null,
    postalCode: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    placeLayoutId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "CLOSED",
    ...overrides,
  } as EventRecord;
}

type Ctx = ReturnType<typeof makeCreateEventTestContext>;

/**
 * Point the save's repos at a BOOKED event: the reverse lookup resolves an
 * agreement, and the agreement resolves the booking request whose thread is
 * the ledger.
 */
function linkToBooking(ctx: Ctx, options: { linked?: boolean } = {}) {
  const linked = options.linked ?? true;
  const repos = ctx.deps.repos as unknown as Record<string, any>;
  repos.agreements.findByLinkedEventId = vi.fn(async () =>
    linked ? { id: AGREEMENT_ID, eventId: DEFAULT_EVENT_ID } : null,
  );
  repos.bookingRequests.findByAgreementId = vi.fn(async () =>
    linked ? { id: REQUEST_ID } : null,
  );
  return {
    findByLinkedEventId: repos.agreements
      .findByLinkedEventId as ReturnType<typeof vi.fn>,
    entries: () =>
      [...repos.bookingRequestMessages.rows.values()].filter(
        (row: { systemKind: string | null }) => row.systemKind,
      ),
  };
}

/**
 * The dedup hit a repeat freeform save takes in production: the address
 * already has a SavedLocation, so the save LINKS the existing one instead of
 * minting a new id (the fake's default is "no match", which would create one).
 */
function reuseSavedLocation(ctx: Ctx) {
  const repos = ctx.deps.repos as unknown as Record<string, any>;
  repos.savedLocations.findByOwnerAndAddress = vi.fn(async () => SAVED_LOCATION);
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    eventId: DEFAULT_EVENT_ID,
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    title: "Existing",
    startsAt: "2024-02-01T18:00:00.000Z",
    endsAt: "2024-02-01T19:00:00.000Z",
    location: { placeId: DEFAULT_PLACE_ID },
    timezone: "America/Chicago",
    clientKey: `key-${Math.random()}`,
    ...overrides,
  };
}

describe("booking_event.modified", () => {
  it("logs a reschedule with a before/after pair the copy can render", async () => {
    const ctx = makeCreateEventTestContext({
      existingEvent: makeExistingEvent(),
    });
    const ledger = linkToBooking(ctx);

    await saveEventForOrg(
      ctx.deps,
      makeInput({
        startsAt: "2024-02-02T19:00:00.000Z",
        endsAt: "2024-02-02T22:00:00.000Z",
      }),
    );

    const entries = ledger.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM",
      authorHumanId: DEFAULT_ACTOR_ID,
      systemKind: "booking_event.modified",
      systemData: {
        eventId: DEFAULT_EVENT_ID,
        changedFields: ["startsAt", "endsAt"],
        // "moved from Fri 8pm to Sat 9pm" is the one change rendered as a
        // before/after — ISO STRINGS, because systemData is a Json column.
        previousStartsAt: "2024-02-01T18:00:00.000Z",
        nextStartsAt: "2024-02-02T19:00:00.000Z",
      },
    });
  });

  it("logs a retitle WITHOUT a start pair", async () => {
    const ctx = makeCreateEventTestContext({
      existingEvent: makeExistingEvent(),
    });
    const ledger = linkToBooking(ctx);

    await saveEventForOrg(ctx.deps, makeInput({ title: "New Name" }));

    expect(ledger.entries()[0]).toMatchObject({
      systemData: {
        changedFields: ["title"],
        previousStartsAt: null,
        nextStartsAt: null,
      },
    });
  });

  it("a NO-OP save writes nothing — and does not even pay for the lookup", async () => {
    const ctx = makeCreateEventTestContext({
      existingEvent: makeExistingEvent(),
    });
    const ledger = linkToBooking(ctx);

    // Same title, same instants, same place as the stored row.
    await saveEventForOrg(ctx.deps, makeInput());

    // A ledger that logs "the event was modified" every time somebody opens
    // and closes the editor is noise, not history.
    expect(ledger.entries()).toEqual([]);
    // Diff FIRST, lookup second: the common no-op costs ZERO extra queries.
    expect(ledger.findByLinkedEventId).not.toHaveBeenCalled();
  });

  it("an event that never came from a booking writes nothing", async () => {
    const ctx = makeCreateEventTestContext({
      existingEvent: makeExistingEvent(),
    });
    const ledger = linkToBooking(ctx, { linked: false });

    await saveEventForOrg(ctx.deps, makeInput({ title: "New Name" }));

    expect(ledger.entries()).toEqual([]);
    // The common case costs exactly ONE reverse lookup call (1–2 unique-index
    // probes inside the adapter) and nothing else.
    expect(ledger.findByLinkedEventId).toHaveBeenCalledTimes(1);
  });

  // ── The freeform staleness trap ──────────────────────────────────────────
  // `upsertDraft`'s return value is what the diff sees, and it is NOT the row
  // as it ends up. On the UPDATE path the adapter resets `savedLocationId` to
  // null in its base `data` and only re-sets it for `kind: "saved-location"`;
  // for a FREEFORM address the link is applied afterwards by
  // `linkSavedLocation`, which never refreshes the returned record. The fake
  // reproduces both halves faithfully, which is what makes this unit-testable.
  //
  // Before the fix, an event minted from an agreement (always
  // `location: {placeId}`) and then re-addressed by the venue reported
  // "location changed" on the FIRST save (correctly) and on every save after
  // it (a lie), forever.
  it("re-saving the SAME freeform address writes nothing — the post-link id is what counts", async () => {
    const ctx = makeCreateEventTestContext({
      // The shape the previous save left behind: no place, and the
      // SavedLocation that save created/linked.
      existingEvent: makeExistingEvent({
        placeId: null,
        savedLocationId: SAVED_LOCATION.id,
        addressText: FREEFORM_ADDRESS.addressText,
      }),
    });
    const ledger = linkToBooking(ctx);
    reuseSavedLocation(ctx);

    await saveEventForOrg(
      ctx.deps,
      makeInput({ location: { ...FREEFORM_ADDRESS } }),
    );

    expect(ledger.entries()).toEqual([]);
    // Diff FIRST, lookup second — a no-op save must not even pay for the
    // reverse lookup.
    expect(ledger.findByLinkedEventId).not.toHaveBeenCalled();
  });

  it("still reports a REAL freeform move (a different address ⇒ a different SavedLocation)", async () => {
    const ctx = makeCreateEventTestContext({
      existingEvent: makeExistingEvent({
        placeId: null,
        savedLocationId: "sl-previous",
        addressText: "12 Old Street, Nashville, TN",
      }),
    });
    const ledger = linkToBooking(ctx);
    reuseSavedLocation(ctx);

    await saveEventForOrg(
      ctx.deps,
      makeInput({ location: { ...FREEFORM_ADDRESS } }),
    );

    expect(ledger.entries()[0]).toMatchObject({
      systemKind: "booking_event.modified",
      systemData: { changedFields: ["location"] },
    });
  });

  it("CREATING an event never looks up an agreement", async () => {
    const ctx = makeCreateEventTestContext({ existingEvent: null });
    const ledger = linkToBooking(ctx);

    await saveEventForOrg(
      ctx.deps,
      makeInput({ eventId: undefined, title: "Brand New" }),
    );

    // A brand-new event cannot be anchored to an agreement yet — the anchor is
    // stamped after the save, by createEventFromAgreement.
    expect(ledger.findByLinkedEventId).not.toHaveBeenCalled();
    expect(ledger.entries()).toEqual([]);
  });
});

describe("diffBookingTrackedEventFields", () => {
  it("tracks exactly the closed set the save path can actually change", () => {
    expect([...BOOKING_TRACKED_EVENT_FIELDS]).toEqual([
      "title",
      "startsAt",
      "endsAt",
      "location",
      "calendar",
      "space",
      "timezone",
    ]);
  });

  it("treats an ABSENT optional placement key as null, not as a change", () => {
    // `spaceId` / `calendarId` are optional on EventRecord ("absent reads as
    // null"), so a projection that omits them must not masquerade as a clear.
    const previous = makeExistingEvent({ spaceId: null, calendarId: null });
    const next = makeExistingEvent();
    delete (next as Record<string, unknown>).spaceId;
    delete (next as Record<string, unknown>).calendarId;

    expect(diffBookingTrackedEventFields(previous, next)).toEqual([]);
  });

  it("reports a venue move and a placement move separately", () => {
    const previous = makeExistingEvent({
      placeId: DEFAULT_PLACE_ID,
      spaceId: "space-1",
    });
    const next = makeExistingEvent({
      placeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      spaceId: "space-2",
    });

    expect(diffBookingTrackedEventFields(previous, next)).toEqual([
      "location",
      "space",
    ]);
  });

  it("does NOT track status — the save path re-persists it verbatim", () => {
    const previous = makeExistingEvent({ status: "DRAFT" });
    const next = makeExistingEvent({ status: "PUBLISHED" });

    // Publish / cancel / archive are their own use cases; putting `status` on
    // the ledger here would add a field nothing on this surface can ever set.
    expect(diffBookingTrackedEventFields(previous, next)).toEqual([]);
  });
});
