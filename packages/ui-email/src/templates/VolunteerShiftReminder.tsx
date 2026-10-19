import { Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { zoneOption } from "../lib/event-time-zone";
import { spacing, tokens } from "../theme/tokens";

/** One shift of a grouped reminder: its role, label and end. */
export type VolunteerShiftReminderRole = {
  roleName: string;
  shiftLabel?: string | null;
  /** This shift's end; falls back to the reminder's `shiftEndsAtISO`. */
  shiftEndsAtISO?: string | null;
};

export type VolunteerShiftReminderProps = {
  eventTitle: string;
  /** The (first) shift's role; the whole reminder when `roles` is unset. */
  roleName: string;
  shiftLabel?: string | null;
  shiftStartsAtISO: string;
  shiftEndsAtISO: string;
  /** The event's IANA timezone; the shift window renders in it. */
  timezone?: string | null;
  /** "Tomorrow" / "In about an hour" — short prose used in the eyebrow + lead line. */
  kindLabel: string;
  /** Event venue / address line, if known. */
  addressText?: string | null;
  /**
   * Public URL where the volunteer can withdraw or arrange a sub. We
   * leave wording vague so Phase 3 (find-a-sub) can repoint this
   * without changing the template.
   */
  manageUrl?: string | null;
  /**
   * Two or more shifts of one person at this event starting at the same
   * time (volunteer-ask-reminders R12): one email lists them all, each with
   * its label and window. Unset, or a single entry, reads as one shift.
   */
  roles?: VolunteerShiftReminderRole[] | null;
};

/**
 * "Reminder: your <event> shift starts tomorrow"; "shifts start" when one
 * email covers two or more shifts (R12).
 */
export const volunteerShiftReminderSubject = ({
  eventTitle,
  kindLabel,
  roles,
}: Pick<
  VolunteerShiftReminderProps,
  "eventTitle" | "kindLabel" | "roles"
>): string =>
  roles && roles.length > 1
    ? `Reminder: your ${eventTitle} shifts start ${kindLabel.toLowerCase()}`
    : `Reminder: your ${eventTitle} shift starts ${kindLabel.toLowerCase()}`;

const formatDateTime = (iso: string, timezone: string | null | undefined) =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timezone),
  }).format(new Date(iso));

const formatShiftWindow = (
  startsAtISO: string,
  endsAtISO: string,
  timezone: string | null | undefined,
) =>
  `${formatDateTime(startsAtISO, timezone)} – ${formatDateTime(endsAtISO, timezone)}`;

export const VolunteerShiftReminder = (
  props: VolunteerShiftReminderProps,
): ReactElement => {
  const {
    eventTitle,
    roleName,
    shiftLabel,
    shiftStartsAtISO,
    shiftEndsAtISO,
    timezone,
    kindLabel,
    addressText,
    manageUrl,
    roles,
  } = props;

  const shiftWindow = formatShiftWindow(
    shiftStartsAtISO,
    shiftEndsAtISO,
    timezone,
  );
  const group = roles && roles.length > 1 ? roles : null;

  return (
    <Shell
      title={volunteerShiftReminderSubject({ eventTitle, kindLabel, roles })}
      previewText={
        group
          ? `${kindLabel} — your shifts at ${eventTitle}.`
          : `${kindLabel} — your ${roleName} shift at ${eventTitle}.`
      }
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>{kindLabel.toUpperCase()}</Text>
        <Text style={headingStyle}>
          {group ? "Your shifts are coming up." : "Your shift is coming up."}
        </Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        {group ? (
          <Text style={bodyStyle}>
            Quick reminder — you signed up for these shifts at{" "}
            <strong>{eventTitle}</strong>:
          </Text>
        ) : (
          <Text style={bodyStyle}>
            Quick reminder — you signed up to volunteer at{" "}
            <strong>{eventTitle}</strong> as <strong>{roleName}</strong>.
          </Text>
        )}
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        {group ? (
          <ul style={listStyle}>
            {group.map((role, i) => (
              <li key={i} style={listItemStyle}>
                <strong>{role.roleName}</strong>
                {role.shiftLabel ? ` (${role.shiftLabel})` : ""}:{" "}
                {formatShiftWindow(
                  shiftStartsAtISO,
                  role.shiftEndsAtISO ?? shiftEndsAtISO,
                  timezone,
                )}
              </li>
            ))}
          </ul>
        ) : (
          <>
            {shiftLabel ? (
              <Text style={metaLineStyle}>
                <strong>Shift:</strong> {shiftLabel}
              </Text>
            ) : null}
            <Text style={metaLineStyle}>
              <strong>When:</strong> {shiftWindow}
            </Text>
          </>
        )}
        {addressText ? (
          <Text style={metaLineStyle}>
            <strong>Where:</strong> {addressText}
          </Text>
        ) : null}
      </Section>

      {/* No reply promise: these emails set no reply-to, so a reply reaches
          the platform, not the organizer. */}
      {manageUrl ? (
        <Text style={footerStyle}>
          Can&apos;t make it?{" "}
          <a href={manageUrl} style={linkStyle}>
            Open your signup
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
  marginBottom: spacing(1),
  paddingLeft: "20px",
};

const listItemStyle: CSSProperties = {
  fontSize: "14px",
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
