import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { ShiftReminderCandidate } from "@th/ports/repos/volunteering";

import { renderNotification } from "../comms/renderers";
import { sendVolunteerShiftReminders } from "./send-volunteer-shift-reminders";
import type { SendVolunteerShiftRemindersDeps } from "./send-volunteer-shift-reminders";

/**
 * The in-app reminder row: its English text, action, tags and metadata are
 * pinned exactly as the dispatcher wrote them before it stored a template;
 * the template (and metadata.variant) are what let the inbox re-render it in
 * the reader's language.
 */

const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const HUMAN_ID = "00000000-0000-4000-8000-000000000050";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-06-30T09:00:00.000Z");
const MANAGE_URL = `https://example.test/events/summer-fest`;

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

function makeDeps(candidate: ShiftReminderCandidate = baseCandidate) {
  const notificationsCreate = vi
    .fn()
    .mockResolvedValue({ id: "n1", createdAt: NOW });
  const reportError = vi.fn();
  const warn = vi.fn();
  const repos = {
    volunteering: {
      findShiftsNeedingReminder: vi.fn().mockResolvedValue([candidate]),
      findEventIdsStillOn: vi.fn(async (ids: string[]) => ids),
      findEventStartReminderCandidates: vi.fn(async () => []),
      findAskStartReminderCandidates: vi.fn(async () => []),
      findAskIdsStillRemindable: vi.fn(async (ids: string[]) => ids),
      recordShiftNotification: vi.fn().mockResolvedValue(true),
      deleteShiftNotification: vi.fn().mockResolvedValue(undefined),
    },
    tx: vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
      fn({
        notifications: { create: notificationsCreate },
        audit: { log: vi.fn().mockResolvedValue(undefined) },
      }),
    ),
  } as unknown as Repos;

  const deps: SendVolunteerShiftRemindersDeps = {
    repos,
    clock: { now: () => NOW },
    // In-app only: no email, no SMS.
    mailer: null,
    sms: null,
    renderEmailTemplate: vi.fn() as unknown as SendVolunteerShiftRemindersDeps["renderEmailTemplate"],
    appBaseUrl: "https://example.test",
    logger: {
      warn,
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as SendVolunteerShiftRemindersDeps["logger"],
    reportError,
  };
  return { deps, notificationsCreate, reportError, warn };
}

describe("sendVolunteerShiftReminders — stored in-app row", () => {
  it("24h: same English row as before, plus the template", async () => {
    const { deps, notificationsCreate } = makeDeps();
    await sendVolunteerShiftReminders(deps, { kind: "REMINDER_24H" });

    expect(notificationsCreate).toHaveBeenCalledTimes(1);
    expect(notificationsCreate.mock.calls[0]![0]).toEqual({
      humanId: HUMAN_ID,
      title: "Reminder: your Summer Fest shift tomorrow",
      body: "Tomorrow — your Security shift (Morning) at Summer Fest.",
      kind: "INFO",
      metadata: {
        signupId: SIGNUP_ID,
        eventId: EVENT_ID,
        kind: "REMINDER_24H",
        variant: "volunteer.shift-reminder-in-app",
      },
      tags: ["volunteer", "shift", "reminder", "24h"],
      action: { label: "Open your signup", href: MANAGE_URL },
      template: {
        key: "volunteer.shift-reminder-in-app",
        version: "1",
        variables: {
          signupId: SIGNUP_ID,
          eventId: EVENT_ID,
          eventTitle: "Summer Fest",
          roleName: "Security",
          shiftLabel: "Morning",
          kind: "REMINDER_24H",
          manageUrl: MANAGE_URL,
        },
      },
    });
  });

  it("1h, no shift label, no slug", async () => {
    const { deps, notificationsCreate } = makeDeps({
      ...baseCandidate,
      shiftLabel: null,
      eventSlug: null,
    });
    await sendVolunteerShiftReminders(deps, { kind: "REMINDER_1H" });

    const row = notificationsCreate.mock.calls[0]![0];
    expect(row.title).toBe("Reminder: your Summer Fest shift in about an hour");
    expect(row.body).toBe("In about an hour — your Security shift at Summer Fest.");
    expect(row.action).toEqual({
      label: "Open your signup",
      // No slug (unreachable for a live event): the commitments page, not a
      // route that does not exist.
      href: "https://example.test/my-volunteering",
    });
    expect(row.tags).toEqual(["volunteer", "shift", "reminder", "1h"]);
    expect(row.template.variables).toMatchObject({
      shiftLabel: null,
      kind: "REMINDER_1H",
    });
  });

  it("the stored template re-renders to the stored English", async () => {
    const { deps, notificationsCreate } = makeDeps();
    await sendVolunteerShiftReminders(deps, { kind: "REMINDER_24H" });
    const row = notificationsCreate.mock.calls[0]![0];
    const en = renderNotification(row.template.key, row.template.variables, {
      now: NOW,
      locale: "en",
    }).inApp!;
    expect([en.title, en.body, en.action]).toEqual([
      row.title,
      row.body,
      row.action,
    ]);
  });

  it("a payload that cannot be stored: row still written, warned, reported (guarded)", async () => {
    const { deps, notificationsCreate, reportError, warn } = makeDeps({
      ...baseCandidate,
      eventTitle: "x".repeat(20_000),
    });
    reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });
    const result = await sendVolunteerShiftReminders(deps, {
      kind: "REMINDER_24H",
    });

    expect(result.sent.inapp).toBe(1);
    const row = notificationsCreate.mock.calls[0]![0];
    expect(row.template).toBeUndefined();
    expect(row.metadata.variant).toBe("volunteer.shift-reminder-in-app");
    expect(warn).toHaveBeenCalledWith(
      "comms.direct_in_app.template_skipped",
      expect.objectContaining({ reason: "oversized" }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: {
        useCase: "volunteering.sendShiftReminders",
        variant: "volunteer.shift-reminder-in-app",
        reason: "oversized",
      },
    });
  });
});
