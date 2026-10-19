import { Section, Text, Hr } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { InstallTile } from "./components/InstallTile";
import { spacing, tokens, px } from "../theme/tokens";

export type ScannerOnboardingProps = {
  orgName: string;
  recipientEmail: string;
  /** App Store / TestFlight URL. Omit to hide the iOS tile. */
  iosAppUrl?: string | null;
  /** Play Store / internal-track URL. Omit to hide the Android tile. */
  androidAppUrl?: string | null;
};

export const ScannerOnboarding = (
  props: ScannerOnboardingProps,
): ReactElement => {
  const { orgName, recipientEmail, iosAppUrl, androidAppUrl } = props;

  return (
    <Shell
      title={`Get the Ithas Fire Scanner for ${orgName}`}
      previewText={`Install the Scanner app and sign in as ${recipientEmail} to start scanning for ${orgName}.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Scanner setup</Text>
        <Text style={headingStyle}>Install the Ithas Fire Scanner</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          You've been added to <strong>{orgName}</strong> as a Scanner. Use the
          Ithas Fire Scanner app to check tickets at the door.
        </Text>
      </Section>

      {iosAppUrl ? (
        <InstallTile
          eyebrow="iOS / iPadOS"
          subtitle="App Store · TestFlight"
          url={iosAppUrl}
          ariaLabel="Install Ithas Fire Scanner for iPhone"
          ctaLabel="Install on iPhone"
        />
      ) : null}
      {androidAppUrl ? (
        <InstallTile
          eyebrow="Android"
          subtitle="Google Play · internal-track"
          url={androidAppUrl}
          ariaLabel="Install Ithas Fire Scanner for Android"
          ctaLabel="Install on Android"
        />
      ) : null}

      <Section style={signInCardStyle}>
        <Text style={signInLabelStyle}>Sign in</Text>
        <Text style={signInBodyStyle}>
          Open the app, choose <strong>Magic link</strong>, and enter:
        </Text>
        <Text style={emailBoxStyle}>{recipientEmail}</Text>
        <Text style={signInBodyStyle}>
          You'll receive a sign-in email — tap the link on the same device and
          you're in.
        </Text>
      </Section>

      <Hr style={dividerStyle} />

      <Text style={footerStyle}>
        Lost your invitation? Ask the {orgName} admin to resend it from the
        Scanner Setup page.
      </Text>

      <Text style={brandFooterStyle}>Sent via Ithas Fire</Text>
    </Shell>
  );
};

const eyebrowStyle: React.CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
  color: tokens.colors.brandAccent,
  margin: 0,
  marginBottom: spacing(1),
};

const headingStyle: React.CSSProperties = {
  fontSize: "26px",
  fontWeight: 700,
  margin: 0,
  lineHeight: tokens.typography.headingTightLH,
  color: tokens.colors.text,
};

const bodyStyle: React.CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.6,
};

const signInCardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.surfaceMuted,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: px(tokens.radius),
  padding: `${spacing(2)} ${spacing(3)}`,
  marginTop: spacing(3),
};

const signInLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(1),
};

const signInBodyStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.text,
  margin: 0,
  marginTop: spacing(1),
  lineHeight: 1.5,
};

const emailBoxStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  backgroundColor: "#FFFFFF",
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: px(tokens.radius),
  padding: `${spacing(1)} ${spacing(2)}`,
  margin: `${spacing(1)} 0`,
  color: tokens.colors.text,
};

const dividerStyle: React.CSSProperties = {
  borderColor: tokens.colors.border,
  marginTop: spacing(3),
  marginBottom: spacing(2),
};

const footerStyle: React.CSSProperties = {
  fontSize: "13px",
  color: tokens.colors.mutedText,
  margin: 0,
  lineHeight: 1.5,
};

const brandFooterStyle: React.CSSProperties = {
  fontSize: "12px",
  color: tokens.colors.mutedText,
  margin: 0,
  marginTop: spacing(2),
  opacity: 0.6,
};
