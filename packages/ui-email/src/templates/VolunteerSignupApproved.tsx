import { Button, Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { zoneOption } from "../lib/event-time-zone";
import { spacing, tokens, primaryButtonStyle } from "../theme/tokens";

export type VolunteerSignupApprovedProps = {
  eventTitle: string;
  roleName: string;
  shiftLabel?: string | null;
  shiftStartsAtISO?: string | null;
  shiftEndsAtISO?: string | null;
  /** The shift's IANA timezone (the event's, or the ask's); times render in it. */
  timezone?: string | null;
  reviewerName?: string | null;
  organizerContactEmail?: string | null;
  /** Event page (event-path signups) or public ask page (ask-path). */
  destinationUrl?: string | null;
  /**
   * CTA label computed by the renderer ("View event" for event-path,
   * "View details" for ask-path). Defaults to "View details".
   */
  destinationLabel?: string | null;
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

export const VolunteerSignupApproved = (
  props: VolunteerSignupApprovedProps,
): ReactElement => {
  const {
    eventTitle,
    roleName,
    shiftLabel,
    shiftStartsAtISO,
    shiftEndsAtISO,
    timezone,
    reviewerName,
    organizerContactEmail,
    destinationUrl,
    destinationLabel,
  } = props;

  const shiftWindow = formatShiftWindow(
    shiftStartsAtISO,
    shiftEndsAtISO,
    timezone,
  );
  const ctaLabel = destinationLabel ?? "View details";

  return (
    <Shell
      title={`You're approved to volunteer at ${eventTitle}`}
      previewText={`Great news — you're approved to volunteer at ${eventTitle}.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Approved</Text>
        <Text style={headingStyle}>You're approved!</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          Great news — you're approved to volunteer at{" "}
          <strong>{eventTitle}</strong> as <strong>{roleName}</strong>.
          {reviewerName ? ` Approved by ${reviewerName}.` : ""}
        </Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
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

      {destinationUrl ? (
        <Section style={{ marginTop: spacing(3) }}>
          <Button
            href={destinationUrl}
            style={primaryButtonStyle}
            aria-label={ctaLabel}
          >
            {ctaLabel}
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
  color: tokens.colors.success,
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
  lineHeight: 1.5,
};

const metaLineStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
};

const footerStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
