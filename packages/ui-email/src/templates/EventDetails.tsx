import { Button, Hr, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";
import { formatEventTimeRange } from "@th/locale";

import { Shell } from "./Shell";
import {
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";
import {
  proseMirrorDocToEmailHtml,
  hasContent,
  type ProseMirrorDoc,
} from "../lib/prose-to-html";

export type EventDetailsProps = {
  /** Event title/headline */
  eventTitle: string;
  /** Event start date/time in ISO format */
  startsAtISO: string;
  /** Event end date/time in ISO format (optional) */
  endsAtISO?: string;
  /** IANA timezone (e.g., "America/Los_Angeles") */
  timezone?: string;
  /** Rich text description as ProseMirror JSON */
  descriptionDoc?: ProseMirrorDoc | null;
  /** Venue or location name */
  venueName?: string;
  /** Full address text */
  addressText?: string;
  /** Hero image URL (optional) */
  heroImageUrl?: string;
  /** URL to the event page */
  eventUrl: string;
  /** Organizer name */
  organizerName?: string;
  /** Organizer contact email. When present the footer invites a reply. */
  organizerContactEmail?: string | null;
};

export const EventDetails = (props: EventDetailsProps): ReactElement => {
  const {
    eventTitle,
    startsAtISO,
    endsAtISO,
    timezone,
    descriptionDoc,
    venueName,
    addressText,
    heroImageUrl,
    eventUrl,
    organizerName,
    organizerContactEmail,
  } = props;

  const hasDescription = hasContent(descriptionDoc ?? null);
  const descriptionHtml = hasDescription
    ? proseMirrorDocToEmailHtml(descriptionDoc!)
    : null;

  return (
    <Shell title={eventTitle} previewText={`${eventTitle}`}>
      {/* Hero image */}
      {heroImageUrl && (
        <Section style={heroSectionStyle}>
          <img src={heroImageUrl} alt={eventTitle} style={heroImageStyle} />
        </Section>
      )}

      {/* Event header */}
      <Section style={{ marginBottom: "24px" }}>
        <Text style={headingStyle}>{eventTitle}</Text>
        {organizerName && (
          <Text style={organizerStyle}>Presented by {organizerName}</Text>
        )}
      </Section>

      <Hr style={dividerStyle} />

      {/* Date/time */}
      <Section style={detailBlockStyle}>
        <Text style={labelStyle}>DATE</Text>
        <Text style={valueStyle}>
          {formatEventTimeRange(startsAtISO, endsAtISO, { timeZone: timezone })}
        </Text>
        {timezone && <Text style={subtextStyle}>{timezone}</Text>}
      </Section>

      {/* Location */}
      {/* eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing */}
      {(venueName || addressText) && (
        <Section style={detailBlockStyle}>
          <Text style={labelStyle}>LOCATION</Text>
          {venueName && <Text style={valueStyle}>{venueName}</Text>}
          {addressText && <Text style={subtextStyle}>{addressText}</Text>}
        </Section>
      )}

      <Hr style={dividerStyle} />

      {/* Description */}
      {descriptionHtml && (
        <Section style={descriptionSectionStyle}>
          <div
            style={descriptionContentStyle}
            dangerouslySetInnerHTML={{ __html: descriptionHtml }}
          />
        </Section>
      )}

      {/* CTA */}
      <Section style={{ marginTop: "32px", textAlign: "center" }}>
        <Button
          href={eventUrl}
          style={primaryButtonStyle}
          aria-label="View event"
        >
          View Event
        </Button>
      </Section>

      <Hr style={{ ...dividerStyle, marginTop: "32px" }} />

      <Text style={footerStyle}>
        {organizerContactEmail
          ? "Have questions? Reply to this email to reach the organizer."
          : "Have questions? Visit the event page for more details."}
      </Text>
    </Shell>
  );
};

const heroSectionStyle: React.CSSProperties = {
  marginBottom: "24px",
  border: `2px solid ${tokens.colors.text}`,
};

const heroImageStyle: React.CSSProperties = {
  width: "100%",
  height: "auto",
  display: "block",
};

const headingStyle: React.CSSProperties = {
  fontSize: "32px",
  fontWeight: 700,
  margin: 0,
  lineHeight: tokens.typography.headingTightLH,
  color: tokens.colors.text,
  textTransform: "uppercase",
  letterSpacing: "-0.02em",
};

const organizerStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  margin: 0,
  marginTop: "8px",
  fontStyle: "italic",
};

const dividerStyle: React.CSSProperties = {
  borderTop: `1px solid ${tokens.colors.border}`,
  borderBottom: "none",
  margin: "24px 0",
};

const detailBlockStyle: React.CSSProperties = {
  marginBottom: "20px",
};

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: "4px",
  letterSpacing: "0.1em",
};

const valueStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  margin: 0,
  color: tokens.colors.text,
};

const subtextStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  margin: 0,
  marginTop: "2px",
};

const descriptionSectionStyle: React.CSSProperties = {
  marginTop: "24px",
};

const descriptionContentStyle: React.CSSProperties = {
  fontSize: "15px",
  lineHeight: 1.5,
  color: tokens.colors.text,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  fontSize: "14px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const footerStyle: React.CSSProperties = {
  fontSize: "13px",
  color: tokens.colors.mutedText,
  marginTop: "16px",
  fontStyle: "italic",
};
