import { Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { tokens } from "../theme/tokens";
import { getFooterDefaults } from "../footer-context";

export type EmailFooterProps = {
  physicalAddress?: string;
  contactEmail?: string;
  brandName?: string;
  unsubscribeUrl?: string;
};

const DEFAULT_BRAND = "Ithas Fire";

export const EmailFooter = ({
  physicalAddress,
  contactEmail,
  brandName,
  unsubscribeUrl,
}: EmailFooterProps): ReactElement => {
  // Explicit props (when a template threads them through) win; otherwise fall
  // back to platform defaults injected at render time via context.
  const defaults = getFooterDefaults();
  const address = physicalAddress ?? defaults?.physicalAddress;
  const contact = contactEmail ?? defaults?.contactEmail;
  const brand = brandName ?? defaults?.brandName ?? DEFAULT_BRAND;

  return (
    <Section style={wrapperStyle}>
      <Text style={brandStyle}>
        <a href="https://ithasfire.live" style={linkStyle}>
          {brand}
        </a>
      </Text>
      {address ? <Text style={addressStyle}>{address}</Text> : null}
      {contact ? (
        <Text style={contactStyle}>
          <a href={`mailto:${contact}`} style={linkStyle}>
            {contact}
          </a>
        </Text>
      ) : null}
      {unsubscribeUrl ? (
        <Text style={unsubStyle}>
          <a href={unsubscribeUrl} style={linkStyle}>
            Unsubscribe
          </a>
        </Text>
      ) : null}
    </Section>
  );
};

const wrapperStyle: CSSProperties = {
  textAlign: "center",
  marginTop: "32px",
  paddingTop: "24px",
  borderTop: `1px solid ${tokens.colors.border}`,
};

const brandStyle: CSSProperties = {
  fontSize: "12px",
  color: tokens.colors.mutedText,
  margin: 0,
};

const addressStyle: CSSProperties = {
  fontSize: "12px",
  color: tokens.colors.mutedText,
  margin: "4px 0 0 0",
};

const contactStyle: CSSProperties = {
  fontSize: "12px",
  color: tokens.colors.mutedText,
  margin: "4px 0 0 0",
};

const unsubStyle: CSSProperties = {
  fontSize: "12px",
  color: tokens.colors.mutedText,
  margin: "4px 0 0 0",
};

const linkStyle: CSSProperties = {
  color: tokens.colors.mutedText,
  textDecoration: "underline",
};
