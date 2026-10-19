import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { EventInviteRecord } from "@th/ports/repos/events";
import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_EVENT_ID,
  INVITE_OPT_OUT_SECRET,
  INVITE_ORG_ID,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  INVITE_STRANGER_ID,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import { hashInviteOptOutEmail } from "../../../../lib/security/invite-optout-token";
import {
  createEventGuestInvites,
  type CreateEventGuestInvitesDeps,
  resendEventGuestInvite,
} from "../create-event-guest-invites";
import {
  decideInvitePause,
  evaluateInviteComplaintTrip,
  getInvitePauseStatus,
  inviteComplaintWindowStart,
  listInvitePauses,
  recordInviteComplaint,
  type RecordInviteComplaintDeps,
  requestInvitePauseReview,
} from "../invite-complaint-pause";

const ORG_OWNER = { kind: "ORG", orgId: INVITE_ORG_ID } as const;
const OWNER_TAG = `org-${INVITE_ORG_ID}`;
const DAY = 86_400_000;
const STAFF_ADMIN = "60000000-0000-4000-8000-000000000006";
const STAFF_SUPPORT = "70000000-0000-4000-8000-000000000007";

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
});

function recordDeps(
  world: InviteWorld,
  extra: Partial<RecordInviteComplaintDeps> = {},
): RecordInviteComplaintDeps & { logger: ReturnType<typeof makeLogger> } {
  return {
    repos: world.repos,
    clock: world.clock,
    inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
    reportError: vi.fn(),
    ...extra,
    logger: makeLogger() as never,
  } as never;
}

let seq = 0;
const complaint = (
  email: string,
  opts: {
    id?: string;
    at?: Date;
    /** The `inviteSentAt` tag (when the complained-about mail went out). */
    sentAt?: Date;
    metadata?: Record<string, string> | null;
  } = {},
) => ({
  providerEventId: opts.id ?? `evt_${++seq}`,
  email,
  occurredAt: opts.at ?? new Date("2026-10-05T11:00:00.000Z"),
  metadata:
    opts.metadata === undefined
      ? {
          inviteOwner: OWNER_TAG,
          inviteEvent: INVITE_EVENT_ID,
          ...(opts.sentAt ? { inviteSentAt: String(opts.sentAt.getTime()) } : {}),
        }
      : opts.metadata,
});

/** `n` PERSONAL invites of the world's event, sent at `at`. */
function seedSent(world: InviteWorld, n: number, at: Date = world.now) {
  for (let i = 0; i < n; i += 1) {
    world.invites.push({
      id: randomUUID(),
      eventId: INVITE_EVENT_ID,
      kind: "PERSONAL",
      inviteeEmail: `seed${i}-${randomUUID()}@example.com`,
      inviteeName: null,
      revokedAt: null,
      sentAt: at,
    } as unknown as EventInviteRecord);
  }
}

describe("evaluateInviteComplaintTrip (D4)", () => {
  it.each([
    [0, 0, null],
    [2, 1000, null],
    [3, 1000, "COMPLAINT_COUNT"],
    [1, 100, null], // exactly 1%: not MORE than 1%
    [2, 100, "COMPLAINT_RATE"],
    [1, 50, "COMPLAINT_RATE"],
    [1, 99, "COMPLAINT_RATE"],
    [1, 0, "COMPLAINT_RATE"], // no recent sends + a complaint
    [3, 10, "COMPLAINT_COUNT"], // both hold: the count is named
  ])("%i complaints / %i recipients → %s", (complaints, recipients, want) => {
    expect(evaluateInviteComplaintTrip({ complaints, recipients })).toBe(want);
  });

  it("window starts 30 days back, or at the last lift when later", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    expect(inviteComplaintWindowStart(now, null)).toEqual(
      new Date(now.getTime() - 30 * DAY),
    );
    const lift = new Date(now.getTime() - 2 * DAY);
    expect(inviteComplaintWindowStart(now, lift)).toEqual(lift);
    const oldLift = new Date(now.getTime() - 60 * DAY);
    expect(inviteComplaintWindowStart(now, oldLift)).toEqual(
      new Date(now.getTime() - 30 * DAY),
    );
  });
});

describe("recordInviteComplaint", () => {
  it("ignores a complaint without invite metadata (not an invite): nothing written, nothing reported", async () => {
    const world = createInviteWorld();
    const deps = recordDeps(world);
    for (const metadata of [null, {}, { other: "x" }]) {
      await expect(
        recordInviteComplaint(deps, complaint("ana@example.com", { metadata })),
      ).resolves.toEqual({ outcome: "NOT_AN_INVITE" });
    }
    expect(world.pauses.complaints).toHaveLength(0);
    expect(world.optOuts.size).toBe(0);
    expect(deps.reportError).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      "invite_complaint_ignored",
      expect.objectContaining({ reason: "not_an_invite" }),
    );
  });

  it("reports a malformed owner tag and writes nothing", async () => {
    const world = createInviteWorld();
    const deps = recordDeps(world);
    for (const bad of ["org-not-a-uuid", "team-" + INVITE_ORG_ID, "org-", " "]) {
      await expect(
        recordInviteComplaint(
          deps,
          complaint("ana@example.com", { metadata: { inviteOwner: bad } }),
        ),
      ).resolves.toEqual({ outcome: "UNATTRIBUTABLE" });
    }
    expect(world.pauses.complaints).toHaveLength(0);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "recordInviteComplaint", channel: "malformed_owner_tag" },
      }),
    );
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("reports an owner that no longer exists", async () => {
    const world = createInviteWorld();
    const deps = recordDeps(world);
    const gone = "99999999-0000-4000-8000-000000000009";
    await expect(
      recordInviteComplaint(
        deps,
        complaint("ana@example.com", { metadata: { inviteOwner: `org-${gone}` } }),
      ),
    ).resolves.toEqual({ outcome: "UNATTRIBUTABLE" });
    expect(world.pauses.complaints).toHaveLength(0);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "owner_gone" }),
      }),
    );
  });

  it("a reporter that throws changes nothing", async () => {
    const world = createInviteWorld();
    const deps = recordDeps(world, {
      reportError: () => {
        throw new Error("sentry down");
      },
    });
    await expect(
      recordInviteComplaint(
        deps,
        complaint("ana@example.com", { metadata: { inviteOwner: "org-zzz" } }),
      ),
    ).resolves.toEqual({ outcome: "UNATTRIBUTABLE" });
  });

  it("records the complaint (hash only), opts the address out of the organiser (D6), no pause below the rule", async () => {
    const world = createInviteWorld();
    seedSent(world, 400);
    const out = await recordInviteComplaint(
      recordDeps(world),
      complaint("Ana@Example.com"),
    );
    expect(out).toEqual({
      outcome: "RECORDED",
      created: true,
      paused: null,
      alreadyPaused: false,
    });
    const hash = hashInviteOptOutEmail("ana@example.com", INVITE_OPT_OUT_SECRET);
    expect(world.pauses.complaints).toEqual([
      expect.objectContaining({
        owner: ORG_OWNER,
        eventId: INVITE_EVENT_ID,
        emailHash: hash,
      }),
    ]);
    expect(JSON.stringify(world.pauses.complaints)).not.toContain("ana@");
    expect(world.optOuts.has(world.optOutKey(ORG_OWNER, "ana@example.com"))).toBe(
      true,
    );
    expect(world.pauses.pauses).toHaveLength(0);
    expect(world.pauses.state.locks).toEqual([`ORG:${INVITE_ORG_ID}`]);
  });

  it("2 distinct complainants don't pause on count; the 3rd does (COMPLAINT_COUNT) and is audited", async () => {
    const world = createInviteWorld();
    seedSent(world, 1000);
    const deps = recordDeps(world);
    await recordInviteComplaint(deps, complaint("a@example.com"));
    // The same address again counts once (distinct recipients, D2).
    await recordInviteComplaint(deps, complaint("a@example.com"));
    const second = await recordInviteComplaint(deps, complaint("b@example.com"));
    expect(second).toMatchObject({ outcome: "RECORDED", paused: null });
    expect(world.pauses.pauses).toHaveLength(0);

    const third = await recordInviteComplaint(deps, complaint("c@example.com"));
    expect(third).toMatchObject({ outcome: "RECORDED", paused: "COMPLAINT_COUNT" });
    expect(world.pauses.pauses).toEqual([
      expect.objectContaining({
        owner: ORG_OWNER,
        reason: "COMPLAINT_COUNT",
        complaintCount: 3,
        recipientCount: 1000,
        pausedAt: world.now,
        liftedAt: null,
      }),
    ]);
    expect(world.audit).toContainEqual(
      expect.objectContaining({ action: "event_invites_paused" }),
    );

    // A 4th lands on the open pause: no second pause.
    const fourth = await recordInviteComplaint(deps, complaint("d@example.com"));
    expect(fourth).toMatchObject({ paused: null, alreadyPaused: true });
    expect(world.pauses.pauses).toHaveLength(1);
  });

  it.each([
    [100, 1, false],
    [199, 2, true],
    [200, 2, false],
    [100, 2, true],
    [50, 1, true],
    [0, 1, true],
  ])("rate: %i recipients, %i complaints → pause %s", async (sent, n, pauses) => {
    const world = createInviteWorld();
    seedSent(world, sent);
    const deps = recordDeps(world);
    for (let i = 0; i < n; i += 1) {
      await recordInviteComplaint(deps, complaint(`r${i}@example.com`));
    }
    expect(world.pauses.pauses.length > 0).toBe(pauses);
    if (pauses) expect(world.pauses.pauses[0]!.reason).toBe("COMPLAINT_RATE");
  });

  it("only sends inside the window count as recipients", async () => {
    const world = createInviteWorld();
    seedSent(world, 1000, new Date(world.now.getTime() - 31 * DAY));
    seedSent(world, 50);
    await recordInviteComplaint(recordDeps(world), complaint("a@example.com"));
    // 1 / 50 → rate trip; the 1000 old sends don't dilute it.
    expect(world.pauses.pauses[0]).toMatchObject({
      reason: "COMPLAINT_RATE",
      recipientCount: 50,
    });
  });

  it("a webhook replay is a no-op: one complaint row, no double count", async () => {
    const world = createInviteWorld();
    seedSent(world, 1000);
    const deps = recordDeps(world);
    const first = await recordInviteComplaint(deps, complaint("a@example.com", { id: "evt_same" }));
    const replay = await recordInviteComplaint(deps, complaint("a@example.com", { id: "evt_same" }));
    expect(first).toMatchObject({ created: true });
    expect(replay).toMatchObject({ outcome: "RECORDED", created: false, paused: null });
    expect(world.pauses.complaints).toHaveLength(1);
  });

  it("complaints older than 30 days, or from before the last lift, don't count", async () => {
    const world = createInviteWorld();
    seedSent(world, 1000);
    const deps = recordDeps(world);
    await recordInviteComplaint(
      deps,
      complaint("old@example.com", { at: new Date(world.now.getTime() - 31 * DAY) }),
    );
    world.pauses.seedPause(ORG_OWNER, {
      pausedAt: new Date(world.now.getTime() - 5 * DAY),
      decision: "LIFTED",
      decidedAt: new Date(world.now.getTime() - 2 * DAY),
      liftedAt: new Date(world.now.getTime() - 2 * DAY),
    });
    // Two complaints before the lift, one after: only one counts.
    await recordInviteComplaint(
      deps,
      complaint("x@example.com", { at: new Date(world.now.getTime() - 3 * DAY) }),
    );
    await recordInviteComplaint(
      deps,
      complaint("y@example.com", { at: new Date(world.now.getTime() - 3 * DAY) }),
    );
    const out = await recordInviteComplaint(deps, complaint("z@example.com"));
    expect(out).toMatchObject({ paused: null });
    expect(world.pauses.pauses.filter((p) => !p.liftedAt)).toHaveLength(0);
  });

  it("drops an event tag that belongs to another organiser", async () => {
    const world = createInviteWorld();
    seedSent(world, 1000);
    const otherEvent = "88888888-0000-4000-8000-000000000008";
    world.events.set(otherEvent, {
      ...world.event,
      id: otherEvent,
      orgId: "77777777-0000-4000-8000-000000000007",
    });
    await recordInviteComplaint(
      recordDeps(world),
      complaint("a@example.com", {
        metadata: { inviteOwner: OWNER_TAG, inviteEvent: otherEvent },
      }),
    );
    expect(world.pauses.complaints[0]!.eventId).toBeNull();
  });

  it("a TRANSIENT DB failure throws, so the webhook 500s and Svix retries; not reported as a swallow", async () => {
    const world = createInviteWorld();
    world.pauses.state.failRecord = new Error("connection reset");
    const deps = recordDeps(world);
    await expect(
      recordInviteComplaint(deps, complaint("a@example.com")),
    ).rejects.toThrow("connection reset");
    expect(deps.reportError).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      "events.recordInviteComplaint.record_failed_retryable",
      expect.any(Object),
    );
    // The retry succeeds once the DB is back.
    world.pauses.state.failRecord = null;
    await expect(
      recordInviteComplaint(deps, complaint("a@example.com", { id: "evt_retry" })),
    ).resolves.toMatchObject({ outcome: "RECORDED" });
  });

  it.each([
    ["a P2004 constraint error", Object.assign(new Error("constraint"), { code: "P2004" })],
    [
      "a CHECK violation nested in driver-adapter meta",
      Object.assign(new Error("db error"), {
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "23514" } } },
      }),
    ],
  ])("%s can't be fixed by a retry: FAILED, reported, not thrown", async (_label, err) => {
    const world = createInviteWorld();
    world.pauses.state.failRecord = err;
    const deps = recordDeps(world);
    await expect(
      recordInviteComplaint(deps, complaint("a@example.com")),
    ).resolves.toEqual({ outcome: "FAILED" });
    expect(deps.reportError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ channel: "record_failed" }),
      }),
    );
  });

  it("a P2003 FK miss (event or owner deleted mid-flight) is RETRIED: rethrown, not swallowed", async () => {
    const world = createInviteWorld();
    const fk = Object.assign(new Error("fk"), { code: "P2003" });
    world.pauses.state.failRecord = fk;
    const deps = recordDeps(world);
    await expect(
      recordInviteComplaint(deps, complaint("a@example.com")),
    ).rejects.toBe(fk);
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("a too-short hashing secret is treated as not configured: FAILED and reported", async () => {
    const world = createInviteWorld();
    const deps = recordDeps(world, { inviteOptOutSecret: "short" });
    await expect(
      recordInviteComplaint(deps, complaint("a@example.com")),
    ).resolves.toEqual({ outcome: "FAILED" });
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ channel: "not_configured" }) }),
    );
  });

  it("a malformed sentAt tag falls back to the complaint's own time", async () => {
    const world = createInviteWorld();
    seedSent(world, 1000);
    for (const bad of ["soon", "-5", "1e12", String(Date.UTC(2010, 0, 1))]) {
      await recordInviteComplaint(
        recordDeps(world),
        complaint(`${bad.length}-${randomUUID()}@example.com`, {
          metadata: { inviteOwner: OWNER_TAG, inviteSentAt: bad },
        }),
      );
    }
    expect(world.pauses.complaints.every((c) => c.sentAt === null)).toBe(true);
  });

  it("counts DISTINCT recipients: one guest invited to two events is one", async () => {
    const world = createInviteWorld();
    const second = "88888888-0000-4000-8000-0000000000aa";
    world.events.set(second, { ...world.event, id: second });
    for (const eventId of [INVITE_EVENT_ID, second]) {
      for (let i = 0; i < 100; i += 1) {
        world.invites.push({
          id: randomUUID(),
          eventId,
          kind: "PERSONAL",
          inviteeEmail: `guest${i}@example.com`,
          sentAt: world.now,
        } as unknown as EventInviteRecord);
      }
    }
    // 200 invite rows but 100 people: 2 / 100 > 1% trips (2 / 200 would not).
    const deps = recordDeps(world);
    await recordInviteComplaint(deps, complaint("guest1@example.com"));
    const out = await recordInviteComplaint(deps, complaint("guest2@example.com"));
    expect(out).toMatchObject({ paused: "COMPLAINT_RATE" });
    expect(world.pauses.pauses[0]).toMatchObject({ recipientCount: 100 });
  });

  it("a REAL resend moves an old invite's send into the window (it counts again)", async () => {
    const world = createInviteWorld();
    const old = new Date(world.now.getTime() - 40 * DAY);
    const first = sendDeps(world);
    first.deps.clock = { now: () => old };
    await createEventGuestInvites(first.deps, {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: Array.from({ length: 60 }, (_, i) => ({
        name: `Guest ${i}`,
        email: `g${i}@example.com`,
      })),
    });
    expect(world.invites.every((i) => i.sentAt?.getTime() === old.getTime())).toBe(true);

    // Resend 20 of them now: only those are back inside the 30-day window.
    const now = sendDeps(world);
    for (const invite of world.invites.slice(0, 20)) {
      await resendEventGuestInvite(now.deps, {
        eventId: INVITE_EVENT_ID,
        inviteId: invite.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      });
    }
    const out = await recordInviteComplaint(
      recordDeps(world),
      complaint("g0@example.com", { sentAt: world.now }),
    );
    // 1 / 20 > 1%: the pause snapshot shows the 20 resent recipients.
    expect(out).toMatchObject({ paused: "COMPLAINT_RATE" });
    expect(world.pauses.pauses[0]).toMatchObject({ recipientCount: 20 });
  });

  it("without the hashing secret: FAILED and reported", async () => {
    const world = createInviteWorld();
    const deps = recordDeps(world, { inviteOptOutSecret: null });
    await expect(
      recordInviteComplaint(deps, complaint("a@example.com")),
    ).resolves.toEqual({ outcome: "FAILED" });
    expect(deps.reportError).toHaveBeenCalled();
  });
});

// ─── Send-time refusal ───────────────────────────────────────────────────

const makeMailer = () =>
  ({
    send: vi.fn(async () => ({ result: { id: "m", status: "queued" } })),
    sendBatch: vi.fn(),
    health: vi.fn(),
  }) as unknown as MailerPort & { send: ReturnType<typeof vi.fn> };

function sendDeps(world: InviteWorld, mailer = makeMailer()) {
  const rateLimit = {
    consumeAllowance: vi.fn(async () => ({
      allowed: true,
      results: [{ remaining: 100, retryAfterSeconds: 0 }],
    })),
    refundAllowance: vi.fn(async () => {}),
  };
  const deps: CreateEventGuestInvitesDeps = {
    repos: world.repos,
    clock: world.clock,
    inviteTokenSecret: INVITE_SECRET,
    appBaseUrl: INVITE_APP_BASE_URL,
    inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
    mailer,
    logger: makeLogger() as unknown as LoggerPort,
    rateLimit: rateLimit as never,
  };
  return { deps, mailer, rateLimit };
}

describe("paused organisers send no invite email (D5)", () => {
  it("create is refused with INVITES_PAUSED before any charge, row or mail", async () => {
    const world = createInviteWorld();
    world.pauses.seedPause(ORG_OWNER);
    const { deps, mailer, rateLimit } = sendDeps(world);
    await expect(
      createEventGuestInvites(deps, {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: [{ name: "Ana", email: "ana@example.com" }],
      }),
    ).rejects.toMatchObject({
      code: "INVITES_PAUSED",
      meta: {
        reason: "COMPLAINT_COUNT",
        pausedAt: "2026-10-01T12:00:00.000Z",
        reviewRequestedAt: null,
      },
    });
    expect(rateLimit.consumeAllowance).not.toHaveBeenCalled();
    expect(world.invites).toHaveLength(0);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("resend is refused too, before the charge", async () => {
    const world = createInviteWorld();
    const { deps, rateLimit } = sendDeps(world);
    await createEventGuestInvites(deps, {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    rateLimit.consumeAllowance.mockClear();
    world.pauses.seedPause(ORG_OWNER);
    const later = sendDeps(world);
    later.deps.clock = { now: () => new Date(world.now.getTime() + DAY) };
    await expect(
      resendEventGuestInvite(later.deps, {
        eventId: INVITE_EVENT_ID,
        inviteId: world.invites[0]!.id,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toMatchObject({ code: "INVITES_PAUSED" });
    expect(later.rateLimit.consumeAllowance).not.toHaveBeenCalled();
    expect(later.mailer.send).not.toHaveBeenCalled();
  });

  it("a failed pause lookup fails CLOSED (SERVICE_UNAVAILABLE), nothing sent", async () => {
    const world = createInviteWorld();
    world.pauses.state.failGetOpen = true;
    const { deps, mailer, rateLimit } = sendDeps(world);
    await expect(
      createEventGuestInvites(deps, {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: [{ name: "Ana", email: "ana@example.com" }],
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", meta: { retryable: true } });
    expect(rateLimit.consumeAllowance).not.toHaveBeenCalled();
    expect(world.invites).toHaveLength(0);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("a LIFTED pause no longer blocks", async () => {
    const world = createInviteWorld();
    world.pauses.seedPause(ORG_OWNER, {
      decision: "LIFTED",
      decidedAt: world.now,
      liftedAt: world.now,
    });
    const { deps, mailer } = sendDeps(world);
    await expect(
      createEventGuestInvites(deps, {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: [{ name: "Ana", email: "ana@example.com" }],
      }),
    ).resolves.toMatchObject({ sent: 1 });
    expect(mailer.send).toHaveBeenCalledOnce();
  });
});

// ─── Organiser status + review request ───────────────────────────────────

const organiserDeps = (world: InviteWorld) => ({
  repos: world.repos,
  clock: world.clock,
  logger: makeLogger() as unknown as LoggerPort,
});

describe("getInvitePauseStatus / requestInvitePauseReview (D7)", () => {
  it("not paused: a plain answer", async () => {
    const world = createInviteWorld();
    await expect(
      getInvitePauseStatus(organiserDeps(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).resolves.toEqual({ paused: false, pause: null, lastDecision: null });
  });

  it("paused: why, when, the counts; never an address or hash", async () => {
    const world = createInviteWorld();
    seedSent(world, 1000);
    const deps = recordDeps(world);
    for (const e of ["a@example.com", "b@example.com", "c@example.com"]) {
      await recordInviteComplaint(deps, complaint(e));
    }
    const status = await getInvitePauseStatus(organiserDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
    });
    expect(status).toEqual({
      paused: true,
      pause: {
        reason: "COMPLAINT_COUNT",
        pausedAt: world.now,
        complaintCount: 3,
        recipientCount: 1000,
        windowDays: 30,
        reviewRequestedAt: null,
        reviewRequestNote: null,
        canRequestReview: true,
      },
      lastDecision: null,
    });
    const json = JSON.stringify(status);
    expect(json).not.toContain("@example.com");
    for (const c of world.pauses.complaints) expect(json).not.toContain(c.emailHash);
  });

  it("someone without edit rights on the event can't read or ask", async () => {
    const world = createInviteWorld();
    world.pauses.seedPause(ORG_OWNER);
    await expect(
      getInvitePauseStatus(organiserDeps(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_STRANGER_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      requestInvitePauseReview(organiserDeps(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_STRANGER_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("one waiting request; a sanitized note; not paused is INVALID_STATUS", async () => {
    const world = createInviteWorld();
    await expect(
      requestInvitePauseReview(organiserDeps(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });

    world.pauses.seedPause(ORG_OWNER);
    const status = await requestInvitePauseReview(organiserDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      note: "  These are <b>our</b> regulars  ",
    });
    expect(status.pause).toMatchObject({
      reviewRequestedAt: world.now,
      canRequestReview: false,
    });
    expect(status.pause?.reviewRequestNote).not.toContain("<b>");
    expect(world.audit).toContainEqual(
      expect.objectContaining({ action: "event_invite_pause_review_requested" }),
    );

    await expect(
      requestInvitePauseReview(organiserDeps(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an over-long note and unknown fields", async () => {
    const world = createInviteWorld();
    world.pauses.seedPause(ORG_OWNER);
    await expect(
      requestInvitePauseReview(organiserDeps(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        note: "x".repeat(1001),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      requestInvitePauseReview(organiserDeps(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        pauseId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ─── Staff queue + decisions ─────────────────────────────────────────────

function staffDeps(world: InviteWorld) {
  const roles = new Map<string, string>([
    [STAFF_ADMIN, "ADMIN"],
    [STAFF_SUPPORT, "SUPPORT"],
  ]);
  return {
    repos: world.repos,
    clock: world.clock,
    logger: makeLogger() as unknown as LoggerPort,
    authz: {
      hasStaffRole: vi.fn(
        async (input: { actorHumanId: string; requiredRoles: string[] }) => ({
          allowed: input.requiredRoles.includes(roles.get(input.actorHumanId) ?? ""),
        }),
      ),
    },
  };
}

describe("listInvitePauses / decideInvitePause", () => {
  it("non-staff can't list or decide; SUPPORT can list but not decide", async () => {
    const world = createInviteWorld();
    const pause = world.pauses.seedPause(ORG_OWNER, { reviewRequestedAt: world.now });
    const deps = staffDeps(world);
    await expect(
      listInvitePauses(deps, { actorHumanId: INVITE_ORGANIZER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    await expect(
      decideInvitePause(deps, {
        actorHumanId: INVITE_ORGANIZER_ID,
        pauseId: pause.id,
        decision: "LIFTED",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    const listed = await listInvitePauses(deps, { actorHumanId: STAFF_SUPPORT });
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: pause.id,
        ownerKind: "ORG",
        ownerId: INVITE_ORG_ID,
        reviewRequestedAt: world.now,
      }),
    ]);
    await expect(
      decideInvitePause(deps, {
        actorHumanId: STAFF_SUPPORT,
        pauseId: pause.id,
        decision: "LIFTED",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("KEEP needs a note, clears the request so the organiser can ask again, and shows them the note", async () => {
    const world = createInviteWorld();
    const pause = world.pauses.seedPause(ORG_OWNER, { reviewRequestedAt: world.now });
    const deps = staffDeps(world);
    await expect(
      decideInvitePause(deps, {
        actorHumanId: STAFF_ADMIN,
        pauseId: pause.id,
        decision: "KEPT",
        note: "   ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const kept = await decideInvitePause(deps, {
      actorHumanId: STAFF_ADMIN,
      pauseId: pause.id,
      decision: "KEPT",
      note: "Your list includes addresses that never signed up.",
    });
    expect(kept.pause).toMatchObject({
      decision: "KEPT",
      decidedByHumanId: STAFF_ADMIN,
      reviewRequestedAt: null,
      liftedAt: null,
    });

    const status = await getInvitePauseStatus(organiserDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
    });
    expect(status).toMatchObject({
      paused: true,
      pause: { canRequestReview: true },
      lastDecision: {
        decision: "KEPT",
        note: "Your list includes addresses that never signed up.",
      },
    });
    await expect(
      requestInvitePauseReview(organiserDeps(world), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
      }),
    ).resolves.toMatchObject({ pause: { canRequestReview: false } });
  });

  it("LIFT resumes invites, restarts the window, and can't be repeated", async () => {
    const world = createInviteWorld();
    seedSent(world, 1000);
    const rdeps = recordDeps(world);
    for (const e of ["a@example.com", "b@example.com", "c@example.com"]) {
      await recordInviteComplaint(rdeps, complaint(e));
    }
    const pause = world.pauses.pauses[0]!;
    const later = new Date(world.now.getTime() + DAY);
    const deps = { ...staffDeps(world), clock: { now: () => later } };
    const lifted = await decideInvitePause(deps, {
      actorHumanId: STAFF_ADMIN,
      pauseId: pause.id,
      decision: "LIFTED",
    });
    expect(lifted.pause).toMatchObject({ decision: "LIFTED", liftedAt: later });
    expect(world.audit).toContainEqual(
      expect.objectContaining({ action: "event_invite_pause_lifted" }),
    );

    await expect(
      decideInvitePause(deps, {
        actorHumanId: STAFF_ADMIN,
        pauseId: pause.id,
        decision: "KEPT",
        note: "late",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });

    // The lift restarts BOTH counts (D3, brief: "same window"). With 1000
    // fresh sends after it, one complaint is 0.1%: the three before the lift
    // no longer count, so no pause.
    seedSent(world, 1000, later);
    const out = await recordInviteComplaint(
      { ...recordDeps(world), clock: { now: () => later } },
      complaint("d@example.com", { at: later }),
    );
    expect(out).toMatchObject({ outcome: "RECORDED", paused: null, alreadyPaused: false });

    const status = await getInvitePauseStatus(organiserDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
    });
    expect(status).toMatchObject({
      paused: false,
      lastDecision: { decision: "LIFTED" },
    });
  });

  it("a lift holds: a LATE complaint about mail sent before the lift does not re-pause", async () => {
    const world = createInviteWorld();
    const sentBefore = new Date(world.now.getTime() - 2 * DAY);
    seedSent(world, 1000, sentBefore);
    const lift = new Date(world.now.getTime() - DAY);
    world.pauses.seedPause(ORG_OWNER, {
      decision: "LIFTED",
      decidedAt: lift,
      liftedAt: lift,
    });
    // Complained today about mail sent before the lift.
    const out = await recordInviteComplaint(
      recordDeps(world),
      complaint("a@example.com", { at: world.now, sentAt: sentBefore }),
    );
    expect(out).toMatchObject({ outcome: "RECORDED", paused: null, alreadyPaused: false });
    expect(world.pauses.pauses.filter((p) => !p.liftedAt)).toHaveLength(0);
  });

  it("after a lift, a complaint about mail sent AFTER it still counts", async () => {
    const world = createInviteWorld();
    const lift = new Date(world.now.getTime() - DAY);
    world.pauses.seedPause(ORG_OWNER, {
      decision: "LIFTED",
      decidedAt: lift,
      liftedAt: lift,
    });
    const sentAfter = new Date(world.now.getTime() - 12 * 3_600_000);
    seedSent(world, 50, sentAfter);
    const out = await recordInviteComplaint(
      recordDeps(world),
      complaint("a@example.com", { at: world.now, sentAt: sentAfter }),
    );
    // 1 / 50 > 1%.
    expect(out).toMatchObject({ paused: "COMPLAINT_RATE" });
    expect(world.pauses.pauses.find((p) => !p.liftedAt)).toMatchObject({
      complaintCount: 1,
      recipientCount: 50,
    });
  });

  it("KEEP writes the cleared request note and the decision note to the audit log; decide names the organiser", async () => {
    const world = createInviteWorld();
    const pause = world.pauses.seedPause(ORG_OWNER, {
      reviewRequestedAt: world.now,
      reviewRequestNote: "These are our regulars",
    });
    const out = await decideInvitePause(staffDeps(world), {
      actorHumanId: STAFF_ADMIN,
      pauseId: pause.id,
      decision: "KEPT",
      note: "Not yet.",
    });
    expect(out.pause.ownerName).toBe("Stub Collective");
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        action: "event_invite_pause_kept",
        data: expect.objectContaining({
          decisionNote: "Not yet.",
          clearedReviewRequestNote: "These are our regulars",
          clearedReviewRequestedAt: world.now.toISOString(),
        }),
      }),
    );
  });

  it("an unknown pause is NOT_FOUND", async () => {
    const world = createInviteWorld();
    await expect(
      decideInvitePause(staffDeps(world), {
        actorHumanId: STAFF_ADMIN,
        pauseId: randomUUID(),
        decision: "LIFTED",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
