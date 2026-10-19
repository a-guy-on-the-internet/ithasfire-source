import { z } from "zod";

import type { NotificationCategory } from "./categories";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { formatEventDate, formatEventStart } from "./copy/common";
import { LINEUP_ADDED_COPY, LINEUP_LEFT_COPY } from "./copy/lineup";
import type { NotificationLocale } from "./locale";
import type { RenderNotificationResult } from "./renderers";

// ─────────────────────────────────────────────────────────────────────────────
// Lineup notices (owner ruling "option A", 2026-09-30).
//
// An event editor can put a REAL person (a linked humanId) on a lineup
// without asking. These two renderers are how that person hears about it and
// how the editors hear that the person took themselves off. (The payout
// invite for a free-text row is NOT a notify() variant: it goes to a shadow
// profile, whose unverified address notify()'s email leg always skips — see
// event-humans/notify-lineup-notices.ts.) Registered in `renderers.ts`'s registry; kept
// in their own file so the lineup feature splices in and out as one piece.
//
// The copy is the owner's (2026-09-30 drafts). Keep it gender-neutral: the
// person's name, or they/them — never he/she.
// ─────────────────────────────────────────────────────────────────────────────

type Tags = string[];
type Metadata = Record<string, string>;

type LineupRendererDefinition<TSchema extends z.ZodTypeAny> = {
  variant: string;
  category: NotificationCategory;
  schema: TSchema;
  render(
    input: z.infer<TSchema>,
    ctx: { now: Date; locale: NotificationLocale },
  ): RenderNotificationResult;
};

export const LINEUP_ADDED_VARIANT = "event.lineup-added" as const;
export const LINEUP_LEFT_VARIANT = "event.lineup-left" as const;

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Formats in the EVENT's timezone, falling back to the platform default
 * (`resolveTimeZone`) when the id is missing or unknown, never UTC: UTC is
 * the server's zone and put an evening show on the next day. Null for an
 * unparseable instant, so callers drop the fragment instead of printing
 * "Invalid Date".
 */
function formatInZone(
  iso: string,
  timezone: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (
    new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: resolveTimeZone(timezone),
    })
      .format(date)
      // Some ICU builds put a narrow no-break space before AM/PM. Plain text
      // and subject lines want an ordinary space.
      .replace(/[  ]/g, " ")
  );
}

/** "Sat, Oct 4, 5:00 PM" — the in-app / push line. */
export function formatLineupShortDateTime(
  iso: string,
  timezone: string | null | undefined,
): string | null {
  return formatInZone(iso, timezone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Sat, Oct 4" — the editors' left notice. */
export function formatLineupShortDate(
  iso: string,
  timezone: string | null | undefined,
): string | null {
  return formatInZone(iso, timezone, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * The in-app date fragments per locale. English keeps its own short forms
 * ("Sat, Oct 4, 5:00 PM", stored since before locales); other languages use
 * the shared event-date phrasing (copy/common.ts).
 */
const IN_APP_LINEUP_WHEN: {
  readonly [L in NotificationLocale]: {
    readonly dateTime: (
      iso: string,
      timezone: string | null | undefined,
    ) => string | null;
    readonly date: (
      iso: string,
      timezone: string | null | undefined,
    ) => string | null;
  };
} = {
  en: { dateTime: formatLineupShortDateTime, date: formatLineupShortDate },
  es: {
    dateTime: (iso, tz) => formatEventStart("es", iso, tz),
    date: (iso, tz) => formatEventDate("es", iso, tz),
  },
};

/**
 * The city part of an IANA zone id: "America/Chicago" → "Chicago",
 * "America/Indiana/Indianapolis" → "Indianapolis". UTC-ish ids read "UTC".
 */
export function timezoneCity(timezone: string | null | undefined): string {
  const tz = timezone?.trim() || "UTC";
  if (/^(Etc\/)?(UTC|GMT|Zulu|UCT|Universal)$/i.test(tz)) return "UTC";
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

/**
 * "Sunday, October 4, 2026 at 5:00 PM (Chicago time)" — the email's When row:
 * full date, time, and the zone's city so a touring act never has to guess
 * whose 5 PM it is.
 */
export function formatLineupFullWhen(
  iso: string,
  timezone: string | null | undefined,
): string | null {
  const formatted = formatInZone(iso, timezone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (!formatted) return null;
  // The same zone formatInZone used, so the label names the clock it read.
  return `${formatted} (${timezoneCity(resolveTimeZone(timezone))} time)`;
}

/** Path + query of an absolute URL, for in-app routes. Null if unparseable. */
function pathOf(absoluteUrl: string): string | null {
  try {
    const url = new URL(absoluteUrl);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

// ── event.lineup-added ───────────────────────────────────────────────────────

const lineupAddedSchema = z
  .object({
    eventId: z.string().uuid(),
    /** The lineup row. The dedupe identity: one notice per row, ever. */
    eventHumanId: z.string().uuid(),
    eventTitle: z.string().min(1).max(300),
    startsAtIso: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).nullable().optional(),
    /** Human-readable role ("Performer", "DJ", a custom label for OTHER). */
    roleLabel: z.string().min(1).max(120),
    /**
     * Who put them on it. The CALLER guarantees non-empty (falls back to the
     * organiser's name) — `.min(1)` fails notify() before its claim.
     */
    addedByName: z.string().min(1).max(200),
    /** Absolute `{publicAppUrl}/my-lineups`. */
    lineupsUrl: z.string().url(),
    /**
     * PUBLIC event AND a role the public lineup lists (PUBLIC_LINEUP_ROLES).
     * Only then does the name really show on the event page and profile.
     */
    publiclyListed: z.boolean(),
    /**
     * The event has STARTED (`startsAt <= now`) — the profile's upcoming-shows
     * filter is `startsAt > now`, so no "upcoming shows" to promise.
     */
    eventEnded: z.boolean(),
    /**
     * The event has someone to tell when the person leaves (an owning org or
     * human). False for an ownerless community listing.
     */
    organiserWillBeTold: z.boolean(),
  })
  .strict();

/**
 * The "where your name shows / you can leave" paragraph — shared by the
 * plain-text part here and (as separate sentences) the ui-email template.
 */
export function lineupAddedExplainer(flags: {
  publiclyListed: boolean;
  eventEnded: boolean;
  organiserWillBeTold: boolean;
}): string {
  const where = !flags.publiclyListed
    ? "Your name is on the lineup for this event."
    : flags.eventEnded
      ? "Your name shows on the event page."
      : "Your name shows on the event page and in your profile's upcoming shows.";
  const leave = flags.organiserWillBeTold
    ? "If you didn't agree to this, or the details are wrong, you can take yourself off the lineup. The organiser will be told."
    : "If you didn't agree to this, or the details are wrong, you can take yourself off the lineup.";
  return `${where} ${leave}`;
}

export const eventLineupAddedRenderer: LineupRendererDefinition<
  typeof lineupAddedSchema
> = {
  variant: LINEUP_ADDED_VARIANT,
  // Cannot be muted: the person is told wherever their name appears.
  category: "transactional",
  schema: lineupAddedSchema,
  render(input, ctx): RenderNotificationResult {
    const title = LINEUP_ADDED_COPY.en.title(input);
    const shortWhen = formatLineupShortDateTime(
      input.startsAtIso,
      input.timezone,
    );
    const body = LINEUP_ADDED_COPY.en.body({
      addedByName: input.addedByName,
      roleLabel: input.roleLabel,
      when: shortWhen,
      eventEnded: input.eventEnded,
    });
    // In-app copy is in the render locale; push and email stay English.
    const copy = LINEUP_ADDED_COPY[ctx.locale];
    const whenLabel =
      formatLineupFullWhen(input.startsAtIso, input.timezone) ?? "";
    const route = pathOf(input.lineupsUrl) ?? "/my-lineups";

    const tags: Tags = ["event", "lineup", "lineup-added"];
    const metadata: Metadata = {
      eventId: input.eventId,
      eventHumanId: input.eventHumanId,
    };

    const heading = `${input.addedByName} put you on a lineup`;
    const text = [
      heading,
      `Event: ${input.eventTitle}`,
      ...(whenLabel ? [`When: ${whenLabel}`] : []),
      `As: ${input.roleLabel}`,
      lineupAddedExplainer(input),
      `Review your lineups: ${input.lineupsUrl}`,
      "You're getting this because someone added your Ithas Fire profile to an event. You can't turn these off, so you know where your name appears.",
    ].join("\n\n");

    return {
      category: "transactional",
      fingerprint: {
        variant: LINEUP_ADDED_VARIANT,
        eventHumanId: input.eventHumanId,
      },
      inApp: {
        title: copy.title(input),
        body: copy.body({
          addedByName: input.addedByName,
          roleLabel: input.roleLabel,
          when: IN_APP_LINEUP_WHEN[ctx.locale].dateTime(
            input.startsAtIso,
            input.timezone,
          ),
          eventEnded: input.eventEnded,
        }),
        kind: "INFO",
        action: { label: copy.reviewLabel, route },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      push: {
        title,
        body,
        collapseKey: `lineup-added-${input.eventHumanId}`,
        data: {
          eventId: input.eventId,
          eventHumanId: input.eventHumanId,
          url: input.lineupsUrl,
        },
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text,
        template: {
          key: "event.lineup_added",
          variables: {
            addedByName: input.addedByName,
            eventTitle: input.eventTitle,
            whenLabel,
            roleLabel: input.roleLabel,
            lineupsUrl: input.lineupsUrl,
            publiclyListed: input.publiclyListed,
            eventEnded: input.eventEnded,
            organiserWillBeTold: input.organiserWillBeTold,
          },
        },
        replyTo: null,
        tags,
        metadata,
      },
    };
  },
};

// ── event.lineup-left ────────────────────────────────────────────────────────

const lineupLeftSchema = z
  .object({
    eventId: z.string().uuid(),
    /** The removed row (gone from the DB; kept for the dedupe identity). */
    eventHumanId: z.string().uuid(),
    eventTitle: z.string().min(1).max(300),
    startsAtIso: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).nullable().optional(),
    /** The person who left. Caller guarantees non-empty. */
    personName: z.string().min(1).max(200),
    /** Absolute admin edit link, `…/events/{id}/edit?section=lineup`. */
    lineupUrl: z.string().url(),
    /**
     * The name WAS on the public event page (PUBLISHED + PUBLIC + a public
     * lineup role). Only then is "off the event page" true.
     */
    wasPubliclyListed: z.boolean(),
  })
  .strict();

export const eventLineupLeftRenderer: LineupRendererDefinition<
  typeof lineupLeftSchema
> = {
  variant: LINEUP_LEFT_VARIANT,
  // Same category as the editor-facing lineup/volunteer analogues
  // (volunteer.spot-opened, event.application-submission-received).
  category: "transactional",
  schema: lineupLeftSchema,
  render(input, ctx): RenderNotificationResult {
    const title = LINEUP_LEFT_COPY.en.title(input);
    const body = LINEUP_LEFT_COPY.en.body({
      eventTitle: input.eventTitle,
      date: formatLineupShortDate(input.startsAtIso, input.timezone),
      wasPubliclyListed: input.wasPubliclyListed,
    });
    // In-app copy is in the render locale; the email stays English.
    const copy = LINEUP_LEFT_COPY[ctx.locale];

    const tags: Tags = ["event", "lineup", "lineup-left"];
    const metadata: Metadata = {
      eventId: input.eventId,
      eventHumanId: input.eventHumanId,
    };

    return {
      category: "transactional",
      fingerprint: {
        variant: LINEUP_LEFT_VARIANT,
        eventHumanId: input.eventHumanId,
      },
      inApp: {
        title: copy.title(input),
        body: copy.body({
          eventTitle: input.eventTitle,
          date: IN_APP_LINEUP_WHEN[ctx.locale].date(
            input.startsAtIso,
            input.timezone,
          ),
          wasPubliclyListed: input.wasPubliclyListed,
        }),
        kind: "INFO",
        action: { label: copy.openLabel, href: input.lineupUrl },
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      // Plain-text email, like the other editor-facing roster notices
      // (volunteer.spot-opened / pool-signup-received).
      email: {
        subject: title,
        text: `${body}\n\nOpen the lineup: ${input.lineupUrl}`,
        replyTo: null,
        tags,
        metadata,
      },
    };
  },
};
