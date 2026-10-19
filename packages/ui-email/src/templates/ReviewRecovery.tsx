import { Button, Hr, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type ReviewRecoveryProps = {
  venueName: string;
  lastStepLabel: string;
  resumeUrl: string;
  unsubscribeUrl: string;
};

export const ReviewRecovery = (props: ReviewRecoveryProps): ReactElement => {
  const { venueName, lastStepLabel, resumeUrl, unsubscribeUrl } = props;

  return (
    <Shell
      title={`Your review for ${venueName} is waiting`}
      previewText={`You started a review for ${venueName} but didn't finish.`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={headingStyle}>You left your review halfway</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          You started a review for <strong>{venueName}</strong> on Ithas Fire
          but didn't finish.
        </Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          You got to: <strong>{lastStepLabel}</strong>
        </Text>
        <Text style={bodyStyle}>
          It only takes another minute to wrap up — and it genuinely helps other
          artists know what to expect before booking there.
        </Text>
      </Section>

      <Section style={{ marginTop: spacing(3), textAlign: "center" as const }}>
        <Button href={resumeUrl} style={primaryButtonStyle}>
          Continue your review
        </Button>
      </Section>

      <Hr style={dividerStyle} />

      <Text style={footerStyle}>
        Your review is 100% anonymous. This email is never connected to what you
        wrote.
      </Text>
    </Shell>
  );
};

const headingStyle: React.CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  lineHeight: 1.2,
};

const bodyStyle: React.CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  marginBottom: spacing(1),
  lineHeight: 1.5,
};

const dividerStyle: React.CSSProperties = {
  borderTop: `1px solid ${tokens.colors.border}`,
  borderBottom: "none",
  margin: `${spacing(3)} 0 ${spacing(1)}`,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
};

const footerStyle: React.CSSProperties = {
  fontSize: "13px",
  color: tokens.colors.mutedText,
  margin: 0,
  lineHeight: 1.5,
};
