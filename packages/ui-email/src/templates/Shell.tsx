import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
} from "@react-email/components";
import { type CSSProperties, type ReactNode } from "react";

import { tokens } from "../theme/tokens";
import { EmailFooter } from "./EmailFooter";

export type ShellProps = {
  title: string;
  previewText?: string;
  locale?: string;
  unsubscribeUrl?: string;
  physicalAddress?: string;
  children: ReactNode;
};

export const Shell = ({
  title,
  previewText,
  locale = "en",
  unsubscribeUrl,
  physicalAddress,
  children,
}: ShellProps) => {
  return (
    <Html lang={locale}>
      <Head>
        <title>{title}</title>
        {/* Force light color-scheme so Gmail / Apple Mail dark-mode
				    auto-invert doesn't ruin our tinted card backgrounds and
				    near-white surfaces. */}
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        {/* Montserrat is the single brand typeface (design-system-v2.md §2). Clients that
				    ignore remote CSS fall back to the system stack in `tokens.typography.fontFamily`
				    — keep the two in sync; they are the only two places the face is named. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap"
        />
      </Head>
      {previewText ? <Preview>{previewText}</Preview> : null}
      <Body lang={locale} dir="ltr" style={bodyStyle}>
        <Section style={sectionStyle}>
          <Container style={containerStyle}>
            {children}
            <EmailFooter
              unsubscribeUrl={unsubscribeUrl}
              physicalAddress={physicalAddress}
            />
          </Container>
        </Section>
      </Body>
    </Html>
  );
};

const bodyStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  backgroundColor: tokens.colors.surface,
  color: tokens.colors.text,
  fontFamily: tokens.typography.fontFamily,
  fontSize: tokens.typography.baseSize,
  lineHeight: tokens.typography.lineHeight,
};

const sectionStyle: CSSProperties = {
  width: "100%",
  maxWidth: "600px",
  margin: "0 auto",
  padding: "32px 16px",
  boxSizing: "border-box",
};

const containerStyle: CSSProperties = {
  borderRadius: tokens.radius,
  border: `1px solid ${tokens.colors.border}`,
  backgroundColor: tokens.colors.surface,
  padding: "32px",
  boxSizing: "border-box",
};
