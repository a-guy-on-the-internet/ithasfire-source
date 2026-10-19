import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type BookingInviteToClaimProps = {
  /** Name of the venue/place that accepted the request. */
  placeName: string;
  /** Act / performer display name from the original submission. */
  actName?: string | null;
  /** Tokenized single-use claim link (absolute URL). */
  claimUrl: string;
  /** When the claim link expires, ISO datetime. Stated factually — no fake urgency. */
  expiresAtISO: string;
};

/**
 * "{place} wants to book you" — sent to an anonymous submitter when the
 * venue ACCEPTS their booking request (FR-007). Invites them to create an
 * account (or sign in), enable performer mode, and claim the request so the
 * booking can be finalized. Warm, grassroots tone; the expiry is stated
 * factually. Hardcoded English copy (like EventLocationRevealed) — no
 * translator keys, so the locale bundles stay untouched.
 */
/**
 * Format the expiry instant pinned to UTC with an explicit time. A bare
 * `dateStyle: "long"` in the render server's local timezone can overstate
 * the deadline by most of a day (a token dying 2026-08-12T00:00:00Z would
 * read "August 12" while it actually expires the evening of Aug 11 in
 * Nashville). Rendering the exact instant as "{date} at {time} UTC" is
 * timezone-independent and never promises more time than the token has.
 */
const formatExpiry = (iso: string) => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
};

export const BookingInviteToClaim = (
  props: BookingInviteToClaimProps,
): ReactElement => {
  const { placeName, actName, claimUrl, expiresAtISO } = props;

  return (
    <Shell
      title={`${placeName} wants to book you`}
      previewText={`${placeName} accepted your booking request — one step left to finalize it.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>BOOKING REQUEST ACCEPTED</Text>
        <Text style={headingStyle}>{placeName} wants to book you</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          Good news — {placeName} accepted the booking request
          {actName ? (
            <>
              {" "}
              you sent for <strong>{actName}</strong>
            </>
          ) : (
            " you sent"
          )}
          . To finalize the booking, claim your request on Ithas Fire: create a
          free account (or sign in if you already have one), turn on performer
          mode, and the booking agreement picks up right where you left off.
        </Text>
      </Section>

      <Section style={{ marginTop: spacing(3) }}>
        <Button
          href={claimUrl}
          style={primaryButtonStyle}
          aria-label="Claim your booking request"
        >
          Claim your booking request
        </Button>
      </Section>

      <Section style={{ marginTop: spacing(2) }}>
        <Text style={expiryStyle}>
          This link expires on {formatExpiry(expiresAtISO)} UTC and can only
          be used once.
        </Text>
      </Section>

      <Text style={footerTextStyle}>
        Not ready yet? No problem — the place has your email and can reach you
        directly. If you weren&apos;t expecting this, you can safely ignore
        this message.
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
  color: tokens.colors.success,
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

const bodyStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: tokens.typography.lineHeight,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  fontFamily,
};

const expiryStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "13px",
  color: tokens.colors.mutedText,
  margin: 0,
};

const footerTextStyle: React.CSSProperties = {
  fontFamily,
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
  marginBottom: 0,
  lineHeight: tokens.typography.lineHeight,
};
