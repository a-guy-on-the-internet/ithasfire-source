import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { zoneOption } from "../lib/event-time-zone";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type EventAnnouncementProps = {
  eventTitle: string;
  dateISO: string;
  /** The event's IANA timezone; the date renders in it. */
  timezone?: string | null;
  ctaUrl: string;
  teaser?: string;
  /** When set, footer shows "reply to reach the organizer" instead of generic text. */
  organizerContactEmail?: string | null;
};

const formatDate = (iso: string, timezone: string | null | undefined) => {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "full",
    ...zoneOption(timezone),
  }).format(new Date(iso));
};

export const EventAnnouncement = (
  props: EventAnnouncementProps,
): ReactElement => {
  const { eventTitle, dateISO, timezone, ctaUrl, teaser, organizerContactEmail } =
    props;

  return (
    <Shell
      title={`${eventTitle} announcement`}
      previewText={teaser ?? eventTitle}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>New date announced</Text>
        <Text style={headingStyle}>{eventTitle}</Text>
      </Section>

      {teaser ? (
        <Section style={{ marginBottom: spacing(2) }}>
          <Text style={teaserStyle}>{teaser}</Text>
        </Section>
      ) : null}

      <Section style={cardStyle}>
        <Text style={cardLabelStyle}>When</Text>
        <Text style={cardValueStyle}>{formatDate(dateISO, timezone)}</Text>
      </Section>

      <Section style={{ marginTop: spacing(3) }}>
        <Button
          href={ctaUrl}
          style={primaryButtonStyle}
          aria-label="Respond to announcement"
        >
          RSVP now
        </Button>
      </Section>

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

const teaserStyle: React.CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
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
  marginBottom: spacing(1),
};

const cardValueStyle: React.CSSProperties = {
  fontSize: "20px",
  fontWeight: 700,
  margin: 0,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
};

const footerStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
