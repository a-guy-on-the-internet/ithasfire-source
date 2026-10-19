import { describe, expect, it } from "vitest";

import {
  assertNoViewerScopedFields,
  type EventPageData,
} from "../event-page-data";

/**
 * The regression net for the edge-cache leak.
 *
 * `/events/[...slug]` is served `public, s-maxage=120, stale-while-revalidate=300`
 * with a `Vary` carrying no `Cookie`. A single viewer-scoped field in
 * {@link EventPageData} is therefore one viewer's answer handed to everyone
 * behind the same colo — and in the case that prompted this, a hidden venue's
 * exact street address handed to strangers and to crawlers.
 *
 * Two independent guards are exercised here: the RUNTIME walk, and (below) the
 * TYPE. The type only knows the three names it was told about; the walk is
 * what catches the field nobody thought to add.
 */
describe("assertNoViewerScopedFields", () => {
  it("passes a payload made only of event-intrinsic data", () => {
    expect(() =>
      assertNoViewerScopedFields({
        // The anonymous arrival areas are event-intrinsic (cacheablePublic).
        arrivalAreas: [{ id: "a1", source: "PLACE", kind: "PARKING" }],
        eventId: "evt-1",
        slug: "great-show",
        event: { name: "Great Show", location: { areaLabel: "Nashville, TN" } },
        ticketTypes: [{ id: "tt-1", name: "General", priceCents: 2500 }],
        communityDates: [{ eventDateId: "d1", startsAt: new Date() }],
        waitlistOpen: false,
      }),
    ).not.toThrow();
  });

  for (const [label, payload] of [
    ["a top-level editHref", { editHref: "/admin/demo/events/evt-1" }],
    ["a nested viewerHasTicket", { event: { viewerHasTicket: true } }],
    ["a nested viewerRsvped", { event: { viewerRsvped: false } }],
    [
      "a viewer flag inside an array element",
      { communityDates: [{ eventDateId: "d1", viewerRsvped: true }] },
    ],
    // The names below are NOT in the type-level list on purpose: this is the
    // half of the guard that catches a field invented later.
    // arrival-areas NFR-001: the viewer's own areas (an act's load-in, a
    // withheld place's parking for a holder) belong in EventViewerState.
    ["a top-level viewerArrivalAreas", { viewerArrivalAreas: [{ id: "a1" }] }],
    ["an unlisted viewerCanBypass", { gate: { viewerCanBypass: true } }],
    ["an unlisted callerIsTicketHolder", { callerIsTicketHolder: true }],
    ["an unlisted myRsvpState", { myRsvpState: "going" }],
    // Moderator-scoped rather than viewer-scoped, and fenced for the same
    // reason: the per-date RSVP presence flag is for one moderator's
    // decision, never for a document strangers share.
    [
      "a moderator-only hasRsvp inside an array element",
      { communityDates: [{ eventDateId: "d1", hasRsvp: true }] },
    ],
  ] as const) {
    it(`throws on ${label}`, () => {
      expect(() => assertNoViewerScopedFields(payload)).toThrow(
        /viewer-scoped field/,
      );
    });
  }

  it("names the offending path so the failure is actionable", () => {
    expect(() =>
      assertNoViewerScopedFields({
        communityDates: [{ eventDateId: "d1" }, { viewerRsvped: true }],
      }),
    ).toThrow(/data\.communityDates\[1\]\.viewerRsvped/);
  });

  it("does not flag a legitimate field that merely starts with 'my'", () => {
    // The pattern requires an uppercase/underscore boundary after the prefix,
    // so `mystery` and `mythology` are ordinary words, not viewer state.
    expect(() =>
      assertNoViewerScopedFields({ mysteryGuest: true, mythology: "none" }),
    ).not.toThrow();
  });

  it("survives a cyclic payload instead of blowing the stack", () => {
    const node: Record<string, unknown> = { name: "x" };
    node.self = node;
    expect(() => assertNoViewerScopedFields(node)).not.toThrow();
  });

  it("does not walk into Date values", () => {
    expect(() =>
      assertNoViewerScopedFields({ startsAt: new Date("2025-04-01") }),
    ).not.toThrow();
  });
});

describe("EventPageData (type-level guard)", () => {
  /**
   * These are compile-time assertions, checked by
   * `pnpm -F web exec tsc -p tsconfig.json --noEmit` (apps/web's tsconfig
   * `include`s `**\/*.ts`, so test files ARE typechecked here — unlike
   * tsconfig.base.json, which excludes them).
   *
   * Each `@ts-expect-error` FAILS THE BUILD if the error disappears — i.e. if
   * someone widens `EventPageData` to accept a viewer-scoped field again.
   */
  it("refuses a viewer-scoped field at the top level", () => {
    const base = {} as EventPageData;

    // @ts-expect-error editHref is viewer-scoped and must live in EventViewerState
    const withEdit: EventPageData = { ...base, editHref: "/admin/x" };
    // @ts-expect-error viewerHasTicket is viewer-scoped
    const withTicket: EventPageData = { ...base, viewerHasTicket: true };
    // @ts-expect-error viewerRsvped is viewer-scoped
    const withRsvp: EventPageData = { ...base, viewerRsvped: true };

    const withAreas: EventPageData = {
      ...base,
      // @ts-expect-error viewerArrivalAreas is viewer-scoped (arrival-areas NFR-001)
      viewerArrivalAreas: [],
    };

    expect([withEdit, withTicket, withRsvp, withAreas]).toHaveLength(4);
  });

  it("refuses a viewer-scoped field nested in `event` or `communityDates`", () => {
    const base = {} as EventPageData;

    const withNestedTicket: EventPageData = {
      ...base,
      // @ts-expect-error PublicEventSeo forbids viewerHasTicket
      event: { ...base.event, viewerHasTicket: true },
    };
    const withNestedRsvp: EventPageData = {
      ...base,
      communityDates: [
        {
          eventDateId: "d1",
          startsAt: "x",
          endsAt: null,
          // @ts-expect-error PublicCommunityEventDate forbids viewerRsvped
          viewerRsvped: true,
        },
      ],
    };

    expect([withNestedTicket, withNestedRsvp]).toHaveLength(2);
  });
});
