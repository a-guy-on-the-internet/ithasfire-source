import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import { zoneOption } from "../lib/event-time-zone";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

/**
 * Pre-renewal notice for a recurring membership, sent off Stripe's
 * `invoice.upcoming` webhook ahead of each charge.
 *
 * Load-bearing for dispute prevention (recurring-memberships spec): the
 * commonest recurring-billing chargeback is a member who could not find how to
 * cancel, so the cancel affordance is the primary CTA — not a footer link.
 * `ownerName` is rendered because the OWNER's name is what appears on the
 * member's card statement (statement-descriptor congruence); the tier name
 * lives here and on the receipt, never on the statement.
 */
export type MembershipRenewalNoticeProps = {
  /** Tier name, e.g. "Sustaining Member". */
  tierName: string;
  /** The org's or human's name — what the card statement will show. */
  ownerName: string;
  /** Pre-formatted charge amount, e.g. "$10.98" (formatted by the caller). */
  amountFormatted: string;
  /** ISO timestamp of the upcoming charge (Stripe `next_payment_attempt`). */
  renewalDateISO: string;
  /**
   * IANA zone the renewal date reads in. The caller passes the platform
   * default (a membership's owner carries no zone); absent, the runtime's.
   */
  timezone?: string;
  /** Link to the member's self-serve membership management page. */
  cancelUrl: string;
};

const formatDate = (iso: string, timezone: string | undefined) => {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    ...zoneOption(timezone),
  }).format(new Date(iso));
};

export const MembershipRenewalNotice = (
  props: MembershipRenewalNoticeProps,
): ReactElement => {
  const {
    tierName,
    ownerName,
    amountFormatted,
    renewalDateISO,
    timezone,
    cancelUrl,
  } = props;
  const renewalDate = formatDate(renewalDateISO, timezone);

  return (
    <Shell
      title="Your membership renews soon"
      previewText={`${amountFormatted} for ${tierName} on ${renewalDate} — manage or cancel anytime`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={eyebrowStyle}>Upcoming renewal</Text>
        <Text style={headingStyle}>Your membership renews soon</Text>
      </Section>

      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={bodyStyle}>
          Your <strong>{tierName}</strong> membership supporting{" "}
          <strong>{ownerName}</strong> renews on {renewalDate}. Nothing to do if
          you&rsquo;d like to keep supporting them.
        </Text>
      </Section>

      <Section style={cardStyle}>
        <Text style={cardLabelStyle}>Renewal</Text>
        <Text style={cardValueStyle}>{amountFormatted}</Text>
        <Text style={cardDateStyle}>
          Charged on {renewalDate} · appears as {ownerName} on your statement
        </Text>
      </Section>

      <Section style={{ marginTop: spacing(3) }}>
        <Button
          href={cancelUrl}
          style={primaryButtonStyle}
          aria-label="Manage or cancel your membership"
        >
          Manage or cancel membership
        </Button>
      </Section>

      <Text style={footerStyle}>
        You can cancel anytime before the renewal date and you won&rsquo;t be
        charged again. Questions? Just reply to this email.
      </Text>
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
  fontSize: "28px",
  fontWeight: 700,
  margin: 0,
  lineHeight: tokens.typography.headingTightLH,
};

const bodyStyle: React.CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: "1.5",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.surfaceMuted,
  borderRadius: tokens.radius,
  padding: "24px",
  border: `1px solid ${tokens.colors.border}`,
};

const cardLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(0.5),
};

const cardValueStyle: React.CSSProperties = {
  fontSize: "20px",
  fontWeight: 700,
  margin: 0,
};

const cardDateStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 400,
  color: tokens.colors.text,
  margin: 0,
  marginTop: spacing(0.5),
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
};

const footerStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  marginTop: spacing(3),
};
