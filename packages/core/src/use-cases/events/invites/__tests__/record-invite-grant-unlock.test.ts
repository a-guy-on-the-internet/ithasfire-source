import { describe, expect, it, vi } from "vitest";

import type { EventApplicationSubmissionRecord } from "@th/ports/repos/events";
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

import { createEventGuestInvites } from "../create-event-guest-invites";
import { recordInviteGrantUnlock } from "../record-invite-grant-unlock";
import { setEventSharedInvite } from "../set-event-shared-invite";

/**
 * A signed-in viewer's verified `th_ei_` cookie → the durable grant they
 * would have got redeeming signed in (R3), under the cookie's rule
 * (`inviteGrantHolds`: SHARED survives reset, PERSONAL dies on revoke, both
 * die at event end / cancellation).
 */

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

const appWorld = () => createInviteWorld({ event: { gateType: "APPLICATION" } });

async function sharedInviteId(world: InviteWorld): Promise<string> {
  const out = await setEventSharedInvite(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    action: "ENABLE",
  });
  return out.id as string;
}

async function personalInviteId(world: InviteWorld, email = "guest@example.com") {
  await createEventGuestInvites(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    guests: [{ name: "Guest", email }],
  });
  return world.invites.find((i) => i.inviteeEmail === email)!.id;
}

const grantFor = (world: InviteWorld, inviteId: string) => ({
  inviteId,
  expMs: world.event.endsAt!.getTime(),
});

const convert = (
  world: InviteWorld,
  inviteId: string,
  viewerHumanId = INVITE_VIEWER_ID,
) =>
  recordInviteGrantUnlock(
    { repos: world.repos, clock: world.clock },
    { eventId: INVITE_EVENT_ID, viewerHumanId, inviteGrant: grantFor(world, inviteId) },
  );

const unlockOf = (world: InviteWorld, viewer = INVITE_VIEWER_ID) =>
  world.unlocks.get(`${INVITE_EVENT_ID}:${viewer}`);

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

describe("recordInviteGrantUnlock — PASSWORD event", () => {
  it("SHARED → EventUnlock (MAGIC_LINK, inviteId), NOT counted again", async () => {
    const world = createInviteWorld();
    const inviteId = await sharedInviteId(world);

    await expect(convert(world, inviteId)).resolves.toEqual({
      eventId: INVITE_EVENT_ID,
      persisted: true,
      outcome: "persisted",
      submissionId: null,
    });
    expect(unlockOf(world)).toMatchObject({
      source: "MAGIC_LINK",
      inviteId,
      applicationSubmissionId: null,
      revokedAt: null,
    });
    expect(world.invites[0]).toMatchObject({ redemptionCount: 0 });
    expect(world.audit.at(-1)).toMatchObject({
      action: "event_invite_grant_converted",
    });
  });

  it("SHARED reset since the cookie was minted → still converts (R5, R14)", async () => {
    const world = createInviteWorld();
    const oldId = await sharedInviteId(world);
    await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "RESET",
    });
    expect(world.invites.find((i) => i.id === oldId)?.revokedAt).not.toBeNull();

    await expect(convert(world, oldId)).resolves.toMatchObject({
      persisted: true,
      outcome: "persisted",
    });
    expect(unlockOf(world)).toMatchObject({ inviteId: oldId, revokedAt: null });
  });

  it("SHARED turned off → still converts", async () => {
    const world = createInviteWorld();
    const id = await sharedInviteId(world);
    await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "DISABLE",
    });
    await expect(convert(world, id)).resolves.toMatchObject({ outcome: "persisted" });
  });

  it("PERSONAL live → converts; PERSONAL revoked → refused, nothing written", async () => {
    const live = createInviteWorld();
    const liveId = await personalInviteId(live);
    await expect(convert(live, liveId)).resolves.toMatchObject({ outcome: "persisted" });
    expect(unlockOf(live)).toMatchObject({ inviteId: liveId });

    const revoked = createInviteWorld();
    const revokedId = await personalInviteId(revoked);
    revoked.invites.find((i) => i.id === revokedId)!.revokedAt = revoked.now;
    await expect(convert(revoked, revokedId)).resolves.toEqual({
      eventId: INVITE_EVENT_ID,
      persisted: false,
      outcome: "grant_invalid",
      submissionId: null,
    });
    expect(unlockOf(revoked)).toBeUndefined();
  });

  it("PERSONAL revoked under the row lock (race) → revoked, rolled back", async () => {
    const world = createInviteWorld();
    const id = await personalInviteId(world);
    const invites = world.repos.eventInvites;
    const original = invites.recordRedemption.bind(invites);
    invites.recordRedemption = async (inviteId: string, at: Date) => {
      world.invites.find((i) => i.id === inviteId)!.revokedAt = at;
      return original(inviteId, at);
    };
    await expect(convert(world, id)).resolves.toMatchObject({
      persisted: false,
      outcome: "revoked",
    });
    expect(unlockOf(world)).toBeUndefined();
  });

  it("event ended → refused", async () => {
    const world = createInviteWorld();
    const id = await sharedInviteId(world);
    const grant = grantFor(world, id);
    world.event.startsAt = new Date(world.now.getTime() - 3 * 3_600_000);
    world.event.endsAt = new Date(world.now.getTime() - 3_600_000);
    await expect(
      recordInviteGrantUnlock(
        { repos: world.repos, clock: world.clock },
        { eventId: INVITE_EVENT_ID, viewerHumanId: INVITE_VIEWER_ID, inviteGrant: grant },
      ),
    ).resolves.toMatchObject({ persisted: false, outcome: "grant_invalid" });
    expect(unlockOf(world)).toBeUndefined();
  });

  it.each(["CANCELLED", "ARCHIVED", "DRAFT"] as const)(
    "event %s → refused",
    async (status) => {
      const world = createInviteWorld();
      const id = await sharedInviteId(world);
      (world.event as { status: string }).status = status;
      await expect(convert(world, id)).resolves.toMatchObject({
        outcome: "grant_invalid",
      });
      expect(unlockOf(world)).toBeUndefined();
    },
  );

  it("an expired grant, an unknown invite or an ungated event → refused", async () => {
    const world = createInviteWorld();
    const id = await sharedInviteId(world);
    await expect(
      recordInviteGrantUnlock(
        { repos: world.repos, clock: world.clock },
        {
          eventId: INVITE_EVENT_ID,
          viewerHumanId: INVITE_VIEWER_ID,
          inviteGrant: { inviteId: id, expMs: world.now.getTime() - 1 },
        },
      ),
    ).resolves.toMatchObject({ outcome: "grant_invalid" });
    await expect(
      convert(world, "12345678-1234-4234-8234-123456789abc"),
    ).resolves.toMatchObject({ outcome: "grant_invalid" });
    (world.event as { gateType: string }).gateType = "NONE";
    await expect(convert(world, id)).resolves.toMatchObject({ outcome: "grant_invalid" });
    expect(unlockOf(world)).toBeUndefined();
  });

  it("an invite of ANOTHER event → refused", async () => {
    const world = createInviteWorld();
    const id = await sharedInviteId(world);
    world.invites.find((i) => i.id === id)!.eventId =
      "99999999-9999-4999-8999-999999999999";
    await expect(convert(world, id)).resolves.toMatchObject({ outcome: "grant_invalid" });
  });

  it("an existing live unlock is left untouched (no overwrite of source / inviteId)", async () => {
    const world = createInviteWorld();
    const id = await sharedInviteId(world);
    const existing = {
      id: "u-1",
      eventId: INVITE_EVENT_ID,
      humanId: INVITE_VIEWER_ID,
      source: "PASSWORD",
      applicationSubmissionId: null,
      inviteId: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: world.now,
      updatedAt: world.now,
    };
    world.unlocks.set(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`, { ...existing } as never);

    await expect(convert(world, id)).resolves.toMatchObject({
      persisted: true,
      outcome: "already_unlocked",
    });
    expect(unlockOf(world)).toMatchObject({ source: "PASSWORD", inviteId: null });
    expect(world.audit.some((a) => a.action === "event_invite_grant_converted")).toBe(false);
  });

  it("is idempotent: a second conversion writes nothing", async () => {
    const world = createInviteWorld();
    const id = await sharedInviteId(world);
    await convert(world, id);
    const audits = world.audit.length;
    await expect(convert(world, id)).resolves.toMatchObject({
      persisted: true,
      outcome: "already_unlocked",
    });
    expect(world.audit.length).toBe(audits);
    expect(world.invites[0]).toMatchObject({ redemptionCount: 0 });
  });
});

describe("recordInviteGrantUnlock — APPLICATION event (R4, R15)", () => {
  it("no submission → a new APPROVED ATTEND submission with inviteId, and an unlock carrying it", async () => {
    const world = appWorld();
    const id = await sharedInviteId(world);
    const out = await convert(world, id);

    const attend = world.submissions.find((s) => s.purpose === "ATTEND")!;
    expect(attend).toMatchObject({
      status: "APPROVED",
      humanId: INVITE_VIEWER_ID,
      inviteId: id,
    });
    expect(out).toEqual({
      eventId: INVITE_EVENT_ID,
      persisted: true,
      outcome: "persisted",
      submissionId: attend.id,
    });
    expect(unlockOf(world)).toMatchObject({
      applicationSubmissionId: attend.id,
      revokedAt: null,
    });
    expect(world.invites[0]).toMatchObject({ redemptionCount: 0 });
  });

  it("an open PENDING ATTEND submission is approved with inviteId", async () => {
    const world = appWorld();
    const id = await sharedInviteId(world);
    const open = seedSubmission(world, { status: "PENDING" });
    await expect(convert(world, id)).resolves.toMatchObject({
      outcome: "persisted",
      submissionId: open.id,
    });
    expect(world.submissions.find((s) => s.id === open.id)).toMatchObject({
      status: "APPROVED",
      inviteId: id,
    });
  });

  it("previously REJECTED → a new APPROVED submission (R15)", async () => {
    const world = appWorld();
    const id = await sharedInviteId(world);
    const rejected = seedSubmission(world, { status: "REJECTED" });
    const out = await convert(world, id);
    expect(world.submissions.find((s) => s.id === rejected.id)?.status).toBe("REJECTED");
    const approved = world.submissions.find(
      (s) => s.status === "APPROVED" && s.purpose === "ATTEND",
    )!;
    expect(approved.id).not.toBe(rejected.id);
    expect(out).toMatchObject({ outcome: "persisted", submissionId: approved.id });
  });

  it("ATTEND only: an open PERFORM application is never approved", async () => {
    const world = appWorld();
    const id = await sharedInviteId(world);
    const perform = seedSubmission(world, { purpose: "PERFORM", status: "PENDING" });
    await convert(world, id);
    expect(world.submissions.find((s) => s.id === perform.id)).toMatchObject({
      status: "PENDING",
      inviteId: null,
    });
    expect(
      world.submissions.find((s) => s.purpose === "ATTEND")?.status,
    ).toBe("APPROVED");
  });

  it("PERSONAL revoked → refused, no submission created", async () => {
    const world = appWorld();
    const id = await personalInviteId(world);
    world.invites.find((i) => i.id === id)!.revokedAt = world.now;
    await expect(convert(world, id)).resolves.toMatchObject({
      outcome: "grant_invalid",
    });
    expect(world.submissions.filter((s) => s.humanId === INVITE_VIEWER_ID)).toHaveLength(0);
  });

  it("each signed-in holder converts for THEMSELVES (forwarded SHARED cookie)", async () => {
    const world = appWorld();
    const id = await sharedInviteId(world);
    await convert(world, id, INVITE_VIEWER_ID);
    await convert(world, id, INVITE_STRANGER_ID);
    expect(unlockOf(world, INVITE_STRANGER_ID)).toMatchObject({ revokedAt: null });
    expect(
      world.submissions.filter((s) => s.status === "APPROVED").map((s) => s.humanId).sort(),
    ).toEqual([INVITE_VIEWER_ID, INVITE_STRANGER_ID].sort());
  });
});

describe("recordInviteGrantUnlock — input", () => {
  it("is strict: rejects extra keys and a malformed grant", async () => {
    const world = createInviteWorld();
    await expect(
      recordInviteGrantUnlock(
        { repos: world.repos, clock: world.clock },
        {
          eventId: INVITE_EVENT_ID,
          viewerHumanId: INVITE_VIEWER_ID,
          inviteGrant: { inviteId: "nope", expMs: 1 },
        },
      ),
    ).rejects.toBeTruthy();
    await expect(
      recordInviteGrantUnlock(
        { repos: world.repos, clock: world.clock },
        {
          eventId: INVITE_EVENT_ID,
          viewerHumanId: INVITE_VIEWER_ID,
          inviteGrant: grantFor(world, INVITE_EVENT_ID),
          extra: true,
        },
      ),
    ).rejects.toBeTruthy();
  });
});
