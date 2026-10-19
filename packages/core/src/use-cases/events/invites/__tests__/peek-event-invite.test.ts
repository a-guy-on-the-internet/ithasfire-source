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

import { mintInviteToken } from "../../../../lib/security/invite-token";
import { createEventGuestInvites } from "../create-event-guest-invites";
import { peekEventInvite, shortInviteeName } from "../peek-event-invite";
import { redeemEventInvite } from "../redeem-event-invite";
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

const peek = (world: InviteWorld, token: string, secret = INVITE_SECRET) =>
  peekEventInvite(
    { repos: world.repos, clock: world.clock, inviteTokenSecret: secret },
    { token },
  );

async function sharedToken(world: InviteWorld): Promise<string> {
  const out = await setEventSharedInvite(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    action: "ENABLE",
  });
  return mintInviteToken(out.id as string, INVITE_SECRET);
}

async function personalToken(world: InviteWorld, name = "Maya Rodriguez") {
  await createEventGuestInvites(linkDeps(world), {
    eventId: INVITE_EVENT_ID,
    actorHumanId: INVITE_ORGANIZER_ID,
    guests: [{ name, email: "maya@example.com" }],
  });
  const invite = world.invites.find((i) => i.inviteeEmail === "maya@example.com")!;
  return mintInviteToken(invite.id, INVITE_SECRET);
}

/** Everything a peek could possibly write to. */
const snapshot = (world: InviteWorld) =>
  JSON.stringify({
    invites: world.invites,
    unlocks: [...world.unlocks.entries()],
    submissions: world.submissions,
    waitlist: world.waitlist,
    audit: world.audit,
  });

describe("peekEventInvite — live links", () => {
  it("SHARED → kind, organizer, no invitee name, and NO side effects", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    const before = snapshot(world);

    await expect(peek(world, token)).resolves.toEqual({
      ok: true,
      eventId: INVITE_EVENT_ID,
      kind: "SHARED",
      inviteeShortName: null,
      organizerName: "Stub Collective",
    });
    expect(snapshot(world)).toBe(before);
    expect(world.invites[0]).toMatchObject({ redemptionCount: 0, firstRedeemedAt: null });
  });

  it("PERSONAL → the short name, never the email, and NO side effects", async () => {
    const world = createInviteWorld();
    const token = await personalToken(world);
    const before = snapshot(world);

    const out = await peek(world, token);
    expect(out).toEqual({
      ok: true,
      eventId: INVITE_EVENT_ID,
      kind: "PERSONAL",
      inviteeShortName: "Maya R.",
      organizerName: "Stub Collective",
    });
    expect(JSON.stringify(out)).not.toContain("maya@example.com");
    expect(JSON.stringify(out)).not.toContain("Rodriguez");
    expect(snapshot(world)).toBe(before);
  });

  it("works on an APPLICATION event too", async () => {
    const world = createInviteWorld({ event: { gateType: "APPLICATION" } });
    const token = await sharedToken(world);
    await expect(peek(world, token)).resolves.toMatchObject({ ok: true, kind: "SHARED" });
  });

  it("a human-owned event names the human organizer", async () => {
    const world = createInviteWorld({
      event: { orgId: null, humanId: INVITE_ORGANIZER_ID } as never,
    });
    const token = await sharedToken(world);
    await expect(peek(world, token)).resolves.toMatchObject({
      organizerName: "Org Person",
    });
  });
});

describe("peekEventInvite — dead links (redeem's reasons)", () => {
  it.each([
    ["garbage", "not-a-token"],
    [
      "a well-formed token no secret minted",
      `inv_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}_${"A".repeat(43)}`,
    ],
  ])("%s → INVALID with no event", async (_, token) => {
    const world = createInviteWorld();
    await expect(peek(world, token)).resolves.toEqual({
      ok: false,
      reason: "INVALID",
      eventId: null,
    });
  });

  it("expectedEventId naming another event → INVALID with no event; its own event → live (F7)", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    const deps = { repos: world.repos, clock: world.clock, inviteTokenSecret: INVITE_SECRET };
    await expect(
      peekEventInvite(deps, {
        token,
        expectedEventId: "99999999-0000-4000-8000-000000000099",
      }),
    ).resolves.toEqual({ ok: false, reason: "INVALID", eventId: null });
    await expect(
      peekEventInvite(deps, { token, expectedEventId: INVITE_EVENT_ID }),
    ).resolves.toMatchObject({ ok: true, eventId: INVITE_EVENT_ID });
  });

  it("a forged token (other secret) or an unknown invite → INVALID", async () => {
    const world = createInviteWorld();
    await sharedToken(world);
    const forged = mintInviteToken(world.invites[0]!.id, "x".repeat(48));
    await expect(peek(world, forged)).resolves.toMatchObject({ reason: "INVALID" });
    const unknown = mintInviteToken("12345678-1234-4234-8234-123456789abc", INVITE_SECRET);
    await expect(peek(world, unknown)).resolves.toMatchObject({ reason: "INVALID" });
  });

  it("a reset SHARED link → REVOKED for new arrivals (R5), with the event", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    await setEventSharedInvite(linkDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      action: "RESET",
    });
    await expect(peek(world, token)).resolves.toEqual({
      ok: false,
      reason: "REVOKED",
      eventId: INVITE_EVENT_ID,
    });
  });

  it("a revoked PERSONAL link → REVOKED", async () => {
    const world = createInviteWorld();
    const token = await personalToken(world);
    world.invites[0]!.revokedAt = world.now;
    await expect(peek(world, token)).resolves.toMatchObject({ reason: "REVOKED" });
  });

  it.each([
    ["CANCELLED", "EVENT_CANCELLED"],
    ["DRAFT", "EVENT_UNAVAILABLE"],
    ["ARCHIVED", "EVENT_UNAVAILABLE"],
  ] as const)("event %s → %s", async (status, reason) => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    (world.event as { status: string }).status = status;
    await expect(peek(world, token)).resolves.toEqual({
      ok: false,
      reason,
      eventId: INVITE_EVENT_ID,
    });
  });

  it("event ended → EVENT_ENDED", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    world.event.startsAt = new Date(world.now.getTime() - 3 * 3_600_000);
    world.event.endsAt = new Date(world.now.getTime() - 3_600_000);
    await expect(peek(world, token)).resolves.toMatchObject({ reason: "EVENT_ENDED" });
  });

  it("gate removed → NOT_GATED", async () => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    (world.event as { gateType: string }).gateType = "NONE";
    await expect(peek(world, token)).resolves.toMatchObject({ reason: "NOT_GATED" });
  });

  it("a dead peek writes nothing either", async () => {
    const world = createInviteWorld();
    const token = await personalToken(world);
    world.invites[0]!.revokedAt = world.now;
    const before = snapshot(world);
    await peek(world, token);
    expect(snapshot(world)).toBe(before);
  });
});

describe("peekEventInvite — config and input", () => {
  it("no token key → NOT_CONFIGURED", async () => {
    const world = createInviteWorld();
    await expect(peek(world, "x", "")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("strict input", async () => {
    const world = createInviteWorld();
    await expect(
      peekEventInvite(
        { repos: world.repos, clock: world.clock, inviteTokenSecret: INVITE_SECRET },
        { token: "x", viewerHumanId: null },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

/**
 * Dead-reason PRECEDENCE, pinned through both callers of `resolveLiveInvite`
 * so a reorder there fails here. Current order: REVOKED → EVENT_CANCELLED →
 * EVENT_UNAVAILABLE → EVENT_ENDED → NOT_GATED.
 */
describe("dead-reason precedence (peek and redeem agree)", () => {
  const ended = (world: InviteWorld) => {
    world.event.startsAt = new Date(world.now.getTime() - 3 * 3_600_000);
    world.event.endsAt = new Date(world.now.getTime() - 3_600_000);
  };
  const setStatus = (world: InviteWorld, status: string) => {
    (world.event as { status: string }).status = status;
  };

  it.each([
    [
      "revoked + cancelled + ended",
      (w: InviteWorld) => {
        w.invites[0]!.revokedAt = w.now;
        setStatus(w, "CANCELLED");
        ended(w);
      },
      "REVOKED",
    ],
    [
      "cancelled + ended",
      (w: InviteWorld) => {
        setStatus(w, "CANCELLED");
        ended(w);
      },
      "EVENT_CANCELLED",
    ],
    [
      "archived + ended",
      (w: InviteWorld) => {
        setStatus(w, "ARCHIVED");
        ended(w);
      },
      "EVENT_UNAVAILABLE",
    ],
    [
      "ended + gate removed",
      (w: InviteWorld) => {
        ended(w);
        (w.event as { gateType: string }).gateType = "NONE";
      },
      "EVENT_ENDED",
    ],
  ] as const)("%s → %s", async (_label, arrange, reason) => {
    const world = createInviteWorld();
    const token = await sharedToken(world);
    arrange(world);

    await expect(peek(world, token)).resolves.toMatchObject({ ok: false, reason });
    await expect(
      redeemEventInvite(
        { repos: world.repos, clock: world.clock, inviteTokenSecret: INVITE_SECRET },
        { token, viewerHumanId: null },
      ),
    ).resolves.toMatchObject({ ok: false, reason });
  });
});

describe("shortInviteeName", () => {
  it.each([
    ["Maya Rodriguez", "Maya R."],
    ["  Maya   de la Cruz ", "Maya C."],
    ["maya rodriguez", "maya R."],
    ["Maya", "Maya"],
    ["Zoë Ørsted", "Zoë Ø."],
    ["", null],
    ["   ", null],
    [null, null],
  ] as const)("%j → %j", (name, expected) => {
    expect(shortInviteeName(name)).toBe(expected);
  });
});
