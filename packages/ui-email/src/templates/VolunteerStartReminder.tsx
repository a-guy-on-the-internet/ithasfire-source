import { Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { zoneOption } from "../lib/event-time-zone";
import { spacing, tokens } from "../theme/tokens";

/**
 * Reminder for a volunteer anchored by a START rather than a shift
 * (volunteer-ask-reminders FR-004): a role at an event with no shifts
 * (`anchor: "event"`, before the event starts) or a one-time ask
 * (`anchor: "ask"`, before the ask starts). Sibling of
 * `VolunteerShiftReminder`; it says what starts and never "your shift".
 */
export type VolunteerStartReminderProps = {
  anchor: "event" | "ask";
  /** The event's or the ask's title. */
  title: string;
  /** Null when the role has no name of its own (the "Volunteer" fallback). */
  roleName: string | null;
  startsAtISO: string;
  /** Shown only when set (an ask may have no end). */
  endsAtISO?: string | null;
  /**
   * IANA zone the times render in, named beside them: the event's, or the
   * ask's (else its place's, else the platform default, America/Chicago).
   */
  timezone?: string | null;
  /** "Tomorrow" / "In about an hour" — eyebrow + lead line. */
  kindLabel: string;
  /** Event address line (gated by the sender). Never shown for an ask. */
  addressText?: string | null;
  /** The signup (event) or the ask's public page (ask). */
  manageUrl?: string | null;
  /**
   * Two or more roles of one person on this event or ask at this start
   * (volunteer-ask-reminders R12): one email lists them all. Unset, or a
   * single entry, reads `roleName`.
   */
  roleNames?: string[] | null;
};

const formatDateTime = (iso: string, timezone: string | null | undefined) =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timezone),
  }).format(new Date(iso));

/** "Nov 1, 2026, 7:00 PM CDT", the zone named so a UTC fallback reads as one. */
const formatWithZone = (iso: string, timezone: string | null | undefined) => {
  const zoneName = new Intl.DateTimeFormat("en", {
    timeZoneName: "short",
    ...zoneOption(timezone),
  })
    .formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName")?.value;
  const at = formatDateTime(iso, timezone);
  return zoneName ? `${at} ${zoneName}` : at;
};

export const volunteerStartReminderSubject = ({
  title,
  kindLabel,
}: Pick<VolunteerStartReminderProps, "title" | "kindLabel">): string =>
  `Reminder: ${title} starts ${kindLabel.toLowerCase()}`;

export const VolunteerStartReminder = (
  props: VolunteerStartReminderProps,
): ReactElement => {
  const {
    anchor,
    title,
    roleName,
    startsAtISO,
    endsAtISO,
    timezone,
    kindLabel,
    addressText,
    manageUrl,
    roleNames,
  } = props;

  const when = endsAtISO
    ? `${formatDateTime(startsAtISO, timezone)} – ${formatWithZone(endsAtISO, timezone)}`
    : formatWithZone(startsAtISO, timezone);
  const where = anchor === "event" ? addressText : null;
  const group = roleNames && roleNames.length > 1 ? roleNames : null;

  return (
    <Shell
      title={volunteerStartReminderSubject({ title, kindLabel })}
      previewText={`${kindLabel} — ${title} starts.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>{kindLabel.toUpperCase()}</Text>
        <Text style={headingStyle}>{title} is coming up.</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        {group ? (
          <>
            <Text style={bodyStyle}>
              Quick reminder — you signed up to volunteer at{" "}
              <strong>{title}</strong> as:
            </Text>
            <ul style={listStyle}>
              {group.map((name, i) => (
                <li key={i} style={listItemStyle}>
                  <strong>{name}</strong>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Text style={bodyStyle}>
            Quick reminder — you signed up to volunteer at{" "}
            <strong>{title}</strong>
            {roleName ? (
              <>
                {" "}
                as <strong>{roleName}</strong>
              </>
            ) : null}
            .
          </Text>
        )}
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={metaLineStyle}>
          <strong>When:</strong> {when}
        </Text>
        {where ? (
          <Text style={metaLineStyle}>
            <strong>Where:</strong> {where}
          </Text>
        ) : null}
      </Section>

      {/* No reply promise: these emails set no reply-to, so a reply reaches
          the platform, not the organizer. Link labels match the in-app row. */}
      {manageUrl ? (
        <Text style={footerStyle}>
          Can&apos;t make it?{" "}
          <a href={manageUrl} style={linkStyle}>
            {anchor === "event" ? "Open your signup" : "View details"}
          </a>
        </Text>
      ) : null}
    </Shell>
  );
};

const eyebrowStyle: CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
  color: tokens.colors.brandAccent,
  margin: 0,
  marginBottom: spacing(1),
};

const headingStyle: CSSProperties = {
  fontSize: "28px",
  fontWeight: 700,
  margin: 0,
  lineHeight: tokens.typography.headingTightLH,
};

const bodyStyle: CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
};

const metaLineStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
};

const listStyle: CSSProperties = {
  margin: 0,
  marginTop: spacing(1),
  paddingLeft: "20px",
};

const listItemStyle: CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.text,
  lineHeight: 1.5,
};

const footerStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};

const linkStyle: CSSProperties = {
  color: tokens.colors.brandAccent,
  textDecoration: "underline",
};
