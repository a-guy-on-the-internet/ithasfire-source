/**
 * Open calls v1 step 5 — the applicant <-> organizer thread (FR-015, Q22):
 * either side posts, lists and marks read; applicants by session or status
 * token (with expiry), organizers through the organizer-side resolver; a
 * WITHDRAWN thread is read-only; no notification is sent in step 5, but the
 * seam swallows-and-reports a throwing notifier.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import {
  OC_EDITOR_ID,
  OC_NOW,
  OC_ORG_ID,
  OC_OTHER_ORG_ID,
  OC_STRANGER_ID,
  OC_VIEWER_ID,
  createOpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { listApplicationMessages } from "../list-application-messages";
import { markApplicationMessagesRead } from "../mark-application-messages-read";
import { postApplicationMessage } from "../post-application-message";
import { hashStatusToken, STATUS_TOKEN_GRACE_MS } from "../_shared/status-token";
import { DAY } from "./open-call-application-helpers";

const TOKEN = "G".repeat(43);

/** A second organizer-side member: an EDITOR of the event's org (setup). */
const SECOND_EDITOR_ID = "30000000-0000-4000-8000-0000000000b4";

function setup() {
  const world = createOpenCallWorld();
  world.memberships.set(`${OC_ORG_ID}:${SECOND_EDITOR_ID}`, "EDITOR");
  let now = world.now;
  const clock = { now: () => now } as unknown as ClockPort;
  const deps = { repos: world.repos, clock };
  const event = world.addEvent();
  const call = world.addForm({ purpose: "PERFORM", eventId: event.id });
  const applicantId = randomUUID();
  const signedIn = world.addSubmission(call.id, "PENDING", { humanId: applicantId });
  const guest = world.addSubmission(call.id, "PENDING", {
    humanId: null,
    guestName: "The Moths",
    contactEmail: "moths@example.com",
    statusTokenHash: hashStatusToken(TOKEN),
  });
  const organizer = (submissionId: string, actorHumanId = OC_EDITOR_ID) => ({
    side: "ORGANIZER" as const,
    actorHumanId,
    formId: call.id,
    submissionId,
  });
  const viaToken = { side: "APPLICANT" as const, auth: { kind: "token" as const, token: TOKEN } };
  const viaSession = {
    side: "APPLICANT" as const,
    auth: { kind: "session" as const, actorHumanId: applicantId, submissionId: signedIn.id },
  };
  return {
    world,
    deps,
    event,
    call,
    signedIn,
    guest,
    applicantId,
    organizer,
    viaToken,
    viaSession,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    setNow: (d: Date) => {
      now = d;
    },
  };
}

describe("postApplicationMessage", () => {
  it("guest replies through the status token; organizer posts; both read the same thread in order", async () => {
    const s = setup();
    const a = await postApplicationMessage(s.deps, { party: s.organizer(s.guest.id), body: "Can you do 9pm?" });
    s.advance(60_000);
    const b = await postApplicationMessage(s.deps, { party: s.viaToken, body: "  Yes we can!  " });
    expect(a.message).toMatchObject({ authorSide: "ORGANIZER", authorHumanId: OC_EDITOR_ID });
    expect(b.message).toMatchObject({ authorSide: "APPLICANT", body: "Yes we can!" });
    // Token messages carry no human author (whoever holds the link).
    expect(s.world.messages.at(-1)!.authorHumanId).toBeNull();

    const applicantView = await listApplicationMessages(s.deps, { party: s.viaToken });
    expect(applicantView.items.map((m) => m.body)).toEqual(["Can you do 9pm?", "Yes we can!"]);
    // The applicant never learns which organizer member wrote.
    expect(applicantView.items.every((m) => m.authorHumanId === null)).toBe(true);
    expect(applicantView.readOnly).toBe(false);

    const organizerView = await listApplicationMessages(s.deps, { party: s.organizer(s.guest.id, SECOND_EDITOR_ID) });
    expect(organizerView.items[0]!.authorHumanId).toBe(OC_EDITOR_ID);
    expect(s.world.audit.filter((x) => x.action === "open_call_application_message_posted")).toHaveLength(2);
    expect(JSON.stringify(s.world.audit)).not.toContain("Yes we can");
  });

  it("signed-in applicant posts by session; another human's session is refused", async () => {
    const s = setup();
    const out = await postApplicationMessage(s.deps, { party: s.viaSession, body: "Hello" });
    expect(s.world.messages.at(-1)!.authorHumanId).toBe(s.applicantId);
    expect(out.message.authorHumanId).toBeNull();
    await expect(
      postApplicationMessage(s.deps, {
        party: {
          side: "APPLICANT",
          auth: { kind: "session", actorHumanId: OC_STRANGER_ID, submissionId: s.signedIn.id },
        },
        body: "Hi",
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
  });

  it("allowed after a decision (REJECTED can be answered) and on EXPIRED; WITHDRAWN is read-only for both sides", async () => {
    const s = setup();
    s.guest.status = "REJECTED";
    await postApplicationMessage(s.deps, { party: s.viaToken, body: "Thanks anyway" });
    s.guest.status = "EXPIRED";
    await postApplicationMessage(s.deps, { party: s.organizer(s.guest.id), body: "Sorry the night was pulled" });

    s.guest.status = "WITHDRAWN";
    await expect(postApplicationMessage(s.deps, { party: s.viaToken, body: "x" })).rejects.toMatchObject({
      code: "OPEN_CALL_THREAD_CLOSED",
    });
    await expect(
      postApplicationMessage(s.deps, { party: s.organizer(s.guest.id), body: "x" }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_THREAD_CLOSED" });
    // Still readable, flagged read-only.
    const view = await listApplicationMessages(s.deps, { party: s.viaToken });
    expect(view.items).toHaveLength(2);
    expect(view.readOnly).toBe(true);
  });

  it("an expired token can't post or read (OPEN_CALL_LINK_EXPIRED); the session still can", async () => {
    const s = setup();
    s.setNow(new Date(s.event.endsAt.getTime() + STATUS_TOKEN_GRACE_MS + DAY));
    await expect(postApplicationMessage(s.deps, { party: s.viaToken, body: "hi" })).rejects.toMatchObject({
      code: "OPEN_CALL_LINK_EXPIRED",
    });
    await expect(listApplicationMessages(s.deps, { party: s.viaToken })).rejects.toMatchObject({
      code: "OPEN_CALL_LINK_EXPIRED",
    });
    await expect(postApplicationMessage(s.deps, { party: s.viaSession, body: "hi" })).resolves.toBeTruthy();
  });

  it("organizer authz: stranger, VIEWER, SCANNER, other-org member and cross-call ids are refused", async () => {
    const s = setup();
    const scanner = randomUUID();
    s.world.memberships.set(`${OC_ORG_ID}:${scanner}`, "SCANNER");
    const otherOrgMember = randomUUID();
    s.world.memberships.set(`${OC_OTHER_ORG_ID}:${otherOrgMember}`, "OWNER");
    const yEvent = s.world.addEvent({ id: randomUUID(), orgId: OC_OTHER_ORG_ID });
    const callY = s.world.addForm({ purpose: "PERFORM", eventId: yEvent.id });
    for (const party of [
      s.organizer(s.guest.id, OC_STRANGER_ID),
      // The event's own org members without edit rights (FR-014 as amended).
      s.organizer(s.guest.id, OC_VIEWER_ID),
      s.organizer(s.guest.id, scanner),
      s.organizer(s.guest.id, otherOrgMember),
      { side: "ORGANIZER" as const, actorHumanId: otherOrgMember, formId: callY.id, submissionId: s.guest.id },
    ]) {
      await expect(postApplicationMessage(s.deps, { party, body: "hi" })).rejects.toMatchObject({
        code: "OPEN_CALL_APPLICATION_NOT_FOUND",
      });
      await expect(listApplicationMessages(s.deps, { party })).rejects.toMatchObject({
        code: "OPEN_CALL_APPLICATION_NOT_FOUND",
      });
    }
    expect(s.world.messages).toHaveLength(0);
  });

  it("one thread per application: an applicant's token reaches only their own thread", async () => {
    const s = setup();
    await postApplicationMessage(s.deps, { party: s.organizer(s.signedIn.id), body: "to the signed-in act" });
    await postApplicationMessage(s.deps, { party: s.organizer(s.guest.id), body: "to the guest" });
    const guestView = await listApplicationMessages(s.deps, { party: s.viaToken });
    expect(guestView.items.map((m) => m.body)).toEqual(["to the guest"]);
    // The applicant party has no field to name another submission.
    await expect(
      listApplicationMessages(s.deps, {
        party: { ...s.viaToken, submissionId: s.signedIn.id },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("body: trimmed, sanitized, 1..4000", async () => {
    const s = setup();
    await expect(postApplicationMessage(s.deps, { party: s.viaToken, body: "   " })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      postApplicationMessage(s.deps, { party: s.viaToken, body: "x".repeat(4001) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("notice seam: the notifier gets the other side, the author and the body; a throwing notifier is reported, the message stands", async () => {
    const s = setup();
    const notify = vi.fn().mockResolvedValue(undefined);
    await postApplicationMessage(
      { ...s.deps, notifyApplicationMessagePosted: notify },
      { party: s.viaToken, body: "hi" },
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientSide: "ORGANIZER",
        submissionId: s.guest.id,
        formId: s.call.id,
        // Through a status token there is no signed-in author.
        authorHumanId: null,
        body: "hi",
      }),
    );

    const boom = new Error("mail down");
    const reportError = vi.fn(() => {
      throw new Error("reporter down too");
    });
    const out = await postApplicationMessage(
      { ...s.deps, notifyApplicationMessagePosted: vi.fn().mockRejectedValue(boom), reportError },
      { party: s.organizer(s.guest.id), body: "hello" },
    );
    expect(out.message.body).toBe("hello");
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: { useCase: "postApplicationMessage" } }),
    );
    expect(s.world.messages).toHaveLength(2);
  });
});

describe("listApplicationMessages pagination", () => {
  it("oldest first with a message-id cursor", async () => {
    const s = setup();
    for (let i = 0; i < 5; i += 1) {
      await postApplicationMessage(s.deps, { party: s.organizer(s.guest.id), body: `m${i}` });
      s.advance(1000);
    }
    const p1 = await listApplicationMessages(s.deps, { party: s.viaToken, limit: 2 });
    const p2 = await listApplicationMessages(s.deps, { party: s.viaToken, limit: 2, cursor: p1.nextCursor });
    const p3 = await listApplicationMessages(s.deps, { party: s.viaToken, limit: 2, cursor: p2.nextCursor });
    expect([...p1.items, ...p2.items, ...p3.items].map((m) => m.body)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(p3.nextCursor).toBeNull();
  });
});

describe("markApplicationMessagesRead", () => {
  it("stamps only the other side's unread rows up to the cutoff; monotonic and idempotent", async () => {
    const s = setup();
    await postApplicationMessage(s.deps, { party: s.viaToken, body: "a1" });
    s.advance(1000);
    await postApplicationMessage(s.deps, { party: s.organizer(s.guest.id), body: "o1" });
    s.advance(1000);
    const cutoff = new Date(OC_NOW.getTime() + 1500);
    await postApplicationMessage(s.deps, { party: s.viaToken, body: "a2" });
    s.advance(1000);

    // Organizer reads up to the cutoff: only a1 (applicant's, before cutoff).
    let out = await markApplicationMessagesRead(s.deps, {
      party: s.organizer(s.guest.id, SECOND_EDITOR_ID),
      upToCreatedAt: cutoff,
    });
    expect(out.updated).toBe(1);
    const a1 = s.world.messages.find((m) => m.body === "a1")!;
    const firstStamp = a1.readAt;
    expect(firstStamp).not.toBeNull();
    expect(s.world.messages.find((m) => m.body === "o1")!.readAt).toBeNull();

    // Repeat later: a1 keeps its first stamp; a2 now stamped.
    s.advance(60_000);
    out = await markApplicationMessagesRead(s.deps, {
      party: s.organizer(s.guest.id),
      upToCreatedAt: new Date(OC_NOW.getTime() + DAY),
    });
    expect(out.updated).toBe(1);
    expect(a1.readAt).toEqual(firstStamp);
    out = await markApplicationMessagesRead(s.deps, {
      party: s.organizer(s.guest.id),
      upToCreatedAt: new Date(OC_NOW.getTime() + DAY),
    });
    expect(out.updated).toBe(0);

    // The applicant reading stamps the organizer's o1 only.
    out = await markApplicationMessagesRead(s.deps, {
      party: s.viaToken,
      upToCreatedAt: new Date(OC_NOW.getTime() + DAY),
    });
    expect(out.updated).toBe(1);
    expect(s.world.messages.find((m) => m.body === "o1")!.readAt).not.toBeNull();
  });

  it("works on a WITHDRAWN thread; refuses a stranger", async () => {
    const s = setup();
    await postApplicationMessage(s.deps, { party: s.viaToken, body: "a1" });
    s.guest.status = "WITHDRAWN";
    const out = await markApplicationMessagesRead(s.deps, {
      party: s.organizer(s.guest.id),
      upToCreatedAt: new Date(OC_NOW.getTime() + DAY),
    });
    expect(out.updated).toBe(1);
    await expect(
      markApplicationMessagesRead(s.deps, {
        party: s.organizer(s.guest.id, OC_STRANGER_ID),
        upToCreatedAt: new Date(OC_NOW.getTime() + DAY),
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
  });
});
