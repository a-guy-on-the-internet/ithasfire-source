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

export type PayoutSentProps = {
  /**
   * `payout` — money moved to the organiser's Stripe account.
   * `reserved` — the amount is held in reserve; nothing moved, nothing lost.
   * `applied_to_balance` — the amount cleared an outstanding balance; no transfer.
   */
  kind: "payout" | "reserved" | "applied_to_balance";
  amountCents: number;
  currency: string;
  /** Null when the payee is a human, not an organisation. */
  orgName: string | null;
  payoutDateIso: string;
  displayTimezone: string;
  lines: Array<{
    eventTitle: string | null;
    eventStartsAtIso: string | null;
    eventTimezone: string | null;
    ticketCount: number | null;
    amountCents: number;
    orderId: string | null;
  }>;
  recoveredDebtCents: number;
  connectAccountFeeCents: number;
  reserveHeldCents: number;
  /** Reserve released back to the payee on this payout. */
  reserveReleasedCents: number;
  /** Credits dropped by the 25-line cap, and their total. */
  otherSalesCount: number;
  otherSalesCents: number;
  /** SIGNED residual (earlier refunds and other changes); 0 omits the row. */
  adjustmentsCents: number;
  /** Null when the sender cannot state a balance; the "Still owed" row is then omitted. */
  balanceAfterCents: number | null;
  nextPayableAtIso: string | null;
  /** Stripe's stated bank-arrival delay for this account; null means "we don't know". */
  bankDelayDays: number | null;
  /** Null when the payee has no payouts page (human payee); the button is then omitted. */
  payoutsUrl: string | null;
  stripeDashboardUrl: string;
  settlementCount: number;
};

type PayoutLine = PayoutSentProps["lines"][number];

/** One non-sale row of the statement: a signed, pre-formatted value and its colour. */
type StatementRow = {
  label: string;
  sub?: string;
  value: string;
  tone: "ink" | "accent";
};

/**
 * Payout figures use the EXACT contract (`formatMoneyCents`): "$10.64" and
 * "$45.00", never "$45" — this is an accounting statement, and a dropped ".00"
 * reads as truncation.
 */
const formatCurrency = (cents: number, currency: string): string =>
  formatMoneyCents(cents, { currency, locale: "en-US" });

type DateParts = { weekday: string; day: string; month: string; year: string };

/**
 * Day-month order ("Sun 20 Sep", "Sunday 20 September") assembled from parts.
 * `en` gives month-day order and `en-GB`'s ICU data spells September "Sept",
 * so neither locale's ready-made pattern matches the approved design.
 * An unknown time zone falls back to UTC rather than failing the whole send.
 */
const dateParts = (
  iso: string,
  timeZone: string,
  style: "short" | "long",
): DateParts => {
  const options: Intl.DateTimeFormatOptions = {
    weekday: style,
    day: "numeric",
    month: style,
    year: "numeric",
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en", { ...options, timeZone });
  } catch {
    formatter = new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" });
  }
  const parts = formatter.formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    day: get("day"),
    month: get("month"),
    year: get("year"),
  };
};

/** "Sun 20 Sep" */
const formatShortDate = (iso: string, timeZone: string): string => {
  const { weekday, day, month } = dateParts(iso, timeZone, "short");
  return `${weekday} ${day} ${month}`;
};

/** "Sunday 20 September" */
const formatLongDate = (iso: string, timeZone: string): string => {
  const { weekday, day, month } = dateParts(iso, timeZone, "long");
  return `${weekday} ${day} ${month}`;
};

/** "20 Sep 2026" */
const formatHeaderDate = (iso: string, timeZone: string): string => {
  const { day, month, year } = dateParts(iso, timeZone, "short");
  return `${day} ${month} ${year}`;
};

/**
 * The subject line AND the `<title>` — one function so the two cannot drift.
 * Only a real transfer may say "paid".
 */
export const payoutSentTitle = (props: PayoutSentProps): string => {
  const amount = formatCurrency(props.amountCents, props.currency);
  return props.kind === "reserved"
    ? `Your ${amount} payout is being held in reserve`
    : props.kind === "applied_to_balance"
      ? `Your ${amount} payout covered your outstanding balance`
      : `You've been paid ${amount}`;
};

/**
 * Hero size stepped down by the FORMATTED length, not by measuring glyphs —
 * clients that never load Montserrat must land on the same size. The Shell
 * leaves ~262px of inner width on a 360px phone; at 52px/800 that fits about
 * seven glyphs ("$999.99"), so anything longer steps to 40px, and a six-figure
 * sum to 32px.
 */
const heroFontSize = (formatted: string): number =>
  formatted.length > 10 ? 32 : formatted.length > 7 ? 40 : 52;

const pluralise = (count: number, singular: string, plural: string) =>
  `${count} ${count === 1 ? singular : plural}`;

const lineSubtitle = (line: PayoutLine, displayTimezone: string): string => {
  const parts: string[] = [];
  if (line.eventStartsAtIso) {
    parts.push(
      formatShortDate(
        line.eventStartsAtIso,
        line.eventTimezone ?? displayTimezone,
      ),
    );
  }
  if (line.ticketCount !== null) {
    parts.push(pluralise(line.ticketCount, "ticket", "tickets"));
  }
  return parts.join(" · ");
};

const buildPreviewText = (props: PayoutSentProps, nothingWithheld: boolean) => {
  switch (props.kind) {
    case "reserved":
      return "Held in reserve — it's still yours";
    case "applied_to_balance":
      return "No transfer was sent — it covered your balance";
    default:
      return [
        `Sent to your Stripe account ${formatShortDate(
          props.payoutDateIso,
          props.displayTimezone,
        )}`,
        // `settlementCount` counts consumed credits (sales), not events.
        pluralise(props.settlementCount, "sale", "sales"),
        ...(nothingWithheld ? ["nothing withheld"] : []),
      ].join(" · ");
  }
};

export const PayoutSent = (props: PayoutSentProps): ReactElement => {
  const {
    kind,
    amountCents,
    currency,
    orgName,
    payoutDateIso,
    displayTimezone,
    lines,
    recoveredDebtCents,
    connectAccountFeeCents,
    reserveHeldCents,
    reserveReleasedCents,
    otherSalesCount,
    otherSalesCents,
    adjustmentsCents,
    balanceAfterCents,
    nextPayableAtIso,
    bankDelayDays,
    payoutsUrl,
    stripeDashboardUrl,
  } = props;

  const money = (cents: number) => formatCurrency(cents, currency);
  const amount = money(amountCents);
  const shortDate = formatShortDate(payoutDateIso, displayTimezone);
  const longDate = formatLongDate(payoutDateIso, displayTimezone);
  // "Nothing was withheld" is the plain-payout affirmation: sales in, same
  // sum out. A refund residual means money did not arrive, and a reserve
  // release means the sum is not just these sales — either way the statement
  // has something to explain, so the sentence stays off.
  const nothingWithheld =
    recoveredDebtCents === 0 &&
    connectAccountFeeCents === 0 &&
    reserveHeldCents === 0 &&
    adjustmentsCents === 0 &&
    reserveReleasedCents === 0;

  // Extra credits: money arriving, so ink like the sale lines.
  const extraCredits: StatementRow[] = [
    // With no itemised lines (legacy or enrichment-timeout payloads) they are
    // not "other" than anything: one plain, unsigned "N sales" row, matching
    // the text renderer.
    ...(otherSalesCount > 0
      ? [
          lines.length === 0
            ? {
                label: pluralise(otherSalesCount, "sale", "sales"),
                value: money(otherSalesCents),
                tone: "ink" as const,
              }
            : {
                label: pluralise(otherSalesCount, "other sale", "other sales"),
                sub: "not listed individually",
                value: `+${money(otherSalesCents)}`,
                tone: "ink" as const,
              },
        ]
      : []),
    ...(reserveReleasedCents > 0
      ? [
          {
            label: "Reserve released back to you",
            value: `+${money(reserveReleasedCents)}`,
            tone: "ink" as const,
          },
        ]
      : []),
  ];

  // The bold "outcome" row already carries the reserve (reserved kind) or the
  // recovered balance (applied kind), so the matching deduction row is skipped
  // there — otherwise the same money would appear twice in one column.
  const deductions: StatementRow[] = [
    ...(recoveredDebtCents > 0 && kind !== "applied_to_balance"
      ? [{ label: "Applied to an earlier refund", cents: recoveredDebtCents }]
      : []),
    ...(connectAccountFeeCents > 0
      ? [{ label: "Stripe account fee withheld", cents: connectAccountFeeCents }]
      : []),
    ...(reserveHeldCents > 0 && kind !== "reserved"
      ? [{ label: "Held in reserve", cents: reserveHeldCents }]
      : []),
  ].map(({ label, cents }) => ({
    label,
    value: `−${money(cents)}`,
    tone: "accent" as const,
  }));

  // Signed: a positive residual arrives (ink), a negative one leaves (accent).
  const adjustments: StatementRow[] =
    adjustmentsCents === 0
      ? []
      : [
          {
            label: "Other adjustments",
            sub: "Earlier refunds and other changes since these sales",
            value:
              adjustmentsCents > 0
                ? `+${money(adjustmentsCents)}`
                : `−${money(-adjustmentsCents)}`,
            tone: adjustmentsCents > 0 ? ("ink" as const) : ("accent" as const),
          },
        ];

  const statementRows = [...extraCredits, ...deductions, ...adjustments];

  const outcomeRow =
    kind === "reserved"
      ? { label: "Held in reserve", value: `−${amount}` }
      : kind === "applied_to_balance"
        ? { label: "Covered your outstanding balance", value: `−${amount}` }
        : { label: "Sent to your Stripe account", value: `−${amount}` };

  const title = payoutSentTitle(props);

  // A reserved amount was withheld in full, so "nothing was withheld" is only
  // true of a real transfer; and a reserve email must never say "paid".
  const withheldSentence =
    kind === "payout" && nothingWithheld
      ? "Nothing was withheld from this payout. "
      : "";
  const balanceSentence =
    balanceAfterCents === null
      ? null
      : balanceAfterCents === 0
        ? kind === "payout"
          ? "Nothing else is waiting to be paid."
          : "Nothing else is outstanding."
        : balanceAfterCents > 0
          ? `${money(balanceAfterCents)} is still coming${
              nextPayableAtIso
                ? `, and becomes payable on ${formatShortDate(
                    nextPayableAtIso,
                    displayTimezone,
                  )}.`
                : "."
            }`
          : // A negative balance is owed BY the payee; the "Still owed" row
            // shows the signed figure and no sentence claims money is coming.
            null;

  const bankValue =
    bankDelayDays === null
      ? "On Stripe's schedule"
      : `On Stripe's schedule · about ${pluralise(
          bankDelayDays,
          "day",
          "days",
        )} for this account`;

  return (
    <Shell title={title} previewText={buildPreviewText(props, nothingWithheld)}>
      <Hr style={brandBarStyle} />

      <Section style={{ marginBottom: spacing(4) }}>
        <Row>
          <Column>
            <Text style={wordmarkStyle}>Ithas Fire</Text>
          </Column>
          <Column style={{ textAlign: "right" }}>
            <Text style={dateLabelStyle}>
              {`Payout · ${formatHeaderDate(payoutDateIso, displayTimezone)}`}
            </Text>
          </Column>
        </Row>
      </Section>

      <Section style={{ marginBottom: spacing(4) }}>
        <Text
          style={{ ...heroAmountStyle, fontSize: `${heroFontSize(amount)}px` }}
        >
          {amount}
        </Text>
        {kind === "payout" ? (
          <Text style={statusStyle}>
            <span style={checkStyle}>✓</span>
            {` Sent to your Stripe account on ${longDate}.`}
          </Text>
        ) : kind === "reserved" ? (
          <Text style={statusStyle}>
            Held for now. It&rsquo;s still yours and is released with a future
            payout.
          </Text>
        ) : (
          <Text style={statusStyle}>
            Covered your outstanding balance from a lost dispute. No transfer
            was sent.
          </Text>
        )}
      </Section>

      {kind === "payout" ? (
        <Section style={{ marginBottom: spacing(5) }}>
          <Row style={hopTableStyle}>
            <Column style={hopCellMovedStyle}>
              <Text style={hopLabelStyle}>We sent it</Text>
              <Text style={hopValueMovedStyle}>{shortDate}</Text>
            </Column>
            <Column style={hopCellPendingStyle}>
              <Text style={hopLabelStyle}>Your bank</Text>
              <Text style={hopValuePendingStyle}>{bankValue}</Text>
            </Column>
          </Row>
        </Section>
      ) : null}

      {kind === "reserved" ? (
        <Section style={reserveNoteStyle}>
          <Text style={noteTextStyle}>
            Reserves hold a portion of new sales for a short period. Nothing
            was taken — this returns automatically.
          </Text>
        </Section>
      ) : null}

      {kind === "applied_to_balance" ? (
        <Section style={balanceNoteStyle}>
          <Text style={noteTextStyle}>
            Future payouts go to your Stripe account as usual.
          </Text>
        </Section>
      ) : null}

      <Section style={{ marginBottom: spacing(3) }}>
        <Text style={sectionLabelStyle}>Where it came from</Text>
        {lines.map((line, index) => {
          const subtitle = lineSubtitle(line, displayTimezone);
          return (
            <Row key={index} style={linesTableStyle}>
              <Column style={lineCellStyle}>
                <Text style={lineTitleStyle}>{line.eventTitle ?? "Sale"}</Text>
                {subtitle ? <Text style={lineMetaStyle}>{subtitle}</Text> : null}
              </Column>
              <Column style={amountCellStyle}>
                <Text style={lineAmountStyle}>{money(line.amountCents)}</Text>
              </Column>
            </Row>
          );
        })}
        {statementRows.map((row) => (
          <Row key={row.label} style={linesTableStyle}>
            <Column style={lineCellStyle}>
              <Text
                style={
                  row.tone === "accent" ? deductionLabelStyle : lineTitleStyle
                }
              >
                {row.label}
              </Text>
              {row.sub ? <Text style={lineMetaStyle}>{row.sub}</Text> : null}
            </Column>
            <Column style={amountCellStyle}>
              <Text
                style={
                  row.tone === "accent" ? deductionAmountStyle : lineAmountStyle
                }
              >
                {row.value}
              </Text>
            </Column>
          </Row>
        ))}
        <Row style={linesTableStyle}>
          <Column style={lineCellStyle}>
            <Text style={outcomeLabelStyle}>{outcomeRow.label}</Text>
          </Column>
          <Column style={amountCellStyle}>
            <Text style={outcomeAmountStyle}>{outcomeRow.value}</Text>
          </Column>
        </Row>
        {balanceAfterCents !== null ? (
          <Row style={linesTableStyle}>
            <Column style={totalCellStyle}>
              <Text style={totalLabelStyle}>
                {`Still owed to ${orgName ?? "you"}`}
              </Text>
            </Column>
            <Column style={totalAmountCellStyle}>
              <Text style={totalAmountStyle}>{money(balanceAfterCents)}</Text>
            </Column>
          </Row>
        ) : null}
      </Section>

      {withheldSentence || balanceSentence ? (
        <Text style={summaryStyle}>
          {`${withheldSentence}${balanceSentence ?? ""}`}
        </Text>
      ) : null}

      <Section style={{ marginBottom: spacing(4) }}>
        {payoutsUrl ? (
          <Button
            href={payoutsUrl}
            style={primaryButtonStyle}
            aria-label="View payouts"
          >
            View payouts
          </Button>
        ) : null}
        {/* Keeps the two links apart in the plain-text rendering. */}{" "}
        <a href={stripeDashboardUrl} style={textLinkStyle}>
          Open your Stripe dashboard
        </a>
      </Section>

      <Text style={footerNoteStyle}>
        {orgName
          ? `You handle finances for ${orgName}, so you get a note each time a payout is sent.`
          : "You get a note each time a payout is sent."}
      </Text>
    </Shell>
  );
};

const brandBarStyle: React.CSSProperties = {
  border: 0,
  borderTop: `4px solid ${tokens.colors.brandAccent}`,
  margin: 0,
  marginBottom: spacing(3),
  width: "100%",
};

const wordmarkStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 800,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.4,
};

const dateLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: tokens.colors.mutedText,
  margin: 0,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
};

const heroAmountStyle: React.CSSProperties = {
  fontSize: "52px",
  fontWeight: 800,
  letterSpacing: "-0.025em",
  fontVariantNumeric: "tabular-nums",
  lineHeight: 1.1,
  color: tokens.colors.text,
  margin: 0,
  marginBottom: spacing(2),
};

const statusStyle: React.CSSProperties = {
  fontSize: "15px",
  fontWeight: 600,
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.45,
};

const checkStyle: React.CSSProperties = {
  color: tokens.colors.success,
};

const hopTableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
};

const hopCellBaseStyle: React.CSSProperties = {
  border: `1px solid ${tokens.colors.border}`,
  padding: "12px 14px",
  verticalAlign: "top",
};

// Two cells, not three: "Stripe has it" is true the instant we send, so it
// said nothing "We sent it" didn't, and the bank sentence needs the room.
const hopCellMovedStyle: React.CSSProperties = {
  ...hopCellBaseStyle,
  width: "40%",
  backgroundColor: tokens.colors.surfaceMuted,
};

const hopCellPendingStyle: React.CSSProperties = {
  ...hopCellBaseStyle,
  width: "60%",
};

const hopLabelStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: 600,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(0),
  lineHeight: 1.4,
};

const hopValueMovedStyle: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  color: tokens.colors.success,
  margin: 0,
  lineHeight: 1.4,
};

const hopValuePendingStyle: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  color: tokens.colors.mutedText,
  margin: 0,
  lineHeight: 1.4,
};

const noteBaseStyle: React.CSSProperties = {
  padding: "12px 14px",
  marginBottom: spacing(5),
  borderRadius: tokens.radius,
};

const reserveNoteStyle: React.CSSProperties = {
  ...noteBaseStyle,
  backgroundColor: tokens.colors.warningBg,
  borderLeft: `3px solid ${tokens.colors.warningBorder}`,
};

const balanceNoteStyle: React.CSSProperties = {
  ...noteBaseStyle,
  backgroundColor: tokens.colors.surfaceMuted,
  borderLeft: `3px solid ${tokens.colors.border}`,
};

const noteTextStyle: React.CSSProperties = {
  fontSize: "13px",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.5,
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: "10.5px",
  fontWeight: 600,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(0),
  lineHeight: 1.4,
};

const linesTableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
};

const lineCellStyle: React.CSSProperties = {
  padding: "10px 0",
  borderBottom: `1px solid ${tokens.colors.border}`,
  verticalAlign: "top",
};

const amountCellStyle: React.CSSProperties = {
  ...lineCellStyle,
  textAlign: "right",
  whiteSpace: "nowrap",
  paddingLeft: spacing(3),
  width: "1%",
};

const lineTitleStyle: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 600,
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.4,
};

const lineMetaStyle: React.CSSProperties = {
  fontSize: "12px",
  color: tokens.colors.mutedText,
  margin: 0,
  marginTop: "2px",
  lineHeight: 1.4,
};

const lineAmountStyle: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 500,
  fontVariantNumeric: "tabular-nums",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.4,
};

const deductionLabelStyle: React.CSSProperties = {
  ...lineTitleStyle,
  fontWeight: 500,
  color: tokens.colors.brandAccent,
};

const deductionAmountStyle: React.CSSProperties = {
  ...lineAmountStyle,
  color: tokens.colors.brandAccent,
};

const outcomeLabelStyle: React.CSSProperties = {
  ...lineTitleStyle,
  fontWeight: 700,
};

const outcomeAmountStyle: React.CSSProperties = {
  ...lineAmountStyle,
  fontWeight: 700,
};

const totalCellStyle: React.CSSProperties = {
  padding: "12px 0 0",
  borderTop: `2px solid ${tokens.colors.text}`,
  verticalAlign: "top",
};

const totalAmountCellStyle: React.CSSProperties = {
  ...totalCellStyle,
  textAlign: "right",
  whiteSpace: "nowrap",
  paddingLeft: spacing(3),
  width: "1%",
};

const totalLabelStyle: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 700,
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.4,
};

const totalAmountStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  color: tokens.colors.text,
  margin: 0,
  lineHeight: 1.4,
};

const summaryStyle: React.CSSProperties = {
  fontSize: "13px",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(4),
  lineHeight: 1.5,
};

const primaryButtonStyle: React.CSSProperties = {
  ...sharedPrimaryButton,
  fontSize: "14px",
  marginRight: spacing(4),
  marginBottom: spacing(2),
};

const textLinkStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: "14px",
  fontWeight: 600,
  color: tokens.colors.text,
  textDecoration: "underline",
  marginBottom: spacing(2),
  lineHeight: 1.5,
};

const footerNoteStyle: React.CSSProperties = {
  fontSize: "11.5px",
  color: tokens.colors.mutedText,
  margin: 0,
  marginBottom: spacing(4),
  lineHeight: 1.5,
};
