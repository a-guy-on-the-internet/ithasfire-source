import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MailerPort } from "@th/ports/comms/mailer";
import type {
  AskStartReminderCandidate,
  EventStartReminderCandidate,
  ShiftReminderCandidate,
} from "@th/ports/repos/volunteering";

import { renderNotification } from "../comms/renderers";
import { sendVolunteerShiftReminders } from "./send-volunteer-shift-reminders";
import type { SendVolunteerShiftRemindersDeps } from "./send-volunteer-shift-reminders";

/**
 * volunteer-ask-reminders: the same dispatcher reminds a shiftless event role
 * before the EVENT starts and a one-time ask before the ASK starts, through
 * the same ledger, fan-out and reporting as shift reminders.
 */

const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const HUMAN_ID = "00000000-0000-4000-8000-000000000050";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ASK_ID = "00000000-0000-4000-8000-000000000007";
const PHONE = "+16125550123";
const MIN = 60_000;
const TICK = 30 * MIN;

const START = new Date("2026-10-02T09:10:00.000Z");
// 09:00 → [+08:30, +09:30), 09:30 → [+09:00, +10:00): +09:10 is in both.
const FIRST_TICK = new Date("2026-10-01T09:00:00.000Z");

const askCandidate: AskStartReminderCandidate = {
  signupId: SIGNUP_ID,
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
  roleName: "Litter picker",
  alreadySent: [],
};

const eventCandidate: EventStartReminderCandidate = {
  signupId: SIGNUP_ID,
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
  roleName: "Security",
  eventStartsAt: START,
  eventEndsAt: new Date(START.getTime() + 3 * 60 * MIN),
  alreadySent: [],
};

const shiftCandidate: ShiftReminderCandidate = {
  signupId: SIGNUP_ID,
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
  roleName: "Security",
  shiftLabel: "Morning",
  shiftStartsAt: START,
  shiftEndsAt: new Date(START.getTime() + 4 * 60 * MIN),
  alreadySent: [],
};

type Anchored = { startsAt: Date };

/**
 * A harness with a real (in-memory) ledger: each read returns its rows when
 * the anchor's start is inside the window, with `alreadySent` from the
 * ledger, and the claim is unique per (signup, kind, channel).
 */
function makeHarness(opts: {
  shifts?: ShiftReminderCandidate[];
  events?: EventStartReminderCandidate[];
  asks?: AskStartReminderCandidate[];
  eventsStillOn?: string[];
  asksStillOn?: string[];
  smsSend?: ReturnType<typeof vi.fn>;
}) {
  let now = FIRST_TICK;
  const ledger = new Set<string>();
  const key = (signupId: string, kind: string, channel: string) =>
    `${signupId}|${kind}|${channel}`;

  function inWindow<T extends { signupId: string }>(
    rows: T[],
    startOf: (row: T) => Anchored["startsAt"],
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

  const findShiftsNeedingReminder = inWindow(
    opts.shifts ?? [],
    (r) => r.shiftStartsAt,
  );
  const findEventStartReminderCandidates = inWindow(
    opts.events ?? [],
    (r) => r.eventStartsAt,
  );
  const findAskStartReminderCandidates = inWindow(
    opts.asks ?? [],
    (r) => r.askStartsAt,
  );
  const findEventIdsStillOn = vi.fn(async (ids: string[]) =>
    opts.eventsStillOn
      ? ids.filter((id) => opts.eventsStillOn!.includes(id))
      : ids,
  );
  const findAskIdsStillRemindable = vi.fn(async (ids: string[]) =>
    opts.asksStillOn ? ids.filter((id) => opts.asksStillOn!.includes(id)) : ids,
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
    .mockResolvedValue({ id: "n1", createdAt: FIRST_TICK });
  const auditLog = vi.fn().mockResolvedValue(undefined);
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
    },
  ]);
  const repos = {
    volunteering: {
      findShiftsNeedingReminder,
      findEventStartReminderCandidates,
      findAskStartReminderCandidates,
      findEventIdsStillOn,
      findAskIdsStillRemindable,
      recordShiftNotification,
      deleteShiftNotification,
    },
    events: { findManyByIds },
    places: { getById: vi.fn(async () => null) },
    smsConsent: { getByPhone: vi.fn().mockResolvedValue(null) },
    tx: vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
      fn({
        notifications: { create: notificationsCreate },
        audit: { log: auditLog },
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
  return {
    deps,
    setNow: (d: Date) => {
      now = d;
    },
    mailSend,
    smsSend,
    renderEmailTemplate,
    notificationsCreate,
    auditLog,
    recordShiftNotification,
    deleteShiftNotification,
    findEventIdsStillOn,
    findAskIdsStillRemindable,
    reportError,
    logger,
  };
}

async function twoTicks(h: ReturnType<typeof makeHarness>) {
  h.setNow(FIRST_TICK);
  const r1 = await sendVolunteerShiftReminders(h.deps, {
    kind: "REMINDER_24H",
  });
  h.setNow(new Date(FIRST_TICK.getTime() + TICK));
  const r2 = await sendVolunteerShiftReminders(h.deps, {
    kind: "REMINDER_24H",
  });
  return { r1, r2 };
}

const renderCall = (h: ReturnType<typeof makeHarness>) =>
  h.renderEmailTemplate.mock.calls[0]![0] as {
    templateId: string;
    props: Record<string, unknown>;
  };

describe("ask-start reminders", () => {
  it("a ONE_TIME ask: one email, one SMS, one in-app across two overlapping ticks", async () => {
    const h = makeHarness({ asks: [askCandidate] });
    const { r1, r2 } = await twoTicks(h);

    expect(r1.candidates).toBe(1);
    expect(r1.byAnchor).toEqual({ shift: 0, eventStart: 0, askStart: 1 });
    expect(r2.candidates).toBe(1);
    expect(r1.sent).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(r2.sent).toEqual({ email: 0, sms: 0, inapp: 0 });
    expect(r2.skipped).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(h.mailSend).toHaveBeenCalledTimes(1);
    expect(h.smsSend).toHaveBeenCalledTimes(1);
    expect(h.notificationsCreate).toHaveBeenCalledTimes(1);
    // The same ledger as shifts: one row per (signup, kind, channel).
    expect(h.recordShiftNotification).toHaveBeenCalledWith({
      signupId: SIGNUP_ID,
      kind: "REMINDER_24H",
      channel: "sms",
    });
  });

  it("names the ask and its start, links to /v/<askId>, never an address or a shift", async () => {
    const h = makeHarness({ asks: [askCandidate] });
    await twoTicks(h);

    const sms = h.smsSend.mock.calls[0]![0] as {
      body: string;
      to: { toE164: string };
      tags: string[];
      metadata: Record<string, string>;
    };
    expect(sms.body).toBe(
      "Ithas Fire: Reminder: River cleanup day starts tomorrow. You're volunteering as Litter picker. Reply STOP to unsubscribe.",
    );
    expect(sms.body.length).toBeLessThanOrEqual(160);
    expect(sms.body).not.toMatch(/shift/i);
    expect(sms.to.toE164).toBe(PHONE);
    expect(sms.tags).toEqual(["volunteer", "ask", "reminder", "24h"]);
    expect(sms.metadata).toEqual({
      signupId: SIGNUP_ID,
      askId: ASK_ID,
      kind: "REMINDER_24H",
    });

    expect(renderCall(h)).toEqual({
      templateId: "volunteer.start_reminder",
      props: {
        anchor: "ask",
        title: "River cleanup day",
        roleName: "Litter picker",
        startsAtISO: START.toISOString(),
        endsAtISO: askCandidate.askEndsAt!.toISOString(),
        timezone: "America/New_York",
        kindLabel: "Tomorrow",
        manageUrl: `https://example.test/v/${ASK_ID}`,
      },
    });

    const row = h.notificationsCreate.mock.calls[0]![0] as {
      title: string;
      body: string;
      action: { href: string };
      metadata: Record<string, string>;
    };
    expect(row.title).toBe("Reminder: River cleanup day starts tomorrow");
    expect(row.body).toBe(
      "Tomorrow at 5:10 AM EDT — you're volunteering as Litter picker at River cleanup day.",
    );
    expect(row.body).not.toMatch(/shift/i);
    expect(row.action.href).toBe(`https://example.test/v/${ASK_ID}`);
    expect(row.metadata).toEqual({
      signupId: SIGNUP_ID,
      askId: ASK_ID,
      kind: "REMINDER_24H",
      variant: "volunteer.start-reminder-in-app",
    });
  });

  it("the stored in-app template re-renders in Spanish", async () => {
    const h = makeHarness({ asks: [askCandidate] });
    await twoTicks(h);
    const row = h.notificationsCreate.mock.calls[0]![0] as {
      title: string;
      body: string;
      template: { key: string; variables: unknown };
    };
    const render = (locale: "en" | "es") =>
      renderNotification(row.template.key, row.template.variables, {
        now: FIRST_TICK,
        locale,
      }).inApp!;
    // Re-rendered English is what was stored.
    expect([render("en").title, render("en").body]).toEqual([
      row.title,
      row.body,
    ]);
    expect(render("es").title).toBe(
      "Recordatorio: River cleanup day empieza mañana",
    );
    expect(render("es").body).toBe(
      "Mañana, a las 5:10 (GMT-4) — tu voluntariado en River cleanup day como Litter picker.",
    );
  });

  it("null endsAt: the email carries no end", async () => {
    const h = makeHarness({ asks: [{ ...askCandidate, askEndsAt: null }] });
    await twoTicks(h);
    expect(renderCall(h).props.endsAtISO).toBeNull();
  });

  it("null timezone (no place zone either): the platform default zone, named, never UTC", async () => {
    const h = makeHarness({ asks: [{ ...askCandidate, askTimezone: null }] });
    // 08:00 → 1h window [08:40, 09:20) holds 09:10.
    h.setNow(new Date("2026-10-02T08:00:00.000Z"));
    await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    expect(renderCall(h).props.timezone).toBe("America/Chicago");
    const body = (h.smsSend.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain("starts at 4:10 AM CDT.");
    expect(body).not.toContain("UTC");
    expect(body).toMatch(/^[\x20-\x7E]+$/);
    const row = h.notificationsCreate.mock.calls[0]![0] as {
      template: { variables: { timezone: string } };
    };
    expect(row.template.variables.timezone).toBe("America/Chicago");
  });

  it("a stated ask zone (America/New_York) renders in SMS, email props and in-app, zone named", async () => {
    const h = makeHarness({ asks: [askCandidate] });
    h.setNow(new Date("2026-10-02T08:00:00.000Z"));
    await sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_1H" });

    expect(renderCall(h).props.timezone).toBe("America/New_York");
    const body = (h.smsSend.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain("starts at 5:10 AM EDT.");
    expect(body).not.toContain("CDT");
    const row = h.notificationsCreate.mock.calls[0]![0] as {
      body: string;
      template: { variables: { timezone: string } };
    };
    expect(row.body).toContain("5:10 AM EDT");
    expect(row.template.variables.timezone).toBe("America/New_York");
  });

  it("the stored 'Volunteer' fallback role is named nowhere", async () => {
    const h = makeHarness({
      asks: [{ ...askCandidate, roleName: "Volunteer" }],
    });
    await twoTicks(h);
    expect(renderCall(h).props.roleName).toBeNull();
    const sms = (h.smsSend.mock.calls[0]![0] as { body: string }).body;
    expect(sms).toBe(
      "Ithas Fire: Reminder: River cleanup day starts tomorrow. You're volunteering. Reply STOP to unsubscribe.",
    );
  });

  it("an ONGOING row that slipped past the read sends nothing and is reported", async () => {
    const h = makeHarness({
      asks: [{ ...askCandidate, askCadence: "ONGOING" }],
    });
    const { r1 } = await twoTicks(h);

    expect(r1.byAnchor.askStart).toBe(0);
    expect(r1.sent).toEqual({ email: 0, sms: 0, inapp: 0 });
    expect(h.recordShiftNotification).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: "anchor_mismatch" }),
      }),
    );
  });

  it("an ask archived (or its owner withheld) between the read and dispatch: nothing claimed or sent", async () => {
    // The adapter's still-remindable re-check covers DRAFT, ARCHIVED and a
    // withheld owner; any of them drops the ask from its answer.
    const h = makeHarness({ asks: [askCandidate], asksStillOn: [] });
    const { r1 } = await twoTicks(h);

    expect(h.findAskIdsStillRemindable).toHaveBeenCalledWith([ASK_ID]);
    expect(h.recordShiftNotification).not.toHaveBeenCalled();
    expect(h.mailSend).not.toHaveBeenCalled();
    expect(h.smsSend).not.toHaveBeenCalled();
    expect(r1.skipped).toEqual({ email: 1, sms: 1, inapp: 1 });
  });

  it("a failed still-remindable read rejects the run with nothing claimed", async () => {
    const h = makeHarness({ asks: [askCandidate] });
    h.findAskIdsStillRemindable.mockRejectedValueOnce(new Error("db_down"));
    await expect(
      sendVolunteerShiftReminders(h.deps, { kind: "REMINDER_24H" }),
    ).rejects.toThrow("db_down");
    expect(h.recordShiftNotification).not.toHaveBeenCalled();
  });

  it("a failed SMS is rolled back and reported without the phone number", async () => {
    const smsSend = vi
      .fn()
      .mockRejectedValue(new Error(`SNS 503 publishing to ${PHONE}`));
    const h = makeHarness({ asks: [askCandidate], smsSend });
    h.setNow(FIRST_TICK);
    const r = await sendVolunteerShiftReminders(h.deps, {
      kind: "REMINDER_24H",
    });

    expect(r.failed.sms).toBe(1);
    expect(r.sent.email).toBe(1);
    expect(h.deleteShiftNotification).toHaveBeenCalledWith({
      signupId: SIGNUP_ID,
      kind: "REMINDER_24H",
      channel: "sms",
    });
    const call = h.reportError.mock.calls.find(
      ([, ctx]) =>
        (ctx as { tags: { stage: string } }).tags.stage === "dispatch_failed",
    );
    expect(call).toBeDefined();
    const reported = JSON.stringify([
      (call![0] as Error).message,
      call![1],
      h.logger.error.mock.calls,
    ]);
    expect(reported).not.toContain("5550123");
  });
});

describe("event-start reminders (shiftless event roles)", () => {
  it("reminds before the EVENT starts: one per channel, copy never says shift", async () => {
    const h = makeHarness({ events: [eventCandidate] });
    const { r1, r2 } = await twoTicks(h);

    expect(r1.byAnchor).toEqual({ shift: 0, eventStart: 1, askStart: 0 });
    expect(r1.sent).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(r2.sent).toEqual({ email: 0, sms: 0, inapp: 0 });

    const sms = (h.smsSend.mock.calls[0]![0] as { body: string }).body;
    expect(sms).toBe(
      "Ithas Fire: Reminder: Summer Fest starts tomorrow. You're volunteering as Security. Reply STOP to unsubscribe.",
    );
    const call = renderCall(h);
    expect(call.templateId).toBe("volunteer.start_reminder");
    expect(call.props).toMatchObject({
      anchor: "event",
      title: "Summer Fest",
      startsAtISO: START.toISOString(),
      endsAtISO: eventCandidate.eventEndsAt.toISOString(),
      timezone: "America/New_York",
      manageUrl: `https://example.test/events/summer-fest`,
    });
    const row = h.notificationsCreate.mock.calls[0]![0] as {
      title: string;
      body: string;
    };
    expect(row.title).toBe("Reminder: Summer Fest starts tomorrow");
    expect(`${row.title} ${row.body}`).not.toMatch(/shift/i);
  });

  it("the address line goes through the holder gate, as for shifts", async () => {
    const h = makeHarness({
      events: [{ ...eventCandidate, addressText: "123 Main St" }],
    });
    await twoTicks(h);
    expect(renderCall(h).props.addressText).toBe("123 Main St");
  });

  it("a cancelled event: nothing claimed or sent", async () => {
    const h = makeHarness({ events: [eventCandidate], eventsStillOn: [] });
    const { r1 } = await twoTicks(h);
    expect(h.findEventIdsStillOn).toHaveBeenCalledWith([EVENT_ID]);
    expect(h.recordShiftNotification).not.toHaveBeenCalled();
    expect(r1.sent).toEqual({ email: 0, sms: 0, inapp: 0 });
  });

  it("a shift signup is still reminded by its shift, and the ledger never lets a second anchor send it again", async () => {
    // The reads never return one signup twice (the event-start read takes
    // shiftless signups only); if they ever did, the shared ledger claim
    // still sends each channel once.
    const h = makeHarness({
      shifts: [shiftCandidate],
      events: [eventCandidate],
    });
    const { r1 } = await twoTicks(h);

    expect(r1.byAnchor).toEqual({ shift: 1, eventStart: 1, askStart: 0 });
    expect(r1.sent).toEqual({ email: 1, sms: 1, inapp: 1 });
    expect(h.mailSend).toHaveBeenCalledTimes(1);
    expect(h.smsSend).toHaveBeenCalledTimes(1);
    // The shift came first: its copy is the one that went out.
    expect((h.smsSend.mock.calls[0]![0] as { body: string }).body).toContain(
      '"Security" shift at Summer Fest',
    );
    expect(renderCall(h).templateId).toBe("volunteer.shift_reminder");
  });
});
