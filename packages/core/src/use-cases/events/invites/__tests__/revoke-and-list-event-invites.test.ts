import { describe, expect, it, vi } from "vitest";

import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_OPT_OUT_SECRET,
  INVITE_EVENT_ID,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  INVITE_STRANGER_ID,
  INVITE_VIEWER_ID,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import { mintInviteToken } from "../../../../lib/security/invite-token";
import { loadApprovedApplicationGrantSubmission } from "../../_shared/application-gate-grant";
import { createEventGuestInvites } from "../create-event-guest-invites";
import { listEventInvites } from "../list-event-invites";
import { redeemEventInvite } from "../redeem-event-invite";
import { revokeEventGuestInvite } from "../revoke-event-guest-invite";
import { setEventSharedInvite } from "../set-event-shared-invite";

const OTHER_VIEWER_ID = "60000000-0000-4000-8000-000000000006";

const linkDeps = (
  world: InviteWorld,
  mailerSend: (...args: unknown[]) => Promise<unknown> = vi.fn(async () => ({})),
) => ({
  repos: world.repos,
  clock: world.clock,
  inviteTokenSecret: INVITE_SECRET,
  appBaseUrl: INVITE_APP_BASE_URL,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
  mailer: { send: mailerSend } as never,
});

async function invite(world: InviteWorld, email: string, name = "Guest") {
  await createEventGuestInvites(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    guests: [{ name, email }],
  });
  const row = world.invites.find(
    (i) => i.inviteeEmail === email && i.revokedAt === null,
  )!;
  return { id: row.id, token: mintInviteToken(row.id, INVITE_SECRET) };
}

const redeem = (world: InviteWorld, token: string, viewer: string | null) =>
  redeemEventInvite(
    { repos: world.repos, clock: world.clock, inviteTokenSecret: INVITE_SECRET },
    { token, viewerHumanId: viewer },
  );

const revoke = (world: InviteWorld, inviteId: string, actor = INVITE_ORGANIZER_ID) =>
  revokeEventGuestInvite(
    { repos: world.repos, clock: world.clock },
    { eventId: INVITE_EVENT_ID, inviteId, actorHumanId: actor },
  );

describe("revokeEventGuestInvite (FR-006, R9)", () => {
  it("PASSWORD event: revokes the invite and every unlock it granted (both devices)", async () => {
    const world = createInviteWorld();
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, INVITE_VIEWER_ID);
    await redeem(world, token, OTHER_VIEWER_ID);

    const out = await revoke(world, id);
    expect(out).toMatchObject({
      inviteId: id,
      revoked: true,
      revokedAt: world.now,
      unlocksRevoked: 2,
      submissionsRescinded: 0,
    });
    expect([...world.unlocks.values()].every((u) => u.revokedAt)).toBe(true);
    expect(world.invites[0]!.revokedAt).toEqual(world.now);
    expect(world.audit.at(-1)).toMatchObject({
      action: "event_guest_invite_revoked",
    });
    // The link is dead from now on.
    await expect(redeem(world, token, INVITE_VIEWER_ID)).resolves.toMatchObject({
      ok: false,
      reason: "REVOKED",
    });
  });

  it("APPLICATION event: rescinds every submission the invite approved via the rescind path", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, INVITE_VIEWER_ID); // signed-in device
    await redeem(world, token, null); // signed-out device (guest submission)
    expect(world.submissions.filter((s) => s.status === "APPROVED")).toHaveLength(2);

    const out = await revoke(world, id);
    expect(out.submissionsRescinded).toBe(2);
    expect(world.submissions.every((s) => s.status === "PENDING")).toBe(true);
    expect(world.submissions.every((s) => s.reviewedAt === null)).toBe(true);
    expect([...world.unlocks.values()].every((u) => u.revokedAt)).toBe(true);
    expect(world.audit.map((a) => a.action)).toContain(
      "event_application_decision_rescinded",
    );
  });

  it("leaves submissions the invite did not approve alone", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id } = await invite(world, "guest@example.com");
    world.submissions.push({
      id: "71000000-0000-4000-8000-000000000000",
      formId: world.formFor("ATTEND").id,
      purpose: "ATTEND",
      eventId: INVITE_EVENT_ID,
      humanId: OTHER_VIEWER_ID,
      contactEmail: null,
      contactPhone: null,
      status: "APPROVED",
      answers: {},
      decisionReason: null,
      questionsSnapshot: {},
      reviewerHumanId: INVITE_ORGANIZER_ID,
      reviewedAt: world.now,
      approvalToken: "t",
      tokenExpiresAt: world.now,
      inviteId: null,
      metadata: {},
      createdAt: world.now,
      updatedAt: world.now,
    });
    await revoke(world, id);
    expect(world.submissions[0]!.status).toBe("APPROVED");
  });

  it("gate switched APPLICATION → PASSWORD before the revoke: invite approvals are still rescinded and their unlocks revoked", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, INVITE_VIEWER_ID);
    await redeem(world, token, null);
    world.event.gateType = "PASSWORD";

    const out = await revoke(world, id);
    // The signed-in holder's unlock carries the inviteId: gone in the
    // revoke transaction itself.
    expect(out.unlocksRevoked).toBe(1);
    expect(out.submissionsRescinded).toBe(2);
    expect(world.submissions.every((s) => s.status === "PENDING")).toBe(true);
    expect(world.submissions.every((s) => s.reviewedAt === null)).toBe(true);
    expect([...world.unlocks.values()].every((u) => u.revokedAt)).toBe(true);
    expect(
      world.audit.filter((a) => a.action === "event_application_decision_rescinded"),
    ).toHaveLength(2);
  });

  it("gate-switched fallback: a submission someone else already rescinded (lost APPROVED CAS) counts as done, not an error", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, INVITE_VIEWER_ID);
    await redeem(world, token, null);
    world.event.gateType = "PASSWORD";

    // The first fallback write loses its CAS: a concurrent rescind moved
    // the row to PENDING after we read it as APPROVED.
    const realUpdate = world.repos.eventApplications.updateSubmissionStatus;
    let raced = false;
    world.repos.eventApplications.updateSubmissionStatus = async (input) => {
      if (!raced && input.expectedFromStatuses?.includes("APPROVED")) {
        raced = true;
        await realUpdate({
          submissionId: input.submissionId,
          status: "PENDING",
          reviewedAt: null,
        });
      }
      return realUpdate(input);
    };

    const out = await revoke(world, id);
    expect(raced).toBe(true);
    expect(out.submissionsRescinded).toBe(1);
    expect(world.submissions.every((s) => s.status === "PENDING")).toBe(true);
  });

  it("is idempotent: revoking twice keeps the first revokedAt and rescinds nothing new", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, INVITE_VIEWER_ID);
    const first = await revoke(world, id);
    const second = await revoke(world, id);
    expect(second.revokedAt).toEqual(first.revokedAt);
    expect(second.submissionsRescinded).toBe(0);
  });

  it("rescind clears the invite stamp, so a later hand approval is not 'Via invite' and a second revoke leaves it alone (F3)", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, null);
    expect(world.submissions[0]!.inviteId).toBe(id);

    await revoke(world, id);
    expect(world.submissions[0]).toMatchObject({
      status: "PENDING",
      inviteId: null,
    });

    // The organizer approves the guest by hand.
    await world.repos.eventApplications.updateSubmissionStatus({
      submissionId: world.submissions[0]!.id,
      status: "APPROVED",
      reviewerHumanId: INVITE_ORGANIZER_ID,
      reviewedAt: world.now,
      inviteId: null,
    });
    const again = await revoke(world, id);
    expect(again.submissionsRescinded).toBe(0);
    expect(world.submissions[0]!.status).toBe("APPROVED");
  });

  it("a rescind that throws is reported and skipped; the rest still run, and the stranded approval no longer opens the gate (F2)", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, INVITE_VIEWER_ID); // signed-in device
    await redeem(world, token, null); // signed-out device (th_ea_)
    const [signedIn, signedOut] = world.submissions;
    expect(signedIn!.humanId).toBe(INVITE_VIEWER_ID);
    expect(signedOut!.humanId).toBeNull();

    // Every rescind write fails: phase 2 strands both approvals.
    const realUpdate = world.repos.eventApplications.updateSubmissionStatus;
    world.repos.eventApplications.updateSubmissionStatus = async (input) => {
      if (input.status === "PENDING") throw new Error("db blip");
      return realUpdate(input);
    };
    const reportError = vi.fn();

    const out = await revokeEventGuestInvite(
      { repos: world.repos, clock: world.clock, reportError },
      { eventId: INVITE_EVENT_ID, inviteId: id, actorHumanId: INVITE_ORGANIZER_ID },
    );

    // No throw: both rows were tried, both reported.
    expect(out).toMatchObject({ revoked: true, submissionsRescinded: 0 });
    const failedReports = reportError.mock.calls.filter(
      ([, ctx]) => ctx.tags.channel === "invite_rescind_failed",
    );
    expect(failedReports).toHaveLength(2);
    expect(failedReports.map(([, ctx]) => ctx.extra.submissionId).sort()).toEqual(
      [signedIn!.id, signedOut!.id].sort(),
    );
    expect(failedReports[0]![1].tags.useCase).toBe("revokeEventGuestInvite");
    // Both rows were tried once; nothing reports as truncated.
    expect(
      reportError.mock.calls.some(
        ([, ctx]) => ctx.tags.channel === "invite_rescind_truncated",
      ),
    ).toBe(false);
    expect(world.submissions.every((s) => s.status === "APPROVED")).toBe(true);

    // Signed-out holder: the th_ea_ grant reads the revoked PERSONAL invite.
    await expect(
      loadApprovedApplicationGrantSubmission(world.repos, world.event, {
        submissionId: signedOut!.id,
        approvedAtMs: signedOut!.reviewedAt!.getTime(),
      }),
    ).resolves.toBeNull();
    // Signed-in holder: the invite-stamped unlock died in phase 1.
    await expect(
      world.repos.eventUnlocks.isUnlocked(INVITE_EVENT_ID, INVITE_VIEWER_ID),
    ).resolves.toBe(false);
  });

  it("a throwing reporter does not turn a skipped rescind into a failed revoke", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, null);
    world.repos.eventApplications.updateSubmissionStatus = async () => {
      throw new Error("db blip");
    };
    await expect(
      revokeEventGuestInvite(
        {
          repos: world.repos,
          clock: world.clock,
          reportError: () => {
            throw new Error("sentry down");
          },
        },
        { eventId: INVITE_EVENT_ID, inviteId: id, actorHumanId: INVITE_ORGANIZER_ID },
      ),
    ).resolves.toMatchObject({ revoked: true, submissionsRescinded: 0 });
  });

  it("reports invite_rescind_truncated when it stops at the page cap with approvals left", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id } = await invite(world, "guest@example.com");
    // An endless supply of approvals: every list returns a full page of
    // rows not seen before (they don't exist, so each rescind fails fast).
    let n = 0;
    world.repos.eventApplications.listSubmissions = async () => ({
      items: Array.from({ length: 200 }, () => {
        n += 1;
        return {
          id: `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
          inviteId: id,
          status: "APPROVED",
        };
      }) as never,
      total: Number.MAX_SAFE_INTEGER,
    });
    const reportError = vi.fn();

    await revokeEventGuestInvite(
      { repos: world.repos, clock: world.clock, reportError },
      { eventId: INVITE_EVENT_ID, inviteId: id, actorHumanId: INVITE_ORGANIZER_ID },
    );

    const truncated = reportError.mock.calls.filter(
      ([, ctx]) => ctx.tags.channel === "invite_rescind_truncated",
    );
    expect(truncated).toHaveLength(1);
    expect(truncated[0]![1].extra).toMatchObject({ eventId: INVITE_EVENT_ID, inviteId: id });
  });

  it("reports invite_rescind_truncated when a full page holds only rows it already tried", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id } = await invite(world, "guest@example.com");
    // The same full page every time: the rows behind it are never reached.
    const page = Array.from({ length: 200 }, (_, i) => ({
      id: `73000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      inviteId: id,
      status: "APPROVED",
    }));
    const list = vi.fn(async () => ({ items: page as never, total: 500 }));
    world.repos.eventApplications.listSubmissions = list;
    const reportError = vi.fn();

    await revokeEventGuestInvite(
      { repos: world.repos, clock: world.clock, reportError },
      { eventId: INVITE_EVENT_ID, inviteId: id, actorHumanId: INVITE_ORGANIZER_ID },
    );

    // Tried each row once (no spinning to the page cap), then stopped.
    expect(list).toHaveBeenCalledTimes(2);
    expect(
      reportError.mock.calls.filter(
        ([, ctx]) => ctx.tags.channel === "invite_rescind_truncated",
      ),
    ).toHaveLength(1);
  });

  it("BLOCKING scenario: rescind fails → Invite again → re-redeem signed in → revoking the NEW invite removes them", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const p1 = await invite(world, "guest@example.com");
    await redeem(world, p1.token, INVITE_VIEWER_ID);
    const sub = world.submissions[0]!;
    expect(sub.inviteId).toBe(p1.id);

    // Revoke P1, but its rescind fails: S stays APPROVED with inviteId=P1.
    const realUpdate = world.repos.eventApplications.updateSubmissionStatus;
    world.repos.eventApplications.updateSubmissionStatus = async (input) => {
      if (input.status === "PENDING") throw new Error("db blip");
      return realUpdate(input);
    };
    await revokeEventGuestInvite(
      { repos: world.repos, clock: world.clock, reportError: vi.fn() },
      { eventId: INVITE_EVENT_ID, inviteId: p1.id, actorHumanId: INVITE_ORGANIZER_ID },
    );
    world.repos.eventApplications.updateSubmissionStatus = realUpdate;
    expect(sub).toMatchObject({ status: "APPROVED", inviteId: p1.id });
    await expect(
      world.repos.eventUnlocks.isUnlocked(INVITE_EVENT_ID, INVITE_VIEWER_ID),
    ).resolves.toBe(false);

    // "Invite again" mints P2; the guest redeems it signed in.
    const p2 = await invite(world, "guest@example.com");
    expect(p2.id).not.toBe(p1.id);
    await expect(redeem(world, p2.token, INVITE_VIEWER_ID)).resolves.toMatchObject({
      ok: true,
      grant: "UNLOCK",
    });
    // Re-approved under P2: both rows carry it.
    expect(world.submissions).toHaveLength(1);
    expect(sub).toMatchObject({ status: "APPROVED", inviteId: p2.id });
    const unlock = await world.repos.eventUnlocks.get(INVITE_EVENT_ID, INVITE_VIEWER_ID);
    expect(unlock).toMatchObject({ inviteId: p2.id, revokedAt: null });

    // Revoking P2 removes the guest (R9).
    await revoke(world, p2.id);
    await expect(
      world.repos.eventUnlocks.isUnlocked(INVITE_EVENT_ID, INVITE_VIEWER_ID),
    ).resolves.toBe(false);
    expect(sub).toMatchObject({ status: "PENDING", inviteId: null });
  });

  it("re-redeem on an approval from a still-LIVE invite: the unlock carries THAT invite, so revoking it removes the guest", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const p1 = await invite(world, "guest@example.com");
    await redeem(world, p1.token, INVITE_VIEWER_ID);
    const sub = world.submissions[0]!;
    // The unlock is lost some other way (not a revoke of P1).
    const key = `${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`;
    world.unlocks.get(key)!.revokedAt = world.now;

    // Re-entry through the SHARED link while signed in.
    const shared = await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "ENABLE",
    });
    await redeem(world, mintInviteToken(shared.id as string, INVITE_SECRET), INVITE_VIEWER_ID);

    // Approval untouched; the restored unlock carries P1, not the shared id.
    expect(sub).toMatchObject({ status: "APPROVED", inviteId: p1.id });
    const unlock = await world.repos.eventUnlocks.get(INVITE_EVENT_ID, INVITE_VIEWER_ID);
    expect(unlock).toMatchObject({ inviteId: p1.id, revokedAt: null });

    await revoke(world, p1.id);
    await expect(
      world.repos.eventUnlocks.isUnlocked(INVITE_EVENT_ID, INVITE_VIEWER_ID),
    ).resolves.toBe(false);
  });

  it("re-redeem race: the approving PERSONAL invite is revoked just before the in-tx lock → re-approved under the redeemed invite", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const p1 = await invite(world, "guest@example.com");
    await redeem(world, p1.token, INVITE_VIEWER_ID);
    const sub = world.submissions[0]!;
    world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`)!.revokedAt = world.now;
    const shared = await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "ENABLE",
    });

    // P1's revoke commits after the redeem read it as live, before the lock.
    world.hooks.beforeLockIfLive = (id) => {
      if (id === p1.id) world.invites.find((i) => i.id === p1.id)!.revokedAt = world.now;
    };
    await redeem(world, mintInviteToken(shared.id as string, INVITE_SECRET), INVITE_VIEWER_ID);

    // The lock saw the revoke: the approval moved to the shared invite.
    expect(sub).toMatchObject({ status: "APPROVED", inviteId: shared.id });
    const unlock = await world.repos.eventUnlocks.get(INVITE_EVENT_ID, INVITE_VIEWER_ID);
    expect(unlock).toMatchObject({ inviteId: shared.id, revokedAt: null });
  });

  it.each([
    ["the organizer REJECTS it", { status: "REJECTED" as const }],
    ["the organizer approves it by hand", { inviteId: null }],
    ["the guest WITHDRAWS it", { status: "WITHDRAWN" as const }],
  ])(
    "a decision landing between the list and the rescind (%s) is not overwritten, and is not reported as a failure",
    async (_, change) => {
      const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
      const { id, token } = await invite(world, "guest@example.com");
      await redeem(world, token, null);
      const sub = world.submissions[0]!;

      const realList = world.repos.eventApplications.listSubmissions;
      let moved = false;
      world.repos.eventApplications.listSubmissions = async (input) => {
        const out = await realList(input);
        if (!moved) {
          moved = true;
          Object.assign(sub, change);
        }
        return out;
      };
      const reportError = vi.fn();

      const out = await revokeEventGuestInvite(
        { repos: world.repos, clock: world.clock, reportError },
        { eventId: INVITE_EVENT_ID, inviteId: id, actorHumanId: INVITE_ORGANIZER_ID },
      );

      expect(out.submissionsRescinded).toBe(0);
      expect(sub).toMatchObject(change);
      expect(sub.status).not.toBe("PENDING");
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it.each(["APPLICATION", "PASSWORD"] as const)(
    "%s event: an approval re-stamped under ANOTHER invite between the rescind's read and its write is skipped as moved on (guard is in the write)",
    async (gateNow) => {
      const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
      const p1 = await invite(world, "guest@example.com");
      await redeem(world, p1.token, null);
      const sub = world.submissions[0]!;
      world.event.gateType = gateNow; // PASSWORD → the fallback path

      // The rescind's unlocked read still sees P1; right after it, a
      // re-approval under P2 commits (status stays APPROVED).
      const otherInvite = "88000000-0000-4000-8000-000000000088";
      const freshReview = new Date(world.now.getTime() + 60_000);
      const realGet = world.repos.eventApplications.getSubmissionById;
      let raced = false;
      world.repos.eventApplications.getSubmissionById = async (id) => {
        const snapshot = await realGet(id);
        if (!raced && id === sub.id) {
          raced = true;
          sub.inviteId = otherInvite;
          sub.reviewedAt = freshReview;
        }
        return snapshot;
      };
      const reportError = vi.fn();

      const out = await revokeEventGuestInvite(
        { repos: world.repos, clock: world.clock, reportError },
        { eventId: INVITE_EVENT_ID, inviteId: p1.id, actorHumanId: INVITE_ORGANIZER_ID },
      );

      expect(raced).toBe(true);
      expect(out.submissionsRescinded).toBe(0);
      expect(sub).toMatchObject({
        status: "APPROVED",
        inviteId: otherInvite,
        reviewedAt: freshReview,
      });
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it("revoking again repairs approvals a failed first revoke stranded", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { id, token } = await invite(world, "guest@example.com");
    await redeem(world, token, null);
    const realUpdate = world.repos.eventApplications.updateSubmissionStatus;
    world.repos.eventApplications.updateSubmissionStatus = async (input) => {
      if (input.status === "PENDING") throw new Error("db blip");
      return realUpdate(input);
    };
    const first = await revokeEventGuestInvite(
      { repos: world.repos, clock: world.clock, reportError: vi.fn() },
      { eventId: INVITE_EVENT_ID, inviteId: id, actorHumanId: INVITE_ORGANIZER_ID },
    );
    expect(first.submissionsRescinded).toBe(0);
    expect(world.submissions[0]!.status).toBe("APPROVED");

    world.repos.eventApplications.updateSubmissionStatus = realUpdate;
    const second = await revoke(world, id);
    expect(second).toMatchObject({ revokedAt: first.revokedAt, submissionsRescinded: 1 });
    expect(world.submissions[0]).toMatchObject({ status: "PENDING", inviteId: null });
  });

  it("refuses a SHARED invite, an unknown one and a stranger", async () => {
    const world = createInviteWorld();
    const shared = await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "ENABLE",
    });
    await expect(revoke(world, shared.id as string)).rejects.toMatchObject({
      code: "MAGIC_LINK_NOT_FOUND",
    });
    await expect(
      revoke(world, "12345678-1234-4234-8234-123456789abc"),
    ).rejects.toMatchObject({ code: "MAGIC_LINK_NOT_FOUND" });
    const { id } = await invite(world, "guest@example.com");
    await expect(revoke(world, id, INVITE_STRANGER_ID)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(world.invites.find((i) => i.id === id)?.revokedAt).toBeNull();
  });
});

describe("listEventInvites (FR-001, FR-002)", () => {
  it("shows the live shared link with its count, and one row per guest (newest) with status and copy URL", async () => {
    const world = createInviteWorld();
    const shared = await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "ENABLE",
    });
    const sharedToken = mintInviteToken(shared.id as string, INVITE_SECRET);
    await redeem(world, sharedToken, null);

    const used = await invite(world, "used@example.com", "Used");
    await redeem(world, used.token, null);
    await invite(world, "sent@example.com", "Sent");
    // Unsent: the mail failed.
    await createEventGuestInvites(
      linkDeps(
        world,
        vi.fn(async () => {
          throw new Error("down");
        }),
      ),
      {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: [{ name: "Unsent", email: "unsent@example.com" }],
      },
    );
    // Revoked, then re-invited: only the newest row shows.
    const old = await invite(world, "again@example.com", "Again");
    await revoke(world, old.id);
    const fresh = await invite(world, "again@example.com", "Again");
    const gone = await invite(world, "gone@example.com", "Gone");
    await revoke(world, gone.id);

    const out = await listEventInvites(
      { repos: world.repos, inviteTokenSecret: INVITE_SECRET, appBaseUrl: INVITE_APP_BASE_URL },
      { eventId: INVITE_EVENT_ID, actorHumanId: INVITE_ORGANIZER_ID },
    );

    expect(out.shared).toEqual({
      id: shared.id,
      url: shared.url,
      redemptionCount: 1,
      firstRedeemedAt: world.now,
    });
    const byEmail = Object.fromEntries(out.guests.map((g) => [g.email, g]));
    expect(out.guests).toHaveLength(5);
    expect(byEmail["used@example.com"]).toMatchObject({ status: "USED" });
    expect(byEmail["sent@example.com"]).toMatchObject({ status: "SENT" });
    expect(byEmail["unsent@example.com"]).toMatchObject({ status: "UNSENT" });
    expect(byEmail["again@example.com"]).toMatchObject({
      id: fresh.id,
      status: "SENT",
      copyUrl: `${INVITE_APP_BASE_URL}/events/basement-show?invite=${fresh.token}`,
    });
    expect(byEmail["gone@example.com"]).toMatchObject({
      status: "REVOKED",
      copyUrl: null,
    });
  });

  it("shared is null when the link is off", async () => {
    const world = createInviteWorld();
    const out = await listEventInvites(
      { repos: world.repos, inviteTokenSecret: INVITE_SECRET, appBaseUrl: INVITE_APP_BASE_URL },
      { eventId: INVITE_EVENT_ID, actorHumanId: INVITE_ORGANIZER_ID },
    );
    expect(out).toEqual({ shared: null, guests: [] });
  });

  it("requires edit rights", async () => {
    const world = createInviteWorld();
    await expect(
      listEventInvites(
        { repos: world.repos, inviteTokenSecret: INVITE_SECRET, appBaseUrl: INVITE_APP_BASE_URL },
        { eventId: INVITE_EVENT_ID, actorHumanId: INVITE_STRANGER_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
