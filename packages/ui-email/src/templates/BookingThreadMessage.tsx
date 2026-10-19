import { Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { spacing, tokens } from "../theme/tokens";

export type BookingThreadMessageProps = {
  /** Name of the venue whose staff wrote the message. */
  placeName: string;
  /** The venue's message body, plain text (already sanitized upstream). */
  messageBody: string;
  /**
   * The venue's own public contact address, when it has one. Non-null means a
   * plain "reply" lands in the VENUE'S mailbox (we set it as `Reply-To`), so
   * the email may say so. Null means replies would bounce off our unattended
   * sending address — the copy must NOT invite one.
   */
  replyToEmail?: string | null;
};

/**
 * "{venue} replied to your booking request" — the ONLY channel that reaches
 * someone who submitted an embed inquiry without an account.
 *
 * Every other delivery path is closed for them by construction: the notify()
 * pipeline needs a humanId AND refuses email to an unverified identity, and
 * the shadow Human minted for the inquiry is unverified forever until they
 * claim. So this template is sent through MailerPort directly, exactly as
 * BookingInviteToClaim is.
 *
 * Hardcoded English copy (like BookingInviteToClaim) — no translator keys, so
 * the locale bundles stay untouched.
 */
export const BookingThreadMessage = (
  props: BookingThreadMessageProps,
): ReactElement => {
  const { placeName, messageBody, replyToEmail } = props;

  return (
    <Shell
      title={`${placeName} replied to your booking request`}
      previewText={`${placeName} sent you a message about your booking request.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>NEW MESSAGE</Text>
        <Text style={headingStyle}>
          {placeName} replied to your booking request
        </Text>
      </Section>

      <Section style={quoteStyle}>
        {/* `white-space: pre-wrap` keeps the venue's own line breaks without
            letting the body be interpreted as markup — the string arrives
            plain-text-sanitized and React escapes it on render. */}
        <Text style={quoteTextStyle}>{messageBody}</Text>
      </Section>

      <Section style={{ marginTop: spacing(3) }}>
        <Text style={bodyStyle}>
          {replyToEmail ? (
            <>
              Just reply to this email — your answer goes straight to{" "}
              {placeName} at <strong>{replyToEmail}</strong>.
            </>
          ) : (
            <>
              {placeName} has your email address and will follow up here. If
              they accept your request you&apos;ll get a link to claim it on
              Ithas Fire.
            </>
          )}
        </Text>
      </Section>

      <Text style={footerTextStyle}>
        You&apos;re getting this because you sent {placeName} a booking request.
        If that wasn&apos;t you, you can safely ignore this message.
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
  color: tokens.colors.text,
  lineHeight: tokens.typography.headingTightLH,
};

const quoteStyle: React.CSSProperties = {
  borderLeft: `3px solid ${tokens.colors.border}`,
  paddingLeft: spacing(2),
};

const quoteTextStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: tokens.typography.lineHeight,
  whiteSpace: "pre-wrap",
};

const bodyStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: tokens.typography.lineHeight,
};

const footerTextStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
  marginBottom: 0,
  lineHeight: tokens.typography.lineHeight,
};
