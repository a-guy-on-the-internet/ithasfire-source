import { Button, Link, Section, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { Shell } from "./Shell";
import { primaryButtonStyle, spacing, tokens } from "../theme/tokens";

/**
 * One layout for every open-call email (spec 2026-10-05, step 7): picked,
 * not this time, call pulled, new message, act dropped out, application
 * received, already applied.
 *
 * Every string arrives ALREADY WRITTEN, in one locale, by core
 * (`packages/core/src/use-cases/comms/open-call-renderers.ts`, copy in
 * `comms/copy/open-calls.ts`). Nothing here is copy, so an email in any
 * locale needs nothing from @th/locale. Keep these props in step with core's
 * `OpenCallEmailContent`.
 *
 * Free text (the call title, the organizer's note, a message) is plain text:
 * React escapes it, and the quote keeps its line breaks with
 * `white-space: pre-wrap`. Links are http(s) only (the registry schema).
 */
export type OpenCallNoticeLink = { label: string; url: string };

export type OpenCallNoticeProps = {
  /** "en" | "es": the Html/Body lang attribute. */
  locale: string;
  subject: string;
  heading: string;
  /** Label/value lines under the heading (Event, When, Pay as posted). */
  rows: Array<{ label: string; value: string }>;
  paragraphs: string[];
  /** Quoted free text: the organizer's note, or a message. */
  quote: { label: string; text: string } | null;
  /** The button. */
  action: OpenCallNoticeLink | null;
  /** Plain links under the button ("Drop out", "Make a page"). */
  links: OpenCallNoticeLink[];
  footer: string;
};

export const openCallNoticeSubject = (props: Pick<OpenCallNoticeProps, "subject">): string =>
  props.subject;

export const OpenCallNotice = (props: OpenCallNoticeProps): ReactElement => {
  const { locale, heading, rows, paragraphs, quote, action, links, footer } = props;
  return (
    <Shell title={openCallNoticeSubject(props)} previewText={heading} locale={locale}>
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={headingStyle}>{heading}</Text>
      </Section>

      {rows.length > 0 ? (
        <Section style={{ marginBottom: spacing(2) }}>
          {rows.map((row) => (
            <Text key={row.label} style={metaLineStyle}>
              <strong>{row.label}:</strong> {row.value}
            </Text>
          ))}
        </Section>
      ) : null}

      {paragraphs.map((paragraph, i) => (
        <Section key={i} style={{ marginBottom: spacing(2) }}>
          <Text style={bodyStyle}>{paragraph}</Text>
        </Section>
      ))}

      {quote ? (
        <Section style={{ marginBottom: spacing(2) }}>
          <Text style={quoteLabelStyle}>{quote.label}</Text>
          <Section style={quoteStyle}>
            <Text style={quoteTextStyle}>{quote.text}</Text>
          </Section>
        </Section>
      ) : null}

      {action ? (
        <Section style={{ marginTop: spacing(3) }}>
          <Button href={action.url} style={primaryButtonStyle}>
            {action.label}
          </Button>
        </Section>
      ) : null}

      {links.length > 0 ? (
        <Section style={{ marginTop: spacing(2) }}>
          {links.map((link) => (
            <Text key={link.url} style={metaLineStyle}>
              <Link href={link.url} style={linkStyle}>
                {link.label}
              </Link>
            </Text>
          ))}
        </Section>
      ) : null}

      <Text style={footerStyle}>{footer}</Text>
    </Shell>
  );
};

const fontFamily = tokens.typography.fontFamily;

const headingStyle: CSSProperties = {
  fontFamily,
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  color: tokens.colors.text,
  lineHeight: tokens.typography.headingTightLH,
};

const bodyStyle: CSSProperties = {
  fontFamily,
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
};

const metaLineStyle: CSSProperties = {
  fontFamily,
  fontSize: "14px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
};

const quoteLabelStyle: CSSProperties = {
  fontFamily,
  fontSize: "12px",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(1),
};

const quoteStyle: CSSProperties = {
  borderLeft: `3px solid ${tokens.colors.border}`,
  paddingLeft: spacing(2),
};

const quoteTextStyle: CSSProperties = {
  fontFamily,
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};

const linkStyle: CSSProperties = {
  color: tokens.colors.brandAccent,
  textDecoration: "underline",
};

const footerStyle: CSSProperties = {
  fontFamily,
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
