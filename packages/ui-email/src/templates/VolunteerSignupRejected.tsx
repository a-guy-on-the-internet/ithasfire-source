import { Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { spacing, tokens } from "../theme/tokens";

export type VolunteerSignupRejectedProps = {
  eventTitle: string;
  roleName: string;
  reviewerName?: string | null;
  rejectionNote?: string | null;
  organizerContactEmail?: string | null;
};

export const VolunteerSignupRejected = (
  props: VolunteerSignupRejectedProps,
): ReactElement => {
  const {
    eventTitle,
    roleName,
    reviewerName,
    rejectionNote,
    organizerContactEmail,
  } = props;

  return (
    <Shell
      title={`Update on your volunteer application for ${eventTitle}`}
      previewText={`An update on your volunteer application for ${eventTitle}.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Application update</Text>
        <Text style={headingStyle}>Thanks for applying</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          Thanks for your interest in volunteering for{" "}
          <strong>{eventTitle}</strong> as <strong>{roleName}</strong>.
          Unfortunately, the organizer wasn't able to approve your signup this
          time.
          {reviewerName ? ` Reviewed by ${reviewerName}.` : ""}
        </Text>
      </Section>

      {rejectionNote ? (
        <Section style={{ marginBottom: spacing(2) }}>
          <Text style={noteLabelStyle}>Note from the organizer</Text>
          <Text style={noteStyle}>{rejectionNote}</Text>
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
  color: tokens.colors.mutedText,
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

const noteLabelStyle: CSSProperties = {
  fontSize: "13px",
  color: tokens.colors.mutedText,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: 0,
  marginBottom: spacing(0),
};

const noteStyle: CSSProperties = {
  fontSize: "15px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
  padding: `${spacing(1)} ${spacing(2)}`,
  borderLeft: `3px solid ${tokens.colors.border}`,
};

const footerStyle: CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
