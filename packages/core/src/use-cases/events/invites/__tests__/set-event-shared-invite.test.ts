import { describe, expect, it } from "vitest";

import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_OPT_OUT_SECRET,
  INVITE_EVENT_ID,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  INVITE_STRANGER_ID,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import {
  hashInviteToken,
  mintInviteToken,
} from "../../../../lib/security/invite-token";
import { setEventSharedInvite } from "../set-event-shared-invite";

const depsFor = (world: InviteWorld) => ({
  repos: world.repos,
  clock: world.clock,
  inviteTokenSecret: INVITE_SECRET,
  appBaseUrl: INVITE_APP_BASE_URL,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
});

const run = (
  world: InviteWorld,
  action: "ENABLE" | "RESET" | "DISABLE",
  actorHumanId = INVITE_ORGANIZER_ID,
) =>
  setEventSharedInvite(depsFor(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId,
    action,
  });

const tokenOf = (url: string | null) =>
  decodeURIComponent(new URL(url as string).searchParams.get("invite") as string);

describe("setEventSharedInvite (FR-001)", () => {
  it("ENABLE mints a SHARED invite and returns its full URL; the DB stores only the token hash", async () => {
    const world = createInviteWorld();
    const out = await run(world, "ENABLE");

    expect(out.id).toBeTruthy();
    expect(out.url).toMatch(
      /^https:\/\/ithas\.fire\/events\/basement-show\?invite=inv_/,
    );
    const token = tokenOf(out.url);
    expect(token).toBe(mintInviteToken(out.id as string, INVITE_SECRET));
    expect(world.invites).toHaveLength(1);
    expect(world.invites[0]).toMatchObject({
      id: out.id,
      kind: "SHARED",
      tokenHash: hashInviteToken(token),
      revokedAt: null,
    });
    expect(JSON.stringify(world.invites[0])).not.toContain(token);
    expect(world.audit.map((a) => a.action)).toEqual([
      "event_shared_invite_enabled",
    ]);
  });

  it("ENABLE is idempotent: a live link is returned, not replaced", async () => {
    const world = createInviteWorld();
    const first = await run(world, "ENABLE");
    const second = await run(world, "ENABLE");
    expect(second).toEqual(first);
    expect(world.invites).toHaveLength(1);
  });

  it("RESET revokes the live link and mints a new one", async () => {
    const world = createInviteWorld();
    const first = await run(world, "ENABLE");
    const reset = await run(world, "RESET");

    expect(reset.id).not.toBe(first.id);
    expect(reset.url).not.toBe(first.url);
    const old = world.invites.find((i) => i.id === first.id);
    expect(old?.revokedAt).toEqual(world.now);
    expect(world.invites.filter((i) => !i.revokedAt)).toHaveLength(1);
  });

  it("a RESET that loses the race returns the winner's live link instead of an error", async () => {
    const world = createInviteWorld();
    await run(world, "ENABLE");
    let winnerId: string | null = null;
    world.hooks.beforeRotate = () => {
      world.hooks.beforeRotate = undefined;
      // A concurrent reset commits first: it revokes the old link and
      // inserts its own. Our insert then hits the one-live-SHARED index.
      for (const i of world.invites) i.revokedAt ??= world.now;
      winnerId = "99999999-9999-4999-8999-999999999999";
      world.invites.push({
        ...world.invites[0]!,
        id: winnerId,
        tokenHash: "winner",
        revokedAt: null,
      });
      // Make rotateShared's own revoke miss and its insert collide.
      throw { code: "shared_invite_already_live", message: "x" };
    };

    const out = await run(world, "RESET");
    expect(out.id).toBe(winnerId);
    expect(tokenOf(out.url)).toBe(mintInviteToken(winnerId!, INVITE_SECRET));
  });

  it("DISABLE revokes the live link and leaves none; repeating it is a no-op", async () => {
    const world = createInviteWorld();
    const first = await run(world, "ENABLE");
    await expect(run(world, "DISABLE")).resolves.toEqual({
      id: first.id,
      url: null,
    });
    expect(world.invites.every((i) => i.revokedAt)).toBe(true);
    await expect(run(world, "DISABLE")).resolves.toEqual({ id: null, url: null });
  });

  it.each(["PASSWORD", "APPLICATION"] as const)(
    "works on a %s event",
    async (gateType) => {
      const world = createInviteWorld({ event: { gateType } });
      await expect(run(world, "ENABLE")).resolves.toMatchObject({
        url: expect.stringContaining("?invite="),
      });
    },
  );

  it("allows the shared link on a DRAFT event (copying it is harmless)", async () => {
    const world = createInviteWorld({ event: { status: "DRAFT" } });
    await expect(run(world, "ENABLE")).resolves.toMatchObject({
      url: expect.stringContaining("?invite="),
    });
  });

  it("refuses an ungated event", async () => {
    const world = createInviteWorld({ event: { gateType: "NONE" } });
    await expect(run(world, "ENABLE")).rejects.toMatchObject({
      code: "INVALID_STATUS",
    });
  });

  it("refuses an ended or cancelled event", async () => {
    const ended = createInviteWorld({
      event: {
        startsAt: new Date("2026-10-01T00:00:00Z"),
        endsAt: new Date("2026-10-01T03:00:00Z"),
      },
    });
    await expect(run(ended, "ENABLE")).rejects.toMatchObject({
      code: "EVENT_ALREADY_ENDED",
    });
    const cancelled = createInviteWorld({ event: { status: "CANCELLED" } });
    await expect(run(cancelled, "ENABLE")).rejects.toMatchObject({
      code: "EVENT_ALREADY_CANCELLED",
    });
  });

  it("refuses someone without edit rights on the event", async () => {
    const world = createInviteWorld();
    await expect(run(world, "ENABLE", INVITE_STRANGER_ID)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(world.invites).toHaveLength(0);
  });

  it("refuses to mint without a web origin rather than hand out a dead link", async () => {
    const world = createInviteWorld();
    await expect(
      setEventSharedInvite(
        { ...depsFor(world), appBaseUrl: null },
        { eventId: INVITE_EVENT_ID, actorHumanId: INVITE_ORGANIZER_ID, action: "ENABLE" },
      ),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(world.invites).toHaveLength(0);
  });
});
