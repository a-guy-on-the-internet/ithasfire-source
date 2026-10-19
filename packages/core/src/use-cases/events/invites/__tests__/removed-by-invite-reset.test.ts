import { describe, expect, it, vi } from "vitest";

import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_EVENT_ID,
  INVITE_OPT_OUT_SECRET,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  INVITE_STRANGER_ID,
  INVITE_VIEWER_ID,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import { getEventGateState } from "../../get-event-gate-state";
import { createEventGuestInvites } from "../create-event-guest-invites";
import { revokeEventGuestInvite } from "../revoke-event-guest-invite";
import { setEventSharedInvite } from "../set-event-shared-invite";

/**
 * `viewerRemovedByInviteReset` (owner ruling 2026-10-06): a guest removed by
 * "Reset and remove everyone" is told why on the gate. It comes only from the
 * viewer's own proof (their verified `th_ei_` grant, or their own revoked
 * unlock), only for RESET_AND_REMOVE, and only while the gate still matters.
 */

const clockAt = (at: Date) => ({ now: () => at });

const linkDeps = (world: InviteWorld, at?: Date) => ({
  repos: world.repos,
  clock: at ? clockAt(at) : world.clock,
  inviteTokenSecret: INVITE_SECRET,
  appBaseUrl: INVITE_APP_BASE_URL,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
  mailer: { send: vi.fn(async () => ({})) } as never,
});

const act = (
  world: InviteWorld,
  action: "ENABLE" | "RESET" | "RESET_AND_REMOVE" | "DISABLE",
  at?: Date,
) =>
  setEventSharedInvite(linkDeps(world, at), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    action,
  });

const gate = (
  world: InviteWorld,
  viewer: {
    inviteId?: string | null;
    expMs?: number;
    humanId?: string | null;
  },
  extraDeps: { reportError?: ReturnType<typeof vi.fn> } = {},
  opts: { explainRemoval?: boolean; at?: Date } = {},
) =>
  getEventGateState(
    {
      repos: world.repos,
      authz: { hasStaffRole: async () => ({ allowed: false }) },
      clock: opts.at ? clockAt(opts.at) : world.clock,
      ...extraDeps,
    },
    {
      eventId: INVITE_EVENT_ID,
      explainRemoval: opts.explainRemoval ?? true,
      viewerHumanId: viewer.humanId ?? null,
      inviteGrant: viewer.inviteId
        ? {
            inviteId: viewer.inviteId,
            expMs: viewer.expMs ?? (world.event.endsAt as Date).getTime(),
          }
        : null,
    },
  );

async function sharedId(world: InviteWorld): Promise<string> {
  return (await act(world, "ENABLE")).id as string;
}

/** A signed-in viewer who came in through the shared link. */
async function signedInThroughShared(world: InviteWorld, inviteId: string) {
  await world.repos.eventUnlocks.upsert({
    eventId: INVITE_EVENT_ID,
    humanId: INVITE_VIEWER_ID,
    source: "MAGIC_LINK",
    inviteId,
  });
}

describe("viewerRemovedByInviteReset — signed out (th_ei_ grant)", () => {
  it.each(["PASSWORD", "APPLICATION"] as const)(
    "is true on a %s gate after Reset and remove everyone",
    async (gateType) => {
      const world = createInviteWorld({ event: { gateType } });
      const id = await sharedId(world);
      await act(world, "RESET_AND_REMOVE");

      const state = await gate(world, { inviteId: id });
      expect(state).toMatchObject({
        viewerHasInviteGrant: false,
        viewerRemovedByInviteReset: true,
      });
      expect(state.passwordRequired || state.applicationRequired).toBe(true);
    },
  );

  it("is true for a link that was already reset, then removed", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await act(world, "RESET");
    await act(world, "RESET_AND_REMOVE");
    await expect(gate(world, { inviteId: id })).resolves.toMatchObject({
      viewerRemovedByInviteReset: true,
    });
  });

  it("is false after a plain Reset or Turn off: the holder is still in", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await act(world, "RESET");
    await act(world, "DISABLE");
    await expect(gate(world, { inviteId: id })).resolves.toMatchObject({
      viewerHasInviteGrant: true,
      viewerRemovedByInviteReset: false,
    });
  });

  it("is false once the event has ended", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await act(world, "RESET_AND_REMOVE");
    world.event.endsAt = new Date(world.now.getTime());
    await expect(
      gate(world, { inviteId: id, expMs: world.now.getTime() + 1 }),
    ).resolves.toMatchObject({ viewerRemovedByInviteReset: false });
  });

  it("is false once the event is cancelled", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await act(world, "RESET_AND_REMOVE");
    world.event.status = "CANCELLED";
    await expect(gate(world, { inviteId: id })).resolves.toMatchObject({
      viewerRemovedByInviteReset: false,
    });
  });

  it("is false for an expired grant cookie", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await act(world, "RESET_AND_REMOVE");
    await expect(
      gate(world, { inviteId: id, expMs: world.now.getTime() }),
    ).resolves.toMatchObject({ viewerRemovedByInviteReset: false });
  });

  it("is false when the removed invite belongs to another event", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await act(world, "RESET_AND_REMOVE");
    world.invites.find((i) => i.id === id)!.eventId =
      "66666666-6666-4666-8666-666666666666";
    await expect(gate(world, { inviteId: id })).resolves.toMatchObject({
      viewerRemovedByInviteReset: false,
    });
  });

  it("is false for a revoked PERSONAL invite (that is not a link reset)", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    const invite = world.invites.find((i) => i.id === id)!;
    invite.kind = "PERSONAL";
    invite.revokedAt = world.now;
    invite.grantsRevokedAt = world.now;
    await expect(gate(world, { inviteId: id })).resolves.toMatchObject({
      viewerRemovedByInviteReset: false,
    });
  });

  it("is false for a stranger with no grant, and looks nothing up", async () => {
    const world = createInviteWorld();
    await sharedId(world);
    await act(world, "RESET_AND_REMOVE");
    const spy = vi.spyOn(world.repos.eventInvites, "getById");
    await expect(gate(world, {})).resolves.toMatchObject({
      passwordRequired: true,
      viewerRemovedByInviteReset: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("is false on an ungated event", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await act(world, "RESET_AND_REMOVE");
    world.event.gateType = "NONE";
    await expect(gate(world, { inviteId: id })).resolves.toMatchObject({
      viewerRemovedByInviteReset: false,
    });
  });
});

describe("viewerRemovedByInviteReset — signed in (own unlock)", () => {
  it.each(["PASSWORD", "APPLICATION"] as const)(
    "is true on a %s gate when Reset and remove everyone revoked their unlock",
    async (gateType) => {
      const world = createInviteWorld({ event: { gateType } });
      const id = await sharedId(world);
      await signedInThroughShared(world, id);
      await act(world, "RESET_AND_REMOVE");

      await expect(
        gate(world, { humanId: INVITE_VIEWER_ID }),
      ).resolves.toMatchObject({
        viewerIsUnlocked: false,
        viewerRemovedByInviteReset: true,
      });
    },
  );

  it("is false after a plain Reset: they are still in", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    await act(world, "RESET");
    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }),
    ).resolves.toMatchObject({
      viewerIsUnlocked: true,
      viewerRemovedByInviteReset: false,
    });
  });

  it("is false when their unlock was revoked some other way BEFORE the reset", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`)!.revokedAt =
      new Date(world.now.getTime() - 60_000);
    await act(world, "RESET_AND_REMOVE");
    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }),
    ).resolves.toMatchObject({ viewerRemovedByInviteReset: false });
  });

  it("is false once they are back in (re-unlocked by any route)", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    await act(world, "RESET_AND_REMOVE");
    await world.repos.eventUnlocks.upsert({
      eventId: INVITE_EVENT_ID,
      humanId: INVITE_VIEWER_ID,
      source: "PASSWORD",
    });
    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }),
    ).resolves.toMatchObject({
      viewerIsUnlocked: true,
      viewerRemovedByInviteReset: false,
    });
  });

  it("is false once the event has ended", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    await act(world, "RESET_AND_REMOVE");
    world.event.endsAt = new Date(world.now.getTime());
    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }),
    ).resolves.toMatchObject({ viewerRemovedByInviteReset: false });
  });

  it("is false for another signed-in viewer who never held access", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    await act(world, "RESET_AND_REMOVE");
    await expect(
      gate(world, { humanId: INVITE_STRANGER_ID }),
    ).resolves.toMatchObject({
      passwordRequired: true,
      viewerRemovedByInviteReset: false,
    });
  });

  it("is false for a revoked unlock that came from no invite", async () => {
    const world = createInviteWorld();
    await sharedId(world);
    await world.repos.eventUnlocks.upsert({
      eventId: INVITE_EVENT_ID,
      humanId: INVITE_VIEWER_ID,
      source: "PASSWORD",
    });
    await act(world, "RESET_AND_REMOVE");
    await world.repos.eventUnlocks.revoke(INVITE_EVENT_ID, INVITE_VIEWER_ID);
    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }),
    ).resolves.toMatchObject({ viewerRemovedByInviteReset: false });
  });
});

describe("viewerRemovedByInviteReset — a failed lookup", () => {
  it("reads as no reason, keeps the gate answer, and is reported", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    await act(world, "RESET_AND_REMOVE");
    const boom = new Error("db down");
    vi.spyOn(world.repos.eventUnlocks, "get").mockRejectedValue(boom);
    const reportError = vi.fn();

    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }, { reportError }),
    ).resolves.toMatchObject({
      passwordRequired: true,
      viewerRemovedByInviteReset: false,
    });
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "getEventGateState",
          channel: "removed_by_invite_reset_lookup_failed",
        }),
      }),
    );
  });

  it("a throwing reporter changes nothing", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    await act(world, "RESET_AND_REMOVE");
    vi.spyOn(world.repos.eventUnlocks, "get").mockRejectedValue(new Error("x"));
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });

    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }, { reportError }),
    ).resolves.toMatchObject({ viewerRemovedByInviteReset: false });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("viewerRemovedByInviteReset — only when asked, only when shut", () => {
  it("is false, with no lookup, when the caller does not ask (access checks)", async () => {
    const world = createInviteWorld();
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    await act(world, "RESET_AND_REMOVE");
    const invites = vi.spyOn(world.repos.eventInvites, "getById");
    const unlocks = vi.spyOn(world.repos.eventUnlocks, "get");

    await expect(
      gate(
        world,
        { inviteId: id, humanId: INVITE_VIEWER_ID },
        {},
        { explainRemoval: false },
      ),
    ).resolves.toMatchObject({
      passwordRequired: true,
      viewerRemovedByInviteReset: false,
    });
    expect(unlocks).not.toHaveBeenCalled();
    // `inviteGrantHolds` reads the invite once; the explanation adds none.
    expect(invites).toHaveBeenCalledTimes(1);
  });

  it("is false, with no lookup, on a PASSWORD gate with no password set (gate not shut)", async () => {
    const world = createInviteWorld({ event: { passwordHash: null } });
    const id = await sharedId(world);
    await signedInThroughShared(world, id);
    await act(world, "RESET_AND_REMOVE");
    const unlocks = vi.spyOn(world.repos.eventUnlocks, "get");

    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }),
    ).resolves.toMatchObject({
      passwordRequired: false,
      viewerRemovedByInviteReset: false,
    });
    expect(unlocks).not.toHaveBeenCalled();
  });
});

describe("viewerRemovedByInviteReset — ordering", () => {
  it("removed twice: the second removal still explains, and the first link keeps its first stamp", async () => {
    const world = createInviteWorld();
    const t1 = world.now;
    const t2 = new Date(t1.getTime() + 60 * 60 * 1000);
    const l1 = await sharedId(world);
    await signedInThroughShared(world, l1);

    const first = await act(world, "RESET_AND_REMOVE", t1);
    const l2 = first.id as string;
    expect(l2).not.toBe(l1);
    // Back in through the new link, then removed again.
    await signedInThroughShared(world, l2);
    await act(world, "RESET_AND_REMOVE", t2);

    expect(world.invites.find((i) => i.id === l1)?.grantsRevokedAt).toEqual(t1);
    expect(world.invites.find((i) => i.id === l2)?.grantsRevokedAt).toEqual(t2);
    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }, {}, { at: t2 }),
    ).resolves.toMatchObject({
      viewerIsUnlocked: false,
      viewerRemovedByInviteReset: true,
    });
    // A signed-out holder of the FIRST link is still told why.
    await expect(
      gate(world, { inviteId: l1 }, {}, { at: t2 }),
    ).resolves.toMatchObject({ viewerRemovedByInviteReset: true });
  });

  it("a named guest kept on their PERSONAL invite, who later loses it, is not told it was a link reset", async () => {
    const world = createInviteWorld();
    world.accountEmails.set(INVITE_VIEWER_ID, "ana@example.com");
    world.verified.add(INVITE_VIEWER_ID);
    const sharedLink = await sharedId(world);
    await signedInThroughShared(world, sharedLink);
    await createEventGuestInvites(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    const personal = world.invites.find((i) => i.kind === "PERSONAL")!.id;

    const out = await act(world, "RESET_AND_REMOVE");
    expect(out.removed).toMatchObject({ namedGuestsKept: 1 });
    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }),
    ).resolves.toMatchObject({ viewerIsUnlocked: true });

    await revokeEventGuestInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      inviteId: personal,
    });
    const unlock = world.unlocks.get(`${INVITE_EVENT_ID}:${INVITE_VIEWER_ID}`)!;
    expect(unlock).toMatchObject({ inviteId: personal });
    expect(unlock.revokedAt).not.toBeNull();
    await expect(
      gate(world, { humanId: INVITE_VIEWER_ID }),
    ).resolves.toMatchObject({
      passwordRequired: true,
      viewerRemovedByInviteReset: false,
    });
  });
});
