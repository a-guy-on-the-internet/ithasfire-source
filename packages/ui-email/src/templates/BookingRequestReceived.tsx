import { Button, Column, Link, Row, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type BookingRequestReceivedProps = {
  /** Name of the venue/place the request was sent to. */
  placeName: string;
  /** Act / performer display name as entered by the submitter. */
  actName: string;
  /** Contact person's name (anonymous embed submissions carry one). */
  contactName?: string | null;
  /** Contact email for off-platform replies (anonymous submissions). */
  contactEmail?: string | null;
  /**
   * The pitch message. Sanitized upstream but treated as untrusted plain
   * text here — rendered via JSX text nodes only (React escapes), never
   * dangerouslySetInnerHTML.
   */
  message: string;
  /** Preferred dates as ISO date strings (e.g. "2026-08-14"). */
  preferredDates?: string[];
  /** Where the request came from. */
  source: "PLATFORM" | "EMBED";
  /** Absolute URL of the venue's booking inbox. */
  inboxUrl: string;
};

/**
 * "New booking request for {place}" — sent to the place owner / org staff
 * whenever a booking request arrives, from the platform form or the embed
 * widget (FR-008). Hardcoded English copy (like EventLocationRevealed /
 * RsvpConfirmed) — no translator keys, so the locale bundles stay untouched.
 */
const formatPreferredDate = (iso: string) => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  // Date-only ISO strings ("2026-08-14") parse as UTC midnight; format in
  // UTC so the rendered day never shifts across the date line.
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(parsed);
};

export const BookingRequestReceived = (
  props: BookingRequestReceivedProps,
): ReactElement => {
  const {
    placeName,
    actName,
    contactName,
    contactEmail,
    message,
    preferredDates,
    source,
    inboxUrl,
  } = props;

  const hasDates = Boolean(preferredDates && preferredDates.length > 0);

  return (
    <Shell
      title={`New booking request for ${placeName}`}
      previewText={`${actName} wants to play ${placeName}.`}
    >
      <Section style={{ marginBottom: spacing(3) }}>
        <Text style={eyebrowStyle}>NEW BOOKING REQUEST</Text>
        <Text style={headingStyle}>
          {actName} wants to play {placeName}
        </Text>
        <Text style={subtitleStyle}>
          {source === "EMBED"
            ? "Sent through the booking button on your website."
            : "Sent through your page on Ithas Fire."}
        </Text>
      </Section>

      <Section style={cardStyle}>
        <Row style={{ marginBottom: spacing(1) }}>
          <Column>
            <Text style={labelStyle}>FROM</Text>
            <Text style={valueStyle}>{actName}</Text>
            {contactName && <Text style={mutedValueStyle}>{contactName}</Text>}
            {contactEmail && (
              <Link href={`mailto:${contactEmail}`} style={emailLinkStyle}>
                {contactEmail}
              </Link>
            )}
          </Column>
        </Row>
        {hasDates && (
          <Row style={{ marginBottom: spacing(1) }}>
            <Column>
              <Text style={labelStyle}>PREFERRED DATES</Text>
              {preferredDates?.map((iso, index) => (
                <Text key={`${iso}-${index}`} style={valueStyle}>
                  {formatPreferredDate(iso)}
                </Text>
              ))}
            </Column>
          </Row>
        )}
        <Row>
          <Column>
            <Text style={labelStyle}>THE PITCH</Text>
            <Text style={messageStyle}>{message}</Text>
          </Column>
        </Row>
      </Section>

      <Section style={{ textAlign: "center" }}>
        <Button
          style={primaryButtonStyle}
          href={inboxUrl}
          aria-label="Open your booking inbox"
        >
          Open booking inbox
        </Button>
      </Section>

      <Text style={mutedTextStyle}>
        You&apos;re receiving this because {placeName} accepts booking requests
        on Ithas Fire. You can respond from your booking inbox
        {contactEmail ? " or reply to the sender directly by email" : ""}.
      </Text>
    </Shell>
  );
};

const fontFamily = tokens.typography.fontFamily;

const eyebrowStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "12px",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(1),
};

const headingStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "26px",
  fontWeight: 700,
  margin: 0,
  marginBottom: spacing(1),
  color: tokens.colors.text,
  lineHeight: tokens.typography.headingTightLH,
};

const subtitleStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  margin: 0,
  color: tokens.colors.mutedText,
};

const cardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.surfaceMuted,
  borderRadius: tokens.radius,
  padding: "20px",
  border: `1px solid ${tokens.colors.border}`,
  marginBottom: spacing(3),
};

const labelStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  marginBottom: "4px",
};

const valueStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  margin: 0,
  fontWeight: 700,
  color: tokens.colors.text,
};

const mutedValueStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "14px",
  margin: 0,
  color: tokens.colors.mutedText,
};

const emailLinkStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "14px",
  color: tokens.colors.brand,
  textDecoration: "underline",
};

const messageStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "15px",
  margin: 0,
  color: tokens.colors.text,
  lineHeight: tokens.typography.lineHeight,
  whiteSpace: "pre-wrap",
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  fontFamily,
  textAlign: "center",
};

const mutedTextStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "12px",
  color: tokens.colors.mutedText,
  margin: `${spacing(3)} 0 0 0`,
};
