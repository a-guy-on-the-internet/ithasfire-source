import { Button, Section, Text, Img, Hr } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { InstallTile } from "./components/InstallTile";
import {
  spacing,
  tokens,
  px,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type OrgInvitationProps = {
  orgName: string;
  role: string;
  inviterName: string | null;
  acceptUrl: string;
  expiresInDays: number;
  /** Optional: org accent color (hex). Falls back to brand accent. */
  accentColor?: string | null;
  /** Optional: org logo URL. When provided, renders above the heading. */
  logoUrl?: string | null;
  /**
   * App Store / TestFlight URL. Surfaced inline when `role` is `scanner`
   * so the new operator gets install instructions in the same email.
   */
  scannerIosUrl?: string | null;
  /** Play Store / internal-track URL. Same role-gated behavior as iOS. */
  scannerAndroidUrl?: string | null;
};

export const OrgInvitation = (props: OrgInvitationProps): ReactElement => {
  const {
    orgName,
    role,
    inviterName,
    acceptUrl,
    expiresInDays,
    accentColor,
    logoUrl,
    scannerIosUrl,
    scannerAndroidUrl,
  } = props;

  const accent = accentColor ?? tokens.colors.brandAccent;
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
  const isScannerRole = role.toLowerCase() === "scanner";
  const showScannerBlock =
    isScannerRole && (scannerIosUrl ?? scannerAndroidUrl);

  return (
    <Shell
      title={`You're invited to join ${orgName}`}
      previewText={`${inviterName ?? "Someone"} invited you to join ${orgName} on Ithas Fire as ${roleLabel}.`}
    >
      {/* Optional org logo */}
      {logoUrl ? (
        <Section
          style={{ marginBottom: spacing(2), textAlign: "center" as const }}
        >
          <Img
            src={logoUrl}
            alt={`${orgName} logo`}
            width={64}
            height={64}
            style={logoStyle}
          />
        </Section>
      ) : null}

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Team invitation</Text>
        <Text style={headingStyle}>You're invited to join {orgName}</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          {inviterName ? (
            <>
              <strong>{inviterName}</strong> has invited you to join{" "}
              <strong>{orgName}</strong> as a <strong>{roleLabel}</strong>.
            </>
          ) : (
            <>
              You've been invited to join <strong>{orgName}</strong> as a{" "}
              <strong>{roleLabel}</strong>.
            </>
          )}
        </Text>
      </Section>

      {/* Role explainer */}
      <Section style={roleCardStyle}>
        <Text style={roleCardLabelStyle}>Your role</Text>
        <Text style={roleCardValueStyle}>{roleLabel}</Text>
      </Section>

      <Section style={{ marginTop: spacing(3) }}>
        <Button
          href={acceptUrl}
          style={{ ...primaryButtonStyle, backgroundColor: accent }}
          aria-label="Accept invitation and join team"
        >
          Accept invitation
        </Button>
      </Section>

      {showScannerBlock ? (
        <>
          <Section style={{ marginTop: spacing(3) }}>
            <Text style={scannerHeaderEyebrowStyle}>After you accept</Text>
            <Text style={scannerHeaderBodyStyle}>
              You'll be scanning tickets at the door — install the Ithas Fire
              Scanner app and sign in with the email this invitation was sent
              to.
            </Text>
          </Section>
          {scannerIosUrl ? (
            <InstallTile
              eyebrow="iOS / iPadOS"
              subtitle="App Store · TestFlight"
              url={scannerIosUrl}
              ariaLabel="Install Ithas Fire Scanner for iPhone"
              ctaLabel="Install on iPhone"
            />
          ) : null}
          {scannerAndroidUrl ? (
            <InstallTile
              eyebrow="Android"
              subtitle="Google Play · internal-track"
              url={scannerAndroidUrl}
              ariaLabel="Install Ithas Fire Scanner for Android"
              ctaLabel="Install on Android"
            />
          ) : null}
        </>
      ) : null}

      <Section style={{ marginTop: spacing(2) }}>
        <Text style={hintStyle}>
          This invitation expires in {expiresInDays}{" "}
          {expiresInDays === 1 ? "day" : "days"}.
        </Text>
      </Section>

      <Hr style={dividerStyle} />

      <Text style={footerStyle}>
        If you didn't expect this invitation, you can safely ignore this email.
        No account will be created unless you accept.
      </Text>

      <Text style={brandFooterStyle}>Sent via Ithas Fire</Text>
    </Shell>
  );
};

// ── Styles ──────────────────────────────────────────────────────────────────

const logoStyle: React.CSSProperties = {
  borderRadius: px(tokens.radius),
  objectFit: "cover",
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

const roleCardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.surfaceMuted,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: px(tokens.radius),
  padding: `${spacing(2)} ${spacing(3)}`,
  marginTop: spacing(2),
};

const roleCardLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: "2px",
};

const roleCardValueStyle: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: 700,
  color: tokens.colors.text,
  margin: 0,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  fontSize: "16px",
};

const hintStyle: React.CSSProperties = {
  fontSize: "13px",
  color: tokens.colors.mutedText,
  margin: 0,
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

const scannerHeaderEyebrowStyle: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: tokens.colors.brandAccent,
  margin: 0,
  marginBottom: spacing(1),
};

const scannerHeaderBodyStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.text,
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
