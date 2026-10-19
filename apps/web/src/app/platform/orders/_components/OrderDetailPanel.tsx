import React from "react";
import { YStack, XStack } from "tamagui";
import { Button, Text, Badge, useTranslations, useFormatters } from "@th/ui";
import { X, ExternalLink, Copy } from "lucide-react";

import { fmtDate, fmtCurrency, truncateId } from "@/lib/format";
import { OrderStatusBadge } from "../../../admin/[slug]/orders/_components/OrderStatusBadge";
import { MonoText, SectionDivider, SectionHeader } from "./detail-parts";
import { OrderSplitsSection } from "./OrderSplitsSection";
import type { OrderStatus, OrderSource } from "@th/types";
import { formatOrderCode } from "@th/types/order-identifier";

// ─────────────────────────────────────────────────────────────────────────────
// Types (shared with parent page)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformOrderItemSummary {
  id: string;
  kind: "ticket" | "discount" | "surcharge";
  ticketTypeName: string | null;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  status: "active" | "refunded" | "transferred";
  paidOutAt: Date | null;
  refundedAt: Date | null;
  transferredAt: Date | null;
  ticketCode: string | null;
  ticketScannedAt: Date | null;
  seatId: string | null;
  ticketOwnerName: string | null;
}

export interface PlatformOrderRow {
  id: string;
  eventId: string | null;
  eventTitle: string | null;
  orgId: string | null;
  orgName: string | null;
  buyerHumanId: string;
  buyerName: string | null;
  buyerEmail: string | null;
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  currency: string;
  status: OrderStatus;
  source: OrderSource;
  stripePaymentIntentId: string | null;
  paymentMethodType: string | null;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;
  feePolicySnapshot: unknown;
  billingCountry: string | null;
  billingAddress: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  stripeTaxCalculationId: string | null;
  parentOrderId: string | null;
  /**
   * `code` is NULL for a membership-sourced discount — a benefit has no code.
   * Branch on `source`; rendering `code` directly leaves a blank badge.
   */
  promo: {
    source: "code" | "membership";
    code: string | null;
    amountDiscountCents: number;
  } | null;
  items: PlatformOrderItemSummary[];
  /**
   * What the buyer was charged, split server-side
   * (`computeBuyerChargeBreakdown`); the lines sum to `totalCents`.
   * `feesPlatformCents` is the RECORDED fee: under ABSORB the organiser paid
   * it out of their basis and the buyer was not charged it.
   */
  charges: {
    buyerFeeMode: "ABSORB" | "PASS_THROUGH";
    subtotalCents: number;
    platformFeeCents: number;
    processingFeeCents: number;
    taxCents: number;
    creditCents: number;
    totalCents: number;
  };
}

export const SOURCE_LABEL_KEY: Record<OrderSource, string> = {
  PRIMARY: "admin.plSourcePrimary",
  RESALE: "admin.plSourceResale",
  COMP: "admin.plSourceComp",
};

/** Type-narrow the JSON blob stored in feePolicySnapshot. */
interface FeePolicySnapshotShape {
  feePolicyId?: string;
  feePolicyVersion?: number;
  feeMode?: string;
  computedAt?: string;
  payoutTermsId?: string;
  payoutTermsVersion?: number;
  buyerFeePct?: number;
  processsorFeePct?: number;
  processorFixedCents?: number;
  platformFixedCents?: number;
  maxFeeCents?: number;
  minFeeCents?: number;
  maxPlatformFeeCents?: number;
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <XStack justifyContent="space-between" alignItems="baseline" gap="$2">
      <Text variant="caption" tone="muted" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      {typeof children === "string" ? (
        <Text variant="body" style={{ textAlign: "right" }}>
          {children}
        </Text>
      ) : (
        children
      )}
    </XStack>
  );
}

const ITEM_STATUS_TONE: Record<
  string,
  "success" | "danger" | "info" | "neutral"
> = {
  active: "success",
  refunded: "danger",
  transferred: "info",
};

export function PlatformOrderDetail({
  row,
  onClose,
}: {
  row: PlatformOrderRow;
  onClose: () => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();

  // What the card was charged. Not gross + recorded fee + tax: under ABSORB
  // the recorded fee was the organiser's cost, and the processing fee a
  // PASS_THROUGH buyer paid is not a column at all.
  const { charges } = row;
  const netAmountCents = charges.totalCents;
  // Under ABSORB the organiser absorbed the platform fee (Stripe's processing
  // fee is the platform's own cost, not shown here). A Stripe-paid order with
  // no per-item buyer totals can still show a buyer-paid fee: then it is a
  // charge line, not an absorbed one.
  const feeAbsorbed =
    charges.buyerFeeMode === "ABSORB" && charges.platformFeeCents === 0;

  const snapshot = (row.feePolicySnapshot ?? {}) as FeePolicySnapshotShape;

  // Settlement summary
  const ticketItems = row.items.filter((i) => i.kind === "ticket");
  const discountItems = row.items.filter((i) => i.kind === "discount");
  const surchargeItems = row.items.filter((i) => i.kind === "surcharge");
  const paidOutCount = row.items.filter((i) => i.paidOutAt).length;
  const refundedCount = row.items.filter((i) => i.status === "refunded").length;
  const transferredCount = row.items.filter(
    (i) => i.status === "transferred",
  ).length;
  const scannedCount = ticketItems.filter((i) => i.ticketScannedAt).length;

  // Financial breakdown
  const ticketSubtotal = ticketItems.reduce((s, i) => s + i.amountCents, 0);
  const discountTotal = discountItems.reduce(
    (s, i) => s + Math.abs(i.amountCents),
    0,
  );

  // Held vs paid-out vs refunded cents
  const heldCents = row.items
    .filter((i) => i.status === "active" && !i.paidOutAt)
    .reduce((s, i) => s + i.amountCents, 0);
  const paidOutCents = row.items
    .filter((i) => i.status === "active" && !!i.paidOutAt)
    .reduce((s, i) => s + i.amountCents, 0);
  const refundedCents = row.items
    .filter((i) => i.status === "refunded")
    .reduce((s, i) => s + i.amountCents, 0);

  // Billing address formatted
  const addr = row.billingAddress;
  const billingLine = addr
    ? [
        addr.line1,
        addr.line2,
        addr.city,
        addr.state,
        addr.postalCode,
        addr.country,
      ]
        .filter(Boolean)
        .join(", ")
    : null;

  return (
    <YStack
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      padding="$4"
      gap="$3"
      backgroundColor="$surfaceMuted"
    >
      {/* ── Header ── */}
      <XStack justifyContent="space-between" alignItems="center">
        <XStack gap="$2" alignItems="center">
          <Text variant="body" weight="bold">
            {String(t("admin.plOrderDetail"))}
          </Text>
          <OrderStatusBadge status={row.status} />
        </XStack>
        <Button
          variant="ghost"
          size="$2"
          icon
          onPress={onClose}
          aria-label={t("admin.plClose") as string}
        >
          <X size={14} />
        </Button>
      </XStack>

      {/* ── Order IDs ── */}
      <YStack gap="$2">
        <XStack gap="$2" alignItems="center">
          <Text variant="caption" tone="muted">
            {String(t("admin.plOrderIdLabel"))}
          </Text>
          <MonoText>{row.id}</MonoText>
        </XStack>
        <XStack gap="$2" alignItems="center">
          <Text variant="caption" tone="muted">
            {String(t("admin.plOrderCode"))}
          </Text>
          <MonoText>{formatOrderCode(row.id)}</MonoText>
        </XStack>
        {row.parentOrderId && (
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" tone="muted">
              {String(t("admin.plParentOrder"))}
            </Text>
            <MonoText size={11}>{row.parentOrderId}</MonoText>
          </XStack>
        )}
      </YStack>

      {/* ── Key metadata row ── */}
      <XStack gap="$4" flexWrap="wrap">
        <YStack gap="$1" minWidth={110}>
          <Text variant="caption" tone="muted">
            {String(t("admin.plSource"))}
          </Text>
          <Badge tone={row.source === "RESALE" ? "info" : "neutral"} size="sm">
            {String(t(SOURCE_LABEL_KEY[row.source]))}
          </Badge>
        </YStack>
        <YStack gap="$1" minWidth={80}>
          <Text variant="caption" tone="muted">
            {String(t("admin.plItems"))}
          </Text>
          <Text variant="body">{row.itemCount}</Text>
        </YStack>
        {row.paymentMethodType && (
          <YStack gap="$1" minWidth={110}>
            <Text variant="caption" tone="muted">
              {String(t("admin.plPaymentMethod"))}
            </Text>
            <Badge tone="neutral" size="sm">
              {row.paymentMethodType}
            </Badge>
          </YStack>
        )}
        {row.promo && (
          <YStack gap="$1" minWidth={110}>
            <Text variant="caption" tone="muted">
              {String(t("admin.plPromo"))}
            </Text>
            <XStack gap="$1" alignItems="center">
              {/* A membership-sourced discount has no code; without this the
                  badge rendered EMPTY next to the amount. */}
              <Badge tone="success" size="sm">
                {row.promo.source === "membership"
                  ? String(t("checkout.memberDiscount"))
                  : row.promo.code}
              </Badge>
              <Text variant="caption" tone="muted">
                &minus;
                {fmtCurrency(fmt, row.promo.amountDiscountCents, row.currency)}
              </Text>
            </XStack>
          </YStack>
        )}
      </XStack>

      {/* ── Timestamps ── */}
      <SectionDivider />
      <XStack gap="$4" flexWrap="wrap">
        <YStack gap="$1" minWidth={140}>
          <Text variant="caption" tone="muted">
            {String(t("admin.date"))}
          </Text>
          <Text variant="body">{fmtDate(fmt, row.occurredAt)}</Text>
        </YStack>
        <YStack gap="$1" minWidth={140}>
          <Text variant="caption" tone="muted">
            {String(t("admin.plCreatedAt"))}
          </Text>
          <Text variant="body">{fmtDate(fmt, row.createdAt)}</Text>
        </YStack>
        {row.updatedAt.getTime() !== row.createdAt.getTime() && (
          <YStack gap="$1" minWidth={140}>
            <Text variant="caption" tone="muted">
              {String(t("admin.plUpdatedAt"))}
            </Text>
            <Text variant="body">{fmtDate(fmt, row.updatedAt)}</Text>
          </YStack>
        )}
      </XStack>

      {/* ── Buyer info ── */}
      <SectionDivider />
      <SectionHeader>{String(t("admin.buyer"))}</SectionHeader>
      <YStack gap="$2">
        <DetailRow label={String(t("admin.plBuyerName"))}>
          {row.buyerName || "\u2014"}
        </DetailRow>
        {row.buyerEmail && (
          <DetailRow label={String(t("admin.plBuyerEmail"))}>
            <Text variant="body" style={{ userSelect: "all" }}>
              {row.buyerEmail}
            </Text>
          </DetailRow>
        )}
        <DetailRow label={String(t("admin.plBuyerId"))}>
          <MonoText size={11}>{truncateId(row.buyerHumanId)}</MonoText>
        </DetailRow>
      </YStack>

      {/* ── Event + Org ── */}
      <SectionDivider />
      <SectionHeader>{String(t("admin.plEventInfo"))}</SectionHeader>
      <YStack gap="$2">
        <DetailRow label={String(t("admin.event"))}>
          <Text variant="body" style={{ textAlign: "right", maxWidth: 280 }}>
            {row.eventTitle ?? "Membership" /* i18n: key pending */}
          </Text>
        </DetailRow>
        <DetailRow label={String(t("admin.plOrg"))}>
          {row.orgName || "\u2014"}
        </DetailRow>
        <DetailRow label={String(t("admin.plEventId"))}>
          <MonoText size={11}>{row.eventId ? truncateId(row.eventId) : "\u2014"}</MonoText>
        </DetailRow>
      </YStack>

      {/* ── Financial breakdown ── */}
      <SectionDivider />
      <SectionHeader>{String(t("admin.plFinancials"))}</SectionHeader>
      <YStack gap="$2">
        <DetailRow label={String(t("admin.plTicketSubtotal"))}>
          {fmtCurrency(fmt, ticketSubtotal, row.currency)}
        </DetailRow>
        {discountTotal > 0 && (
          <DetailRow label={String(t("admin.plDiscount"))}>
            <Text variant="body" tone="success">
              &minus;{fmtCurrency(fmt, discountTotal, row.currency)}
            </Text>
          </DetailRow>
        )}
        <DetailRow label={String(t("admin.plGross"))}>
          {fmtCurrency(fmt, row.amountGrossCents, row.currency)}
        </DetailRow>
        <DetailRow label={String(t("admin.platformFee"))}>
          {feeAbsorbed && row.feesPlatformCents > 0 ? (
            // Recorded, but the organiser paid it: not part of the charge.
            <YStack alignItems="flex-end">
              <Text variant="body" tone="muted">
                {fmtCurrency(fmt, row.feesPlatformCents, row.currency)}
              </Text>
              <Text variant="caption" tone="muted">
                {String(t("admin.ttFeeModeAbsorb"))}
              </Text>
            </YStack>
          ) : (
            fmtCurrency(fmt, charges.platformFeeCents, row.currency)
          )}
        </DetailRow>
        {charges.processingFeeCents > 0 && (
          <DetailRow label={String(t("orderDetail.processingFee"))}>
            {fmtCurrency(fmt, charges.processingFeeCents, row.currency)}
          </DetailRow>
        )}
        {row.taxAmountCents > 0 && (
          <DetailRow label={String(t("admin.plTax"))}>
            {fmtCurrency(fmt, row.taxAmountCents, row.currency)}
          </DetailRow>
        )}
        {charges.creditCents < 0 && (
          <DetailRow label={String(t("orderDetail.creditApplied"))}>
            <Text variant="body" tone="success">
              &minus;{fmtCurrency(fmt, -charges.creditCents, row.currency)}
            </Text>
          </DetailRow>
        )}
        <XStack
          justifyContent="space-between"
          paddingTop="$1"
          borderTopWidth={1}
          borderTopColor="$borderColor"
        >
          <Text variant="caption" weight="bold">
            {String(t("admin.plNetCharged"))}
          </Text>
          <Text variant="body" weight="bold">
            {fmtCurrency(fmt, netAmountCents, row.currency)}
          </Text>
        </XStack>
      </YStack>

      {/* ── Settlement / payout status ── */}
      <SectionDivider />
      <SectionHeader>{String(t("admin.plSettlement"))}</SectionHeader>
      <YStack gap="$2">
        <XStack gap="$4" flexWrap="wrap">
          <YStack gap="$1" minWidth={100}>
            <Text variant="caption" tone="muted">
              {String(t("admin.plHeld"))}
            </Text>
            <Text variant="body">
              {fmtCurrency(fmt, heldCents, row.currency)}
            </Text>
          </YStack>
          <YStack gap="$1" minWidth={100}>
            <Text variant="caption" tone="muted">
              {String(t("admin.plItemsPaidOut"))}
            </Text>
            <Text variant="body">
              {fmtCurrency(fmt, paidOutCents, row.currency)} ({paidOutCount}/
              {row.itemCount})
            </Text>
          </YStack>
          {refundedCount > 0 && (
            <YStack gap="$1" minWidth={100}>
              <Text variant="caption" tone="muted">
                {String(t("admin.plItemsRefunded"))}
              </Text>
              <Text variant="body" tone="error">
                {fmtCurrency(fmt, refundedCents, row.currency)} ({refundedCount}
                /{row.itemCount})
              </Text>
            </YStack>
          )}
          {transferredCount > 0 && (
            <YStack gap="$1" minWidth={100}>
              <Text variant="caption" tone="muted">
                {String(t("admin.plTransferred"))}
              </Text>
              <Text variant="body">
                {transferredCount}/{row.itemCount}
              </Text>
            </YStack>
          )}
        </XStack>
      </YStack>

      {/* ── Revenue splits (ADMIN only; gates itself) ── */}
      <OrderSplitsSection
        orderId={row.id}
        currency={row.currency}
        orgId={row.orgId}
        orgName={row.orgName}
        buyerHumanId={row.buyerHumanId}
        buyerName={row.buyerName}
      />

      {/* ── Order items detail ── */}
      {row.items.length > 0 && (
        <>
          <SectionDivider />
          <SectionHeader>
            {String(t("admin.plItemsDetail"))} ({row.items.length})
          </SectionHeader>
          <YStack
            borderWidth={2}
            borderColor="$borderColor"
            borderRadius={0}
            overflow="hidden"
          >
            {/* Table header */}
            <XStack
              paddingHorizontal="$2"
              paddingVertical="$2"
              backgroundColor="$backgroundHover"
              gap="$2"
            >
              <Text
                variant="caption"
                tone="muted"
                style={{ flex: 2.5, fontSize: 10 }}
              >
                {String(t("admin.plItemName"))}
              </Text>
              <Text
                variant="caption"
                tone="muted"
                style={{ flex: 1, fontSize: 10, textAlign: "right" }}
              >
                {String(t("admin.plItemQty"))}
              </Text>
              <Text
                variant="caption"
                tone="muted"
                style={{ flex: 1.2, fontSize: 10, textAlign: "right" }}
              >
                {String(t("admin.plItemUnit"))}
              </Text>
              <Text
                variant="caption"
                tone="muted"
                style={{ flex: 1.2, fontSize: 10, textAlign: "right" }}
              >
                {String(t("admin.plItemTotal"))}
              </Text>
              <Text
                variant="caption"
                tone="muted"
                style={{ flex: 1.2, fontSize: 10, textAlign: "center" }}
              >
                {String(t("admin.status"))}
              </Text>
              <Text
                variant="caption"
                tone="muted"
                style={{ flex: 1.5, fontSize: 10, textAlign: "right" }}
              >
                {String(t("admin.plItemPayout"))}
              </Text>
            </XStack>

            {row.items.map((item) => (
              <YStack key={item.id}>
                <XStack
                  paddingHorizontal="$2"
                  paddingVertical="$2"
                  borderTopWidth={1}
                  borderTopColor="$borderColor"
                  gap="$2"
                  alignItems="center"
                  opacity={item.status === "refunded" ? 0.7 : 1}
                >
                  <YStack style={{ flex: 2.5 }} gap="$1">
                    <Text variant="bodySmall" weight="bold" ellipse>
                      {item.ticketTypeName || item.kind}
                    </Text>
                    {item.ticketCode && (
                      <MonoText size={10}>{item.ticketCode}</MonoText>
                    )}
                  </YStack>
                  <Text
                    variant="bodySmall"
                    style={{ flex: 1, textAlign: "right" }}
                  >
                    {item.qty}
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={{
                      flex: 1.2,
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 11,
                      textAlign: "right",
                    }}
                  >
                    {fmtCurrency(fmt, item.unitPriceCents, row.currency)}
                  </Text>
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    style={{
                      flex: 1.2,
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 11,
                      textAlign: "right",
                      textDecoration:
                        item.status === "refunded" ? "line-through" : undefined,
                    }}
                  >
                    {fmtCurrency(fmt, item.amountCents, row.currency)}
                  </Text>
                  <XStack style={{ flex: 1.2 }} justifyContent="center">
                    <Badge
                      tone={ITEM_STATUS_TONE[item.status] ?? "neutral"}
                      size="sm"
                    >
                      {item.status}
                    </Badge>
                  </XStack>
                  <Text
                    variant="caption"
                    tone="muted"
                    style={{ flex: 1.5, textAlign: "right", fontSize: 10 }}
                  >
                    {item.paidOutAt
                      ? fmtDate(fmt, item.paidOutAt)
                      : item.status === "refunded"
                        ? "\u2014"
                        : String(t("admin.held"))}
                  </Text>
                </XStack>
                {/* Extra ticket metadata row */}
                {(item.seatId ||
                  item.ticketScannedAt ||
                  item.ticketOwnerName) && (
                  <XStack
                    paddingHorizontal="$3"
                    paddingVertical="$1"
                    backgroundColor="$backgroundHover"
                    gap="$4"
                    flexWrap="wrap"
                  >
                    {item.seatId && (
                      <XStack gap="$1" alignItems="center">
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ fontSize: 10 }}
                        >
                          {String(t("admin.plSeat"))}:
                        </Text>
                        <MonoText size={10}>{item.seatId}</MonoText>
                      </XStack>
                    )}
                    {item.ticketScannedAt && (
                      <XStack gap="$1" alignItems="center">
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ fontSize: 10 }}
                        >
                          {String(t("admin.plScanned"))}:
                        </Text>
                        <Text variant="caption" style={{ fontSize: 10 }}>
                          {fmtDate(fmt, item.ticketScannedAt)}
                        </Text>
                      </XStack>
                    )}
                    {item.ticketOwnerName &&
                      item.ticketOwnerName !== row.buyerName && (
                        <XStack gap="$1" alignItems="center">
                          <Text
                            variant="caption"
                            tone="muted"
                            style={{ fontSize: 10 }}
                          >
                            {String(t("admin.plCurrentOwner"))}:
                          </Text>
                          <Text variant="caption" style={{ fontSize: 10 }}>
                            {item.ticketOwnerName}
                          </Text>
                        </XStack>
                      )}
                    {item.refundedAt && (
                      <XStack gap="$1" alignItems="center">
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ fontSize: 10 }}
                        >
                          {String(t("admin.plRefundedOn"))}:
                        </Text>
                        <Text variant="caption" style={{ fontSize: 10 }}>
                          {fmtDate(fmt, item.refundedAt)}
                        </Text>
                      </XStack>
                    )}
                    {item.transferredAt && (
                      <XStack gap="$1" alignItems="center">
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ fontSize: 10 }}
                        >
                          {String(t("admin.plTransferredOn"))}:
                        </Text>
                        <Text variant="caption" style={{ fontSize: 10 }}>
                          {fmtDate(fmt, item.transferredAt)}
                        </Text>
                      </XStack>
                    )}
                  </XStack>
                )}
              </YStack>
            ))}
          </YStack>

          {/* Scan summary */}
          {ticketItems.length > 0 && (
            <XStack gap="$3" flexWrap="wrap" paddingTop="$1">
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.plScanSummary", {
                    scanned: scannedCount,
                    total: ticketItems.length,
                  }),
                )}
              </Text>
            </XStack>
          )}
        </>
      )}

      {/* ── Billing address ── */}
      {billingLine && (
        <>
          <SectionDivider />
          <SectionHeader>{String(t("admin.plBillingAddress"))}</SectionHeader>
          <Text variant="body" style={{ userSelect: "all" }}>
            {billingLine}
          </Text>
        </>
      )}

      {/* ── Fee policy snapshot ── */}
      {snapshot.feeMode && (
        <>
          <SectionDivider />
          <SectionHeader>{String(t("admin.plFeeSnapshot"))}</SectionHeader>
          <YStack gap="$2">
            <DetailRow label={String(t("admin.plFeeMode"))}>
              {snapshot.feeMode}
            </DetailRow>
            {snapshot.buyerFeePct !== undefined && (
              <DetailRow label={String(t("admin.plBuyerFeePct"))}>
                {(snapshot.buyerFeePct * 100).toFixed(2)}%
              </DetailRow>
            )}
            {snapshot.platformFixedCents !== undefined &&
              snapshot.platformFixedCents > 0 && (
                <DetailRow label={String(t("admin.plPlatformFixed"))}>
                  {fmtCurrency(fmt, snapshot.platformFixedCents, row.currency)}
                </DetailRow>
              )}
            {snapshot.processsorFeePct !== undefined && (
              <DetailRow label={String(t("admin.plProcessorRate"))}>
                {(snapshot.processsorFeePct * 100).toFixed(1)}% +{" "}
                {fmtCurrency(
                  fmt,
                  snapshot.processorFixedCents ?? 0,
                  row.currency,
                )}
              </DetailRow>
            )}
            {snapshot.maxFeeCents !== undefined && snapshot.maxFeeCents > 0 && (
              <DetailRow label={String(t("admin.plMaxFee"))}>
                {fmtCurrency(fmt, snapshot.maxFeeCents, row.currency)}
              </DetailRow>
            )}
            {snapshot.minFeeCents !== undefined && snapshot.minFeeCents > 0 && (
              <DetailRow label={String(t("admin.plMinFee"))}>
                {fmtCurrency(fmt, snapshot.minFeeCents, row.currency)}
              </DetailRow>
            )}
            {snapshot.feePolicyId && (
              <XStack gap="$2" alignItems="center">
                <Text variant="caption" tone="muted">
                  {String(t("admin.plFeePolicyId"))}
                </Text>
                <MonoText size={11}>
                  {truncateId(snapshot.feePolicyId)}
                </MonoText>
              </XStack>
            )}
            {snapshot.payoutTermsId && (
              <XStack gap="$2" alignItems="center">
                <Text variant="caption" tone="muted">
                  {String(t("admin.plPayoutTermsId"))}
                </Text>
                <MonoText size={11}>
                  {truncateId(snapshot.payoutTermsId)}
                </MonoText>
              </XStack>
            )}
            {snapshot.computedAt && (
              <DetailRow label={String(t("admin.plFeeComputedAt"))}>
                {new Date(snapshot.computedAt).toLocaleDateString()}
              </DetailRow>
            )}
          </YStack>
        </>
      )}

      {/* ── Stripe references ── */}
      {(row.stripePaymentIntentId || row.stripeTaxCalculationId) && (
        <>
          <SectionDivider />
          <SectionHeader>{String(t("admin.plStripeRefs"))}</SectionHeader>
          <YStack gap="$2">
            {row.stripePaymentIntentId && (
              <XStack gap="$2" alignItems="center">
                <Text variant="caption" tone="muted">
                  Payment Intent
                </Text>
                <MonoText size={11}>{row.stripePaymentIntentId}</MonoText>
              </XStack>
            )}
            {row.stripeTaxCalculationId && (
              <XStack gap="$2" alignItems="center">
                <Text variant="caption" tone="muted">
                  Tax Calculation
                </Text>
                <MonoText size={11}>{row.stripeTaxCalculationId}</MonoText>
              </XStack>
            )}
          </YStack>
        </>
      )}

      {/* ── Actions ── */}
      <SectionDivider />
      <XStack gap="$3" flexWrap="wrap">
        <Button
          variant="secondary"
          size="$2"
          onPress={() => {
            void navigator.clipboard.writeText(row.id);
          }}
        >
          <Copy size={12} />
          {String(t("admin.plCopyId"))}
        </Button>
        <Button
          variant="secondary"
          size="$2"
          onPress={() => {
            void navigator.clipboard.writeText(formatOrderCode(row.id));
          }}
        >
          <Copy size={12} />
          {String(t("admin.plCopyOrderCode"))}
        </Button>
        {row.stripePaymentIntentId && (
          <Button
            variant="secondary"
            size="$2"
            onPress={() => {
              window.open(
                `https://dashboard.stripe.com/payments/${row.stripePaymentIntentId}`,
                "_blank",
              );
            }}
          >
            <ExternalLink size={14} />
            {String(t("admin.plStripe"))}
          </Button>
        )}
      </XStack>
    </YStack>
  );
}
