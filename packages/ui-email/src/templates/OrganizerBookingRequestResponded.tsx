import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type OrganizerBookingRequestRespondedProps = {
  /** The act's display name (caller-resolved, non-empty). */
  actName: string;
  /** Whether the act accepted or declined. */
  action: "accepted" | "declined";
  /** Agreement editor (accept) or the org's Bookings hub (decline). */
  targetUrl: string;
};

/**
 * "{act} accepted/declined your booking request" — sent to the organizer
 * org's editors when the act responds (organizer-booking-requests FR-006).
 * Hardcoded English copy (like BookingRequestReceived).
 */
export const OrganizerBookingRequestResponded = (
  props: OrganizerBookingRequestRespondedProps,
): ReactElement => {
  const { actName, action, targetUrl } = props;
  const accepted = action === "accepted";

  const title = accepted
    ? `${actName} accepted your booking request`
    : `${actName} declined your booking request`;

  return (
    <Shell
      title={title}
      previewText={
        accepted
          ? `${actName} accepted — a draft agreement is ready.`
          : `${actName} declined your booking request.`
      }
    >
      <Section style={{ marginBottom: spacing(3) }}>
        <Text style={eyebrowStyle}>BOOKING REQUEST UPDATE</Text>
        <Text style={headingStyle}>{title}</Text>
        <Text style={subtitleStyle}>
          {accepted
            ? "A draft agreement was created for you both. Open it to confirm dates, terms and payouts together."
            : "You can reach out to other acts, or try again another time — declined requests keep your booking history tidy."}
        </Text>
      </Section>

      <Section style={{ textAlign: "center" }}>
        <Button
          style={primaryButtonStyle}
          href={targetUrl}
          aria-label={accepted ? "Open the agreement" : "Open your bookings"}
        >
          {accepted ? "Open the agreement" : "Open your bookings"}
        </Button>
      </Section>

      <Text style={mutedTextStyle}>
        You&apos;re receiving this because your group sent this booking
        request on Ithas Fire.
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
