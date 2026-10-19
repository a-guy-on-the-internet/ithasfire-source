/**
 * Open calls v1 step 4 — the applicant edits (FR-010), withdraws, and lists
 * their own applications (FR-009).
 */
import { describe, expect, it } from "vitest";

import { OC_EDITOR_ID, OC_EVENT_ID, OC_ORG_ID, OC_SERIES_ID } from "@th/test-utils/fakes/open-calls";

import { editOpenCallApplication } from "../edit-open-call-application";
import { listMyOpenCallApplications } from "../list-my-open-call-applications";
import { submitOpenCallApplication } from "../submit-open-call-application";
import { withdrawOpenCallApplication } from "../withdraw-open-call-application";
import { DAY, addEventDate, guest, setupApplying } from "./open-call-application-helpers";

const ME = "30000000-0000-4000-8000-0000000000f1";
const OTHER = "30000000-0000-4000-8000-0000000000f2";

async function multiDateApplied() {
  const s = setupApplying();
  s.world.addEvent();
  const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
  const q = await s.world.repos.eventApplications.upsertQuestion({
    formId: call.id,
    type: "SHORT_TEXT",
    label: "Your link",
    isRequired: true,
  });
  const d1 = addEventDate(s.world, new Date(s.world.now.getTime() + 2 * DAY));
  const d2 = addEventDate(s.world, new Date(s.world.now.getTime() + 3 * DAY));
  const out = await submitOpenCallApplication(s.deps, {
    publicId: call.publicId,
    guest: guest(),
    answers: { [q.id]: "https://a.example" },
    dateIds: [d1.id],
  });
  const row = () => s.world.submissions.find((x) => x.id === out.submissionId)!;
  return { ...s, call, q, d1, d2, token: out.statusToken!, submissionId: out.submissionId!, row };
}

describe("editOpenCallApplication", () => {
  it("replaces answers, dates and privacy wholesale; re-snapshots; audits", async () => {
    const { world, deps, q, d2, token, row } = await multiDateApplied();
    const out = await editOpenCallApplication(deps, {
      auth: { kind: "token", token },
      answers: { [q.id]: "https://b.example" },
      dateIds: [d2.id],
      isPrivate: true,
    });
    expect(row()).toMatchObject({
      answers: { [q.id]: "https://b.example" },
      dateChoices: [{ eventDateId: d2.id }],
      isPrivate: true,
    });
    expect(out.application).toMatchObject({
      isPrivate: true,
      dateChoices: [{ id: d2.id, startsAt: d2.startsAt }],
    });
    expect(world.audit).toContainEqual(
      expect.objectContaining({ action: "open_call_application_edited" }),
    );
  });

  it("same validation as submit: answers, required dates, foreign dates", async () => {
    const { deps, q, d1, token, row } = await multiDateApplied();
    const auth = { kind: "token" as const, token };
    await expect(
      editOpenCallApplication(deps, { auth, answers: {}, dateIds: [d1.id], isPrivate: false }),
    ).rejects.toMatchObject({ code: "APPLICATION_ANSWERS_INCOMPLETE" });
    await expect(
      editOpenCallApplication(deps, {
        auth,
        answers: { [q.id]: "x" },
        dateIds: [],
        isPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_DATES_REQUIRED" });
    await expect(
      editOpenCallApplication(deps, {
        auth,
        answers: { [q.id]: "x" },
        dateIds: ["20000000-0000-4000-8000-0000000000aa"],
        isPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_DATE_INVALID" });
    expect(row().dateChoices).toEqual([{ eventDateId: d1.id }]);
  });

  it("refused once the organizer side opened it (FR-010), or once decided", async () => {
    const { deps, q, d1, token, row } = await multiDateApplied();
    const input = {
      auth: { kind: "token" as const, token },
      answers: { [q.id]: "late" },
      dateIds: [d1.id],
      isPrivate: false,
    };
    row().openedAt = new Date();
    await expect(editOpenCallApplication(deps, input)).rejects.toMatchObject({
      code: "OPEN_CALL_APPLICATION_LOCKED",
    });
    // Opened AND decided: DECIDED wins.
    row().status = "REJECTED";
    await expect(editOpenCallApplication(deps, input)).rejects.toMatchObject({
      code: "OPEN_CALL_APPLICATION_DECIDED",
    });
    row().openedAt = null;
    await expect(editOpenCallApplication(deps, input)).rejects.toMatchObject({
      code: "OPEN_CALL_APPLICATION_DECIDED",
    });
    expect(row().answers[q.id]).toBe("https://a.example");
  });

  it("an organizer open that lands between the read and the write wins (guarded write)", async () => {
    const { world, deps, q, d1, token, row } = await multiDateApplied();
    const real = world.repos.eventApplications.updateOpenCallSubmission.bind(
      world.repos.eventApplications,
    );
    world.repos.eventApplications.updateOpenCallSubmission = async (input) => {
      row().openedAt = new Date();
      return real(input);
    };
    await expect(
      editOpenCallApplication(deps, {
        auth: { kind: "token", token },
        answers: { [q.id]: "late" },
        dateIds: [d1.id],
        isPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_LOCKED" });
  });

  it("another applicant's session can't edit it", async () => {
    const s = setupApplying();
    s.world.addEvent();
    const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const mine = await submitOpenCallApplication(s.deps, {
      publicId: call.publicId,
      viewerHumanId: ME,
    });
    await expect(
      editOpenCallApplication(s.deps, {
        auth: { kind: "session", actorHumanId: OTHER, submissionId: mine.submissionId! },
        answers: {},
        dateIds: [],
        isPrivate: true,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
    const ok = await editOpenCallApplication(s.deps, {
      auth: { kind: "session", actorHumanId: ME, submissionId: mine.submissionId! },
      answers: {},
      dateIds: [],
      isPrivate: true,
    });
    expect(ok.application.isPrivate).toBe(true);
  });

  it("still allowed after the deadline (FR-004 only stops new applications)", async () => {
    const { world, deps, call, q, d1, token, row } = await multiDateApplied();
    world.forms.find((f) => f.id === call.id)!.closesAt = new Date(world.now.getTime() - 1);
    await editOpenCallApplication(deps, {
      auth: { kind: "token", token },
      answers: { [q.id]: "after deadline" },
      dateIds: [d1.id],
      isPrivate: false,
    });
    expect(row().answers[q.id]).toBe("after deadline");
  });

  it("refused on a closed call", async () => {
    const { world, deps, call, q, d1, token } = await multiDateApplied();
    world.forms.find((f) => f.id === call.id)!.closedAt = world.now;
    await expect(
      editOpenCallApplication(deps, {
        auth: { kind: "token", token },
        answers: { [q.id]: "x" },
        dateIds: [d1.id],
        isPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_CLOSED" });
  });
});

describe("withdrawOpenCallApplication", () => {
  it("PENDING -> WITHDRAWN, returns the step-7 notice; a repeat is a no-op", async () => {
    const { world, deps, call, token, submissionId, row } = await multiDateApplied();
    const first = await withdrawOpenCallApplication(deps, { auth: { kind: "token", token } });
    expect(first).toEqual({
      submissionId,
      status: "WITHDRAWN",
      alreadyWithdrawn: false,
      notice: {
        kind: "application_withdrawn",
        submissionId,
        formId: call.id,
        anchor: { kind: "event", eventId: OC_EVENT_ID },
        title: "Basement Show",
      },
    });
    expect(row().status).toBe("WITHDRAWN");
    const again = await withdrawOpenCallApplication(deps, { auth: { kind: "token", token } });
    expect(again).toMatchObject({ alreadyWithdrawn: true, notice: null });
    expect(
      world.audit.filter((a) => a.action === "open_call_application_withdrawn"),
    ).toHaveLength(1);
  });

  it("refused after a pick or a 'not this time' (drop out is step 6)", async () => {
    for (const status of ["APPROVED", "REJECTED"] as const) {
      const { deps, token, row } = await multiDateApplied();
      row().status = status;
      await expect(
        withdrawOpenCallApplication(deps, { auth: { kind: "token", token } }),
      ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_DECIDED" });
      expect(row().status).toBe(status);
    }
  });

  it("works after the organizer opened it (withdraw any time before a pick)", async () => {
    const { deps, token, row } = await multiDateApplied();
    row().openedAt = new Date();
    await expect(
      withdrawOpenCallApplication(deps, { auth: { kind: "token", token } }),
    ).resolves.toMatchObject({ alreadyWithdrawn: false });
  });

  it("then the applicant can apply again (FR-011)", async () => {
    const s = setupApplying();
    s.world.addEvent();
    const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const a = await submitOpenCallApplication(s.deps, { publicId: call.publicId, viewerHumanId: ME });
    await withdrawOpenCallApplication(s.deps, {
      auth: { kind: "session", actorHumanId: ME, submissionId: a.submissionId! },
    });
    const b = await submitOpenCallApplication(s.deps, { publicId: call.publicId, viewerHumanId: ME });
    expect(b.outcome).toBe("created");
  });
});

describe("listMyOpenCallApplications", () => {
  it("my own open-call applications, newest first, with title, status and link paths", async () => {
    const s = setupApplying();
    s.world.addEvent();
    s.world.addSeries();
    s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + 2 * DAY) });
    const eventCall = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const seriesCall = s.world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const attend = s.world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    s.world.addSubmission(attend.id, "PENDING", { humanId: OC_EDITOR_ID });
    s.world.addSubmission(eventCall.id, "REJECTED", {
      humanId: OC_EDITOR_ID,
      createdAt: new Date(s.world.now.getTime() - DAY),
    });
    s.world.addSubmission(seriesCall.id, "PENDING", {
      humanId: OC_EDITOR_ID,
      applyingAsOrgId: OC_ORG_ID,
    });
    s.world.addSubmission(eventCall.id, "PENDING", { humanId: OTHER });

    const out = await listMyOpenCallApplications(s.deps, { actorHumanId: OC_EDITOR_ID });
    expect(out).toEqual([
      expect.objectContaining({
        publicId: seriesCall.publicId,
        anchor: "series",
        title: "Tuesday Open Stage",
        status: "PENDING",
        appliedAs: { kind: "org", orgName: expect.any(String) },
        callPath: `/call/${seriesCall.publicId}`,
        statusPath: `/call/${seriesCall.publicId}/application`,
      }),
      expect.objectContaining({
        publicId: eventCall.publicId,
        anchor: "event",
        title: "Basement Show",
        status: "REJECTED",
        appliedAs: { kind: "self", orgName: null },
      }),
    ]);
  });
});
