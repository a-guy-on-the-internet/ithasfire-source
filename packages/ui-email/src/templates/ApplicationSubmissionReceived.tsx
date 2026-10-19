import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type ApplicationSubmissionReceivedProps = {
  eventTitle: string;
  /** Applicant display name (never empty — caller guarantees a fallback). */
  applicantName: string;
  /** Absolute, per-recipient link to the event's application review queue. */
  queueUrl: string;
};

/**
 * Organizer-facing — a new application landed in the event's review queue
 * (spec Phase 1 notification triple, leg b). Mirrors
 * BookingRequestReceived's shape: who, for what, one clear action.
 */
export const ApplicationSubmissionReceived = (
  props: ApplicationSubmissionReceivedProps,
): ReactElement => {
  const { eventTitle, applicantName, queueUrl } = props;

  return (
    <Shell
      title={`New application for ${eventTitle}`}
      previewText={`${applicantName} applied to ${eventTitle}.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>New application</Text>
        <Text style={headingStyle}>{eventTitle}</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          <strong>{applicantName}</strong> applied to{" "}
          <strong>{eventTitle}</strong>. Their answers are waiting in your
          review queue.
        </Text>
      </Section>

      <Section style={{ marginTop: spacing(3) }}>
        <Button
          href={queueUrl}
          style={primaryButtonStyle}
          aria-label="Review applications"
        >
          Review applications
        </Button>
      </Section>

      <Text style={footerStyle}>
        Applicants are waiting on your decision — they&apos;ll be notified by
        email when you approve or decline.
      </Text>
    </Shell>
  );
};

const eyebrowStyle: React.CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
  color: tokens.colors.mutedText,
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

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
};

const footerStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
