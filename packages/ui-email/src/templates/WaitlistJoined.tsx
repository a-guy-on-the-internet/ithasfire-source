import { Button, Hr, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { zoneOption } from "../lib/event-time-zone";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";
import {
  proseMirrorDocToEmailHtml,
  hasContent,
  type ProseMirrorDoc,
} from "../lib/prose-to-html";

export type WaitlistJoinedProps = {
  /** Event title/headline */
  eventTitle: string;
  /** Event start date/time in ISO format */
  eventDateISO: string;
  /** The event's IANA timezone; the date renders in it. */
  timezone?: string | null;
  /** URL to the public event page */
  eventUrl?: string | null;
  /** Hero image URL (optional) */
  heroImageUrl?: string | null;
  /** Organizer-authored rich text body (ProseMirror JSON) */
  organizerMessageDoc?: ProseMirrorDoc | null;
  /** Organizer contact email. When present the footer invites a reply. */
  organizerContactEmail?: string | null;
};

const formatDate = (iso: string, timezone: string | null | undefined) => {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short",
    ...zoneOption(timezone),
  }).format(new Date(iso));
};

export const WaitlistJoined = (props: WaitlistJoinedProps): ReactElement => {
  const {
    eventTitle,
    eventDateISO,
    timezone,
    eventUrl,
    heroImageUrl,
    organizerMessageDoc,
    organizerContactEmail,
  } = props;

  const hasOrganizerMessage = hasContent(organizerMessageDoc ?? null);
  const organizerMessageHtml = hasOrganizerMessage
    ? proseMirrorDocToEmailHtml(organizerMessageDoc!)
    : null;

  return (
    <Shell
      title={`You're on the waitlist for ${eventTitle}`}
      previewText={`You've been added to the waitlist for ${eventTitle}.`}
    >
      {heroImageUrl && (
        <Section style={heroSectionStyle}>
          <img src={heroImageUrl} alt={eventTitle} style={heroImageStyle} />
        </Section>
      )}

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Waitlist confirmed</Text>
        <Text style={headingStyle}>You're on the list</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          You've been added to the waitlist for <strong>{eventTitle}</strong> on{" "}
          {formatDate(eventDateISO, timezone)}. We'll notify you when tickets become
          available.
        </Text>
      </Section>

      {organizerMessageHtml && (
        <>
          <Hr style={dividerStyle} />
          <Section style={{ marginBottom: spacing(2) }}>
            <Text style={orgMessageLabelStyle}>A note from the organizer</Text>
            <div
              style={orgMessageContentStyle}
              dangerouslySetInnerHTML={{ __html: organizerMessageHtml }}
            />
          </Section>
        </>
      )}

      {/* Omitted when the event has no resolvable public page. */}
      {eventUrl ? (
        <Section
          style={{ marginTop: spacing(3), textAlign: "center" as const }}
        >
          <Button
            href={eventUrl}
            style={primaryButtonStyle}
            aria-label="View event"
          >
            View Event
          </Button>
        </Section>
      ) : null}

      <Hr style={{ ...dividerStyle, marginTop: spacing(3) }} />

      <Text style={footerStyle}>
        {organizerContactEmail
          ? "Have questions? Reply to this email to reach the organizer."
          : "Have questions? Visit the event page for more details."}
      </Text>
    </Shell>
  );
};

const heroSectionStyle: React.CSSProperties = {
  marginBottom: spacing(2),
  border: `2px solid ${tokens.colors.text}`,
};

const heroImageStyle: React.CSSProperties = {
  width: "100%",
  height: "auto",
  display: "block",
};

const eyebrowStyle: React.CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
  color: tokens.colors.brand,
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
  lineHeight: 1.5,
};

const dividerStyle: React.CSSProperties = {
  borderTop: `1px solid ${tokens.colors.border}`,
  borderBottom: "none",
  margin: `${spacing(2)} 0`,
};

const orgMessageLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(1),
};

const orgMessageContentStyle: React.CSSProperties = {
  fontSize: "15px",
  lineHeight: 1.5,
  color: tokens.colors.text,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
};

const footerStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(2),
};
