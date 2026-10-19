import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { zoneOption } from "../lib/event-time-zone";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type EventRescheduledProps = {
  sourceEventTitle: string;
  sourceEventDateISO: string;
  targetEventTitle: string;
  targetEventDateISO: string;
  /** The source event's IANA timezone; its date renders in it. */
  sourceEventTimezone?: string | null;
  /** The target event's IANA timezone; its date renders in it. */
  targetEventTimezone?: string | null;
  manageUrl: string;
  /** When set, footer shows "reply to reach the organizer" instead of generic text. */
  organizerContactEmail?: string | null;
};

const formatDate = (iso: string, timezone: string | null | undefined) => {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "full",
    timeStyle: "short",
    ...zoneOption(timezone),
  }).format(new Date(iso));
};

export const EventRescheduled = (
  props: EventRescheduledProps,
): ReactElement => {
  const {
    sourceEventTitle,
    sourceEventDateISO,
    targetEventTitle,
    targetEventDateISO,
    sourceEventTimezone,
    targetEventTimezone,
    manageUrl,
    organizerContactEmail,
  } = props;

  return (
    <Shell
      title="Your event has been rescheduled"
      previewText={`${sourceEventTitle} has moved to ${formatDate(targetEventDateISO, targetEventTimezone)}`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Event rescheduled</Text>
        <Text style={headingStyle}>Your tickets have been moved</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          <strong>{sourceEventTitle}</strong> on{" "}
          {formatDate(sourceEventDateISO, sourceEventTimezone)} has been rescheduled. Your tickets
          have been automatically transferred to the new date.
        </Text>
      </Section>

      <Section style={cardStyle}>
        <Text style={cardLabelStyle}>New event</Text>
        <Text style={cardValueStyle}>{targetEventTitle}</Text>
        <Text style={cardDateStyle}>
          {formatDate(targetEventDateISO, targetEventTimezone)}
        </Text>
      </Section>

      <Section style={{ marginTop: spacing(3) }}>
        <Button
          href={manageUrl}
          style={primaryButtonStyle}
          aria-label="View your tickets"
        >
          View your tickets
        </Button>
      </Section>

      <Text style={refundNoteStyle}>
        If you can no longer attend, you can request a refund from your order
        page.
      </Text>

      <Text style={footerStyle}>
        {organizerContactEmail
          ? "Have questions? Reply to this email to reach the organizer."
          : "Have questions? Visit the event page for more details."}
      </Text>
    </Shell>
  );
};

const eyebrowStyle: React.CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
  color: tokens.colors.brandAccent,
  margin: 0,
  marginBottom: spacing(1),
};

const headingStyle: React.CSSProperties = {
  fontSize: "28px",
  fontWeight: 700,
  margin: 0,
  lineHeight: tokens.typography.headingTightLH,
};

const bodyStyle: React.CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: "1.5",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.surfaceMuted,
  borderRadius: tokens.radius,
  padding: "24px",
  border: `1px solid ${tokens.colors.border}`,
};

const cardLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(0.5),
};

const cardValueStyle: React.CSSProperties = {
  fontSize: "20px",
  fontWeight: 700,
  margin: 0,
};

const cardDateStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 400,
  color: tokens.colors.text,
  margin: 0,
  marginTop: spacing(0.5),
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
};

const refundNoteStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(2),
  fontStyle: "italic",
};

const footerStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
