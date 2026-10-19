import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MailerPort } from "@th/ports/comms/mailer";
import { CommsPortError } from "@th/ports/comms/schemas";
import type { ShiftReminderCandidate } from "@th/ports/repos/volunteering";

import { sendVolunteerShiftReminders } from "./send-volunteer-shift-reminders";
import type { SendVolunteerShiftRemindersDeps } from "./send-volunteer-shift-reminders";

// ── Constants ────────────────────────────────────────────────────────────────

const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const HUMAN_ID = "00000000-0000-4000-8000-000000000050";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const NOTIFICATION_ID = "00000000-0000-4000-8000-000000000060";
const NOW = new Date("2026-06-30T09:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseCandidate: ShiftReminderCandidate = {
  signupId: SIGNUP_ID,
  humanId: HUMAN_ID,
  contactEmail: "vol@example.com",
  contactName: "Vol Unteer",
  contactPhone: null,
  smsOptIn: false,
  eventId: EVENT_ID,
  eventTitle: "Summer Fest",
  eventSlug: "summer-fest",
  eventTimezone: "America/New_York",
  addressText: null,
  roleName: "Security",
  shiftLabel: "Morning",
  shiftStartsAt: new Date("2026-07-01T09:00:00Z"),
  shiftEndsAt: new Date("2026-07-01T13:00:00Z"),
  alreadySent: [],
};

// ── Test harness ─────────────────────────────────────────────────────────────

function makeDeps(opts?: {
  candidates?: ShiftReminderCandidate[];
  /** Per-call results for `recordShiftNotification`; defaults to always true. */
  recordResults?: boolean[];
  mailer?: Pick<MailerPort, "send"> | null;
}) {
  const findShiftsNeedingReminder = vi
    .fn()
    .mockResolvedValue(opts?.candidates ?? [baseCandidate]);

  const findEventIdsStillOn = vi.fn(async (ids: string[]) => ids);
  const recordShiftNotification = vi.fn().mockResolvedValue(true);
  for (const result of opts?.recordResults ?? []) {
    recordShiftNotification.mockResolvedValueOnce(result);
  }

  const deleteShiftNotification = vi.fn().mockResolvedValue(undefined);

  // In-app dispatch persists the notification row inside `repos.tx`
  // (DB row backs the polled inbox).
  const notificationsCreate = vi
    .fn()
    .mockResolvedValue({ id: NOTIFICATION_ID, createdAt: NOW });
  const auditLog = vi.fn().mockResolvedValue(undefined);
  const tx = vi.fn(
    async (fn: (txRepos: unknown) => Promise<unknown>): Promise<unknown> =>
      fn({
        notifications: { create: notificationsCreate },
        audit: { log: auditLog },
      }),
  );

  const repos = {
    volunteering: {
      findShiftsNeedingReminder,
      findEventIdsStillOn,
      findEventStartReminderCandidates: vi.fn(async () => []),
      findAskStartReminderCandidates: vi.fn(async () => []),
      findAskIdsStillRemindable: vi.fn(async (ids: string[]) => ids),
      recordShiftNotification,
      deleteShiftNotification,
    },
    tx,
  } as unknown as Repos;

  const send = vi.fn().mockResolvedValue(undefined);
  const mailer =
    opts?.mailer === undefined
      ? ({ send } as unknown as Pick<MailerPort, "send">)
      : opts.mailer;

  const renderEmailTemplate = vi.fn().mockResolvedValue({
    subject: "subject",
    html: "<p>html</p>",
    text: "text",
  });

  const deps: SendVolunteerShiftRemindersDeps = {
    repos,
    clock: { now: () => NOW },
    mailer,
    sms: null,
    renderEmailTemplate:
      renderEmailTemplate as SendVolunteerShiftRemindersDeps["renderEmailTemplate"],
    appBaseUrl: "https://example.test",
  };

  return {
    deps,
    mocks: {
      findShiftsNeedingReminder,
      findEventIdsStillOn,
      recordShiftNotification,
      deleteShiftNotification,
      notificationsCreate,
      auditLog,
      send,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sendVolunteerShiftReminders — in-app channel", () => {
  it("an event cancelled between the candidate read and dispatch: nothing is claimed or sent", async () => {
    const { deps, mocks } = makeDeps();
    mocks.findEventIdsStillOn.mockResolvedValueOnce([]);

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(mocks.findEventIdsStillOn).toHaveBeenCalledWith([EVENT_ID]);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.notificationsCreate).not.toHaveBeenCalled();
    expect(mocks.recordShiftNotification).not.toHaveBeenCalled();
    expect(result.sent).toEqual({ email: 0, sms: 0, inapp: 0 });
  });

  it("a failed still-on read rejects the run with nothing claimed or sent", async () => {
    const { deps, mocks } = makeDeps();
    mocks.findEventIdsStillOn.mockRejectedValueOnce(new Error("db_down"));

    await expect(
      sendVolunteerShiftReminders(deps, { kind: "REMINDER_24H" }),
    ).rejects.toThrow("db_down");

    expect(mocks.recordShiftNotification).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.notificationsCreate).not.toHaveBeenCalled();
  });

  it("persists the notification row for the in-app channel (24h kind)", async () => {
    const { deps, mocks } = makeDeps();

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    // DB persist is the source of truth — it backs the polled inbox
    // list, same row shape as `sendInApp`.
    expect(mocks.notificationsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: HUMAN_ID,
        title: "Reminder: your Summer Fest shift tomorrow",
        kind: "INFO",
        action: {
          label: "Open your signup",
          href: `https://example.test/events/summer-fest`,
        },
      }),
    );
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "human",
        entityId: HUMAN_ID,
        action: "comms.in_app.sent",
      }),
    );

    expect(mocks.recordShiftNotification).toHaveBeenCalledWith({
      signupId: SIGNUP_ID,
      kind: "REMINDER_24H",
      channel: "inapp",
    });
    expect(result.sent.inapp).toBe(1);
    expect(result.failed.inapp).toBe(0);
    // Email fans out alongside in-app.
    expect(result.sent.email).toBe(1);
  });

  it("persists an in-app reminder for the 1h kind too", async () => {
    const { deps, mocks } = makeDeps();

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_1H",
    });

    expect(mocks.notificationsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.recordShiftNotification).toHaveBeenCalledWith({
      signupId: SIGNUP_ID,
      kind: "REMINDER_1H",
      channel: "inapp",
    });
    expect(result.sent.inapp).toBe(1);
  });

  it("skips the in-app channel for shadow signups (humanId null) without throwing", async () => {
    const { deps, mocks } = makeDeps({
      candidates: [{ ...baseCandidate, humanId: null }],
    });

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(mocks.notificationsCreate).not.toHaveBeenCalled();
    // No ledger claim should be written for a channel we never attempt.
    expect(mocks.recordShiftNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: "inapp" }),
    );
    expect(result.sent.inapp).toBe(0);
    expect(result.failed.inapp).toBe(0);
    expect(result.skipped.inapp).toBe(0);
    // The shadow signup still gets its email.
    expect(result.sent.email).toBe(1);
  });

  it("short-circuits when the ledger claim loses the race (recordShiftNotification → false)", async () => {
    // mailer null so the only channel in play is inapp; the single
    // recordShiftNotification call returns false (row already exists).
    const { deps, mocks } = makeDeps({
      mailer: null,
      recordResults: [false],
    });

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(mocks.notificationsCreate).not.toHaveBeenCalled();
    expect(result.skipped.inapp).toBe(1);
    expect(result.sent.inapp).toBe(0);
  });

  it("skips without a ledger round-trip when the candidate's alreadySent includes inapp", async () => {
    const { deps, mocks } = makeDeps({
      mailer: null,
      candidates: [{ ...baseCandidate, alreadySent: ["inapp"] }],
    });

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_1H",
    });

    expect(mocks.notificationsCreate).not.toHaveBeenCalled();
    expect(mocks.recordShiftNotification).not.toHaveBeenCalled();
    expect(result.skipped.inapp).toBe(1);
  });

  it("rolls back the ledger claim when the DB persist throws so the next tick retries", async () => {
    const { deps, mocks } = makeDeps({ mailer: null });
    mocks.notificationsCreate.mockRejectedValueOnce(new Error("db_down"));

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(mocks.deleteShiftNotification).toHaveBeenCalledWith({
      signupId: SIGNUP_ID,
      kind: "REMINDER_24H",
      channel: "inapp",
    });
    expect(result.failed.inapp).toBe(1);
    expect(result.sent.inapp).toBe(0);
  });
});

// ── The email's address line goes through the holder-address gate ───────────
//
// It used to print the Event row's `addressText` unconditionally. A volunteer
// gets what a ticket holder gets: no street before the reveal (a setup shift
// can start before it), none ever for NEVER, the Place's street for a venue
// that withholds its address.

describe("sendVolunteerShiftReminders — address gate", () => {
  const PLACE_ID = "00000000-0000-4000-8000-000000000070";
  const HOUR = 60 * 60 * 1000;

  /** Owned by VENUE_ORG; accepts community listings venue-wide. */
  const VENUE_ORG = "00000000-0000-4000-8000-0000000000e1";
  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    city: "Nashville",
    region: "TN",
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
  };

  async function emailAddressFor(
    eventOverrides: Record<string, unknown>,
    place: unknown = null,
    candidateAddress: string | null = "123 Main St",
  ) {
    const { deps, mocks } = makeDeps({
      candidates: [{ ...baseCandidate, addressText: candidateAddress }],
    });
    const findManyByIds = vi.fn(async () => [
      {
        id: EVENT_ID,
        locationMode: "EXACT",
        locationRadiusMeters: null,
        addressRevealAt: null,
        addressRevealPreset: null,
        placeId: null,
        addressText: "123 Main St",
        locality: "Nashville",
        region: "TN",
        locationLabel: null,
        ...eventOverrides,
      },
    ]);
    const getPlace = vi.fn(async () => place);
    Object.assign(deps.repos, {
      events: { findManyByIds },
      places: { getById: getPlace },
    });

    await sendVolunteerShiftReminders(deps, { kind: "REMINDER_24H" });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const render = deps.renderEmailTemplate as unknown as ReturnType<
      typeof vi.fn
    >;
    return {
      addressText: render.mock.calls[0]![0].props.addressText as
        | string
        | null,
      findManyByIds,
      getPlace,
    };
  }

  it("EXACT: unchanged", async () => {
    expect((await emailAddressFor({})).addressText).toBe("123 Main St");
  });

  it("NEVER: the coarse area, never the street", async () => {
    const { addressText } = await emailAddressFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "NEVER",
      addressRevealAt: null,
    });
    expect(addressText).toBe("Nashville, TN");
  });

  it("before the reveal: the coarse area, never the street", async () => {
    const { addressText } = await emailAddressFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "DAY_BEFORE",
      // The shift is at 2026-07-01T09:00Z; the event is revealed after it.
      addressRevealAt: new Date(NOW.getTime() + 48 * HOUR),
    });
    expect(addressText).toBe("Nashville, TN");
  });

  it("after the reveal at a withheld venue: the Place's street, not the Event projection", async () => {
    const { addressText, getPlace } = await emailAddressFor(
      {
        // The venue's own show.
        orgId: VENUE_ORG,
        stewardship: "OWNED",
        placeId: PLACE_ID,
        locationMode: "OBSCURED",
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(NOW.getTime() - HOUR),
        addressText: "East Nashville",
      },
      withheldPlace,
      "East Nashville",
    );
    expect(getPlace).toHaveBeenCalledWith(PLACE_ID);
    expect(addressText).toBe("901 Porter Rd");
  });

  it("C1: a stranger's UNCONFIRMED event at the house: the coarse area, never the street", async () => {
    const { addressText } = await emailAddressFor(
      {
        orgId: "00000000-0000-4000-8000-0000000000e9",
        stewardship: "OWNED",
        placeId: PLACE_ID,
        locationMode: "OBSCURED",
        addressRevealPreset: "IMMEDIATELY",
        addressRevealAt: new Date(NOW.getTime() - HOUR),
        addressText: "East Nashville",
      },
      withheldPlace,
      "East Nashville",
    );
    expect(addressText).toBe("Nashville, TN");
  });

  it("a candidate with no address reads no events at all", async () => {
    const { addressText, findManyByIds } = await emailAddressFor({}, null, null);
    expect(addressText).toBeNull();
    expect(findManyByIds).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reminder windows vs the */30 tick (2026-09-30: 1h reminders moved from */5
// to */15; 2026-10-08: every */15 cron moved to */30 so Neon can sleep between
// slots, and both windows doubled to stay wider than the tick).
// ─────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const TICK = 30 * MIN;

describe("sendVolunteerShiftReminders — default windows", () => {
  it("DEFAULT_BAND_MS: 24h is +23h30m..+24h30m, 1h is +40m..+80m", async () => {
    const { DEFAULT_BAND_MS } = await import("./send-volunteer-shift-reminders");
    const bounds = (kind: keyof typeof DEFAULT_BAND_MS) => {
      const b = DEFAULT_BAND_MS[kind];
      return [b.offsetMs - b.halfWidthMs, b.offsetMs + b.halfWidthMs];
    };
    expect(bounds("REMINDER_24H")).toEqual([
      (23 * 60 + 30) * MIN,
      (24 * 60 + 30) * MIN,
    ]);
    expect(bounds("REMINDER_1H")).toEqual([40 * MIN, 80 * MIN]);
  });

  it("1h window is +40m..+80m of the tick", async () => {
    const { deps, mocks } = makeDeps({ candidates: [] });

    await sendVolunteerShiftReminders(deps, { kind: "REMINDER_1H" });

    expect(mocks.findShiftsNeedingReminder).toHaveBeenCalledWith({
      kind: "REMINDER_1H",
      windowStart: new Date(NOW.getTime() + 40 * MIN),
      windowEnd: new Date(NOW.getTime() + 80 * MIN),
    });
  });

  it("24h window is +23h30m..+24h30m of the tick", async () => {
    const { deps, mocks } = makeDeps({ candidates: [] });

    await sendVolunteerShiftReminders(deps, { kind: "REMINDER_24H" });

    expect(mocks.findShiftsNeedingReminder).toHaveBeenCalledWith({
      kind: "REMINDER_24H",
      windowStart: new Date(NOW.getTime() + (23 * 60 + 30) * MIN),
      windowEnd: new Date(NOW.getTime() + (24 * 60 + 30) * MIN),
    });
  });

  it.each(["REMINDER_1H", "REMINDER_24H"] as const)(
    "%s: on a */30 tick, even a few seconds late, EVERY minute of a day is inside some window (none silently skipped)",
    async (kind) => {
      const { DEFAULT_BAND_MS } = await import("./send-volunteer-shift-reminders");
      const band = DEFAULT_BAND_MS[kind];
      const DAY = 24 * 60 * MIN;
      const base = Date.parse("2026-10-01T00:00:00.000Z");
      // Worst case jitter: alternate ticks fire 0s and 20s late.
      const windows: Array<[number, number]> = [];
      for (let t = base - DAY; t <= base + 2 * DAY; t += TICK) {
        const fired = t + (((t - base) / TICK) % 2 === 0 ? 0 : 20_000);
        const center = fired + band.offsetMs;
        windows.push([center - band.halfWidthMs, center + band.halfWidthMs]);
      }
      for (let start = base; start < base + DAY; start += MIN) {
        const hits = windows.filter(([a, b]) => start >= a && start < b).length;
        // >= 1: never missed. The per-channel ledger claim turns the overlap
        // (a shift seen by two ticks) into ONE reminder — see "two
        // consecutive ticks" below.
        expect(hits).toBeGreaterThanOrEqual(1);
      }
    },
  );

  it.each([
    ["REMINDER_1H", "2026-10-01T01:07:42.000Z"],
    ["REMINDER_1H", "2026-10-01T01:29:59.000Z"],
    ["REMINDER_24H", "2026-10-02T13:44:13.000Z"],
    ["REMINDER_24H", "2026-10-02T13:59:59.000Z"],
  ] as const)(
    "%s: a shift at an off-tick minute (%s) is inside the window of a :00/:30 tick",
    async (kind, shiftIso) => {
      const { DEFAULT_BAND_MS } = await import("./send-volunteer-shift-reminders");
      const band = DEFAULT_BAND_MS[kind];
      const shiftStart = Date.parse(shiftIso);
      // Every :00/:30 tick in the 30h before the shift.
      const firstTick = Math.floor((shiftStart - 30 * 60 * MIN) / TICK) * TICK;
      let covering = 0;
      for (let t = firstTick; t <= shiftStart; t += TICK) {
        const center = t + band.offsetMs;
        if (
          shiftStart >= center - band.halfWidthMs &&
          shiftStart < center + band.halfWidthMs
        ) {
          covering += 1;
        }
      }
      expect(covering).toBeGreaterThanOrEqual(1);
    },
  );

  it("the PREVIOUS windows (24h ±15m, 1h ±10m) on a */30 tick would skip shifts — the reason they were widened", () => {
    const base = Date.parse("2026-10-01T00:00:00.000Z");
    // Every :00/:30 tick from 24h before `base` to 6h after it.
    const ticks = Array.from({ length: 60 }, (_, k) => base - 48 * TICK + k * TICK);
    const coveredBy = (offset: number, halfWidth: number, shiftStart: number) =>
      ticks.some((t) => {
        const center = t + offset;
        return shiftStart >= center - halfWidth && shiftStart < center + halfWidth;
      });
    // 1h ±10m: ticks at 00:00 and 00:30 cover 00:50-01:10 and 01:20-01:40,
    // so a 01:15 shift fell in the gap.
    expect(coveredBy(60 * MIN, 10 * MIN, base + 75 * MIN)).toBe(false);
    // 24h ±15m: a */30 tick at 00:00 covers +23h45m..+24h15m and the next
    // at 00:30 starts at +24h15m — exactly zero overlap, so a tick even a
    // second late skips the shifts that fell in between. Fire the 00:30
    // tick 20s late and a shift at 00:15:10 the next day is lost.
    const late = 20_000;
    const shift = base + 24 * 60 * MIN + 15 * MIN + 10_000;
    const hit = [base, base + TICK + late].some((t) => {
      const center = t + 24 * 60 * MIN;
      return shift >= center - 15 * MIN && shift < center + 15 * MIN;
    });
    expect(hit).toBe(false);
  });

  it("the OLD 1h window (±5m) on a */15 tick would have skipped shifts — the reason it was first widened", () => {
    const QUARTER = 15 * MIN;
    const halfWidth = 5 * MIN;
    const base = Date.parse("2026-10-01T00:00:00.000Z");
    const shiftStart = base + 60 * MIN + 7 * MIN; // 01:07
    const covered = [0, 1, 2, 3, 4, 5, 6, 7, 8].some((k) => {
      const center = base + k * QUARTER + 60 * MIN;
      return shiftStart >= center - halfWidth && shiftStart < center + halfWidth;
    });
    expect(covered).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Two consecutive */30 ticks see the same shift (every 1h window overlaps the
// next by 10 min, every 24h window by 30 min). The ledger fake below models
// the real adapter: `findShiftsNeedingReminder` filters APPROVED shifts to
// [windowStart, windowEnd) and derives `alreadySent` from the ledger, and
// `recordShiftNotification` is an INSERT ... ON CONFLICT DO NOTHING keyed by
// signup × kind × channel (createMany skipDuplicates, `count === 1`).
// ─────────────────────────────────────────────────────────────────────────────

describe("sendVolunteerShiftReminders — two consecutive ticks, one reminder per channel", () => {
  function makeLedgerHarness(opts: {
    shiftStartsAt: Date;
    /** Hand every read an empty `alreadySent`, as if both ticks read before either claimed. */
    staleReads?: boolean;
    contactPhone?: string;
    eventTitle?: string;
  }) {
    let now = new Date(0);
    const ledger = new Set<string>();
    const key = (signupId: string, kind: string, channel: string) =>
      `${signupId}|${kind}|${channel}`;
    const candidate: ShiftReminderCandidate = {
      ...baseCandidate,
      contactPhone: opts.contactPhone ?? "+16125550123",
      ...(opts.eventTitle ? { eventTitle: opts.eventTitle } : {}),
      smsOptIn: true,
      shiftStartsAt: opts.shiftStartsAt,
      shiftEndsAt: new Date(opts.shiftStartsAt.getTime() + 4 * 60 * MIN),
    };

    const findShiftsNeedingReminder = vi.fn(
      async (args: { kind: string; windowStart: Date; windowEnd: Date }) => {
        const t = candidate.shiftStartsAt.getTime();
        if (t < args.windowStart.getTime() || t >= args.windowEnd.getTime()) {
          return [];
        }
        const alreadySent = opts.staleReads
          ? []
          : (["email", "inapp", "sms"] as const).filter((ch) =>
              ledger.has(key(candidate.signupId, args.kind, ch)),
            );
        return [{ ...candidate, alreadySent: [...alreadySent] }];
      },
    );
    const recordShiftNotification = vi.fn(
      async (args: { signupId: string; kind: string; channel: string }) => {
        const k = key(args.signupId, args.kind, args.channel);
        if (ledger.has(k)) return false;
        ledger.add(k);
        return true;
      },
    );
    const deleteShiftNotification = vi.fn(
      async (args: { signupId: string; kind: string; channel: string }) => {
        ledger.delete(key(args.signupId, args.kind, args.channel));
      },
    );
    const notificationsCreate = vi
      .fn()
      .mockResolvedValue({ id: NOTIFICATION_ID, createdAt: NOW });
    const getByPhone = vi.fn().mockResolvedValue(null);
    const repos = {
      volunteering: {
        findShiftsNeedingReminder,
        findEventIdsStillOn: vi.fn(async (ids: string[]) => ids),
        findEventStartReminderCandidates: vi.fn(async () => []),
        findAskStartReminderCandidates: vi.fn(async () => []),
        findAskIdsStillRemindable: vi.fn(async (ids: string[]) => ids),
        recordShiftNotification,
        deleteShiftNotification,
      },
      smsConsent: { getByPhone },
      tx: vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
        fn({
          notifications: { create: notificationsCreate },
          audit: { log: vi.fn().mockResolvedValue(undefined) },
        }),
      ),
    } as unknown as Repos;

    const mailSend = vi.fn().mockResolvedValue(undefined);
    const smsSend = vi.fn().mockResolvedValue(undefined);
    const deps: SendVolunteerShiftRemindersDeps = {
      repos,
      clock: { now: () => now },
      mailer: { send: mailSend } as unknown as Pick<MailerPort, "send">,
      sms: { send: smsSend } as unknown as SendVolunteerShiftRemindersDeps["sms"],
      renderEmailTemplate: vi.fn().mockResolvedValue({
        subject: "subject",
        html: "<p>html</p>",
        text: "text",
      }) as SendVolunteerShiftRemindersDeps["renderEmailTemplate"],
      appBaseUrl: "https://example.test",
    };
    return {
      deps,
      setNow: (d: Date) => {
        now = d;
      },
      mailSend,
      smsSend,
      notificationsCreate,
      findShiftsNeedingReminder,
      getByPhone,
    };
  }

  it.each([
    // 1h: 09:30 → [10:10, 10:50), 10:00 → [10:40, 11:20); 10:45 is in both.
    ["REMINDER_1H", "2026-10-01T10:45:00.000Z", "2026-10-01T09:30:00.000Z"],
    // 24h: 09:00 → [+08:30, +09:30), 09:30 → [+09:00, +10:00); +09:10 is in both.
    ["REMINDER_24H", "2026-10-02T09:10:00.000Z", "2026-10-01T09:00:00.000Z"],
  ] as const)(
    "%s: a shift at %s, in the windows of the %s tick and the next, gets ONE email, ONE SMS, ONE in-app",
    async (kind, shiftIso, firstTickIso) => {
      const h = makeLedgerHarness({ shiftStartsAt: new Date(shiftIso) });
      const first = new Date(firstTickIso);
      const second = new Date(first.getTime() + TICK);

      h.setNow(first);
      const r1 = await sendVolunteerShiftReminders(h.deps, { kind });
      h.setNow(second);
      const r2 = await sendVolunteerShiftReminders(h.deps, { kind });

      // Both ticks really did see the shift — the overlap is real.
      expect(r1.candidates).toBe(1);
      expect(r2.candidates).toBe(1);
      expect(r1.sent).toEqual({ email: 1, sms: 1, inapp: 1 });
      expect(r2.sent).toEqual({ email: 0, sms: 0, inapp: 0 });
      expect(r2.skipped).toEqual({ email: 1, sms: 1, inapp: 1 });
      expect(h.mailSend).toHaveBeenCalledTimes(1);
      expect(h.smsSend).toHaveBeenCalledTimes(1);
      expect(h.smsSend).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "notification" }),
      );
      expect(h.notificationsCreate).toHaveBeenCalledTimes(1);
    },
  );

  it("a stale read (second tick sees alreadySent empty) still sends once: the unique claim decides", async () => {
    const h = makeLedgerHarness({
      shiftStartsAt: new Date("2026-10-01T10:45:00.000Z"),
      staleReads: true,
    });
    const first = new Date("2026-10-01T09:30:00.000Z");

    h.setNow(first);
    const r1 = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });
    h.setNow(new Date(first.getTime() + TICK));
    const r2 = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    expect(r1.sent).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(r2.sent).toEqual({ email: 0, sms: 0, inapp: 0 });
    expect(h.mailSend).toHaveBeenCalledTimes(1);
    expect(h.smsSend).toHaveBeenCalledTimes(1);
    expect(h.notificationsCreate).toHaveBeenCalledTimes(1);
  });

  it("a channel that failed on the first tick is retried (once) by the second", async () => {
    const h = makeLedgerHarness({
      shiftStartsAt: new Date("2026-10-01T10:45:00.000Z"),
    });
    h.smsSend.mockRejectedValueOnce(new Error("sns_5xx"));
    const first = new Date("2026-10-01T09:30:00.000Z");

    h.setNow(first);
    const r1 = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });
    h.setNow(new Date(first.getTime() + TICK));
    const r2 = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    expect(r1.sent).toEqual({ email: 1, sms: 0, inapp: 1 });
    expect(r1.failed.sms).toBe(1);
    expect(r2.sent).toEqual({ email: 0, sms: 1, inapp: 0 });
    expect(h.mailSend).toHaveBeenCalledTimes(1);
    expect(h.smsSend).toHaveBeenCalledTimes(2);
    expect(h.notificationsCreate).toHaveBeenCalledTimes(1);
  });

  it("an SMS the provider refuses as invalid_input is skipped for good: no rollback, no retry, one report without the number", async () => {
    const h = makeLedgerHarness({
      shiftStartsAt: new Date("2026-10-01T10:45:00.000Z"),
    });
    h.smsSend.mockRejectedValue(
      new CommsPortError(
        "invalid_input",
        "destination +16125550123 is not a US number",
      ),
    );
    const reportError = vi.fn();
    h.deps.reportError = reportError;
    const first = new Date("2026-10-01T09:30:00.000Z");

    h.setNow(first);
    const r1 = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });
    h.setNow(new Date(first.getTime() + TICK));
    const r2 = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    expect(r1.sent).toEqual({ email: 1, sms: 0, inapp: 1 });
    expect(r1.failed.sms).toBe(0);
    expect(r1.skipped.sms).toBe(1);
    // The claim stayed, so the second tick does not try again.
    expect(r2.skipped.sms).toBe(1);
    expect(h.smsSend).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0]!;
    expect(ctx).toMatchObject({
      tags: { stage: "sms_invalid_destination" },
      extra: { channel: "sms" },
    });
    expect(String((err as Error).message)).not.toContain("5550123");
    expect(JSON.stringify(ctx)).not.toContain("5550123");
  });

  it("a row opted in with a number kept as typed sends to its E.164 form", async () => {
    const h = makeLedgerHarness({
      shiftStartsAt: new Date("2026-10-01T10:45:00.000Z"),
      contactPhone: "(612) 555-0123",
    });
    h.setNow(new Date("2026-10-01T09:30:00.000Z"));

    const r = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    expect(r.sent.sms).toBe(1);
    expect(h.smsSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: { toE164: "+16125550123" } }),
    );
    // The consent ledger is read by the same E.164 key a STOP writes.
    expect(h.getByPhone).toHaveBeenCalledWith("+16125550123");
  });

  it("a stored number we do not text is never sent, skipped for good, reported once without the number", async () => {
    const h = makeLedgerHarness({
      shiftStartsAt: new Date("2026-10-01T10:45:00.000Z"),
      contactPhone: "+14165550123",
    });
    const reportError = vi.fn();
    h.deps.reportError = reportError;
    const first = new Date("2026-10-01T09:30:00.000Z");

    h.setNow(first);
    const r1 = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });
    h.setNow(new Date(first.getTime() + TICK));
    const r2 = await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    expect(h.smsSend).not.toHaveBeenCalled();
    expect(r1.skipped.sms).toBe(1);
    expect(r1.failed.sms).toBe(0);
    expect(r2.skipped.sms).toBe(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0]!;
    expect(ctx).toMatchObject({ tags: { stage: "sms_invalid_destination" } });
    expect(String((err as Error).message)).not.toContain("5550123");
    expect(JSON.stringify(ctx)).not.toContain("5550123");
  });

  // The 1h reminder lands 40 to 80 minutes ahead, so "in 1 hour" was wrong
  // by up to 20 minutes either way. The SMS names the start instead, in the
  // event's own timezone.
  it("the 1h SMS names the shift's local start time, not 'in 1 hour'", async () => {
    const h = makeLedgerHarness({
      shiftStartsAt: new Date("2026-10-01T10:45:00.000Z"),
    });
    h.setNow(new Date("2026-10-01T09:30:00.000Z"));

    await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    const body = (h.smsSend.mock.calls[0]?.[0] as { body: string }).body;
    // 10:45Z is 6:45 AM in America/New_York (baseCandidate.eventTimezone).
    expect(body).toContain("starts at 6:45 AM EDT");
    expect(body).not.toContain("in 1 hour");
    // GSM-7 only: no narrow no-break space from ICU before AM/PM.
    expect(body).toMatch(/^[\x20-\x7E]*$/);
  });

  it("a long event title is cut with ASCII '...' so the SMS stays GSM-7/ASCII", async () => {
    const h = makeLedgerHarness({
      shiftStartsAt: new Date("2026-10-01T10:45:00.000Z"),
      eventTitle: `${"Extraordinarily Long Festival of Lights ".repeat(3)}\u2014 \u201Cfinale\u201D \u2026`,
    });
    h.setNow(new Date("2026-10-01T09:30:00.000Z"));

    await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    const body = (h.smsSend.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("...");
    expect(body).not.toContain("\u2026");
    expect(body).toMatch(/^[\x20-\x7E]*$/);
  });

  it("the 24h SMS still says 'tomorrow'", async () => {
    const h = makeLedgerHarness({
      shiftStartsAt: new Date("2026-10-02T09:10:00.000Z"),
    });
    h.setNow(new Date("2026-10-01T09:00:00.000Z"));

    await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_24H" });

    const body = (h.smsSend.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("starts tomorrow");
    // The text names its sender (carriers expect the brand).
    expect(body.startsWith('Ithas Fire: Reminder: your "')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Swallowed failures are REPORTED (CLAUDE.md, "Error Reporting Convention").
// Each branch below catches and carries on so one bad channel cannot sink the
// batch, and the jobs process has no pino→Sentry bridge: without reportError
// these were log lines nobody saw.
// ─────────────────────────────────────────────────────────────────────────────

describe("sendVolunteerShiftReminders — swallowed failures reach reportError", () => {
  const stageOf = (call: unknown[]) =>
    (call[1] as { tags?: { stage?: string } } | undefined)?.tags?.stage;

  it("claim_failed: a ledger claim that throws is reported, and the channel counts as failed", async () => {
    const { deps, mocks } = makeDeps({ mailer: null });
    const reportError = vi.fn();
    deps.reportError = reportError;
    const claimError = new Error("db_down");
    mocks.recordShiftNotification.mockRejectedValueOnce(claimError);

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_1H",
    });

    expect(result.failed.inapp).toBe(1);
    expect(mocks.notificationsCreate).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(claimError, {
      tags: {
        useCase: "volunteering.sendShiftReminders",
        stage: "claim_failed",
      },
      extra: { signupId: SIGNUP_ID, kind: "REMINDER_1H", channel: "inapp" },
    });
  });

  it("dispatch_failed: a send that throws is reported after its claim is rolled back", async () => {
    const { deps, mocks } = makeDeps();
    const reportError = vi.fn();
    deps.reportError = reportError;
    const sendError = new Error("resend_503");
    mocks.send.mockRejectedValueOnce(sendError);

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(result.failed.email).toBe(1);
    expect(result.sent.inapp).toBe(1);
    expect(mocks.deleteShiftNotification).toHaveBeenCalledWith({
      signupId: SIGNUP_ID,
      kind: "REMINDER_24H",
      channel: "email",
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(sendError, {
      tags: {
        useCase: "volunteering.sendShiftReminders",
        stage: "dispatch_failed",
      },
      extra: { signupId: SIGNUP_ID, kind: "REMINDER_24H", channel: "email" },
    });
  });

  it("rollback_failed: a rollback that throws is reported too — that reminder is now lost for good", async () => {
    const { deps, mocks } = makeDeps({ mailer: null });
    const reportError = vi.fn();
    deps.reportError = reportError;
    const persistError = new Error("db_down");
    const rollbackError = new Error("db_still_down");
    mocks.notificationsCreate.mockRejectedValueOnce(persistError);
    mocks.deleteShiftNotification.mockRejectedValueOnce(rollbackError);

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(result.failed.inapp).toBe(1);
    expect(reportError.mock.calls.map(stageOf)).toEqual([
      "rollback_failed",
      "dispatch_failed",
    ]);
    expect(reportError.mock.calls[0]?.[0]).toEqual(rollbackError);
    expect(reportError.mock.calls[1]?.[0]).toEqual(persistError);
  });

  it("provider errors that echo a phone number reach no log line or report with it", async () => {
    const { deps, mocks } = makeDeps();
    const reportError = vi.fn();
    const logged: unknown[] = [];
    const sink = (...args: unknown[]) => void logged.push(args);
    deps.reportError = reportError;
    deps.logger = {
      info: sink,
      warn: sink,
      error: sink,
      debug: sink,
      child: () => deps.logger,
    } as unknown as SendVolunteerShiftRemindersDeps["logger"];
    const echo = (what: string) =>
      new Error(`${what} for +16155550100 (615) 555-0100`);
    // email claims, then its send and rollback fail; the next claim fails.
    mocks.recordShiftNotification
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(echo("claim"));
    mocks.send.mockRejectedValueOnce(
      new CommsPortError("rate_limited", "send for +16155550100"),
    );
    mocks.deleteShiftNotification.mockRejectedValueOnce(echo("rollback"));

    await sendVolunteerShiftReminders(deps, { kind: "REMINDER_24H" });

    expect(reportError.mock.calls.map(stageOf).sort()).toEqual(
      ["claim_failed", "dispatch_failed", "rollback_failed"].sort(),
    );
    for (const [err] of reportError.mock.calls) {
      expect((err as Error).stack).toBeDefined();
    }
    const everything = JSON.stringify([
      logged,
      reportError.mock.calls.map(([err, ctx]) => [
        (err as Error).message,
        (err as Error).stack,
        ctx,
      ]),
    ]);
    expect(everything).not.toContain("5550100");
    expect(everything).toContain("[redacted]");
    // The scrubbed copy has no code; the tag reads it from the original.
    const dispatch = reportError.mock.calls.find(
      (call) => stageOf(call) === "dispatch_failed",
    );
    expect(dispatch?.[1]).toMatchObject({ tags: { errorCode: "rate_limited" } });
  });

  it("a throwing reporter changes nothing: same counts, rollback still runs, next channel still sends", async () => {
    const { deps, mocks } = makeDeps();
    deps.reportError = vi.fn(() => {
      throw new Error("sentry_down");
    });
    mocks.send.mockRejectedValueOnce(new Error("resend_503"));

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(result.failed.email).toBe(1);
    expect(result.sent.inapp).toBe(1);
    expect(mocks.deleteShiftNotification).toHaveBeenCalledTimes(1);
    expect(mocks.notificationsCreate).toHaveBeenCalledTimes(1);
  });

  it("with no reporter wired, the batch behaves the same", async () => {
    const { deps, mocks } = makeDeps();
    mocks.send.mockRejectedValueOnce(new Error("resend_503"));

    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(result.failed.email).toBe(1);
    expect(result.sent.inapp).toBe(1);
  });
});

// The email template renders the shift window in this zone; without it a UTC
// server mailed a 7pm Chicago shift as the next day (prod, 2026-10-13).
describe("sendVolunteerShiftReminders — email carries the event's timezone", () => {
  it("passes the candidate's eventTimezone to the template", async () => {
    const { deps, mocks } = makeDeps({
      candidates: [
        {
          ...baseCandidate,
          eventTimezone: "America/Chicago",
          // 2026-10-12 19:00–22:00 CDT.
          shiftStartsAt: new Date("2026-10-13T00:00:00.000Z"),
          shiftEndsAt: new Date("2026-10-13T03:00:00.000Z"),
        },
      ],
    });
    Object.assign(deps.repos, {
      events: {
        findManyByIds: vi.fn(async () => [
          {
            id: EVENT_ID,
            locationMode: "EXACT",
            locationRadiusMeters: null,
            addressRevealAt: null,
            addressRevealPreset: null,
            placeId: null,
            addressText: null,
            locality: null,
            region: null,
            locationLabel: null,
          },
        ]),
      },
      places: { getById: vi.fn(async () => null) },
    });

    await sendVolunteerShiftReminders(deps, { kind: "REMINDER_24H" });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const render = deps.renderEmailTemplate as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(render.mock.calls[0]![0].props).toMatchObject({
      shiftStartsAtISO: "2026-10-13T00:00:00.000Z",
      timezone: "America/Chicago",
    });
  });
});
