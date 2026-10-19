import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { spacing, tokens, px } from "../../theme/tokens";

export type InstallTileProps = {
  eyebrow: string;
  subtitle: string;
  url: string;
  ariaLabel: string;
  ctaLabel: string;
};

/**
 * Email-safe analogue of the on-page InstallTile (Swiss tile pattern):
 * thick black border, surface bg, no radius, uppercase eyebrow, tracked
 * subtitle, primary orange CTA. Stacked vertically because email clients
 * render single-column far more reliably than flex/grid.
 *
 * Used by `ScannerOnboarding` and the SCANNER-role variant of
 * `OrgInvitation`.
 */
export const InstallTile = ({
  eyebrow,
  subtitle,
  url,
  ariaLabel,
  ctaLabel,
}: InstallTileProps): ReactElement => (
  <Section style={tileStyle}>
    <Text style={tileEyebrowStyle}>{eyebrow}</Text>
    <Text style={tileSubtitleStyle}>{subtitle}</Text>
    <Section style={{ marginTop: spacing(2) }}>
      <Button href={url} style={tileCtaStyle} aria-label={ariaLabel}>
        {ctaLabel}
      </Button>
    </Section>
  </Section>
);

const tileStyle: React.CSSProperties = {
  border: `2px solid ${tokens.colors.text}`,
  backgroundColor: tokens.colors.surface,
  padding: `${spacing(3)} ${spacing(3)}`,
  marginTop: spacing(2),
};

const tileEyebrowStyle: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: tokens.colors.text,
  margin: 0,
};

const tileSubtitleStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: tokens.colors.mutedText,
  margin: 0,
};

const tileCtaStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "14px 22px",
  backgroundColor: tokens.colors.brandAccent,
  color: "#FFFFFF",
  borderRadius: px(tokens.radius),
  textDecoration: "none",
  fontWeight: 800,
  fontSize: "13px",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};
