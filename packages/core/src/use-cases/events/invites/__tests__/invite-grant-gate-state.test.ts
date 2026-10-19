import { describe, expect, it, vi } from "vitest";

import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_OPT_OUT_SECRET,
  INVITE_EVENT_ID,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import { getEventGateState } from "../../get-event-gate-state";
import { createEventGuestInvites } from "../create-event-guest-invites";
import { setEventSharedInvite } from "../set-event-shared-invite";

/**
 * The signed-out invite holder's `th_ei_` grant (FR-004, FR-006, FR-007,
 * FR-008, R5, R14): a SHARED grant survives reset / turn-off, a PERSONAL one
 * dies with its revoke, and both die at event end or cancellation.
 */

const linkDeps = (world: InviteWorld) => ({
  repos: world.repos,
  clock: world.clock,
  inviteTokenSecret: INVITE_SECRET,
  appBaseUrl: INVITE_APP_BASE_URL,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
  mailer: { send: vi.fn(async () => ({})) } as never,
});

const gate = (world: InviteWorld, inviteId: string | null, expMs?: number) =>
  getEventGateState(
    {
      repos: world.repos,
      authz: { hasStaffRole: async () => ({ allowed: false }) },
      clock: world.clock,
    },
    {
      eventId: INVITE_EVENT_ID,
      viewerHumanId: null,
      inviteGrant: inviteId
        ? { inviteId, expMs: expMs ?? (world.event.endsAt as Date).getTime() }
        : null,
    },
  );

async function sharedId(world: InviteWorld): Promise<string> {
  const out = await setEventSharedInvite(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    action: "ENABLE",
  });
  return out.id as string;
}

async function personalId(world: InviteWorld): Promise<string> {
  await createEventGuestInvites(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    guests: [{ name: "Guest", email: "guest@example.com" }],
  });
  return world.invites.find((i) => i.kind === "PERSONAL")!.id;
}

describe("getEventGateState — invite grant", () => {
  it("opens a PASSWORD gate", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await expect(gate(world, id)).resolves.toMatchObject({
      passwordRequired: false,
      viewerHasInviteGrant: true,
    });
  });

  it("opens an APPLICATION gate", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const id = await sharedId(world);
    await expect(gate(world, id)).resolves.toMatchObject({
      applicationRequired: false,
      viewerHasInviteGrant: true,
      viewerHasApplicationGrant: false,
    });
  });

  it("stays locked without a grant", async () => {
    const world = createInviteWorld();
    await expect(gate(world, null)).resolves.toMatchObject({
      passwordRequired: true,
      viewerHasInviteGrant: false,
    });
  });

  it("a SHARED grant survives Reset and Turn off (R5, R14)", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "RESET",
    });
    await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "DISABLE",
    });
    expect(world.invites.find((i) => i.id === id)?.revokedAt).not.toBeNull();
    await expect(gate(world, id)).resolves.toMatchObject({
      passwordRequired: false,
      viewerHasInviteGrant: true,
    });
  });

  it("a PERSONAL grant dies when the invite is revoked (FR-006)", async () => {
    const world = createInviteWorld();
    const id = await personalId(world);
    await expect(gate(world, id)).resolves.toMatchObject({
      viewerHasInviteGrant: true,
    });
    world.invites.find((i) => i.id === id)!.revokedAt = world.now;
    await expect(gate(world, id)).resolves.toMatchObject({
      passwordRequired: true,
      viewerHasInviteGrant: false,
    });
  });

  it("dies at event end and on cancellation (FR-008)", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    world.event.status = "CANCELLED";
    // A cancelled event stays readable to the public if it went live.
    await expect(gate(world, id)).resolves.toMatchObject({
      viewerHasInviteGrant: false,
    });

    const ended = createInviteWorld();
    const endedId = await sharedId(ended);
    ended.event.endsAt = new Date(ended.now.getTime());
    await expect(gate(ended, endedId, ended.now.getTime() + 1)).resolves.toMatchObject({
      viewerHasInviteGrant: false,
    });
  });

  it("an expired grant cookie does not count", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await expect(gate(world, id, world.now.getTime())).resolves.toMatchObject({
      viewerHasInviteGrant: false,
    });
  });

  it("a grant for another event's invite stays locked", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    world.invites[0]!.eventId = "66666666-6666-4666-8666-666666666666";
    await expect(gate(world, id)).resolves.toMatchObject({
      passwordRequired: true,
      viewerHasInviteGrant: false,
    });
  });

  it("never opens an ungated event's flags and does not look the invite up", async () => {
    const world = createInviteWorld({ event: { gateType: "NONE" } });
    const spy = vi.spyOn(world.repos.eventInvites, "getById");
    const state = await gate(world, "12345678-1234-4234-8234-123456789abc");
    expect(state.viewerHasInviteGrant).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
