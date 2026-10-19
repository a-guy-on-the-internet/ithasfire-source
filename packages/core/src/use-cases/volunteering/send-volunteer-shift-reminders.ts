import { createHash } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MailerPort } from "@th/ports/comms/mailer";
import { redactPhoneNumbers, type SMSPort } from "@th/ports/comms/sms";
import { CommsPortError, isCommsPortError } from "@th/ports/comms/schemas";
import type {
  AskStartReminderCandidate,
  EventStartReminderCandidate,
  ShiftReminderCandidate,
  VolunteerReminderChannel,
  VolunteerReminderKind,
} from "@th/ports/repos/volunteering";

import { redactedError } from "../../lib/comms/redacted-error";
import { describeError, parseInput } from "../../lib/io";
import {
  eventIdsWithAddress,
  gatedRowAddressText,
  loadHolderAddressesForEventIds,
} from "../../lib/location/load-holder-addresses";
import {
  volunteerShiftReminderInAppRenderer,
  volunteerStartReminderInAppRenderer,
} from "../comms/direct-community-renderers";
import { formatEventTime } from "../comms/copy/common";
import { buildDirectInAppNotice } from "../comms/direct-in-app";
import { ensureSmsDeliverable } from "../comms/ensure-sms-deliverable";
import { SMS_BRAND_PREFIX } from "../../lib/comms/sms-brand";
import { toUsSmsNumber } from "../../lib/comms/phone";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { signupReminderAnchor } from "./_shared/signup-reminder-anchor";

/**
 * Cron-driven volunteer reminder dispatcher.
 *
 * Picks up APPROVED signups whose ANCHOR starts inside the requested
 * window, fans out one notification per (signup × channel) that hasn't
 * been sent yet, and idempotently records each successful send via the
 * `VolunteerShiftNotification` ledger so overlapping cron ticks can't
 * double-fire.
 *
 * A signup has exactly one anchor (`signupReminderAnchor`,
 * volunteer-ask-reminders FR-001): its shift's start; else, for an event
 * signup without a shift, the event's start; else, for a signup on a
 * one-time non-EVENT ask, the ask's start. One anchor per signup is why the
 * same (signup, kind, channel) ledger serves all three without a migration
 * and without a double-send. The three are read separately and share the
 * channel fan-out below; only the copy differs.
 *
 * Grouping (volunteer-ask-reminders R12 / FR-008): one person with several
 * signups on the same event or ask starting at the same instant (on an event,
 * shift and shiftless roles alike), gets ONE message per channel naming every role, not one per
 * signup. The ledger stays per signup; see `sendGroup` for the claim rules
 * and the race analysis.
 *
 * Channels per candidate:
 *   • `email` — always sent; everyone gave us an email at signup.
 *   • `inapp` — sent when `humanId` is set (real account, not shadow).
 *     Persists a notification row like the canonical `sendInApp`
 *     pipeline; the row backs the inbox list, which the client polls.
 *   • `sms`   — sent only when `contactPhone` is set AND `smsOptIn` is
 *     true on the signup row. Independent of any org-level prefs.
 *
 * We talk to the mailer / SMS / in-app ports directly rather than via
 * the shared `notify` use case because:
 *   1. `notify` requires a `humanId`, but shadow-profile volunteers (no
 *      humanId) still need reminders.
 *   2. The DB ledger already gives us per-channel idempotency at the
 *      use-case boundary, so we don't need notify's idempotency port.
 *   3. Reminder dispatch is transactional and bypasses notification
 *      preferences by design — a volunteer who's still APPROVED should
 *      not silently miss a reminder because they globally muted
 *      transactional in-app.
 */

export const sendVolunteerShiftRemindersInputSchema = z.object({
  kind: z.enum(["REMINDER_24H", "REMINDER_1H"]),
  /**
   * Inclusive lower bound on the anchor's start (shift, event or ask; ISO
   * 8601 UTC). When omitted the use case computes a default band around
   * the kind.
   */
  windowStartIso: z.string().datetime().optional(),
  /** Exclusive upper bound on the anchor's start. */
  windowEndIso: z.string().datetime().optional(),
});

export type SendVolunteerShiftRemindersInput = z.infer<
  typeof sendVolunteerShiftRemindersInputSchema
>;

/**
 * `sent`, `skipped` and `failed` count SIGNUPS (one per signup × channel, the
 * ledger's grain), so per channel they add up to every signup that wanted
 * that channel this tick. `messages` counts what actually went out: a grouped
 * reminder naming three roles is `sent: 3, messages: 1` (R12).
 */
export type SendVolunteerShiftRemindersOutput = {
  /** Every candidate read, all anchors together. */
  candidates: number;
  /** The same candidates split by anchor. */
  byAnchor: { shift: number; eventStart: number; askStart: number };
  /** Per channel: signups named in a reminder that went out this tick. */
  sent: Record<VolunteerReminderChannel, number>;
  /**
   * Per channel: signups not sent this tick and not to be retried: an
   * already-sent ledger row (read, or a claim another tick won), an SMS
   * suppression or a refused destination, or an event (or ask) no longer on.
   */
  skipped: Record<VolunteerReminderChannel, number>;
  /**
   * Per channel: signups whose claim threw, or whose message failed to send
   * (their claims rolled back, so the next tick retries them).
   */
  failed: Record<VolunteerReminderChannel, number>;
  /** Per channel: messages that went out (one per group). */
  messages: Record<VolunteerReminderChannel, number>;
};

export type SendVolunteerShiftRemindersDeps = {
  repos: Repos;
  clock: ClockPort;
  mailer: Pick<MailerPort, "send"> | null;
  sms: Pick<SMSPort, "send"> | null;
  /**
   * Renders the `volunteer.shift_reminder` / `volunteer.start_reminder`
   * email templates to subject / html / text. Injected so this use case
   * stays free of a direct `@th/ui-email` dependency (the package isn't
   * reachable from every runtime that imports core).
   */
  renderEmailTemplate: (
    input: VolunteerReminderEmailInput,
  ) => Promise<{ subject: string; html: string; text: string }>;
  /** Public web origin used to compose the manage-signup URL. */
  appBaseUrl: string;
  logger?: LoggerPort;
  /**
   * Reports what this batch swallows instead of throwing: a ledger claim that
   * failed, a send that failed (and its claim rollback), and an in-app
   * reminder whose template could not be stored (the row still goes out, but
   * stays English for every reader). The jobs process has no pino→Sentry
   * bridge, so without it these are only log lines nobody sees.
   */
  reportError?: ReporterPort;
};

export type VolunteerReminderEmailInput =
  | {
      templateId: "volunteer.shift_reminder";
      props: {
        eventTitle: string;
        roleName: string;
        shiftLabel?: string | null;
        shiftStartsAtISO: string;
        shiftEndsAtISO: string;
        /** The event's IANA zone; the shift window renders in it. */
        timezone?: string | null;
        kindLabel: string;
        addressText?: string | null;
        manageUrl?: string | null;
        /** Set for a grouped reminder (two or more shifts, R12). */
        roles?: Array<{
          roleName: string;
          shiftLabel: string | null;
          shiftEndsAtISO: string;
        }>;
      };
    }
  | {
      templateId: "volunteer.start_reminder";
      props: {
        anchor: "event" | "ask";
        /** The event's or the ask's title. */
        title: string;
        /** Null for the stored "Volunteer" fallback: no role named. */
        roleName: string | null;
        startsAtISO: string;
        endsAtISO?: string | null;
        timezone?: string | null;
        kindLabel: string;
        /** Event-anchored only; an ask reminder never names an address. */
        addressText?: string | null;
        manageUrl?: string | null;
        /** Set for a grouped reminder (two or more named roles, R12). */
        roleNames?: string[];
      };
    };

/**
 * One candidate, tagged by what it is reminded by. Contact and ledger fields
 * are common to all three; the rest is the copy's.
 */
type Reminder =
  | { anchor: "SHIFT"; c: ShiftReminderCandidate }
  | { anchor: "EVENT_START"; c: EventStartReminderCandidate }
  | { anchor: "ASK_START"; c: AskStartReminderCandidate };

/**
 * The signups one message covers (R12): same subject, same start, same
 * destination (on an event, any mix of shift and event-start members). `cs[0]` is `lead`, whose shared fields (title,
 * zone, slug, address, contact name) the message uses.
 */
type Batch =
  | {
      anchor: "SHIFT";
      lead: ShiftReminderCandidate;
      cs: ShiftReminderCandidate[];
    }
  | {
      /**
       * Any EVENT_START member makes the whole message the start form, shift
       * members included: they share the event and the instant, and the only
       * instant an EVENT_START signup has is the event's start, so "<event>
       * starts at …" is true for every member. `lead` is the first
       * EVENT_START member (it carries the event's start and end); a shift
       * member contributes only its signup and its role.
       */
      anchor: "EVENT_START";
      lead: EventStartReminderCandidate;
      cs: Array<EventStartReminderCandidate | ShiftReminderCandidate>;
    }
  | {
      anchor: "ASK_START";
      lead: AskStartReminderCandidate;
      cs: AskStartReminderCandidate[];
    };

/** One channel's message to one destination, before any claim. */
type Group = {
  channel: VolunteerReminderChannel;
  /** The E.164 number for an SMS group we can text; else null. */
  smsTo: string | null;
  members: Reminder[];
};

/**
 * A provider error can echo the destination number, so the log line and the
 * report get a redacted copy. A non-Error throw is described first so its
 * text is scrubbed too.
 */
function scrubbed(error: unknown): Error {
  return redactedError(
    error instanceof Error ? error : new Error(describeError(error)),
  );
}

/**
 * Best-effort report of a swallowed failure. A reporter that throws must
 * never change what the batch does: the counts, the rollback and the next
 * channel all proceed exactly as they would without it.
 */
function reportSwallowed(
  deps: SendVolunteerShiftRemindersDeps,
  error: unknown,
  original: unknown,
  stage:
    | "claim_failed"
    | "rollback_failed"
    | "dispatch_failed"
    | "sms_invalid_destination"
    | "anchor_mismatch",
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: {
        useCase: "volunteering.sendShiftReminders",
        stage,
        errorCode: isCommsPortError(original) ? original.code : undefined,
      },
      extra,
    });
  } catch {
    // Reporting is best-effort; see above.
  }
}

/**
 * Default window per kind: shifts starting in `[now + offset - halfWidth,
 * now + offset + halfWidth)`.
 *
 * EACH WINDOW MUST BE AT LEAST AS WIDE AS ITS CRON PERIOD, or a shift starting
 * between two ticks is never in any window and its reminder is silently lost.
 * Both kinds run every 30 minutes (`jobs.manifest.json`, aligned to :00/:30 so
 * the database wakes once per slot), and both windows are WIDER than that:
 * 24h is 60 min wide (+23h30m to +24h30m), 1h is 40 min wide (+40m to +80m).
 * The overlap absorbs Cloud Scheduler jitter and a late tick; the per-channel
 * ledger claim (`recordShiftNotification`, unique per signup × kind × channel)
 * is what makes a shift seen by two consecutive ticks still get exactly one
 * reminder.
 *
 * The 1h window was 10 min wide on a 5-minute tick (zero overlap) until
 * 2026-09-30, then 20 min wide (50-70 minutes before the shift) on a 15-minute
 * tick. On 2026-10-08 every 15-minute cron moved to 30 minutes so Neon can
 * sleep between slots, and both windows doubled: the 1h reminder now lands
 * 40-80 minutes before the shift.
 */
export const DEFAULT_BAND_MS = {
  REMINDER_24H: { offsetMs: 24 * 60 * 60_000, halfWidthMs: 30 * 60_000 },
  REMINDER_1H: { offsetMs: 60 * 60_000, halfWidthMs: 20 * 60_000 },
} as const satisfies Record<
  VolunteerReminderKind,
  { offsetMs: number; halfWidthMs: number }
>;

const ZERO_COUNTS = (): Record<VolunteerReminderChannel, number> => ({
  email: 0,
  sms: 0,
  inapp: 0,
});

/**
 * An event reminder links to the event page, where the volunteer section
 * lists the reader's own signups. Until 2026-10-18 it linked to
 * `/events/<slug>/volunteer?signup=<id>`, a route that does not exist (the
 * event catch-all 404s on the trailing segment). One link serves a single
 * signup and a group alike.
 */
function manageUrlFor(appBaseUrl: string, eventSlug: string | null): string {
  const base = appBaseUrl.replace(/\/+$/, "");
  if (eventSlug) return `${base}/events/${eventSlug}`;
  // Not reached for a live event (publishing refuses an event it cannot
  // slug), but never a dead link: the volunteer's own commitments page.
  return `${base}/my-volunteering`;
}

/** An ask reminder links to the ask's public page (FR-004). */
function askUrlFor(appBaseUrl: string, askId: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}/v/${askId}`;
}

/**
 * The zone an ask's start renders in: the ask's own, else its place's (both
 * resolved by the candidate read), else the platform default, the same rule
 * every event time follows (`resolveTimeZone`); never UTC. Every channel
 * names the zone beside the time (FR-004).
 */
function askZone(c: AskStartReminderCandidate): string {
  return resolveTimeZone(c.askTimezone);
}

/**
 * Reduce free-form names to a short, GSM-7-safe slice for SMS bodies.
 * Without this, an event title with an emoji or curly quote flips the
 * whole message to UCS-2 (160→70 chars/segment) and a 1-segment
 * reminder becomes a 3-segment one — surprising SNS cost and worse
 * carrier reliability. We drop control chars, replace curly quotes
 * with straight ones, strip the rest of the non-GSM-7 set, and cap
 * the result. Email keeps the original (rendered as UTF-8 HTML).
 */
function sanitizeForSms(
  input: string,
  maxLen: number,
  fallback = "your shift",
): string {
  const replacements: [RegExp, string][] = [
    [/[‘’‚‛]/g, "'"], // curly single quotes
    [/[“”„‟]/g, '"'], // curly double quotes
    [/[–—]/g, "-"], // en/em dashes
    [/[…]/g, "..."], // ellipsis
  ];
  let cleaned = input.replace(/[\r\n\t]+/g, " ");
  for (const [pat, repl] of replacements) cleaned = cleaned.replace(pat, repl);
  // Strip anything that's not basic GSM-7 / 7-bit ASCII range. Loose
  // approximation — fully accurate GSM-7 detection is a 100-line
  // table; this catches the common bloat sources.
  cleaned = cleaned.replace(/[^\x20-\x7E]/g, "");
  cleaned = cleaned.trim();
  if (cleaned.length > maxLen)
    // ASCII "..." only: a U+2026 here would flip the whole SMS to UCS-2.
    cleaned = cleaned.slice(0, maxLen - 3).trim() + "...";
  return cleaned.length > 0 ? cleaned : fallback;
}

export async function sendVolunteerShiftReminders(
  deps: SendVolunteerShiftRemindersDeps,
  rawInput: unknown,
): Promise<SendVolunteerShiftRemindersOutput> {
  const input = parseInput(sendVolunteerShiftRemindersInputSchema, rawInput);

  const now = deps.clock.now();
  const band = DEFAULT_BAND_MS[input.kind];
  const center = new Date(now.getTime() + band.offsetMs);
  const windowStart = input.windowStartIso
    ? new Date(input.windowStartIso)
    : new Date(center.getTime() - band.halfWidthMs);
  const windowEnd = input.windowEndIso
    ? new Date(input.windowEndIso)
    : new Date(center.getTime() + band.halfWidthMs);

  const window = { kind: input.kind, windowStart, windowEnd };
  const shiftCandidates =
    await deps.repos.volunteering.findShiftsNeedingReminder(window);
  const eventStartCandidates =
    await deps.repos.volunteering.findEventStartReminderCandidates(window);
  const askStartRows =
    await deps.repos.volunteering.findAskStartReminderCandidates(window);

  // The ask read filters on cadence and start in SQL; the one rule
  // (`signupReminderAnchor`) is re-applied here so the two can never drift
  // into reminding a signup the submit path would not have offered texts
  // for. A row that fails it is dropped and reported, never sent.
  const askStartCandidates = askStartRows.filter((c) => {
    const anchor = signupReminderAnchor({
      shiftId: null,
      eventId: null,
      roleHasShifts: false,
      ask: {
        subjectType: c.askSubjectType,
        cadence: c.askCadence,
        startsAt: c.askStartsAt,
      },
    });
    if (anchor === "ASK_START") return true;
    deps.logger?.error("volunteering.shift_reminder.anchor_mismatch", {
      signupId: c.signupId,
      askId: c.askId,
    });
    reportSwallowed(
      deps,
      new Error("ask_reminder_candidate_without_anchor"),
      null,
      "anchor_mismatch",
      { signupId: c.signupId, askId: c.askId, kind: input.kind },
    );
    return false;
  });

  const reminders: Reminder[] = [
    ...shiftCandidates.map((c) => ({ anchor: "SHIFT" as const, c })),
    ...eventStartCandidates.map((c) => ({
      anchor: "EVENT_START" as const,
      c,
    })),
    ...askStartCandidates.map((c) => ({ anchor: "ASK_START" as const, c })),
  ];
  const eventRows = [...shiftCandidates, ...eventStartCandidates];

  // The email's address line is gated like a ticket holder's: no street
  // before the event's reveal (a setup shift can start before it), none ever
  // for NEVER — organizers can tell their volunteers directly — and the
  // Place's street, not the Event row's public projection, for a venue that
  // withholds its address. Resolved once per batch and BEFORE any ledger
  // claim, so a failed read fails the run with nothing claimed and the next
  // tick retries.
  const holderAddresses = await loadHolderAddressesForEventIds({
    repos: deps.repos,
    eventIds: eventIdsWithAddress(eventRows),
    // Every candidate read takes APPROVED signups only: every candidate is
    // an accepted volunteer.
    activeHolder: true,
    now,
  });

  // Plain mutable counters with every channel declared up front — the
  // project's `noUncheckedIndexedAccess` would otherwise make each
  // `counts[channel] += 1` read possibly-undefined. See the output type for
  // what each counts (signups, except `messages`).
  const counts: Counts = {
    sent: ZERO_COUNTS(),
    skipped: ZERO_COUNTS(),
    failed: ZERO_COUNTS(),
    messages: ZERO_COUNTS(),
  };

  // Channels we can actually deliver to. If a port is missing we simply
  // drop that channel from the candidate fan-out — no ledger row gets
  // written, so wiring the port later doesn't create stale ghost
  // reminders for shifts that have already passed.
  const availableChannels = new Set<VolunteerReminderChannel>();
  if (deps.mailer) availableChannels.add("email");
  if (deps.sms) availableChannels.add("sms");
  // In-app reminders persist a notification row via `repos` (always
  // present); the row backs the polled inbox. No live-push dependency.
  availableChannels.add("inapp");

  // Re-check, right before any claim or send, that each event (and each
  // ask, FR-003) is still on. The candidate queries already filtered, but an
  // organiser can cancel or archive (or an owner be banned) between that
  // read and the dispatch below. A failed read throws with nothing claimed,
  // so the next tick retries.
  const stillOn = new Set(
    await deps.repos.volunteering.findEventIdsStillOn([
      ...new Set(eventRows.map((c) => c.eventId)),
    ]),
  );
  const askIds = [...new Set(askStartCandidates.map((c) => c.askId))];
  const asksStillOn = new Set(
    askIds.length > 0
      ? await deps.repos.volunteering.findAskIdsStillRemindable(askIds)
      : [],
  );

  // Group per channel (R12): one message per destination, subject, anchor
  // kind and start instant. Map order is first-seen order, so messages go
  // out in candidate order, as before.
  const groups = new Map<string, Group>();
  for (const raw of reminders) {
    const r = withGatedAddress(raw, holderAddresses);
    const { c } = r;
    const desiredChannels = computeChannelsFor(c).filter((ch) =>
      availableChannels.has(ch),
    );
    const live =
      r.anchor === "ASK_START"
        ? asksStillOn.has(r.c.askId)
        : stillOn.has(r.c.eventId);
    if (!live) {
      for (const channel of desiredChannels) counts.skipped[channel] += 1;
      deps.logger?.info(
        r.anchor === "ASK_START"
          ? "volunteering.shift_reminder.ask_not_live"
          : "volunteering.shift_reminder.event_not_live",
        {
          signupId: c.signupId,
          ...(r.anchor === "ASK_START"
            ? { askId: r.c.askId }
            : { eventId: r.c.eventId }),
        },
      );
      continue;
    }
    for (const channel of desiredChannels) {
      if (c.alreadySent.includes(channel)) {
        counts.skipped[channel] += 1;
        continue;
      }
      const key = groupKey(r, channel);
      const group = groups.get(key);
      if (group) {
        group.members.push(r);
      } else {
        groups.set(key, {
          channel,
          smsTo:
            channel === "sms" ? toUsSmsNumber(c.contactPhone ?? "") : null,
          members: [r],
        });
      }
    }
  }

  for (const group of groups.values()) {
    await sendGroup(deps, group, input.kind, counts);
  }

  const { sent, skipped, failed, messages } = counts;
  const byAnchor = {
    shift: shiftCandidates.length,
    eventStart: eventStartCandidates.length,
    askStart: askStartCandidates.length,
  };
  deps.logger?.info("volunteering.shift_reminders.batch_complete", {
    kind: input.kind,
    candidates: reminders.length,
    byAnchor,
    sent,
    skipped,
    failed,
    messages,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  });

  return {
    candidates: reminders.length,
    byAnchor,
    sent,
    skipped,
    failed,
    messages,
  };
}

type Counts = Pick<
  SendVolunteerShiftRemindersOutput,
  "sent" | "skipped" | "failed" | "messages"
>;

/** The instant a reminder is anchored to (its shift's, event's or ask's start). */
function anchorStart(r: Reminder): Date {
  switch (r.anchor) {
    case "SHIFT":
      return r.c.shiftStartsAt;
    case "EVENT_START":
      return r.c.eventStartsAt;
    case "ASK_START":
      return r.c.askStartsAt;
  }
}

/**
 * R12's grouping key for one channel: the destination (SMS: the E.164 number,
 * or the stored text when it is not one we text; email: the lowercased
 * address; in-app: the account), the subject (event or ask) and the anchor
 * instant. Two shifts at different times, or two events, are two keys.
 *
 * "One reminder per person per start time" (owner, R12): on an event the
 * anchor kind is NOT in the key, so a shift that starts exactly at the event's
 * start groups with a shiftless role reminded by that start (`toBatch` then
 * sends the start form). An ask has only ASK_START.
 */
function groupKey(r: Reminder, channel: VolunteerReminderChannel): string {
  const { c } = r;
  const destination =
    channel === "sms"
      ? (toUsSmsNumber(c.contactPhone ?? "") ??
        `unparsed:${(c.contactPhone ?? "").trim()}`)
      : channel === "email"
        ? c.contactEmail.trim().toLowerCase()
        : (c.humanId ?? "");
  const subject =
    r.anchor === "ASK_START" ? `ask:${r.c.askId}` : `event:${r.c.eventId}`;
  return JSON.stringify([
    channel,
    destination,
    subject,
    anchorStart(r).getTime(),
  ]);
}

/** The claimed members of one group as a message's batch. */
function toBatch(members: readonly Reminder[]): Batch {
  const first = members[0];
  if (!first) throw new Error("empty_reminder_batch");
  switch (first.anchor) {
    case "SHIFT":
    case "EVENT_START": {
      // Every member SHIFT: the shift form, as before. Any EVENT_START
      // member: the start form for all, led by the first such member, which
      // goes first so `cs[0]` stays `lead`.
      const lead = members.find((m) => m.anchor === "EVENT_START");
      if (lead?.anchor === "EVENT_START")
        return {
          anchor: "EVENT_START",
          lead: lead.c,
          cs: [
            lead.c,
            ...members.flatMap((m) =>
              m !== lead && m.anchor !== "ASK_START" ? [m.c] : [],
            ),
          ],
        };
      if (first.anchor !== "SHIFT") throw new Error("unreachable_batch");
      return {
        anchor: "SHIFT",
        lead: first.c,
        cs: members.flatMap((m) => (m.anchor === "SHIFT" ? [m.c] : [])),
      };
    }
    case "ASK_START":
      return {
        anchor: "ASK_START",
        lead: first.c,
        cs: members.flatMap((m) => (m.anchor === "ASK_START" ? [m.c] : [])),
      };
  }
}

/** The signup ids a log line or report names: `signupIds` only for a group. */
function signupFields(signupIds: readonly string[]): {
  signupId: string | undefined;
  signupIds?: string[];
} {
  return signupIds.length > 1
    ? { signupId: signupIds[0], signupIds: [...signupIds] }
    : { signupId: signupIds[0] };
}

/**
 * Claim, send and (on failure) roll back one group: one message per channel
 * per destination, subject and start (R12 / FR-008).
 *
 * The ledger stays per signup. Each member's (signup, kind, channel) row is
 * claimed first; a member whose claim returns false was sent already (by an
 * earlier tick, or by an overlapping one) and is left out of the message; a
 * member whose claim throws is reported and left out. With no member newly
 * claimed nothing is sent. The message names only the members THIS call
 * claimed, so no member is ever named in two messages. A send failure rolls
 * back every row this call claimed, and the next tick retries them together.
 *
 * Races between overlapping ticks (two runs over the same group at once):
 *   • The unique claim gives each member's row to exactly one tick, so each
 *     member is named in exactly one message. Never twice, with one
 *     exception: a group send that THREW after the provider had in fact
 *     delivered it rolls back, and if the claimed set differs on the retry
 *     (a member withdraws, another is approved, or a rollback that failed
 *     for one member left its row claimed), the retry's idempotency key
 *     differs, the provider does not dedupe it, and the members of both sets
 *     are named twice. Accepted, the same class as the interleave split
 *     below: it needs a lost provider response plus a changed set inside one
 *     30-minute slot.
 *   • If the claims interleave (tick A wins signup 1, tick B wins signup 2),
 *     each tick sends a message naming only its own member: that person gets
 *     two messages for one start. This is the accepted degradation. Ruling
 *     it out needs a group-level lock (an advisory lock or a group row), a
 *     port and schema change for a case that needs a tick to overrun its
 *     30-minute slot or a manual run to overlap a scheduled one.
 *   • A rolled-back group can be re-claimed piecemeal the same way, with the
 *     same outcome: one message per claiming tick, each member once.
 *   • A rollback that itself fails leaves that member's row claimed: that
 *     member misses this reminder (reported as `rollback_failed`, as before
 *     grouping) while the rest of the group is retried.
 *   • A member approved after its group-mates were sent finds their rows
 *     already claimed and gets a message naming only its own role.
 *
 * SMS consent is checked once per group: every member of an SMS group has the
 * same number by construction (`groupKey`). A number we cannot text skips the
 * consent check; `dispatch` refuses it after the claim, so the group is
 * reported once and never retried.
 */
async function sendGroup(
  deps: SendVolunteerShiftRemindersDeps,
  group: Group,
  kind: VolunteerReminderKind,
  counts: Counts,
): Promise<void> {
  const { channel, members } = group;

  // FR-006: never send a reminder SMS to a phone that has opted out of
  // reminder SMS (app ledger), even when the signup's `smsOptIn` was
  // previously true. Only the app ledger is checked here: this call passes
  // no provider lookup, and no job in apps/jobs copies provider opt-outs into
  // the ledger. A number the provider has opted out is dropped by the
  // provider (SNS), not by the adapter.
  if (channel === "sms" && group.smsTo) {
    const verdict = await ensureSmsDeliverable(
      {
        repos: deps.repos,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        phoneNumber: group.smsTo,
        category: "VOLUNTEER_REMINDER",
      },
    );
    if (!verdict.deliverable) {
      deps.logger?.info("volunteering.shift_reminder.sms_suppressed", {
        ...signupFields(members.map((m) => m.c.signupId)),
        reason: verdict.reason,
      });
      counts.skipped[channel] += members.length;
      return;
    }
  }

  const claimed: Reminder[] = [];
  for (const m of members) {
    const signupId = m.c.signupId;
    let won = false;
    try {
      won = await deps.repos.volunteering.recordShiftNotification({
        signupId,
        kind,
        channel,
      });
    } catch (error) {
      deps.logger?.warn("volunteering.shift_reminder.claim_failed", {
        signupId,
        channel,
        error: describeError(scrubbed(error)),
      });
      reportSwallowed(deps, scrubbed(error), error, "claim_failed", {
        signupId,
        kind,
        channel,
      });
      counts.failed[channel] += 1;
      continue;
    }
    if (!won) {
      counts.skipped[channel] += 1;
      continue;
    }
    claimed.push(m);
  }
  if (claimed.length === 0) return;

  const batch = toBatch(claimed);
  const signupIds = batch.cs.map((c) => c.signupId);
  const ids = signupFields(signupIds);

  try {
    await dispatch(deps, batch, kind, channel);
    counts.sent[channel] += claimed.length;
    counts.messages[channel] += 1;
  } catch (error) {
    // The provider refused the destination itself (`invalid_input`: not a
    // number we text, e.g. outside the US). Retrying cannot succeed, so the
    // claims stay and this reminder is skipped for good: reported once here
    // instead of on every cron tick. The report carries a fresh, redacted
    // error so no phone number reaches the tracker.
    if (
      channel === "sms" &&
      isCommsPortError(error) &&
      error.code === "invalid_input"
    ) {
      deps.logger?.error("volunteering.shift_reminder.sms_invalid_destination", {
        ...ids,
        kind,
      });
      reportSwallowed(
        deps,
        new Error(`sms_invalid_input: ${redactPhoneNumbers(error.message)}`),
        error,
        "sms_invalid_destination",
        { ...ids, kind, channel },
      );
      counts.skipped[channel] += claimed.length;
      return;
    }
    // Roll back every claim this group made so the next cron tick retries
    // them together. Without this, a transient mailer / SNS 5xx would mark
    // the channel "sent" forever and the volunteer would silently never get
    // reminded. Best-effort per row — we don't re-raise if a rollback fails.
    for (const signupId of signupIds) {
      try {
        await deps.repos.volunteering.deleteShiftNotification({
          signupId,
          kind,
          channel,
        });
      } catch (rollbackError) {
        deps.logger?.error("volunteering.shift_reminder.rollback_failed", {
          signupId,
          kind,
          channel,
          error: describeError(scrubbed(rollbackError)),
        });
        // The claim stays: this channel now reads "sent" for this signup and
        // is never retried, so the volunteer misses this reminder for good.
        reportSwallowed(
          deps,
          scrubbed(rollbackError),
          rollbackError,
          "rollback_failed",
          { signupId, kind, channel },
        );
      }
    }
    deps.logger?.error("volunteering.shift_reminder.dispatch_failed", {
      ...ids,
      kind,
      channel,
      error: describeError(scrubbed(error)),
    });
    reportSwallowed(deps, scrubbed(error), error, "dispatch_failed", {
      ...ids,
      kind,
      channel,
    });
    counts.failed[channel] += claimed.length;
  }
}

/**
 * The email's address line, gated like a ticket holder's (see the batch
 * read above). Event-anchored rows only: an ask reminder never names an
 * address (FR-004), and its candidate carries none.
 */
function withGatedAddress(
  r: Reminder,
  holderAddresses: Parameters<typeof gatedRowAddressText>[1],
): Reminder {
  if (r.anchor === "ASK_START") return r;
  const addressText = gatedRowAddressText(r.c, holderAddresses, {
    activeHolder: true,
  });
  return r.anchor === "SHIFT"
    ? { anchor: "SHIFT", c: { ...r.c, addressText } }
    : { anchor: "EVENT_START", c: { ...r.c, addressText } };
}

function computeChannelsFor(
  c: Pick<ShiftReminderCandidate, "humanId" | "smsOptIn" | "contactPhone">,
): VolunteerReminderChannel[] {
  const channels: VolunteerReminderChannel[] = ["email"];
  if (c.humanId) channels.push("inapp");
  if (c.smsOptIn && c.contactPhone && c.contactPhone.trim().length > 0) {
    channels.push("sms");
  }
  return channels;
}

/**
 * The 1h SMS names the start in the anchor's own timezone ("at 7:30 PM
 * CDT"): the reminder lands 40 to 80 minutes ahead, so a clock time says
 * more than "in 1 hour". Falls back to "in about an hour" when the instant
 * cannot be formatted. ICU's narrow no-break space before AM/PM is not
 * GSM-7, so it becomes a plain space.
 */
function smsOneHourWhen(startsAt: Date, timezone: string | null): string {
  const time = formatEventTime("en", startsAt.toISOString(), timezone);
  return time
    ? `at ${time.replace(/[  ]/g, " ")}`
    : "in about an hour";
}

/** One GSM-7 segment. */
export const SMS_MAX_CHARS = 160;
const SMS_MIN_TITLE_CHARS = 12;
const SMS_MIN_ROLE_CHARS = 8;

/**
 * Build an SMS body that fits one segment. `build` takes the caps for the
 * title (event or ask) and for each role name; starting from the given caps,
 * they shrink one character at a time, alternately, until the body fits or
 * both are at their floor. A body that fits at the starting caps is returned
 * unchanged, so a short reminder reads exactly as it did before grouping. At
 * the floors the worst case (12-character title, 8-character role, "and 99
 * more", a 21-character time) is about 145 characters.
 */
function fitSmsSegment(
  build: (titleCap: number, roleCap: number) => string,
  titleCap: number,
  roleCap: number,
): string {
  let t = titleCap;
  let r = roleCap;
  let body = build(t, r);
  let shrinkRole = true;
  while (body.length > SMS_MAX_CHARS) {
    const canRole = r > SMS_MIN_ROLE_CHARS;
    const canTitle = t > SMS_MIN_TITLE_CHARS;
    if (!canRole && !canTitle) break;
    if ((shrinkRole && canRole) || !canTitle) r -= 1;
    else t -= 1;
    shrinkRole = !shrinkRole;
    body = build(t, r);
  }
  return body;
}

/**
 * The roles an SMS names: "A", "A and B", or past two "A and N more" (R12).
 * A name that sanitises to nothing (all emoji, say) is not shown but still
 * counted in "N more". Null when nothing can be shown.
 */
function smsRoleList(names: readonly string[], cap: number): string | null {
  const shown = names
    .map((n) => sanitizeForSms(n, cap, ""))
    .filter((n) => n.length > 0);
  const first = shown[0];
  if (!first) return null;
  if (names.length === 1) return first;
  if (names.length === 2 && shown.length === 2)
    return `${first} and ${shown[1]}`;
  return `${first} and ${names.length - 1} more`;
}

/** Distinct role names, in order; the stored "Volunteer" fallback names none. */
function namedRoles(roleNames: readonly string[]): string[] {
  return [...new Set(roleNames)].filter((n) => n !== "Volunteer");
}

/**
 * Provider idempotency key. A single signup keeps the key it always had; a
 * group's key hashes its sorted claimed signup ids, so a retry of the same
 * group dedupes at the provider and a different set never collides with it.
 */
function idempotencyKeyFor(
  signupIds: readonly string[],
  kind: VolunteerReminderKind,
  channel: "sms" | "email",
): string {
  if (signupIds.length === 1)
    return `vol-shift-rem:${signupIds[0]}:${kind}:${channel}`;
  const digest = createHash("sha256")
    .update([...signupIds].sort().join(","))
    .digest("hex")
    .slice(0, 32);
  return `vol-shift-rem:group:${digest}:${kind}:${channel}`;
}

/**
 * The per-anchor parts of one message: where it links, what its tags and
 * metadata name, and its SMS body. The fan-out in `dispatch` is shared.
 */
function reminderParts(
  deps: SendVolunteerShiftRemindersDeps,
  b: Batch,
  kind: VolunteerReminderKind,
): {
  manageUrl: string;
  tags: string[];
  metadata: Record<string, string>;
  smsBody: string;
} {
  const band = kind === "REMINDER_24H" ? "24h" : "1h";
  const stop = ". Reply STOP to unsubscribe.";
  const signupIds = b.cs.map((c) => c.signupId);
  const ids: Record<string, string> =
    signupIds.length > 1
      ? { signupId: b.lead.signupId, signupIds: signupIds.join(",") }
      : { signupId: b.lead.signupId };
  switch (b.anchor) {
    case "SHIFT": {
      const c = b.lead;
      const when =
        kind === "REMINDER_24H"
          ? "tomorrow"
          : smsOneHourWhen(c.shiftStartsAt, c.eventTimezone);
      const roleNames = [...new Set(b.cs.map((m) => m.roleName))];
      const smsBody =
        b.cs.length > 1
          ? // Several shifts of one person, same event, same start (R12).
            fitSmsSegment(
              (t, r) => {
                const event = sanitizeForSms(c.eventTitle, t);
                const roles = smsRoleList(roleNames, r);
                return (
                  `${SMS_BRAND_PREFIX}Reminder: your shifts at ${event} start ${when}` +
                  (roles ? ` (${roles})` : "") +
                  stop
                );
              },
              40,
              20,
            )
          : fitSmsSegment(
              (t, r) => {
                const role = sanitizeForSms(c.roleName, r);
                const event = sanitizeForSms(c.eventTitle, t);
                const label = c.shiftLabel
                  ? sanitizeForSms(c.shiftLabel, Math.min(20, r))
                  : null;
                return (
                  `${SMS_BRAND_PREFIX}Reminder: your "${role}" shift at ${event} starts ${when}` +
                  (label ? ` (${label})` : "") +
                  stop
                );
              },
              40,
              30,
            );
      return {
        manageUrl: manageUrlFor(deps.appBaseUrl, c.eventSlug),
        tags: ["volunteer", "shift", "reminder", band],
        metadata: { ...ids, eventId: c.eventId, kind },
        smsBody,
      };
    }
    case "EVENT_START":
    case "ASK_START": {
      // R7: the EVENT (or the ask) starts; never "your shift". Title 36 and
      // role 20 keep a single role inside one 160-character GSM-7 segment;
      // `fitSmsSegment` trims further when a group's role list needs room.
      const isAsk = b.anchor === "ASK_START";
      const title = isAsk ? b.lead.askTitle : b.lead.eventTitle;
      const startsAt = isAsk ? b.lead.askStartsAt : b.lead.eventStartsAt;
      const zone = isAsk ? askZone(b.lead) : b.lead.eventTimezone;
      const when =
        kind === "REMINDER_24H" ? "tomorrow" : smsOneHourWhen(startsAt, zone);
      const roles = namedRoles(b.cs.map((m) => m.roleName));
      const smsBody = fitSmsSegment(
        (t, r) => {
          const name = sanitizeForSms(
            title,
            t,
            isAsk ? "Your volunteering" : "Your event",
          );
          const list = smsRoleList(roles, r);
          return (
            `${SMS_BRAND_PREFIX}Reminder: ${name} starts ${when}.` +
            (list ? ` You're volunteering as ${list}` : " You're volunteering") +
            stop
          );
        },
        36,
        20,
      );
      return {
        manageUrl:
          b.anchor === "ASK_START"
            ? askUrlFor(deps.appBaseUrl, b.lead.askId)
            : manageUrlFor(deps.appBaseUrl, b.lead.eventSlug),
        tags: ["volunteer", isAsk ? "ask" : "event", "reminder", band],
        metadata:
          b.anchor === "ASK_START"
            ? { ...ids, askId: b.lead.askId, kind }
            : { ...ids, eventId: b.lead.eventId, kind },
        smsBody,
      };
    }
  }
}

/**
 * The email's role props: the first named role, plus the whole list when
 * there are two or more. The stored "Volunteer" fallback reads as no role at
 * all, as in SMS and in-app.
 */
function emailRoles(roleNames: readonly string[]): {
  roleName: string | null;
  roleNames?: string[];
} {
  const named = namedRoles(roleNames);
  return named.length > 1
    ? { roleName: named[0] ?? null, roleNames: named }
    : { roleName: named[0] ?? null };
}

async function dispatch(
  deps: SendVolunteerShiftRemindersDeps,
  b: Batch,
  kind: VolunteerReminderKind,
  channel: VolunteerReminderChannel,
): Promise<void> {
  const lead = b.lead;
  const signupIds = b.cs.map((c) => c.signupId);
  const grouped = signupIds.length > 1;
  const { manageUrl, tags, metadata, smsBody } = reminderParts(deps, b, kind);
  // "about an hour": the 1h window is +40m..+80m (DEFAULT_BAND_MS), so the
  // reminder can land anywhere from 40 to 80 minutes before the start.
  const kindLabel = kind === "REMINDER_24H" ? "Tomorrow" : "In about an hour";
  // The in-app start row's `roleName`: the first real role of the group, so
  // a group led by a "Volunteer" fallback signup still names its real role
  // (as SMS and email do). A single signup stores its own, as before.
  const leadRole =
    namedRoles(b.cs.map((c) => c.roleName))[0] ?? lead.roleName;

  if (channel === "sms") {
    if (!deps.sms) throw new Error("sms_port_unavailable");
    if (!lead.contactPhone) throw new Error("missing_phone");
    // Rows opted in with a number kept as typed ("615-555-0100") send in
    // E.164; a number we do not text is a terminal invalid_input (the
    // caller keeps the claims and reports once). No number in the message.
    const toE164 = toUsSmsNumber(lead.contactPhone);
    if (!toE164) {
      throw new CommsPortError("invalid_input", "not_a_us_sms_number");
    }
    await deps.sms.send({
      purpose: "notification",
      to: { toE164 },
      body: smsBody,
      tags,
      metadata,
      idempotencyKey: idempotencyKeyFor(signupIds, kind, "sms"),
    });
    return;
  }

  if (channel === "inapp") {
    if (!lead.humanId) throw new Error("missing_human_id_for_inapp");
    const humanId = lead.humanId;
    // The text comes from an in-app-only comms variant
    // (comms/direct-community-renderers.ts) and the row stores its payload as
    // the template, so the inbox shows it in the reader's language. Stored
    // text stays English. A grouped row also stores its role list (R12); a
    // single row is stored exactly as before.
    const ctx = {
      useCase: "volunteering.sendShiftReminders",
      now: deps.clock.now(),
    };
    const notice =
      b.anchor === "SHIFT"
        ? buildDirectInAppNotice(
            deps,
            volunteerShiftReminderInAppRenderer,
            {
              signupId: b.lead.signupId,
              eventId: b.lead.eventId,
              eventTitle: b.lead.eventTitle,
              roleName: b.lead.roleName,
              shiftLabel: b.lead.shiftLabel ?? null,
              kind,
              manageUrl,
              ...(grouped
                ? {
                    roles: b.cs.map((c) => ({
                      roleName: c.roleName,
                      shiftLabel: c.shiftLabel ?? null,
                    })),
                    signupIds,
                  }
                : {}),
            },
            ctx,
          )
        : buildDirectInAppNotice(
            deps,
            volunteerStartReminderInAppRenderer,
            {
              ...(b.anchor === "ASK_START"
                ? {
                    signupId: b.lead.signupId,
                    anchor: "ASK_START" as const,
                    eventId: null,
                    askId: b.lead.askId,
                    title: b.lead.askTitle,
                    roleName: leadRole,
                    kind,
                    startsAtIso: b.lead.askStartsAt.toISOString(),
                    timezone: askZone(b.lead),
                    manageUrl,
                  }
                : {
                    signupId: b.lead.signupId,
                    anchor: "EVENT_START" as const,
                    eventId: b.lead.eventId,
                    askId: null,
                    title: b.lead.eventTitle,
                    roleName: leadRole,
                    kind,
                    startsAtIso: b.lead.eventStartsAt.toISOString(),
                    timezone: b.lead.eventTimezone,
                    manageUrl,
                  }),
              ...(grouped
                ? { roleNames: b.cs.map((c) => c.roleName), signupIds }
                : {}),
            },
            ctx,
          );

    // Persist the notification row, mirroring the canonical in-app
    // pipeline (`sendInApp`). The DB row is the source of truth: it
    // backs the volunteer's inbox (`notifications.list`), which the
    // client polls. A persist failure throws so the caller rolls back
    // the group's ledger claims and the next tick retries the channel.
    await deps.repos.tx(async (tx) => {
      if (!tx.notifications) {
        throw new Error("notifications_repo_unavailable");
      }
      const record = await tx.notifications.create({
        humanId,
        title: notice.title,
        body: notice.body,
        kind: "INFO",
        metadata: { ...metadata, variant: notice.variant },
        tags,
        action: notice.action,
        template: notice.template,
      });
      await tx.audit.log({
        entity: "human",
        entityId: humanId,
        action: "comms.in_app.sent",
        data: { ...metadata, notificationId: record.id },
        at: deps.clock.now(),
      });
      return record;
    });
    return;
  }

  // email
  if (!deps.mailer) throw new Error("mailer_port_unavailable");
  const rendered = await deps.renderEmailTemplate(
    b.anchor === "SHIFT"
      ? {
          templateId: "volunteer.shift_reminder",
          props: {
            eventTitle: b.lead.eventTitle,
            roleName: b.lead.roleName,
            shiftLabel: b.lead.shiftLabel,
            shiftStartsAtISO: b.lead.shiftStartsAt.toISOString(),
            shiftEndsAtISO: b.lead.shiftEndsAt.toISOString(),
            timezone: b.lead.eventTimezone,
            kindLabel,
            addressText: b.lead.addressText,
            manageUrl,
            ...(grouped
              ? {
                  roles: b.cs.map((c) => ({
                    roleName: c.roleName,
                    shiftLabel: c.shiftLabel,
                    shiftEndsAtISO: c.shiftEndsAt.toISOString(),
                  })),
                }
              : {}),
          },
        }
      : b.anchor === "EVENT_START"
        ? {
            templateId: "volunteer.start_reminder",
            props: {
              anchor: "event",
              title: b.lead.eventTitle,
              ...emailRoles(b.cs.map((c) => c.roleName)),
              startsAtISO: b.lead.eventStartsAt.toISOString(),
              endsAtISO: b.lead.eventEndsAt.toISOString(),
              timezone: b.lead.eventTimezone,
              kindLabel,
              addressText: b.lead.addressText,
              manageUrl,
            },
          }
        : {
            templateId: "volunteer.start_reminder",
            props: {
              anchor: "ask",
              title: b.lead.askTitle,
              ...emailRoles(b.cs.map((c) => c.roleName)),
              startsAtISO: b.lead.askStartsAt.toISOString(),
              endsAtISO: b.lead.askEndsAt?.toISOString() ?? null,
              timezone: askZone(b.lead),
              kindLabel,
              manageUrl,
            },
          },
  );
  await deps.mailer.send({
    to: {
      to: lead.contactEmail,
      ...(lead.contactName ? { name: lead.contactName } : {}),
    },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tags,
    metadata,
    idempotencyKey: idempotencyKeyFor(signupIds, kind, "email"),
  });
}
