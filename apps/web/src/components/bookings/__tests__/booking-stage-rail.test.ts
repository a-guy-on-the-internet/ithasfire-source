import { describe, expect, it } from "vitest";

import {
  describeBookingStages,
  type DescribeBookingStagesArgs,
} from "../booking-stage-rail";

// The catalogs are exercised separately by the parity gate; here a translator
// that echoes `key(args)` keeps every assertion about the DECISION rather than
// about English copy, and makes a missing/typo'd key visible as a raw key in
// the expected string.
const t = (key: string, values?: Record<string, string>) =>
  values && Object.keys(values).length > 0
    ? `${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key;

const formatDate = (value: Date) =>
  `${value.getFullYear()}-${`${value.getMonth() + 1}`.padStart(2, "0")}-${`${value.getDate()}`.padStart(2, "0")}`;

function describeRow(
  overrides: Partial<DescribeBookingStagesArgs> = {},
): ReturnType<typeof describeBookingStages> {
  return describeBookingStages({
    status: "PENDING",
    agreementStatus: null,
    eventId: null,
    eventStatus: null,
    eventStartsAt: null,
    preferredDates: [],
    t,
    formatDate,
    ...overrides,
  });
}

/** The three bar states, in arc order — the whole visual claim in one line. */
const barStates = (view: ReturnType<typeof describeBookingStages>) =>
  view.stages.map((stage) => stage.state);

const values = (view: ReturnType<typeof describeBookingStages>) =>
  view.stages.map((stage) => stage.value);

describe("describeBookingStages", () => {
  describe("request only", () => {
    it("lights the request leg and leaves the rest as 'not yet'", () => {
      const view = describeRow({ status: "PENDING" });
      expect(barStates(view)).toEqual(["current", "upcoming", "upcoming"]);
      expect(values(view)).toEqual([
        "admin.bkStatusPending",
        "admin.bkStageNotYet",
        "admin.bkStageNotYet",
      ]);
      expect(view.focusIndex).toBe(0);
      expect(view.stopped).toBe(false);
    });

    it("keeps an accepted request as the current leg while nothing follows", () => {
      // ACCEPTED with a null agreement is the degraded-lookup case as well as
      // the "just accepted" case — it must NOT render as a definite negative.
      const view = describeRow({ status: "ACCEPTED" });
      expect(barStates(view)).toEqual(["current", "upcoming", "upcoming"]);
      expect(view.stages[1]!.value).toBe("admin.bkStageNotYet");
    });

    it("treats VIEWED as in progress, not as an answer", () => {
      expect(barStates(describeRow({ status: "VIEWED" }))).toEqual([
        "current",
        "upcoming",
        "upcoming",
      ]);
    });
  });

  describe("agreement leg", () => {
    it("moves focus to a drafted agreement and marks the request done", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "DRAFT",
      });
      expect(barStates(view)).toEqual(["done", "current", "upcoming"]);
      expect(view.stages[1]!.value).toBe("admin.bkStageAgrDraft");
      expect(view.focusIndex).toBe(1);
    });

    it("says an agreement is out for review", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "PROPOSED",
      });
      expect(view.stages[1]!.value).toBe("admin.bkStageAgrProposed");
      expect(view.stages[1]!.state).toBe("current");
    });

    it("says terms are agreed", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
      });
      expect(view.stages[1]!.value).toBe("admin.bkStageAgrAccepted");
      expect(view.stopped).toBe(false);
    });

    it.each([
      ["DECLINED", "admin.bkStageAgrDeclined"],
      ["CANCELLED", "admin.bkStageAgrCancelled"],
      ["EXPIRED", "admin.bkStageAgrExpired"],
      ["DISPUTED", "admin.bkStageAgrDisputed"],
    ])("stops the arc on a %s agreement", (status, key) => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: status,
      });
      expect(view.stopped).toBe(true);
      expect(view.focusIndex).toBe(1);
      expect(barStates(view)).toEqual(["stopped", "stopped", "upcoming"]);
      expect(view.stages[1]!.value).toBe(key);
      // "Not yet" is a promise a dead booking must not make.
      expect(view.stages[2]!.value).toBe("admin.bkStageNotReached");
    });

    it("renders COUNTERED without stopping the arc", () => {
      // In the enum, written by nothing today — handled so a future row
      // cannot crash an inbox, not designed around.
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "COUNTERED",
      });
      expect(view.stopped).toBe(false);
      expect(view.stages[1]!.state).toBe("current");
    });

    it("renders FULFILLED as done — terminal-good, not 'current'", () => {
      // FULFILLED is written by `completeEvent` when the show happened. A
      // fulfilled agreement is not waiting on anyone, so the leg is `done`
      // even though it is the furthest reached; focus still points at it.
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "FULFILLED",
      });
      expect(view.stopped).toBe(false);
      expect(view.stages[1]!.value).toBe("admin.bkStageAgrFulfilled");
      expect(barStates(view)).toEqual(["done", "done", "upcoming"]);
      expect(view.focusIndex).toBe(1);
    });

    it("does not crash on an agreement status this build has never heard of", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "TIME_TRAVELLED",
      });
      expect(view.stages[1]!.value).toBe("admin.bkStageUnknownState");
      expect(view.stages[1]!.state).toBe("current");
      // Never guessed as good OR bad news.
      expect(view.stopped).toBe(false);
    });
  });

  describe("event leg", () => {
    it("distinguishes a draft event from a published one", () => {
      const draft = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
      });
      expect(barStates(draft)).toEqual(["done", "done", "current"]);
      expect(draft.stages[2]!.value).toBe("admin.eventStatusDraft");

      const live = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "PUBLISHED",
        eventStartsAt: new Date(2026, 8, 19),
      });
      expect(live.stages[2]!.value).toBe("admin.eventStatusPublished");
    });

    it("puts the booked date on the event leg", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
      });
      expect(view.stages[2]!.meta).toBe("2026-09-19");
      expect(view.stages[0]!.meta).toBeNull();
      expect(view.stages[1]!.meta).toBeNull();
    });

    it("reads done-done-done once the event is COMPLETED and the agreement FULFILLED", () => {
      // The whole arc settled: nothing is `current` because nothing is
      // pending. The date and the state word still ride the event leg.
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "FULFILLED",
        eventId: "e1",
        eventStatus: "COMPLETED",
        eventStartsAt: new Date(2026, 8, 19),
      });
      expect(view.stopped).toBe(false);
      expect(barStates(view)).toEqual(["done", "done", "done"]);
      expect(view.stages[2]!.value).toBe("admin.eventStatusCompleted");
      expect(view.stages[2]!.meta).toBe("2026-09-19");
      expect(view.focusIndex).toBe(2);
      expect(view.summary).toContain("admin.eventStatusCompleted");
    });

    it("keeps a COMPLETED event done even when the agreement stayed ACCEPTED", () => {
      // Pre-FULFILLED rows (completed before this shipped) — the event leg
      // is still settled; the agreement leg is simply behind it.
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "COMPLETED",
        eventStartsAt: new Date(2026, 8, 19),
      });
      expect(barStates(view)).toEqual(["done", "done", "done"]);
    });

    it("stops the arc on a cancelled event", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "CANCELLED",
        eventStartsAt: new Date(2026, 8, 19),
      });
      expect(view.stopped).toBe(true);
      expect(barStates(view)).toEqual(["stopped", "stopped", "stopped"]);
    });

    it("labels an event whose status did not come through, rather than blanking the leg", () => {
      // Unreachable by contract (the event triple is all-or-nothing) — this
      // pins the degradation, not the happy path.
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: null,
        eventStartsAt: null,
      });
      expect(view.stages[2]!.value).toBe("admin.bkStageUnknownState");
      expect(view.stages[2]!.state).toBe("current");
    });
  });

  describe("terminal request statuses", () => {
    it.each([
      ["DECLINED", "admin.bkStatusDeclined"],
      ["WITHDRAWN", "admin.bkStatusWithdrawn"],
      ["EXPIRED", "admin.bkStatusExpired"],
    ] as const)("renders %s as a whole-rail terminal state", (status, key) => {
      const view = describeRow({ status });
      expect(view.stopped).toBe(true);
      expect(view.focusIndex).toBe(0);
      // The WHOLE rail goes quiet — no half-lit rail that still reads as
      // progress, and no later leg promising "not yet".
      expect(barStates(view)).toEqual(["stopped", "upcoming", "upcoming"]);
      expect(values(view)).toEqual([
        key,
        "admin.bkStageNotReached",
        "admin.bkStageNotReached",
      ]);
    });

    it("keeps every reached leg quiet when a later leg still has content", () => {
      // Can't happen today (events come only from accepted agreements), so
      // this pins that the combination degrades coherently rather than
      // rendering a live-looking event on a dead booking.
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "DECLINED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
      });
      expect(barStates(view)).toEqual(["stopped", "stopped", "stopped"]);
      expect(view.focusIndex).toBe(1);
    });
  });

  describe("degraded stage lookup", () => {
    it("renders a full null projection without crashing and without a false negative", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: null,
        eventId: null,
        eventStatus: null,
        eventStartsAt: null,
        preferredDates: ["2026-09-18"],
      });
      expect(view.stopped).toBe(false);
      expect(view.dateOffPitch).toBe(false);
      expect(values(view)).toEqual([
        "admin.bkStatusAccepted",
        "admin.bkStageNotYet",
        "admin.bkStageNotYet",
      ]);
    });

    it("treats a MISSING field the same as an absent stage", () => {
      // `undefined`, not null, is what a row builder that forgot the field
      // hands us. A strict `=== null` check let it through as "reached", and a
      // booking with no agreement at all drew a lit agreement leg reading "In
      // progress" — caught by an existing inbox fixture, not hypothesised.
      const view = describeBookingStages({
        status: "VIEWED",
        t,
        formatDate,
      } as unknown as DescribeBookingStagesArgs);
      expect(barStates(view)).toEqual(["current", "upcoming", "upcoming"]);
      expect(values(view)).toEqual([
        "admin.bkStatusViewed",
        "admin.bkStageNotYet",
        "admin.bkStageNotYet",
      ]);
    });

    it("ignores an unparseable event start", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: "not-a-date",
        preferredDates: ["2026-09-18"],
      });
      expect(view.stages[2]!.meta).toBeNull();
      expect(view.dateOffPitch).toBe(false);
    });

    it("accepts a serialized ISO start (superjson-less transports)", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19).toISOString(),
      });
      expect(view.stages[2]!.meta).toBe("2026-09-19");
    });
  });

  describe("booked-date signal", () => {
    it("flags a booked date the act never asked for", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
        preferredDates: ["2026-09-18", "2026-09-25", "2026-10-02T20:00"],
      });
      expect(view.dateOffPitch).toBe(true);
      expect(view.summary).toContain("admin.bkStageDateOffPitch");
    });

    it("stays quiet when the booked date IS one of the asks", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 25),
        preferredDates: ["2026-09-18", "2026-09-25"],
      });
      expect(view.dateOffPitch).toBe(false);
    });

    it("matches a preferred date that carries a wall clock", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 9, 2, 20, 0),
        preferredDates: ["2026-10-02T20:00"],
      });
      expect(view.dateOffPitch).toBe(false);
    });

    it("does not flag when there is nothing to compare against", () => {
      // An absent comparison is not a mismatch, and a warning nobody can act
      // on is worse than no warning.
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
        preferredDates: [],
      });
      expect(view.dateOffPitch).toBe(false);
    });

    it("does not flag when there is no event yet", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "DRAFT",
        preferredDates: ["2026-09-18"],
      });
      expect(view.dateOffPitch).toBe(false);
    });
  });

  describe("accessible summary", () => {
    it("names all three legs and folds the booked date into the event leg", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
        preferredDates: ["2026-09-19"],
      });
      expect(view.summary).toBe(
        "admin.bkStageSummary(request=admin.bkStatusAccepted," +
          "agreement=admin.bkStageAgrAccepted," +
          "event=admin.bkStageEventWithDate(status=admin.eventStatusDraft,date=2026-09-19))",
      );
    });

    it("matches the visible state on a stopped booking", () => {
      const view = describeRow({ status: "DECLINED" });
      expect(view.summary).toBe(
        "admin.bkStageSummary(request=admin.bkStatusDeclined," +
          "agreement=admin.bkStageNotReached," +
          "event=admin.bkStageNotReached)",
      );
    });

    it("carries every visible state word, so the picture and the caption cannot drift", () => {
      const view = describeRow({
        status: "ACCEPTED",
        agreementStatus: "PROPOSED",
      });
      for (const stage of view.stages) {
        expect(view.summary).toContain(stage.value);
      }
    });
  });

  it("always returns exactly three legs in arc order", () => {
    const view = describeRow();
    expect(view.stages.map((stage) => stage.key)).toEqual([
      "request",
      "agreement",
      "event",
    ]);
    expect(view.stages.map((stage) => stage.label)).toEqual([
      "admin.bkStageRequest",
      "admin.bkStageAgreement",
      "admin.bkStageEvent",
    ]);
  });
});

describe("describeBookingStages — venue confirmation on the event leg", () => {
  const booked = {
    status: "ACCEPTED" as const,
    agreementStatus: "ACCEPTED",
    eventId: "ev-1",
    eventStatus: "DRAFT",
  };

  it("says 'Confirmed by the place' beside the event status, and in the caption", () => {
    const view = describeRow({
      ...booked,
      venueConfirmation: { state: "confirmed" },
    });
    expect(values(view)[2]).toBe(
      "admin.bkStageEventWithConfirmation(status=admin.eventStatusDraft,confirmation=admin.bkStageVcConfirmed)",
    );
    expect(view.summary).toContain("admin.bkStageVcConfirmed");
  });

  it("says the venue has not confirmed yet", () => {
    const view = describeRow({
      ...booked,
      eventStatus: "PUBLISHED",
      venueConfirmation: { state: "unconfirmed" },
    });
    expect(values(view)[2]).toBe(
      "admin.bkStageEventWithConfirmation(status=admin.eventStatusPublished,confirmation=admin.bkStageVcAwaiting)",
    );
  });

  it("says the confirmation was withdrawn", () => {
    const view = describeRow({
      ...booked,
      venueConfirmation: { state: "withdrawn" },
    });
    expect(values(view)[2]).toBe(
      "admin.bkStageEventWithConfirmation(status=admin.eventStatusDraft,confirmation=admin.bkStageVcWithdrawn)",
    );
  });

  it("leaves the leg alone for `none`, an absent projection, and a state it has never heard of", () => {
    for (const venueConfirmation of [
      { state: "none" },
      null,
      undefined,
      { state: "something-new" },
    ]) {
      const view = describeRow({ ...booked, venueConfirmation });
      expect(values(view)[2]).toBe("admin.eventStatusDraft");
    }
  });

  it("never touches the request or agreement legs, nor an unreached event leg", () => {
    const view = describeRow({
      status: "ACCEPTED",
      agreementStatus: "DRAFT",
      venueConfirmation: { state: "confirmed" },
    });
    expect(values(view)).toEqual([
      "admin.bkStatusAccepted",
      "admin.bkStageAgrDraft",
      "admin.bkStageNotYet",
    ]);
  });
});
