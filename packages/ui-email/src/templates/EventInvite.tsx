import { Link, Text } from "@react-email/components";
import { formatEventDateShort } from "@th/locale";
import { type ReactElement } from "react";

import { Ledger, type LedgerRow } from "./components/Ledger";
import { PrintedCta } from "./components/PrintedCta";
import { PrintedFrame, RawUrl, SmallPrint } from "./components/PrintedFrame";
import {
  ACCENT,
  bodyText,
  smallText,
} from "./components/printed-styles";
import {
  isKnownTimeZone,
  usableTimeZone as usableZone,
} from "../lib/event-time-zone";
import { TEXT_LINK_ATTR, TEXT_LINK_COLON } from "../lib/text-link";

/**
 * Variables exactly as core sends them (`sendInviteEmail` in
 * packages/core/src/use-cases/events/invites/_shared.ts): note the `Iso`
 * casing and the explicit nulls.
 */
export type EventInviteProps = {
  eventTitle: string;
  /**
   * The guest's personal link. It carries a bearer token, so it appears in
   * exactly two places: the button href and the raw-link line. Never in the
   * preview, the subject, alt text or anything else.
   */
  inviteUrl: string;
  /** English start line preformatted by core; used when the ISO parts fail. */
  eventWhen?: string | null;
  inviteeName?: string | null;
  organizerName?: string | null;
  startsAtIso?: string | null;
  endsAtIso?: string | null;
  /** The event's IANA timezone; the When row renders in it. */
  timezone?: string | null;
  /**
   * "Stop invites from this organiser" confirmation page. Carries the
   * OPT-OUT token (never the invite token). Absent = no footer line.
   */
  stopInvitesUrl?: string | null;
};

// Keep in step with the registry `subjectTemplate`; this is the document <title>.
const subjectFor = (eventTitle: string) => `You’re invited: ${eventTitle}`;

const isValidISO = (iso: string) => !Number.isNaN(new Date(iso).getTime());

/** Trimmed text, or null when absent or blank (a blank name reads as none). */
const present = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
};

/** Intl output uses narrow/thin no-break spaces; the email wants plain ones. */
const plainSpaces = (text: string) => text.replace(/[\u00a0\u2009\u202f]/g, " ");

const NBSP = "\u00a0";

/**
 * The footer opt-out (board decision 1, option A): the email's link colour
 * (`brandAccent`, the #B93312 rung that holds as text on white), set
 * explicitly because some clients paint links default blue, and underlined.
 * The line around it stays muted small print.
 */
const STOP_LINK = { color: ACCENT, textDecoration: "underline" } as const;

/**
 * "Sun, Oct 18 · 7:00 – 11:00 PM" where the only break point is the space
 * after "·": the date and the time range each stay whole, so a narrow
 * screen wraps to "Sun, Oct 18 ·" / "7:00 – 11:00 PM".
 */
const dayAndTime = (day: string, time: string) => {
  const keep = (part: string) => plainSpaces(part).replace(/ /g, NBSP);
  return `${keep(day)}${DAY_TIME_SEPARATOR}${keep(time)}`;
};

/** Joins the date and the time in the short form; the space after "·" is the break point. */
const DAY_TIME_SEPARATOR = `${NBSP}· `;

/**
 * Browsers still break after an en dash ("7:00 –" / "11:00 PM") even with a
 * no-break space after it, so each half also sits in a `nowrap` span. The
 * no-break spaces stay as the fallback for clients that drop inline styles.
 */
const NOWRAP = { whiteSpace: "nowrap" } as const;

const WhenValue = ({ when }: { when: string }): ReactElement => {
  const at = when.indexOf(DAY_TIME_SEPARATOR);
  if (at < 0) return <>{when}</>;
  return (
    <>
      <span style={NOWRAP}>{when.slice(0, at)}</span>
      {DAY_TIME_SEPARATOR}
      <span style={NOWRAP}>{when.slice(at + DAY_TIME_SEPARATOR.length)}</span>
    </>
  );
};

/**
 * The board's short When line, in the event's zone:
 * - same day: "Sat, Oct 18 · 7:00 – 11:00 PM" (Intl's range drops the shared PM);
 * - no end: "Sat, Oct 18 · 7:00 PM";
 * - across midnight or days: "Sat, Oct 18, 7:00 PM – Sun, Oct 19, 1:00 AM".
 * `@th/locale` has no short RANGE formatter; the multi-day form reuses its
 * single-instant `formatEventDateShort`.
 */
export const formatInviteWhen = (
  startsAtIso: string,
  endsAtIso: string | null | undefined,
  timezone: string | null | undefined,
): string => {
  const timeZone = usableZone(timezone);
  const zone = { timeZone };
  const start = new Date(startsAtIso);
  const end = endsAtIso ? new Date(endsAtIso) : null;
  const day = new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...zone,
  });
  const time = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    ...zone,
  });
  const calendarDay = new Intl.DateTimeFormat("en", {
    dateStyle: "short",
    ...zone,
  });
  if (!end || Number.isNaN(end.getTime()) || end <= start) {
    return dayAndTime(day.format(start), time.format(start));
  }
  if (calendarDay.format(start) === calendarDay.format(end)) {
    return dayAndTime(day.format(start), time.formatRange(start, end));
  }
  return plainSpaces(
    `${formatEventDateShort(start, { timeZone })} – ${formatEventDateShort(end, { timeZone })}`,
  );
};

/** Personal invite to a gated event ("Printed", owner pick 2026-10-03). */
export const EventInvite = (props: EventInviteProps): ReactElement => {
  const {
    eventTitle,
    inviteUrl,
    eventWhen,
    startsAtIso,
    endsAtIso,
    timezone,
  } = props;
  const inviteeName = present(props.inviteeName);
  const organizerName = present(props.organizerName);
  const stopInvitesUrl = present(props.stopInvitesUrl);

  // Without a zone Intl knows, this line would guess one (the platform
  // default) with no zone label, so core's line (which names its zone) wins;
  // the platform-default form is the last resort.
  const start = startsAtIso && isValidISO(startsAtIso) ? startsAtIso : null;
  const when =
    start && isKnownTimeZone(timezone)
      ? formatInviteWhen(start, endsAtIso, timezone)
      : (present(eventWhen) ??
        (start ? formatInviteWhen(start, endsAtIso, null) : null));

  // Owner ruling 10-05: keep the guest's name even without an organizer.
  const opening = organizerName
    ? `${inviteeName ? `${inviteeName}, ` : ""}${organizerName} invited you to a private event.`
    : inviteeName
      ? `${inviteeName}, you’re invited to a private event.`
      : "You’re invited to a private event.";

  const rows: LedgerRow[] = [
    { label: "Event", value: <strong>{eventTitle}</strong> },
  ];
  if (when) rows.push({ label: "When", value: <WhenValue when={when} /> });
  rows.push({ label: "Link works until", value: "The event ends" });

  return (
    <PrintedFrame
      subject={subjectFor(eventTitle)}
      previewText={
        organizerName
          ? `${organizerName} invited you to ${eventTitle}.`
          : `You’re invited to ${eventTitle}.`
      }
      kicker={organizerName ? `Invitation · ${organizerName}` : "Invitation"}
      title="You’re invited"
      accentTitle
    >
      <Text style={bodyText}>
        {opening} The link below is yours. It opens the event page on any
        device, with no password and no application.
      </Text>
      <Ledger rows={rows} />
      <PrintedCta kind="primary" label="Open the event" href={inviteUrl} />
      <SmallPrint>Button not working? Paste this link into your browser:</SmallPrint>
      <RawUrl url={inviteUrl} />
      <SmallPrint>
        This invite is for you. Anyone you forward it to can use it too.
      </SmallPrint>
      {stopInvitesUrl ? (
        // Plain text: "Stop invites from <organiser>: <url>" (text-link.ts).
        <Text style={{ ...smallText, marginTop: "16px" }}>
          <Link
            href={stopInvitesUrl}
            style={STOP_LINK}
            {...{ [TEXT_LINK_ATTR]: TEXT_LINK_COLON }}
          >
            {organizerName
              ? `Stop invites from ${organizerName}`
              : "Stop invites from this organiser"}
          </Link>
        </Text>
      ) : null}
    </PrintedFrame>
  );
};
