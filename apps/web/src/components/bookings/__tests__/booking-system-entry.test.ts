import { describe, expect, it } from "vitest";

import { createTranslator, type MessageCatalog } from "@th/locale";
import { BOOKING_SYSTEM_ENTRY_KINDS, type BookingSystemEntryKind } from "@th/types";

import enApp from "@/i18n/messages/en";
import esApp from "@/i18n/messages/es";
import {
  LEGACY_OWNER_SIDE,
  LEGACY_REQUEST_DIRECTION,
  LEGACY_SYSTEM_ENTRY_KINDS,
  LEGACY_THREAD_SIDE,
} from "@th/core/lib/legacy-place-values";
import { describeBookingSystemEntry } from "../booking-system-entry";

/**
 * The booking thread's LEDGER copy, pinned against the REAL catalogs.
 *
 * The gate this file exists for is the one the parity test cannot see. Catalog
 * parity checks that en and es agree; it does NOT check that a key a component
 * references actually exists — and a lookup miss in this app renders the RAW KEY
 * STRING on screen ("booking.entryAgreementDrafted" in a booking thread). A
 * namespace typo therefore ships silently and green. So the translator here is
 * built from `messages/en.ts` and `messages/es.ts` themselves, with
 * `onMissingMessage` collecting every miss, and the exhaustive loop below drives
 * all sixteen kinds through BOTH locales.
 *
 * The loop is keyed by `BOOKING_SYSTEM_ENTRY_KINDS` (the union's own source of
 * truth), and the fixture map is `Record<BookingSystemEntryKind, …>`, so a kind
 * added upstream without copy fails here as a type error AND as a missing key —
 * not as a blank line a reader discovers in production.
 */

function translatorFor(locale: "en" | "es") {
  const missing: string[] = [];
  const catalog = (locale === "en" ? enApp : esApp) as unknown as MessageCatalog;
  const translator = createTranslator(locale, catalog, {
    onMissingMessage: (key) => missing.push(key),
  });
  return { missing, t: translator.t };
}

/** Deterministic, so assertions pin copy rather than the host's date format. */
const formatDateTime = (value: Date) => value.toISOString();
/** LOCAL calendar day, so a hold's day can be asserted regardless of host zone. */
const formatDate = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;

function view(
  systemKind: string,
  systemData: Record<string, unknown> | null,
  locale: "en" | "es" = "en",
  viewerSide?: "VENUE" | "PERFORMER",
) {
  const { missing, t } = translatorFor(locale);
  const result = describeBookingSystemEntry({
    systemKind,
    systemData,
    t,
    formatDateTime,
    formatDate,
    locale,
    viewerSide,
  });
  return { result, missing };
}

const AGREEMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOLD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HUMAN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ISO = "2026-09-18T01:00:00.000Z";

/** One valid payload per kind — mirrors the core zod schemas exactly. */
const FIXTURES: Record<BookingSystemEntryKind, Record<string, unknown>> = {
  "booking_request.opened": { direction: "TO_PLACE", source: "PLATFORM" },
  "booking_request.viewed": {},
  "booking_request.expired": { expiresAt: ISO },
  "booking_request.withdrawn": {},
  "booking_request.accepted": { agreementId: AGREEMENT_ID },
  "booking_request.declined": { reason: "the room is booked that week" },
  "booking_agreement.drafted": { agreementId: AGREEMENT_ID },
  "booking_agreement.sent_for_review": {
    agreementId: AGREEMENT_ID,
    actorSide: "PLACE",
  },
  "booking_agreement.countered": {
    agreementId: AGREEMENT_ID,
    actorSide: "PERFORMER",
  },
  "booking_agreement.accepted": {
    agreementId: AGREEMENT_ID,
    actorSide: "PERFORMER",
  },
  "booking_agreement.declined": {
    agreementId: AGREEMENT_ID,
    actorSide: "PLACE",
    reason: "the fee doesn't work",
  },
  "booking_agreement.cancelled": {
    agreementId: AGREEMENT_ID,
    actorSide: "PLACE",
    reason: "the room is double-booked",
  },
  "booking_agreement.pulled_back": {
    agreementId: AGREEMENT_ID,
    actorSide: "PLACE",
  },
  "booking_agreement.reopened": {
    agreementId: AGREEMENT_ID,
    actorSide: "PLACE",
  },
  "booking_agreement.finalized": {
    agreementId: AGREEMENT_ID,
    eventId: EVENT_ID,
  },
  "booking_event.created": {
    eventId: EVENT_ID,
    agreementId: AGREEMENT_ID,
    startsAt: ISO,
  },
  "booking_event.modified": {
    eventId: EVENT_ID,
    changedFields: ["startsAt", "location"],
    previousStartsAt: ISO,
    nextStartsAt: "2026-09-19T01:00:00.000Z",
  },
  "booking_agreement.fulfilled": { agreementId: AGREEMENT_ID },
  "booking_event.published": { eventId: EVENT_ID, startsAt: ISO },
  "booking_event.cancelled": { eventId: EVENT_ID },
  "booking_event.completed": { eventId: EVENT_ID },
  // ── venue-confirmation spec 2026-08-27 (core step 2) ─────────────────────
  "booking_event.place_confirmed": { eventId: EVENT_ID, ownerSide: "requester" },
  "booking_event.place_confirmation_withdrawn": {
    eventId: EVENT_ID,
    reason: "the room is double-booked",
  },
  // ── booking-holds spec 2026-08-25 (core step 2) ─────────────────────────
  "booking_request.assigned": {
    assigneeHumanId: HUMAN_ID,
    previousAssigneeHumanId: null,
  },
  // ── venue-confirmation spec 2026-08-27 (unclaimed venue, no params) ─────
  "booking_request.parked_unclaimed": {},
  "booking_request.unparked": {},
  // ── P3a (unclaimed venues) ── the parked-request cleanup's one note.
  "booking_request.expired_unclaimed": { placeName: "The Unclaimed Stage" },
  // ── lineup-booking-requests v2 (FR-003) ─────────────────────────────────
  "booking_request.act_confirmed": { actId: HUMAN_ID, actName: "The Weeds" },
  "booking_request.act_declined": { actId: HUMAN_ID, actName: "The Weeds" },
  // ── lineup-booking-requests v3 (FR-009 / FR-010) — copy lands with the
  // bill UI step; until then both sit in NOT_YET_RENDERED below.
  "booking_request.bill_changed": {
    added: [{ actId: HUMAN_ID, name: "Maren Sky", source: "TAGGED", state: "invited" }],
    removed: [{ name: "Junco", wasState: "by_name" }],
    otherRemovedCount: 1,
    reordered: true,
    roleChanged: false,
  },
  "booking_request.act_joined_lineup": {
    actId: HUMAN_ID,
    eventId: EVENT_ID,
    actName: "The Weeds",
  },
  "booking_hold.placed": { holdId: HOLD_ID, date: "2026-10-13", position: 2 },
  "booking_hold.reordered": { holdId: HOLD_ID, from: 2, to: 1 },
  "booking_hold.challenged": { holdId: HOLD_ID, respondBy: ISO },
  "booking_hold.extended": { holdId: HOLD_ID, respondBy: ISO },
  "booking_hold.kept": { holdId: HOLD_ID },
  "booking_hold.released": { holdId: HOLD_ID, reason: "MANUAL" },
  "booking_hold.confirmed": { holdId: HOLD_ID, eventId: null },
  // ── booking-the-night (P2a: kinds + schemas only) ───────────────────────
  "booking_request.closed_by_place": { reason: "We went another way." },
  "booking_request.booking_cancelled": {
    by: "place",
    reason: "the room flooded",
  },
  // ── P3b (asks) ── kinds + schemas only; copy lands with the thread UI.
  "booking_request.ask_opened": { askId: HOLD_ID, kind: "IMAGE", label: "Poster" },
  "booking_request.ask_answered": {
    askId: HOLD_ID,
    kind: "IMAGE",
    label: "Poster",
    replaced: false,
  },
  "booking_request.ask_withdrawn": { askId: HOLD_ID, kind: "IMAGE", label: "Poster" },
  "booking_agreement.returned_to_draft": {
    agreementId: AGREEMENT_ID,
    reason: "the fee doesn't work",
  },
  // booking-the-night P2b: venue-only notice that the sender's agree was
  // refused (the night went elsewhere). Copy lands with the thread UI (P5).
  "booking_agreement.agree_refused": {
    agreementId: AGREEMENT_ID,
    date: "2026-10-13",
  },
  // booking-the-night P2c: venue-only notice that the agree booked the night
  // but its event was not created. Copy lands with the thread UI (P5).
  "booking_agreement.event_not_created": {
    agreementId: AGREEMENT_ID,
    date: "2026-10-13",
  },
  // ── booking-the-night P2d-2 ──
  // Venue-only: the ready request moved up to 1st hold ("Send terms"). Copy
  // lands with the thread UI (P5).
  "booking_hold.first_ready": {
    holdId: HOLD_ID,
    date: "2026-10-13",
    agreementId: AGREEMENT_ID,
  },
};

/**
 * Every kind the type union names now has a case. Kept as an (empty) set so
 * the loop below keeps its "not rendered yet" branch for the next deferred
 * kind — the NFR-003 contract ("unknown kinds still render nothing, never
 * crash") is pinned separately by the made-up-kind test.
 */
const NOT_YET_RENDERED = new Set<BookingSystemEntryKind>([
  // lineup v3 P1a landed the kinds + schemas only; the renderer cases and
  // their en/es copy come with the bill UI. Remove from here when they do.
  "booking_request.bill_changed",
  "booking_request.act_joined_lineup",
  // booking-the-night P2a landed the kinds + schemas only; their copy comes
  // with the thread UI step. Remove from here when it does.
  "booking_request.closed_by_place",
  "booking_request.booking_cancelled",
  "booking_agreement.returned_to_draft",
  // booking-the-night P2b: kind + schema only; copy with the thread UI (P5).
  "booking_agreement.agree_refused",
  // booking-the-night P2c: kind + schema only; copy with the thread UI (P5).
  "booking_agreement.event_not_created",
  // ── booking-the-night P2d-2 ── kind + schema only; copy with the thread UI (P5).
  "booking_hold.first_ready",
  // ── P3b (asks) ── kind + schema only; copy with the thread UI.
  "booking_request.ask_opened",
  "booking_request.ask_answered",
  "booking_request.ask_withdrawn",
]);

describe("describeBookingSystemEntry — catalog coverage", () => {
  for (const locale of ["en", "es"] as const) {
    it(`renders every kind from real ${locale} copy, with no missing key`, () => {
      for (const kind of BOOKING_SYSTEM_ENTRY_KINDS) {
        const { result, missing } = view(kind, FIXTURES[kind], locale);
        if (NOT_YET_RENDERED.has(kind)) {
          // Unknown-kind path: renders nothing, never throws (NFR-003).
          expect(result, `${kind} is not rendered yet — expected null`).toBeNull();
          expect(missing).toEqual([]);
          continue;
        }
        expect(result, `${kind} produced no view`).not.toBeNull();
        expect(
          missing,
          `${kind} referenced ${locale} key(s) that do not exist — these render as the RAW KEY on screen`,
        ).toEqual([]);
        // A raw key would still be a non-empty string, so assert on its shape.
        expect(result!.text).not.toMatch(/^booking\./);
        expect(result!.text.length).toBeGreaterThan(0);
      }
    });
  }

  // The act reads the SAME ledger through `viewerSide: "PERFORMER"`. Every
  // hold kind swaps to an `…Act` key there, so the act side needs the same
  // no-missing-key sweep in both locales — a miss renders the raw key.
  for (const locale of ["en", "es"] as const) {
    it(`renders every kind from the ACT's side in ${locale}, with no missing key`, () => {
      for (const kind of BOOKING_SYSTEM_ENTRY_KINDS) {
        const { result, missing } = view(kind, FIXTURES[kind], locale, "PERFORMER");
        if (NOT_YET_RENDERED.has(kind)) continue;
        expect(result, `${kind} produced no view for the act`).not.toBeNull();
        expect(missing, `${kind} (act side, ${locale}) referenced missing key(s)`).toEqual([]);
        expect(result!.text).not.toMatch(/^booking\./);
      }
    });
  }

  it("covers every kind in the fixture map (guards a vacuous loop)", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(
      [...BOOKING_SYSTEM_ENTRY_KINDS].sort(),
    );
  });
});

describe("describeBookingSystemEntry — per-kind copy", () => {
  /**
   * DEGRADE, DON'T GUESS. `direction` is the whole content of this sentence —
   * WHO the request went to — so an unreadable one must drop the party, not
   * default to one. The first cut tested `direction !== "TO_PERFORMER"`, which
   * made a null/corrupt `systemData` render "Request sent to the place": an
   * assertion the row never made, on the one entry that opens every ledger.
   * `source` is not symmetric with it — it only says HOW the request arrived,
   * so falling back to the plain wording stays true either way.
   */
  it("drops the party from `opened` when direction is missing or corrupt", () => {
    for (const data of [
      null,
      {},
      { source: "PLATFORM" },
      { direction: "SIDEWAYS", source: "PLATFORM" },
      { direction: 42, source: "EMBED" },
    ] as (Record<string, unknown> | null)[]) {
      const { result, missing } = view("booking_request.opened", data);
      expect(result!.text, JSON.stringify(data)).toBe("Request sent");
      expect(missing).toEqual([]);
      // Never the venue's line by default — that is the guess this pins out.
      expect(result!.text).not.toMatch(/venue|performer/i);
    }
    // …and the es fallback is real copy, not a raw key.
    expect(view("booking_request.opened", null, "es").result!.text).toBe(
      "Solicitud enviada",
    );
  });

  it("branches `opened` on direction and source", () => {
    expect(
      view("booking_request.opened", {
        direction: "TO_PLACE",
        source: "PLATFORM",
      }).result!.text,
    ).toBe("Request sent to the place");
    expect(
      view("booking_request.opened", {
        direction: "TO_PLACE",
        source: "EMBED",
      }).result!.text,
    ).toBe("Request sent through the place's booking form");
    expect(
      view("booking_request.opened", {
        direction: "TO_PERFORMER",
        source: "PLATFORM",
      }).result!.text,
    ).toBe("Offer sent to the performer");
    expect(
      view("booking_request.opened", {
        direction: "TO_PERFORMER",
        source: "EMBED",
      }).result!.text,
    ).toBe("Offer sent through a booking form");
  });

  it("puts the expiry deadline in the sentence, and drops it when unparseable", () => {
    expect(
      view("booking_request.expired", { expiresAt: ISO }).result!.text,
    ).toBe(`Request expired — the reply deadline was ${ISO}`);
    expect(
      view("booking_request.expired", { expiresAt: "not-a-date" }).result!.text,
    ).toBe("Request expired");
    expect(view("booking_request.expired", {}).result!.text).toBe(
      "Request expired",
    );
  });

  it("carries a decline reason on the detail line, not the sentence", () => {
    const declined = view("booking_request.declined", {
      reason: "the room is booked",
    }).result!;
    expect(declined.text).toBe("Request declined");
    expect(declined.detail).toBe("Reason: the room is booked");
    expect(view("booking_request.declined", { reason: null }).result!.detail).toBeNull();
  });

  it("labels the acting SIDE, and omits the label when the row does not say", () => {
    expect(
      view("booking_agreement.sent_for_review", {
        agreementId: AGREEMENT_ID,
        actorSide: "PLACE",
      }).result!.actorLabel,
    ).toBe("by the place");
    expect(
      view("booking_agreement.reopened", {
        agreementId: AGREEMENT_ID,
        actorSide: "PERFORMER",
      }).result!.actorLabel,
    ).toBe("by the performer");
    // No name is ever needed — `authorHumanId` is an id and the list projects
    // no display name, so an unattributable row simply drops the label.
    expect(
      view("booking_agreement.reopened", { agreementId: AGREEMENT_ID }).result!
        .actorLabel,
    ).toBeNull();
    expect(
      view("booking_agreement.reopened", {
        agreementId: AGREEMENT_ID,
        actorSide: "MARTIAN",
      }).result!.actorLabel,
    ).toBeNull();
  });

  it("links the agreement on agreement entries and the EVENT on event entries", () => {
    const accepted = view("booking_request.accepted", {
      agreementId: AGREEMENT_ID,
    }).result!;
    expect(accepted.agreementId).toBe(AGREEMENT_ID);
    expect(accepted.eventId).toBeNull();

    // `booking_event.created` carries BOTH ids; one link per line, and the
    // agreement is already linked from the entries above it.
    const created = view("booking_event.created", {
      eventId: EVENT_ID,
      agreementId: AGREEMENT_ID,
      startsAt: ISO,
    }).result!;
    expect(created.eventId).toBe(EVENT_ID);
    expect(created.agreementId).toBeNull();
    expect(created.text).toBe(`Event created for ${ISO}`);
  });

  it("names the changed fields, drops unknown ones, and shows the reschedule", () => {
    const moved = view("booking_event.modified", {
      eventId: EVENT_ID,
      changedFields: ["startsAt", "location", "somethingNewer"],
      previousStartsAt: ISO,
      nextStartsAt: "2026-09-19T01:00:00.000Z",
    }).result!;
    // A column name is not copy: an unknown field is dropped, never printed.
    expect(moved.text).toBe("Event updated — start time and location");
    expect(moved.detail).toBe(
      `Moved from ${ISO} to 2026-09-19T01:00:00.000Z`,
    );

    const generic = view("booking_event.modified", {
      eventId: EVENT_ID,
      changedFields: ["somethingNewer"],
      previousStartsAt: null,
      nextStartsAt: null,
    }).result!;
    expect(generic.text).toBe("Event updated");
    expect(generic.detail).toBeNull();
  });

  it("renders the event lifecycle — published (with and without a date), cancelled, completed", () => {
    const published = view("booking_event.published", {
      eventId: EVENT_ID,
      startsAt: ISO,
    }).result!;
    expect(published.text).toBe(`Event published for ${ISO}`);
    expect(published.icon).toBe("calendarCheck");
    expect(published.eventId).toBe(EVENT_ID);
    expect(published.agreementId).toBeNull();
    // A start-less or corrupt snapshot drops to the date-free line.
    expect(
      view("booking_event.published", { eventId: EVENT_ID, startsAt: null })
        .result!.text,
    ).toBe("Event published");
    expect(
      view("booking_event.published", { eventId: EVENT_ID, startsAt: "nope" })
        .result!.text,
    ).toBe("Event published");

    const cancelled = view("booking_event.cancelled", { eventId: EVENT_ID })
      .result!;
    expect(cancelled.text).toBe("Event cancelled");
    expect(cancelled.icon).toBe("calendarX");
    expect(cancelled.eventId).toBe(EVENT_ID);
    expect(cancelled.detail).toBeNull();

    const completed = view("booking_event.completed", { eventId: EVENT_ID })
      .result!;
    expect(completed.text).toBe("Event completed");
    expect(completed.icon).toBe("circleCheck");
    expect(completed.eventId).toBe(EVENT_ID);
  });

  it("cancelled: the editor's walk-away carries the reason and the side", () => {
    const cancelled = view("booking_agreement.cancelled", {
      agreementId: AGREEMENT_ID,
      actorSide: "PLACE",
      reason: "the room is double-booked",
    }).result!;
    expect(cancelled.text).toBe("Agreement cancelled");
    expect(cancelled.icon).toBe("fileX");
    expect(cancelled.detail).toBe("Reason: the room is double-booked");
    expect(cancelled.actorLabel).toBe("by the place");
    expect(cancelled.agreementId).toBe(AGREEMENT_ID);
    expect(cancelled.eventId).toBeNull();
    // The schema requires a reason, but a row from a newer writer might not
    // carry one — degrade to no detail line, never "Reason: undefined".
    expect(
      view("booking_agreement.cancelled", {
        agreementId: AGREEMENT_ID,
        actorSide: "PLACE",
      }).result!.detail,
    ).toBeNull();
    expect(
      view(
        "booking_agreement.cancelled",
        { agreementId: AGREEMENT_ID, actorSide: "PLACE", reason: "x" },
        "es",
      ).result!.text,
    ).toBe("Acuerdo cancelado");
  });

  it("links the AGREEMENT on fulfilled, with no side label", () => {
    const fulfilled = view("booking_agreement.fulfilled", {
      agreementId: AGREEMENT_ID,
    }).result!;
    expect(fulfilled.text).toBe("Agreement fulfilled — the show happened");
    expect(fulfilled.icon).toBe("fileCheck");
    expect(fulfilled.agreementId).toBe(AGREEMENT_ID);
    expect(fulfilled.eventId).toBeNull();
    // Completing the event is an organizer action, not a negotiation move —
    // the row carries no actorSide and the copy names none.
    expect(fulfilled.actorLabel).toBeNull();
  });

  it("translates rather than copying English", () => {
    expect(view("booking_request.accepted", {}, "es").result!.text).toBe(
      "Solicitud aceptada",
    );
    expect(
      view(
        "booking_event.modified",
        { eventId: EVENT_ID, changedFields: ["title", "space"] },
        "es",
      ).result!.text,
    ).toBe("Evento actualizado — título y espacio");
    expect(
      view("booking_event.cancelled", { eventId: EVENT_ID }, "es").result!.text,
    ).toBe("Evento cancelado");
    expect(
      view("booking_agreement.fulfilled", { agreementId: AGREEMENT_ID }, "es")
        .result!.text,
    ).toBe("Acuerdo cumplido — el evento se realizó");
  });

  it("names the act on confirm / decline, and renders nothing without a name", () => {
    const ACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    expect(
      view("booking_request.act_confirmed", { actId: ACT_ID, actName: "The Weeds" })
        .result!.text,
    ).toBe("The Weeds confirmed their spot on the bill");
    expect(
      view("booking_request.act_declined", { actId: ACT_ID, actName: "The Weeds" }, "es")
        .result!.text,
    ).toBe("The Weeds rechazó su lugar en el cartel");
    // No honest subject → no sentence (never "undefined confirmed…").
    for (const kind of [
      "booking_request.act_confirmed",
      "booking_request.act_declined",
    ]) {
      expect(view(kind, { actId: ACT_ID }).result, kind).toBeNull();
      expect(view(kind, { actId: ACT_ID, actName: "" }).result, kind).toBeNull();
      expect(view(kind, { actId: ACT_ID, actName: 42 }).result, kind).toBeNull();
      expect(view(kind, null).result, kind).toBeNull();
    }
  });
});

describe("describeBookingSystemEntry — forward compatibility", () => {
  /**
   * `systemData` is NOT re-validated on read (the port doc says so), and both
   * ids are interpolated into a URL PATH by the renderer
   * (`/admin/{slug}/events/{id}`, `/agreements/{id}`) — the sink the house
   * `safeHref` rule exists for. `safeHref` alone would not catch it either: the
   * path already starts with `/admin/`, so a traversal segment sails through
   * its scheme check. The shape guard is the fix, and an id that fails it is
   * dropped, so the entry renders with NO link rather than a bogus one.
   */
  it("drops an id that is not uuid-shaped, so no href can be built from it", () => {
    for (const hostile of [
      "../../platform/settings",
      "not-a-uuid",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/../../platform",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb?x=1",
      "javascript:alert(1)",
      "",
    ]) {
      const created = view("booking_event.created", {
        eventId: hostile,
        agreementId: hostile,
        startsAt: ISO,
      }).result!;
      expect(created.eventId, hostile).toBeNull();
      expect(created.agreementId, hostile).toBeNull();
      // The line itself still renders — a bad id costs the link, not the entry.
      expect(created.text).toBe(`Event created for ${ISO}`);
    }

    // The real thing still passes, in both id slots.
    const ok = view("booking_agreement.finalized", {
      agreementId: AGREEMENT_ID,
      eventId: EVENT_ID,
    }).result!;
    expect(ok.agreementId).toBe(AGREEMENT_ID);
    expect(
      view("booking_event.modified", {
        eventId: EVENT_ID,
        changedFields: ["title"],
      }).result!.eventId,
    ).toBe(EVENT_ID);
  });

  it("returns null for a kind this build does not know", () => {
    expect(view("booking_hold.something_new", { holdId: "x" }).result).toBeNull();
    expect(view("totally.made.up", null).result).toBeNull();
  });

  it("returns null for a row with no kind at all", () => {
    expect(view("", null).result).toBeNull();
    const { result } = view("booking_request.viewed", {});
    expect(result).not.toBeNull();
  });

  it("survives params of the wrong SHAPE without throwing", () => {
    expect(() =>
      describeBookingSystemEntry({
        systemKind: "booking_event.modified",
        // Every field the wrong type — a corrupt row must degrade, not crash.
        systemData: {
          eventId: 42,
          changedFields: "startsAt",
          previousStartsAt: {},
          nextStartsAt: [],
        } as unknown as Record<string, unknown>,
        t: translatorFor("en").t,
        formatDateTime,
        locale: "en",
      }),
    ).not.toThrow();
    const degraded = view("booking_event.modified", {
      eventId: 42,
      changedFields: "startsAt",
    } as unknown as Record<string, unknown>).result!;
    expect(degraded.text).toBe("Event updated");
    expect(degraded.eventId).toBeNull();
  });
});

describe("describeBookingSystemEntry — holds and assignment (booking-holds FR-012 / FR-015)", () => {
  it("placed: names the day and the ordinal, and degrades field by field", () => {
    const full = view("booking_hold.placed", FIXTURES["booking_hold.placed"]);
    expect(full.result?.icon).toBe("hold");
    expect(full.result?.text).toMatch(/2nd/);
    expect(full.result?.text).toMatch(/2026-10-13/);
    expect(full.missing).toEqual([]);

    const noPosition = view("booking_hold.placed", { holdId: HOLD_ID, date: "2026-10-13" });
    expect(noPosition.result?.text).toMatch(/2026-10-13/);
    expect(noPosition.result?.text).not.toMatch(/undefined/);

    const nothing = view("booking_hold.placed", { holdId: HOLD_ID, date: "not a day" });
    expect(nothing.result?.text.length).toBeGreaterThan(0);
    expect(nothing.missing).toEqual([]);
  });

  it("placed: a calendar day is parsed as a LOCAL day, never UTC midnight", () => {
    // Formatted through the LOCAL-day formatter: a UTC-midnight parse would
    // print Oct 12 anywhere west of Greenwich.
    const { result } = view("booking_hold.placed", {
      holdId: HOLD_ID,
      date: "2026-10-13",
      position: 1,
    });
    expect(result?.text).toMatch(/2026-10-13/);
  });

  it("reordered: from → to as ordinals; generic when a position is unreadable", () => {
    expect(view("booking_hold.reordered", { holdId: HOLD_ID, from: 2, to: 1 }).result?.text)
      .toMatch(/2nd.*1st/);
    expect(view("booking_hold.reordered", { holdId: HOLD_ID, from: "x", to: 1 }).result?.text)
      .not.toMatch(/undefined/);
  });

  it("challenged / extended: carry the deadline, and survive a missing one", () => {
    expect(view("booking_hold.challenged", { holdId: HOLD_ID, respondBy: ISO }).result?.icon)
      .toBe("holdClock");
    expect(view("booking_hold.challenged", { holdId: HOLD_ID }).missing).toEqual([]);
    expect(view("booking_hold.extended", { holdId: HOLD_ID }).result?.text.length)
      .toBeGreaterThan(0);
  });

  it("released: the reason is an enum word rendered from the catalog, never printed raw", () => {
    const manual = view("booking_hold.released", { holdId: HOLD_ID, reason: "MANUAL" });
    expect(manual.result?.icon).toBe("holdX");
    expect(manual.result?.detail).not.toMatch(/MANUAL/);
    expect(manual.result?.detail).not.toMatch(/^Reason:/);
    expect(manual.missing).toEqual([]);
    // Unknown reason → no detail line at all.
    expect(
      view("booking_hold.released", { holdId: HOLD_ID, reason: "SOMETHING_NEW" }).result?.detail,
    ).toBeNull();
  });

  it("confirmed: links the event when the id is present, none when null", () => {
    expect(view("booking_hold.confirmed", { holdId: HOLD_ID, eventId: null }).result?.eventId)
      .toBeNull();
    expect(view("booking_hold.confirmed", { holdId: HOLD_ID, eventId: EVENT_ID }).result?.eventId)
      .toBe(EVENT_ID);
  });

  /**
   * FR-013: the act reads its OWN place, in its own voice. The venue's
   * "Hold placed for Oct 13 — 2nd in line" is a line it keeps; the act's
   * "You're 2nd in line for Oct 13" is a place it holds. Same row, same
   * params, and the venue wording must not move when the act's is added.
   */
  it("hold entries read in the act's voice from the PERFORMER side, and the venue's otherwise", () => {
    const placedAct = view("booking_hold.placed", FIXTURES["booking_hold.placed"], "en", "PERFORMER");
    expect(placedAct.result?.text).toBe("You're 2nd in line for 2026-10-13");
    expect(placedAct.missing).toEqual([]);
    expect(view("booking_hold.placed", FIXTURES["booking_hold.placed"], "en", "VENUE").result?.text)
      .toBe("Hold placed for 2026-10-13 — 2nd in line");
    // No side at all → the venue wording (every pre-FR-013 caller).
    expect(view("booking_hold.placed", FIXTURES["booking_hold.placed"]).result?.text)
      .toBe("Hold placed for 2026-10-13 — 2nd in line");

    expect(view("booking_hold.challenged", { holdId: HOLD_ID, respondBy: ISO }, "en", "PERFORMER").result?.text)
      .toBe(`The place asked you to keep or release your hold by ${ISO}`);
    expect(view("booking_hold.kept", { holdId: HOLD_ID }, "en", "PERFORMER").result?.text)
      .toBe("You kept your hold");
    expect(view("booking_hold.confirmed", { holdId: HOLD_ID, eventId: null }, "en", "PERFORMER").result?.text)
      .toBe("Your hold was confirmed — the place is creating the event");
    expect(view("booking_hold.reordered", { holdId: HOLD_ID, from: 2, to: 1 }, "en", "PERFORMER").result?.text)
      .toBe("Your spot in line moved from 2nd to 1st");
    // es is real copy on the act side too.
    expect(view("booking_hold.kept", { holdId: HOLD_ID }, "es", "PERFORMER").result?.text)
      .toBe("Mantuviste tu reserva");
  });

  /**
   * `reason: "MANUAL"` is written for a staff release AND for the act's own
   * release, and the row carries no side — so "Released by the place" is a
   * guess on the act's side. The act gets no detail for MANUAL and the real
   * cause for everything else; the venue side is unchanged.
   */
  it("released: drops the ambiguous MANUAL attribution on the act's side only", () => {
    expect(view("booking_hold.released", { holdId: HOLD_ID, reason: "MANUAL" }, "en", "PERFORMER").result?.detail)
      .toBeNull();
    expect(view("booking_hold.released", { holdId: HOLD_ID, reason: "MANUAL" }, "en", "VENUE").result?.detail)
      .toBe("Released by the place");
    expect(view("booking_hold.released", { holdId: HOLD_ID, reason: "EXPIRED" }, "en", "PERFORMER").result?.detail)
      .toBe("The challenge deadline passed");
    expect(view("booking_hold.released", { holdId: HOLD_ID, reason: "CONFIRMED_OTHER" }, "en", "PERFORMER").result?.text)
      .toBe("Your hold was released");
  });

  /**
   * FR-018: a published event took the date. The venue's ledger line is
   * terse; the act gets its own sentence — the venue scheduled an event, and
   * the request survives — on both locales.
   */
  it("released: EVENT_SCHEDULED reads sided, with the act's own sentence", () => {
    const row = { holdId: HOLD_ID, reason: "EVENT_SCHEDULED" };
    expect(view("booking_hold.released", row, "en", "VENUE").result?.text).toBe("Hold released");
    expect(view("booking_hold.released", row, "en", "VENUE").result?.detail)
      .toBe("An event was scheduled on that date");
    expect(view("booking_hold.released", row, "en", "PERFORMER").result?.text).toBe("Your hold was released");
    expect(view("booking_hold.released", row, "en", "PERFORMER").result?.detail)
      .toBe("The place scheduled an event on that date, so your hold was released — your request is still open");
    expect(view("booking_hold.released", row, "es", "PERFORMER").result?.detail)
      .toBe("El lugar programó un evento en esa fecha, así que tu reserva se liberó; tu solicitud sigue abierta");
  });

  /**
   * Newer `booking_hold.released` rows carry `by: "act" | "staff"` for a
   * MANUAL release, so both sides can name the author truthfully. Rows
   * without it (expiry, closure, confirm-driven, and every pre-`by` row)
   * keep the neutral wording above.
   */
  it("released: names the author on both sides when `by` is present, and stays neutral without it", () => {
    const byAct = { holdId: HOLD_ID, reason: "MANUAL", by: "act" };
    const byStaff = { holdId: HOLD_ID, reason: "MANUAL", by: "staff" };
    const noBy = { holdId: HOLD_ID, reason: "MANUAL" };

    // Venue side: the headline is unchanged, the detail names the author.
    expect(view("booking_hold.released", byAct, "en", "VENUE").result?.text).toBe("Hold released");
    expect(view("booking_hold.released", byAct, "en", "VENUE").result?.detail).toBe("Released by the act");
    expect(view("booking_hold.released", byStaff, "en", "VENUE").result?.detail).toBe("Released by the place");
    expect(view("booking_hold.released", noBy, "en", "VENUE").result?.detail).toBe("Released by the place");

    // Act side: the headline carries the author, no detail for MANUAL.
    expect(view("booking_hold.released", byAct, "en", "PERFORMER").result?.text).toBe("You released your hold");
    expect(view("booking_hold.released", byAct, "en", "PERFORMER").result?.detail).toBeNull();
    expect(view("booking_hold.released", byStaff, "en", "PERFORMER").result?.text).toBe("The place released your hold");
    expect(view("booking_hold.released", byStaff, "en", "PERFORMER").result?.detail).toBeNull();
    expect(view("booking_hold.released", noBy, "en", "PERFORMER").result?.text).toBe("Your hold was released");

    // Both locales resolve every new key.
    for (const locale of ["en", "es"] as const) {
      for (const side of ["VENUE", "PERFORMER"] as const) {
        expect(view("booking_hold.released", byAct, locale, side).missing).toEqual([]);
        expect(view("booking_hold.released", byStaff, locale, side).missing).toEqual([]);
      }
    }
    expect(view("booking_hold.released", byAct, "es", "PERFORMER").result?.text).toBe("Liberaste tu reserva");

    // A junk `by` is dropped, never printed.
    const junk = view("booking_hold.released", { holdId: HOLD_ID, reason: "MANUAL", by: "robot" }, "en", "PERFORMER");
    expect(junk.result?.text).toBe("Your hold was released");
    expect(junk.result?.text).not.toMatch(/robot/);
  });

  it("assigned: says assigned vs unassigned and names nobody", () => {
    const assigned = view("booking_request.assigned", {
      assigneeHumanId: HUMAN_ID,
      previousAssigneeHumanId: null,
    });
    expect(assigned.result?.icon).toBe("assigned");
    expect(assigned.result?.text).not.toMatch(HUMAN_ID);
    const cleared = view("booking_request.assigned", {
      assigneeHumanId: null,
      previousAssigneeHumanId: HUMAN_ID,
    });
    expect(cleared.result?.text).not.toBe(assigned.result?.text);
  });
});

describe("describeBookingSystemEntry — venue confirmation (docs/specs/2026-08-27)", () => {
  it("renders the confirmation linking the EVENT, the same sentence for either ownerSide", () => {
    const requester = view("booking_event.place_confirmed", { eventId: EVENT_ID, ownerSide: "requester" }).result!;
    expect(requester.text).toBe("Place confirmed the event");
    expect(requester.icon).toBe("calendarCheck");
    expect(requester.eventId).toBe(EVENT_ID);
    expect(requester.agreementId).toBeNull();
    expect(requester.detail).toBeNull();
    const placeOwned = view("booking_event.place_confirmed", { eventId: EVENT_ID, ownerSide: "place" }).result!;
    expect(placeOwned.text).toBe(requester.text);
    // The act reads the same line.
    expect(view("booking_event.place_confirmed", { eventId: EVENT_ID, ownerSide: "requester" }, "en", "PERFORMER").result!.text).toBe(
      requester.text,
    );
  });

  it("renders the withdrawal with the venue's reason as the detail line, and without one when the row has none", () => {
    const withReason = view("booking_event.place_confirmation_withdrawn", {
      eventId: EVENT_ID,
      reason: "the room is double-booked",
    }).result!;
    expect(withReason.text).toBe("Place withdrew its confirmation");
    expect(withReason.icon).toBe("calendarX");
    expect(withReason.eventId).toBe(EVENT_ID);
    expect(withReason.detail).toBe("Reason: the room is double-booked");
    const bare = view("booking_event.place_confirmation_withdrawn", { eventId: EVENT_ID, reason: null }).result!;
    expect(bare.detail).toBeNull();
  });

  it("es copy exists for both", () => {
    expect(view("booking_event.place_confirmed", { eventId: EVENT_ID, ownerSide: "place" }, "es").result!.text).toBe(
      "El lugar confirm\u00f3 el evento",
    );
    expect(
      view("booking_event.place_confirmation_withdrawn", { eventId: EVENT_ID, reason: "x" }, "es").result!.text,
    ).toBe("El lugar retir\u00f3 su confirmaci\u00f3n");
  });
});

describe("describeBookingSystemEntry — rows in the pre-2026-10-18 spelling", () => {
  // An API build from before the place rename (for the length of a deploy)
  // sends ledger rows in their stored spelling. Every one must render
  // exactly as its new-spelling twin. The old spellings come from core's
  // `lib/legacy-place-values`, the one place they are written down.
  const pairs: Array<{
    name: string;
    old: [string, Record<string, unknown>];
    current: [BookingSystemEntryKind, Record<string, unknown>];
  }> = [
    {
      name: "the place confirmed the event",
      old: [LEGACY_SYSTEM_ENTRY_KINDS["booking_event.place_confirmed"], { eventId: EVENT_ID, ownerSide: LEGACY_OWNER_SIDE }],
      current: ["booking_event.place_confirmed", { eventId: EVENT_ID, ownerSide: "place" }],
    },
    {
      name: "the place withdrew its confirmation",
      old: [LEGACY_SYSTEM_ENTRY_KINDS["booking_event.place_confirmation_withdrawn"], { eventId: EVENT_ID, reason: "x" }],
      current: ["booking_event.place_confirmation_withdrawn", { eventId: EVENT_ID, reason: "x" }],
    },
    {
      name: "a request sent to a place",
      old: ["booking_request.opened", { direction: LEGACY_REQUEST_DIRECTION, source: "EMBED" }],
      current: ["booking_request.opened", { direction: "TO_PLACE", source: "EMBED" }],
    },
    {
      name: "terms countered by the place",
      old: ["booking_agreement.countered", { agreementId: AGREEMENT_ID, actorSide: LEGACY_THREAD_SIDE }],
      current: ["booking_agreement.countered", { agreementId: AGREEMENT_ID, actorSide: "PLACE" }],
    },
  ];

  for (const pair of pairs) {
    for (const locale of ["en", "es"] as const) {
      for (const viewerSide of ["VENUE", "PERFORMER"] as const) {
        it(`${locale}/${viewerSide}: ${pair.name}`, () => {
          const old = view(pair.old[0], pair.old[1], locale, viewerSide);
          const current = view(pair.current[0], pair.current[1], locale, viewerSide);
          expect(current.result).not.toBeNull();
          expect(old.missing).toEqual([]);
          expect(old.result).toEqual(current.result);
        });
      }
    }
  }

  it("the actor label still names the place on an old row", () => {
    const old = view("booking_agreement.countered", { agreementId: AGREEMENT_ID, actorSide: LEGACY_THREAD_SIDE }).result!;
    expect(old.actorLabel).not.toBeNull();
    expect(old.actorLabel).toBe(
      view("booking_agreement.countered", { agreementId: AGREEMENT_ID, actorSide: "PLACE" }).result!.actorLabel,
    );
  });

  it("the old closed-request and cancelled-booking kinds stay as unrendered as their new twins", () => {
    // Neither has copy yet (NOT_YET_RENDERED); the old spelling must not
    // start rendering something the new one does not.
    expect(view(LEGACY_SYSTEM_ENTRY_KINDS["booking_request.closed_by_place"], { reason: "r" }).result).toEqual(
      view("booking_request.closed_by_place", { reason: "r" }).result,
    );
    expect(view("booking_request.booking_cancelled", { by: LEGACY_OWNER_SIDE, reason: "r" }).result).toEqual(
      view("booking_request.booking_cancelled", { by: "place", reason: "r" }).result,
    );
  });
});

describe("describeBookingSystemEntry — booking-the-night params on existing kinds", () => {
  it("a hold released with BOOKING_CANCELLED renders, without printing the enum word", () => {
    for (const viewerSide of ["VENUE", "PERFORMER"] as const) {
      const { result, missing } = view(
        "booking_hold.released",
        { holdId: HOLD_ID, reason: "BOOKING_CANCELLED" },
        "en",
        viewerSide,
      );
      expect(result, viewerSide).not.toBeNull();
      expect(missing).toEqual([]);
      // No copy for the new reason yet (it lands with the cancel UI): the
      // detail line is DROPPED, never "BOOKING_CANCELLED".
      expect(result!.detail).toBeNull();
      expect(result!.text).not.toMatch(/BOOKING_CANCELLED/);
    }
  });

  it("a confirmed-hold entry with withoutTerms renders like any confirmed hold", () => {
    const plain = view("booking_hold.confirmed", { holdId: HOLD_ID, eventId: null });
    const withoutTerms = view("booking_hold.confirmed", {
      holdId: HOLD_ID,
      eventId: null,
      withoutTerms: true,
    });
    expect(withoutTerms.missing).toEqual([]);
    expect(withoutTerms.result).toEqual(plain.result);
  });
});

// ── P3a (unclaimed venues) ──
describe("describeBookingSystemEntry — unclaimed venues (amendment 2026-09-25)", () => {
  it("expired_unclaimed names the place from its snapshot, in both locales", () => {
    expect(
      view("booking_request.expired_unclaimed", { placeName: "The Unclaimed Stage" })
        .result!.text,
    ).toBe(
      "The Unclaimed Stage isn't on Ithas Fire yet, so this request can't reach them.",
    );
    expect(
      view(
        "booking_request.expired_unclaimed",
        { placeName: "The Unclaimed Stage" },
        "es",
      ).result!.text,
    ).toBe(
      "The Unclaimed Stage aún no está en Ithas Fire, así que esta solicitud no puede llegarle.",
    );
  });

  it("expired_unclaimed says \"This place\" when the snapshot is missing", () => {
    for (const data of [{ placeName: null }, { placeName: "" }, null]) {
      const { result, missing } = view("booking_request.expired_unclaimed", data);
      expect(missing).toEqual([]);
      expect(result!.text).toBe(
        "This place isn't on Ithas Fire yet, so this request can't reach them.",
      );
    }
  });

  it("old parked / unparked rows still render (retired kinds stay readable)", () => {
    for (const side of ["VENUE", "PERFORMER"] as const) {
      expect(
        view("booking_request.parked_unclaimed", {}, "en", side).result!.text,
      ).toBe("Waiting for the place's owner to claim its page");
      expect(
        view("booking_request.unparked", {}, "es", side).result!.text,
      ).toBe("El lugar reclamó su página — tu solicitud está en camino");
    }
  });
});
