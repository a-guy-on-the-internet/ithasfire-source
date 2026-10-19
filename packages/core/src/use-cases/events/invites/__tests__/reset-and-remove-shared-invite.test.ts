import { describe, expect, it, vi } from "vitest";

import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_EVENT_ID,
  INVITE_OPT_OUT_SECRET,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  INVITE_VIEWER_ID,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import { mintInviteToken } from "../../../../lib/security/invite-token";
import {
  inviteApprovalRevoked,
  loadApprovedApplicationGrantSubmission,
} from "../../_shared/application-gate-grant";
import { createEventGuestInvites } from "../create-event-guest-invites";
import { inviteGrantHolds } from "../invite-grant";
import { recordInviteGrantUnlock } from "../record-invite-grant-unlock";
import { redeemEventInvite } from "../redeem-event-invite";
import { setEventSharedInvite } from "../set-event-shared-invite";

/**
 * "Reset and remove everyone" on the SHARED link (owner ruling 2026-10-05):
 * rotate like RESET, and everyone who got in through ANY earlier SHARED link
 * is removed (signed-out cookie grants, signed-in unlocks, invite
 * approvals). A plain RESET keeps them (R5). Personal invites are untouched.
 */

const SECOND_VIEWER = "60000000-0000-4000-8000-000000000006";

const deps = (world: InviteWorld, extra: { reportError?: ReturnType<typeof vi.fn> } = {}) => ({
  repos: world.repos,
  clock: world.clock,
  inviteTokenSecret: INVITE_SECRET,
  appBaseUrl: INVITE_APP_BASE_URL,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
  reportError: extra.reportError,
  mailer: {
    send: vi.fn(async () => ({ result: { id: "m", status: "queued" } })),
  } as never,
});

const shared = (
  world: InviteWorld,
  action: "ENABLE" | "RESET" | "RESET_AND_REMOVE" | "DISABLE",
  extra?: Parameters<typeof deps>[1],
) =>
  setEventSharedInvite(deps(world, extra), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    action,
  });

const redeem = (world: InviteWorld, inviteId: string, viewerHumanId: string | null) =>
  redeemEventInvite(deps(world), {
    token: mintInviteToken(inviteId, INVITE_SECRET),
    viewerHumanId,
  });

const cookieGrant = (world: InviteWorld, inviteId: string) => ({
  inviteId,
  expMs: world.event.endsAt!.getTime(),
});

const holds = (world: InviteWorld, inviteId: string) =>
  inviteGrantHolds(
    world.repos.eventInvites,
    world.event,
    cookieGrant(world, inviteId),
    world.now,
  );

const unlockOf = (world: InviteWorld, viewer = INVITE_VIEWER_ID) =>
  world.unlocks.get(`${INVITE_EVENT_ID}:${viewer}`);

describe("setEventSharedInvite RESET_AND_REMOVE (password event)", () => {
  it("ends signed-out cookie grants and revokes signed-in unlocks from the old link; mints a new live link", async () => {
    const world = createInviteWorld();
    const first = await shared(world, "ENABLE");
    const oldId = first.id as string;

    const signedOut = await redeem(world, oldId, null);
    expect(signedOut).toMatchObject({ ok: true, grant: "INVITE_GRANT" });
    const signedIn = await redeem(world, oldId, INVITE_VIEWER_ID);
    expect(signedIn).toMatchObject({ ok: true, grant: "UNLOCK" });
    expect(unlockOf(world)?.revokedAt).toBeNull();
    expect(await holds(world, oldId)).toBe(true);

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(out.id).not.toBe(oldId);
    expect(out.url).toContain("?invite=");
    expect(out.removed).toEqual({
      links: 1,
      unlocksRevoked: 1,
      submissionsRescinded: 0,
      namedGuestsKept: 0,
    });
    const old = world.invites.find((i) => i.id === oldId)!;
    expect(old.revokedAt).toEqual(world.now);
    expect(old.grantsRevokedAt).toEqual(world.now);
    const fresh = world.invites.find((i) => i.id === out.id)!;
    expect(fresh).toMatchObject({ revokedAt: null, grantsRevokedAt: null });

    // Signed-out holder: the cookie no longer opens the gate.
    expect(await holds(world, oldId)).toBe(false);
    // Signed-in holder: unlock revoked.
    expect(unlockOf(world)?.revokedAt).toEqual(world.now);
    // The new link works.
    expect(await redeem(world, out.id as string, null)).toMatchObject({
      ok: true,
      grant: "INVITE_GRANT",
    });
    expect(await holds(world, out.id as string)).toBe(true);

    expect(world.audit.map((a) => a.action)).toContain(
      "event_shared_invite_reset_and_removed",
    );
  });

  it("also removes holders of links reset or turned off EARLIER, not just the live one", async () => {
    const world = createInviteWorld();
    const a = (await shared(world, "ENABLE")).id as string;
    await redeem(world, a, INVITE_VIEWER_ID);
    const b = (await shared(world, "RESET")).id as string;
    await redeem(world, b, SECOND_VIEWER);
    await shared(world, "DISABLE");

    // Plain reset + disable kept everyone (R5).
    expect(await holds(world, a)).toBe(true);
    expect(unlockOf(world)?.revokedAt).toBeNull();

    // No live link now (DISABLEd): RESET_AND_REMOVE removes both and the
    // link stays off (security N8: no new link the organiser turned off).
    const out = await shared(world, "RESET_AND_REMOVE");
    expect(out).toMatchObject({ id: null, url: null });
    expect(out.removed).toMatchObject({ links: 2, unlocksRevoked: 2 });
    expect(await world.repos.eventInvites.getLiveShared(INVITE_EVENT_ID)).toBeNull();
    expect(await holds(world, a)).toBe(false);
    expect(await holds(world, b)).toBe(false);
    expect(unlockOf(world)?.revokedAt).not.toBeNull();
    expect(unlockOf(world, SECOND_VIEWER)?.revokedAt).not.toBeNull();
  });

  it("a plain RESET keeps every grant (R5 default unchanged)", async () => {
    const world = createInviteWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await redeem(world, oldId, null);
    await redeem(world, oldId, INVITE_VIEWER_ID);

    const out = await shared(world, "RESET");

    expect(out.removed).toBeUndefined();
    expect(world.invites.find((i) => i.id === oldId)?.grantsRevokedAt).toBeNull();
    expect(await holds(world, oldId)).toBe(true);
    expect(unlockOf(world)?.revokedAt).toBeNull();
    expect(world.audit.map((a) => a.action)).not.toContain(
      "event_shared_invite_reset_and_removed",
    );
  });

  it("leaves personal invites and what they granted alone", async () => {
    const world = createInviteWorld();
    const sharedId = (await shared(world, "ENABLE")).id as string;
    await createEventGuestInvites(deps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Guest", email: "guest@example.com" }],
    });
    const personalId = world.invites.find((i) => i.kind === "PERSONAL")!.id;
    await redeem(world, personalId, INVITE_VIEWER_ID);
    await redeem(world, sharedId, SECOND_VIEWER);

    await shared(world, "RESET_AND_REMOVE");

    const personal = world.invites.find((i) => i.id === personalId)!;
    expect(personal).toMatchObject({ revokedAt: null, grantsRevokedAt: null });
    expect(await holds(world, personalId)).toBe(true);
    expect(unlockOf(world)?.revokedAt).toBeNull();
    expect(unlockOf(world, SECOND_VIEWER)?.revokedAt).not.toBeNull();
  });

  it("is idempotent: running it again keeps the earlier stamp and removes nothing new twice", async () => {
    const world = createInviteWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await redeem(world, oldId, INVITE_VIEWER_ID);
    await shared(world, "RESET_AND_REMOVE");
    const stamp = world.invites.find((i) => i.id === oldId)!.grantsRevokedAt;

    const again = await shared(world, "RESET_AND_REMOVE");
    expect(again.removed).toMatchObject({ links: 2, unlocksRevoked: 0 });
    expect(world.invites.find((i) => i.id === oldId)!.grantsRevokedAt).toBe(stamp);
  });
});

describe("RESET_AND_REMOVE keeps NAMED guests (live personal invite for their verified email)", () => {
  const ANA_EMAIL = "ana@example.com";

  /** Ana: signed in, verified, holds a personal invite, came in by the shared link first. */
  async function anaViaSharedFirst(world: InviteWorld) {
    world.accountEmails.set(INVITE_VIEWER_ID, ANA_EMAIL);
    world.verified.add(INVITE_VIEWER_ID);
    const sharedId = (await shared(world, "ENABLE")).id as string;
    expect(await redeem(world, sharedId, INVITE_VIEWER_ID)).toMatchObject({ ok: true });
    await createEventGuestInvites(deps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "Ana@Example.com" }],
    });
    const personalId = world.invites.find((i) => i.kind === "PERSONAL")!.id;
    // Opening her own link later leaves the shared-link unlock as it was.
    await redeem(world, personalId, INVITE_VIEWER_ID);
    expect(unlockOf(world)?.inviteId).toBe(sharedId);
    // Bo: came by the shared link, no personal invite.
    world.accountEmails.set(SECOND_VIEWER, "bo@example.com");
    world.verified.add(SECOND_VIEWER);
    await redeem(world, sharedId, SECOND_VIEWER);
    return { sharedId, personalId };
  }

  it("password event: Ana keeps access (unlock re-pointed to her invite); Bo loses it", async () => {
    const world = createInviteWorld();
    const { personalId } = await anaViaSharedFirst(world);

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(out.removed).toMatchObject({ unlocksRevoked: 1, namedGuestsKept: 1 });
    expect(unlockOf(world)).toMatchObject({ revokedAt: null, inviteId: personalId });
    expect(unlockOf(world, SECOND_VIEWER)?.revokedAt).not.toBeNull();

    // From now on her access lives and dies with her own invite.
    expect(await world.repos.eventUnlocks.revokeByInvite(personalId, world.now)).toBe(1);
  });

  it("application event: Ana's approval is re-stamped with her invite, not rescinded", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const { sharedId, personalId } = await anaViaSharedFirst(world);
    const anas = world.submissions.find(
      (s) => s.humanId === INVITE_VIEWER_ID && s.inviteId === sharedId,
    )!;
    const bos = world.submissions.find((s) => s.humanId === SECOND_VIEWER)!;

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(out.removed).toMatchObject({ namedGuestsKept: 1, submissionsRescinded: 1 });
    const ana = world.submissions.find((s) => s.id === anas.id)!;
    expect(ana).toMatchObject({ status: "APPROVED", inviteId: personalId });
    expect(await inviteApprovalRevoked(world.repos.eventInvites, ana)).toBe(false);
    expect(
      await loadApprovedApplicationGrantSubmission(world.repos, world.event, {
        submissionId: ana.id,
        approvedAtMs: ana.reviewedAt!.getTime(),
      }),
    ).not.toBeNull();
    expect(unlockOf(world)).toMatchObject({ revokedAt: null, inviteId: personalId });
    expect(world.submissions.find((s) => s.id === bos.id)?.status).toBe("PENDING");
  });

  it("an UNVERIFIED account email doesn't count: removed like everyone else", async () => {
    const world = createInviteWorld();
    await anaViaSharedFirst(world);
    world.verified.delete(INVITE_VIEWER_ID);

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(out.removed).toMatchObject({ namedGuestsKept: 0, unlocksRevoked: 2 });
    expect(unlockOf(world)?.revokedAt).not.toBeNull();
  });

  it("a REVOKED personal invite doesn't count", async () => {
    const world = createInviteWorld();
    const { personalId } = await anaViaSharedFirst(world);
    world.invites.find((i) => i.id === personalId)!.revokedAt = world.now;

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(out.removed).toMatchObject({ namedGuestsKept: 0 });
    expect(unlockOf(world)?.revokedAt).not.toBeNull();
  });
});

describe("RESET_AND_REMOVE while the event no longer takes invites (security N8)", () => {
  it("gate switched off: removes everyone, turns the live link off, mints nothing", async () => {
    const world = createInviteWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await redeem(world, oldId, INVITE_VIEWER_ID);
    await redeem(world, oldId, null);
    world.event.gateType = "NONE" as never;

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(out).toMatchObject({ id: oldId, url: null });
    expect(out.removed).toMatchObject({ links: 1, unlocksRevoked: 1 });
    expect(unlockOf(world)?.revokedAt).not.toBeNull();
    expect(world.invites.find((i) => i.id === oldId)).toMatchObject({
      revokedAt: world.now,
      grantsRevokedAt: world.now,
    });
    expect(world.invites.filter((i) => i.kind === "SHARED")).toHaveLength(1);
    expect(await world.repos.eventInvites.getLiveShared(INVITE_EVENT_ID)).toBeNull();
  });

  it("a cancelled event: removal still runs, no new link", async () => {
    const world = createInviteWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await redeem(world, oldId, INVITE_VIEWER_ID);
    world.event.status = "CANCELLED";

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(out.url).toBeNull();
    expect(unlockOf(world)?.revokedAt).not.toBeNull();
  });

  it("the other actions still refuse on a non-gated event", async () => {
    const world = createInviteWorld();
    await shared(world, "ENABLE");
    world.event.gateType = "NONE" as never;
    await expect(shared(world, "RESET")).rejects.toMatchObject({
      code: "INVALID_STATUS",
    });
  });
});

describe("setEventSharedInvite RESET_AND_REMOVE (application event)", () => {
  const appWorld = () =>
    createInviteWorld({ event: { gateType: "APPLICATION" } });

  it("rescinds approvals the old shared link gave; their grants stop holding", async () => {
    const world = appWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    const redeemed = await redeem(world, oldId, INVITE_VIEWER_ID);
    expect(redeemed).toMatchObject({ ok: true, grant: "UNLOCK" });
    const submission = world.submissions.find((s) => s.inviteId === oldId)!;
    expect(submission.status).toBe("APPROVED");
    const approvedAtMs = submission.reviewedAt!.getTime();

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(out.removed).toMatchObject({ links: 1, submissionsRescinded: 1 });
    expect(world.submissions.find((s) => s.id === submission.id)?.status).toBe(
      "PENDING",
    );
    expect(unlockOf(world)?.revokedAt).not.toBeNull();
    expect(
      await loadApprovedApplicationGrantSubmission(world.repos, world.event, {
        submissionId: submission.id,
        approvedAtMs,
      }),
    ).toBeNull();
  });

  it("the read path refuses an approval phase 2 never reached (grantsRevokedAt alone is enough)", async () => {
    const world = appWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await redeem(world, oldId, INVITE_VIEWER_ID);
    const submission = world.submissions.find((s) => s.inviteId === oldId)!;

    // Plain reset: the approval still counts (R5).
    await shared(world, "RESET");
    expect(await inviteApprovalRevoked(world.repos.eventInvites, submission)).toBe(
      false,
    );

    // Stamp only, as if phase 2 had stopped before this row.
    world.invites.find((i) => i.id === oldId)!.grantsRevokedAt = world.now;
    expect(await inviteApprovalRevoked(world.repos.eventInvites, submission)).toBe(
      true,
    );
    expect(
      await loadApprovedApplicationGrantSubmission(world.repos, world.event, {
        submissionId: submission.id,
        approvedAtMs: submission.reviewedAt!.getTime(),
      }),
    ).toBeNull();
  });

  it("reports a failed rescind and still removes the rest", async () => {
    const world = appWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await redeem(world, oldId, INVITE_VIEWER_ID);
    await redeem(world, oldId, SECOND_VIEWER);
    const [first] = world.submissions.filter((s) => s.inviteId === oldId);

    const getSubmissionById = world.repos.eventApplications.getSubmissionById;
    vi.spyOn(world.repos.eventApplications, "getSubmissionById").mockImplementation(
      async (id: string) => {
        if (id === first!.id) throw new Error("db hiccup");
        return getSubmissionById.call(world.repos.eventApplications, id);
      },
    );
    const reportError = vi.fn();

    const out = await shared(world, "RESET_AND_REMOVE", { reportError });

    expect(out.removed).toMatchObject({ links: 1, unlocksRevoked: 2, submissionsRescinded: 1 });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "setEventSharedInvite",
          channel: "invite_rescind_failed",
        }),
      }),
    );
  });
});

describe("phase 1 deadlock retry", () => {
  const deadlock = () =>
    Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), {
      code: "P2034",
    });

  it("a P2034 on phase 1 is retried once, with the link id minted before it; the removal lands", async () => {
    const world = createInviteWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await redeem(world, oldId, INVITE_VIEWER_ID);
    const realTx = world.repos.tx.bind(world.repos);
    let calls = 0;
    vi.spyOn(world.repos, "tx").mockImplementation((async (fn: never) => {
      calls += 1;
      // Postgres aborted the first attempt before it wrote anything.
      if (calls === 1) throw deadlock();
      return realTx(fn);
    }) as never);
    const rotate = vi.spyOn(world.repos.eventInvites, "rotateShared");

    const out = await shared(world, "RESET_AND_REMOVE");

    expect(calls).toBe(2);
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(out.id).toBe(rotate.mock.calls[0]![1].id);
    expect(out.removed).toMatchObject({ links: 1, unlocksRevoked: 1 });
    expect(unlockOf(world)?.revokedAt).not.toBeNull();
  });

  it("a second deadlock propagates", async () => {
    const world = createInviteWorld();
    await shared(world, "ENABLE");
    vi.spyOn(world.repos, "tx").mockRejectedValue(deadlock());
    await expect(shared(world, "RESET_AND_REMOVE")).rejects.toMatchObject({
      code: "P2034",
    });
    expect(world.repos.tx).toHaveBeenCalledTimes(2);
  });

  it("other errors are not retried", async () => {
    const world = createInviteWorld();
    await shared(world, "ENABLE");
    vi.spyOn(world.repos, "tx").mockRejectedValue(new Error("boom"));
    await expect(shared(world, "RESET_AND_REMOVE")).rejects.toThrow("boom");
    expect(world.repos.tx).toHaveBeenCalledTimes(1);
  });
});

describe("phase 2 list failure", () => {
  it("a failed list after phase 1 committed is reported; the call returns partial counts", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const oldId = (await shared(world, "ENABLE")).id as string;
    await redeem(world, oldId, INVITE_VIEWER_ID);
    vi.spyOn(world.repos.eventApplications, "listSubmissions").mockRejectedValue(
      new Error("db hiccup on list"),
    );
    const reportError = vi.fn();

    const out = await shared(world, "RESET_AND_REMOVE", { reportError });

    // Phase 1 removed them; phase 2 couldn't list, so nothing rescinded.
    expect(out.removed).toMatchObject({ links: 1, unlocksRevoked: 1, submissionsRescinded: 0 });
    expect(unlockOf(world)?.revokedAt).not.toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db hiccup on list" }),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "invite_rescind_list_failed" }),
      }),
    );
  });
});

describe("signed-in CONVERT of a removed shared grant (checkout / sync-unlock)", () => {
  const convert = (world: InviteWorld, inviteId: string) =>
    recordInviteGrantUnlock(
      { repos: world.repos, clock: world.clock },
      {
        eventId: INVITE_EVENT_ID,
        viewerHumanId: INVITE_VIEWER_ID,
        inviteGrant: cookieGrant(world, inviteId),
      },
    );

  it("a reset-only shared cookie still converts (R5); a removed one does not", async () => {
    const world = createInviteWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await shared(world, "RESET");
    expect(await convert(world, oldId)).toMatchObject({ outcome: "persisted" });

    const world2 = createInviteWorld();
    const oldId2 = (await shared(world2, "ENABLE")).id as string;
    await shared(world2, "RESET_AND_REMOVE");
    expect(await convert(world2, oldId2)).toMatchObject({
      outcome: "grant_invalid",
      persisted: false,
    });
    expect(unlockOf(world2)).toBeUndefined();
  });

  it("a removal landing during the conversion wins under the row lock: nothing is written", async () => {
    const world = createInviteWorld();
    const oldId = (await shared(world, "ENABLE")).id as string;
    await shared(world, "RESET");
    world.hooks.beforeLockIfGrantsHold = (id) => {
      if (id === oldId) {
        world.invites.find((i) => i.id === oldId)!.grantsRevokedAt = world.now;
      }
    };

    expect(await convert(world, oldId)).toMatchObject({
      outcome: "revoked",
      persisted: false,
    });
    expect(unlockOf(world)).toBeUndefined();
  });

  it("on an application event a removed shared cookie approves nobody", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const oldId = (await shared(world, "ENABLE")).id as string;
    await shared(world, "RESET_AND_REMOVE");
    expect(await convert(world, oldId)).toMatchObject({ outcome: "grant_invalid" });
    expect(world.submissions).toHaveLength(0);
  });
});
