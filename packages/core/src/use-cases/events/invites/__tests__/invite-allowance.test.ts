import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import { isAppError } from "@th/errors";
import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_EVENT_ID,
  INVITE_OPT_OUT_SECRET,
  INVITE_ORG_ID,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  makeInviteEvent,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";
import { createInMemoryRateLimit } from "@th/test-utils/fakes/rate-limit";

import {
  createEventGuestInvites,
  resendEventGuestInvite,
} from "../create-event-guest-invites";
import {
  INVITE_ALLOWANCE_WINDOW_SECONDS,
  MIN_DISTINCT_SCANNED_HOLDERS,
  NEW_ACCOUNT_AGE_SECONDS,
  NEW_ACCOUNT_DAILY_RECIPIENTS,
  NEW_SENDER_DAILY_RECIPIENTS,
  TRACK_RECORD_DAILY_RECIPIENTS,
  TRACK_RECORD_DOOR_LEAD_SECONDS,
  TRACK_RECORD_EVENT_SETTLE_SECONDS,
} from "../invite-allowance";

/**
 * The invite email allowance (security review F1, owner ruling 10-05):
 * RECIPIENTS per rolling 24h, charged to the sending actor AND the event
 * owner, all or nothing, before anything is created or sent. 50 for a new
 * organiser, 1,000 once the owner has a settled payout or 10 distinct
 * outside holders scanned at the door of events that ended a day ago.
 * Unsent emails are refunded; a limiter outage fails closed.
 */

const CO_ADMIN = "70000000-0000-4000-8000-000000000007";
const OTHER_ORG = "80000000-0000-4000-8000-000000000008";
const OTHER_EVENT = "90000000-0000-4000-8000-000000000009";
const PERSON_EVENT = "a0000000-0000-4000-8000-00000000000a";

type Clock = { t: number };

function setup(opts: { event?: Partial<EventRecord> } = {}) {
  const world = createInviteWorld(opts);
  const clock: Clock = { t: world.now.getTime() };
  const limiter = createInMemoryRateLimit({ now: () => clock.t });
  const mailer = {
    send: vi.fn(async () => ({ result: { id: "m", status: "queued" } })),
  };
  const reportError = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deps = () => ({
    logger: logger as never,
    repos: world.repos,
    clock: { now: () => new Date(clock.t) },
    inviteTokenSecret: INVITE_SECRET,
    appBaseUrl: INVITE_APP_BASE_URL,
    inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
    mailer: mailer as never,
    reportError,
    rateLimit: limiter,
  });
  // Keep the event in the future as the test clock advances.
  world.event.startsAt = new Date(world.now.getTime() + 10 * 86_400_000);
  world.event.endsAt = new Date(world.now.getTime() + 11 * 86_400_000);
  return { world, clock, limiter, mailer, reportError, logger, deps };
}

const emails = (n: number, prefix = "g") =>
  Array.from({ length: n }, (_, i) => ({
    name: `Guest ${i}`,
    email: `${prefix}${i}@example.com`,
  }));

const send = (
  s: ReturnType<typeof setup>,
  guests: Array<{ name: string; email: string }>,
  extra: { actorHumanId?: string; eventId?: string; resendExisting?: boolean } = {},
) =>
  createEventGuestInvites(s.deps(), {
    eventId: extra.eventId ?? INVITE_EVENT_ID,
    actorHumanId: extra.actorHumanId ?? INVITE_ORGANIZER_ID,
    guests,
    ...(extra.resendExisting ? { resendExisting: true } : {}),
  });

async function allowanceError(p: Promise<unknown>) {
  try {
    await p;
  } catch (error) {
    if (isAppError(error) && error.code === "INVITE_ALLOWANCE_EXCEEDED") {
      return error;
    }
    throw error;
  }
  throw new Error("expected INVITE_ALLOWANCE_EXCEEDED");
}

/** A second event the same organizer can edit, owned by another org. */
function addOtherOrgEvent(world: InviteWorld) {
  world.events.set(
    OTHER_EVENT,
    makeInviteEvent({
      id: OTHER_EVENT,
      orgId: OTHER_ORG,
      slug: "other-show",
      startsAt: world.event.startsAt,
      endsAt: world.event.endsAt,
    }),
  );
  world.memberships.set(`${OTHER_ORG}:${INVITE_ORGANIZER_ID}`, "ADMIN");
}

describe("invite allowance: new organiser (50 per rolling 24h)", () => {
  it("sends up to 50 and refuses the 51st, creating and sending nothing for it", async () => {
    const s = setup();
    expect(NEW_SENDER_DAILY_RECIPIENTS).toBe(50);

    const out = await send(s, emails(50));
    expect(out).toMatchObject({ created: 50, sent: 50 });

    const err = await allowanceError(send(s, emails(1, "late")));
    expect(err.meta).toMatchObject({ requested: 1, remaining: 0, limit: 50 });
    expect(s.world.invites).toHaveLength(50);
    expect(s.mailer.send).toHaveBeenCalledTimes(50);
  });

  it("is all or nothing: a batch bigger than what remains sends none; a batch that fits sends all", async () => {
    const s = setup();
    await send(s, emails(40));

    const err = await allowanceError(send(s, emails(20, "b")));
    expect(err.meta).toMatchObject({ requested: 20, remaining: 10 });
    expect(s.world.invites).toHaveLength(40);
    expect(s.mailer.send).toHaveBeenCalledTimes(40);
    // The refused call charged nothing.
    expect(s.limiter.allowanceUsed(`invite-allowance:actor:${INVITE_ORGANIZER_ID}`, INVITE_ALLOWANCE_WINDOW_SECONDS)).toBe(40);

    const ok = await send(s, emails(10, "c"));
    expect(ok).toMatchObject({ created: 10, sent: 10 });
  });

  it("rolls: what was sent 24h ago stops counting", async () => {
    const s = setup();
    await send(s, emails(50));
    await allowanceError(send(s, emails(1, "x")));

    s.clock.t += INVITE_ALLOWANCE_WINDOW_SECONDS * 1000 + 1;
    expect(await send(s, emails(1, "y"))).toMatchObject({ sent: 1 });
  });

  it("charges only emails actually sent: reused invites without resendExisting are free", async () => {
    const s = setup();
    await send(s, emails(30));
    const again = await send(s, emails(30));
    expect(again).toMatchObject({ created: 0, reused: 30, sent: 0 });
    expect(await send(s, emails(20, "more"))).toMatchObject({ sent: 20 });
  });

  it("counts resendExisting re-sends, all or nothing", async () => {
    const s = setup();
    await send(s, emails(30));
    // 30 re-sends + 0 new = 30 > 20 remaining: refused whole.
    const err = await allowanceError(send(s, emails(30), { resendExisting: true }));
    expect(err.meta).toMatchObject({ requested: 30, remaining: 20 });
    expect(s.mailer.send).toHaveBeenCalledTimes(30);
  });

  it("counts a single Resend, and refuses it once the allowance is spent", async () => {
    const s = setup();
    await send(s, emails(49));
    const invite = s.world.invites[0]!;
    const resend = () =>
      resendEventGuestInvite(s.deps(), {
        eventId: INVITE_EVENT_ID,
        inviteId: invite.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      });

    s.clock.t += 11 * 60_000; // past the resend cooldown
    expect(await resend()).toMatchObject({ sent: true });
    s.clock.t += 11 * 60_000;
    const err = await allowanceError(resend());
    expect(err.meta).toMatchObject({ requested: 1, remaining: 0 });
    expect(s.mailer.send).toHaveBeenCalledTimes(50);
  });
});

describe("invite allowance: both keys", () => {
  it("per ACTOR: the same person can't multiply reach across organisers", async () => {
    const s = setup();
    addOtherOrgEvent(s.world);
    await send(s, emails(50));

    const err = await allowanceError(
      send(s, emails(1, "elsewhere"), { eventId: OTHER_EVENT }),
    );
    expect(err.meta).toMatchObject({ remaining: 0 });
  });

  it("per OWNER: a second editor of the same org shares the org's allowance", async () => {
    const s = setup();
    s.world.memberships.set(`${INVITE_ORG_ID}:${CO_ADMIN}`, "ADMIN");
    s.world.verified.add(CO_ADMIN);
    await send(s, emails(45));

    const err = await allowanceError(
      send(s, emails(10, "co"), { actorHumanId: CO_ADMIN }),
    );
    expect(err.meta).toMatchObject({ requested: 10, remaining: 5 });
    expect(
      s.limiter.allowanceUsed(`invite-allowance:actor:${CO_ADMIN}`, INVITE_ALLOWANCE_WINDOW_SECONDS),
    ).toBe(0);
  });

  it("keys a person-owned event's allowance on the owning human", async () => {
    const s = setup({
      event: { id: PERSON_EVENT, orgId: null, humanId: INVITE_ORGANIZER_ID },
    });
    await send(s, emails(3), { eventId: PERSON_EVENT });
    expect(
      s.limiter.allowanceUsed(
        `invite-allowance:human:${INVITE_ORGANIZER_ID}`,
        INVITE_ALLOWANCE_WINDOW_SECONDS,
      ),
    ).toBe(3);
    expect(
      s.limiter.allowanceUsed(
        `invite-allowance:actor:${INVITE_ORGANIZER_ID}`,
        INVITE_ALLOWANCE_WINDOW_SECONDS,
      ),
    ).toBe(3);
  });
});

describe("invite allowance: track record (1,000 per rolling 24h)", () => {
  it.each([
    [
      "10 distinct outside holders scanned at past events",
      (w: InviteWorld) => {
        w.trackRecord.scannedHolders = 10;
      },
    ],
    [
      "a settled payout",
      (w: InviteWorld) => {
        w.trackRecord.payout = true;
      },
    ],
  ])("an owner with %s gets 1,000", async (_label, arrange) => {
    const s = setup();
    arrange(s.world);
    expect(TRACK_RECORD_DAILY_RECIPIENTS).toBe(1_000);

    await send(s, emails(500));
    await send(s, emails(500, "b"));
    const err = await allowanceError(send(s, emails(1, "c")));
    expect(err.meta).toMatchObject({ remaining: 0, limit: 1_000 });
  });

  it("9 distinct scanned holders is not a track record: 50", async () => {
    const s = setup();
    expect(MIN_DISTINCT_SCANNED_HOLDERS).toBe(10);
    s.world.trackRecord.scannedHolders = 9;
    const err = await allowanceError(send(s, emails(51)));
    expect(err.meta).toMatchObject({ limit: 50 });
  });

  it("asks the scan count for events ended a day ago, door window 6h, capped at the threshold", async () => {
    const s = setup();
    const count = vi.spyOn(
      s.world.repos.tickets,
      "countDistinctDoorScannedHolders",
    );
    await send(s, emails(1));
    expect(count).toHaveBeenCalledWith({
      owner: { orgId: INVITE_ORG_ID },
      endedBefore: new Date(
        s.clock.t - TRACK_RECORD_EVENT_SETTLE_SECONDS * 1000,
      ),
      doorLeadSeconds: TRACK_RECORD_DOOR_LEAD_SECONDS,
      cap: MIN_DISTINCT_SCANNED_HOLDERS,
    });
    expect(TRACK_RECORD_EVENT_SETTLE_SECONDS).toBe(86_400);
    expect(TRACK_RECORD_DOOR_LEAD_SECONDS).toBe(6 * 3600);
  });

  it("a settled payout short-circuits the scan count", async () => {
    const s = setup();
    s.world.trackRecord.payout = true;
    const count = vi.spyOn(
      s.world.repos.tickets,
      "countDistinctDoorScannedHolders",
    );
    await send(s, emails(1));
    expect(count).not.toHaveBeenCalled();
  });

  it("a failed track-record lookup falls back to 50 and is reported", async () => {
    const s = setup();
    s.world.trackRecord.fail = true;
    const err = await allowanceError(send(s, emails(51)));
    expect(err.meta).toMatchObject({ limit: 50 });
    expect(s.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "invite_track_record" }),
      }),
    );
  });
});

describe("invite allowance: limiter backend down", () => {
  it("fails CLOSED: SERVICE_UNAVAILABLE (retryable), nothing created or sent, logged at error", async () => {
    const s = setup();
    s.limiter.consumeAllowance = async () => {
      throw new Error("redis down");
    };
    await expect(send(s, emails(2))).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      meta: { retryable: true },
    });
    expect(s.world.invites).toHaveLength(0);
    expect(s.mailer.send).not.toHaveBeenCalled();
    expect(s.logger.error).toHaveBeenCalledWith(
      "events.createEventGuestInvites.invite_allowance_failed",
      expect.objectContaining({ eventId: INVITE_EVENT_ID }),
    );
    // Thrown, not swallowed: the transport backstop captures it.
    expect(s.reportError).not.toHaveBeenCalled();
  });

  it("a Resend fails closed too", async () => {
    const s = setup();
    await send(s, emails(1));
    s.clock.t += 11 * 60_000; // past the resend cooldown
    s.limiter.consumeAllowance = async () => {
      throw new Error("redis down");
    };
    await expect(
      resendEventGuestInvite(s.deps(), {
        eventId: INVITE_EVENT_ID,
        inviteId: s.world.invites[0]!.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(s.mailer.send).toHaveBeenCalledTimes(1);
  });
});

describe("invite allowance: refunds for mail that didn't go out", () => {
  const used = (s: ReturnType<typeof setup>, key: string) =>
    s.limiter.allowanceUsed(key, INVITE_ALLOWANCE_WINDOW_SECONDS);
  const ACTOR = `invite-allowance:actor:${INVITE_ORGANIZER_ID}`;
  const OWNER = `invite-allowance:org:${INVITE_ORG_ID}`;

  it("provider rejections are handed back to both keys", async () => {
    const s = setup();
    let n = 0;
    s.mailer.send.mockImplementation(async () => {
      n += 1;
      if (n % 3 === 0) throw new Error("provider said no");
      return { result: { id: "m", status: "queued" } };
    });
    const out = await send(s, emails(10));
    expect(out).toMatchObject({ created: 10, sent: 7, failed: 3 });
    expect(used(s, ACTOR)).toBe(7);
    expect(used(s, OWNER)).toBe(7);
  });

  it("an insert that throws refunds the whole mail share", async () => {
    const s = setup();
    (s.world.repos as { tx: unknown }).tx = async () => {
      throw new Error("db down");
    };
    await expect(send(s, emails(5))).rejects.toThrow("db down");
    expect(used(s, ACTOR)).toBe(0);
    expect(used(s, OWNER)).toBe(0);
  });

  it("a failed Resend is refunded", async () => {
    const s = setup();
    await send(s, emails(1));
    s.clock.t += 11 * 60_000; // past the resend cooldown
    s.mailer.send.mockImplementation(async () => {
      throw new Error("provider said no");
    });
    const out = await resendEventGuestInvite(s.deps(), {
      eventId: INVITE_EVENT_ID,
      inviteId: s.world.invites[0]!.id,
      actorHumanId: INVITE_ORGANIZER_ID,
    });
    expect(out).toMatchObject({ sent: false });
    expect(used(s, ACTOR)).toBe(1);
  });

  it("a refund that fails is reported and never thrown", async () => {
    const s = setup();
    s.limiter.refundAllowance = async () => {
      throw new Error("redis down on refund");
    };
    s.mailer.send.mockImplementation(async () => {
      throw new Error("provider said no");
    });
    const out = await send(s, emails(2));
    expect(out).toMatchObject({ sent: 0, failed: 2 });
    expect(s.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "redis down on refund" }),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "invite_allowance_refund" }),
      }),
    );
  });
});

describe("invite allowance: skipped recipients count (owner ruling 2026-10-07)", () => {
  const used = (s: ReturnType<typeof setup>, key: string) =>
    s.limiter.allowanceUsed(key, INVITE_ALLOWANCE_WINDOW_SECONDS);
  const ACTOR = `invite-allowance:actor:${INVITE_ORGANIZER_ID}`;
  const OWNER = `invite-allowance:org:${INVITE_ORG_ID}`;
  const ORG_OWNER = { kind: "ORG" as const, orgId: INVITE_ORG_ID };

  /** One opted-out address per kind: this organiser, stop-all, org suppression. */
  const optOutThree = (s: ReturnType<typeof setup>) => {
    s.world.optOuts.add(s.world.optOutKey(ORG_OWNER, "org-no@example.com"));
    s.world.optOuts.add(s.world.optOutAllKey("all-no@example.com"));
    s.world.suppressed.add("suppressed@example.com");
    return ["org-no@example.com", "all-no@example.com", "suppressed@example.com"];
  };

  const sendList = (s: ReturnType<typeof setup>, listId: string) =>
    createEventGuestInvites(s.deps(), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      contactListId: listId,
    });

  it("a list send charges every opted-out address, not just the ones mailed; unsubscribed and phone-only entries are free", async () => {
    const s = setup();
    const optedOut = optOutThree(s);
    const list = s.world.addList(undefined, [
      ...optedOut.map((contactEmail) => ({ contactEmail })),
      { contactEmail: "fine1@example.com" },
      { contactEmail: "fine2@example.com" },
      { contactEmail: "gone@example.com", unsubscribedAt: s.world.now },
      { contactEmail: null, contactPhone: "+15555550100" },
    ]);

    const out = await sendList(s, list.id);
    expect(out).toMatchObject({
      created: 2,
      sent: 2,
      skippedOptedOut: 3,
      skippedUnsubscribed: 1,
      skippedNoEmail: 1,
    });
    expect(s.mailer.send).toHaveBeenCalledTimes(2);
    // 2 mailed + 3 opted out. Unsubscribed is free: the organiser already
    // sees that status, so charging it hides nothing.
    expect(used(s, ACTOR)).toBe(5);
    expect(used(s, OWNER)).toBe(5);
  });

  it("a single hand-added opted-out guest costs one unit", async () => {
    const s = setup();
    s.world.optOuts.add(s.world.optOutKey(ORG_OWNER, "ana@example.com"));
    const out = await send(s, [{ name: "Ana", email: "ana@example.com" }]);
    expect(out).toMatchObject({ created: 0, sent: 0, skippedOptedOut: 1 });
    expect(s.mailer.send).not.toHaveBeenCalled();
    expect(used(s, ACTOR)).toBe(1);
    expect(used(s, OWNER)).toBe(1);
  });

  it("with nothing left, an opted-out guest gets the allowance refusal, not the opted-out answer", async () => {
    const s = setup();
    await send(s, emails(50));
    s.world.optOuts.add(s.world.optOutKey(ORG_OWNER, "ana@example.com"));
    const err = await allowanceError(
      send(s, [{ name: "Ana", email: "ana@example.com" }]),
    );
    expect(err.meta).toMatchObject({ requested: 1, remaining: 0 });
  });

  it("the over-allowance refusal counts the would-be-skipped addresses, and reads the same with or without opt-outs", async () => {
    const s = setup();
    await send(s, emails(45)); // 5 left
    const optedOut = optOutThree(s);
    const withOptOuts = s.world.addList(undefined, [
      ...optedOut.map((contactEmail) => ({ contactEmail })),
      { contactEmail: "fine1@example.com" },
      { contactEmail: "fine2@example.com" },
      { contactEmail: "fine3@example.com" },
      { contactEmail: "gone@example.com", unsubscribedAt: s.world.now },
    ]);
    // 3 opted out + 3 fine; the unsubscribed entry is not requested.
    const err = await allowanceError(sendList(s, withOptOuts.id));
    expect(err.meta).toMatchObject({ requested: 6, remaining: 5 });

    const noOptOuts = s.world.addList(
      undefined,
      emails(6, "x").map(({ email }) => ({ contactEmail: email })).concat([
        { contactEmail: "gone2@example.com", unsubscribedAt: s.world.now },
      ]),
    );
    const err2 = await allowanceError(sendList(s, noOptOuts.id));
    expect(err2.meta).toMatchObject({ requested: 6, remaining: 5 });

    // Refusals charge nothing and send nothing.
    expect(used(s, ACTOR)).toBe(45);
    expect(s.mailer.send).toHaveBeenCalledTimes(45);
  });

  it("an address already holding a live invite is free and reads as reused, opted out or not", async () => {
    const s = setup();
    await send(s, [
      { name: "Ana", email: "ana@example.com" },
      { name: "Bo", email: "bo@example.com" },
    ]);
    s.world.optOuts.add(s.world.optOutKey(ORG_OWNER, "ana@example.com"));

    const again = await send(s, [
      { name: "Ana", email: "ana@example.com" },
      { name: "Bo", email: "bo@example.com" },
    ]);
    expect(again).toMatchObject({ created: 0, reused: 2, sent: 0, skippedOptedOut: 0 });
    expect(used(s, ACTOR)).toBe(2);
  });

  it("resendExisting charges an opted-out reused invite too, and still skips it", async () => {
    const s = setup();
    await send(s, [
      { name: "Ana", email: "ana@example.com" },
      { name: "Bo", email: "bo@example.com" },
    ]);
    s.world.optOuts.add(s.world.optOutKey(ORG_OWNER, "ana@example.com"));

    const out = await send(
      s,
      [
        { name: "Ana", email: "ana@example.com" },
        { name: "Bo", email: "bo@example.com" },
      ],
      { resendExisting: true },
    );
    expect(out).toMatchObject({ reused: 1, sent: 1, skippedOptedOut: 1 });
    expect(s.mailer.send).toHaveBeenCalledTimes(3);
    expect(used(s, ACTOR)).toBe(4);
  });

  it("provider failures refund the mail share only; the skip share is kept", async () => {
    const s = setup();
    s.world.optOuts.add(s.world.optOutKey(ORG_OWNER, "ana@example.com"));
    s.mailer.send.mockImplementation(async () => {
      throw new Error("provider said no");
    });
    const out = await send(s, [
      { name: "Ana", email: "ana@example.com" },
      { name: "Bo", email: "bo@example.com" },
    ]);
    expect(out).toMatchObject({ created: 1, sent: 0, failed: 1, skippedOptedOut: 1 });
    expect(used(s, ACTOR)).toBe(1);
    expect(used(s, OWNER)).toBe(1);
  });

  it("an insert that throws refunds the mail share only; the skip share is kept", async () => {
    const s = setup();
    s.world.optOuts.add(s.world.optOutKey(ORG_OWNER, "ana@example.com"));
    (s.world.repos as { tx: unknown }).tx = async () => {
      throw new Error("db down");
    };
    await expect(
      send(s, [
        { name: "Ana", email: "ana@example.com" },
        { name: "Bo", email: "bo@example.com" },
        { name: "Cy", email: "cy@example.com" },
      ]),
    ).rejects.toThrow("db down");
    // Ana's (opted-out) unit stays: a failed insert never refunds the
    // skip share.
    expect(used(s, ACTOR)).toBe(1);
    expect(used(s, OWNER)).toBe(1);
  });

  it("a Resend whose opt-out lookup throws propagates the error and keeps nothing charged", async () => {
    const s = setup();
    await send(s, [{ name: "Ana", email: "ana@example.com" }]);
    s.clock.t += 11 * 60_000; // past the resend cooldown
    (
      s.world.repos.eventInviteOptOuts as { listOptedOut: unknown }
    ).listOptedOut = async () => {
      throw new Error("opt-out lookup down");
    };
    await expect(
      resendEventGuestInvite(s.deps(), {
        eventId: INVITE_EVENT_ID,
        inviteId: s.world.invites[0]!.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toThrow("opt-out lookup down");
    // Only the original send's unit: the resend's unit was handed back.
    expect(used(s, ACTOR)).toBe(1);
    expect(used(s, OWNER)).toBe(1);
    expect(s.mailer.send).toHaveBeenCalledTimes(1);
  });

  it("a Resend to a guest who opted out since costs one unit; with none left it is refused", async () => {
    const s = setup();
    await send(s, [{ name: "Ana", email: "ana@example.com" }]);
    s.world.optOuts.add(s.world.optOutAllKey("ana@example.com"));
    const resend = () =>
      resendEventGuestInvite(s.deps(), {
        eventId: INVITE_EVENT_ID,
        inviteId: s.world.invites[0]!.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      });

    s.clock.t += 11 * 60_000; // past the resend cooldown
    expect(await resend()).toMatchObject({ sent: false, optedOut: true });
    expect(used(s, ACTOR)).toBe(2);
    expect(s.mailer.send).toHaveBeenCalledTimes(1);

    await send(s, emails(48)); // spend the rest
    const err = await allowanceError(resend());
    expect(err.meta).toMatchObject({ requested: 1, remaining: 0 });
  });

  it("a Resend inside the cooldown is refused for free whether or not the guest opted out", async () => {
    const s = setup();
    await send(s, [
      { name: "Ana", email: "ana@example.com" },
      { name: "Bo", email: "bo@example.com" },
    ]);
    s.world.optOuts.add(s.world.optOutKey(ORG_OWNER, "ana@example.com"));
    for (const invite of s.world.invites) {
      await expect(
        resendEventGuestInvite(s.deps(), {
          eventId: INVITE_EVENT_ID,
          inviteId: invite.id,
          actorHumanId: INVITE_ORGANIZER_ID,
        }),
      ).rejects.toMatchObject({ code: "INVITE_RESEND_TOO_SOON" });
    }
    expect(used(s, ACTOR)).toBe(2);
  });
});

describe("invite allowance: new accounts (10 per rolling 24h for the first 7 days)", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const ACTOR = `invite-allowance:actor:${INVITE_ORGANIZER_ID}`;
  const OWNER = `invite-allowance:org:${INVITE_ORG_ID}`;
  const used = (s: ReturnType<typeof setup>, key: string) =>
    s.limiter.allowanceUsed(key, INVITE_ALLOWANCE_WINDOW_SECONDS);
  /** The organizer's account signed up `ageMs` before the test clock. */
  const signedUp = (s: ReturnType<typeof setup>, ageMs: number, who = INVITE_ORGANIZER_ID) =>
    s.world.accounts.createdAt.set(who, new Date(s.clock.t - ageMs));

  it("pins the ruling's numbers", () => {
    expect(NEW_ACCOUNT_DAILY_RECIPIENTS).toBe(10);
    expect(NEW_ACCOUNT_AGE_SECONDS).toBe(7 * 24 * 3600);
  });

  it("an account 6 days 23 hours old sends 10 and is refused the 11th, naming the new-account rule", async () => {
    const s = setup();
    signedUp(s, 7 * DAY - HOUR);

    expect(await send(s, emails(10))).toMatchObject({ created: 10, sent: 10 });
    const err = await allowanceError(send(s, emails(1, "late")));
    expect(err.meta).toMatchObject({
      requested: 1,
      remaining: 0,
      limit: 10,
      tier: "NEW_ACCOUNT",
    });
    expect(s.world.invites).toHaveLength(10);
    expect(s.mailer.send).toHaveBeenCalledTimes(10);
  });

  it("an account exactly 7 days old is not new: the owner's 50 applies", async () => {
    const s = setup();
    signedUp(s, 7 * DAY);

    expect(await send(s, emails(11))).toMatchObject({ sent: 11 });
    const err = await allowanceError(send(s, emails(40, "b")));
    expect(err.meta).toMatchObject({ remaining: 39, limit: 50, tier: "NEW_SENDER" });
  });

  it("what a new account sent still counts once it turns 7 days old", async () => {
    const s = setup();
    signedUp(s, 7 * DAY - HOUR);
    await send(s, emails(10));

    s.clock.t += HOUR; // now exactly 7 days old, same 24h window
    const err = await allowanceError(send(s, emails(41, "b")));
    expect(err.meta).toMatchObject({ remaining: 40, limit: 50, tier: "NEW_SENDER" });
    expect(await send(s, emails(40, "c"))).toMatchObject({ sent: 40 });
  });

  it("holds a new account to 10 even for an owner with a track record", async () => {
    const s = setup();
    s.world.trackRecord.payout = true;
    signedUp(s, DAY);

    const err = await allowanceError(send(s, emails(11)));
    expect(err.meta).toMatchObject({ remaining: 10, limit: 10, tier: "NEW_ACCOUNT" });
    expect(used(s, ACTOR)).toBe(0);
    expect(used(s, OWNER)).toBe(0);
  });

  it("smaller wins: an owner bucket with less left than the new account's names the owner's rule", async () => {
    const s = setup();
    s.world.memberships.set(`${INVITE_ORG_ID}:${CO_ADMIN}`, "ADMIN");
    s.world.verified.add(CO_ADMIN);
    signedUp(s, DAY, CO_ADMIN);
    await send(s, emails(45)); // the established organizer spends the org's 50 down to 5

    const err = await allowanceError(
      send(s, emails(6, "co"), { actorHumanId: CO_ADMIN }),
    );
    expect(err.meta).toMatchObject({ remaining: 5, limit: 50, tier: "NEW_SENDER" });
    // ...and the new account's own 10 is the cap once the owner has room.
    expect(
      await send(s, emails(5, "co"), { actorHumanId: CO_ADMIN }),
    ).toMatchObject({ sent: 5 });
    expect(used(s, `invite-allowance:actor:${CO_ADMIN}`)).toBe(5);
  });

  it("smaller wins the other way: the new account's 10 binds before a roomy owner bucket", async () => {
    const s = setup();
    s.world.memberships.set(`${INVITE_ORG_ID}:${CO_ADMIN}`, "ADMIN");
    s.world.verified.add(CO_ADMIN);
    signedUp(s, DAY, CO_ADMIN);
    await send(s, emails(20)); // owner bucket: 30 left

    const err = await allowanceError(
      send(s, emails(11, "co"), { actorHumanId: CO_ADMIN }),
    );
    expect(err.meta).toMatchObject({ remaining: 10, limit: 10, tier: "NEW_ACCOUNT" });
  });

  it("an exact tie (both buckets at 0) names the new account's rule", async () => {
    const s = setup();
    s.world.memberships.set(`${INVITE_ORG_ID}:${CO_ADMIN}`, "ADMIN");
    s.world.verified.add(CO_ADMIN);
    signedUp(s, DAY, CO_ADMIN);
    await send(s, emails(10, "co"), { actorHumanId: CO_ADMIN }); // actor 0 left
    await send(s, emails(40)); // the org's 50 spent: owner 0 left

    const err = await allowanceError(
      send(s, emails(1, "late"), { actorHumanId: CO_ADMIN }),
    );
    expect(err.meta).toMatchObject({ remaining: 0, limit: 10, tier: "NEW_ACCOUNT" });
    expect(used(s, `invite-allowance:actor:${CO_ADMIN}`)).toBe(10);
    expect(used(s, OWNER)).toBe(50);
  });

  it("counts a Resend against a new account's 10", async () => {
    const s = setup();
    signedUp(s, DAY);
    await send(s, emails(10));
    s.clock.t += 11 * 60_000; // past the resend cooldown
    const err = await allowanceError(
      resendEventGuestInvite(s.deps(), {
        eventId: INVITE_EVENT_ID,
        inviteId: s.world.invites[0]!.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    );
    expect(err.meta).toMatchObject({ remaining: 0, tier: "NEW_ACCOUNT" });
  });

  it("a failed account-age lookup counts the account as new, and is logged and reported", async () => {
    const s = setup();
    s.world.accounts.fail = true;

    const err = await allowanceError(send(s, emails(11)));
    expect(err.meta).toMatchObject({ limit: 10, tier: "NEW_ACCOUNT" });
    expect(s.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "account lookup down" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "createEventGuestInvites",
          channel: "invite_account_age",
        }),
        extra: expect.objectContaining({ actorHumanId: INVITE_ORGANIZER_ID }),
      }),
    );
    expect(s.logger.error).toHaveBeenCalledWith(
      "events.createEventGuestInvites.invite_account_age_failed",
      expect.objectContaining({ eventId: INVITE_EVENT_ID }),
    );
  });

  it("a sender who never signed in counts as new too (reported)", async () => {
    const s = setup();
    vi.spyOn(s.world.repos.humans, "getAccountCreatedAt").mockResolvedValue(null);

    const err = await allowanceError(send(s, emails(11)));
    expect(err.meta).toMatchObject({ limit: 10, tier: "NEW_ACCOUNT" });
    expect(s.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "invite sender has never signed in",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "invite_account_age" }),
      }),
    );
  });

  it("a reporter that throws changes nothing", async () => {
    const s = setup();
    s.world.accounts.fail = true;
    s.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    expect(await send(s, emails(10))).toMatchObject({ sent: 10 });
    const err = await allowanceError(send(s, emails(1, "late")));
    expect(err.meta).toMatchObject({ limit: 10, tier: "NEW_ACCOUNT" });
  });
});

describe("invite allowance: a verified email is required to send", () => {
  const used = (s: ReturnType<typeof setup>, key: string) =>
    s.limiter.allowanceUsed(key, INVITE_ALLOWANCE_WINDOW_SECONDS);

  it("refuses an unverified sender before charging or writing anything", async () => {
    const s = setup();
    s.world.verified.clear();
    const lookup = vi.spyOn(s.world.repos.humans, "getAccountCreatedAt");

    await expect(send(s, emails(3))).rejects.toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });
    expect(s.world.invites).toHaveLength(0);
    expect(s.world.audit).toHaveLength(0);
    expect(s.mailer.send).not.toHaveBeenCalled();
    expect(used(s, `invite-allowance:actor:${INVITE_ORGANIZER_ID}`)).toBe(0);
    expect(used(s, `invite-allowance:org:${INVITE_ORG_ID}`)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a Resend from a sender whose email is no longer verified", async () => {
    const s = setup();
    await send(s, emails(1));
    s.clock.t += 11 * 60_000; // past the resend cooldown
    s.world.verified.clear();

    await expect(
      resendEventGuestInvite(s.deps(), {
        eventId: INVITE_EVENT_ID,
        inviteId: s.world.invites[0]!.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(s.mailer.send).toHaveBeenCalledTimes(1);
    expect(used(s, `invite-allowance:actor:${INVITE_ORGANIZER_ID}`)).toBe(1);
  });
});
