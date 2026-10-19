import { describe, expect, it } from "vitest";

import { describeBookingTerms } from "../booking-terms-strip";

/**
 * Decision table for the terms strip — the booking's binding header, rendered
 * inside the conversation about it.
 *
 * The bug behind the surface: an act and a venue agreed "Sep 25 works" in the
 * thread while the agreement's `proposedDate` said Sep 18, nobody opened the
 * agreement, and the event was created from Sep 18. Everything here exists so
 * the header is legible at the moment the prose is written — including the
 * server's `pitchProvenance`, which says which values are still the act's
 * un-chosen opening ask.
 */

const t = (key: string) => key;
const formatDateTime = (value: Date) => value.toISOString();
const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function describe_(
  overrides: Partial<Parameters<typeof describeBookingTerms>[0]> = {},
) {
  return describeBookingTerms({
    status: "ACCEPTED",
    proposedDate: new Date("2026-09-19T00:00:00.000Z"),
    proposedEndDate: new Date("2026-09-19T04:00:00.000Z"),
    guaranteeCents: 65000,
    pitchProvenance: null,
    mayEdit: false,
    t,
    formatDateTime,
    formatMoney,
    ...overrides,
  });
}

describe("describeBookingTerms", () => {
  it("renders the three header fields that actually bind, in header order", () => {
    const view = describe_();
    expect(view.fields.map((f) => f.key)).toEqual(["date", "end", "guarantee"]);
    expect(view.fields[0]!.value).toBe("2026-09-19T00:00:00.000Z");
    expect(view.fields[1]!.value).toBe("2026-09-19T04:00:00.000Z");
    expect(view.fields[2]!.value).toBe("$650.00");
    expect(view.fields.every((f) => f.present)).toBe(true);
  });

  it("uses the agreement editor's own field labels, so the two surfaces agree", () => {
    expect(describe_().fields.map((f) => f.label)).toEqual([
      "admin.baProposedDateLabel",
      "admin.baProposedEndDateLabel",
      "admin.baGuaranteeLabel",
    ]);
  });

  it("prints a placeholder for a null field instead of dropping it", () => {
    const view = describe_({
      proposedDate: null,
      proposedEndDate: null,
      guaranteeCents: null,
    });
    expect(view.fields.map((f) => f.value)).toEqual(["—", "—", "—"]);
    expect(view.fields.every((f) => f.present)).toBe(false);
  });

  /**
   * A settled $0 guarantee is a DECISION (a door split with no floor), and a
   * truthiness check would report it as unset. That is the same class of
   * mistake the whole strip exists to catch, one level down.
   */
  it("treats a zero guarantee as a set value, not an absent one", () => {
    const view = describe_({ guaranteeCents: 0 });
    expect(view.fields[2]!.value).toBe("$0.00");
    expect(view.fields[2]!.present).toBe(true);
  });

  it("survives an unparseable date without throwing", () => {
    const view = describe_({ proposedDate: "not-a-date" });
    expect(view.fields[0]!.value).toBe("—");
    expect(view.fields[0]!.present).toBe(false);
  });

  it("accepts an ISO string as well as a Date (wire shape drift)", () => {
    const view = describe_({ proposedDate: "2026-09-19T00:00:00.000Z" });
    expect(view.fields[0]!.value).toBe("2026-09-19T00:00:00.000Z");
  });

  // ── Pitch provenance ──────────────────────────────────────────────────────

  it("marks exactly the fields the server attributed to the pitch", () => {
    const view = describe_({
      pitchProvenance: {
        proposedDate: true,
        proposedEndDate: false,
        guaranteeCents: true,
        description: false,
      },
    });
    expect(view.fields.map((f) => f.fromPitch)).toEqual([true, false, true]);
    expect(view.anyFromPitch).toBe(true);
  });

  /**
   * Null provenance means "there is no originating pitch to attribute to", NOT
   * "the act asked for this". Reading it the other way round would print the
   * strip's loudest claim on an agreement nobody pitched.
   */
  it("attributes nothing when the server sent no provenance", () => {
    const view = describe_({ pitchProvenance: null });
    expect(view.fields.map((f) => f.fromPitch)).toEqual([false, false, false]);
    expect(view.anyFromPitch).toBe(false);
  });

  it("suppresses the pitch nudge once the agreement has ended", () => {
    const view = describe_({
      status: "DECLINED",
      pitchProvenance: {
        proposedDate: true,
        proposedEndDate: true,
        guaranteeCents: true,
        description: true,
      },
    });
    // The flags survive (they are facts about the stored row); the "nobody has
    // chosen this yet" sentence does not, because nobody is going to.
    expect(view.fields.map((f) => f.fromPitch)).toEqual([true, true, true]);
    expect(view.anyFromPitch).toBe(false);
  });

  // ── Live vs ended ─────────────────────────────────────────────────────────

  it.each(["DRAFT", "PROPOSED", "COUNTERED", "ACCEPTED"])(
    "reads as live terms at %s",
    (status) => {
      const view = describe_({ status });
      expect(view.ended).toBe(false);
      expect(view.heading).toBe("booking.termsHeading");
    },
  );

  it.each(["DECLINED", "CANCELLED", "EXPIRED", "DISPUTED", "FULFILLED"])(
    "reads as history at %s",
    (status) => {
      const view = describe_({ status });
      expect(view.ended).toBe(true);
      expect(view.heading).toBe("booking.termsHeadingEnded");
    },
  );

  // ── The route-out's label is a promise ────────────────────────────────────

  /**
   * `mayEdit` is DRAFT + edit-level access, i.e. the only window in which the
   * header can actually be changed. A verb the destination page will refuse is
   * worse than no verb, so every other case reads "View agreement".
   */
  it("offers the CHANGE verb only while the viewer may actually edit", () => {
    expect(describe_({ status: "DRAFT", mayEdit: true }).linkLabel).toBe(
      "booking.termsChange",
    );
    expect(describe_({ status: "DRAFT", mayEdit: false }).linkLabel).toBe(
      "booking.entryOpenAgreement",
    );
    // Accepted: the specimen. Nobody can edit it, so nobody is told they can.
    expect(describe_({ status: "ACCEPTED", mayEdit: false }).linkLabel).toBe(
      "booking.entryOpenAgreement",
    );
  });

  it("never offers the CHANGE verb on an ended agreement", () => {
    // Belt and braces: `mayEdit` is already false at every ended status
    // server-side, but the strip must not depend on that to stay honest.
    expect(describe_({ status: "DECLINED", mayEdit: true }).linkLabel).toBe(
      "booking.entryOpenAgreement",
    );
  });

  it("labels and tones the status from the shared agreement mapping", () => {
    expect(describe_({ status: "ACCEPTED" })).toMatchObject({
      statusLabel: "admin.baStatusAccepted",
      statusTone: "success",
    });
    expect(describe_({ status: "DECLINED" })).toMatchObject({
      statusLabel: "admin.baStatusDeclined",
      statusTone: "danger",
    });
    expect(describe_({ status: "PROPOSED" }).statusTone).toBe("warning");
  });

  /**
   * A status written by a newer build must not blank the badge, print a raw
   * enum member, or be coloured as if we knew whether it was good news.
   */
  it("gives an unknown status a neutral word rather than the raw enum member", () => {
    const view = describe_({ status: "RENEGOTIATING" });
    expect(view.statusLabel).toBe("admin.bkStageUnknownState");
    expect(view.statusTone).toBe("neutral");
    expect(view.ended).toBe(false);
    expect(view.heading).toBe("booking.termsHeading");
  });
});
