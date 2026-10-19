import { describe, expect, it, vi, type Mock } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { EventDateRecord } from "@th/ports/repos/event-dates";
import type { NotificationPreferenceSnapshot } from "@th/ports/repos/notification-preferences";
import type {
  RsvpReminderCandidate,
  RsvpReminderChannel,
} from "@th/ports/repos/rsvp-reminders";
import type { NotifyOutput } from "../../comms/notify";
import type {
  EmailResult,
  InAppResult,
  PushResult,
  SmsResult,
} from "../../comms/shared";

import { renderNotification } from "../../comms/renderers";
import {
  sendRsvpReminders,
  type SendRsvpRemindersDeps,
} from "../send-rsvp-reminders";
import { EVENT_ID, USER_ID, makeCommunityEvent } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
//
// EVERY instant here is expressed so the wall clock in America/Chicago is
// meaningful, and the event fixture's timezone IS America/Chicago (CDT, UTC-5
// in August). A UTC-only fixture would pass even if the renderer leaked the
// server's zone, which is exactly the bug class this has to catch.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Chicago";

/** 2026-08-17 15:00 CDT — exactly 24h before the date below. */
const NOW = new Date("2026-08-17T20:00:00.000Z");
/** 2026-08-18 15:00 CDT. */
const DATE_STARTS_AT = new Date("2026-08-18T20:00:00.000Z");
const DATE_ENDS_AT = new Date("2026-08-18T22:30:00.000Z");
/** RSVP'd five weeks out — the case the feature exists for. */
const RSVP_CREATED_AT = new Date("2026-07-13T18:00:00.000Z");

const DATE_ID = "dddddddd-1111-4111-8111-dddddddddddd";
const OTHER_DATE_ID = "dddddddd-2222-4222-8222-dddddddddddd";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** One human per disposition, for the counter-completeness invariant. */
const HUMAN_SETTLED = "cccccccc-1111-4111-8111-cccccccccccc";
const HUMAN_LATE_RSVP = "cccccccc-2222-4222-8222-cccccccccccc";
const HUMAN_MUTED = "cccccccc-3333-4333-8333-cccccccccccc";
const HUMAN_DECLINED = "cccccccc-4444-4444-8444-cccccccccccc";
const HUMAN_FAILED = "cccccccc-5555-4555-8555-cccccccccccc";

const EVENT_SLUG = "event/us/austin/weekly-open-mic-2026-08-01-2000--abc123";

function makeCandidate(
  overrides: Partial<RsvpReminderCandidate> = {},
): RsvpReminderCandidate {
  return {
    eventDateId: DATE_ID,
    eventId: EVENT_ID,
    humanId: USER_ID,
    rsvpCreatedAt: RSVP_CREATED_AT,
    startsAt: DATE_STARTS_AT,
    endsAt: DATE_ENDS_AT,
    settledChannels: [],
    ...overrides,
  };
}

function makeEventDate(
  overrides: Partial<EventDateRecord> = {},
): EventDateRecord {
  return {
    id: DATE_ID,
    eventId: EVENT_ID,
    ordinal: 1,
    status: "SCHEDULED",
    startsAt: DATE_STARTS_AT,
    endsAt: DATE_ENDS_AT,
    ...overrides,
  } as EventDateRecord;
}

const ALL_ON: NotificationPreferenceSnapshot = {
  in_app: {
    transactional: true,
    announcements: true,
    reminders: true,
    marketing: true,
    organizerMessages: true,
  },
  push: {
    transactional: true,
    announcements: true,
    reminders: true,
    marketing: true,
    organizerMessages: true,
  },
  email: {
    transactional: true,
    announcements: true,
    reminders: true,
    marketing: true,
    organizerMessages: true,
    frequency: "INSTANT",
  },
  sms: {
    transactional: false,
    announcements: false,
    reminders: false,
    marketing: false,
    organizerMessages: false,
  },
};

function withRemindersOff(
  base: NotificationPreferenceSnapshot = ALL_ON,
): NotificationPreferenceSnapshot {
  const next = JSON.parse(
    JSON.stringify(base),
  ) as NotificationPreferenceSnapshot;
  for (const channel of ["in_app", "push", "email", "sms"] as const) {
    const snapshot = next[channel];
    if (snapshot) snapshot.reminders = false;
  }
  return next;
}

/**
 * Only the EMAIL channel is on. The point of the fixture: an attendee whose
 * only reminder channel is email is the one who gets NOTHING when the mailer
 * is down — and `notify` reports a dead mailer by RETURNING a failure, never
 * by throwing.
 */
function emailOnly(): NotificationPreferenceSnapshot {
  const next = JSON.parse(
    JSON.stringify(ALL_ON),
  ) as NotificationPreferenceSnapshot;
  for (const channel of ["in_app", "push", "sms"] as const) {
    const snapshot = next[channel];
    if (snapshot) snapshot.reminders = false;
  }
  return next;
}

// ── notify results ───────────────────────────────────────────────────────────

/**
 * Typed against the REAL channel result unions, with NO cast anywhere on this
 * path.
 *
 * That is the point of it. The previous version widened everything with
 * `as ChannelResults` / `as NotifyOutput`, and under that cast two fixtures
 * asserted reasons the product cannot emit — `preference_disabled` (the real
 * one is `channel_disabled`) and `no_device` (the real one is `no_devices`).
 * Since no tsconfig in this repo typechecks test files and vitest only
 * transpiles, nothing anywhere caught it: the tests were green against
 * behaviour that does not exist. Typed this way, an invented reason is a
 * compile error — but only to a checker that is actually pointed at this file,
 * which no CI job is. To run one:
 *
 *   cat > tsconfig.scratch.json <<'JSON'
 *   { "extends": "./tsconfig.base.json",
 *     "compilerOptions": { "types": ["node"] },
 *     "files": ["packages/core/src/use-cases/community/__tests__/send-rsvp-reminders.test.ts"],
 *     "exclude": [] }
 *   JSON
 *   pnpm exec tsc -p tsconfig.scratch.json --noEmit
 *
 * That run is clean as of this commit, and rejects `preference_disabled`,
 * `no_device`, a `persisted` in-app result with no `createdAt`, and a `sent`
 * push result with no `deviceCount` — all four of which used to live here.
 */
type ChannelResults = {
  inApp?: InAppResult;
  push?: PushResult;
  email?: EmailResult;
  sms?: SmsResult;
};

/**
 * A realistic `notify` return. Defaults to "every channel delivered"; override
 * one channel to model a partial outcome. Modelling the RESULT rather than a
 * thrown error is the whole point — `sendEmail` catches a mailer
 * `success: false` (and a thrown `CommsPortError`) and RETURNS
 * `{ status: "failed", reason: "port_error" }`.
 */
function notifyOutput(overrides: ChannelResults = {}): NotifyOutput {
  // Resolved per channel rather than by spreading over defaults: a spread
  // widens each property to a union and TypeScript then stops checking the
  // default against its own variant, which is how `preference_disabled` and
  // `no_device` survived in here. This way every literal below is checked.
  const inApp: InAppResult = overrides.inApp ?? {
    status: "persisted",
    notificationId: "n-1",
    createdAt: NOW,
  };
  // `deviceCount` is REQUIRED on a successful push — `{ status: "sent" }`
  // alone is another shape the product cannot emit.
  const push: PushResult = overrides.push ?? { status: "sent", deviceCount: 1 };
  const email: EmailResult = overrides.email ?? { status: "sent" };
  // SMS defaults OFF for the `reminders` category, so notify's own gate
  // declines it. `channel_disabled` — NOT `preference_disabled`, which is not
  // a member of `smsResultSchema`'s reason enum.
  const sms: SmsResult = overrides.sms ?? {
    status: "skipped",
    reason: "channel_disabled",
  };

  return {
    ok: true,
    variant: "rsvp.reminder",
    category: "reminders",
    scope: { kind: "EVENT", eventId: EVENT_ID },
    inApp,
    push,
    email,
    sms,
  };
}

const EMAIL_FAILED = notifyOutput({
  email: { status: "failed", reason: "port_error" },
});

/**
 * The finding this file exists to pin: `notify` returns `port_unavailable`
 * when the mailer is simply absent from ITS deps (`send-email.ts`). That is
 * infrastructure, not the recipient, so it must RELEASE the claim — settling
 * it would stamp `sentAt` and take the reminder out of the due set forever
 * over an unset env var.
 */
const EMAIL_PORT_UNAVAILABLE = notifyOutput({
  email: { status: "skipped", reason: "port_unavailable" },
});

/** A decline about the RECIPIENT: no email identity. Settles for good. */
const EMAIL_NO_RECIPIENT = notifyOutput({
  email: { status: "skipped", reason: "no_recipient" },
});

// ── ledger ───────────────────────────────────────────────────────────────────

type LedgerRow = { claimedAt: Date; sentAt: Date | null };

/**
 * In-memory stand-in for the `RsvpReminder` ledger, honouring the SAME rules
 * the DB enforces: one row per (subject × human × CHANNEL) — the subject being
 * the eventDateId for a per-date reminder and the eventId for an event-level
 * one — a settled row is never re-claimable, and an in-flight one is
 * re-claimable only once its claim goes stale. Without that fidelity a
 * double-run test would pass against a fake that cannot lose a race.
 */
function makeLedger() {
  const rows = new Map<string, LedgerRow>();
  const subjectOf = (input: {
    eventDateId: string | null;
    eventId: string;
  }) => input.eventDateId ?? `event:${input.eventId}`;
  const keyOf = (
    input: { eventDateId: string | null; eventId: string; humanId: string },
    channel: string,
  ) => `${subjectOf(input)}|${input.humanId}|${channel}`;

  const rowsFor = (predicate: (row: LedgerRow) => boolean) =>
    [...rows.entries()].filter(([, row]) => predicate(row)).map(([key]) => key);

  return {
    rows,
    keyOf,
    /** Keys a tick currently owns or that still owe a send. */
    unsettled: () => rowsFor((row) => row.sentAt === null),
    /** Keys that will never be sent again. */
    settled: () => rowsFor((row) => row.sentAt !== null),
    /** Channels settled for one (subject × human) — what `findDue` reports. */
    settledChannels: (input: {
      eventDateId: string | null;
      eventId: string;
      humanId: string;
    }): RsvpReminderChannel[] =>
      (["in_app", "push", "email", "sms"] as const).filter(
        (channel) => rows.get(keyOf(input, channel))?.sentAt != null,
      ),
    claim: vi.fn(
      async (input: {
        eventDateId: string | null;
        eventId: string;
        humanId: string;
        channels: RsvpReminderChannel[];
        now: Date;
        staleClaimBefore: Date;
      }) => {
        const won: RsvpReminderChannel[] = [];
        for (const channel of input.channels) {
          const key = keyOf(input, channel);
          const row = rows.get(key);
          if (!row) {
            rows.set(key, { claimedAt: input.now, sentAt: null });
            won.push(channel);
            continue;
          }
          // Settled, or another tick is holding a fresh claim.
          if (row.sentAt !== null) continue;
          if (row.claimedAt.getTime() >= input.staleClaimBefore.getTime()) {
            continue;
          }
          row.claimedAt = input.now;
          won.push(channel);
        }
        return won;
      },
    ),
    markSent: vi.fn(
      async (input: {
        eventDateId: string | null;
        eventId: string;
        humanId: string;
        channels: RsvpReminderChannel[];
        sentAt: Date;
      }) => {
        for (const channel of input.channels) {
          const row = rows.get(keyOf(input, channel));
          if (row && row.sentAt === null) row.sentAt = input.sentAt;
        }
      },
    ),
    release: vi.fn(
      async (input: {
        eventDateId: string | null;
        eventId: string;
        humanId: string;
        channels: RsvpReminderChannel[];
      }) => {
        for (const channel of input.channels) {
          const row = rows.get(keyOf(input, channel));
          // Mirrors the adapter: the row survives (it records an unpaid debt)
          // and is pushed back to the epoch so the next tick retakes it.
          if (row && row.sentAt === null) row.claimedAt = new Date(0);
        }
      },
    ),
  };
}

function createDeps(args: {
  candidates: RsvpReminderCandidate[];
  event?: ReturnType<typeof makeCommunityEvent> | null;
  eventDate?: EventDateRecord | null;
  /**
   * Per-id occurrences, for a MIXED batch — one night called off while the
   * listing's other nights are still on. Takes precedence over `eventDate`.
   */
  eventDatesById?: Record<string, EventDateRecord | null>;
  rsvpExists?: boolean;
  globalPrefs?: NotificationPreferenceSnapshot;
  eventPrefs?: NotificationPreferenceSnapshot;
  /** Overrides `globalPrefs`/`eventPrefs` for specific people in one batch. */
  prefsByHuman?: Record<string, NotificationPreferenceSnapshot>;
  prefsThrow?: boolean;
  notify?: SendRsvpRemindersDeps["notify"];
  ledger?: ReturnType<typeof makeLedger>;
  findDueThrows?: boolean;
  releaseThrows?: boolean;
  markSentThrows?: boolean;
  now?: Date;
  /**
   * Ports this "process" has. Defaults to all four — the fully-configured
   * deployment. Narrow it to model an unset RESEND_API_KEY.
   */
  availableChannels?: RsvpReminderChannel[];
  /**
   * Successive clock reads, consumed in order (the last one repeats). Models a
   * batch whose wall clock ADVANCES while it runs, which is what the
   * stale-claim guard actually has to survive.
   */
  clockReads?: Date[];
  /** The event's venue row, served by `places.getById`. */
  place?: Record<string, unknown> | null;
}) {
  const ledger = args.ledger ?? makeLedger();

  // Reports each candidate's settled channels from the ledger, exactly as the
  // query's correlated aggregate does — so a second run against the same
  // ledger sees what the first one actually achieved.
  const findDue = vi.fn(async () => {
    if (args.findDueThrows) throw new Error("db down");
    return args.candidates.map((candidate) => ({
      ...candidate,
      settledChannels: ledger.settledChannels(candidate),
    }));
  });

  const release = args.releaseThrows
    ? vi.fn(async () => {
        throw new Error("release failed");
      })
    : ledger.release;

  const markSent = args.markSentThrows
    ? vi.fn(async () => {
        throw new Error("markSent failed");
      })
    : ledger.markSent;

  const rsvpReminders = { findDue, claim: ledger.claim, markSent, release };

  const events = {
    getById: vi.fn(async () =>
      args.event === undefined
        ? makeCommunityEvent({ timezone: TZ, slug: EVENT_SLUG })
        : args.event,
    ),
  };

  const eventDates = {
    getById: vi.fn(async (id: string) => {
      if (args.eventDatesById) return args.eventDatesById[id] ?? null;
      return args.eventDate === undefined ? makeEventDate({ id }) : args.eventDate;
    }),
  };

  const places = { getById: vi.fn(async () => args.place ?? null) };

  const existsForUser = vi.fn(async () => args.rsvpExists ?? true);
  const eventDateRsvps = { existsForUser };
  const eventRsvps = { existsForUser };

  const notificationPrefs = {
    readEffective: vi.fn(
      async (input: { humanId: string; scope: { kind: string } }) => {
        if (args.prefsThrow) throw new Error("prefs unavailable");
        // Per-human override first: a mixed batch needs one person's
        // reminders off while everyone else's stay on, and the use case
        // memoizes per `humanId|eventId`, so this is the only way to model it.
        const perHuman = args.prefsByHuman?.[input.humanId];
        if (perHuman) return perHuman;
        return input.scope.kind === "EVENT"
          ? (args.eventPrefs ?? ALL_ON)
          : (args.globalPrefs ?? ALL_ON);
      },
    ),
  };

  // Typed as a Mock, not as the dep's function type: every assertion below
  // reads `.mock.calls`, and `args.notify`'s declared type has no `.mock`.
  const notify = (args.notify ?? vi.fn(async () => notifyOutput())) as Mock;
  // `logger` references itself through `child`, so the annotation is what
  // stops TypeScript inferring `any` for the whole object.
  const logger: Record<string, Mock> = {
    child: vi.fn(() => logger),
    withTime: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const reads = args.clockReads;
  let readIndex = 0;
  const clock: ClockPort = {
    now: vi.fn(() => {
      if (!reads || reads.length === 0) return args.now ?? NOW;
      const value = reads[Math.min(readIndex, reads.length - 1)];
      readIndex += 1;
      return value as Date;
    }),
  };
  const reportError = vi.fn();

  const deps: SendRsvpRemindersDeps = {
    repos: {
      rsvpReminders,
      events,
      eventDates,
      eventDateRsvps,
      eventRsvps,
      notificationPrefs,
      places,
    } as unknown as SendRsvpRemindersDeps["repos"],
    notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    availableChannels: new Set<RsvpReminderChannel>(
      args.availableChannels ?? ["in_app", "push", "email", "sms"],
    ),
    clock,
    // Trailing slash on purpose — the use case must trim it.
    appBaseUrl: "https://ithasfire.com/",
    logger: logger as unknown as SendRsvpRemindersDeps["logger"],
    reportError,
  };

  return {
    deps,
    ledger,
    findDue,
    events,
    eventDates,
    existsForUser,
    notificationPrefs,
    places,
    notify,
    logger,
    reportError,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("community.sendRsvpReminders", () => {
  it("sends one per-date reminder and queries the 24h window as instants", async () => {
    const { deps, findDue, notify } = createDeps({
      candidates: [makeCandidate()],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({
      candidates: 1,
      reminded: 1,
      alreadyReminded: 0,
      skipped: 0,
      suppressed: 0,
      failed: 0,
    });

    // The window is `now + lead - catchUp` .. `now + lead` — pure instant
    // arithmetic, identical in every timezone. `leadMinutes` also goes to the
    // query (the RSVP'd-inside-the-lead filter), and `staleClaimBefore` is
    // `now - staleClaimMinutes`.
    expect(findDue).toHaveBeenCalledWith({
      windowStart: new Date("2026-08-18T18:00:00.000Z"), // now + 24h - 2h
      windowEnd: new Date("2026-08-18T20:00:00.000Z"), // now + 24h
      leadMinutes: 24 * 60,
      staleClaimBefore: new Date("2026-08-17T19:50:00.000Z"), // now - 10m
      limit: 200,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]?.[0];
    expect(payload?.variant).toBe("rsvp.reminder");
    expect(payload?.humanId).toBe(USER_ID);
    // EVENT scope so the in-app row and the key are attributed to the listing.
    expect(payload?.scope).toEqual({ kind: "EVENT", eventId: EVENT_ID });
    // Subject-scoped idempotency key.
    expect(payload?.idempotencyKey).toBe(`rsvp-reminder:${DATE_ID}`);
  });

  it("carries the OCCURRENCE's start/end, not the event's", async () => {
    const { deps, notify } = createDeps({ candidates: [makeCandidate()] });

    await sendRsvpReminders(deps, {});

    const payload = notify.mock.calls[0]?.[0] as
      | { payload: Record<string, unknown> }
      | undefined;
    expect(payload?.payload.startsAtIso).toBe(DATE_STARTS_AT.toISOString());
    expect(payload?.payload.endsAtIso).toBe(DATE_ENDS_AT.toISOString());
    // The event fixture starts 2026-08-01 — proving we did NOT fall back to it.
    expect(payload?.payload.startsAtIso).not.toBe(
      makeCommunityEvent().startsAt.toISOString(),
    );
    expect(payload?.payload.eventDateId).toBe(DATE_ID);
    // Per-date "manage" points at the event page (the real cancel surface),
    // never /my-rsvps, which lists event-level RSVPs only.
    expect(payload?.payload.manageRsvpsUrl).toBe(
      `https://ithasfire.com/events/${EVENT_SLUG}`,
    );
  });

  it("announces the occurrence's CURRENT time when the date moved after the due read", async () => {
    // The due-set row says 15:00; the occurrence was pushed to 17:00 while the
    // batch was running. Announcing the stale time is worse than not sending.
    const MOVED = new Date("2026-08-18T22:00:00.000Z");
    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      eventDate: makeEventDate({ startsAt: MOVED, endsAt: null }),
    });

    await sendRsvpReminders(deps, {});

    const payload = notify.mock.calls[0]?.[0] as
      | { payload: Record<string, unknown> }
      | undefined;
    expect(payload?.payload.startsAtIso).toBe(MOVED.toISOString());
    expect(payload?.payload.endsAtIso).toBeNull();
  });

  it("sends an event-level reminder with the /my-rsvps manage link", async () => {
    const { deps, notify, ledger, eventDates } = createDeps({
      candidates: [
        makeCandidate({
          eventDateId: null,
          startsAt: DATE_STARTS_AT,
          endsAt: null,
        }),
      ],
      // For an event-level RSVP the subject IS Event.startsAt, and the use
      // case re-reads it, so the fixture has to carry the same instant the
      // due-set row did.
      event: makeCommunityEvent({
        timezone: TZ,
        slug: EVENT_SLUG,
        startsAt: DATE_STARTS_AT,
        endsAt: null,
      }),
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result.reminded).toBe(1);
    const payload = notify.mock.calls[0]?.[0] as
      | { payload: Record<string, unknown>; idempotencyKey?: string }
      | undefined;
    expect(payload?.payload.eventDateId).toBeNull();
    expect(payload?.payload.manageRsvpsUrl).toBe(
      "https://ithasfire.com/my-rsvps",
    );
    expect(payload?.idempotencyKey).toBe(`rsvp-reminder:${EVENT_ID}`);
    // An event-level reminder has no occurrence to re-read.
    expect(eventDates.getById).not.toHaveBeenCalled();
    // The ledger claim is keyed on the EVENT for an event-level reminder.
    expect(ledger.settled()).toEqual(
      expect.arrayContaining([
        `event:${EVENT_ID}|${USER_ID}|in_app`,
        `event:${EVENT_ID}|${USER_ID}|email`,
      ]),
    );
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  it("a double run sends exactly ONE reminder (the ledger claim is the guard)", async () => {
    const ledger = makeLedger();
    const candidates = [makeCandidate()];

    // Two runs against the SAME ledger. The second run's findDue still returns
    // the candidate — which is the realistic worst case: an overlapping tick
    // whose read happened before the first tick's claim landed, or a scheduler
    // retry. Only the claim can save us, and it must.
    const first = createDeps({ candidates, ledger });
    const second = createDeps({ candidates, ledger });

    const r1 = await sendRsvpReminders(first.deps, {});
    const r2 = await sendRsvpReminders(second.deps, {});

    expect(r1.reminded).toBe(1);
    expect(r2.reminded).toBe(0);
    expect(r2.alreadyReminded).toBe(1);

    expect(first.notify).toHaveBeenCalledTimes(1);
    expect(second.notify).toHaveBeenCalledTimes(0);
    expect(ledger.unsettled()).toEqual([]);
  });

  it("claims BEFORE sending, so a concurrent tick cannot interleave a second send", async () => {
    const ledger = makeLedger();
    const order: string[] = [];
    const claim = ledger.claim;
    ledger.claim = vi.fn(async (input) => {
      order.push("claim");
      return claim(input);
    }) as typeof ledger.claim;

    const { deps } = createDeps({
      candidates: [makeCandidate()],
      ledger,
      notify: vi.fn(async () => {
        order.push("notify");
        return notifyOutput();
      }) as unknown as SendRsvpRemindersDeps["notify"],
    });

    await sendRsvpReminders(deps, {});

    expect(order).toEqual(["claim", "notify"]);
  });

  it("reminds each RSVP'd date of a recurring listing separately", async () => {
    const { deps, notify } = createDeps({
      candidates: [
        makeCandidate({ eventDateId: DATE_ID }),
        makeCandidate({
          eventDateId: OTHER_DATE_ID,
          startsAt: new Date("2026-08-18T19:00:00.000Z"),
        }),
      ],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result.reminded).toBe(2);
    const keys = notify.mock.calls.map(
      (call) => (call[0] as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys).toEqual([
      `rsvp-reminder:${DATE_ID}`,
      `rsvp-reminder:${OTHER_DATE_ID}`,
    ]);
  });

  // ── Never remind about a dead/past subject ────────────────────────────────

  it("skips a date whose startsAt has already passed", async () => {
    const { deps, notify } = createDeps({
      candidates: [
        makeCandidate({ startsAt: new Date("2026-08-17T19:00:00.000Z") }),
      ],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips when the event vanished between the read and the send", async () => {
    const { deps, notify, ledger } = createDeps({
      candidates: [makeCandidate()],
      event: null,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
    // No claim burned on a skip, so the reminder is still sendable if the event
    // comes back inside the window.
    expect(ledger.rows.size).toBe(0);
  });

  it("skips when the event stopped being PUBLISHED", async () => {
    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      event: makeCommunityEvent({ status: "CANCELLED", timezone: TZ }),
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips an occurrence a moderator called off AFTER the due-set read", async () => {
    // The event is still PUBLISHED — cancelling ONE night of a weekly listing
    // never touches Event.status, so only the per-date re-read can catch it.
    // Without this check candidate #170 of a 3-minute batch is told "Tomorrow:
    // Weekly Open Mic" for a night that is off.
    const { deps, notify, ledger, logger } = createDeps({
      candidates: [makeCandidate()],
      eventDate: makeEventDate({ status: "CANCELLED" }),
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(ledger.rows.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "community.sendRsvpReminders.date_gone",
      expect.objectContaining({ status: "CANCELLED" }),
    );
  });

  it("a call-off landing MID-BATCH skips only that night, and burns no claim", async () => {
    // The read-to-send gap is where a cancellation lands: a 200-row batch takes
    // minutes, and `findDue` has long since answered. Cancelling ONE night of a
    // weekly listing never touches `Event.status`, so the event re-read cannot
    // catch it — only the per-date re-read can, and it has to run BEFORE the
    // ledger claim or the reminder is burned for good.
    const { deps, notify, ledger, logger } = createDeps({
      candidates: [
        makeCandidate({ eventDateId: DATE_ID, humanId: USER_ID }),
        makeCandidate({ eventDateId: OTHER_DATE_ID, humanId: OTHER_USER_ID }),
      ],
      eventDatesById: {
        // Called off while the batch was running.
        [DATE_ID]: makeEventDate({ id: DATE_ID, status: "CANCELLED" }),
        // The listing's other night, still on.
        [OTHER_DATE_ID]: makeEventDate({ id: OTHER_DATE_ID }),
      },
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ candidates: 2, reminded: 1, skipped: 1 });
    // Only the live night was reminded, and only its person.
    const reminded = notify.mock.calls.map((call) => (call as any[])[0]);
    expect(reminded).toHaveLength(1);
    expect(reminded[0].humanId).toBe(OTHER_USER_ID);
    expect(reminded[0].payload.eventDateId).toBe(OTHER_DATE_ID);
    // No ledger row for the cancelled night — nothing to burn, and if it is
    // restored while still inside the window the reminder is still sendable.
    for (const key of ledger.rows.keys()) {
      expect(key).not.toContain(DATE_ID);
    }
    expect(logger.info).toHaveBeenCalledWith(
      "community.sendRsvpReminders.date_gone",
      expect.objectContaining({
        eventDateId: DATE_ID,
        status: "CANCELLED",
      }),
    );
  });

  it("skips an occurrence that vanished entirely", async () => {
    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      eventDate: null,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips a date the occurrence itself has moved into the past", async () => {
    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      eventDate: makeEventDate({
        startsAt: new Date("2026-08-17T19:00:00.000Z"),
      }),
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips an RSVP withdrawn between the due-set read and the send", async () => {
    const { deps, notify, ledger, existsForUser, logger } = createDeps({
      candidates: [makeCandidate()],
      rsvpExists: false,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(existsForUser).toHaveBeenCalledWith({
      eventDateId: DATE_ID,
      humanId: USER_ID,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(ledger.rows.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "community.sendRsvpReminders.rsvp_cancelled",
      expect.objectContaining({ humanId: USER_ID }),
    );
  });

  it("checks the EVENT-level RSVP row for an event-level candidate", async () => {
    const { deps, existsForUser } = createDeps({
      candidates: [makeCandidate({ eventDateId: null, endsAt: null })],
      event: makeCommunityEvent({
        timezone: TZ,
        slug: EVENT_SLUG,
        startsAt: DATE_STARTS_AT,
      }),
    });

    await sendRsvpReminders(deps, {});

    expect(existsForUser).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: USER_ID,
    });
  });

  it("skips an event-level reminder whose event was rescheduled into the past", async () => {
    // Event.startsAt IS the subject here, so the send-time re-read is the only
    // thing standing between a reschedule and a reminder for a night that has
    // already been and gone.
    const { deps, notify } = createDeps({
      candidates: [makeCandidate({ eventDateId: null, endsAt: null })],
      event: makeCommunityEvent({
        timezone: TZ,
        slug: EVENT_SLUG,
        startsAt: new Date("2026-08-17T19:00:00.000Z"),
      }),
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips someone who RSVP'd AFTER the 24h mark — their confirmation is the reminder", async () => {
    // Only reachable in the catch-up tail: the date starts at now + 23h, so its
    // 24h mark was an hour ago, and this person RSVP'd 30 minutes ago — i.e.
    // 23.5h before the show, having just been sent a confirmation. The query
    // filters this class too; the use case keeps the rule.
    const { deps, notify } = createDeps({
      candidates: [
        makeCandidate({
          startsAt: new Date("2026-08-18T19:00:00.000Z"),
          rsvpCreatedAt: new Date("2026-08-17T19:30:00.000Z"),
        }),
      ],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  // ── Preferences ───────────────────────────────────────────────────────────

  it("sends nothing when reminders are off GLOBALLY", async () => {
    const { deps, notify, ledger } = createDeps({
      candidates: [makeCandidate()],
      globalPrefs: withRemindersOff(),
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ suppressed: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
    // Deliberately NO claim: switching reminders back on while the date is
    // still inside the window must still deliver.
    expect(ledger.rows.size).toBe(0);
  });

  it("sends nothing when reminders are muted for THIS listing only", async () => {
    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      globalPrefs: ALL_ON,
      eventPrefs: withRemindersOff(),
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ suppressed: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("passes the resolved per-channel decision to notify as explicit overrides", async () => {
    // Email off globally, everything else on. `readEffective` does NOT cascade
    // scopes, so the use case has to AND them itself and hand notify the answer
    // — this pins that it does.
    const globalPrefs = JSON.parse(
      JSON.stringify(ALL_ON),
    ) as NotificationPreferenceSnapshot;
    if (globalPrefs.email) globalPrefs.email.reminders = false;

    const { deps, notify, notificationPrefs } = createDeps({
      candidates: [makeCandidate()],
      globalPrefs,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result.reminded).toBe(1);
    expect(notify.mock.calls[0]?.[0]?.channels).toEqual({
      inApp: { enabled: true },
      push: { enabled: true },
      email: { enabled: false },
      // reminders default OFF for SMS, matching the house opt-in posture.
      sms: { enabled: false },
    });

    const scopes = notificationPrefs.readEffective.mock.calls.map(
      (call) => call[0]?.scope,
    );
    expect(scopes).toEqual(
      expect.arrayContaining([
        { kind: "GLOBAL" },
        { kind: "EVENT", eventId: EVENT_ID },
      ]),
    );
  });

  it("never texts a reminder, even with a stored reminders SMS opt-in (reminders are not SMS-eligible)", async () => {
    const smsOn = JSON.parse(
      JSON.stringify(ALL_ON),
    ) as NotificationPreferenceSnapshot;
    if (smsOn.sms) smsOn.sms.reminders = true;

    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      globalPrefs: smsOn,
      eventPrefs: smsOn,
    });

    await sendRsvpReminders(deps, {});

    expect(notify.mock.calls[0]?.[0]?.channels?.sms).toEqual({ enabled: false });
  });

  it("fails CLOSED and reports when the preference read throws", async () => {
    const { deps, notify, reportError, logger } = createDeps({
      candidates: [makeCandidate()],
      prefsThrow: true,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ skipped: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "read_preferences" }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "community.sendRsvpReminders.preference_read_failed",
      expect.objectContaining({ humanId: USER_ID }),
    );
  });

  // ── Failure handling ──────────────────────────────────────────────────────

  it("releases the claim when the mailer FAILS without throwing, so the next tick retries", async () => {
    // The failure this exists to catch: `sendEmail` catches a mailer
    // `success: false` (and a thrown CommsPortError) and RETURNS
    // `{ status: "failed" }` — it never throws, and only logs a `warn`, which
    // Sentry does not capture. A use case that reacts to rejections only
    // counts the send as delivered, keeps the ledger claim, and `findDue`'s
    // exclusion then hides the reminder forever: an email-only attendee is
    // silently never reminded while the job reports success.
    const ledger = makeLedger();
    const notify = vi
      .fn()
      .mockResolvedValueOnce(EMAIL_FAILED)
      .mockResolvedValue(notifyOutput());

    const first = createDeps({
      candidates: [makeCandidate()],
      ledger,
      globalPrefs: emailOnly(),
      eventPrefs: emailOnly(),
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });

    const r1 = await sendRsvpReminders(first.deps, {});

    expect(r1).toMatchObject({ reminded: 0, failed: 1 });
    // Nothing was delivered, so nothing may stay settled.
    expect(ledger.settled()).toEqual([]);
    expect(first.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "notify" }),
      }),
    );
    expect(first.logger.error).toHaveBeenCalledWith(
      "community.sendRsvpReminders.channel_send_failed",
      expect.objectContaining({ failedChannels: ["email"] }),
    );

    // …and the next tick actually re-sends it.
    const second = createDeps({
      candidates: [makeCandidate()],
      ledger,
      globalPrefs: emailOnly(),
      eventPrefs: emailOnly(),
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });
    const r2 = await sendRsvpReminders(second.deps, {});
    expect(r2.reminded).toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(ledger.settled()).toEqual([`${DATE_ID}|${USER_ID}|email`]);
  });

  it("retries ONLY the failed channel — the in-app row that landed is never re-fired", async () => {
    const ledger = makeLedger();
    const notify = vi
      .fn()
      .mockResolvedValueOnce(EMAIL_FAILED)
      .mockResolvedValue(notifyOutput());

    const first = createDeps({
      candidates: [makeCandidate()],
      ledger,
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });
    const r1 = await sendRsvpReminders(first.deps, {});

    // In-app + push landed, email did not: both counters are true of this one
    // candidate.
    expect(r1).toMatchObject({ reminded: 1, failed: 1 });
    expect(ledger.settled().sort()).toEqual([
      `${DATE_ID}|${USER_ID}|in_app`,
      `${DATE_ID}|${USER_ID}|push`,
    ]);
    expect(ledger.unsettled()).toEqual([`${DATE_ID}|${USER_ID}|email`]);

    const second = createDeps({
      candidates: [makeCandidate()],
      ledger,
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });
    const r2 = await sendRsvpReminders(second.deps, {});

    expect(r2.reminded).toBe(1);
    // THE point of the per-channel ledger: the retry carries email alone.
    expect(notify.mock.calls[1]?.[0]?.channels).toEqual({
      inApp: { enabled: false },
      push: { enabled: false },
      email: { enabled: true },
      sms: { enabled: false },
    });
    expect(ledger.unsettled()).toEqual([]);
  });

  it("settles a channel the transport DECLINED, so it cannot loop forever", async () => {
    // "no device registered" is not a transient failure — retrying it every
    // tick would put the candidate back at the head of the due set for the
    // rest of the window.
    const ledger = makeLedger();
    const { deps } = createDeps({
      candidates: [makeCandidate()],
      ledger,
      notify: vi.fn(async () =>
        // `no_devices`, plural — `no_device` is not a member of
        // `pushResultSchema`'s reason enum and never reached this code.
        notifyOutput({ push: { status: "skipped", reason: "no_devices" } }),
      ) as unknown as SendRsvpRemindersDeps["notify"],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ reminded: 1, failed: 0 });
    expect(ledger.unsettled()).toEqual([]);
    expect(ledger.settled()).toContain(`${DATE_ID}|${USER_ID}|push`);
  });

  // ── `skipped` is not one meaning ──────────────────────────────────────────

  it("RELEASES and reports a `skipped: port_unavailable` — an unset env var must not settle the ledger", async () => {
    // The narrowing the second review caught. Treating every `skipped` as
    // "declined for good" settles the row and stamps `sentAt`, and `findDue`
    // then excludes it forever. `port_unavailable` is returned by
    // `send-email.ts` when `deps.mailer` is falsy — which the jobs container
    // leaves null whenever RESEND_API_KEY / SMTP_* are absent, announcing it
    // with `logger.warn` that Sentry does not capture. A deploy with that key
    // shadowed to empty would therefore destroy every reminder in the window
    // while the job logged `failed: 0` and raised nothing.
    const ledger = makeLedger();
    const notify = vi
      .fn()
      .mockResolvedValueOnce(EMAIL_PORT_UNAVAILABLE)
      .mockResolvedValue(notifyOutput());

    const first = createDeps({
      candidates: [makeCandidate()],
      ledger,
      globalPrefs: emailOnly(),
      eventPrefs: emailOnly(),
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });

    const r1 = await sendRsvpReminders(first.deps, {});

    expect(r1).toMatchObject({ reminded: 0, declined: 0, failed: 1 });
    // The claim MUST NOT be settled — that is the whole finding.
    expect(ledger.settled()).toEqual([]);
    expect(ledger.unsettled()).toEqual([`${DATE_ID}|${USER_ID}|email`]);
    expect(first.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "notify" }),
      }),
    );
    expect(first.logger.error).toHaveBeenCalledWith(
      "community.sendRsvpReminders.channel_send_failed",
      expect.objectContaining({ failedChannels: ["email"] }),
    );

    // …and once the mailer is wired back up, the reminder actually goes out.
    const second = createDeps({
      candidates: [makeCandidate()],
      ledger,
      globalPrefs: emailOnly(),
      eventPrefs: emailOnly(),
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });
    const r2 = await sendRsvpReminders(second.deps, {});

    expect(r2.reminded).toBe(1);
    expect(ledger.settled()).toEqual([`${DATE_ID}|${USER_ID}|email`]);
  });

  it("SETTLES a `skipped: no_recipient` — that one is about the person, not the port", async () => {
    // The other side of the same discrimination: no email identity on file is
    // not going to change on the next tick, and retrying it every 30 minutes
    // would park this candidate at the head of the due set for the whole 2h
    // window.
    const ledger = makeLedger();
    const { deps, reportError } = createDeps({
      candidates: [makeCandidate()],
      ledger,
      globalPrefs: emailOnly(),
      eventPrefs: emailOnly(),
      notify: vi.fn(
        async () => EMAIL_NO_RECIPIENT,
      ) as unknown as SendRsvpRemindersDeps["notify"],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ reminded: 0, declined: 1, failed: 0 });
    expect(ledger.settled()).toEqual([`${DATE_ID}|${USER_ID}|email`]);
    expect(ledger.unsettled()).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  // ── Primary fix: never claim a channel the process has no port for ────────

  it("never CLAIMS a channel whose port is missing, so wiring it later still reminds", async () => {
    // The backstop above releases and retries; this is why it is only the
    // backstop. With no mailer at all, claiming email every tick for two hours
    // is pure churn — and in the window where every channel is email, the
    // released row also keeps the candidate at the head of the due set. Gating
    // on the composition root's port set means no email row is ever written.
    const ledger = makeLedger();
    const { deps, notify, reportError, logger } = createDeps({
      candidates: [makeCandidate()],
      ledger,
      availableChannels: ["in_app", "push", "sms"],
    });

    const result = await sendRsvpReminders(deps, {});

    // in-app and push still went out; email was simply not attempted.
    expect(result).toMatchObject({ reminded: 1, failed: 0 });
    expect(notify.mock.calls[0]?.[0]?.channels).toEqual({
      inApp: { enabled: true },
      push: { enabled: true },
      email: { enabled: false },
      sms: { enabled: false },
    });
    // NO email ledger row exists at all — neither settled nor outstanding.
    expect([...ledger.rows.keys()]).not.toContain(
      `${DATE_ID}|${USER_ID}|email`,
    );
    // Loud exactly once per run, because the container only says so at boot
    // and says it with `warn`.
    expect(logger.error).toHaveBeenCalledWith(
      "community.sendRsvpReminders.channel_port_unavailable",
      expect.objectContaining({ unavailableChannels: ["email"] }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "port_unavailable" }),
      }),
    );
  });

  it("skips (without claiming) someone whose ONLY channel has no port", async () => {
    const ledger = makeLedger();
    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      ledger,
      globalPrefs: emailOnly(),
      eventPrefs: emailOnly(),
      availableChannels: ["in_app", "push", "sms"],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({
      candidates: 1,
      skipped: 1,
      reminded: 0,
      failed: 0,
      declined: 0,
    });
    expect(notify).not.toHaveBeenCalled();
    expect([...ledger.rows.keys()]).toEqual([]);
  });

  it("reports missing ports ONCE per run, not once per candidate", async () => {
    const { deps, reportError } = createDeps({
      candidates: [
        makeCandidate({ eventDateId: DATE_ID }),
        makeCandidate({ eventDateId: OTHER_DATE_ID }),
        makeCandidate({ eventDateId: DATE_ID, humanId: OTHER_USER_ID }),
      ],
      availableChannels: ["in_app", "push"],
    });

    await sendRsvpReminders(deps, {});

    const portCalls = reportError.mock.calls.filter(
      (call) =>
        (call[1] as { tags?: { stage?: string } })?.tags?.stage ===
        "port_unavailable",
    );
    expect(portCalls).toHaveLength(1);
  });

  it("releases the claim and reports when the send THROWS, so the next tick retries", async () => {
    const ledger = makeLedger();
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error("mailer 503"))
      .mockResolvedValue(notifyOutput());

    const first = createDeps({
      candidates: [makeCandidate()],
      ledger,
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });

    const r1 = await sendRsvpReminders(first.deps, {});
    expect(r1).toMatchObject({ failed: 1, reminded: 0 });
    // Every claim rolled back — otherwise the reminder is lost forever.
    expect(ledger.settled()).toEqual([]);
    expect(first.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "notify" }),
      }),
    );

    const second = createDeps({
      candidates: [makeCandidate()],
      ledger,
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });
    const r2 = await sendRsvpReminders(second.deps, {});
    expect(r2.reminded).toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("reports when the claim rollback itself fails (a permanently lost reminder)", async () => {
    const { deps, reportError } = createDeps({
      candidates: [makeCandidate()],
      notify: vi.fn(async () => {
        throw new Error("mailer 503");
      }) as unknown as SendRsvpRemindersDeps["notify"],
      releaseThrows: true,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result.failed).toBe(1);
    const stages = reportError.mock.calls.map(
      (call) => (call[1] as { tags?: { stage?: string } })?.tags?.stage,
    );
    expect(stages).toEqual(
      expect.arrayContaining(["release_claim", "notify"]),
    );
  });

  it("reports when the send landed but the ledger write did not", async () => {
    // The person HAS been reminded; only the bookkeeping failed. The claim
    // stays unsettled so a later tick re-sends — survivable, but never silent.
    const { deps, reportError, logger } = createDeps({
      candidates: [makeCandidate()],
      markSentThrows: true,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result.reminded).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "community.sendRsvpReminders.mark_sent_failed",
      expect.objectContaining({ humanId: USER_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "mark_sent" }),
      }),
    );
  });

  it("treats a channel missing from notify's answer as unsent, not delivered", async () => {
    const ledger = makeLedger();
    const { deps } = createDeps({
      candidates: [makeCandidate()],
      ledger,
      notify: vi.fn(async () => ({ ok: true })) as unknown as
        SendRsvpRemindersDeps["notify"],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ reminded: 0, failed: 1 });
    expect(ledger.settled()).toEqual([]);
  });

  it("one bad candidate never aborts the batch", async () => {
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(notifyOutput());

    const { deps } = createDeps({
      candidates: [
        makeCandidate({ eventDateId: DATE_ID }),
        makeCandidate({ eventDateId: OTHER_DATE_ID }),
      ],
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ candidates: 2, reminded: 1, failed: 1 });
  });

  it("returns an empty result and reports when the due-set read fails", async () => {
    const { deps, reportError, logger } = createDeps({
      candidates: [],
      findDueThrows: true,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ candidates: 0, reminded: 0 });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "find_due" }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "community.sendRsvpReminders.due_read_failed",
      expect.objectContaining({ error: expect.anything() }),
    );
  });

  // ── Crash recovery ────────────────────────────────────────────────────────

  it("re-claims a stale unsent row — an eviction between claim and send self-heals", async () => {
    const ledger = makeLedger();
    // A previous run claimed every channel 30 minutes ago and died before
    // sending. `sentAt` is null, so these rows are a debt, not a delivery.
    for (const channel of ["in_app", "push", "email"]) {
      ledger.rows.set(`${DATE_ID}|${USER_ID}|${channel}`, {
        claimedAt: new Date(NOW.getTime() - 30 * 60_000),
        sentAt: null,
      });
    }

    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      ledger,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result.reminded).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger.unsettled()).toEqual([]);
  });

  it("does NOT steal a claim another tick is still holding", async () => {
    const ledger = makeLedger();
    for (const channel of ["in_app", "push", "email"]) {
      ledger.rows.set(`${DATE_ID}|${USER_ID}|${channel}`, {
        // Claimed one minute ago — well inside the 10-minute staleness window.
        claimedAt: new Date(NOW.getTime() - 60_000),
        sentAt: null,
      });
    }

    const { deps, notify } = createDeps({
      candidates: [makeCandidate()],
      ledger,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({ alreadyReminded: 1, reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("stamps each claim with a FRESH clock read, so a slow batch is not stolen from", async () => {
    // The second finding. The claim stamp used to be the RUN-START instant,
    // reused however long the batch ran — which made the guard depend on
    // elapsed run time rather than on the claim→settle gap. Cron */30: tick A
    // starts 12:00 and is still going at 12:35; tick B starts 12:30 with
    // staleClaimBefore = 12:20, reaches the same row, sees `claimedAt = 12:00`
    // and calls it stale. Two claims, two emails. Once a run outlives
    // staleClaimMinutes, protection is ZERO, not merely reduced — and notify's
    // own idempotency is a 60-second TTL against a 30-minute tick gap.
    const ledger = makeLedger();
    const TWENTY_MIN = 20 * 60_000;

    // Tick A: run starts at NOW, but the clock has advanced 20 minutes by the
    // time this candidate is claimed. `markSent` throws, so the row is left
    // claimed-and-unsent — exactly the state an overlapping tick inspects.
    const a = createDeps({
      candidates: [makeCandidate()],
      ledger,
      markSentThrows: true,
      clockReads: [
        NOW, // run start → findDue window
        new Date(NOW.getTime() + TWENTY_MIN), // the claim
        new Date(NOW.getTime() + TWENTY_MIN), // markSent's own read
      ],
    });

    await sendRsvpReminders(a.deps, {});

    // The claim carried the fresh read, and its staleness cutoff was derived
    // from the SAME read — not from the run-start instant.
    const claimArgs = ledger.claim.mock.calls[0]?.[0];
    expect(claimArgs?.now).toEqual(new Date(NOW.getTime() + TWENTY_MIN));
    expect(claimArgs?.staleClaimBefore).toEqual(
      new Date(NOW.getTime() + TWENTY_MIN - 10 * 60_000),
    );
    expect(ledger.rows.get(`${DATE_ID}|${USER_ID}|email`)?.claimedAt).toEqual(
      new Date(NOW.getTime() + TWENTY_MIN),
    );

    // Tick B, five minutes later. Its staleness cutoff is NOW+15m. A claim
    // stamped NOW+20m is still fresh, so B must leave it alone. Stamped with
    // the run-start NOW it would look 25 minutes old and be retaken.
    const b = createDeps({
      candidates: [makeCandidate()],
      ledger,
      now: new Date(NOW.getTime() + 25 * 60_000),
    });

    const r2 = await sendRsvpReminders(b.deps, {});

    expect(b.notify).not.toHaveBeenCalled();
    expect(r2).toMatchObject({ alreadyReminded: 1, reminded: 0 });
  });

  // ── Batch shape ───────────────────────────────────────────────────────────

  it("reports when the batch limit is reached, because starvation is invisible from in here", async () => {
    const { deps, reportError, logger } = createDeps({
      candidates: [
        makeCandidate({ eventDateId: DATE_ID }),
        makeCandidate({ eventDateId: OTHER_DATE_ID }),
      ],
    });

    const result = await sendRsvpReminders(deps, { batchLimit: 2 });

    expect(result.candidates).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(
      "community.sendRsvpReminders.batch_limit_reached",
      expect.objectContaining({ batchLimit: 2 }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "batch_limit_reached" }),
      }),
    );
  });

  it("stays quiet when the batch is NOT full", async () => {
    const { deps, reportError } = createDeps({
      candidates: [makeCandidate()],
    });

    await sendRsvpReminders(deps, { batchLimit: 2 });

    expect(reportError).not.toHaveBeenCalled();
  });

  // ── Counter completeness ──────────────────────────────────────────────────

  it("accounts for EVERY candidate in exactly one bucket", async () => {
    // The invariant that was missing. A candidate whose every claimed channel
    // came back `skipped` used to increment nothing at all, so a batch of 200
    // uncontactable people reported `{ candidates: 200, reminded: 0,
    // failed: 0 }` — all zeros, and no assertion anywhere that the parts sum
    // to the whole. `declined` closes it.
    //
    // Six people, six dispositions, each landing in exactly ONE bucket (so
    // `failed` here IS failed-only — the counters are otherwise per-channel
    // facts and `reminded`/`failed` can both be true of one person).
    const ledger = makeLedger();

    // 2. Everything this person can receive on has already settled.
    for (const channel of ["in_app", "push", "email"]) {
      ledger.rows.set(`${OTHER_DATE_ID}|${HUMAN_SETTLED}|${channel}`, {
        claimedAt: NOW,
        sentAt: NOW,
      });
    }

    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === HUMAN_DECLINED) {
        // Nothing failed and nothing landed: every transport declined for a
        // reason about the person.
        return notifyOutput({
          inApp: { status: "skipped", reason: "channel_disabled" },
          push: { status: "skipped", reason: "no_devices" },
          email: { status: "skipped", reason: "no_recipient" },
        });
      }
      if (input.humanId === HUMAN_FAILED) {
        return notifyOutput({
          inApp: { status: "skipped", reason: "port_unavailable" },
          push: { status: "failed", deviceCount: 1, reason: "port_error" },
          email: { status: "failed", reason: "port_error" },
        });
      }
      return notifyOutput();
    });

    const { deps } = createDeps({
      ledger,
      candidates: [
        // 1. reminded
        makeCandidate({ humanId: USER_ID }),
        // 2. alreadyReminded
        makeCandidate({
          humanId: HUMAN_SETTLED,
          eventDateId: OTHER_DATE_ID,
        }),
        // 3. skipped — RSVP'd inside the 24h lead, so the confirmation they
        //    just got IS the reminder.
        makeCandidate({
          humanId: HUMAN_LATE_RSVP,
          rsvpCreatedAt: new Date(DATE_STARTS_AT.getTime() - 60 * 60_000),
        }),
        // 4. suppressed — reminders switched off on every channel.
        makeCandidate({ humanId: HUMAN_MUTED }),
        // 5. declined
        makeCandidate({ humanId: HUMAN_DECLINED }),
        // 6. failed (and nothing delivered, so failed-only)
        makeCandidate({ humanId: HUMAN_FAILED }),
      ],
      prefsByHuman: { [HUMAN_MUTED]: withRemindersOff() },
      notify: notify as unknown as SendRsvpRemindersDeps["notify"],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toEqual({
      candidates: 6,
      reminded: 1,
      alreadyReminded: 1,
      skipped: 1,
      suppressed: 1,
      declined: 1,
      failed: 1,
    });

    const failedOnly = result.failed; // no candidate here is both.
    expect(result.candidates).toBe(
      result.reminded +
        result.alreadyReminded +
        result.skipped +
        result.suppressed +
        result.declined +
        failedOnly,
    );
  });

  it("never leaves an all-declined candidate in zero buckets", async () => {
    // The shape of the bug, isolated: before `declined` existed this returned
    // `{ candidates: 1, reminded: 0, failed: 0 }` and matched nothing.
    const { deps } = createDeps({
      candidates: [makeCandidate()],
      notify: vi.fn(async () =>
        notifyOutput({
          inApp: { status: "skipped", reason: "channel_disabled" },
          push: { status: "skipped", reason: "no_devices" },
          email: { status: "skipped", reason: "no_recipient" },
        }),
      ) as unknown as SendRsvpRemindersDeps["notify"],
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result).toMatchObject({
      candidates: 1,
      reminded: 0,
      failed: 0,
      declined: 1,
    });
  });

  // ── Read amplification ────────────────────────────────────────────────────

  it("re-reads each event, date and preference pair ONCE per run", async () => {
    // 200 RSVPers on one listing must not cost 200 event reads or 400
    // preference reads. Two humans × two dates of the same listing:
    //   1 event read, 2 date reads, 2 humans × 2 scopes = 4 preference reads.
    const { deps, events, eventDates, notificationPrefs } = createDeps({
      candidates: [
        makeCandidate({ humanId: USER_ID }),
        makeCandidate({ humanId: USER_ID, eventDateId: OTHER_DATE_ID }),
        makeCandidate({ humanId: OTHER_USER_ID }),
        makeCandidate({ humanId: OTHER_USER_ID, eventDateId: OTHER_DATE_ID }),
      ],
    });

    await sendRsvpReminders(deps, {});

    expect(events.getById).toHaveBeenCalledTimes(1);
    expect(eventDates.getById).toHaveBeenCalledTimes(2);
    expect(notificationPrefs.readEffective).toHaveBeenCalledTimes(4);
  });

  it("memoizes a FAILED preference read too, instead of retrying it per candidate", async () => {
    const { deps, notificationPrefs } = createDeps({
      candidates: [
        makeCandidate({ eventDateId: DATE_ID }),
        makeCandidate({ eventDateId: OTHER_DATE_ID }),
      ],
      prefsThrow: true,
    });

    const result = await sendRsvpReminders(deps, {});

    expect(result.skipped).toBe(2);
    // One (human × event) pair → one pair of reads, not one per candidate.
    expect(notificationPrefs.readEffective).toHaveBeenCalledTimes(2);
  });

  it("respects an explicit window override and the batch limit", async () => {
    const { deps, findDue } = createDeps({ candidates: [] });

    await sendRsvpReminders(deps, {
      leadMinutes: 60,
      catchUpMinutes: 30,
      staleClaimMinutes: 5,
      batchLimit: 7,
    });

    expect(findDue).toHaveBeenCalledWith({
      windowStart: new Date("2026-08-17T20:30:00.000Z"), // now + 60m - 30m
      windowEnd: new Date("2026-08-17T21:00:00.000Z"), // now + 60m
      leadMinutes: 60,
      staleClaimBefore: new Date("2026-08-17T19:55:00.000Z"), // now - 5m
      limit: 7,
    });
  });

  it("rejects unknown input keys", async () => {
    const { deps } = createDeps({ candidates: [] });
    await expect(
      sendRsvpReminders(deps, { leadMinutes: 60, nope: true }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Renderer — the timezone-sensitive half
// ─────────────────────────────────────────────────────────────────────────────

describe("rsvp.reminder renderer", () => {
  const basePayload = {
    eventId: EVENT_ID,
    eventDateId: DATE_ID,
    eventTitle: "Weekly Open Mic",
    startsAtIso: DATE_STARTS_AT.toISOString(),
    endsAtIso: DATE_ENDS_AT.toISOString(),
    timezone: TZ,
    venueName: "The Corner Stage",
    addressText: "123 Main St, Austin, TX",
    heroImageUrl: null,
    eventUrl: `https://ithasfire.com/events/${EVENT_SLUG}`,
    manageRsvpsUrl: `https://ithasfire.com/events/${EVENT_SLUG}`,
  };

  it("is categorised `reminders`, not `transactional`", () => {
    const rendered = renderNotification("rsvp.reminder", basePayload, {
      now: NOW,
    });
    expect(rendered.category).toBe("reminders");
  });

  it('says "Tomorrow" when the date is the next CHICAGO calendar day', () => {
    // now = 2026-08-17 15:00 CDT, date = 2026-08-18 15:00 CDT.
    const rendered = renderNotification("rsvp.reminder", basePayload, {
      now: NOW,
    });
    expect(rendered.inApp?.title).toBe("Tomorrow: Weekly Open Mic");
    expect(rendered.email?.subject).toBe("Tomorrow: Weekly Open Mic");
    expect(rendered.email?.template?.variables?.dayLabel).toBe("Tomorrow");
  });

  it('says "Today" on a catch-up send whose date is later the same Chicago day', () => {
    // now = 2026-08-18 06:00 CDT, date = 2026-08-18 15:00 CDT (9h lead — the
    // catch-up tail after an outage). Saying "tomorrow" here would be a lie.
    const rendered = renderNotification("rsvp.reminder", basePayload, {
      now: new Date("2026-08-18T11:00:00.000Z"),
    });
    expect(rendered.inApp?.title).toBe("Today: Weekly Open Mic");
  });

  it("is UTC-day agnostic: a late-evening Chicago date is still TOMORROW", () => {
    // 2026-08-18 22:00 CDT === 2026-08-19 03:00 UTC. A UTC-based day comparison
    // against a now of 2026-08-17 22:00 CDT (2026-08-18 03:00 UTC) would call
    // this "tomorrow" too — so also assert the same instant reads "Today" when
    // the clock is one Chicago day later, which UTC maths gets wrong.
    const lateNight = {
      ...basePayload,
      startsAtIso: "2026-08-19T03:00:00.000Z",
      endsAtIso: null,
    };
    expect(
      renderNotification("rsvp.reminder", lateNight, {
        now: new Date("2026-08-18T03:00:00.000Z"), // 2026-08-17 22:00 CDT
      }).inApp?.title,
    ).toBe("Tomorrow: Weekly Open Mic");
    expect(
      renderNotification("rsvp.reminder", lateNight, {
        now: new Date("2026-08-18T15:00:00.000Z"), // 2026-08-18 10:00 CDT
      }).inApp?.title,
    ).toBe("Today: Weekly Open Mic");
  });

  it("renders the time in the LISTING's timezone", () => {
    const rendered = renderNotification("rsvp.reminder", basePayload, {
      now: NOW,
    });
    // 20:00Z in August Chicago is 3:00 PM CDT.
    expect(rendered.inApp?.body).toContain("3:00");
    expect(rendered.inApp?.body).toContain("CDT");
  });

  it("falls back to a neutral label when the date is further out", () => {
    const rendered = renderNotification("rsvp.reminder", basePayload, {
      now: new Date("2026-08-10T20:00:00.000Z"),
    });
    expect(rendered.inApp?.title).toBe("Coming up: Weekly Open Mic");
    expect(rendered.email?.template?.variables?.dayLabel).toBeNull();
  });

  it("still renders with no event URL (a slugless event must not lose its reminder)", () => {
    const rendered = renderNotification(
      "rsvp.reminder",
      { ...basePayload, eventUrl: null, manageRsvpsUrl: null },
      { now: NOW },
    );
    expect(rendered.inApp?.action).toBeNull();
    expect(rendered.email?.template?.key).toBe("rsvp.reminder");
  });

  it("fingerprints per DATE, so two dates of one listing never collapse", () => {
    const a = renderNotification("rsvp.reminder", basePayload, { now: NOW });
    const b = renderNotification(
      "rsvp.reminder",
      { ...basePayload, eventDateId: OTHER_DATE_ID },
      { now: NOW },
    );
    expect(a.fingerprint).not.toEqual(b.fingerprint);
  });

  it("tolerates an invalid IANA zone rather than throwing away the reminder", () => {
    const rendered = renderNotification(
      "rsvp.reminder",
      { ...basePayload, timezone: "Not/AZone" },
      { now: NOW },
    );
    expect(rendered.inApp?.title).toContain("Weekly Open Mic");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The address a reminder may carry
//
// It used to be `event.addressText` with no mode, reveal or NEVER check. An
// RSVP is attendance: the attendee gets exactly what a ticket holder gets.
// ─────────────────────────────────────────────────────────────────────────────

describe("community.sendRsvpReminders — address gate", () => {
  const PLACE_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
  const VENUE_ORG = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
  const HOUR = 60 * 60 * 1000;

  /** Owned by VENUE_ORG; accepts community listings venue-wide. */
  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    city: "Austin",
    region: "TX",
    postalCode: "78702",
    lat: 30.26,
    lng: -97.72,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Austin",
  };

  async function payloadFor(
    eventOverrides: Parameters<typeof makeCommunityEvent>[0],
    place: Record<string, unknown> | null = null,
  ) {
    const { deps, notify, places } = createDeps({
      candidates: [makeCandidate()],
      event: makeCommunityEvent({
        timezone: TZ,
        slug: EVENT_SLUG,
        ...eventOverrides,
      }),
      place,
    });
    await sendRsvpReminders(deps, {});
    expect(notify).toHaveBeenCalledTimes(1);
    return {
      payload: (notify.mock.calls[0]![0] as { payload: Record<string, unknown> })
        .payload,
      places,
    };
  }

  it("EXACT: unchanged — the organizer's label and the stored street, no venue read", async () => {
    const { payload, places } = await payloadFor({
      locationLabel: "The Corner Stage",
    });
    expect(payload.venueName).toBe("The Corner Stage");
    expect(payload.addressText).toBe("123 Main St, Austin, TX");
    expect(places.getById).not.toHaveBeenCalled();
  });

  it("NEVER: no street, ever", async () => {
    const { payload } = await payloadFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "NEVER",
      addressRevealAt: null,
      locationLabel: null,
    });
    expect(payload.addressText).toBeNull();
    expect(payload.venueName).toBe("Austin, TX");
    expect(JSON.stringify(payload)).not.toContain("123 Main St");
  });

  it("before the reveal: no street", async () => {
    const { payload } = await payloadFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "CUSTOM",
      addressRevealAt: new Date(NOW.getTime() + HOUR),
      locationLabel: "East Austin",
    });
    expect(payload.addressText).toBeNull();
    expect(payload.venueName).toBe("East Austin");
  });

  const revealedAtHouse = {
    placeId: PLACE_ID,
    locationMode: "OBSCURED" as const,
    locationRadiusMeters: 800,
    addressRevealPreset: "DAY_BEFORE" as const,
    addressRevealAt: new Date(NOW.getTime() - HOUR),
    addressText: "East Austin",
    postalCode: null,
  };

  it("after the reveal at a withheld venue: the Place's street, not the Event projection", async () => {
    const { payload, places } = await payloadFor(
      // The venue's own RSVP night.
      { ...revealedAtHouse, orgId: VENUE_ORG, stewardship: "OWNED" },
      withheldPlace,
    );
    expect(places.getById).toHaveBeenCalledWith(PLACE_ID);
    expect(payload.addressText).toBe("901 Porter Rd");
    expect(payload.addressText).not.toBe("East Austin");
  });

  it("C1: a community listing at a house that accepts listings: no street, ever", async () => {
    const { payload } = await payloadFor(revealedAtHouse, withheldPlace);
    expect(payload.addressText).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("Porter");
  });

  it("a failed venue read claims nothing and sends nothing (retried next tick)", async () => {
    const { deps, notify, places, ledger } = createDeps({
      candidates: [makeCandidate()],
      event: makeCommunityEvent({
        timezone: TZ,
        slug: EVENT_SLUG,
        placeId: PLACE_ID,
      }),
    });
    places.getById.mockRejectedValueOnce(new Error("places down"));

    const result = await sendRsvpReminders(deps, {});

    expect(result.failed).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    expect(ledger.claim).not.toHaveBeenCalled();
  });
});
