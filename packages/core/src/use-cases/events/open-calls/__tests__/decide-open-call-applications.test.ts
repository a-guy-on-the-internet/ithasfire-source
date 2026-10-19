/**
 * Open calls v1 step 6 — DECIDING: pick (FR-016), "not this time" (FR-018),
 * drop out (FR-017, by status link / session and through leaveEventLineup),
 * and the lineup-removal stamp (FR-019), with the notifier seams.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import {
  OC_EDITOR_ID,
  OC_NOW,
  OC_ORG_ID,
  OC_OTHER_ORG_ID,
  OC_SERIES_ID,
  OC_STRANGER_ID,
  OC_VIEWER_ID,
  createOpenCallWorld,
  type OpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { detachEventHuman } from "../../../event-humans/detach-event-human";
import { leaveEventLineup } from "../../../event-humans/leave-event-lineup";
import { declineOpenCallApplication } from "../decline-open-call-application";
import { dropOutOfOpenCall } from "../drop-out-of-open-call";
import { pickOpenCallApplication } from "../pick-open-call-application";
import { withdrawOpenCallApplication } from "../withdraw-open-call-application";
import { deriveStatusToken } from "../_shared/status-token";
import { DAY, TEST_STATUS_TOKEN_SECRET, addEventDate } from "./open-call-application-helpers";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

function setup() {
  const world = createOpenCallWorld();
  const clock = { now: () => world.now } as unknown as ClockPort;
  const deps = { repos: world.repos, clock };
  return { world, clock, deps };
}

function eventCall(world: OpenCallWorld) {
  const event = world.addEvent();
  const call = world.addForm({ purpose: "PERFORM", eventId: event.id });
  return { event, call };
}

function lineupRow(
  world: OpenCallWorld,
  eventId: string,
  who: {
    humanId?: string;
    orgId?: string;
    externalName?: string;
    externalUrl?: string | null;
    role?: "PERFORMER" | "VOLUNTEER" | "HOST";
  },
  sortOrder = 0,
) {
  const row = {
    id: randomUUID(),
    eventId,
    humanId: who.humanId ?? null,
    orgId: who.orgId ?? null,
    externalName: who.externalName ?? null,
    externalUrl: who.externalUrl ?? null,
    role: who.role ?? ("PERFORMER" as const),
    customRoleLabel: null,
    sortOrder,
    createdAt: OC_NOW,
    updatedAt: OC_NOW,
    profileSlug: null,
    humanDisplayName: null,
  };
  world.lineup.push(row);
  return row;
}

/** A series call with three upcoming nights: one materialised, two not. */
function seriesCall(world: OpenCallWorld) {
  world.addSeries();
  const night1 = world.addEvent({ id: randomUUID(), title: "Night 1" });
  const o1 = world.addOccurrence({
    startsAt: new Date(OC_NOW.getTime() + 2 * DAY),
    eventId: night1.id,
  });
  const o2 = world.addOccurrence({ startsAt: new Date(OC_NOW.getTime() + 9 * DAY) });
  const o3 = world.addOccurrence({ startsAt: new Date(OC_NOW.getTime() + 16 * DAY) });
  // Unmaterialised nights need an end time to be generated (see the
  // endsAt test below).
  o2.endsAt = new Date(o2.startsAt.getTime() + 3 * 60 * 60 * 1000);
  o3.endsAt = new Date(o3.startsAt.getTime() + 3 * 60 * 60 * 1000);
  const call = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
  return { call, night1, o1, o2, o3 };
}

/** Stand-in for `generateEventsFromSeries`: one draft event per night. */
function materializer(world: OpenCallWorld) {
  return vi.fn(async (input: { occurrenceIds: string[] }) => {
    for (const id of input.occurrenceIds) {
      const o = world.occurrences.find((x) => x.id === id)!;
      const e = world.addEvent({ id: randomUUID(), title: "Generated", status: "DRAFT" });
      o.eventId = e.id;
      o.status = "GENERATED";
    }
  });
}

const pickInput = (formId: string, submissionId: string, extra: Record<string, unknown> = {}) => ({
  actorHumanId: OC_EDITOR_ID,
  formId,
  submissionId,
  ...extra,
});

describe("pickOpenCallApplication (FR-016)", () => {
  it("person: APPROVED, one PERFORMER row with humanId at the END of the lineup, openedAt stamped", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    lineupRow(world, event.id, { externalName: "Opener" }, 0);
    lineupRow(world, event.id, { externalName: "Headliner" }, 4);
    const s = world.addSubmission(call.id, "PENDING");
    const notify = vi.fn(async () => undefined);

    const out = await pickOpenCallApplication(
      { ...deps, notifyOpenCallPicked: notify },
      pickInput(call.id, s.id),
    );

    expect(out.status).toBe("APPROVED");
    expect(out.alreadyPicked).toBe(false);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ eventId: event.id, occurrenceId: null, added: true });
    const row = world.lineup.find((r) => r.id === out.rows[0]!.eventHumanId)!;
    expect(row).toMatchObject({ humanId: s.humanId, orgId: null, role: "PERFORMER", sortOrder: 5 });
    expect(s.status).toBe("APPROVED");
    expect(s.reviewerHumanId).toBe(OC_EDITOR_ID);
    expect(s.openedAt).toEqual(OC_NOW);
    expect(world.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["open_call_application_opened", "open_call_application_picked"]),
    );
    expect(world.locks).toContainEqual({ kind: "submission_for_update", id: s.id });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      kind: "open_call_picked",
      firstPick: true,
      eventIds: [event.id],
      addedEventIds: [event.id],
    });
  });

  it("organisation: the row carries orgId only; guest: externalName + externalUrl", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    const org = world.addSubmission(call.id, "PENDING", { applyingAsOrgId: OC_OTHER_ORG_ID });
    const guest = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "  The Moths ",
      guestUrl: "https://moths.example.com",
      contactEmail: "moths@example.com",
    });

    const o = await pickOpenCallApplication(deps, pickInput(call.id, org.id));
    const g = await pickOpenCallApplication(deps, pickInput(call.id, guest.id));

    const orgRow = world.lineup.find((r) => r.id === o.rows[0]!.eventHumanId)!;
    expect(orgRow).toMatchObject({ orgId: OC_OTHER_ORG_ID, humanId: null, externalName: null, sortOrder: 0 });
    const guestRow = world.lineup.find((r) => r.id === g.rows[0]!.eventHumanId)!;
    expect(guestRow).toMatchObject({
      humanId: null,
      orgId: null,
      externalName: "The Moths",
      externalUrl: "https://moths.example.com",
      sortOrder: 1,
    });
    expect(world.lineup.filter((r) => r.eventId === event.id)).toHaveLength(2);
  });

  it("guest with an unsafe URL goes on by name only", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const guest = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "Moths",
      guestUrl: "javascript:alert(1)",
    });
    const out = await pickOpenCallApplication(deps, pickInput(call.id, guest.id));
    expect(world.lineup.find((r) => r.id === out.rows[0]!.eventHumanId)!.externalUrl).toBeNull();
  });

  it("already on the lineup (any role, or a same-named free-text row): records the decision, adds no row", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    const person = world.addSubmission(call.id, "PENDING");
    const existing = { ...lineupRow(world, event.id, { humanId: person.humanId! }), role: "HOST" as const };
    world.lineup.splice(world.lineup.length - 1, 1, existing);
    lineupRow(world, event.id, { externalName: "the moths" });
    const guest = world.addSubmission(call.id, "PENDING", { humanId: null, guestName: "The Moths" });

    const p = await pickOpenCallApplication(deps, pickInput(call.id, person.id));
    const g = await pickOpenCallApplication(deps, pickInput(call.id, guest.id));

    expect(p.rows[0]).toMatchObject({ eventHumanId: existing.id, added: false });
    expect(g.rows[0]!.added).toBe(false);
    expect(person.status).toBe("APPROVED");
    expect(guest.status).toBe("APPROVED");
    expect(world.lineup.filter((r) => r.eventId === event.id)).toHaveLength(2);
  });

  it("idempotent retry: same pick again is success, no new row, no notice", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    const notify = vi.fn(async () => undefined);
    const d = { ...deps, notifyOpenCallPicked: notify };
    await pickOpenCallApplication(d, pickInput(call.id, s.id));
    const again = await pickOpenCallApplication(d, pickInput(call.id, s.id));

    expect(again.alreadyPicked).toBe(true);
    expect(again.rows[0]!.added).toBe(false);
    expect(again.notice).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(world.lineup.filter((r) => r.eventId === event.id)).toHaveLength(1);
    expect(world.audit.filter((a) => a.action === "open_call_application_picked")).toHaveLength(1);
  });

  it("community-listing style event (EventDate rows): one row on the shared lineup, the chosen dates stay on the card", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    const d1 = addEventDate(world, new Date(OC_NOW.getTime() + 3 * DAY));
    const d2 = addEventDate(world, new Date(OC_NOW.getTime() + 4 * DAY));
    const s = world.addSubmission(call.id, "PENDING", {
      dateChoices: [{ eventDateId: d1.id }, { eventDateId: d2.id }],
    });

    const out = await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    expect(out.rows).toEqual([expect.objectContaining({ eventId: event.id, occurrenceId: null })]);
    expect(s.dateChoices).toHaveLength(2);
    // Naming dates on an event call is refused: there is only one lineup.
    const other = world.addSubmission(call.id, "PENDING");
    expect(
      await code(
        pickOpenCallApplication(deps, pickInput(call.id, other.id, { occurrenceIds: [d1.id] })),
      ),
    ).toBe("OPEN_CALL_DATE_INVALID");
  });

  describe("authz and isolation", () => {
    it("needs edit rights: a VIEWER member and a stranger both get not-found (FR-014 as amended: no edit rights, no queue)", async () => {
      const { world, deps } = setup();
      const { call } = eventCall(world);
      const s = world.addSubmission(call.id, "PENDING");
      expect(
        await code(pickOpenCallApplication(deps, { ...pickInput(call.id, s.id), actorHumanId: OC_VIEWER_ID })),
      ).toBe("OPEN_CALL_APPLICATION_NOT_FOUND");
      expect(
        await code(pickOpenCallApplication(deps, { ...pickInput(call.id, s.id), actorHumanId: OC_STRANGER_ID })),
      ).toBe("OPEN_CALL_APPLICATION_NOT_FOUND");
      expect(s.status).toBe("PENDING");
      expect(world.lineup).toHaveLength(0);
    });

    it("a submission of ANOTHER call answers not-found, even for an editor of both", async () => {
      const { world, deps } = setup();
      const { call } = eventCall(world);
      const otherEvent = world.addEvent({ id: randomUUID() });
      const otherCall = world.addForm({ purpose: "PERFORM", eventId: otherEvent.id });
      const s = world.addSubmission(otherCall.id, "PENDING");
      expect(await code(pickOpenCallApplication(deps, pickInput(call.id, s.id)))).toBe(
        "OPEN_CALL_APPLICATION_NOT_FOUND",
      );
      expect(s.status).toBe("PENDING");
    });

    it("an attendee (ATTEND) submission is invisible", async () => {
      const { world, deps } = setup();
      const { event, call } = eventCall(world);
      const attend = world.addForm({ purpose: "ATTEND", eventId: event.id });
      const s = world.addSubmission(attend.id, "PENDING");
      expect(await code(pickOpenCallApplication(deps, pickInput(call.id, s.id)))).toBe(
        "OPEN_CALL_APPLICATION_NOT_FOUND",
      );
    });
  });

  describe("status guards", () => {
    it.each([
      ["WITHDRAWN", "OPEN_CALL_APPLICATION_WITHDRAWN"],
      ["REJECTED", "OPEN_CALL_APPLICATION_DECIDED"],
      ["EXPIRED", "OPEN_CALL_APPLICATION_DECIDED"],
    ] as const)("%s cannot be picked (%s)", async (status, expected) => {
      const { world, deps } = setup();
      const { call } = eventCall(world);
      const s = world.addSubmission(call.id, status);
      expect(await code(pickOpenCallApplication(deps, pickInput(call.id, s.id)))).toBe(expected);
      expect(world.lineup).toHaveLength(0);
    });

    it("WAITLISTED can be picked", async () => {
      const { world, deps } = setup();
      const { call } = eventCall(world);
      const s = world.addSubmission(call.id, "WAITLISTED");
      await pickOpenCallApplication(deps, pickInput(call.id, s.id));
      expect(s.status).toBe("APPROVED");
    });

    it("an APPROVED act later removed from the lineup is not re-picked", async () => {
      const { world, deps } = setup();
      const { call } = eventCall(world);
      const s = world.addSubmission(call.id, "APPROVED", { removedFromLineupAt: OC_NOW });
      expect(await code(pickOpenCallApplication(deps, pickInput(call.id, s.id)))).toBe(
        "OPEN_CALL_APPLICATION_DECIDED",
      );
    });

    it("a cancelled event's call takes no picks", async () => {
      const { world, deps } = setup();
      const event = world.addEvent({ status: "CANCELLED" });
      const call = world.addForm({ purpose: "PERFORM", eventId: event.id });
      const s = world.addSubmission(call.id, "PENDING");
      expect(await code(pickOpenCallApplication(deps, pickInput(call.id, s.id)))).toBe("OPEN_CALL_CLOSED");
    });
  });

  describe("series call", () => {
    it("picks a subset of the chosen nights; materialises a night with no event; one row per night", async () => {
      const { world, deps } = setup();
      const { call, night1, o1, o2, o3 } = seriesCall(world);
      const s = world.addSubmission(call.id, "PENDING", {
        dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }, { occurrenceId: o3.id }],
      });
      const materialize = materializer(world);

      const out = await pickOpenCallApplication(
        { ...deps, materializeSeriesOccurrences: materialize },
        pickInput(call.id, s.id, { occurrenceIds: [o1.id, o2.id] }),
      );

      expect(materialize).toHaveBeenCalledTimes(1);
      expect(materialize.mock.calls[0]![0]).toMatchObject({
        actorHumanId: OC_EDITOR_ID,
        seriesId: OC_SERIES_ID,
        occurrenceIds: [o2.id],
      });
      expect((materialize.mock.calls[0]![0] as { clientKey: string }).clientKey.length).toBeGreaterThanOrEqual(8);
      expect(o2.eventId).not.toBeNull();
      expect(out.rows.map((r) => [r.occurrenceId, r.eventId])).toEqual([
        [o1.id, night1.id],
        [o2.id, o2.eventId],
      ]);
      expect(world.lineup.filter((r) => r.humanId === s.humanId)).toHaveLength(2);
      expect(o3.eventId).toBeNull();
    });

    it("validates the subset: required, only chosen nights, only live upcoming nights", async () => {
      const { world, deps } = setup();
      const { call, o1, o2 } = seriesCall(world);
      const past = world.addOccurrence({ startsAt: new Date(OC_NOW.getTime() - DAY), eventId: randomUUID() });
      const s = world.addSubmission(call.id, "PENDING", {
        dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: past.id }],
      });
      const d = { ...deps, materializeSeriesOccurrences: materializer(world) };
      expect(await code(pickOpenCallApplication(d, pickInput(call.id, s.id)))).toBe("OPEN_CALL_DATES_REQUIRED");
      expect(
        await code(pickOpenCallApplication(d, pickInput(call.id, s.id, { occurrenceIds: [o2.id] }))),
      ).toBe("OPEN_CALL_DATE_INVALID");
      expect(
        await code(pickOpenCallApplication(d, pickInput(call.id, s.id, { occurrenceIds: [past.id] }))),
      ).toBe("OPEN_CALL_DATE_UNAVAILABLE");
      expect(s.status).toBe("PENDING");
      expect(world.lineup).toHaveLength(0);
    });

    it("a night needing materialisation with the seam unwired is refused before anything is written", async () => {
      const { world, deps } = setup();
      const { call, o2 } = seriesCall(world);
      const s = world.addSubmission(call.id, "PENDING", { dateChoices: [{ occurrenceId: o2.id }] });
      expect(
        await code(pickOpenCallApplication(deps, pickInput(call.id, s.id, { occurrenceIds: [o2.id] }))),
      ).toBe("NOT_CONFIGURED");
      expect(s.status).toBe("PENDING");
    });

    it("retry naming more chosen nights adds rows for the new ones only", async () => {
      const { world, deps } = setup();
      const { call, night1, o1, o2 } = seriesCall(world);
      const s = world.addSubmission(call.id, "PENDING", {
        dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }],
      });
      const notify = vi.fn(async () => undefined);
      const d = { ...deps, materializeSeriesOccurrences: materializer(world), notifyOpenCallPicked: notify };
      await pickOpenCallApplication(d, pickInput(call.id, s.id, { occurrenceIds: [o1.id] }));
      const more = await pickOpenCallApplication(d, pickInput(call.id, s.id, { occurrenceIds: [o1.id, o2.id] }));

      expect(more.alreadyPicked).toBe(true);
      expect(more.rows.map((r) => r.added)).toEqual([false, true]);
      expect(more.notice).toMatchObject({ firstPick: false, addedEventIds: [o2.eventId] });
      expect(notify).toHaveBeenCalledTimes(2);
      expect(world.lineup.filter((r) => r.eventId === night1.id)).toHaveLength(1);
      expect(world.audit.map((a) => a.action)).toContain("open_call_application_pick_extended");
    });

    it("series edit rights: an org VIEWER is refused with not-found", async () => {
      const { world, deps } = setup();
      const { call, o1 } = seriesCall(world);
      const s = world.addSubmission(call.id, "PENDING", { dateChoices: [{ occurrenceId: o1.id }] });
      expect(
        await code(
          pickOpenCallApplication(deps, {
            ...pickInput(call.id, s.id, { occurrenceIds: [o1.id] }),
            actorHumanId: OC_VIEWER_ID,
          }),
        ),
      ).toBe("OPEN_CALL_APPLICATION_NOT_FOUND");
    });
  });

  it("a throwing notifier AND a throwing reporter never undo the pick", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    const out = await pickOpenCallApplication(
      {
        ...deps,
        reportError,
        notifyOpenCallPicked: vi.fn(async () => {
          throw new Error("mail down");
        }),
      },
      pickInput(call.id, s.id),
    );
    expect(out.status).toBe("APPROVED");
    expect(s.status).toBe("APPROVED");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "mail down" }),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "pickOpenCallApplication", reason: "notice_failed" }),
      }),
    );
  });
});

describe("declineOpenCallApplication (FR-018)", () => {
  it("REJECTED with a sanitised note, openedAt stamped, applicant told", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    const notify = vi.fn(async () => undefined);
    const out = await declineOpenCallApplication(
      { ...deps, notifyOpenCallNotThisTime: notify },
      { ...pickInput(call.id, s.id), decisionReason: "  Full lineup\u0007 this month  " },
    );
    expect(out).toMatchObject({ status: "REJECTED", alreadyDeclined: false });
    expect(s.status).toBe("REJECTED");
    expect(s.decisionReason).toBe("Full lineup this month");
    expect(s.openedAt).toEqual(OC_NOW);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open_call_not_this_time", decisionReason: "Full lineup this month" }),
    );
  });

  it("note is optional and bounded", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    expect(
      await code(declineOpenCallApplication(deps, { ...pickInput(call.id, s.id), decisionReason: "x".repeat(501) })),
    ).toBe("invalid_input");
    await declineOpenCallApplication(deps, pickInput(call.id, s.id));
    expect(s.decisionReason).toBeNull();
  });

  it("idempotent: an already-REJECTED application (decline or sweep) is success, note kept, no notice", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "REJECTED", { decisionReason: "first" });
    const notify = vi.fn(async () => undefined);
    const out = await declineOpenCallApplication(
      { ...deps, notifyOpenCallNotThisTime: notify },
      { ...pickInput(call.id, s.id), decisionReason: "second" },
    );
    expect(out.alreadyDeclined).toBe(true);
    expect(s.decisionReason).toBe("first");
    expect(notify).not.toHaveBeenCalled();
  });

  it("APPROVED cannot be declined; WITHDRAWN answers withdrawn", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const approved = world.addSubmission(call.id, "APPROVED");
    const withdrawn = world.addSubmission(call.id, "WITHDRAWN");
    expect(await code(declineOpenCallApplication(deps, pickInput(call.id, approved.id)))).toBe(
      "OPEN_CALL_APPLICATION_DECIDED",
    );
    expect(await code(declineOpenCallApplication(deps, pickInput(call.id, withdrawn.id)))).toBe(
      "OPEN_CALL_APPLICATION_WITHDRAWN",
    );
    expect(approved.status).toBe("APPROVED");
  });

  it("needs edit rights; cross-call refused", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    expect(
      await code(declineOpenCallApplication(deps, { ...pickInput(call.id, s.id), actorHumanId: OC_VIEWER_ID })),
    ).toBe("OPEN_CALL_APPLICATION_NOT_FOUND");
    const otherCall = world.addForm({ purpose: "PERFORM", eventId: world.addEvent({ id: randomUUID() }).id });
    expect(await code(declineOpenCallApplication(deps, pickInput(otherCall.id, s.id)))).toBe(
      "OPEN_CALL_APPLICATION_NOT_FOUND",
    );
    expect(s.status).toBe("PENDING");
  });

  it("a throwing notifier and reporter leave the decision standing", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    await declineOpenCallApplication(
      {
        ...deps,
        reportError,
        notifyOpenCallNotThisTime: vi.fn(async () => {
          throw new Error("mail down");
        }),
      },
      pickInput(call.id, s.id),
    );
    expect(s.status).toBe("REJECTED");
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("dropOutOfOpenCall (FR-017, status link / session)", () => {
  it("guest by token: removes their row, WITHDRAWN + droppedOutAt, organizer side told", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "The Moths",
      statusTokenHash: hash,
    });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const other = lineupRow(world, event.id, { externalName: "Someone Else" });
    const notify = vi.fn(async () => undefined);

    const out = await dropOutOfOpenCall(
      { ...deps, notifyOpenCallDroppedOut: notify },
      { auth: { kind: "token", token } },
    );

    expect(out).toMatchObject({ status: "WITHDRAWN", alreadyDroppedOut: false });
    expect(out.removedEventHumanIds).toHaveLength(1);
    expect(world.lineup.map((r) => r.id)).toEqual([other.id]);
    expect(s.status).toBe("WITHDRAWN");
    expect(s.droppedOutAt).toEqual(OC_NOW);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open_call_dropped_out", via: "status_link", removedEventIds: [event.id] }),
    );

    const again = await dropOutOfOpenCall(deps, { auth: { kind: "token", token } });
    expect(again.alreadyDroppedOut).toBe(true);
  });

  it("organisation by token: removes the org's rows on every picked series night", async () => {
    const { world, deps } = setup();
    const { call, o1, o2 } = seriesCall(world);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", {
      applyingAsOrgId: OC_OTHER_ORG_ID,
      statusTokenHash: hash,
      dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }],
    });
    await pickOpenCallApplication(
      { ...deps, materializeSeriesOccurrences: materializer(world) },
      pickInput(call.id, s.id, { occurrenceIds: [o1.id, o2.id] }),
    );
    expect(world.lineup.filter((r) => r.orgId === OC_OTHER_ORG_ID)).toHaveLength(2);

    const out = await dropOutOfOpenCall(deps, { auth: { kind: "token", token } });
    expect(out.removedEventHumanIds).toHaveLength(2);
    expect(world.lineup.filter((r) => r.orgId === OC_OTHER_ORG_ID)).toHaveLength(0);
    expect(s.status).toBe("WITHDRAWN");
  });

  it("the submitting human's session works for an org application while it holds an edit role", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const submitter = randomUUID();
    world.memberships.set(`${OC_OTHER_ORG_ID}:${submitter}`, "EDITOR");
    const s = world.addSubmission(call.id, "PENDING", { humanId: submitter, applyingAsOrgId: OC_OTHER_ORG_ID });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const out = await dropOutOfOpenCall(deps, {
      auth: { kind: "session", actorHumanId: submitter, submissionId: s.id },
    });
    expect(out.status).toBe("WITHDRAWN");
    expect(world.lineup.filter((r) => r.orgId === OC_OTHER_ORG_ID)).toHaveLength(0);
  });

  it("ANY org edit member may drop out an org application (owner ruling 2026-10-07); VIEWER, SCANNER, FINANCE, an ex-member and another org may not", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const submitter = randomUUID();
    const editor = randomUUID();
    const viewer = randomUUID();
    const scanner = randomUUID();
    const finance = randomUUID();
    const otherOrgEditor = randomUUID();
    world.memberships.set(`${OC_OTHER_ORG_ID}:${editor}`, "EDITOR");
    world.memberships.set(`${OC_OTHER_ORG_ID}:${viewer}`, "VIEWER");
    world.memberships.set(`${OC_OTHER_ORG_ID}:${scanner}`, "SCANNER");
    world.memberships.set(`${OC_OTHER_ORG_ID}:${finance}`, "FINANCE");
    world.memberships.set(`${OC_ORG_ID}:${otherOrgEditor}`, "EDITOR");
    // The submitter has left the org (no membership row).
    const s = world.addSubmission(call.id, "PENDING", { humanId: submitter, applyingAsOrgId: OC_OTHER_ORG_ID });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const as = (actorHumanId: string) =>
      code(dropOutOfOpenCall(deps, { auth: { kind: "session", actorHumanId, submissionId: s.id } }));
    for (const refused of [viewer, scanner, finance, otherOrgEditor, submitter]) {
      expect(await as(refused)).toBe("OPEN_CALL_APPLICATION_NOT_FOUND");
    }
    expect(s.status).toBe("APPROVED");
    expect(await as(editor)).toBe("resolved");
    expect(s.status).toBe("WITHDRAWN");
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        action: "open_call_application_dropped_out",
        data: expect.objectContaining({ actorHumanId: editor, via: "session" }),
      }),
    );
  });

  it("only a picked application drops out: PENDING is refused (it withdraws instead)", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", { humanId: null, guestName: "G", statusTokenHash: hash });
    expect(await code(dropOutOfOpenCall(deps, { auth: { kind: "token", token } }))).toBe(
      "OPEN_CALL_APPLICATION_NOT_PICKED",
    );
    await withdrawOpenCallApplication(deps, { auth: { kind: "token", token } });
    // A plain withdraw is not a drop out either.
    expect(await code(dropOutOfOpenCall(deps, { auth: { kind: "token", token } }))).toBe(
      "OPEN_CALL_APPLICATION_NOT_PICKED",
    );
    expect(s.droppedOutAt).toBeNull();
  });

  it("withdraw of a picked application stays refused (drop out is the path)", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", { humanId: null, guestName: "G", statusTokenHash: hash });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    expect(await code(withdrawOpenCallApplication(deps, { auth: { kind: "token", token } }))).toBe(
      "OPEN_CALL_APPLICATION_DECIDED",
    );
  });
});

describe("leaveEventLineup marks the open-call application (FR-017)", () => {
  const leaveDeps = (world: OpenCallWorld, clock: ClockPort, extra: Record<string, unknown> = {}) => ({
    repos: {
      ...(world.repos as unknown as Record<string, unknown>),
      agreements: { findByLinkedEventId: async () => null },
      volunteering: { listSignupsByHuman: async () => [] },
    } as unknown as Repos,
    clock,
    ...extra,
  });

  it("a picked person leaving: row gone, WITHDRAWN + droppedOutAt in the same transaction, seam called", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const notify = vi.fn(async () => undefined);

    await leaveEventLineup(leaveDeps(world, clock, { notifyOpenCallDroppedOut: notify }) as never, {
      actorHumanId: s.humanId!,
      eventId: event.id,
    });

    expect(world.lineup).toHaveLength(0);
    expect(s.status).toBe("WITHDRAWN");
    expect(s.droppedOutAt).toEqual(OC_NOW);
    expect(world.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["left_lineup", "open_call_application_dropped_out"]),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open_call_dropped_out", via: "lineup_leave", submissionId: s.id }),
    );
  });

  it("series: leaving ONE of two picked nights keeps the application APPROVED; leaving the last marks it", async () => {
    const { world, clock, deps } = setup();
    const { call, night1, o1, o2 } = seriesCall(world);
    const s = world.addSubmission(call.id, "PENDING", {
      dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }],
    });
    await pickOpenCallApplication(
      { ...deps, materializeSeriesOccurrences: materializer(world) },
      pickInput(call.id, s.id, { occurrenceIds: [o1.id, o2.id] }),
    );

    await leaveEventLineup(leaveDeps(world, clock) as never, { actorHumanId: s.humanId!, eventId: night1.id });
    expect(s.status).toBe("APPROVED");
    await leaveEventLineup(leaveDeps(world, clock) as never, { actorHumanId: s.humanId!, eventId: o2.eventId! });
    expect(s.status).toBe("WITHDRAWN");
    expect(s.droppedOutAt).toEqual(OC_NOW);
  });

  it("a person who was never picked leaves as before; their application is untouched", async () => {
    const { world, clock } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    lineupRow(world, event.id, { humanId: s.humanId! });
    await leaveEventLineup(leaveDeps(world, clock) as never, { actorHumanId: s.humanId!, eventId: event.id });
    expect(s.status).toBe("PENDING");
    expect(world.lineup).toHaveLength(0);
  });

  it("a throwing seam and reporter never undo the leave", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    await leaveEventLineup(
      leaveDeps(world, clock, {
        reportError,
        notifyOpenCallDroppedOut: vi.fn(async () => {
          throw new Error("seam down");
        }),
      }) as never,
      { actorHumanId: s.humanId!, eventId: event.id },
    );
    expect(s.status).toBe("WITHDRAWN");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "seam down" }),
      expect.objectContaining({ tags: expect.objectContaining({ useCase: "leaveEventLineup" }) }),
    );
  });
});

describe("detachEventHuman stamps removedFromLineupAt (FR-019)", () => {
  const detachDeps = (world: OpenCallWorld, clock: ClockPort) => ({
    repos: world.repos,
    authz: { hasStaffRole: async () => ({ allowed: false }) },
    clock,
  });

  it("removing a picked act keeps APPROVED and records removedFromLineupAt", async () => {
    const { world, clock, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING", { humanId: null, guestName: "The Moths" });
    const picked = await pickOpenCallApplication(deps, pickInput(call.id, s.id));

    await detachEventHuman(detachDeps(world, clock) as never, {
      actorHumanId: OC_EDITOR_ID,
      eventHumanId: picked.rows[0]!.eventHumanId,
    });

    expect(world.lineup).toHaveLength(0);
    expect(s.status).toBe("APPROVED");
    expect(s.removedFromLineupAt).toEqual(OC_NOW);
    expect(world.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["detached", "open_call_application_removed_from_lineup"]),
    );
  });

  it("series: removing one of two picked nights does not stamp; removing the last does", async () => {
    const { world, clock, deps } = setup();
    const { call, o1, o2 } = seriesCall(world);
    const s = world.addSubmission(call.id, "PENDING", {
      applyingAsOrgId: OC_OTHER_ORG_ID,
      dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }],
    });
    const picked = await pickOpenCallApplication(
      { ...deps, materializeSeriesOccurrences: materializer(world) },
      pickInput(call.id, s.id, { occurrenceIds: [o1.id, o2.id] }),
    );
    await detachEventHuman(detachDeps(world, clock) as never, {
      actorHumanId: OC_EDITOR_ID,
      eventHumanId: picked.rows[0]!.eventHumanId,
    });
    expect(s.removedFromLineupAt ?? null).toBeNull();
    await detachEventHuman(detachDeps(world, clock) as never, {
      actorHumanId: OC_EDITOR_ID,
      eventHumanId: picked.rows[1]!.eventHumanId,
    });
    expect(s.removedFromLineupAt).toEqual(OC_NOW);
    expect(s.status).toBe("APPROVED");
  });

  it("removing an unrelated row touches no application", async () => {
    const { world, clock } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "APPROVED");
    const row = lineupRow(world, event.id, { externalName: "Someone Else" });
    await detachEventHuman(detachDeps(world, clock) as never, { actorHumanId: OC_EDITOR_ID, eventHumanId: row.id });
    expect(s.removedFromLineupAt ?? null).toBeNull();
  });
});

// ── Review round 1 (step 6) ──────────────────────────────────────────────────

/** leaveEventLineup / person drop-out deps over the fake world. */
function leaveWorldDeps(world: OpenCallWorld, clock: ClockPort, extra: Record<string, unknown> = {}) {
  return {
    repos: {
      ...(world.repos as unknown as Record<string, unknown>),
      agreements: { findByLinkedEventId: async () => null },
      volunteering: { listSignupsByHuman: async () => [] },
    } as unknown as Repos,
    clock,
    ...extra,
  };
}

describe("PERFORMER-only removal and 'anything left?' (finding 1)", () => {
  it("guest drop-out leaves a same-named VOLUNTEER row alone", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", { humanId: null, guestName: "The Moths", statusTokenHash: hash });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const volunteer = lineupRow(world, event.id, { externalName: "The Moths", role: "VOLUNTEER" });

    const out = await dropOutOfOpenCall(deps as never, { auth: { kind: "token", token } });

    expect(out.removedEventHumanIds).toHaveLength(1);
    expect(world.lineup.map((r) => r.id)).toEqual([volunteer.id]);
    expect(s.status).toBe("WITHDRAWN");
  });

  it("person drop-out on a series removes the PERFORMER row, keeps their VOLUNTEER row on another chosen night", async () => {
    const { world, clock, deps } = setup();
    const { call, night1, o1, o2 } = seriesCall(world);
    const s = world.addSubmission(call.id, "PENDING", {
      dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }],
    });
    const materialize = materializer(world);
    await materialize({ occurrenceIds: [o2.id] });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id, { occurrenceIds: [o1.id] }));
    const volunteer = lineupRow(world, o2.eventId!, { humanId: s.humanId!, role: "VOLUNTEER" });

    await dropOutOfOpenCall(leaveWorldDeps(world, clock) as never, {
      auth: { kind: "session", actorHumanId: s.humanId!, submissionId: s.id },
    });

    expect(world.lineup.filter((r) => r.eventId === night1.id)).toHaveLength(0);
    expect(world.lineup.map((r) => r.id)).toEqual([volunteer.id]);
    expect(s.status).toBe("WITHDRAWN");
  });

  it("leaving the last PERFORMER night settles WITHDRAWN even with a VOLUNTEER row on another chosen night", async () => {
    const { world, clock, deps } = setup();
    const { call, night1, o1, o2 } = seriesCall(world);
    const s = world.addSubmission(call.id, "PENDING", {
      dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }],
    });
    await materializer(world)({ occurrenceIds: [o2.id] });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id, { occurrenceIds: [o1.id] }));
    lineupRow(world, o2.eventId!, { humanId: s.humanId!, role: "VOLUNTEER" });

    await leaveEventLineup(leaveWorldDeps(world, clock) as never, { actorHumanId: s.humanId!, eventId: night1.id });

    expect(s.status).toBe("WITHDRAWN");
    expect(s.droppedOutAt).toEqual(OC_NOW);
  });

  it("detach of the last PERFORMER night stamps removedFromLineupAt even with a VOLUNTEER row on another chosen night", async () => {
    const { world, clock, deps } = setup();
    const { call, o1, o2 } = seriesCall(world);
    const s = world.addSubmission(call.id, "PENDING", {
      dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }],
    });
    await materializer(world)({ occurrenceIds: [o2.id] });
    const picked = await pickOpenCallApplication(deps, pickInput(call.id, s.id, { occurrenceIds: [o1.id] }));
    lineupRow(world, o2.eventId!, { humanId: s.humanId!, role: "VOLUNTEER" });

    await detachEventHuman(
      { repos: world.repos, authz: { hasStaffRole: async () => ({ allowed: false }) }, clock } as never,
      { actorHumanId: OC_EDITOR_ID, eventHumanId: picked.rows[0]!.eventHumanId },
    );

    expect(s.status).toBe("APPROVED");
    expect(s.removedFromLineupAt).toEqual(OC_NOW);
  });
});

describe("guest identity = PERFORMER + name + url (finding 2)", () => {
  it("an unrelated 'Sam' row with another url, or none, is neither reused nor deleted", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    const otherUrl = lineupRow(world, event.id, { externalName: "Sam", externalUrl: "https://other.example.com" });
    const noUrl = lineupRow(world, event.id, { externalName: " sam " }, 1);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "Sam",
      guestUrl: "https://sam.example.com",
      statusTokenHash: hash,
    });

    const picked = await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    expect(picked.rows[0]!.added).toBe(true);
    expect(world.lineup).toHaveLength(3);

    await dropOutOfOpenCall(deps as never, { auth: { kind: "token", token } });
    expect(world.lineup.map((r) => r.id).sort()).toEqual([otherUrl.id, noUrl.id].sort());
  });

  it("a PERFORMER row with the same name and url IS the guest (reused, no new row)", async () => {
    const { world, deps } = setup();
    const { event, call } = eventCall(world);
    const same = lineupRow(world, event.id, { externalName: "SAM", externalUrl: " https://sam.example.com " });
    const s = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "Sam",
      guestUrl: "https://sam.example.com",
    });
    const picked = await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    expect(picked.rows[0]).toMatchObject({ eventHumanId: same.id, added: false });
  });

  it("removing an unrelated same-named row does not stamp the guest's application", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "Sam",
      guestUrl: "https://sam.example.com",
    });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const stranger = lineupRow(world, event.id, { externalName: "Sam" }, 7);
    await detachEventHuman(
      { repos: world.repos, authz: { hasStaffRole: async () => ({ allowed: false }) }, clock } as never,
      { actorHumanId: OC_EDITOR_ID, eventHumanId: stranger.id },
    );
    expect(s.removedFromLineupAt ?? null).toBeNull();
  });
});

describe("pick and time / Close (findings 3, 4, 9)", () => {
  it("event call: refused once the event has started", async () => {
    const { world, deps } = setup();
    const event = world.addEvent({
      startsAt: new Date(OC_NOW.getTime() - 60 * 60 * 1000),
      endsAt: new Date(OC_NOW.getTime() + 60 * 60 * 1000),
    });
    const call = world.addForm({ purpose: "PERFORM", eventId: event.id });
    const s = world.addSubmission(call.id, "PENDING");
    expect(await code(pickOpenCallApplication(deps, pickInput(call.id, s.id)))).toBe("OPEN_CALL_CLOSED");
    expect(s.status).toBe("PENDING");
  });

  it("multi-date event: allowed while a date is upcoming, refused once the LAST date has started", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    addEventDate(world, new Date(OC_NOW.getTime() - 2 * DAY));
    const last = addEventDate(world, new Date(OC_NOW.getTime() + 2 * DAY));
    const a = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, a.id));
    expect(a.status).toBe("APPROVED");
    last.startsAt = new Date(OC_NOW.getTime() - DAY);
    const b = world.addSubmission(call.id, "PENDING");
    expect(await code(pickOpenCallApplication(deps, pickInput(call.id, b.id)))).toBe("OPEN_CALL_CLOSED");
  });

  it("pick vs close: after Close a swept PENDING is decided, a WAITLISTED act may still be picked", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const pending = world.addSubmission(call.id, "PENDING");
    const waitlisted = world.addSubmission(call.id, "WAITLISTED");
    const { closeOpenCall } = await import("../close-open-call");
    await closeOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(pending.status).toBe("REJECTED");

    expect(await code(pickOpenCallApplication(deps, pickInput(call.id, pending.id)))).toBe(
      "OPEN_CALL_APPLICATION_DECIDED",
    );
    const out = await pickOpenCallApplication(deps, pickInput(call.id, waitlisted.id));
    expect(out.status).toBe("APPROVED");
  });

  it("a chosen night whose materialised event was CANCELLED is refused (occurrence still reads live)", async () => {
    const { world, deps } = setup();
    const { call, night1, o1 } = seriesCall(world);
    world.events.get(night1.id)!.status = "CANCELLED";
    const s = world.addSubmission(call.id, "PENDING", { dateChoices: [{ occurrenceId: o1.id }] });
    expect(
      await code(
        pickOpenCallApplication(
          { ...deps, materializeSeriesOccurrences: materializer(world) },
          pickInput(call.id, s.id, { occurrenceIds: [o1.id] }),
        ),
      ),
    ).toBe("OPEN_CALL_DATE_UNAVAILABLE");
    expect(s.status).toBe("PENDING");
  });

  it("a chosen unmaterialised night with no end time is refused before the materialise seam runs", async () => {
    const { world, deps } = setup();
    const { call, o2 } = seriesCall(world);
    o2.endsAt = null;
    const s = world.addSubmission(call.id, "PENDING", { dateChoices: [{ occurrenceId: o2.id }] });
    const materialize = materializer(world);
    expect(
      await code(
        pickOpenCallApplication(
          { ...deps, materializeSeriesOccurrences: materialize },
          pickInput(call.id, s.id, { occurrenceIds: [o2.id] }),
        ),
      ),
    ).toBe("OPEN_CALL_DATE_UNAVAILABLE");
    expect(materialize).not.toHaveBeenCalled();
    expect(s.status).toBe("PENDING");
  });
});

describe("a person's drop-out runs the leave semantics (finding 6)", () => {
  it("session drop-out: passes the booking act, clears the cooldown, sends no lineup-left", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));

    const notify = vi.fn(async () => ({ ok: true, email: { status: "sent" } }));
    const passBookingRequestAct = vi.fn(async () => ({ changed: true, confirmation: "DECLINED" }));
    const clearCooldown = vi.fn(async () => undefined);
    const dropDeps = {
      repos: {
        ...(world.repos as unknown as Record<string, unknown>),
        agreements: { findByLinkedEventId: async () => ({ id: "agreement-1" }) },
        bookingRequests: {
          findByAgreementId: async () => ({ id: "request-1", direction: "TO_VENUE" }),
          getActForOwner: async () => ({ id: "act-1", source: "TAGGED", confirmation: "CONFIRMED" }),
        },
        organizations: {
          getById: async (id: string) => ({ id, name: "Org", slug: "org" }),
          listMembers: async () => ({ items: [{ humanId: OC_EDITOR_ID, role: "ADMIN" }], total: 1 }),
        },
        volunteering: { listSignupsByHuman: async () => [] },
      } as unknown as Repos,
      clock,
      notify,
      publicAppUrl: "https://ithasfire.com",
      passBookingRequestAct,
      lineupNotices: { clearCooldown },
      notifyOpenCallDroppedOut: vi.fn(async () => undefined),
    };

    await dropOutOfOpenCall(dropDeps as never, {
      auth: { kind: "session", actorHumanId: s.humanId!, submissionId: s.id },
    });

    expect(world.lineup).toHaveLength(0);
    expect(s.status).toBe("WITHDRAWN");
    expect(world.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["left_lineup", "open_call_application_dropped_out"]),
    );
    expect(clearCooldown).toHaveBeenCalledWith({ eventId: event.id, humanId: s.humanId });
    // ONE notice per editor: the dropped-out seam, never lineup-left.
    expect(notify).not.toHaveBeenCalled();
    expect(passBookingRequestAct).toHaveBeenCalledWith(
      { actorHumanId: s.humanId, bookingRequestId: "request-1" },
      expect.objectContaining({ onlyWhileEventUpcoming: { eventId: event.id } }),
    );
  });

  it("an org's drop-out keeps the plain status-link path (no leave side effects)", async () => {
    const { world, deps } = setup();
    const { call } = eventCall(world);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", { applyingAsOrgId: OC_OTHER_ORG_ID, statusTokenHash: hash });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const notify = vi.fn();
    await dropOutOfOpenCall({ ...deps, notify } as never, { auth: { kind: "token", token } });
    expect(notify).not.toHaveBeenCalled();
    expect(world.audit.map((a) => a.action)).not.toContain("left_lineup");
  });
});

describe("person applied AS AN ORG (finding 9)", () => {
  it("leaving their own row as themselves leaves the org's application untouched", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const person = randomUUID();
    const s = world.addSubmission(call.id, "PENDING", { humanId: person, applyingAsOrgId: OC_OTHER_ORG_ID });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    lineupRow(world, event.id, { humanId: person }, 3);

    await leaveEventLineup(leaveWorldDeps(world, clock) as never, { actorHumanId: person, eventId: event.id });

    expect(s.status).toBe("APPROVED");
    expect(s.droppedOutAt).toBeNull();
    expect(world.lineup.filter((r) => r.orgId === OC_OTHER_ORG_ID)).toHaveLength(1);
  });
});

// ── Re-review (step 6): one notice per editor, token vs booking, stale rows ──

/** Leave / drop-out deps with every aftermath effect spied. */
function spiedLeaveDeps(world: OpenCallWorld, clock: ClockPort, extra: Record<string, unknown> = {}) {
  const notify = vi.fn(async () => ({ ok: true, email: { status: "sent" } }));
  const passBookingRequestAct = vi.fn(async () => ({ changed: true, confirmation: "DECLINED" }));
  const clearCooldown = vi.fn(async () => undefined);
  const notifyOpenCallDroppedOut = vi.fn(async () => undefined);
  const reportError = vi.fn();
  const deps = {
    repos: {
      ...(world.repos as unknown as Record<string, unknown>),
      agreements: { findByLinkedEventId: async () => ({ id: "agreement-1" }) },
      bookingRequests: {
        findByAgreementId: async () => ({ id: "request-1", direction: "TO_VENUE" }),
        getActForOwner: async () => ({ id: "act-1", source: "TAGGED", confirmation: "CONFIRMED" }),
      },
      organizations: {
        getById: async (id: string) => ({ id, name: "Org", slug: "org" }),
        listMembers: async () => ({ items: [{ humanId: OC_EDITOR_ID, role: "ADMIN" }], total: 1 }),
      },
      volunteering: { listSignupsByHuman: async () => [] },
    } as unknown as Repos,
    clock,
    notify,
    publicAppUrl: "https://ithasfire.com",
    passBookingRequestAct,
    lineupNotices: { clearCooldown },
    notifyOpenCallDroppedOut,
    reportError,
    ...extra,
  };
  return { deps, notify, passBookingRequestAct, clearCooldown, notifyOpenCallDroppedOut, reportError };
}

const lineupLeftCalls = (notify: ReturnType<typeof vi.fn>) =>
  notify.mock.calls.filter((c) => (c[0] as { variant?: string }).variant === "event.lineup-left");

/** A person picked for all three nights of a series call. */
async function threeNightPick(world: OpenCallWorld, deps: { repos: Repos; clock: ClockPort }, extra = {}) {
  const { call, night1, o1, o2, o3 } = seriesCall(world);
  const s = world.addSubmission(call.id, "PENDING", {
    dateChoices: [{ occurrenceId: o1.id }, { occurrenceId: o2.id }, { occurrenceId: o3.id }],
    ...extra,
  });
  await pickOpenCallApplication(
    { ...deps, materializeSeriesOccurrences: materializer(world) },
    pickInput(call.id, s.id, { occurrenceIds: [o1.id, o2.id, o3.id] }),
  );
  return { s, nights: [night1.id, o2.eventId!, o3.eventId!] };
}

describe("ONE notice per editor (re-review 1)", () => {
  it("3-night series drop-out: aftermath x3, zero lineup-left, exactly one dropped-out", async () => {
    const { world, clock, deps } = setup();
    const { s, nights } = await threeNightPick(world, deps);
    const spy = spiedLeaveDeps(world, clock);

    await dropOutOfOpenCall(spy.deps as never, {
      auth: { kind: "session", actorHumanId: s.humanId!, submissionId: s.id },
    });

    expect(world.lineup).toHaveLength(0);
    expect(spy.clearCooldown).toHaveBeenCalledTimes(3);
    expect(spy.clearCooldown.mock.calls.map((c) => (c[0] as { eventId: string }).eventId).sort()).toEqual(
      [...nights].sort(),
    );
    expect(spy.passBookingRequestAct).toHaveBeenCalledTimes(3);
    expect(lineupLeftCalls(spy.notify)).toHaveLength(0);
    expect(spy.notifyOpenCallDroppedOut).toHaveBeenCalledTimes(1);
    expect(world.audit.filter((a) => a.action === "left_lineup")).toHaveLength(3);
  });

  it("leaving the last picked night: dropped-out only, no lineup-left", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const spy = spiedLeaveDeps(world, clock);

    await leaveEventLineup(spy.deps as never, { actorHumanId: s.humanId!, eventId: event.id });

    expect(s.status).toBe("WITHDRAWN");
    expect(lineupLeftCalls(spy.notify)).toHaveLength(0);
    expect(spy.notifyOpenCallDroppedOut).toHaveBeenCalledTimes(1);
    expect(spy.clearCooldown).toHaveBeenCalledTimes(1);
    expect(spy.passBookingRequestAct).toHaveBeenCalledTimes(1);
  });

  it("partial series leave: lineup-left only, no dropped-out", async () => {
    const { world, clock, deps } = setup();
    const { s, nights } = await threeNightPick(world, deps);
    const spy = spiedLeaveDeps(world, clock);

    await leaveEventLineup(spy.deps as never, { actorHumanId: s.humanId!, eventId: nights[0]! });

    expect(s.status).toBe("APPROVED");
    expect(lineupLeftCalls(spy.notify)).toHaveLength(1);
    expect(spy.notifyOpenCallDroppedOut).not.toHaveBeenCalled();
  });

  it("ordinary (non-open-call) leave: lineup-left as before, no dropped-out", async () => {
    const { world, clock } = setup();
    const { event } = eventCall(world);
    const person = randomUUID();
    lineupRow(world, event.id, { humanId: person });
    const spy = spiedLeaveDeps(world, clock);

    await leaveEventLineup(spy.deps as never, { actorHumanId: person, eventId: event.id });

    expect(lineupLeftCalls(spy.notify)).toHaveLength(1);
    expect(spy.notifyOpenCallDroppedOut).not.toHaveBeenCalled();
    expect(spy.passBookingRequestAct).toHaveBeenCalledTimes(1);
  });
});

describe("a token never passes a booking act (re-review 2)", () => {
  it("token drop-out of a person: rows go, cooldown clears, the booking act is NOT passed", async () => {
    const { world, clock, deps } = setup();
    const { call } = eventCall(world);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", { statusTokenHash: hash });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const spy = spiedLeaveDeps(world, clock);

    await dropOutOfOpenCall(spy.deps as never, { auth: { kind: "token", token } });

    expect(s.status).toBe("WITHDRAWN");
    expect(world.lineup).toHaveLength(0);
    expect(spy.clearCooldown).toHaveBeenCalledTimes(1);
    expect(spy.passBookingRequestAct).not.toHaveBeenCalled();
    expect(spy.notifyOpenCallDroppedOut).toHaveBeenCalledWith(
      expect.objectContaining({ via: "status_link" }),
    );
  });

  it("session drop-out of a person: the booking act IS passed", async () => {
    const { world, clock, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const spy = spiedLeaveDeps(world, clock);

    await dropOutOfOpenCall(spy.deps as never, {
      auth: { kind: "session", actorHumanId: s.humanId!, submissionId: s.id },
    });

    expect(spy.passBookingRequestAct).toHaveBeenCalledTimes(1);
  });
});

describe("stale row after the lock (re-review 3)", () => {
  /** Delete `rowId` the moment the pick lock is taken (a concurrent winner). */
  function deleteOnLock(world: OpenCallWorld, rowId: string) {
    const apps = (world.repos as unknown as { eventApplications: Record<string, unknown> }).eventApplications;
    const orig = apps.lockOpenCallSubmissionsByAct as (i: unknown) => Promise<unknown>;
    apps.lockOpenCallSubmissionsByAct = async (input: unknown) => {
      const i = world.lineup.findIndex((r) => r.id === rowId);
      if (i >= 0) world.lineup.splice(i, 1);
      return orig(input);
    };
  }

  it("leave: a row gone by the time the lock is held answers EVENT_HUMAN_NOT_FOUND", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    const picked = await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    deleteOnLock(world, picked.rows[0]!.eventHumanId);
    expect(
      await code(leaveEventLineup(leaveWorldDeps(world, clock) as never, { actorHumanId: s.humanId!, eventId: event.id })),
    ).toBe("EVENT_HUMAN_NOT_FOUND");
    expect(s.status).toBe("APPROVED");
  });

  it("detach: a row gone by the time the lock is held answers EVENT_HUMAN_NOT_FOUND", async () => {
    const { world, clock, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    const picked = await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    deleteOnLock(world, picked.rows[0]!.eventHumanId);
    expect(
      await code(
        detachEventHuman(
          { repos: world.repos, authz: { hasStaffRole: async () => ({ allowed: false }) }, clock } as never,
          { actorHumanId: OC_EDITOR_ID, eventHumanId: picked.rows[0]!.eventHumanId },
        ),
      ),
    ).toBe("EVENT_HUMAN_NOT_FOUND");
    expect(s.removedFromLineupAt ?? null).toBeNull();
  });
});

describe("person drop-out failures are swallowed and reported (re-review 5, 6)", () => {
  it("throwing seam, booking pass and reporter: success, reported under dropOutOfOpenCall", async () => {
    const { world, clock, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    const spy = spiedLeaveDeps(world, clock, {
      reportError,
      passBookingRequestAct: vi.fn(async () => {
        throw new Error("booking down");
      }),
      notifyOpenCallDroppedOut: vi.fn(async () => {
        throw new Error("seam down");
      }),
    });

    const out = await dropOutOfOpenCall(spy.deps as never, {
      auth: { kind: "session", actorHumanId: s.humanId!, submissionId: s.id },
    });

    expect(out.status).toBe("WITHDRAWN");
    expect(s.status).toBe("WITHDRAWN");
    const tagged = (message: string) =>
      reportError.mock.calls.find((c) => (c[0] as Error).message === message)?.[1] as
        | { tags: Record<string, string> }
        | undefined;
    expect(tagged("booking down")?.tags.useCase).toBe("dropOutOfOpenCall");
    expect(tagged("seam down")?.tags.useCase).toBe("dropOutOfOpenCall");
  });
});

describe("editors are ALWAYS told while the dropped-out seam is unwired", () => {
  const unwired = (world: OpenCallWorld, clock: ClockPort) =>
    spiedLeaveDeps(world, clock, { notifyOpenCallDroppedOut: undefined });
  const seamReports = (reportError: ReturnType<typeof vi.fn>) =>
    reportError.mock.calls.filter(
      (c) => (c[1] as { tags?: { reason?: string } })?.tags?.reason === "dropped_out_seam_unwired",
    );

  it("leaving the last picked night with no seam: exactly one lineup-left plus one report", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const spy = unwired(world, clock);

    await leaveEventLineup(spy.deps as never, { actorHumanId: s.humanId!, eventId: event.id });

    expect(s.status).toBe("WITHDRAWN");
    expect(lineupLeftCalls(spy.notify)).toHaveLength(1);
    expect(seamReports(spy.reportError)).toHaveLength(1);
    expect(seamReports(spy.reportError)[0]![1]).toMatchObject({ tags: { useCase: "leaveEventLineup" } });
  });

  it("3-night session drop-out with no seam: lineup-left per night plus one report", async () => {
    const { world, clock, deps } = setup();
    const { s } = await threeNightPick(world, deps);
    const spy = unwired(world, clock);

    await dropOutOfOpenCall(spy.deps as never, {
      auth: { kind: "session", actorHumanId: s.humanId!, submissionId: s.id },
    });

    expect(s.status).toBe("WITHDRAWN");
    expect(lineupLeftCalls(spy.notify)).toHaveLength(3);
    expect(seamReports(spy.reportError)).toHaveLength(1);
    expect(seamReports(spy.reportError)[0]![1]).toMatchObject({ tags: { useCase: "dropOutOfOpenCall" } });
  });

  it("org drop-out with no seam: no lineup-left path, the gap is reported", async () => {
    const { world, clock, deps } = setup();
    const { call } = eventCall(world);
    const { token, hash } = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID());
    const s = world.addSubmission(call.id, "PENDING", { applyingAsOrgId: OC_OTHER_ORG_ID, statusTokenHash: hash });
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const spy = unwired(world, clock);

    await dropOutOfOpenCall(spy.deps as never, { auth: { kind: "token", token } });

    expect(lineupLeftCalls(spy.notify)).toHaveLength(0);
    expect(seamReports(spy.reportError)).toHaveLength(1);
  });

  it("person drop-out with no row left (removed by the organizers) and no seam: fallback 'none', no lineup-left", async () => {
    const { world, clock, deps } = setup();
    const { call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    const picked = await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    await detachEventHuman(
      { repos: world.repos, authz: { hasStaffRole: async () => ({ allowed: false }) }, clock } as never,
      { actorHumanId: OC_EDITOR_ID, eventHumanId: picked.rows[0]!.eventHumanId },
    );
    const spy = unwired(world, clock);

    await dropOutOfOpenCall(spy.deps as never, {
      auth: { kind: "session", actorHumanId: s.humanId!, submissionId: s.id },
    });

    expect(s.status).toBe("WITHDRAWN");
    expect(lineupLeftCalls(spy.notify)).toHaveLength(0);
    expect(seamReports(spy.reportError)).toHaveLength(1);
    expect(seamReports(spy.reportError)[0]![1]).toMatchObject({ extra: { fallback: "none" } });
  });

  it("with the seam wired nothing is reported and no lineup-left goes out", async () => {
    const { world, clock, deps } = setup();
    const { event, call } = eventCall(world);
    const s = world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(deps, pickInput(call.id, s.id));
    const spy = spiedLeaveDeps(world, clock);

    await leaveEventLineup(spy.deps as never, { actorHumanId: s.humanId!, eventId: event.id });

    expect(lineupLeftCalls(spy.notify)).toHaveLength(0);
    expect(seamReports(spy.reportError)).toHaveLength(0);
    expect(spy.notifyOpenCallDroppedOut).toHaveBeenCalledTimes(1);
  });
});
