import { Button, Column, Img, Link, Row, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";
import { formatEventTimeRange } from "@th/locale";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type EventLocationRevealedProps = {
  /** Event title/headline */
  eventTitle: string;
  /** Event start date/time in ISO format */
  startsAtISO: string;
  /** IANA timezone (e.g., "America/Chicago") */
  timezone?: string | null;
  /** Venue or location name (optional — obscured events often have none) */
  venueName?: string | null;
  /** The exact street address, now unlocked for the ticket holder. */
  address: string;
  /** Google Maps place link for the revealed coordinates (optional). */
  mapUrl?: string | null;
  /** Static map image URL (optional — rendered when a tileserver is available). */
  mapImageUrl?: string | null;
  /** Google Maps directions deep-link (optional). */
  directionsUrl?: string | null;
  /** Absolute URL of the public event page. */
  eventUrl?: string | null;
};

/**
 * "The location for {event} is now live" — sent by the address-reveal
 * notification job when an OBSCURED event's `addressRevealAt` crosses.
 * Clones TicketIssued's address + static-map + directions block into a
 * standalone reveal email. Hardcoded English copy (like RsvpConfirmed) —
 * no translator keys, so the locale bundles stay untouched.
 */
export const EventLocationRevealed = (
  props: EventLocationRevealedProps,
): ReactElement => {
  const {
    eventTitle,
    startsAtISO,
    timezone,
    venueName,
    address,
    mapUrl,
    mapImageUrl,
    directionsUrl,
    eventUrl,
  } = props;

  return (
    <Shell
      title={`The location for ${eventTitle} is now live`}
      previewText={`${eventTitle} is at ${address}.`}
    >
      <Section style={{ marginBottom: spacing(3) }}>
        <Text style={eyebrowStyle}>LOCATION REVEALED</Text>
        <Text style={headingStyle}>
          The location for {eventTitle} is now live
        </Text>
        <Text style={subtitleStyle}>
          You&apos;re holding a ticket — here&apos;s exactly where to go.
        </Text>
      </Section>

      <Section style={eventCardStyle}>
        <Row style={{ marginBottom: spacing(1) }}>
          <Column>
            <Text style={labelStyle}>WHEN</Text>
            <Text style={eventDateStyle}>
              {formatEventTimeRange(startsAtISO, undefined, {
                timeZone: timezone ?? undefined,
              })}
            </Text>
          </Column>
        </Row>
        <Row style={{ marginBottom: spacing(1) }}>
          <Column>
            <Text style={labelStyle}>WHERE</Text>
            {venueName && <Text style={valueStyle}>{venueName}</Text>}
            {mapUrl ? (
              <Link href={mapUrl} style={addressLinkStyle}>
                {address}
              </Link>
            ) : (
              <Text style={addressStyle}>{address}</Text>
            )}
          </Column>
        </Row>
        {mapImageUrl && (
          <Row style={{ marginBottom: directionsUrl ? spacing(1) : 0 }}>
            <Column>
              {directionsUrl ? (
                <a
                  href={directionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Img
                    src={mapImageUrl}
                    alt={`Map of ${address}`}
                    style={mapImageStyle}
                  />
                </a>
              ) : (
                <Img
                  src={mapImageUrl}
                  alt={`Map of ${address}`}
                  style={mapImageStyle}
                />
              )}
            </Column>
          </Row>
        )}
        {directionsUrl && (
          <Row>
            <Column>
              <Button
                style={directionsButtonStyle}
                href={directionsUrl}
                aria-label="Get directions"
              >
                Get directions
              </Button>
            </Column>
          </Row>
        )}
      </Section>

      {/* Omitted when the event has no resolvable public page — the address
          above is the point of this email, so it still sends. */}
      {eventUrl ? (
        <Section style={{ textAlign: "center" }}>
          <Button
            style={primaryButtonStyle}
            href={eventUrl}
            aria-label="View event"
          >
            View event
          </Button>
        </Section>
      ) : null}

      <Text style={mutedTextStyle}>
        You&apos;re receiving this because you hold a ticket to {eventTitle}.
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

const eventCardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.surface,
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

const eventDateStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "18px",
  margin: 0,
  fontWeight: 700,
  color: tokens.colors.brandAccent,
  lineHeight: tokens.typography.headingTightLH,
};

const valueStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  margin: 0,
  fontWeight: 500,
};

const addressStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  margin: 0,
  fontWeight: 700,
  color: tokens.colors.text,
};

const addressLinkStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  fontWeight: 700,
  color: tokens.colors.brand,
  textDecoration: "underline",
};

const mapImageStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: tokens.radius,
  border: `1px solid ${tokens.colors.border}`,
};

const directionsButtonStyle: React.CSSProperties = {
  display: "inline-block",
  fontFamily,
  padding: "10px 16px",
  backgroundColor: tokens.colors.surface,
  borderRadius: tokens.radius,
  color: tokens.colors.brand,
  textDecoration: "none",
  fontWeight: 700,
  fontSize: "14px",
  border: `1px solid ${tokens.colors.border}`,
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
