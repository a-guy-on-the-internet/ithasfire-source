import { Button, Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { zoneOption } from "../lib/event-time-zone";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type VolunteerSignupReceivedProps = {
  eventTitle: string;
  roleName: string;
  shiftLabel?: string | null;
  shiftStartsAtISO?: string | null;
  shiftEndsAtISO?: string | null;
  /** The shift's IANA timezone (the event's, or the ask's); times render in it. */
  timezone?: string | null;
  status: "PENDING" | "APPROVED";
  accountCompletionUrl?: string | null;
  organizerContactEmail?: string | null;
};

const formatDateTime = (iso: string, timezone: string | null | undefined) => {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timezone),
  }).format(new Date(iso));
};

const formatShiftWindow = (
  startsAtISO: string | null | undefined,
  endsAtISO: string | null | undefined,
  timezone: string | null | undefined,
): string | null => {
  if (!startsAtISO && !endsAtISO) return null;
  if (startsAtISO && endsAtISO) {
    return `${formatDateTime(startsAtISO, timezone)} – ${formatDateTime(endsAtISO, timezone)}`;
  }
  return formatDateTime((startsAtISO ?? endsAtISO)!, timezone);
};

export const VolunteerSignupReceived = (
  props: VolunteerSignupReceivedProps,
): ReactElement => {
  const {
    eventTitle,
    roleName,
    shiftLabel,
    shiftStartsAtISO,
    shiftEndsAtISO,
    timezone,
    status,
    accountCompletionUrl,
    organizerContactEmail,
  } = props;

  const isApproved = status === "APPROVED";
  const eyebrow = isApproved ? "You're confirmed" : "Signup received";
  const heading = isApproved
    ? "You're confirmed to volunteer"
    : "Thanks for signing up to volunteer";
  const statusLine = isApproved
    ? "You're confirmed"
    : "Your signup is pending review";
  const previewText = isApproved
    ? `You're confirmed to volunteer at ${eventTitle}.`
    : `Thanks for signing up to volunteer at ${eventTitle}.`;

  const shiftWindow = formatShiftWindow(
    shiftStartsAtISO,
    shiftEndsAtISO,
    timezone,
  );

  return (
    <Shell
      title={`Thanks for signing up to volunteer at ${eventTitle}`}
      previewText={previewText}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>{eyebrow}</Text>
        <Text style={headingStyle}>{heading}</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          Thanks for signing up to help at <strong>{eventTitle}</strong>. We've
          recorded your interest in the <strong>{roleName}</strong> role.
        </Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={metaLineStyle}>
          <strong>Status:</strong> {statusLine}
        </Text>
        <Text style={metaLineStyle}>
          <strong>Role:</strong> {roleName}
        </Text>
        {shiftLabel ? (
          <Text style={metaLineStyle}>
            <strong>Shift:</strong> {shiftLabel}
          </Text>
        ) : null}
        {shiftWindow ? (
          <Text style={metaLineStyle}>
            <strong>When:</strong> {shiftWindow}
          </Text>
        ) : null}
      </Section>

      {accountCompletionUrl ? (
        <Section style={{ marginTop: spacing(3) }}>
          <Text style={bodyStyle}>
            Finish setting up your account so you can manage this signup.
          </Text>
          <Button
            href={accountCompletionUrl}
            style={primaryButtonStyle}
            aria-label="Complete your account"
          >
            Complete your account
          </Button>
        </Section>
      ) : null}

      <Text style={footerStyle}>
        {organizerContactEmail
          ? "Have questions? Reply to this email to reach the organizer."
          : "Have questions? Visit the event page for more details."}
      </Text>
    </Shell>
  );
};

const eyebrowStyle: CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
  color: tokens.colors.brand,
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
  marginBottom: spacing(1),
  lineHeight: 1.5,
};

const metaLineStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.text,
  margin: 0,
  marginBottom: spacing(0),
  lineHeight: 1.5,
};

const primaryButtonStyle: CSSProperties = {
  ...sharedPrimaryButton,
  marginTop: spacing(1),
};

const footerStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
