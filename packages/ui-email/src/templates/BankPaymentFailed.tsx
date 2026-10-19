import { Button, Section, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type BankPaymentFailedProps = {
  /** Title of the event the order was for. */
  eventTitle: string;
  /** The ONE displayed order code (`formatOrderCode`: 8-hex tail, uppercased). */
  orderCode: string;
  /**
   * The event's public page, where the buyer can buy again. Null when the
   * event has no slug: the notice must still send without the button.
   */
  eventUrl?: string | null;
};

export const BANK_PAYMENT_FAILED_SUBJECT = "Your bank payment didn't go through";

/**
 * A US bank account (ACH) payment that was accepted as "processing" failed
 * days later, and the order was cancelled. Sent only for that case: a card
 * decline happens while the buyer is on the page and needs no email.
 *
 * Short on purpose: what happened, that nothing was charged, and the way back
 * to buy again. Hardcoded English like OrderReceipt and TicketIssued's
 * siblings; no translator keys, so the locale bundles stay untouched.
 */
export const BankPaymentFailed = (
  props: BankPaymentFailedProps,
): ReactElement => {
  const { eventTitle, orderCode, eventUrl } = props;

  return (
    <Shell
      title={BANK_PAYMENT_FAILED_SUBJECT}
      previewText={`Order ${orderCode} for ${eventTitle} was cancelled. You weren't charged.`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={headingStyle}>{BANK_PAYMENT_FAILED_SUBJECT}</Text>
      </Section>

      <Section style={{ marginBottom: "20px" }}>
        <Text style={bodyStyle}>
          The bank payment for {eventTitle} didn&apos;t go through, so we
          cancelled order {orderCode}. You weren&apos;t charged.
        </Text>
      </Section>

      {eventUrl ? (
        <Section style={{ marginTop: "32px", textAlign: "center" }}>
          <Button href={eventUrl} style={primaryButtonStyle}>
            Buy Again
          </Button>
        </Section>
      ) : null}
    </Shell>
  );
};

const headingStyle: React.CSSProperties = {
  fontSize: "28px",
  fontWeight: 700,
  margin: 0,
  lineHeight: tokens.typography.headingTightLH,
  color: tokens.colors.text,
  textTransform: "uppercase",
  letterSpacing: "-0.02em",
};

const bodyStyle: React.CSSProperties = {
  fontSize: "15px",
  margin: 0,
  color: tokens.colors.text,
  lineHeight: 1.5,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  fontSize: "14px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
