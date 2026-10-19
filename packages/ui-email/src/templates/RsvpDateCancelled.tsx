import { Button, Hr, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";
import { formatEventTimeRange } from "@th/locale";

import { Shell } from "./Shell";
import {
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type RsvpDateCancelledProps = {
  /** Event title/headline */
  eventTitle: string;
  /** Start of the occurrence that was called off, ISO 8601. */
  startsAtISO: string;
  /** IANA timezone (e.g., "America/Chicago") */
  timezone?: string | null;
  /** Venue or location name */
  venueName?: string | null;
  /** Hero image URL (optional) */
  heroImageUrl?: string | null;
  /** URL to the event page — where the REST of the schedule lives. */
  eventUrl?: string | null;
  /**
   * The WHOLE listing is off (cancelled, archived or completed), not one
   * night. One message stands for every remaining night the person held: no
   * date headline, no place, no "other dates" button. A "View event" button
   * shows when `eventUrl` is set (the core drain sends one only for a
   * CANCELLED listing, whose page says "Event cancelled").
   */
  listingCancelled?: boolean | null;
};

/**
 * ONE night of a recurring community listing has been called off.
 *
 * Sibling of RsvpConfirmed / RsvpReminder rather than a variant of either,
 * because it has to say something neither of them can: this DATE is off and
 * the series is not. The date is the headline, the title is the subhead, and
 * the CTA is "see the other dates" — every one of those is the opposite of the
 * confirmation's emphasis.
 *
 * Deliberately no hero image by default and no address block: the address of a
 * night that is not happening is noise, and the recipient's next action is
 * looking at the rest of the schedule.
 *
 * `listingCancelled` is the whole-listing take-down: the listing is cancelled,
 * archived or completed, so the title leads, with no poster, place or link to
 * other dates; a plain "View event" link only when `eventUrl` is set.
 *
 * Hardcoded English copy, like its two siblings — no translator keys, so the
 * locale bundles stay untouched.
 */
export const RsvpDateCancelled = (
  props: RsvpDateCancelledProps,
): ReactElement => {
  const {
    eventTitle,
    startsAtISO,
    timezone,
    venueName,
    heroImageUrl,
    eventUrl,
    listingCancelled,
  } = props;

  if (listingCancelled) {
    // Same sentences as the in-app/text copy (core comms copy/rsvp.ts, en).
    // No poster: a listing that is gone is not something to look at.
    return (
      <Shell
        title={`Cancelled: ${eventTitle}`}
        previewText="None of its remaining nights will happen. Your RSVP is cancelled."
      >
        <Section style={{ marginBottom: "24px" }}>
          <Text style={eyebrowStyle}>CANCELLED</Text>
          <Text style={headingStyle}>{eventTitle}</Text>
        </Section>

        <Hr style={dividerStyle} />

        <Section style={detailBlockStyle}>
          <Text style={bodyStyle}>
            None of its remaining nights will happen. Your RSVP is cancelled.
          </Text>
        </Section>

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
      </Shell>
    );
  }

  const when = formatEventTimeRange(startsAtISO, undefined, {
    timeZone: timezone ?? undefined,
  });

  return (
    <Shell
      title={`Cancelled: ${eventTitle}`}
      previewText={`The ${when} date of ${eventTitle} has been called off.`}
    >
      {heroImageUrl && (
        <Section style={heroSectionStyle}>
          <img src={heroImageUrl} alt={eventTitle} style={heroImageStyle} />
        </Section>
      )}

      {/* Header — the DATE leads. The recipient RSVP'd to one night of
          something that is still running. */}
      <Section style={{ marginBottom: "24px" }}>
        <Text style={eyebrowStyle}>THIS DATE IS OFF</Text>
        <Text style={headingStyle}>{when}</Text>
        <Text style={subheadStyle}>{eventTitle}</Text>
      </Section>

      <Hr style={dividerStyle} />

      <Section style={detailBlockStyle}>
        <Text style={bodyStyle}>
          Your RSVP for that night is cancelled. Nothing else about the
          schedule has changed — the other dates are still on.
        </Text>
        {timezone && <Text style={subtextStyle}>Times shown in {timezone}</Text>}
      </Section>

      {venueName && (
        <Section style={detailBlockStyle}>
          <Text style={labelStyle}>WHERE IT WOULD HAVE BEEN</Text>
          <Text style={valueStyle}>{venueName}</Text>
        </Section>
      )}

      {/* CTA — omitted when the event has no resolvable public page. */}
      {eventUrl ? (
        <Section style={{ marginTop: "32px", textAlign: "center" }}>
          <Button
            href={eventUrl}
            style={primaryButtonStyle}
            aria-label="See other dates"
          >
            See Other Dates
          </Button>
        </Section>
      ) : null}
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

const eyebrowStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 700,
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: "8px",
  letterSpacing: "0.12em",
};

const headingStyle: React.CSSProperties = {
  fontSize: "28px",
  fontWeight: 700,
  margin: 0,
  lineHeight: tokens.typography.headingTightLH,
  color: tokens.colors.text,
  textTransform: "uppercase",
  letterSpacing: "-0.02em",
};

const subheadStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  margin: 0,
  marginTop: "8px",
  color: tokens.colors.mutedText,
};

const dividerStyle: React.CSSProperties = {
  borderTop: `1px solid ${tokens.colors.border}`,
  borderBottom: "none",
  margin: "24px 0",
};

const detailBlockStyle: React.CSSProperties = {
  marginBottom: "20px",
};

const bodyStyle: React.CSSProperties = {
  fontSize: "15px",
  margin: 0,
  color: tokens.colors.text,
  lineHeight: 1.5,
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
  marginTop: "8px",
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  fontSize: "14px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
