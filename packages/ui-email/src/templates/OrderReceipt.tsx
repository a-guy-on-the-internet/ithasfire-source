import {
  Button,
  Column,
  Hr,
  Row,
  Section,
  Text,
} from "@react-email/components";
import { type ReactElement } from "react";
import { formatMoneyCents } from "@th/types/money";

import { Shell } from "./Shell";
import {
  spacing,
  tokens,
  primaryButtonStyle as sharedPrimaryButton,
} from "../theme/tokens";

export type OrderReceiptProps = {
  orderId: string;
  /** Omitted for a buyer with no name on file (a door buyer who gave only an email). */
  buyerName?: string;
  lineItems: Array<{
    label: string;
    amountCents: number;
  }>;
  totalCents: number;
  eventTitle?: string;
  /**
   * The buyer's order page. Omitted for a guest with no sign-in method (a
   * door buyer who gave only an email): the page is behind sign-in, so the
   * link would be a dead end; their ticket email carries the claim link.
   */
  viewOrderUrl?: string;
  /** How the buyer paid ("Card", "Cash", "Complimentary"). Shown when set. */
  paymentMethod?: string;
  /** A comp: the receipt reads as a gift, not a purchase. */
  complimentary?: boolean;
  /** ISO 4217 code of the amounts. Defaults to USD. */
  currency?: string;
};

/**
 * Receipt figures use the EXACT contract (`formatMoneyCents`) — a receipt line
 * always shows full fraction digits, so "$45.00" is correct here and "$45"
 * would read as truncation. The COMPACT contract (`formatPriceCents`) is for
 * browse/discovery price labels only.
 *
 * CURRENCY: `currency` when the sender passes it (the door-sale receipt
 * does), else USD as before (the resale receipt does not pass one yet).
 */
const formatCurrency = (cents: number, currency: string | undefined): string =>
  formatMoneyCents(cents, {
    currency: (currency ?? "USD").toUpperCase(),
    locale: "en-US",
  });

export const OrderReceipt = (props: OrderReceiptProps): ReactElement => {
  const {
    orderId,
    buyerName,
    lineItems,
    totalCents,
    eventTitle,
    viewOrderUrl,
    paymentMethod,
    complimentary,
    currency,
  } = props;
  const name = buyerName?.trim();

  return (
    <Shell
      title={`Receipt for order ${orderId}`}
      previewText={`Order ${orderId} receipt`}
    >
      <Section style={{ marginBottom: spacing(2) }}>
        <Text style={headingStyle}>
          {complimentary ? (
            name ? (
              <>Here&apos;s your ticket, {name}!</>
            ) : (
              "Here's your ticket!"
            )
          ) : name ? (
            <>Thanks for your purchase, {name}!</>
          ) : (
            "Thanks for your purchase!"
          )}
        </Text>
        <Text style={subtitleStyle}>
          {complimentary
            ? "This receipt records your complimentary order"
            : "This receipt summarises your recent order"}
          {eventTitle ? ` for ${eventTitle}` : ""}.
        </Text>
      </Section>

      <Section style={summaryCardStyle}>
        <Row>
          <Column>
            <Text style={labelStyle}>Order ID</Text>
            <Text style={valueStyle}>{orderId}</Text>
          </Column>
        </Row>
        {eventTitle ? (
          <Row style={{ marginTop: spacing(1) }}>
            <Column>
              <Text style={labelStyle}>Event</Text>
              <Text style={valueStyle}>{eventTitle}</Text>
            </Column>
          </Row>
        ) : null}
        {paymentMethod ? (
          <Row style={{ marginTop: spacing(1) }}>
            <Column>
              <Text style={labelStyle}>Payment</Text>
              <Text style={valueStyle}>{paymentMethod}</Text>
            </Column>
          </Row>
        ) : null}
      </Section>

      <Section style={lineItemsCardStyle}>
        {lineItems.map((item, index) => (
          <Row key={`${index}-${item.label}`} style={lineItemRowStyle}>
            <Column>
              <Text style={lineItemLabelStyle}>{item.label}</Text>
            </Column>
            <Column style={{ textAlign: "right" }}>
              <Text style={lineItemValueStyle}>
                {formatCurrency(item.amountCents, currency)}
              </Text>
            </Column>
          </Row>
        ))}
        <Hr style={dividerStyle} />
        <Row>
          <Column>
            <Text style={totalLabelStyle}>Total</Text>
          </Column>
          <Column style={{ textAlign: "right" }}>
            <Text style={totalValueStyle}>
              {formatCurrency(totalCents, currency)}
            </Text>
          </Column>
        </Row>
      </Section>

      {viewOrderUrl ? (
        <>
          <Section>
            <Button
              style={primaryButtonStyle}
              href={viewOrderUrl}
              aria-label="View your order details"
            >
              View order details
            </Button>
          </Section>

          <Text style={footerTextStyle}>
            Keep this email for your records. If you have any questions, visit
            your order page for help.
          </Text>
        </>
      ) : (
        <Text style={footerTextStyle}>
          Keep this email for your records. Your ticket and its QR code are in
          a separate email.
        </Text>
      )}

      {complimentary ? null : (
        <Text style={merchantOfRecordStyle}>
          Ithas Fire is the merchant of record for this purchase, sold on behalf
          of the event organiser.
        </Text>
      )}
    </Shell>
  );
};

const headingStyle: React.CSSProperties = {
  fontSize: "22px",
  fontWeight: 700,
  margin: 0,
  marginBottom: spacing(1),
};

const subtitleStyle: React.CSSProperties = {
  fontSize: "16px",
  color: tokens.colors.mutedText,
  margin: 0,
};

const summaryCardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.surfaceMuted,
  borderRadius: tokens.radius,
  padding: "16px",
  border: `1px solid ${tokens.colors.border}`,
  marginBottom: spacing(3),
};

const labelStyle: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  marginBottom: "4px",
  letterSpacing: "0.02em",
};

const valueStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  margin: 0,
};

const lineItemsCardStyle: React.CSSProperties = {
  borderRadius: tokens.radius,
  border: `1px solid ${tokens.colors.border}`,
  padding: "16px",
  marginBottom: spacing(3),
};

const lineItemRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: spacing(1),
};

const lineItemLabelStyle: React.CSSProperties = {
  fontSize: "16px",
  margin: 0,
};

const lineItemValueStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 500,
  margin: 0,
};

const dividerStyle: React.CSSProperties = {
  borderColor: tokens.colors.border,
  margin: `${spacing(2)} 0`,
};

const totalLabelStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  margin: 0,
};

const totalValueStyle: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: 700,
  margin: 0,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  marginBottom: spacing(2),
};

const footerTextStyle: React.CSSProperties = {
  fontSize: "14px",
  color: tokens.colors.mutedText,
  margin: 0,
  lineHeight: tokens.typography.lineHeight,
};

const merchantOfRecordStyle: React.CSSProperties = {
  fontSize: "12px",
  color: tokens.colors.mutedText,
  marginTop: spacing(2),
  marginBottom: 0,
  lineHeight: tokens.typography.lineHeight,
};
