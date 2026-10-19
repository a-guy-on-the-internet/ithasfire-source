/**
 * Open calls v1 step 7 — the notifiers behind the core seams: who is told,
 * on which channel, exactly once, and what happens when a send fails.
 * Runs the REAL use cases (pick, decline, close, leave) over the open-call
 * fake world, with the REAL renderers (every notify payload is rendered, so
 * a payload the renderer would refuse fails here).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import {
  OC_EDITOR_ID,
  OC_ORG_ID,
  OC_OTHER_ORG_ID,
  OC_VIEWER_ID,
  createOpenCallWorld,
  type OpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import type { NotifyInput } from "../../../comms/notify";
import { OPEN_CALL_EMAIL_TEMPLATE_KEY, type OpenCallEmailContent } from "../../../comms/open-call-renderers";
import { renderNotification } from "../../../comms/renderers";
import { leaveEventLineup } from "../../../event-humans/leave-event-lineup";
import { closeOpenCall } from "../close-open-call";
import { declineOpenCallApplication } from "../decline-open-call-application";
import {
  makeOpenCallNotices,
  OPEN_CALL_MESSAGE_BURST_WINDOW_SEC,
  openCallNoticeKey,
  openCallNoticeWasSent,
  type OpenCallNoticeDeps,
} from "../notify-open-call-notices";
import { pickOpenCallApplication } from "../pick-open-call-application";
import { deriveStatusToken } from "../_shared/status-token";
import { TEST_STATUS_TOKEN_SECRET } from "./open-call-application-helpers";

const BASE = "https://ithasfire.com";
const SECOND_EDITOR = "30000000-0000-4000-8000-0000000000c1";
const SCANNER = "30000000-0000-4000-8000-0000000000c2";
const FINANCE = "30000000-0000-4000-8000-0000000000c3";

function setup(overrides: Partial<OpenCallNoticeDeps> = {}) {
  const world = createOpenCallWorld();
  world.memberships.set(`${OC_ORG_ID}:${SECOND_EDITOR}`, "EDITOR");
  world.memberships.set(`${OC_ORG_ID}:${SCANNER}`, "SCANNER");
  world.memberships.set(`${OC_ORG_ID}:${FINANCE}`, "FINANCE");
  const clock = { now: () => world.now } as unknown as ClockPort;
  const idempotency = createFakeIdempotencyPort({ withStatus: true });
  // The REAL renderer runs on every payload: a payload it refuses throws here.
  const notify = vi.fn(async (input: NotifyInput) => {
    renderNotification(input.variant, input.payload, { now: world.now });
    return { ok: true } as never;
  });
  const mailer = {
    send: vi.fn(async (_input: Record<string, unknown>) => ({ result: { success: true, id: "m-1" } })),
    sendBatch: vi.fn(),
    health: vi.fn(),
  };
  const reportError = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  const deps: OpenCallNoticeDeps = {
    repos: world.repos as unknown as OpenCallNoticeDeps["repos"],
    notify,
    mailer: mailer as unknown as OpenCallNoticeDeps["mailer"],
    idempotency,
    publicAppUrl: BASE,
    logger: logger as unknown as OpenCallNoticeDeps["logger"],
    reportError,
    statusTokenSecret: TEST_STATUS_TOKEN_SECRET,
    ...overrides,
  };
  const notices = makeOpenCallNotices(deps);
  const decideDeps = { repos: world.repos, clock };
  return { world, clock, idempotency, notify, mailer, reportError, logger, deps, notices, decideDeps };
}

type Setup = ReturnType<typeof setup>;

function eventCall(world: OpenCallWorld, eventOverrides = {}) {
  const event = world.addEvent(eventOverrides);
  const call = world.addForm({
    purpose: "PERFORM",
    eventId: event.id,
    payKind: "FIXED",
    payDetails: "$150 + two drinks",
  });
  return { event, call };
}

const pickInput = (formId: string, submissionId: string) => ({
  actorHumanId: OC_EDITOR_ID,
  formId,
  submissionId,
});

const sentTo = (s: Setup, variant: string) =>
  s.notify.mock.calls.filter((c) => c[0].variant === variant).map((c) => c[0].humanId);
const payloadOf = (s: Setup, variant: string, i = 0) =>
  s.notify.mock.calls.filter((c) => c[0].variant === variant)[i]![0].payload as Record<string, unknown>;
/** A guest's real status link, as the notifier re-derives it. */
const statusUrlOf = (publicId: string, submissionId: string) =>
  `${BASE}/call/${publicId}/application/${deriveStatusToken(TEST_STATUS_TOKEN_SECRET, submissionId).token}`;

/**
 * NFR-001: nothing that goes through notify() (stored payload, rendered
 * in-app route, push data) may carry a status link.
 */
const expectNoTokenThroughNotify = (s: Setup) => {
  for (const [input] of s.notify.mock.calls) {
    expect(JSON.stringify(input)).not.toContain("/application/");
    const rendered = renderNotification(input.variant, input.payload, { now: s.world.now });
    expect(JSON.stringify(rendered)).not.toContain("/application/");
  }
};

const mailContent = (s: Setup, i = 0) => {
  const input = s.mailer.send.mock.calls[i]![0] as {
    to: { to: string };
    template: { key: string; variables: OpenCallEmailContent };
  };
  return { to: input.to.to, key: input.template.key, content: input.template.variables };
};

// ── Picked (FR-017) ─────────────────────────────────────────────────────────

describe("picked", () => {
  it("a person: one in-app + email notice through notify, with the dates, the pay as posted and a drop-out link", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");

    await pickOpenCallApplication(
      { ...s.decideDeps, notifyOpenCallPicked: s.notices.notifyOpenCallPicked },
      pickInput(call.id, sub.id),
    );

    expect(sentTo(s, "open-call.picked")).toEqual([sub.humanId]);
    expect(payloadOf(s, "open-call.picked")).toMatchObject({
      callTitle: event.title,
      firstPick: true,
      actName: null,
      dates: [{ startsAtIso: event.startsAt.toISOString(), timezone: "America/Chicago" }],
      payKind: "FIXED",
      payDetails: "$150 + two drinks",
      actionUrl: `${BASE}/my-applications`,
      dropOutUrl: `${BASE}/my-lineups`,
      makePageUrl: null,
    });
    expect(s.mailer.send).not.toHaveBeenCalled();
    expect(await openCallNoticeWasSent(s.idempotency, "picked", sub.id)).toBe(true);
  });

  it("re-sending the same (submission, kind) is a no-op", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    const out = await pickOpenCallApplication(s.decideDeps, pickInput(call.id, sub.id));

    await s.notices.notifyOpenCallPicked(out.notice!);
    await s.notices.notifyOpenCallPicked(out.notice!);

    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  it("an organisation: its OWNER/ADMIN/EDITOR members, named as the org; never SCANNER, VIEWER or FINANCE", async () => {
    const s = setup();
    const band = OC_OTHER_ORG_ID;
    const [owner, editor, viewer, scanner, finance] = [1, 2, 3, 4, 5].map(() => randomUUID());
    s.world.memberships.set(`${band}:${owner}`, "OWNER");
    s.world.memberships.set(`${band}:${editor}`, "EDITOR");
    s.world.memberships.set(`${band}:${viewer}`, "VIEWER");
    s.world.memberships.set(`${band}:${scanner}`, "SCANNER");
    s.world.memberships.set(`${band}:${finance}`, "FINANCE");
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", { humanId: editor, applyingAsOrgId: band });

    await pickOpenCallApplication(
      { ...s.decideDeps, notifyOpenCallPicked: s.notices.notifyOpenCallPicked },
      pickInput(call.id, sub.id),
    );

    expect(sentTo(s, "open-call.picked").sort()).toEqual([owner, editor].sort());
    expect(payloadOf(s, "open-call.picked")).toMatchObject({
      actName: `Org ${band.slice(-2)}`,
      dropOutUrl: `${BASE}/my-applications`,
    });
  });

  it("an organisation with no edit member left: the member who submitted it, so the act still hears", async () => {
    const s = setup();
    const lonely = randomUUID();
    const submitter = randomUUID();
    const { call } = eventCall(s.world);
    // What submit writes for an org application: the submitter, no contact email.
    const sub = s.world.addSubmission(call.id, "PENDING", {
      humanId: submitter,
      applyingAsOrgId: lonely,
      contactEmail: null,
    });
    const out = await pickOpenCallApplication(s.decideDeps, pickInput(call.id, sub.id));
    await s.notices.notifyOpenCallPicked(out.notice!);

    expect(sentTo(s, "open-call.picked")).toEqual([submitter]);
    expect(s.mailer.send).not.toHaveBeenCalled();
    expect(await openCallNoticeWasSent(s.idempotency, "picked", sub.id)).toBe(true);
  });

  it("a guest: one email to the contact address, in the platform default language, with a make-a-page invite (Q34)", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "The Moths",
      guestUrl: "https://moths.example.com",
      contactEmail: "moths@example.com",
    });

    await pickOpenCallApplication(
      { ...s.decideDeps, notifyOpenCallPicked: s.notices.notifyOpenCallPicked },
      pickInput(call.id, sub.id),
    );

    expect(s.notify).not.toHaveBeenCalled();
    expect(s.mailer.send).toHaveBeenCalledTimes(1);
    const mail = mailContent(s);
    expect(mail.to).toBe("moths@example.com");
    expect(mail.key).toBe(OPEN_CALL_EMAIL_TEMPLATE_KEY);
    expect(mail.content.locale).toBe("en");
    expect(mail.content.subject).toBe(`You're on the lineup for ${event.title}`);
    // The status link is re-derived from the submission id (owner ruling
    // 2026-10-07): the button opens it and "Drop out" is one tap.
    const statusUrl = statusUrlOf(call.publicId, sub.id);
    expect(mail.content.action!.url).toBe(statusUrl);
    expect(mail.content.links).toEqual([
      { label: "Drop out", url: statusUrl },
      { label: "Make a page", url: `${BASE}/sign-up?email=moths%40example.com&src=open-call` },
    ]);
    expect(mail.content.paragraphs.join(" ")).toContain("Drop out with one tap");
    const input = s.mailer.send.mock.calls[0]![0] as {
      idempotencyKey: string;
      localization: unknown;
      metadata: unknown;
      tags: unknown;
    };
    expect(input.idempotencyKey).toMatch(/^open-call-notice:picked:.+:mail$/);
    expect(input.localization).toEqual({ locale: "en" });
    // The token is in the email body only: not in the key, metadata or tags,
    // nor in any log line or report.
    const token = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, sub.id).token;
    expect(JSON.stringify([input.idempotencyKey, input.metadata, input.tags])).not.toContain(token);
    expect(JSON.stringify(s.logger.info.mock.calls)).not.toContain(token);
    expect(JSON.stringify(s.logger.error.mock.calls)).not.toContain(token);
    expect(JSON.stringify(s.reportError.mock.calls)).not.toContain(token);
  });

  it("a guest who applied in Spanish (contactLocale) gets the email in Spanish", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "Las Polillas",
      contactEmail: "polillas@example.com",
      contactLocale: "es",
    });
    const out = await pickOpenCallApplication(s.decideDeps, pickInput(call.id, sub.id));
    await s.notices.notifyOpenCallPicked(out.notice!);

    const mail = mailContent(s);
    expect(mail.content.locale).toBe("es");
    expect(mail.content.subject).toBe(`Estás en el lineup de ${event.title}`);
    expect(mail.content.links[0]).toEqual({ label: "Retirarme", url: statusUrlOf(call.publicId, sub.id) });
  });

  it("no status-token secret bound: the guest email fails, is reported, and waits for a reconcile", async () => {
    const s = setup({ statusTokenSecret: null });
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "The Moths",
      contactEmail: "moths@example.com",
    });
    const out = await pickOpenCallApplication(s.decideDeps, pickInput(call.id, sub.id));
    await expect(s.notices.notifyOpenCallPicked(out.notice!)).resolves.toBeUndefined();

    expect(s.mailer.send).not.toHaveBeenCalled();
    expect(s.reportError).toHaveBeenCalledTimes(1);
    expect(s.reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "openCallNotices", kind: "picked", reason: "send_failed" },
    });
    expect(await openCallNoticeWasSent(s.idempotency, "picked", sub.id)).toBe(false);
  });

  it("signed-in links never carry a token (NFR-001): person and org payloads and rendered routes", async () => {
    const s = setup();
    const band = OC_OTHER_ORG_ID;
    const member = randomUUID();
    s.world.memberships.set(`${band}:${member}`, "EDITOR");
    const { call } = eventCall(s.world);
    const person = s.world.addSubmission(call.id, "PENDING", { statusTokenHash: "a".repeat(64) });
    const org = s.world.addSubmission(call.id, "PENDING", { humanId: member, applyingAsOrgId: band });
    const pickDeps = { ...s.decideDeps, notifyOpenCallPicked: s.notices.notifyOpenCallPicked };
    await pickOpenCallApplication(pickDeps, pickInput(call.id, person.id));
    await pickOpenCallApplication(pickDeps, pickInput(call.id, org.id));

    expect(s.notify).toHaveBeenCalledTimes(2);
    expectNoTokenThroughNotify(s);
  });
});

// ── Not this time (FR-018, FR-020) ──────────────────────────────────────────

describe("not this time", () => {
  it("decline: the applicant hears at once, with the organizer's note", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");

    await declineOpenCallApplication(
      { ...s.decideDeps, notifyOpenCallNotThisTime: s.notices.notifyOpenCallNotThisTime },
      { ...pickInput(call.id, sub.id), decisionReason: "Loved it. Next season." },
    );

    expect(sentTo(s, "open-call.not-this-time")).toEqual([sub.humanId]);
    expect(payloadOf(s, "open-call.not-this-time")).toMatchObject({ note: "Loved it. Next season." });
    expect(await openCallNoticeWasSent(s.idempotency, "not-this-time", sub.id)).toBe(true);
  });

  it("a guest's email quotes the note", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "The Moths",
      contactEmail: "moths@example.com",
    });
    await declineOpenCallApplication(
      { ...s.decideDeps, notifyOpenCallNotThisTime: s.notices.notifyOpenCallNotThisTime },
      { ...pickInput(call.id, sub.id), decisionReason: "Loved it." },
    );
    expect(mailContent(s).content.quote).toEqual({ label: "Their note", text: "Loved it." });
  });

  it("close sweep: each swept applicant gets the standard reply once; a second close and a reconcile re-send nothing", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const a = s.world.addSubmission(call.id, "PENDING");
    const b = s.world.addSubmission(call.id, "PENDING");
    const picked = s.world.addSubmission(call.id, "APPROVED");
    const closeDeps = { ...s.decideDeps, notifyOpenCallNotThisTime: s.notices.notifyOpenCallNotThisTime };

    const first = await closeOpenCall(closeDeps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(first.swept).toBe(2);
    expect(sentTo(s, "open-call.not-this-time").sort()).toEqual([a.humanId, b.humanId].sort());
    expect(payloadOf(s, "open-call.not-this-time")).toMatchObject({ note: null });
    expect(sentTo(s, "open-call.not-this-time")).not.toContain(picked.humanId);

    await closeOpenCall(closeDeps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    // Step 8's reconcile: re-call for every REJECTED PERFORM application.
    for (const sub of [a, b]) {
      expect(await openCallNoticeWasSent(s.idempotency, "not-this-time", sub.id)).toBe(true);
      await s.notices.notifyOpenCallNotThisTime({
        kind: "open_call_not_this_time",
        submissionId: sub.id,
        formId: call.id,
        anchor: { kind: "event", eventId: call.eventId! },
        title: "Basement Show",
        decisionReason: null,
      });
    }
    expect(s.notify).toHaveBeenCalledTimes(2);
  });

  it("close: a throwing notifier is reported per submission and the close stands", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const a = s.world.addSubmission(call.id, "PENDING");
    s.world.addSubmission(call.id, "PENDING");
    const reportError = vi.fn();
    const notifyOpenCallNotThisTime = vi.fn(async () => {
      throw new Error("mail down");
    });

    const out = await closeOpenCall(
      { ...s.decideDeps, reportError, notifyOpenCallNotThisTime },
      { actorHumanId: OC_EDITOR_ID, formId: call.id },
    );

    expect(out.swept).toBe(2);
    expect(a.status).toBe("REJECTED");
    expect(notifyOpenCallNotThisTime).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "closeOpenCall", reason: "notice_failed", kind: "open_call_not_this_time" },
    });
  });
});

// ── Pulled (FR-022) ─────────────────────────────────────────────────────────

describe("pulled", () => {
  it("tells a pending applicant the call was pulled, once", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "EXPIRED");
    const notice = {
      kind: "open_call_pulled" as const,
      submissionId: sub.id,
      formId: call.id,
      anchor: { kind: "event" as const, eventId: call.eventId! },
      title: "Basement Show",
    };
    await s.notices.notifyOpenCallPulled(notice);
    await s.notices.notifyOpenCallPulled(notice);
    expect(sentTo(s, "open-call.pulled")).toEqual([sub.humanId]);
    expect(await openCallNoticeWasSent(s.idempotency, "pulled", sub.id)).toBe(true);
  });
});

// ── Dropped out (FR-017): the organizer side, edit rights only ───────────────

describe("dropped out", () => {
  const droppedNotice = (formId: string, submissionId: string, removedEventIds: string[]) => ({
    kind: "open_call_dropped_out" as const,
    submissionId,
    formId,
    anchor: { kind: "event" as const, eventId: removedEventIds[0]! },
    via: "status_link" as const,
    removedEventIds,
  });

  it("org event: ONE notice per edit-role member, even for several nights; never VIEWER/SCANNER/FINANCE or the act", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world);
    // The act's own submitter happens to be an editor of the event's org.
    const sub = s.world.addSubmission(call.id, "WITHDRAWN", { humanId: SECOND_EDITOR, guestName: null });
    const night2 = s.world.addEvent({ id: randomUUID(), startsAt: new Date(event.startsAt.getTime() + 86_400_000) });

    await s.notices.notifyOpenCallDroppedOut(droppedNotice(call.id, sub.id, [event.id, night2.id]));
    await s.notices.notifyOpenCallDroppedOut(droppedNotice(call.id, sub.id, [event.id, night2.id]));

    expect(sentTo(s, "open-call.dropped-out")).toEqual([OC_EDITOR_ID]);
    expect(sentTo(s, "open-call.dropped-out")).not.toContain(OC_VIEWER_ID);
    const payload = payloadOf(s, "open-call.dropped-out");
    expect(payload.dates).toHaveLength(2);
    expect(payload.actionUrl).toBe(
      `${BASE}/admin/org-${OC_ORG_ID.slice(-2)}/events/${event.id}/open-call?application=${sub.id}`,
    );
  });

  it("personal event: the owner and edit-role delegates; a VIEWER delegate is not told", async () => {
    const s = setup();
    const owner = randomUUID();
    const editDelegate = randomUUID();
    const viewDelegate = randomUUID();
    s.world.delegations.set(`${owner}:${editDelegate}`, "EDITOR");
    s.world.delegations.set(`${owner}:${viewDelegate}`, "VIEWER");
    const { event, call } = eventCall(s.world, { orgId: null, humanId: owner });
    const sub = s.world.addSubmission(call.id, "WITHDRAWN");

    await s.notices.notifyOpenCallDroppedOut(droppedNotice(call.id, sub.id, [event.id]));

    expect(sentTo(s, "open-call.dropped-out").sort()).toEqual([owner, editDelegate].sort());
    expect(payloadOf(s, "open-call.dropped-out").actionUrl).toBe(
      `${BASE}/admin/@${owner}/events/${event.id}/open-call?application=${sub.id}`,
    );
  });

  it("a person leaving their last picked night: editors get the dropped-out notice INSTEAD of lineup-left", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    await pickOpenCallApplication(s.decideDeps, pickInput(call.id, sub.id));

    await leaveEventLineup(
      {
        repos: {
          ...(s.world.repos as unknown as Record<string, unknown>),
          agreements: { findByLinkedEventId: async () => null },
          volunteering: { listSignupsByHuman: async () => [] },
        } as unknown as Repos,
        clock: s.clock,
        notify: s.notify as never,
        publicAppUrl: BASE,
        notifyOpenCallDroppedOut: s.notices.notifyOpenCallDroppedOut,
      },
      { actorHumanId: sub.humanId!, eventId: event.id },
    );

    expect(sub.status).toBe("WITHDRAWN");
    expect(sentTo(s, "event.lineup-left")).toEqual([]);
    expect(sentTo(s, "open-call.dropped-out").sort()).toEqual([OC_EDITOR_ID, SECOND_EDITOR].sort());
  });
});

// ── Messages (FR-015) ───────────────────────────────────────────────────────

describe("new message", () => {
  const msg = (formId: string, submissionId: string, over: Record<string, unknown> = {}) => ({
    formId,
    submissionId,
    messageId: randomUUID(),
    recipientSide: "ORGANIZER" as const,
    authorHumanId: null as string | null,
    body: "Can we bring our own amp?",
    ...over,
  });

  /** Store a real thread message (so the burst rule can read the thread), then its seam input. */
  let tick = 0;
  const post = async (
    s: Setup,
    formId: string,
    submissionId: string,
    recipientSide: "ORGANIZER" | "APPLICANT",
    body: string,
    authorHumanId: string | null = recipientSide === "APPLICANT" ? OC_EDITOR_ID : null,
  ) => {
    tick += 1;
    const row = await s.world.repos.eventApplications.createApplicationMessage({
      submissionId,
      authorSide: recipientSide === "APPLICANT" ? "ORGANIZER" : "APPLICANT",
      authorHumanId,
      body,
      createdAt: new Date(s.world.now.getTime() + tick * 60_000),
    });
    return { formId, submissionId, messageId: row.id, recipientSide, authorHumanId, body: row.body };
  };

  it("to the organizers: edit-role members only, minus the sender; named after the applicant", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", { humanId: null, guestName: "The Moths", contactEmail: "m@example.com" });

    await s.notices.notifyApplicationMessagePosted(msg(call.id, sub.id));

    expect(sentTo(s, "open-call.message-received").sort()).toEqual([OC_EDITOR_ID, SECOND_EDITOR].sort());
    expect(payloadOf(s, "open-call.message-received")).toMatchObject({
      authorName: "The Moths",
      preview: "Can we bring our own amp?",
      recipientSide: "ORGANIZER",
    });
  });

  it("to the applicant: the person, never the organizer who wrote it", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    await s.notices.notifyApplicationMessagePosted(
      msg(call.id, sub.id, { recipientSide: "APPLICANT", authorHumanId: OC_EDITOR_ID }),
    );
    expect(sentTo(s, "open-call.message-received")).toEqual([sub.humanId]);
  });

  it("the writer is never told about their own message, even when they are also an editor", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    await s.notices.notifyApplicationMessagePosted(
      msg(call.id, sub.id, { recipientSide: "ORGANIZER", authorHumanId: SECOND_EDITOR }),
    );
    expect(sentTo(s, "open-call.message-received")).toEqual([OC_EDITOR_ID]);
  });

  it(`a burst: messages to the same side within ${OPEN_CALL_MESSAGE_BURST_WINDOW_SEC / 60} minutes, with no reply between, send one notice`, async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    const send = async (side: "ORGANIZER" | "APPLICANT", body: string) =>
      s.notices.notifyApplicationMessagePosted(await post(s, call.id, sub.id, side, body, side === "APPLICANT" ? OC_EDITOR_ID : sub.humanId));
    await send("ORGANIZER", "Can we bring our own amp?");
    await send("ORGANIZER", "And a second thing");
    await send("ORGANIZER", "Third");
    expect(s.notify).toHaveBeenCalledTimes(2); // two editors, once each
    // The other side has its own window.
    await send("APPLICANT", "Sure, bring it.");
    expect(s.notify).toHaveBeenCalledTimes(3);
  });

  it("a back-and-forth never goes quiet: the recipient's reply opens a fresh window", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    // t=0 organizers write (applicant told), t=3 applicant replies
    // (organizers told), t=6 organizers follow up: the applicant is told again.
    await s.notices.notifyApplicationMessagePosted(await post(s, call.id, sub.id, "APPLICANT", "Can you do 9pm?"));
    await s.notices.notifyApplicationMessagePosted(
      await post(s, call.id, sub.id, "ORGANIZER", "Yes, 9 works.", sub.humanId),
    );
    await s.notices.notifyApplicationMessagePosted(await post(s, call.id, sub.id, "APPLICANT", "Great, see you then."));
    expect(sentTo(s, "open-call.message-received").filter((id) => id === sub.humanId)).toHaveLength(2);
    expect(sentTo(s, "open-call.message-received").sort()).toEqual(
      [sub.humanId, sub.humanId, OC_EDITOR_ID, SECOND_EDITOR].sort(),
    );
  });

  it("a first message that reached nobody does not hold the window: the next one is notified", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    s.notify.mockImplementationOnce(async () => {
      throw new Error("db blip");
    });
    const first = await post(s, call.id, sub.id, "APPLICANT", "First");
    await s.notices.notifyApplicationMessagePosted(first);
    expect(s.reportError).toHaveBeenCalledTimes(1);
    await s.notices.notifyApplicationMessagePosted(await post(s, call.id, sub.id, "APPLICANT", "Second"));
    expect(s.notify).toHaveBeenCalledTimes(2);
    expect(payloadOf(s, "open-call.message-received", 1).preview).toBe("Second");
    // A retry of the opener inside its window still reaches whoever it missed
    // (here nobody: it was the one that failed, and "Second" now holds it).
    await s.notices.notifyApplicationMessagePosted(first);
    expect(s.notify).toHaveBeenCalledTimes(2);
  });

  it("one editor missed the window's opener: the window is not held, so the follow-up reaches every editor", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    s.notify.mockImplementationOnce(async () => {
      throw new Error("db blip");
    });
    await s.notices.notifyApplicationMessagePosted(
      await post(s, call.id, sub.id, "ORGANIZER", "First", sub.humanId),
    );
    expect(s.notify).toHaveBeenCalledTimes(2); // one failed, one reached
    expect(s.reportError).toHaveBeenCalledTimes(1);
    await s.notices.notifyApplicationMessagePosted(
      await post(s, call.id, sub.id, "ORGANIZER", "Second", sub.humanId),
    );
    expect(s.notify).toHaveBeenCalledTimes(4);
    const second = s.notify.mock.calls.slice(2).map((c) => c[0].humanId).sort();
    expect(second).toEqual([OC_EDITOR_ID, SECOND_EDITOR].sort());
  });

  it("two messages in flight to one side: the second is NOT coalesced behind an unsettled window, so the first failing loses nothing", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    let releaseA!: () => void;
    const aBlocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aStarted!: () => void;
    const aInNotify = new Promise<void>((resolve) => {
      aStarted = resolve;
    });
    s.notify.mockImplementationOnce(async () => {
      aStarted();
      await aBlocked;
      throw new Error("db blip");
    });
    const a = await post(s, call.id, sub.id, "APPLICANT", "First");
    const b = await post(s, call.id, sub.id, "APPLICANT", "Second");

    const runA = s.notices.notifyApplicationMessagePosted(a);
    await aInNotify; // A holds the window claim, not yet settled
    await s.notices.notifyApplicationMessagePosted(b);
    releaseA();
    await runA;

    expect(s.reportError).toHaveBeenCalledTimes(1); // A's failed send
    const previews = s.notify.mock.calls.map((c) => (c[0].payload as { preview: string }).preview);
    expect(previews).toEqual(["First", "Second"]);
  });

  it("a long message full of emoji is clipped in UTF-16 units and still renders (no invalid payload)", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    const body = `a${"🎸".repeat(400)}`;
    await s.notices.notifyApplicationMessagePosted(await post(s, call.id, sub.id, "APPLICANT", body));
    expect(s.reportError).not.toHaveBeenCalled();
    expect(sentTo(s, "open-call.message-received")).toEqual([sub.humanId]);
    const preview = payloadOf(s, "open-call.message-received").preview as string;
    expect(preview.length).toBeLessThanOrEqual(240);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("a guest applicant: email to the contact address", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", { humanId: null, guestName: "The Moths", contactEmail: "m@example.com" });
    await s.notices.notifyApplicationMessagePosted(
      msg(call.id, sub.id, { recipientSide: "APPLICANT", authorHumanId: OC_EDITOR_ID }),
    );
    expect(s.notify).not.toHaveBeenCalled();
    const mail = mailContent(s);
    expect(mail.content.quote).toEqual({ label: "Message", text: "Can we bring our own amp?" });
    expect(mail.content.action!.url).toBe(statusUrlOf(call.publicId, sub.id));
  });
});

// ── Application received (FR-009) ───────────────────────────────────────────

describe("application received", () => {
  it("a signed-in submitter: in-app + email with the hub link, never a token; the org's other editors are not told", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const submitter = randomUUID();
    const sub = s.world.addSubmission(call.id, "PENDING", {
      humanId: submitter,
      applyingAsOrgId: OC_ORG_ID,
      statusTokenHash: deriveStatusToken(TEST_STATUS_TOKEN_SECRET, randomUUID()).hash,
    });
    await s.notices.notifyOpenCallApplicationReceived({
      kind: "application_received",
      submissionId: sub.id,
      formId: call.id,
    });
    expect(sentTo(s, "open-call.application-received")).toEqual([submitter]);
    expect(payloadOf(s, "open-call.application-received")).toMatchObject({
      callTitle: "Basement Show",
      actionUrl: `${BASE}/my-applications`,
    });
    expectNoTokenThroughNotify(s);
    expect(await openCallNoticeWasSent(s.idempotency, "received", sub.id)).toBe(true);
  });

  it("a guest: the email carries the status link, in their language; a re-send is a no-op", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "Las Polillas",
      contactEmail: "polillas@example.com",
      contactLocale: "es",
    });
    const notice = { kind: "application_received" as const, submissionId: sub.id, formId: call.id };
    await s.notices.notifyOpenCallApplicationReceived(notice);
    await s.notices.notifyOpenCallApplicationReceived(notice);
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.mailer.send).toHaveBeenCalledTimes(1);
    const mail = mailContent(s);
    expect(mail.content.locale).toBe("es");
    expect(mail.content.action!.url).toBe(statusUrlOf(call.publicId, sub.id));
    expect(mail.content.paragraphs.join(" ")).toContain("Guarda este correo");
  });

  it("a failed guest email is reported as application_received_failed, and a reconcile from the ids resends it", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "The Moths",
      contactEmail: "moths@example.com",
    });
    s.mailer.send.mockImplementationOnce(async () => {
      throw new Error("smtp down");
    });
    const notice = { kind: "application_received" as const, submissionId: sub.id, formId: call.id };
    await s.notices.notifyOpenCallApplicationReceived(notice);
    expect(s.reportError).toHaveBeenCalledTimes(1);
    expect(s.reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "openCallNotices", kind: "received", reason: "application_received_failed" },
    });
    expect(await openCallNoticeWasSent(s.idempotency, "received", sub.id)).toBe(false);

    // Step 8's reconcile: only the ids, the link is re-derived.
    await s.notices.notifyOpenCallApplicationReceived(notice);
    expect(s.mailer.send).toHaveBeenCalledTimes(2);
    expect(mailContent(s, 1).content.action!.url).toBe(statusUrlOf(call.publicId, sub.id));
    expect(await openCallNoticeWasSent(s.idempotency, "received", sub.id)).toBe(true);
  });

  it("a guest duplicate emails the address once an hour, pointing at the call", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const dup = {
      kind: "guest_duplicate" as const,
      contactEmail: "moths@example.com",
      publicId: call.publicId,
      title: "Basement Show",
    };
    await s.notices.notifyOpenCallApplicationReceived(dup);
    await s.notices.notifyOpenCallApplicationReceived(dup);
    expect(s.mailer.send).toHaveBeenCalledTimes(1);
    expect(mailContent(s).content.action!.url).toBe(`${BASE}/call/${call.publicId}`);
  });
});

// ── Failures ────────────────────────────────────────────────────────────────

describe("failures", () => {
  it("one recipient failing is reported, the others still hear, and a re-send reaches only the one missed", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "WITHDRAWN");
    s.notify.mockImplementationOnce(async () => {
      throw new Error("db blip");
    });
    const notice = {
      kind: "open_call_dropped_out" as const,
      submissionId: sub.id,
      formId: call.id,
      anchor: { kind: "event" as const, eventId: event.id },
      via: "status_link" as const,
      removedEventIds: [event.id],
    };

    await s.notices.notifyOpenCallDroppedOut(notice);
    expect(s.notify).toHaveBeenCalledTimes(2);
    expect(s.reportError).toHaveBeenCalledTimes(1);
    expect(s.reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "openCallNotices", kind: "dropped-out", reason: "send_failed" },
    });
    expect(await openCallNoticeWasSent(s.idempotency, "dropped-out", sub.id)).toBe(false);

    const failedOne = s.notify.mock.calls[0]![0].humanId;
    await s.notices.notifyOpenCallDroppedOut(notice);
    expect(s.notify).toHaveBeenCalledTimes(3);
    expect(s.notify.mock.calls[2]![0].humanId).toBe(failedOne);
    expect(await openCallNoticeWasSent(s.idempotency, "dropped-out", sub.id)).toBe(true);
  });

  it("a guest email with no mailer bound is reported, not thrown", async () => {
    const s = setup({ mailer: null });
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING", { humanId: null, guestName: "G", contactEmail: "g@example.com" });
    const out = await pickOpenCallApplication(s.decideDeps, pickInput(call.id, sub.id));
    await expect(s.notices.notifyOpenCallPicked(out.notice!)).resolves.toBeUndefined();
    expect(s.reportError).toHaveBeenCalledTimes(1);
    expect(await openCallNoticeWasSent(s.idempotency, "picked", sub.id)).toBe(false);
  });

  it("no web origin bound: the notifier throws, the seam reports it, and the decision stands", async () => {
    const s = setup({ publicAppUrl: null });
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    const reportError = vi.fn();

    const out = await declineOpenCallApplication(
      { ...s.decideDeps, reportError, notifyOpenCallNotThisTime: s.notices.notifyOpenCallNotThisTime },
      pickInput(call.id, sub.id),
    );

    expect(out.status).toBe("REJECTED");
    expect(sub.status).toBe("REJECTED");
    expect(s.notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "declineOpenCallApplication", reason: "notice_failed", kind: "open_call_not_this_time" },
      }),
    );
    expect(await openCallNoticeWasSent(s.idempotency, "not-this-time", sub.id)).toBe(false);
  });

  it("the ledger key is per (kind, submission)", () => {
    expect(openCallNoticeKey("not-this-time", "abc")).toBe("open-call-notice:not-this-time:abc");
  });
});
