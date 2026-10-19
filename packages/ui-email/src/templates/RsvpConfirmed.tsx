import { Button, Hr, Link, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";
import { formatEventTimeRange } from "@th/locale";

import { Shell } from "./Shell";
import {
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type RsvpConfirmedProps = {
  /** Event title/headline */
  eventTitle: string;
  /** Event start date/time in ISO format */
  startsAtISO: string;
  /** Event end date/time in ISO format (optional) */
  endsAtISO?: string | null;
  /** IANA timezone (e.g., "America/Chicago") */
  timezone?: string | null;
  /** Venue or location name */
  venueName?: string | null;
  /** Full address text */
  addressText?: string | null;
  /** Hero image URL (optional) */
  heroImageUrl?: string | null;
  /**
   * URL to the event page. The page hosts the RSVP toggle, so this is ALSO
   * how the recipient cancels — there is no tokenized one-click cancel.
   */
  eventUrl?: string | null;
  /** URL to the recipient's /my-rsvps list. */
  manageRsvpsUrl?: string | null;
};

export const RsvpConfirmed = (props: RsvpConfirmedProps): ReactElement => {
  const {
    eventTitle,
    startsAtISO,
    endsAtISO,
    timezone,
    venueName,
    addressText,
    heroImageUrl,
    eventUrl,
    manageRsvpsUrl,
  } = props;

  return (
    <Shell
      title={`You're going to ${eventTitle}`}
      previewText={`Your RSVP for ${eventTitle} is confirmed.`}
    >
      {/* Hero image */}
      {heroImageUrl && (
        <Section style={heroSectionStyle}>
          <img src={heroImageUrl} alt={eventTitle} style={heroImageStyle} />
        </Section>
      )}

      {/* Header */}
      <Section style={{ marginBottom: "24px" }}>
        <Text style={confirmedStyle}>RSVP CONFIRMED</Text>
        <Text style={headingStyle}>{eventTitle}</Text>
      </Section>

      <Hr style={dividerStyle} />

      {/* Date/time */}
      <Section style={detailBlockStyle}>
        <Text style={labelStyle}>DATE</Text>
        <Text style={valueStyle}>
          {formatEventTimeRange(startsAtISO, endsAtISO ?? undefined, {
            timeZone: timezone ?? undefined,
          })}
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

      {/* CTA — omitted when the event has no resolvable public page. */}
      {eventUrl ? (
        <Section style={{ marginTop: "32px", textAlign: "center" }}>
          <Button
            href={eventUrl}
            style={primaryButtonStyle}
            aria-label="View event"
          >
            View Event
          </Button>
        </Section>
      ) : null}

      <Hr style={{ ...dividerStyle, marginTop: "32px" }} />

      <Text style={footerStyle}>
        {manageRsvpsUrl ? (
          <>
            Changed your plans?{" "}
            <Link href={manageRsvpsUrl} style={footerLinkStyle}>
              Manage your RSVPs
            </Link>{" "}
            — or un-RSVP anytime from the event page.
          </>
        ) : (
          "Changed your plans? You can un-RSVP anytime from the event page."
        )}
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

const confirmedStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 700,
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: "8px",
  letterSpacing: "0.12em",
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

const footerLinkStyle: React.CSSProperties = {
  color: tokens.colors.text,
  textDecoration: "underline",
};
