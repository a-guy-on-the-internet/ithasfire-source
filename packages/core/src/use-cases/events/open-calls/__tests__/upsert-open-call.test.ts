/**
 * Open calls v1, step 3 — posting a call (FR-001, FR-002, Q40).
 */
import { describe, expect, it } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import {
  OC_EDITOR_ID,
  OC_EVENT_ID,
  OC_SERIES_ID,
  OC_STRANGER_ID,
  OC_VIEWER_ID,
  createOpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { upsertEventApplicationForm } from "../../upsert-event-application-form";
import { upsertSeriesOpenCall } from "../upsert-series-open-call";
import { statesTicketCount } from "../_shared/open-call-pay";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const world = createOpenCallWorld();
  const deps = { repos: world.repos, clock: world.clock as unknown as ClockPort };
  return { world, deps };
}

/** A series with one live date ahead (a new series call needs one). */
function addLiveSeries(
  world: ReturnType<typeof createOpenCallWorld>,
  overrides: Parameters<ReturnType<typeof createOpenCallWorld>["addSeries"]>[0] = {},
) {
  const series = world.addSeries(overrides);
  world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY) });
  return series;
}

const eventCall = (extra: Record<string, unknown>) => ({
  actorHumanId: OC_EDITOR_ID,
  eventId: OC_EVENT_ID,
  purpose: "PERFORM",
  ...extra,
});

/** The zod issue messages carried by an `invalid_input` rejection. */
async function issueMessages(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    const issues = (error as { issues?: Array<{ message: string }> }).issues ?? [];
    return issues.map((i) => i.message);
  }
  throw new Error("expected a rejection");
}

describe("pay validation matrix (FR-002)", () => {
  const REQUIRES_DETAILS = ["FIXED", "DOOR_SPLIT", "TICKET_SHARE"] as const;

  it.each(REQUIRES_DETAILS)("%s needs details: missing and blank are refused", async (payKind) => {
    const { world, deps } = setup();
    world.addEvent();
    expect(
      await issueMessages(upsertEventApplicationForm(deps, eventCall({ payKind }))),
    ).toEqual(["pay_details_required"]);
    expect(
      await issueMessages(
        upsertEventApplicationForm(deps, eventCall({ payKind, payDetails: "   \n  " })),
      ),
    ).toEqual(["pay_details_required"]);
    // Markup alone sanitizes to nothing, so it is blank too.
    expect(
      await issueMessages(
        upsertEventApplicationForm(deps, eventCall({ payKind, payDetails: "<b></b>" })),
      ),
    ).toEqual(["pay_details_required"]);
    expect(world.forms).toHaveLength(0);
  });

  it.each(REQUIRES_DETAILS)("%s with details is posted", async (payKind) => {
    const { world, deps } = setup();
    world.addEvent();
    const out = await upsertEventApplicationForm(
      deps,
      eventCall({ payKind, payDetails: "  $150 guarantee  " }),
    );
    expect(out.purpose).toBe("PERFORM");
    expect(out.openCall).toMatchObject({ payKind, payDetails: "$150 guarantee" });
    expect(out.openCall?.publicId).toMatch(/\S+/);
  });

  it("TICKET_QUOTA needs details that state a number of tickets", async () => {
    const { world, deps } = setup();
    world.addEvent();
    expect(
      await issueMessages(upsertEventApplicationForm(deps, eventCall({ payKind: "TICKET_QUOTA" }))),
    ).toEqual(["pay_details_required"]);
    expect(
      await issueMessages(
        upsertEventApplicationForm(
          deps,
          eventCall({ payKind: "TICKET_QUOTA", payDetails: "sell some tickets" }),
        ),
      ),
    ).toEqual(["ticket_quota_needs_count"]);
    expect(
      await issueMessages(
        upsertEventApplicationForm(
          deps,
          eventCall({ payKind: "TICKET_QUOTA", payDetails: "sell 0 tickets" }),
        ),
      ),
    ).toEqual(["ticket_quota_needs_count"]);
    const ok = await upsertEventApplicationForm(
      deps,
      eventCall({ payKind: "TICKET_QUOTA", payDetails: "Sell 10 tickets to play" }),
    );
    expect(ok.openCall?.payKind).toBe("TICKET_QUOTA");
  });

  it.each(["UNPAID", "DISCUSSED_AFTER"] as const)("%s needs no details", async (payKind) => {
    const { world, deps } = setup();
    world.addEvent();
    const out = await upsertEventApplicationForm(deps, eventCall({ payKind }));
    expect(out.openCall).toMatchObject({ payKind, payDetails: null });
  });

  it("a call with no pay kind is refused", async () => {
    const { world, deps } = setup();
    world.addEvent();
    expect(
      await issueMessages(upsertEventApplicationForm(deps, eventCall({ introText: "Hi" }))),
    ).toEqual(["pay_kind_required"]);
  });

  it("details over 500 characters are refused", async () => {
    const { world, deps } = setup();
    world.addEvent();
    await expect(
      upsertEventApplicationForm(deps, eventCall({ payKind: "FIXED", payDetails: "x".repeat(501) })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("validates the MERGED pay: switching to FIXED without details is refused", async () => {
    const { world, deps } = setup();
    world.addEvent();
    await upsertEventApplicationForm(deps, eventCall({ payKind: "UNPAID" }));
    // An intro-only save keeps the stored kind.
    const intro = await upsertEventApplicationForm(deps, eventCall({ introText: "Bands wanted" }));
    expect(intro.openCall?.payKind).toBe("UNPAID");
    expect(
      await issueMessages(upsertEventApplicationForm(deps, eventCall({ payKind: "FIXED" }))),
    ).toEqual(["pay_details_required"]);
    // Clearing the details of a FIXED call is refused the same way.
    await upsertEventApplicationForm(deps, eventCall({ payKind: "FIXED", payDetails: "$100" }));
    expect(
      await issueMessages(upsertEventApplicationForm(deps, eventCall({ payDetails: null }))),
    ).toEqual(["pay_details_required"]);
  });

  it("statesTicketCount reads digits only", () => {
    expect(statesTicketCount("15 presales")).toBe(true);
    expect(statesTicketCount("ten")).toBe(false);
    expect(statesTicketCount("0")).toBe(false);
    expect(statesTicketCount("00 or 3")).toBe(true);
  });
});

describe("ATTEND stays the attendee gate", () => {
  it.each([{ payKind: "UNPAID" }, { payDetails: "x" }, { payKind: null }])(
    "rejects pay fields on the attendee form (%o)",
    async (extra) => {
      const { world, deps } = setup();
      world.addEvent({ gateType: "APPLICATION" });
      const messages = await issueMessages(
        upsertEventApplicationForm(deps, {
          actorHumanId: OC_EDITOR_ID,
          eventId: OC_EVENT_ID,
          ...extra,
        }),
      );
      expect(messages).toContain("pay_fields_only_on_open_calls");
    },
  );

  it("refuses autoApprove on a call", async () => {
    const { world, deps } = setup();
    world.addEvent();
    expect(
      await issueMessages(
        upsertEventApplicationForm(deps, eventCall({ payKind: "UNPAID", autoApprove: true })),
      ),
    ).toEqual(["auto_approve_not_on_open_calls"]);
  });
});

describe("event call auth and lifecycle", () => {
  it("a stranger and a VIEWER cannot post a call", async () => {
    const { world, deps } = setup();
    world.addEvent();
    for (const actor of [OC_STRANGER_ID, OC_VIEWER_ID]) {
      await expect(
        upsertEventApplicationForm(deps, eventCall({ actorHumanId: actor, payKind: "UNPAID" })),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    }
    expect(world.forms).toHaveLength(0);
  });

  it("does not need the attendee gate, and works on a draft", async () => {
    const { world, deps } = setup();
    world.addEvent({ gateType: "NONE", status: "DRAFT" });
    const out = await upsertEventApplicationForm(deps, eventCall({ payKind: "UNPAID" }));
    expect(out.purpose).toBe("PERFORM");
    expect(world.audit.map((a) => a.action)).toEqual(["open_call_created"]);
  });

  it.each(["CANCELLED", "ARCHIVED", "COMPLETED"] as const)(
    "a %s event takes no call",
    async (status) => {
      const { world, deps } = setup();
      world.addEvent({ status });
      await expect(
        upsertEventApplicationForm(deps, eventCall({ payKind: "UNPAID" })),
      ).rejects.toMatchObject({ code: "EVENT_NOT_EDITABLE" });
    },
  );
});

describe("one call per night (FR-001)", () => {
  it("an event in a series whose series has a call is refused its own", async () => {
    const { world, deps } = setup();
    world.addEvent();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 10 * DAY), eventId: OC_EVENT_ID });
    const seriesCall = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });

    await expect(
      upsertEventApplicationForm(deps, eventCall({ payKind: "UNPAID" })),
    ).rejects.toMatchObject({
      code: "OPEN_CALL_COVERED_BY_SERIES",
      meta: { seriesId: OC_SERIES_ID, publicId: seriesCall.publicId, posted: true },
    });
    expect(world.locks).toContainEqual({ kind: "series_advisory", id: OC_SERIES_ID });
  });

  it("a DRAFT series call still covers the night, and the refusal says it is unposted", async () => {
    const { world, deps } = setup();
    world.addEvent();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 10 * DAY), eventId: OC_EVENT_ID });
    const seriesDraft = world.addForm({
      purpose: "PERFORM",
      seriesId: OC_SERIES_ID,
      postedAt: null,
      postedByHumanId: null,
    });

    await expect(
      upsertEventApplicationForm(deps, eventCall({ payKind: "UNPAID" })),
    ).rejects.toMatchObject({
      code: "OPEN_CALL_COVERED_BY_SERIES",
      meta: { seriesId: OC_SERIES_ID, publicId: seriesDraft.publicId, posted: false },
    });
  });

  it("an event DETACHED from its series may have its own call", async () => {
    const { world, deps } = setup();
    world.addEvent();
    world.addSeries();
    world.addOccurrence({
      startsAt: new Date(world.now.getTime() + 10 * DAY),
      eventId: OC_EVENT_ID,
      status: "DETACHED",
    });
    world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const out = await upsertEventApplicationForm(deps, eventCall({ payKind: "UNPAID" }));
    expect(out.purpose).toBe("PERFORM");
  });

  it("a series call is refused while an upcoming event of the series has its own, naming it", async () => {
    const { world, deps } = setup();
    const event = world.addEvent();
    world.addSeries();
    world.addOccurrence({ startsAt: event.startsAt, eventId: event.id });
    world.addForm({ purpose: "PERFORM", eventId: event.id });

    await expect(
      upsertSeriesOpenCall(deps, {
        actorHumanId: OC_EDITOR_ID,
        seriesId: OC_SERIES_ID,
        payKind: "UNPAID",
      }),
    ).rejects.toMatchObject({
      code: "SERIES_OPEN_CALL_CONFLICT",
      meta: {
        seriesId: OC_SERIES_ID,
        events: [{ eventId: event.id, title: event.title }],
      },
    });
  });

  it("a PAST event's own call does not block the series call", async () => {
    const { world, deps } = setup();
    const past = world.addEvent({
      startsAt: new Date(world.now.getTime() - 3 * DAY),
      endsAt: new Date(world.now.getTime() - 3 * DAY + 3600_000),
    });
    world.addSeries();
    world.addOccurrence({ startsAt: past.startsAt, eventId: past.id });
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY) });
    world.addForm({ purpose: "PERFORM", eventId: past.id, closedAt: world.now });

    const out = await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      payKind: "DOOR_SPLIT",
      payDetails: "70/30 of the door after costs",
    });
    expect(out).toMatchObject({ seriesId: OC_SERIES_ID, payKind: "DOOR_SPLIT" });
  });

  it("an EXISTING event call can still be edited (the checks guard creation)", async () => {
    const { world, deps } = setup();
    world.addEvent();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 10 * DAY), eventId: OC_EVENT_ID });
    world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const out = await upsertEventApplicationForm(deps, eventCall({ introText: "Still on" }));
    expect(out.introText).toBe("Still on");
  });
});

describe("series call (Q40)", () => {
  it("a series editor can post one; the record is series-anchored", async () => {
    const { world, deps } = setup();
    addLiveSeries(world);
    const out = await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      payKind: "FIXED",
      payDetails: "$80 per act",
      closesAt: new Date(world.now.getTime() + 5 * DAY),
    });
    expect(out).toMatchObject({ seriesId: OC_SERIES_ID, payKind: "FIXED", closedAt: null });
    expect(world.forms[0]).toMatchObject({ seriesId: OC_SERIES_ID, eventId: null, purpose: "PERFORM" });
    expect(world.audit[0]).toMatchObject({ entity: "event_series", action: "open_call_created" });
  });

  it("a stranger cannot; a VIEWER member cannot", async () => {
    const { world, deps } = setup();
    addLiveSeries(world);
    await expect(
      upsertSeriesOpenCall(deps, {
        actorHumanId: OC_STRANGER_ID,
        seriesId: OC_SERIES_ID,
        payKind: "UNPAID",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      upsertSeriesOpenCall(deps, {
        actorHumanId: OC_VIEWER_ID,
        seriesId: OC_SERIES_ID,
        payKind: "UNPAID",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(world.forms).toHaveLength(0);
  });

  it("a person's series: the owner can, someone else cannot", async () => {
    const { world, deps } = setup();
    addLiveSeries(world, { ownerScope: "HUMAN", ownerId: OC_EDITOR_ID });
    await expect(
      upsertSeriesOpenCall(deps, {
        actorHumanId: OC_STRANGER_ID,
        seriesId: OC_SERIES_ID,
        payKind: "UNPAID",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      payKind: "UNPAID",
    });
    expect(world.forms).toHaveLength(1);
  });

  it("an archived series takes no call; a missing one is SERIES_NOT_FOUND", async () => {
    const { world, deps } = setup();
    world.addSeries({ archivedAt: world.now });
    await expect(
      upsertSeriesOpenCall(deps, {
        actorHumanId: OC_EDITOR_ID,
        seriesId: OC_SERIES_ID,
        payKind: "UNPAID",
      }),
    ).rejects.toMatchObject({ code: "SERIES_INACTIVE" });
    await expect(
      upsertSeriesOpenCall(deps, {
        actorHumanId: OC_EDITOR_ID,
        seriesId: "40000000-0000-4000-8000-0000000000ff",
        payKind: "UNPAID",
      }),
    ).rejects.toMatchObject({ code: "SERIES_NOT_FOUND" });
  });

  it("pay rules apply to series calls too", async () => {
    const { world, deps } = setup();
    addLiveSeries(world);
    expect(
      await issueMessages(
        upsertSeriesOpenCall(deps, {
          actorHumanId: OC_EDITOR_ID,
          seriesId: OC_SERIES_ID,
          payKind: "TICKET_SHARE",
        }),
      ),
    ).toEqual(["pay_details_required"]);
  });
});

describe("intro text on a call is sanitized (it is public)", () => {
  it("event call: tags and control characters stripped, blank becomes null", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const out = await upsertEventApplicationForm(
      deps,
      eventCall({
        payKind: "UNPAID",
        introText: "<script>alert(1)</script>Bands <b>wanted</b>\u202E!",
      }),
    );
    expect(out.introText).toBe("Bands wanted!");
    const blank = await upsertEventApplicationForm(deps, eventCall({ introText: "<p> </p>" }));
    expect(blank.introText).toBeNull();
  });

  it("series call: same", async () => {
    const { world, deps } = setup();
    addLiveSeries(world);
    const out = await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      payKind: "UNPAID",
      introText: "<i>Open</i> stage\u200B every week",
    });
    expect(out.introText).toBe("Open stage every week");
    const blank = await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      introText: "   ",
    });
    expect(blank.introText).toBeNull();
  });

  it("the attendee form's intro keeps its old schema (trim only)", async () => {
    const { world, deps } = setup();
    world.addEvent({ gateType: "APPLICATION" });
    let written: unknown;
    (world.repos.eventApplications as unknown as Record<string, unknown>).getForm = async () => null;
    (world.repos.eventApplications as unknown as Record<string, unknown>).upsertForm = async (
      input: { introText?: string },
    ) => {
      written = input.introText;
      return {
        id: "a0000000-0000-4000-8000-00000000000a",
        eventId: OC_EVENT_ID,
        purpose: "ATTEND",
        publicId: "attend0001",
        introText: input.introText ?? null,
        defaults: { includeName: false, includeReason: false, includeSocialLinks: false },
        opensAt: null,
        closesAt: null,
        maxSubmissions: null,
        autoApprove: false,
        updatedByHumanId: OC_EDITOR_ID,
        createdAt: world.now,
        updatedAt: world.now,
      };
    };
    await upsertEventApplicationForm(deps, {
      actorHumanId: OC_EDITOR_ID,
      eventId: OC_EVENT_ID,
      introText: "  <b>Tell us</b>  ",
    });
    expect(written).toBe("<b>Tell us</b>");
  });
});

describe("a NEW call needs a night still to come", () => {
  it("a past event is refused a new call, but its existing call stays editable", async () => {
    const { world, deps } = setup();
    world.addEvent({ startsAt: new Date(world.now.getTime() - DAY) });
    await expect(
      upsertEventApplicationForm(deps, eventCall({ payKind: "UNPAID" })),
    ).rejects.toMatchObject({ code: "EVENT_NOT_EDITABLE", meta: { reason: "last_date_started" } });
    expect(world.forms).toHaveLength(0);

    world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const out = await upsertEventApplicationForm(deps, eventCall({ introText: "Thanks all" }));
    expect(out.introText).toBe("Thanks all");
  });

  it("a series with no live occurrence ahead is refused a new call", async () => {
    const { world, deps } = setup();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() - DAY) });
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + DAY), status: "SKIPPED" });
    await expect(
      upsertSeriesOpenCall(deps, {
        actorHumanId: OC_EDITOR_ID,
        seriesId: OC_SERIES_ID,
        payKind: "UNPAID",
      }),
    ).rejects.toMatchObject({ code: "SERIES_INACTIVE", meta: { reason: "last_date_started" } });

    world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const out = await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      introText: "Edited",
    });
    expect(out.introText).toBe("Edited");
  });
});
