/**
 * Open calls v1 step 4 — the applicant's status page, its auth (session or
 * status token, NFR-001) and the peer list (FR-008, NFR-002).
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OC_EVENT_ID, OC_ORG_ID, OC_SERIES_ID } from "@th/test-utils/fakes/open-calls";

import { getOpenCallApplicationStatus } from "../get-open-call-application-status";
import { submitOpenCallApplication } from "../submit-open-call-application";
import { DAY, addEventDate, guest, setupApplying } from "./open-call-application-helpers";

const ME = "30000000-0000-4000-8000-0000000000f1";
const OTHER = "30000000-0000-4000-8000-0000000000f2";

async function applied(opts: { formExtra?: Record<string, unknown> } = {}) {
  const s = setupApplying();
  s.world.addEvent();
  const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, ...opts.formExtra });
  const mine = await submitOpenCallApplication(s.deps, {
    publicId: call.publicId,
    viewerHumanId: ME,
    answers: {},
  });
  return { ...s, call, mine, token: mine.statusToken!, submissionId: mine.submissionId! };
}

describe("applicant auth", () => {
  it("session: the submitting human reads it; anyone else gets NOT_FOUND", async () => {
    const { deps, submissionId } = await applied();
    const out = await getOpenCallApplicationStatus(deps, {
      auth: { kind: "session", actorHumanId: ME, submissionId },
    });
    expect(out.application.status).toBe("PENDING");
    await expect(
      getOpenCallApplicationStatus(deps, {
        auth: { kind: "session", actorHumanId: OTHER, submissionId },
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
  });

  it("token: its own application only; an unknown or malformed token is refused", async () => {
    const { world, deps, call, token } = await applied();
    const other = await submitOpenCallApplication(deps, { publicId: call.publicId, guest: guest() });
    const mineView = await getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } });
    const otherView = await getOpenCallApplicationStatus(deps, {
      auth: { kind: "token", token: other.statusToken! },
    });
    expect(mineView.application.appliedAs).toEqual({ kind: "self", name: expect.any(String) });
    expect(otherView.application.appliedAs).toEqual({ kind: "guest", name: "The Moths" });

    const unknown = "A".repeat(43);
    await expect(
      getOpenCallApplicationStatus(deps, { auth: { kind: "token", token: unknown } }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
    await expect(
      getOpenCallApplicationStatus(deps, { auth: { kind: "token", token: "short" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(world.submissions).toHaveLength(2);
  });

  it("an ATTEND submission is invisible to the token path", async () => {
    const { world, deps } = setupApplying();
    world.addEvent({ gateType: "APPLICATION" });
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    const token = "B".repeat(43);
    world.addSubmission(attend.id, "PENDING", {
      statusTokenHash: createHash("sha256").update(token).digest("hex"),
    });
    await expect(
      getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
  });

  it("token expiry: 30 days after the event (single date); the session keeps working", async () => {
    const { world, deps, setNow, token, submissionId } = await applied();
    const eventStart = world.events.get(OC_EVENT_ID)!.startsAt;
    setNow(new Date(eventStart.getTime() + 30 * DAY));
    await expect(
      getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } }),
    ).resolves.toBeDefined();
    setNow(new Date(eventStart.getTime() + 30 * DAY + 1));
    await expect(
      getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_LINK_EXPIRED" });
    await expect(
      getOpenCallApplicationStatus(deps, {
        auth: { kind: "session", actorHumanId: ME, submissionId },
      }),
    ).resolves.toBeDefined();
  });

  it("token expiry follows the LAST chosen date", async () => {
    const s = setupApplying();
    s.world.addSeries();
    const o1 = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + 2 * DAY) });
    const o2 = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + 40 * DAY) });
    s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + 90 * DAY) });
    const call = s.world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const out = await submitOpenCallApplication(s.deps, {
      publicId: call.publicId,
      guest: guest(),
      dateIds: [o1.id, o2.id],
    });
    const auth = { kind: "token" as const, token: out.statusToken! };
    s.setNow(new Date(o2.startsAt.getTime() + 30 * DAY - 1));
    await expect(getOpenCallApplicationStatus(s.deps, { auth })).resolves.toBeDefined();
    s.setNow(new Date(o2.startsAt.getTime() + 30 * DAY + 1));
    await expect(getOpenCallApplicationStatus(s.deps, { auth })).rejects.toMatchObject({
      code: "OPEN_CALL_LINK_EXPIRED",
    });
  });
});

describe("status page", () => {
  it("canEdit until opened; canWithdraw while PENDING; call summary with choosable dates", async () => {
    const { world, deps, token, submissionId } = await applied();
    let out = await getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } });
    expect(out).toMatchObject({
      canEdit: true,
      canWithdraw: true,
      call: {
        anchor: "event",
        title: "Basement Show",
        closed: false,
        closedReason: null,
        pay: { kind: "UNPAID", details: null },
        dates: [{ id: null, startsAt: world.events.get(OC_EVENT_ID)!.startsAt }],
      },
      application: { seenByOrganizers: false, isPrivate: false, dateChoices: [] },
    });
    world.submissions.find((s) => s.id === submissionId)!.openedAt = world.now;
    out = await getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } });
    expect(out).toMatchObject({ canEdit: false, canWithdraw: true });
    expect(out.application.seenByOrganizers).toBe(true);
    world.submissions.find((s) => s.id === submissionId)!.status = "APPROVED";
    out = await getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } });
    expect(out).toMatchObject({ canEdit: false, canWithdraw: false });
  });

  it("shows the questions as answered, in form order, and the chosen dates", async () => {
    const s = setupApplying();
    s.world.addEvent();
    const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const q2 = await s.world.repos.eventApplications.upsertQuestion({
      formId: call.id,
      type: "LONG_TEXT",
      label: "Second",
      order: 2,
    });
    const q1 = await s.world.repos.eventApplications.upsertQuestion({
      formId: call.id,
      type: "SHORT_TEXT",
      label: "First",
      order: 1,
    });
    const d1 = addEventDate(s.world, new Date(s.world.now.getTime() + 2 * DAY));
    addEventDate(s.world, new Date(s.world.now.getTime() + 3 * DAY));
    const out = await submitOpenCallApplication(s.deps, {
      publicId: call.publicId,
      guest: guest(),
      answers: { [q1.id]: "one", [q2.id]: "two" },
      dateIds: [d1.id],
    });
    const view = await getOpenCallApplicationStatus(s.deps, {
      auth: { kind: "token", token: out.statusToken! },
    });
    expect(view.application.questions.map((q) => q.label)).toEqual(["First", "Second"]);
    expect(view.application.answers).toEqual({ [q1.id]: "one", [q2.id]: "two" });
    expect(view.application.dateChoices).toEqual([{ id: d1.id, startsAt: d1.startsAt }]);
    expect(view.call.dates.map((d) => d.id)).toHaveLength(2);
  });
});

describe("peer list (FR-008)", () => {
  it("lists other non-private, non-withdrawn applicants, never self; filtered in the query", async () => {
    const { world, deps, call, token, submissionId } = await applied();
    // Distinct times: the list is ordered by first application (ties go to
    // the identity key, as in the adapter's ORDER BY).
    const at = (h: number) => new Date(world.now.getTime() + h * 3600_000);
    const visible = world.addSubmission(call.id, "PENDING", { humanId: OTHER, createdAt: at(1) });
    world.publicPages.set(OTHER, {
      slug: "other-act",
      avatarUrl: "https://img.example/o.png",
      displayName: "Other Act",
    });
    world.addSubmission(call.id, "REJECTED", {
      humanId: null,
      guestName: "Told Not This Time",
      guestUrl: "https://ntt.example",
      contactEmail: "ntt@example.com",
      createdAt: at(2),
    });
    world.addSubmission(call.id, "APPROVED", {
      humanId: null,
      applyingAsOrgId: OC_ORG_ID,
      createdAt: at(3),
    });
    world.addSubmission(call.id, "PENDING", { isPrivate: true });
    world.addSubmission(call.id, "WITHDRAWN");

    const out = await getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } });
    expect(out.peers).toEqual([
      {
        kind: "human",
        name: "Other Act",
        photoUrl: "https://img.example/o.png",
        pageSlug: "other-act",
        url: null,
      },
      {
        kind: "guest",
        name: "Told Not This Time",
        photoUrl: null,
        pageSlug: null,
        url: "https://ntt.example",
      },
      { kind: "org", name: expect.any(String), photoUrl: null, pageSlug: null, url: null },
    ]);
    // The exclusions are the repo query's job (the adapter's WHERE).
    expect(world.peerQueries).toEqual([
      {
        formId: call.id,
        viewer: { humanId: ME, applyingAsOrgId: null, contactEmail: null },
        limit: 200,
      },
    ]);
    expect(submissionId).toBeDefined();
    expect(JSON.stringify(out.peers)).not.toContain(visible.id);
  });

  it("one entry per identity: a re-application after 'not this time' never shows twice; the viewer's identity is excluded", async () => {
    const { world, deps, call, token } = await applied();
    const t = (h: number) => new Date(world.now.getTime() + h * 3600_000);
    // Same human: REJECTED then PENDING re-application.
    world.addSubmission(call.id, "REJECTED", { humanId: OTHER, createdAt: t(1) });
    world.addSubmission(call.id, "PENDING", { humanId: OTHER, createdAt: t(5) });
    // Same org, two different submitters.
    world.addSubmission(call.id, "REJECTED", { humanId: OTHER, applyingAsOrgId: OC_ORG_ID, createdAt: t(2) });
    world.addSubmission(call.id, "PENDING", {
      humanId: "30000000-0000-4000-8000-0000000000f9",
      applyingAsOrgId: OC_ORG_ID,
      createdAt: t(6),
    });
    // Same guest email, different case.
    const g = { humanId: null, guestName: "Guesty", contactEmail: "g@example.com" };
    world.addSubmission(call.id, "REJECTED", { ...g, createdAt: t(3) });
    world.addSubmission(call.id, "PENDING", { ...g, contactEmail: "G@Example.com", createdAt: t(7) });
    // The viewer's own earlier, rejected self application.
    world.addSubmission(call.id, "REJECTED", { humanId: ME, createdAt: t(-1) });

    const out = await getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } });
    expect(out.peers!.map((p) => p.kind)).toEqual(["human", "org", "guest"]);
  });

  it("NFR-002: exact response shape — no status, vote, note, decision, email or ids", async () => {
    const { world, deps, call, token } = await applied();
    const other = world.addSubmission(call.id, "REJECTED", {
      humanId: null,
      guestName: "Guest Act",
      guestUrl: "https://guest.example",
      contactEmail: "guest-secret@example.com",
      answers: { q: "secret pitch" },
    });
    const out = await getOpenCallApplicationStatus(deps, { auth: { kind: "token", token } });

    expect(Object.keys(out).sort()).toEqual([
      "application",
      "call",
      "canEdit",
      "canSetPrivacy",
      "canWithdraw",
      "peers",
    ]);
    expect(Object.keys(out.application).sort()).toEqual(
      [
        "answers",
        "appliedAs",
        "createdAt",
        "dateChoices",
        "isPrivate",
        "questions",
        "seenByOrganizers",
        "status",
      ].sort(),
    );
    expect(Object.keys(out.call).sort()).toEqual(
      ["anchor", "closed", "closedReason", "closesAt", "dates", "pay", "publicId", "timezone", "title"].sort(),
    );
    expect(out.peers).toHaveLength(1);
    expect(Object.keys(out.peers![0]!).sort()).toEqual(["kind", "name", "pageSlug", "photoUrl", "url"]);

    const wire = JSON.stringify(out);
    for (const secret of [
      other.id,
      "guest-secret@example.com",
      "secret pitch",
      "REJECTED",
      call.id,
      OC_EVENT_ID,
      token,
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("only while the call is open, and not after this applicant withdrew", async () => {
    const closed = await applied();
    closed.world.addSubmission(closed.call.id, "PENDING");
    closed.world.forms.find((f) => f.id === closed.call.id)!.closedAt = closed.world.now;
    const a = await getOpenCallApplicationStatus(closed.deps, {
      auth: { kind: "token", token: closed.token },
    });
    expect(a.peers).toBeNull();
    expect(a.call).toMatchObject({ closed: true, closedReason: "closed_by_poster" });
    expect(closed.world.peerQueries).toEqual([]);

    const ended = await applied();
    ended.setNow(new Date(ended.world.events.get(OC_EVENT_ID)!.startsAt.getTime() + 1));
    const b = await getOpenCallApplicationStatus(ended.deps, {
      auth: { kind: "token", token: ended.token },
    });
    expect(b.peers).toBeNull();
    expect(b.call.closedReason).toBe("last_date_started");

    const gone = await applied();
    gone.world.submissions.find((s) => s.id === gone.submissionId)!.status = "WITHDRAWN";
    const c = await getOpenCallApplicationStatus(gone.deps, {
      auth: { kind: "token", token: gone.token },
    });
    expect(c.peers).toBeNull();
  });
});
