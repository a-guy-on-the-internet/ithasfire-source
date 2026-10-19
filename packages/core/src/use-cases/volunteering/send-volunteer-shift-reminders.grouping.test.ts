import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MailerPort } from "@th/ports/comms/mailer";
import type {
  AskStartReminderCandidate,
  EventStartReminderCandidate,
  ShiftReminderCandidate,
} from "@th/ports/repos/volunteering";

import { renderNotification } from "../comms/renderers";
import {
  SMS_MAX_CHARS,
  sendVolunteerShiftReminders,
} from "./send-volunteer-shift-reminders";
import type { SendVolunteerShiftRemindersDeps } from "./send-volunteer-shift-reminders";

/**
 * volunteer-ask-reminders R12 / FR-008: one person's signups on the same
 * event or ask starting at the same instant (shift or shiftless role), share
 * ONE text, ONE email and ONE in-app notice naming every role. The ledger
 * stays per signup.
 */

const SIGNUP_A = "00000000-0000-4000-8000-0000000000a1";
const SIGNUP_B = "00000000-0000-4000-8000-0000000000b2";
const SIGNUP_C = "00000000-0000-4000-8000-0000000000c3";
const HUMAN_ID = "00000000-0000-4000-8000-000000000050";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ASK_ID = "00000000-0000-4000-8000-000000000007";
const ASK_ID_2 = "00000000-0000-4000-8000-000000000008";
const PHONE = "+16125550123";
const PHONE_2 = "+16125550199";
const MIN = 60_000;
const TICK = 30 * MIN;

const START = new Date("2026-10-02T09:10:00.000Z");
// 09:00 → [+08:30, +09:30), 09:30 → [+09:00, +10:00): +09:10 is in both.
const FIRST_TICK = new Date("2026-10-01T09:00:00.000Z");

const ask = (
  signupId: string,
  roleName: string,
  over: Partial<AskStartReminderCandidate> = {},
): AskStartReminderCandidate => ({
  signupId,
  humanId: HUMAN_ID,
  contactEmail: "vol@example.com",
  contactName: "Vol Unteer",
  contactPhone: PHONE,
  smsOptIn: true,
  askId: ASK_ID,
  askTitle: "River cleanup day",
  askSubjectType: "PLACE",
  askCadence: "ONE_TIME",
  askStartsAt: START,
  askEndsAt: new Date(START.getTime() + 4 * 60 * MIN),
  askTimezone: "America/New_York",
  roleName,
  alreadySent: [],
  ...over,
});

const eventRole = (
  signupId: string,
  roleName: string,
  over: Partial<EventStartReminderCandidate> = {},
): EventStartReminderCandidate => ({
  signupId,
  humanId: HUMAN_ID,
  contactEmail: "vol@example.com",
  contactName: "Vol Unteer",
  contactPhone: PHONE,
  smsOptIn: true,
  eventId: EVENT_ID,
  eventTitle: "Summer Fest",
  eventSlug: "summer-fest",
  eventTimezone: "America/New_York",
  addressText: null,
  roleName,
  eventStartsAt: START,
  eventEndsAt: new Date(START.getTime() + 3 * 60 * MIN),
  alreadySent: [],
  ...over,
});

const shift = (
  signupId: string,
  roleName: string,
  over: Partial<ShiftReminderCandidate> = {},
): ShiftReminderCandidate => ({
  signupId,
  humanId: HUMAN_ID,
  contactEmail: "vol@example.com",
  contactName: "Vol Unteer",
  contactPhone: PHONE,
  smsOptIn: true,
  eventId: EVENT_ID,
  eventTitle: "Summer Fest",
  eventSlug: "summer-fest",
  eventTimezone: "America/New_York",
  addressText: null,
  roleName,
  shiftLabel: null,
  shiftStartsAt: START,
  shiftEndsAt: new Date(START.getTime() + 4 * 60 * MIN),
  alreadySent: [],
  ...over,
});

/**
 * A harness with a real (in-memory) ledger: each read returns its rows when
 * the anchor's start is inside the window, with `alreadySent` from the
 * ledger, and the claim is unique per (signup, kind, channel). The row
 * arrays are read on every call, so a test can push a signup approved
 * between ticks.
 */
function makeHarness(opts: {
  shifts?: ShiftReminderCandidate[];
  events?: EventStartReminderCandidate[];
  asks?: AskStartReminderCandidate[];
  smsSend?: ReturnType<typeof vi.fn>;
  optedOut?: string[];
}) {
  let now = FIRST_TICK;
  const ledger = new Set<string>();
  const key = (signupId: string, kind: string, channel: string) =>
    `${signupId}|${kind}|${channel}`;
  const shifts = opts.shifts ?? [];
  const events = opts.events ?? [];
  const asks = opts.asks ?? [];

  function inWindow<T extends { signupId: string }>(
    rows: T[],
    startOf: (row: T) => Date,
  ) {
    return vi.fn(
      async (args: { kind: string; windowStart: Date; windowEnd: Date }) =>
        rows
          .filter((row) => {
            const t = startOf(row).getTime();
            return (
              t >= args.windowStart.getTime() && t < args.windowEnd.getTime()
            );
          })
          .map((row) => ({
            ...row,
            alreadySent: (["email", "inapp", "sms"] as const).filter((ch) =>
              ledger.has(key(row.signupId, args.kind, ch)),
            ),
          })),
    );
  }

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
    .mockResolvedValue({ id: "n1", createdAt: FIRST_TICK });
  const repos = {
    volunteering: {
      findShiftsNeedingReminder: inWindow(shifts, (r) => r.shiftStartsAt),
      findEventStartReminderCandidates: inWindow(
        events,
        (r) => r.eventStartsAt,
      ),
      findAskStartReminderCandidates: inWindow(asks, (r) => r.askStartsAt),
      findEventIdsStillOn: vi.fn(async (ids: string[]) => ids),
      findAskIdsStillRemindable: vi.fn(async (ids: string[]) => ids),
      recordShiftNotification,
      deleteShiftNotification,
    },
    events: { findManyByIds: vi.fn(async () => []) },
    places: { getById: vi.fn(async () => null) },
    smsConsent: {
      getByPhone: vi.fn(async (phone: string) =>
        opts.optedOut?.includes(phone) ? { status: "OPTED_OUT" } : null,
      ),
    },
    tx: vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
      fn({
        notifications: { create: notificationsCreate },
        audit: { log: vi.fn().mockResolvedValue(undefined) },
      }),
    ),
  } as unknown as Repos;

  const mailSend = vi.fn().mockResolvedValue(undefined);
  const smsSend = opts.smsSend ?? vi.fn().mockResolvedValue(undefined);
  const renderEmailTemplate = vi.fn().mockResolvedValue({
    subject: "subject",
    html: "<p>html</p>",
    text: "text",
  });
  const reportError = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: SendVolunteerShiftRemindersDeps = {
    repos,
    clock: { now: () => now },
    mailer: { send: mailSend } as unknown as Pick<MailerPort, "send">,
    sms: { send: smsSend } as unknown as SendVolunteerShiftRemindersDeps["sms"],
    renderEmailTemplate:
      renderEmailTemplate as SendVolunteerShiftRemindersDeps["renderEmailTemplate"],
    appBaseUrl: "https://example.test/",
    logger: logger as unknown as SendVolunteerShiftRemindersDeps["logger"],
    reportError,
  };
  const run = (at: Date, kind: "REMINDER_24H" | "REMINDER_1H" = "REMINDER_24H") => {
    now = at;
    return sendVolunteerShiftReminders(deps, { kind });
  };
  return {
    deps,
    run,
    ledger,
    asks,
    mailSend,
    smsSend,
    renderEmailTemplate,
    notificationsCreate,
    recordShiftNotification,
    deleteShiftNotification,
    reportError,
    logger,
  };
}

type Harness = ReturnType<typeof makeHarness>;

const smsCalls = (h: Harness) =>
  h.smsSend.mock.calls.map(
    (c) =>
      c[0] as {
        body: string;
        to: { toE164: string };
        metadata: Record<string, string>;
        idempotencyKey: string;
      },
  );
const emailProps = (h: Harness) =>
  h.renderEmailTemplate.mock.calls.map(
    (c) => c[0] as { templateId: string; props: Record<string, unknown> },
  );
const inAppRows = (h: Harness) =>
  h.notificationsCreate.mock.calls.map(
    (c) =>
      c[0] as {
        title: string;
        body: string;
        metadata: Record<string, string>;
        template: { key: string; variables: Record<string, unknown> };
      },
  );

const SECOND_TICK = new Date(FIRST_TICK.getTime() + TICK);

describe("grouped reminders: two roles on one ask", () => {
  it("one text, one email and one in-app notice naming both; every member's rows claimed", async () => {
    const h = makeHarness({
      asks: [ask(SIGNUP_A, "Litter picker"), ask(SIGNUP_B, "Check-in table")],
    });
    const r = await h.run(FIRST_TICK);

    expect(r.candidates).toBe(2);
    // Signups per channel, and one message per channel.
    expect(r.sent).toEqual({ email: 2, sms: 2, inapp: 2 });
    expect(r.messages).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(r.failed).toEqual({ email: 0, sms: 0, inapp: 0 });

    expect(h.smsSend).toHaveBeenCalledTimes(1);
    expect(h.mailSend).toHaveBeenCalledTimes(1);
    expect(h.notificationsCreate).toHaveBeenCalledTimes(1);

    const [sms] = smsCalls(h);
    expect(sms!.body).toBe(
      "Ithas Fire: Reminder: River cleanup day starts tomorrow. You're volunteering as Litter picker and Check-in table. Reply STOP to unsubscribe.",
    );
    expect(sms!.body.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(sms!.metadata).toEqual({
      signupId: SIGNUP_A,
      signupIds: `${SIGNUP_A},${SIGNUP_B}`,
      askId: ASK_ID,
      kind: "REMINDER_24H",
    });
    // A group's provider key is not either member's single key.
    expect(sms!.idempotencyKey).toMatch(
      /^vol-shift-rem:group:[0-9a-f]{32}:REMINDER_24H:sms$/,
    );

    const [email] = emailProps(h);
    expect(email!.templateId).toBe("volunteer.start_reminder");
    expect(email!.props).toMatchObject({
      anchor: "ask",
      roleName: "Litter picker",
      roleNames: ["Litter picker", "Check-in table"],
      manageUrl: `https://example.test/v/${ASK_ID}`,
    });

    const [row] = inAppRows(h);
    expect(row!.body).toBe(
      "Tomorrow at 5:10 AM EDT — you're volunteering as Litter picker and Check-in table at River cleanup day.",
    );
    expect(row!.template.variables).toMatchObject({
      signupId: SIGNUP_A,
      roleNames: ["Litter picker", "Check-in table"],
      signupIds: [SIGNUP_A, SIGNUP_B],
    });

    // Every member's row on every channel: 2 signups × 3 channels.
    expect([...h.ledger].sort()).toEqual(
      [SIGNUP_A, SIGNUP_B]
        .flatMap((id) =>
          ["email", "inapp", "sms"].map((ch) => `${id}|REMINDER_24H|${ch}`),
        )
        .sort(),
    );
  });

  it("two overlapping ticks resend nothing", async () => {
    const h = makeHarness({
      asks: [ask(SIGNUP_A, "Litter picker"), ask(SIGNUP_B, "Check-in table")],
    });
    await h.run(FIRST_TICK);
    const r2 = await h.run(SECOND_TICK);

    expect(r2.sent).toEqual({ email: 0, sms: 0, inapp: 0 });
    expect(r2.messages).toEqual({ email: 0, sms: 0, inapp: 0 });
    expect(r2.skipped).toEqual({ email: 2, sms: 2, inapp: 2 });
    expect(h.smsSend).toHaveBeenCalledTimes(1);
    expect(h.mailSend).toHaveBeenCalledTimes(1);
    expect(h.notificationsCreate).toHaveBeenCalledTimes(1);
  });

  it("a stale second tick (alreadySent read empty) loses every claim and sends nothing", async () => {
    const h = makeHarness({
      asks: [ask(SIGNUP_A, "Litter picker"), ask(SIGNUP_B, "Check-in table")],
    });
    await h.run(FIRST_TICK);
    // The read raced the first tick's claims: it saw no rows.
    const readAsks = h.deps.repos.volunteering
      .findAskStartReminderCandidates as ReturnType<typeof vi.fn>;
    readAsks.mockResolvedValueOnce(h.asks.map((a) => ({ ...a })));
    const r2 = await h.run(SECOND_TICK);

    expect(r2.messages).toEqual({ email: 0, sms: 0, inapp: 0 });
    expect(r2.skipped).toEqual({ email: 2, sms: 2, inapp: 2 });
    expect(h.smsSend).toHaveBeenCalledTimes(1);
  });

  it("one member already sent, a second approved later inside the band: one message naming only the new role", async () => {
    const h = makeHarness({ asks: [ask(SIGNUP_A, "Litter picker")] });
    await h.run(FIRST_TICK);
    h.asks.push(ask(SIGNUP_B, "Check-in table"));
    const r2 = await h.run(SECOND_TICK);

    expect(r2.sent).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(r2.skipped).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(r2.messages).toEqual({ email: 1, sms: 1, inapp: 1 });
    const second = smsCalls(h)[1]!;
    expect(second.body).toBe(
      "Ithas Fire: Reminder: River cleanup day starts tomorrow. You're volunteering as Check-in table. Reply STOP to unsubscribe.",
    );
    // A single member keeps its own key, as before grouping.
    expect(second.idempotencyKey).toBe(
      `vol-shift-rem:${SIGNUP_B}:REMINDER_24H:sms`,
    );
    expect(emailProps(h)[1]!.props).not.toHaveProperty("roleNames");
    expect(inAppRows(h)[1]!.template.variables).not.toHaveProperty(
      "roleNames",
    );
  });

  it("an SMS that fails rolls back both members, reports once without the number, and the next tick sends once", async () => {
    const smsSend = vi
      .fn()
      .mockRejectedValueOnce(new Error(`SNS 503 publishing to ${PHONE}`))
      .mockResolvedValue(undefined);
    const h = makeHarness({
      asks: [ask(SIGNUP_A, "Litter picker"), ask(SIGNUP_B, "Check-in table")],
      smsSend,
    });
    const r1 = await h.run(FIRST_TICK);

    expect(r1.failed.sms).toBe(2);
    expect(r1.messages.sms).toBe(0);
    expect(r1.sent.email).toBe(2);
    for (const signupId of [SIGNUP_A, SIGNUP_B]) {
      expect(h.deleteShiftNotification).toHaveBeenCalledWith({
        signupId,
        kind: "REMINDER_24H",
        channel: "sms",
      });
    }
    const reports = h.reportError.mock.calls.filter(
      ([, ctx]) =>
        (ctx as { tags: { stage: string } }).tags.stage === "dispatch_failed",
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      extra: { signupId: SIGNUP_A, signupIds: [SIGNUP_A, SIGNUP_B] },
    });
    const reported = JSON.stringify([
      (reports[0]![0] as Error).message,
      reports[0]![1],
      h.logger.error.mock.calls,
    ]);
    expect(reported).not.toContain("5550123");

    const r2 = await h.run(SECOND_TICK);
    expect(r2.sent.sms).toBe(2);
    expect(r2.messages.sms).toBe(1);
    expect(r2.messages.email).toBe(0);
    expect(smsSend).toHaveBeenCalledTimes(2);
    expect(smsCalls(h)[1]!.body).toContain(
      "as Litter picker and Check-in table.",
    );
    // The retry carries the same key, so the provider dedupes a send that
    // went out before the error.
    expect(smsCalls(h)[1]!.idempotencyKey).toBe(smsCalls(h)[0]!.idempotencyKey);
  });

  it("an opted-out phone: the group is checked once, nothing is claimed or sent", async () => {
    const h = makeHarness({
      asks: [ask(SIGNUP_A, "Litter picker"), ask(SIGNUP_B, "Check-in table")],
      optedOut: [PHONE],
    });
    const r = await h.run(FIRST_TICK);

    expect(r.skipped.sms).toBe(2);
    expect(r.messages.sms).toBe(0);
    expect(h.smsSend).not.toHaveBeenCalled();
    expect(h.recordShiftNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms" }),
    );
    const getByPhone = h.deps.repos.smsConsent.getByPhone as ReturnType<
      typeof vi.fn
    >;
    expect(getByPhone).toHaveBeenCalledTimes(1);
  });
});

describe("grouped reminders: partial failures inside a group", () => {
  it("one member's claim throws: it is reported and counted failed, the other is sent alone, and the next tick sends it", async () => {
    // SMS only, so counts and keys are about one channel.
    const only = { humanId: null, contactEmail: "vol@example.com" };
    const h = makeHarness({
      asks: [
        ask(SIGNUP_A, "Litter picker", only),
        ask(SIGNUP_B, "Check-in table", only),
      ],
    });
    h.deps.mailer = null;
    const record = h.recordShiftNotification;
    const real = record.getMockImplementation()!;
    record.mockImplementation(async (args) => {
      if (args.signupId === SIGNUP_B && args.channel === "sms")
        throw new Error(`db timeout for ${PHONE}`);
      return real(args);
    });

    const r1 = await h.run(FIRST_TICK);
    expect(r1.failed.sms).toBe(1);
    expect(r1.sent.sms).toBe(1);
    expect(r1.messages.sms).toBe(1);
    const [first] = smsCalls(h);
    expect(first!.body).toContain("You're volunteering as Litter picker.");
    expect(first!.idempotencyKey).toBe(
      `vol-shift-rem:${SIGNUP_A}:REMINDER_24H:sms`,
    );
    const claimReports = h.reportError.mock.calls.filter(
      ([, ctx]) =>
        (ctx as { tags: { stage: string } }).tags.stage === "claim_failed",
    );
    expect(claimReports).toHaveLength(1);
    expect(claimReports[0]![1]).toMatchObject({
      extra: { signupId: SIGNUP_B, channel: "sms" },
    });
    expect(
      JSON.stringify([
        (claimReports[0]![0] as Error).message,
        claimReports[0]![1],
        h.logger.warn.mock.calls,
      ]),
    ).not.toContain("5550123");

    record.mockImplementation(real);
    const r2 = await h.run(SECOND_TICK);
    expect(r2.sent.sms).toBe(1);
    expect(r2.skipped.sms).toBe(1);
    expect(r2.messages.sms).toBe(1);
    const second = smsCalls(h)[1]!;
    expect(second.body).toContain("You're volunteering as Check-in table.");
    expect(second.idempotencyKey).toBe(
      `vol-shift-rem:${SIGNUP_B}:REMINDER_24H:sms`,
    );
  });

  it("a failed group send whose rollback throws for one member: the other is still rolled back, one report each", async () => {
    const only = { humanId: null };
    const smsSend = vi
      .fn()
      .mockRejectedValueOnce(new Error(`SNS 503 publishing to ${PHONE}`))
      .mockResolvedValue(undefined);
    const h = makeHarness({
      asks: [
        ask(SIGNUP_A, "Litter picker", only),
        ask(SIGNUP_B, "Check-in table", only),
      ],
      smsSend,
    });
    h.deps.mailer = null;
    const del = h.deleteShiftNotification;
    const realDelete = del.getMockImplementation()!;
    del.mockImplementation(async (args) => {
      if (args.signupId === SIGNUP_A)
        throw new Error(`rollback lost, phone ${PHONE}`);
      return realDelete(args);
    });

    const r1 = await h.run(FIRST_TICK);
    expect(r1.failed.sms).toBe(2);
    expect(del).toHaveBeenCalledTimes(2);
    expect(h.ledger.has(`${SIGNUP_A}|REMINDER_24H|sms`)).toBe(true);
    expect(h.ledger.has(`${SIGNUP_B}|REMINDER_24H|sms`)).toBe(false);

    const stages = h.reportError.mock.calls.map(
      ([, ctx]) => (ctx as { tags: { stage: string } }).tags.stage,
    );
    expect(stages.filter((s) => s === "dispatch_failed")).toHaveLength(1);
    expect(stages.filter((s) => s === "rollback_failed")).toHaveLength(1);
    const rollback = h.reportError.mock.calls.find(
      ([, ctx]) =>
        (ctx as { tags: { stage: string } }).tags.stage === "rollback_failed",
    )!;
    expect(rollback[1]).toMatchObject({ extra: { signupId: SIGNUP_A } });
    expect(
      JSON.stringify([
        h.reportError.mock.calls.map(([e, ctx]) => [(e as Error).message, ctx]),
        h.logger.error.mock.calls,
      ]),
    ).not.toContain("5550123");

    // A's row stayed claimed (lost for good, reported); B is retried alone.
    del.mockImplementation(realDelete);
    const r2 = await h.run(SECOND_TICK);
    expect(r2.sent.sms).toBe(1);
    expect(r2.skipped.sms).toBe(1);
    expect(smsCalls(h)[1]!.body).toContain(
      "You're volunteering as Check-in table.",
    );
  });
});

describe("grouped reminders: what stays separate", () => {
  it("different phones on the same ask: separate texts (one shared email and notice)", async () => {
    const h = makeHarness({
      asks: [
        ask(SIGNUP_A, "Litter picker"),
        ask(SIGNUP_B, "Check-in table", { contactPhone: PHONE_2 }),
      ],
    });
    const r = await h.run(FIRST_TICK);

    expect(r.messages).toEqual({ email: 1, sms: 2, inapp: 1 });
    expect(smsCalls(h).map((c) => c.to.toE164)).toEqual([PHONE, PHONE_2]);
  });

  it("the same phone, written two ways, is one destination", async () => {
    const h = makeHarness({
      asks: [
        ask(SIGNUP_A, "Litter picker"),
        ask(SIGNUP_B, "Check-in table", {
          contactPhone: "(612) 555-0123",
          contactEmail: " VOL@Example.com ",
        }),
      ],
    });
    const r = await h.run(FIRST_TICK);
    expect(r.messages).toEqual({ email: 1, sms: 1, inapp: 1 });
  });

  it("the same phone on different asks: separate texts", async () => {
    const h = makeHarness({
      asks: [
        ask(SIGNUP_A, "Litter picker"),
        ask(SIGNUP_B, "Check-in table", {
          askId: ASK_ID_2,
          askTitle: "Park planting",
        }),
      ],
    });
    const r = await h.run(FIRST_TICK);

    expect(r.messages).toEqual({ email: 2, sms: 2, inapp: 2 });
    expect(smsCalls(h).map((c) => c.metadata.askId)).toEqual([
      ASK_ID,
      ASK_ID_2,
    ]);
  });

  it("two shifts at different times: separate", async () => {
    const h = makeHarness({
      shifts: [
        shift(SIGNUP_A, "Security"),
        shift(SIGNUP_B, "Bar", {
          shiftStartsAt: new Date(START.getTime() + 10 * MIN),
        }),
      ],
    });
    const r = await h.run(FIRST_TICK);

    expect(r.messages).toEqual({ email: 2, sms: 2, inapp: 2 });
    expect(smsCalls(h).map((c) => c.body)).toEqual([
      'Ithas Fire: Reminder: your "Security" shift at Summer Fest starts tomorrow. Reply STOP to unsubscribe.',
      'Ithas Fire: Reminder: your "Bar" shift at Summer Fest starts tomorrow. Reply STOP to unsubscribe.',
    ]);
  });

  it("a shift starting before the event start and a shiftless role: different start times, separate", async () => {
    const h = makeHarness({
      // The shift at 08:40, the event (and so the shiftless role) at 09:10.
      shifts: [
        shift(SIGNUP_A, "Security", {
          shiftStartsAt: new Date(START.getTime() - 30 * MIN),
        }),
      ],
      events: [eventRole(SIGNUP_B, "Greeter")],
    });
    const r = await h.run(FIRST_TICK);
    expect(r.messages).toEqual({ email: 2, sms: 2, inapp: 2 });
    expect(smsCalls(h).map((c) => c.body)).toEqual([
      'Ithas Fire: Reminder: your "Security" shift at Summer Fest starts tomorrow. Reply STOP to unsubscribe.',
      "Ithas Fire: Reminder: Summer Fest starts tomorrow. You're volunteering as Greeter. Reply STOP to unsubscribe.",
    ]);
  });
});

describe("grouped reminders: a shift at the event start joins the start reminder", () => {
  it("SHIFT + EVENT_START at the event's start: one text, email and notice, start form, both roles, both rows claimed", async () => {
    const h = makeHarness({
      shifts: [shift(SIGNUP_A, "Security", { shiftLabel: "Gate A" })],
      events: [eventRole(SIGNUP_B, "Greeter")],
    });
    const r = await h.run(FIRST_TICK);

    expect(r.byAnchor).toEqual({ shift: 1, eventStart: 1, askStart: 0 });
    expect(r.sent).toEqual({ email: 2, sms: 2, inapp: 2 });
    expect(r.messages).toEqual({ email: 1, sms: 1, inapp: 1 });

    const [sms] = smsCalls(h);
    expect(sms!.body).toBe(
      "Ithas Fire: Reminder: Summer Fest starts tomorrow. You're volunteering as Greeter and Security. Reply STOP to unsubscribe.",
    );
    expect(sms!.metadata).toEqual({
      signupId: SIGNUP_B,
      signupIds: `${SIGNUP_B},${SIGNUP_A}`,
      eventId: EVENT_ID,
      kind: "REMINDER_24H",
    });
    expect(sms!.idempotencyKey).toMatch(
      /^vol-shift-rem:group:[0-9a-f]{32}:REMINDER_24H:sms$/,
    );

    const [email] = emailProps(h);
    expect(email!.templateId).toBe("volunteer.start_reminder");
    expect(email!.props).toMatchObject({
      anchor: "event",
      title: "Summer Fest",
      roleName: "Greeter",
      roleNames: ["Greeter", "Security"],
      manageUrl: "https://example.test/events/summer-fest",
    });

    const [row] = inAppRows(h);
    expect(row!.template.key).toBe("volunteer.start-reminder-in-app");
    expect(row!.body).toBe(
      "Tomorrow at 5:10 AM EDT — you're volunteering as Greeter and Security at Summer Fest.",
    );
    expect(`${row!.title} ${row!.body} ${sms!.body}`).not.toMatch(/shift/i);

    expect([...h.ledger].sort()).toEqual(
      [SIGNUP_A, SIGNUP_B]
        .flatMap((id) =>
          ["email", "inapp", "sms"].map((ch) => `${id}|REMINDER_24H|${ch}`),
        )
        .sort(),
    );

    // An overlapping tick resends nothing.
    const r2 = await h.run(SECOND_TICK);
    expect(r2.messages).toEqual({ email: 0, sms: 0, inapp: 0 });
  });

  it("two shifts at a start other than the event's: the shift form, the start reminder apart", async () => {
    const h = makeHarness({
      // The event (and its shiftless role) starts at 08:40; both shifts at 09:10.
      shifts: [shift(SIGNUP_A, "Security"), shift(SIGNUP_B, "Bar")],
      events: [
        eventRole(SIGNUP_C, "Greeter", {
          eventStartsAt: new Date(START.getTime() - 30 * MIN),
        }),
      ],
    });
    const r = await h.run(FIRST_TICK);
    expect(r.messages).toEqual({ email: 2, sms: 2, inapp: 2 });
    expect(smsCalls(h).map((c) => c.body)).toEqual([
      "Ithas Fire: Reminder: your shifts at Summer Fest start tomorrow (Security and Bar). Reply STOP to unsubscribe.",
      "Ithas Fire: Reminder: Summer Fest starts tomorrow. You're volunteering as Greeter. Reply STOP to unsubscribe.",
    ]);
    expect(emailProps(h).map((e) => e.templateId)).toEqual([
      "volunteer.shift_reminder",
      "volunteer.start_reminder",
    ]);
  });
});

describe("grouped reminders: shifts at the same start", () => {
  it("two shifts of one event at the same instant: one text, one email listing both, one notice", async () => {
    const h = makeHarness({
      shifts: [
        shift(SIGNUP_A, "Security", { shiftLabel: "Gate A" }),
        shift(SIGNUP_B, "Bar", {
          shiftLabel: null,
          shiftEndsAt: new Date(START.getTime() + 2 * 60 * MIN),
        }),
      ],
    });
    const r = await h.run(FIRST_TICK);

    expect(r.messages).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(smsCalls(h)[0]!.body).toBe(
      "Ithas Fire: Reminder: your shifts at Summer Fest start tomorrow (Security and Bar). Reply STOP to unsubscribe.",
    );

    const [email] = emailProps(h);
    expect(email!.templateId).toBe("volunteer.shift_reminder");
    expect(email!.props).toMatchObject({
      roleName: "Security",
      manageUrl: "https://example.test/events/summer-fest",
      roles: [
        {
          roleName: "Security",
          shiftLabel: "Gate A",
          shiftEndsAtISO: new Date(START.getTime() + 4 * 60 * MIN).toISOString(),
        },
        {
          roleName: "Bar",
          shiftLabel: null,
          shiftEndsAtISO: new Date(START.getTime() + 2 * 60 * MIN).toISOString(),
        },
      ],
    });

    const [row] = inAppRows(h);
    expect(row!.title).toBe("Reminder: your Summer Fest shifts tomorrow");
    expect(row!.body).toBe(
      "Tomorrow — your shifts at Summer Fest: Security (Gate A) and Bar.",
    );
  });

  it("a shiftless role group links to the event page, never a per-signup link", async () => {
    const h = makeHarness({
      events: [eventRole(SIGNUP_A, "Greeter"), eventRole(SIGNUP_B, "Runner")],
    });
    await h.run(FIRST_TICK);
    expect(emailProps(h)[0]!.props.manageUrl).toBe(
      "https://example.test/events/summer-fest",
    );
    expect(smsCalls(h)[0]!.body).toBe(
      "Ithas Fire: Reminder: Summer Fest starts tomorrow. You're volunteering as Greeter and Runner. Reply STOP to unsubscribe.",
    );
  });
});

describe("grouped SMS copy stays in one segment", () => {
  it("three roles read '<first> and 2 more'", async () => {
    const h = makeHarness({
      asks: [
        ask(SIGNUP_A, "Litter picker"),
        ask(SIGNUP_B, "Check-in table"),
        ask(SIGNUP_C, "Water station"),
      ],
    });
    await h.run(FIRST_TICK);
    expect(smsCalls(h)[0]!.body).toBe(
      "Ithas Fire: Reminder: River cleanup day starts tomorrow. You're volunteering as Litter picker and 2 more. Reply STOP to unsubscribe.",
    );
    // Email and in-app name all three.
    expect(emailProps(h)[0]!.props.roleNames).toEqual([
      "Litter picker",
      "Check-in table",
      "Water station",
    ]);
    expect(inAppRows(h)[0]!.body).toContain(
      "as Litter picker, Check-in table and Water station at",
    );
  });

  it("the 'Volunteer' fallback is dropped from a list with real roles", async () => {
    const h = makeHarness({
      asks: [ask(SIGNUP_A, "Volunteer"), ask(SIGNUP_B, "Check-in table")],
    });
    await h.run(FIRST_TICK);
    expect(smsCalls(h)[0]!.body).toContain(
      "You're volunteering as Check-in table. Reply",
    );
    expect(emailProps(h)[0]!.props).toMatchObject({
      roleName: "Check-in table",
    });
    expect(emailProps(h)[0]!.props).not.toHaveProperty("roleNames");

    // In-app names the real role too, as stored and re-rendered in Spanish.
    const [row] = inAppRows(h);
    expect(row!.body).toBe(
      "Tomorrow at 5:10 AM EDT — you're volunteering as Check-in table at River cleanup day.",
    );
    expect(row!.template.variables).toMatchObject({
      roleName: "Check-in table",
      roleNames: ["Volunteer", "Check-in table"],
    });
    const es = renderNotification(row!.template.key, row!.template.variables, {
      now: FIRST_TICK,
      locale: "es",
    }).inApp!;
    expect(es.body).toBe(
      "Mañana, a las 5:10 (GMT-4) — tu voluntariado en River cleanup day como Check-in table.",
    );
  });

  it("an all-'Volunteer' group names no role, in every channel and language", async () => {
    const h = makeHarness({
      asks: [ask(SIGNUP_A, "Volunteer"), ask(SIGNUP_B, "Volunteer")],
    });
    const r = await h.run(FIRST_TICK);
    expect(r.messages).toEqual({ email: 1, sms: 1, inapp: 1 });
    const body = smsCalls(h)[0]!.body;
    expect(body.endsWith("You're volunteering. Reply STOP to unsubscribe.")).toBe(
      true,
    );
    expect(emailProps(h)[0]!.props.roleName).toBeNull();
    expect(emailProps(h)[0]!.props).not.toHaveProperty("roleNames");

    const [row] = inAppRows(h);
    expect(row!.body).toBe(
      "Tomorrow at 5:10 AM EDT — you're volunteering at River cleanup day.",
    );
    const es = renderNotification(row!.template.key, row!.template.variables, {
      now: FIRST_TICK,
      locale: "es",
    }).inApp!;
    expect(es.body).toBe(
      "Mañana, a las 5:10 (GMT-4) — tu voluntariado en River cleanup day.",
    );
  });

  it("a row stored with the fallback as its roleName still names the real role", () => {
    const variables = {
      signupId: SIGNUP_A,
      anchor: "ASK_START",
      eventId: null,
      askId: ASK_ID,
      title: "River cleanup day",
      roleName: "Volunteer",
      kind: "REMINDER_24H",
      startsAtIso: START.toISOString(),
      timezone: "America/New_York",
      manageUrl: `https://ithas.fire/v/${ASK_ID}`,
      roleNames: ["Volunteer", "Check-in table"],
      signupIds: [SIGNUP_A, SIGNUP_B],
    };
    const body = (locale: "en" | "es") =>
      renderNotification("volunteer.start-reminder-in-app", variables, {
        now: FIRST_TICK,
        locale,
      }).inApp!.body;
    expect(body("en")).toContain("you're volunteering as Check-in table at");
    expect(body("es")).toContain("como Check-in table.");
  });

  const LONG_TITLE =
    "The Annual Riverside Community Cleanup and Planting Festival Weekend";
  const LONG_ROLE_1 = "Senior volunteer coordinator for the north entrance";
  const LONG_ROLE_2 = "Assistant check-in table and wristband distribution";
  const LONG_ROLE_3 = "Hydration and first aid station runner";
  // A zone whose short name is long ("GMT+5:30"), on the 1h clock-time form.
  const LONG_ZONE = "Asia/Kolkata";

  const assertOneSegment = (body: string) => {
    expect(body.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(body).toMatch(/^[\x20-\x7E]+$/);
    expect(body.startsWith("Ithas Fire: Reminder: ")).toBe(true);
    expect(body.endsWith(". Reply STOP to unsubscribe.")).toBe(true);
  };

  it.each([
    ["two roles", [LONG_ROLE_1, LONG_ROLE_2]],
    ["three roles", [LONG_ROLE_1, LONG_ROLE_2, LONG_ROLE_3]],
  ])("worst-case ask (1h, long zone, %s) is at most 160 characters", async (_, roles) => {
    const h = makeHarness({
      asks: roles.map((roleName, i) =>
        ask([SIGNUP_A, SIGNUP_B, SIGNUP_C][i]!, roleName, {
          askTitle: LONG_TITLE,
          askTimezone: LONG_ZONE,
          // Inside the 1h band of FIRST_TICK.
          askStartsAt: new Date(FIRST_TICK.getTime() + 60 * MIN),
        }),
      ),
    });
    await h.run(FIRST_TICK, "REMINDER_1H");
    const body = smsCalls(h)[0]!.body;
    assertOneSegment(body);
    expect(body).toContain("GMT+5:30");
    expect(body).toContain(roles.length === 2 ? " and " : " and 2 more");
  });

  it("worst-case shift group (1h, long zone, long names) is at most 160 characters", async () => {
    const at = new Date(FIRST_TICK.getTime() + 60 * MIN);
    const h = makeHarness({
      shifts: [LONG_ROLE_1, LONG_ROLE_2, LONG_ROLE_3].map((roleName, i) =>
        shift([SIGNUP_A, SIGNUP_B, SIGNUP_C][i]!, roleName, {
          eventTitle: LONG_TITLE,
          eventTimezone: LONG_ZONE,
          shiftLabel: "An extremely long shift label for the morning",
          shiftStartsAt: at,
        }),
      ),
    });
    await h.run(FIRST_TICK, "REMINDER_1H");
    const body = smsCalls(h)[0]!.body;
    assertOneSegment(body);
    expect(body).toContain("and 2 more)");
  });

  it("a single shift with long names now fits one segment too", async () => {
    const h = makeHarness({
      shifts: [
        shift(SIGNUP_A, LONG_ROLE_1, {
          eventTitle: LONG_TITLE,
          eventTimezone: LONG_ZONE,
          shiftLabel: "An extremely long shift label for the morning",
          shiftStartsAt: new Date(FIRST_TICK.getTime() + 60 * MIN),
        }),
      ],
    });
    await h.run(FIRST_TICK, "REMINDER_1H");
    assertOneSegment(smsCalls(h)[0]!.body);
  });
});

describe("grouped in-app notices re-render in the reader's language", () => {
  const render = (
    row: { template: { key: string; variables: unknown } },
    locale: "en" | "es",
  ) =>
    renderNotification(row.template.key, row.template.variables, {
      now: FIRST_TICK,
      locale,
    }).inApp!;

  it("a grouped ask notice: English as stored, Spanish lists every role", async () => {
    const h = makeHarness({
      asks: [ask(SIGNUP_A, "Litter picker"), ask(SIGNUP_B, "Check-in table")],
    });
    await h.run(FIRST_TICK);
    const [row] = inAppRows(h);

    expect(render(row!, "en").body).toBe(row!.body);
    expect(render(row!, "es").body).toBe(
      "Mañana, a las 5:10 (GMT-4) — tu voluntariado en River cleanup day como Litter picker y Check-in table.",
    );
  });

  it("a grouped shift notice: Spanish names the shifts", async () => {
    const h = makeHarness({
      shifts: [
        shift(SIGNUP_A, "Security", { shiftLabel: "Gate A" }),
        shift(SIGNUP_B, "Bar"),
      ],
    });
    await h.run(FIRST_TICK);
    const [row] = inAppRows(h);

    expect(render(row!, "en").title).toBe(row!.title);
    expect(render(row!, "en").body).toBe(row!.body);
    expect(render(row!, "es")).toMatchObject({
      title: "Recordatorio: tus turnos de voluntariado en Summer Fest son mañana",
      body: "Mañana — tus turnos en Summer Fest: Security (Gate A) y Bar.",
    });
  });

  it("rows stored before grouping (no role list) still render, in both languages", () => {
    const oldShift = {
      template: {
        key: "volunteer.shift-reminder-in-app",
        variables: {
          signupId: SIGNUP_A,
          eventId: EVENT_ID,
          eventTitle: "Summer Fest",
          roleName: "Security",
          shiftLabel: "Morning",
          kind: "REMINDER_24H",
          manageUrl: `https://ithas.fire/events/summer-fest/volunteer?signup=${SIGNUP_A}`,
        },
      },
    };
    expect(render(oldShift, "en").body).toBe(
      "Tomorrow — your Security shift (Morning) at Summer Fest.",
    );
    expect(render(oldShift, "es").body).toBe(
      "Mañana — tu turno de Security (Morning) en Summer Fest.",
    );

    const oldStart = {
      template: {
        key: "volunteer.start-reminder-in-app",
        variables: {
          signupId: SIGNUP_A,
          anchor: "ASK_START",
          eventId: null,
          askId: ASK_ID,
          title: "River cleanup day",
          roleName: "Litter picker",
          kind: "REMINDER_24H",
          startsAtIso: START.toISOString(),
          timezone: "America/New_York",
          manageUrl: `https://ithas.fire/v/${ASK_ID}`,
        },
      },
    };
    expect(render(oldStart, "en").body).toBe(
      "Tomorrow at 5:10 AM EDT — you're volunteering as Litter picker at River cleanup day.",
    );
    expect(render(oldStart, "es").body).toBe(
      "Mañana, a las 5:10 (GMT-4) — tu voluntariado en River cleanup day como Litter picker.",
    );
  });
});
