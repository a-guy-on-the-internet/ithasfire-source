import { Button, Column, Row, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type OrganizerBookingRequestReceivedProps = {
  /** Display name of the organizer org that sent the request. */
  orgName: string;
  /**
   * The pitch message. Sanitized upstream but treated as untrusted plain
   * text here — rendered via JSX text nodes only (React escapes), never
   * dangerouslySetInnerHTML.
   */
  message: string;
  /** Preferred dates as ISO date strings (e.g. "2026-08-14"). */
  preferredDates?: string[];
  /** Live title of the attached event, when one was attached. */
  attachedEventTitle?: string;
  /** Absolute URL of the act's "Requests to you" list. */
  requestsUrl: string;
};

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

/**
 * "{org} wants to book you" — sent to a performer (or an org act's editors)
 * when an organizer sends them a booking request
 * (organizer-booking-requests FR-006). Hardcoded English copy (like
 * BookingRequestReceived) — no translator keys, so locale bundles stay
 * untouched.
 */
export const OrganizerBookingRequestReceived = (
  props: OrganizerBookingRequestReceivedProps,
): ReactElement => {
  const { orgName, message, preferredDates, attachedEventTitle, requestsUrl } =
    props;

  const hasDates = Boolean(preferredDates && preferredDates.length > 0);

  return (
    <Shell
      title={`${orgName} wants to book you`}
      previewText={`${orgName} sent you a booking request on Ithas Fire.`}
    >
      <Section style={{ marginBottom: spacing(3) }}>
        <Text style={eyebrowStyle}>NEW BOOKING REQUEST</Text>
        <Text style={headingStyle}>{orgName} wants to book you</Text>
        <Text style={subtitleStyle}>
          Sent through your page on Ithas Fire.
        </Text>
      </Section>

      <Section style={cardStyle}>
        <Row style={{ marginBottom: spacing(1) }}>
          <Column>
            <Text style={labelStyle}>FROM</Text>
            <Text style={valueStyle}>{orgName}</Text>
          </Column>
        </Row>
        {attachedEventTitle && (
          <Row style={{ marginBottom: spacing(1) }}>
            <Column>
              <Text style={labelStyle}>FOR THEIR EVENT</Text>
              <Text style={valueStyle}>{attachedEventTitle}</Text>
            </Column>
          </Row>
        )}
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
            <Text style={labelStyle}>THE MESSAGE</Text>
            <Text style={messageStyle}>{message}</Text>
          </Column>
        </Row>
      </Section>

      <Section style={{ textAlign: "center" }}>
        <Button
          style={primaryButtonStyle}
          href={requestsUrl}
          aria-label="View and respond to this booking request"
        >
          View request
        </Button>
      </Section>

      <Text style={mutedTextStyle}>
        You&apos;re receiving this because you accept booking requests on
        Ithas Fire. You can accept or decline from your requests list; the
        request expires automatically if you don&apos;t respond.
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
