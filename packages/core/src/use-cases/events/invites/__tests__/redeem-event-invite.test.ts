import { describe, expect, it, vi } from "vitest";

import type { EventApplicationSubmissionRecord } from "@th/ports/repos/events";
import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_OPT_OUT_SECRET,
  INVITE_EVENT_ID,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  INVITE_VIEWER_ID,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import { mintInviteToken } from "../../../../lib/security/invite-token";
import { loadApprovedApplicationGrantSubmission } from "../../_shared/application-gate-grant";
import { createEventGuestInvites } from "../create-event-guest-invites";
import { inviteGrantHolds } from "../invite-grant";
import { redeemEventInvite } from "../redeem-event-invite";
import { revokeEventGuestInvite } from "../revoke-event-guest-invite";
import { setEventSharedInvite } from "../set-event-shared-invite";

const linkDeps = (world: InviteWorld) => ({
  repos: world.repos,
  clock: world.clock,
  inviteTokenSecret: INVITE_SECRET,
  appBaseUrl: INVITE_APP_BASE_URL,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
  mailer: {
    send: vi.fn(async () => ({ result: { id: "m", status: "queued" } })),
  } as never,
});

const redeemDeps = (world: InviteWorld) => ({
  repos: world.repos,
  clock: world.clock,
  inviteTokenSecret: INVITE_SECRET,
});

async function sharedToken(world: InviteWorld): Promise<string> {
  const out = await setEventSharedInvite(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    action: "ENABLE",
  });
  return mintInviteToken(out.id as string, INVITE_SECRET);
}

async function personalToken(
  world: InviteWorld,
  email = "guest@example.com",
): Promise<{ token: string; inviteId: string }> {
  await createEventGuestInvites(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    guests: [{ name: "Guest", email }],
  });
  const invite = world.invites.find((i) => i.inviteeEmail === email)!;
  return { token: mintInviteToken(invite.id, INVITE_SECRET), inviteId: invite.id };
}

const redeem = (
  world: InviteWorld,
  token: string,
  viewerHumanId: string | null = null,
  currentInviteGrantId: string | null = null,
) =>
  redeemEventInvite(redeemDeps(world), {
    token,
    viewerHumanId,
    currentInviteGrantId,
  });

function seedSubmission(
  world: InviteWorld,
  overrides: Partial<EventApplicationSubmissionRecord>,
): EventApplicationSubmissionRecord {
  const purpose = overrides.purpose ?? "ATTEND";
  const row = {
    id: `7${world.submissions.length}000000-0000-4000-8000-000000000000`,
    formId: world.formFor(purpose).id,
    purpose,
    eventId: INVITE_EVENT_ID,
    humanId: INVITE_VIEWER_ID,
    contactEmail: null,
    contactPhone: null,
    status: "PENDING",
    answers: { q: "a" },
    decisionReason: null,
    questionsSnapshot: {},
    reviewerHumanId: null,
    reviewedAt: null,
    approvalToken: null,
    tokenExpiresAt: null,
    inviteId: null,
    metadata: {},
    createdAt: world.now,
    updatedAt: world.now,
    ...overrides,
  } as EventApplicationSubmissionRecord;
  world.submissions.push(row);
  return row;
}

describe("redeemEventInvite — dead links (FR-008, FR-010)", () => {
  it.each([
    ["garbage", "not-a-token"],
    ["a well-formed token no secret minted", `inv_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}_${"A".repeat(43)}`],
  ])("%s → INVALID, never a throw", async (_, token) => {
    const world = createInviteWorld();
    await expect(redeem(world, token)).resolves.toEqual({
      ok: false,
      reason: "INVALID",
      eventId: null,
      slug: null,
    });
  });

  it("a validly signed token with no row → INVALID", async () => {
    const world = createInviteWorld();
    const token = mintInviteToken(
      "12345678-1234-4234-8234-123456789abc",
      INVITE_SECRET,
    );
    await expect(redeem(world, token)).resolves.toMatchObject({
      ok: false,
      reason: "INVALID",
    });
  });

  it("a token signed with another secret → INVALID", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    const forged = mintInviteToken(world.invites[0]!.id, "x".repeat(48));
    expect(forged).not.toBe(token);
    await expect(redeem(world, forged)).resolves.toMatchObject({
      ok: false,
      reason: "INVALID",
    });
  });

  it.each([
    ["signed out, SHARED, PASSWORD event", "PASSWORD", "shared", null],
    ["signed in, PERSONAL, APPLICATION event", "APPLICATION", "personal", INVITE_VIEWER_ID],
  ] as const)(
    "%s: expectedEventId naming another event → INVALID, nothing counted or written (F7)",
    async (_, gateType, kind, viewer) => {
      const world = createInviteWorld({ event: { gateType } });
      const token =
        kind === "shared" ? await sharedToken(world) : (await personalToken(world)).token;
      const auditBefore = world.audit.length;

      await expect(
        redeemEventInvite(redeemDeps(world), {
          token,
          viewerHumanId: viewer,
          expectedEventId: "99999999-0000-4000-8000-000000000099",
        }),
      ).resolves.toEqual({ ok: false, reason: "INVALID", eventId: null, slug: null });
      expect(world.invites[0]!.redemptionCount).toBe(0);
      expect(world.unlocks.size).toBe(0);
      expect(world.submissions).toHaveLength(0);
      expect(world.audit).toHaveLength(auditBefore);

      // The same token with its own event id still redeems.
      await expect(
        redeemEventInvite(redeemDeps(world), {
          token,
          viewerHumanId: viewer,
          expectedEventId: INVITE_EVENT_ID,
        }),
      ).resolves.toMatchObject({ ok: true, eventId: INVITE_EVENT_ID });
    },
  );

  it("a reset SHARED link → REVOKED, and lands on the event", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "RESET",
    });
    await expect(redeem(world, token)).resolves.toEqual({
      ok: false,
      reason: "REVOKED",
      eventId: INVITE_EVENT_ID,
      slug: "basement-show",
    });
  });

  it("an ended event → EVENT_ENDED (end = endsAt, else startsAt)", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    world.event.endsAt = null;
    world.event.startsAt = new Date(world.now.getTime() - 1);
    await expect(redeem(world, token)).resolves.toMatchObject({
      ok: false,
      reason: "EVENT_ENDED",
    });
  });

  it.each([
    ["CANCELLED", "EVENT_CANCELLED"],
    ["DRAFT", "EVENT_UNAVAILABLE"],
    ["ARCHIVED", "EVENT_UNAVAILABLE"],
  ] as const)("a %s event → %s", async (status, reason) => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    world.event.status = status;
    await expect(redeem(world, token)).resolves.toMatchObject({
      ok: false,
      reason,
    });
  });

  it("an event whose gate was removed → NOT_GATED", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    world.event.gateType = "NONE";
    await expect(redeem(world, token)).resolves.toMatchObject({
      ok: false,
      reason: "NOT_GATED",
    });
  });

  it("a revoke that commits while the redemption runs → REVOKED (row lock read)", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    const original = world.repos.eventInvites.recordRedemption;
    world.repos.eventInvites.recordRedemption = async (id, at) => {
      world.invites[0]!.revokedAt = world.now;
      return original(id, at);
    };
    await expect(redeem(world, token, INVITE_VIEWER_ID)).resolves.toMatchObject({
      ok: false,
      reason: "REVOKED",
    });
  });
});

describe("redeemEventInvite — deadlock retry", () => {
  it.each([
    ["P2034 (interactive tx)", { code: "P2034", message: "write conflict or a deadlock" }],
    ["raw SQLSTATE 40P01", { message: "Raw query failed. Code: `40P01`. Message: deadlock detected" }],
  ])("a transaction aborted for a deadlock (%s) is retried once and succeeds", async (_, abort) => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const token = await sharedToken(world);
    const realTx = world.repos.tx;
    let calls = 0;
    world.repos.tx = (async (fn: never) => {
      calls += 1;
      if (calls === 1) throw abort;
      return realTx(fn);
    }) as typeof world.repos.tx;

    await expect(redeem(world, token, INVITE_VIEWER_ID)).resolves.toMatchObject({
      ok: true,
      grant: "UNLOCK",
    });
    expect(calls).toBe(2);
  });

  it("a second deadlock propagates (one retry only)", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const token = await sharedToken(world);
    let calls = 0;
    world.repos.tx = (async () => {
      calls += 1;
      throw { code: "P2034", message: "deadlock" };
    }) as typeof world.repos.tx;

    await expect(redeem(world, token, INVITE_VIEWER_ID)).rejects.toMatchObject({
      code: "P2034",
    });
    expect(calls).toBe(2);
  });
});

describe("redeemEventInvite — PASSWORD event (FR-004)", () => {
  it("signed in → EventUnlock (MAGIC_LINK, inviteId), counted once", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    const out = await redeem(world, token, INVITE_VIEWER_ID);

    expect(out).toMatchObject({
      ok: true,
      grant: "UNLOCK",
      eventId: INVITE_EVENT_ID,
      slug: "basement-show",
      inviteId: world.invites[0]!.id,
      inviteKind: "SHARED",
      submissionId: null,
      approvedAtMs: null,
      expiresAt: world.event.endsAt,
      created: true,
    });
    expect(
      world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`),
    ).toMatchObject({
      source: "MAGIC_LINK",
      inviteId: world.invites[0]!.id,
      applicationSubmissionId: null,
      revokedAt: null,
    });
    expect(world.invites[0]).toMatchObject({
      redemptionCount: 1,
      firstRedeemedAt: world.now,
    });
    expect(world.audit.at(-1)).toMatchObject({ action: "event_invite_redeemed" });
  });

  it("re-redeeming is a no-op returning the same grant (no recount)", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    await redeem(world, token, INVITE_VIEWER_ID);
    const again = await redeem(world, token, INVITE_VIEWER_ID);
    expect(again).toMatchObject({ ok: true, grant: "UNLOCK", created: false });
    expect(world.invites[0]!.redemptionCount).toBe(1);
  });

  it("never overwrites an existing LIVE unlock (revoking the invite later must not strip it)", async () => {
    const world = createInviteWorld();
    const { token, inviteId } = await personalToken(world);
    await world.repos.eventUnlocks.upsert({
      eventId: INVITE_EVENT_ID,
      humanId: INVITE_VIEWER_ID,
      source: "PASSWORD",
    });

    const out = await redeem(world, token, INVITE_VIEWER_ID);
    expect(out).toMatchObject({ ok: true, grant: "UNLOCK", created: false });
    const unlock = world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`);
    expect(unlock).toMatchObject({ source: "PASSWORD", inviteId: null });
    expect(world.invites[0]!.redemptionCount).toBe(0);

    await revokeEventGuestInvite(
      { repos: world.repos, clock: world.clock },
      { eventId: INVITE_EVENT_ID, inviteId, actorHumanId: INVITE_ORGANIZER_ID },
    );
    expect(
      world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`)?.revokedAt,
    ).toBeNull();
  });

  it("a REVOKED earlier unlock is replaced", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    await world.repos.eventUnlocks.upsert({
      eventId: INVITE_EVENT_ID,
      humanId: INVITE_VIEWER_ID,
      source: "PASSWORD",
    });
    await world.repos.eventUnlocks.revoke(INVITE_EVENT_ID, INVITE_VIEWER_ID);
    const out = await redeem(world, token, INVITE_VIEWER_ID);
    expect(out).toMatchObject({ ok: true, created: true });
    expect(
      world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`),
    ).toMatchObject({ source: "MAGIC_LINK", revokedAt: null });
  });

  it.each(["SHARED", "PERSONAL"] as const)(
    "signed out, %s → INVITE_GRANT, no row",
    async (kind) => {
      const world = createInviteWorld();
      const token =
        kind === "SHARED"
          ? await sharedToken(world)
          : (await personalToken(world)).token;
      const out = await redeem(world, token, null);
      expect(out).toMatchObject({
        ok: true,
        grant: "INVITE_GRANT",
        inviteKind: kind,
        submissionId: null,
        expiresAt: world.event.endsAt,
        created: true,
      });
      expect(world.unlocks.size).toBe(0);
      expect(world.submissions).toHaveLength(0);
      expect(world.invites[0]!.redemptionCount).toBe(1);
    },
  );

  it("signed out with the same invite's grant cookie already set → not recounted", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    const out = await redeem(world, token, null, world.invites[0]!.id);
    expect(out).toMatchObject({ ok: true, grant: "INVITE_GRANT", created: false });
    expect(world.invites[0]!.redemptionCount).toBe(0);
  });
});

describe("redeemEventInvite — APPLICATION event (FR-005, R4, R15)", () => {
  const appWorld = () => createInviteWorld({ event: { gateType: "APPLICATION" } });

  it("signed in, no submission → a new APPROVED submission (no answers, inviteId) and an unlock carrying it", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const out = await redeem(world, token, INVITE_VIEWER_ID);

    expect(world.submissions).toHaveLength(1);
    const sub = world.submissions[0]!;
    expect(sub).toMatchObject({
      humanId: INVITE_VIEWER_ID,
      status: "APPROVED",
      answers: {},
      inviteId: world.invites[0]!.id,
      reviewerHumanId: null,
      reviewedAt: world.now,
    });
    expect(out).toMatchObject({
      ok: true,
      grant: "UNLOCK",
      submissionId: sub.id,
      approvedAtMs: null,
      created: true,
    });
    expect(
      world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`),
    ).toMatchObject({ source: "APPLICATION", applicationSubmissionId: sub.id });
  });

  it.each(["PENDING", "WAITLISTED"] as const)(
    "signed in with an open %s submission → that submission is approved through the approve path",
    async (status) => {
      const world = appWorld();
      const token = await sharedToken(world);
      const open = seedSubmission(world, { status });
      const out = await redeem(world, token, INVITE_VIEWER_ID);

      expect(world.submissions).toHaveLength(1);
      expect(world.submissions[0]).toMatchObject({
        id: open.id,
        status: "APPROVED",
        answers: { q: "a" },
        inviteId: world.invites[0]!.id,
        approvalToken: expect.any(String),
      });
      expect(out).toMatchObject({ ok: true, submissionId: open.id, created: true });
      expect(
        world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`),
      ).toMatchObject({ applicationSubmissionId: open.id });
    },
  );

  it("signed in, already APPROVED by the organizer but no live unlock → unlock restored, approval left as the organizer's", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const approved = seedSubmission(world, {
      status: "APPROVED",
      reviewedAt: new Date("2026-10-01T00:00:00Z"),
      reviewerHumanId: INVITE_ORGANIZER_ID,
    });
    const out = await redeem(world, token, INVITE_VIEWER_ID);
    expect(out).toMatchObject({ ok: true, submissionId: approved.id, created: true });
    expect(world.submissions[0]).toMatchObject({
      inviteId: null,
      reviewerHumanId: INVITE_ORGANIZER_ID,
    });
    expect(
      world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`),
    ).toMatchObject({ source: "APPLICATION", applicationSubmissionId: approved.id });
  });

  it("R15: someone previously REJECTED who uses the shared link gets a NEW approved submission", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const rejected = seedSubmission(world, {
      status: "REJECTED",
      decisionReason: "full",
      reviewedAt: new Date("2026-10-01T00:00:00Z"),
    });
    const out = await redeem(world, token, INVITE_VIEWER_ID);

    expect(world.submissions).toHaveLength(2);
    expect(world.submissions[0]).toMatchObject({ id: rejected.id, status: "REJECTED" });
    const fresh = world.submissions[1]!;
    expect(fresh).toMatchObject({
      status: "APPROVED",
      inviteId: world.invites[0]!.id,
      answers: {},
    });
    expect(out).toMatchObject({ ok: true, submissionId: fresh.id });
  });

  it("sends NO approval email or notification", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const deps = {
      ...redeemDeps(world),
      // Anything extra a future edit might wire in must stay unused.
      notify: vi.fn(),
      mailer: { send: vi.fn() },
    };
    await redeemEventInvite(deps, { token, viewerHumanId: INVITE_VIEWER_ID });
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.mailer.send).not.toHaveBeenCalled();
  });

  it("re-redeeming is a no-op returning the same grant", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const first = await redeem(world, token, INVITE_VIEWER_ID);
    const again = await redeem(world, token, INVITE_VIEWER_ID);
    expect(again).toMatchObject({
      ok: true,
      grant: "UNLOCK",
      submissionId: first.ok ? first.submissionId : "x",
      created: false,
    });
    expect(world.submissions).toHaveLength(1);
    expect(world.invites[0]!.redemptionCount).toBe(1);
  });

  it("a concurrent redeem winning the open-application index is retried and becomes a no-op", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const original = world.repos.eventApplications.createSubmission;
    let raced = false;
    world.repos.eventApplications.createSubmission = async (input) => {
      if (!raced) {
        raced = true;
        // The other tab commits its approval + unlock first.
        const winner = await original(input);
        await world.repos.eventApplications.updateSubmissionStatus({
          submissionId: winner.id,
          status: "APPROVED",
          reviewedAt: world.now,
        });
        await world.repos.eventUnlocks.upsert({
          eventId: INVITE_EVENT_ID,
          humanId: INVITE_VIEWER_ID,
          source: "APPLICATION",
          applicationSubmissionId: winner.id,
        });
        throw { code: "duplicate_open_application", message: "x" };
      }
      return original(input);
    };
    const out = await redeem(world, token, INVITE_VIEWER_ID);
    expect(out).toMatchObject({ ok: true, grant: "UNLOCK", created: false });
    expect(world.submissions).toHaveLength(1);
  });

  it("signed out, SHARED → INVITE_GRANT and no row (R4)", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const out = await redeem(world, token, null);
    expect(out).toMatchObject({ ok: true, grant: "INVITE_GRANT", created: true });
    expect(world.submissions).toHaveLength(0);
  });

  it("signed out, PERSONAL → APPROVED guest submission at the invitee's email + APPLICATION_GRANT", async () => {
    const world = appWorld();
    const { token, inviteId } = await personalToken(world, "guest@example.com");
    const out = await redeem(world, token, null);

    expect(world.submissions).toHaveLength(1);
    const sub = world.submissions[0]!;
    expect(sub).toMatchObject({
      humanId: null,
      contactEmail: "guest@example.com",
      status: "APPROVED",
      inviteId,
      answers: {},
    });
    expect(out).toMatchObject({
      ok: true,
      grant: "APPLICATION_GRANT",
      inviteKind: "PERSONAL",
      submissionId: sub.id,
      approvedAtMs: world.now.getTime(),
      created: true,
    });
    expect(world.unlocks.size).toBe(0);

    // Second device: same grant, nothing new.
    const again = await redeem(world, token, null);
    expect(again).toMatchObject({
      ok: true,
      grant: "APPLICATION_GRANT",
      submissionId: sub.id,
      approvedAtMs: world.now.getTime(),
      created: false,
    });
    expect(world.submissions).toHaveLength(1);

    // That APPLICATION_GRANT rides THIS invite's own approval, so revoking
    // the invite rescinds it and both devices' th_ea_ grants stop holding.
    await revokeEventGuestInvite(
      { repos: world.repos, clock: world.clock },
      { eventId: INVITE_EVENT_ID, inviteId, actorHumanId: INVITE_ORGANIZER_ID },
    );
    await expect(
      loadApprovedApplicationGrantSubmission(
        world.repos,
        world.event,
        { submissionId: sub.id, approvedAtMs: world.now.getTime() },
      ),
    ).resolves.toBeNull();
  });

  it("signed out, PERSONAL, invitee ALREADY APPROVED by the organizer → INVITE_GRANT (not th_ea_ on the organizer's approval); revoking the invite removes the link holder", async () => {
    const world = appWorld();
    const { token, inviteId } = await personalToken(world, "guest@example.com");
    const organizerApproval = seedSubmission(world, {
      humanId: null,
      contactEmail: "guest@example.com",
      status: "APPROVED",
      reviewerHumanId: INVITE_ORGANIZER_ID,
      reviewedAt: new Date("2026-10-01T00:00:00Z"),
    });

    const out = await redeem(world, token, null);
    expect(out).toMatchObject({
      ok: true,
      grant: "INVITE_GRANT",
      submissionId: null,
      approvedAtMs: null,
      created: true,
    });
    expect(world.submissions).toHaveLength(1);
    expect(world.invites[0]!.redemptionCount).toBe(1);

    // Forwarded to a second browser that already holds the cookie: no-op.
    await expect(redeem(world, token, null, inviteId)).resolves.toMatchObject({
      grant: "INVITE_GRANT",
      created: false,
    });
    expect(world.invites[0]!.redemptionCount).toBe(1);

    const grant = { inviteId, expMs: (world.event.endsAt as Date).getTime() };
    await expect(
      inviteGrantHolds(world.repos.eventInvites, world.event, grant, world.now),
    ).resolves.toBe(true);

    await revokeEventGuestInvite(
      { repos: world.repos, clock: world.clock },
      { eventId: INVITE_EVENT_ID, inviteId, actorHumanId: INVITE_ORGANIZER_ID },
    );
    await expect(
      inviteGrantHolds(world.repos.eventInvites, world.event, grant, world.now),
    ).resolves.toBe(false);
    // The organizer's own approval of the invitee is untouched.
    expect(world.submissions[0]).toMatchObject({
      id: organizerApproval.id,
      status: "APPROVED",
      inviteId: null,
    });
  });

  it("signed out, PERSONAL, with the guest's open PENDING application → that one is approved", async () => {
    const world = appWorld();
    const { token, inviteId } = await personalToken(world, "guest@example.com");
    const open = seedSubmission(world, {
      humanId: null,
      contactEmail: "guest@example.com",
    });
    const out = await redeem(world, token, null);
    expect(world.submissions).toHaveLength(1);
    expect(world.submissions[0]).toMatchObject({
      id: open.id,
      status: "APPROVED",
      inviteId,
    });
    expect(out).toMatchObject({ grant: "APPLICATION_GRANT", submissionId: open.id });
  });
});

describe("redeemEventInvite — review round 1", () => {
  const appWorld = () => createInviteWorld({ event: { gateType: "APPLICATION" } });

  it("PASSWORD: a live unlock that appears between the pre-check and the write is re-read under the lock and left alone", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    const realGet = world.repos.eventUnlocks.get;
    let calls = 0;
    world.repos.eventUnlocks.get = async (eventId, humanId) => {
      calls += 1;
      if (calls === 1) {
        // The pre-check sees nothing; a concurrent password unlock then
        // commits before this redeem takes the invite's row lock.
        await world.repos.eventUnlocks.upsert({
          eventId,
          humanId,
          source: "PASSWORD",
        });
        return null;
      }
      return realGet(eventId, humanId);
    };

    const out = await redeem(world, token, INVITE_VIEWER_ID);
    expect(out).toMatchObject({ ok: true, grant: "UNLOCK", created: false });
    expect(
      world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`),
    ).toMatchObject({ source: "PASSWORD", inviteId: null });
  });

  it("invite-approved unlocks carry the inviteId (revokeByInvite reaches them)", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    await redeem(world, token, INVITE_VIEWER_ID);
    expect(
      world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`),
    ).toMatchObject({
      source: "APPLICATION",
      inviteId: world.invites[0]!.id,
      applicationSubmissionId: world.submissions[0]!.id,
    });
  });

  it("signed in, PENDING → approved with inviteId, answers kept, nothing on the waitlist touched", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const open = seedSubmission(world, { status: "PENDING" });
    await redeem(world, token, INVITE_VIEWER_ID);
    expect(world.submissions).toHaveLength(1);
    expect(world.submissions[0]).toMatchObject({
      id: open.id,
      status: "APPROVED",
      answers: { q: "a" },
      inviteId: world.invites[0]!.id,
    });
    expect(world.waitlist).toHaveLength(0);
  });

  it("signed in, WAITLISTED → approved, and the waitlist entry the decision created is DROPPED", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const open = seedSubmission(world, { status: "WAITLISTED" });
    world.waitlist.push({
      id: "90000000-0000-4000-8000-000000000009",
      eventId: INVITE_EVENT_ID,
      humanId: INVITE_VIEWER_ID,
      contactEmail: null,
      contactPhone: null,
      source: "APPLICATION",
      status: "PENDING",
      metadata: { submissionId: open.id },
      notifiedAt: null,
      convertedOrderId: null,
      createdAt: world.now,
      updatedAt: world.now,
    });
    await redeem(world, token, INVITE_VIEWER_ID);
    expect(world.submissions[0]).toMatchObject({ status: "APPROVED" });
    expect(world.waitlist[0]).toMatchObject({ status: "DROPPED" });
  });

  it("signed out PERSONAL, WAITLISTED guest → approved and the decision's waitlist entry DROPPED", async () => {
    const world = appWorld();
    const { token } = await personalToken(world, "guest@example.com");
    const open = seedSubmission(world, {
      humanId: null,
      contactEmail: "guest@example.com",
      status: "WAITLISTED",
    });
    world.waitlist.push({
      id: "91000000-0000-4000-8000-000000000009",
      eventId: INVITE_EVENT_ID,
      humanId: null,
      contactEmail: "Guest@Example.com",
      contactPhone: null,
      source: "APPLICATION",
      status: "PENDING",
      metadata: { submissionId: open.id },
      notifiedAt: null,
      convertedOrderId: null,
      createdAt: world.now,
      updatedAt: world.now,
    });
    const out = await redeem(world, token, null);
    expect(out).toMatchObject({ grant: "APPLICATION_GRANT", submissionId: open.id });
    expect(world.waitlist[0]).toMatchObject({ status: "DROPPED" });
  });

  it("ATTEND only: a signed-in viewer's open PERFORM (open call) application is never approved by an invite", async () => {
    const world = appWorld();
    const token = await sharedToken(world);
    const perform = seedSubmission(world, { purpose: "PERFORM", status: "PENDING" });
    const out = await redeem(world, token, INVITE_VIEWER_ID);

    expect(world.submissions.find((s) => s.id === perform.id)).toMatchObject({
      status: "PENDING",
      inviteId: null,
    });
    const attend = world.submissions.find((s) => s.purpose === "ATTEND")!;
    expect(attend).toMatchObject({ status: "APPROVED", inviteId: world.invites[0]!.id });
    expect(out).toMatchObject({ ok: true, submissionId: attend.id });
  });

  it("ATTEND only: a guest's open PERFORM application at the invitee's email is never approved by an invite", async () => {
    const world = appWorld();
    const { token } = await personalToken(world, "guest@example.com");
    const perform = seedSubmission(world, {
      purpose: "PERFORM",
      humanId: null,
      contactEmail: "guest@example.com",
      status: "PENDING",
    });
    const out = await redeem(world, token, null);
    expect(world.submissions.find((s) => s.id === perform.id)?.status).toBe("PENDING");
    const attend = world.submissions.find((s) => s.purpose === "ATTEND")!;
    expect(attend.status).toBe("APPROVED");
    expect(out).toMatchObject({ grant: "APPLICATION_GRANT", submissionId: attend.id });
  });
});
