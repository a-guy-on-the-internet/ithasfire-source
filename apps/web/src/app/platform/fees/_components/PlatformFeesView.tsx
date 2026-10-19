"use client";

import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";
import { YStack, XStack, styled } from "tamagui";
import { Text, Spinner, Separator, useTranslations } from "@th/ui";
import {
  Percent,
  DollarSign,
  TrendingUp,
  ShieldCheck,
  Lock,
  FileCode2,
  AlertTriangle,
} from "lucide-react";

import { trpc } from "@/trpc";
import { formatCurrency } from "@/lib/format";

import { FeeProjectionChart, type ProjectionPoint } from "./FeeProjectionChart";
import {
  computePassThrough,
  type FeePreviewPolicy,
} from "./fee-preview-math";

/**
 * `/platform/fees` — READ-ONLY.
 *
 * The global fee policy is declared in code (`PLATFORM_FEE_POLICY`) and the
 * Postgres row is reconciled on every deploy, so there is deliberately no
 * write path here: no mutation, no Save, no "request a change" form. The only
 * interactive controls on the page are the two what-if inputs, which are
 * local component state and change nothing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Where the policy actually comes from. Rendered verbatim on the page so a
// staff member who lands here can find the file without asking anyone.
// ─────────────────────────────────────────────────────────────────────────────

const POLICY_SOURCE_CONSTANT = "PLATFORM_FEE_POLICY";
const POLICY_SOURCE_PATH =
  "packages/core/src/lib/pricing/platform-fee-policy.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives (matches platform settings card patterns)
// ─────────────────────────────────────────────────────────────────────────────

const StatCard = styled(YStack, {
  name: "FeeStatCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
  borderLeftWidth: 3,
  borderLeftColor: "$accent",
  padding: "$4",
  gap: "$2",
  minWidth: 0,
});

const SectionCard = styled(YStack, {
  name: "FeeSectionCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
  padding: "$5",
  gap: "$4",
});

const FieldGroup = styled(YStack, {
  name: "FieldGroup",
  gap: "$2",
  minWidth: 0,
});

const InputLabel = styled(Text, {
  name: "InputLabel",
  variant: "caption",
  weight: "semibold",
  color: "$color",
});

const HintText = styled(Text, {
  name: "HintText",
  variant: "caption",
  color: "$colorMuted",
  fontSize: 12,
});

/**
 * Every collection on this page is a GRID with an auto-fill track, never a
 * media-query column count. `min(Xpx, 100%)` rather than a bare `Xpx` floor
 * because the platform shell's 256px rail means the content box is NOT a
 * function of viewport width — a bare floor overflows the moment the
 * container is narrower than it, which is exactly what happened at 320px.
 */
const gridStyle = (minTrackPx: number, gapPx: number): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(auto-fill, minmax(min(${minTrackPx}px, 100%), 1fr))`,
  gap: gapPx,
  width: "100%",
  alignItems: "start",
});

/** Stat cards are equal-height siblings, so this one track stretches. */
const STAT_GRID_STYLE: CSSProperties = {
  ...gridStyle(180, 16),
  alignItems: "stretch",
};
const POLICY_GRID_STYLE = gridStyle(190, 20);
const COMPARE_GRID_STYLE = gridStyle(260, 24);
const CONTROL_GRID_STYLE = gridStyle(180, 16);

const TABULAR: CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** A 60-char file path must never be the thing that widens the page at 320px. */
const BREAK_ANYWHERE: CSSProperties = { overflowWrap: "anywhere" };

/** An icon beside wrapping text is a flex item and WILL be squeezed to 0. */
const ICON: CSSProperties = { flexShrink: 0 };

/**
 * Plain DOM `<input type="number">`, not the `@th/ui` TextInput: the RNW text
 * input reverses typed characters under `type="number"`. These two fields are
 * the only interactive controls left on the page.
 */
const INPUT_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 180,
  padding: "8px 12px",
  borderRadius: 0,
  border: "1px solid var(--borderColor, #211C16)",
  backgroundColor: "var(--background, #F6F0E4)",
  color: "var(--color, #211C16)",
  fontFamily: "inherit",
  fontSize: 14,
  fontVariantNumeric: "tabular-nums",
  minHeight: 44,
};

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** `0.0333 → "3.33%"`, `0.029 → "2.9%"`. Trailing zeros dropped. */
function formatPct(fraction: number): string {
  return `${Number((fraction * 100).toFixed(4))}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PlatformFeesView() {
  const t = useTranslations();

  // The page's ONLY state: two local what-if knobs. Nothing here is persisted.
  const [ticketPrice, setTicketPrice] = useState("4000"); // cents
  const [monthlySales, setMonthlySales] = useState("500");

  const policyQuery = trpc.platform.getGlobalFeePolicy.useQuery(
    {},
    { staleTime: 30_000 },
  );
  const policy = policyQuery.data?.policy ?? null;

  const previewPolicy: FeePreviewPolicy = useMemo(
    () => ({
      buyerFeePct: policy?.buyerFeePct ?? 0,
      maxFeeCents: policy?.maxFeeCents ?? null,
      minFeeCents: policy?.minFeeCents ?? 0,
      platformFixedCents: policy?.platformFixedCents ?? 0,
      processorFeePct: policy?.processsorFeePct ?? 0,
      processorFixedCents: policy?.processorFixedCents ?? 0,
    }),
    [policy],
  );

  const unitPrice = parseInt(ticketPrice, 10) || 0;
  const monthlyCount = parseInt(monthlySales, 10) || 0;

  const passThroughPreview = useMemo(
    () => computePassThrough(unitPrice, previewPolicy),
    [unitPrice, previewPolicy],
  );

  const monthlyRevenue = passThroughPreview.platformFee * monthlyCount;
  const annualRevenue = monthlyRevenue * 12;

  const projectionData: ProjectionPoint[] = useMemo(() => {
    const ticketPrices = [
      1000, 2500, 4000, 5000, 7500, 10000, 15000, 20000, 25000,
    ];
    return ticketPrices.map((price) => {
      const pt = computePassThrough(price, previewPolicy);
      return {
        ticketPrice: price,
        platformFee: pt.platformFee,
        processorFee: pt.processorFee,
        monthlyRevenue: pt.platformFee * monthlyCount,
        passThroughBuyerTotal: pt.buyerTotal,
      };
    });
  }, [previewPolicy, monthlyCount]);

  const examplePrices = useMemo(() => {
    return [100, 500].map((price) => ({
      price,
      passThrough: computePassThrough(price, previewPolicy),
    }));
  }, [previewPolicy]);

  // ── Loading / error / empty ──────────────────────────────────────────
  if (policyQuery.isLoading) {
    return (
      <CenteredState>
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.feesLoading"))}
        </Text>
      </CenteredState>
    );
  }

  if (policyQuery.isError) {
    return (
      <CenteredState>
        <AlertTriangle size={24} color="var(--danger, #B91C1C)" style={ICON} />
        <Text variant="h4" weight="bold">
          {String(t("admin.feesLoadError"))}
        </Text>
      </CenteredState>
    );
  }

  if (!policy) {
    // The GLOBAL row is materialized by the deploy-time reconciler, so this is
    // reachable on a fresh database that has not run it yet.
    return (
      <CenteredState>
        <FileCode2 size={24} color="var(--colorMuted, #5C544A)" style={ICON} />
        <Text variant="h4" weight="bold">
          {String(t("admin.feesEmptyTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={520}>
          {String(t("admin.feesEmptyBody"))}
        </Text>
        <SourceOfTruth label={String(t("admin.feesCodeDefinedSourceLabel"))} />
      </CenteredState>
    );
  }

  // ── Derived display values ───────────────────────────────────────────
  const capLabel =
    policy.maxFeeCents == null
      ? String(t("admin.feesNoCap"))
      : formatCurrency(policy.maxFeeCents);
  const orderCapLabel =
    policy.maxPlatformFeeCents == null
      ? String(t("admin.feesNoCap"))
      : formatCurrency(policy.maxPlatformFeeCents);

  /**
   * The live formula, spelled out with the live numbers substituted in. A $0
   * ticket pays no fee (owner ruling 2026-10-10), which the fixed part and
   * the floor would otherwise contradict, so the formula says it.
   */
  const formula =
    `face > 0 ? ` +
    `max( min( round(face × ${formatPct(policy.buyerFeePct)}), ` +
    `${policy.maxFeeCents == null ? "∞" : formatCurrency(policy.maxFeeCents)} )` +
    ` + ${formatCurrency(policy.platformFixedCents)},` +
    ` ${formatCurrency(policy.minFeeCents)} )` +
    ` : ${formatCurrency(0)}`;

  const ticketPriceLabel = `${String(t("admin.feesTicketPrice"))} (${String(t("admin.feesCentsUnit"))})`;

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <YStack padding="$5" gap="$5" maxWidth={960}>
      {/* Header */}
      <YStack gap="$2">
        <XStack alignItems="center" gap="$2">
          <ShieldCheck size={20} color="var(--accent, #E2481D)" style={ICON} />
          <Text variant="h2" tag="h1" weight="bold">
            {String(t("admin.feesTitle"))}
          </Text>
        </XStack>
        <Text variant="body" tone="muted">
          {String(t("admin.feesDescription"))}
        </Text>
      </YStack>

      {/* Stat cards */}
      <div style={STAT_GRID_STYLE}>
        <StatCard>
          <XStack alignItems="center" gap="$2">
            <Percent size={16} color="var(--accent, #E2481D)" style={ICON} />
            <Text variant="caption" tone="muted">
              {String(t("admin.feesPlatformFee"))}
            </Text>
          </XStack>
          <Text variant="h3" weight="bold" style={TABULAR}>
            {formatPct(policy.buyerFeePct)}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.feesMaxFeeCents"))}: {capLabel}
          </Text>
        </StatCard>

        <StatCard>
          <XStack alignItems="center" gap="$2">
            <DollarSign size={16} color="var(--accent, #E2481D)" style={ICON} />
            <Text variant="caption" tone="muted">
              {String(t("admin.feesPerTicket"))}
            </Text>
          </XStack>
          <Text variant="h3" weight="bold" style={TABULAR}>
            {formatCurrency(passThroughPreview.platformFee)}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.feesOnTicketOf"))} {formatCurrency(unitPrice)}
          </Text>
        </StatCard>

        <StatCard>
          <XStack alignItems="center" gap="$2">
            <TrendingUp size={16} color="var(--accent, #E2481D)" style={ICON} />
            <Text variant="caption" tone="muted">
              {String(t("admin.feesMonthlyRevenue"))}
            </Text>
          </XStack>
          <Text variant="h3" weight="bold" style={TABULAR}>
            {formatCurrency(monthlyRevenue)}
          </Text>
          <Text variant="caption" tone="muted" style={TABULAR}>
            {monthlyCount} {String(t("admin.feesTicketsPerMonth"))}
          </Text>
        </StatCard>

        <StatCard>
          <XStack alignItems="center" gap="$2">
            <TrendingUp size={16} color="var(--accent, #E2481D)" style={ICON} />
            <Text variant="caption" tone="muted">
              {String(t("admin.feesAnnualRevenue"))}
            </Text>
          </XStack>
          <Text variant="h3" weight="bold" style={TABULAR}>
            {formatCurrency(annualRevenue)}
          </Text>
        </StatCard>
      </div>

      {/* ── Effective policy (read-only) ──────────────────────────────── */}
      <SectionCard>
        <Text variant="h4" weight="bold">
          {String(t("admin.feesDefaultPolicy"))}
        </Text>

        {/* Why there is no Save button */}
        <YStack
          backgroundColor="$surfaceMuted"
          borderWidth={1}
          borderColor="$borderColorSoft"
          borderRadius={0}
          padding="$3"
          gap="$2"
        >
          <XStack alignItems="center" gap="$2">
            <FileCode2 size={14} color="var(--colorMuted, #5C544A)" style={ICON} />
            <Text variant="overline" tone="muted">
              {String(t("admin.feesCodeDefinedTitle"))}
            </Text>
          </XStack>
          <Text variant="bodySmall">
            {String(t("admin.feesCodeDefinedBody"))}
          </Text>
          <SourceOfTruth label={String(t("admin.feesCodeDefinedSourceLabel"))} />
        </YStack>

        <HintText>{String(t("admin.feesDefaultPolicyHint"))}</HintText>

        <div style={POLICY_GRID_STYLE}>
          <PolicyValue
            label={String(t("admin.feesBuyerFeePct"))}
            value={formatPct(policy.buyerFeePct)}
            hint={String(t("admin.feesBuyerFeePctHint"))}
          />
          <PolicyValue
            label={String(t("admin.feesMaxFeeCents"))}
            value={capLabel}
            muted={policy.maxFeeCents == null}
            hint={String(t("admin.feesMaxFeeCentsHint"))}
          />
          <PolicyValue
            label={String(t("admin.feesMinFeeCents"))}
            value={formatCurrency(policy.minFeeCents)}
            hint={String(t("admin.feesMinFeeCentsHint"))}
          />
          <PolicyValue
            label={String(t("admin.feesPlatformFixedCents"))}
            value={formatCurrency(policy.platformFixedCents)}
            hint={String(t("admin.feesPlatformFixedCentsHint"))}
          />
          <PolicyValue
            label={String(t("admin.feesMaxPlatformFeeCents"))}
            value={orderCapLabel}
            muted={policy.maxPlatformFeeCents == null}
            hint={String(t("admin.feesMaxPlatformFeeCentsHint"))}
          />
        </div>

        <YStack gap="$1">
          <Text variant="overline" tone="muted">
            {String(t("admin.feesFormulaLabel"))}
          </Text>
          <Text variant="code" fontSize={12} tone="muted">
            {formula}
          </Text>
        </YStack>

        <Separator />

        {/* Processor rates */}
        <YStack gap="$1">
          <XStack alignItems="center" gap="$2">
            <Lock size={14} color="var(--colorMuted, #5C544A)" style={ICON} />
            <Text variant="overline" tone="muted">
              {String(t("admin.feesProcessorRates"))}
            </Text>
          </XStack>
          <HintText>{String(t("admin.feesProcessorRatesReadonly"))}</HintText>
        </YStack>

        <div style={POLICY_GRID_STYLE}>
          <PolicyValue
            label={String(t("admin.feesProcessorFeePct"))}
            value={formatPct(policy.processsorFeePct)}
            hint={String(t("admin.feesProcessorFeePctHint"))}
          />
          <PolicyValue
            label={String(t("admin.feesProcessorFixedCents"))}
            value={formatCurrency(policy.processorFixedCents)}
            hint={String(t("admin.feesProcessorFixedCentsHint"))}
          />
        </div>

        <Separator />

        <Text variant="caption" tone="muted" style={TABULAR}>
          {String(t("admin.feesPolicyVersion"))} {policy.version}
        </Text>
      </SectionCard>

      {/* ── What-if controls ──────────────────────────────────────────── */}
      <SectionCard>
        <YStack gap="$1">
          <Text variant="h4" weight="bold">
            {String(t("admin.feesPreviewControls"))}
          </Text>
          <HintText>{String(t("admin.feesProjectionInputsNote"))}</HintText>
        </YStack>

        <div style={CONTROL_GRID_STYLE}>
          <FieldGroup>
            <InputLabel>{ticketPriceLabel}</InputLabel>
            <input
              type="number"
              min="0"
              step="100"
              aria-label={ticketPriceLabel}
              value={ticketPrice}
              onChange={(e) => setTicketPrice(e.target.value)}
              style={INPUT_STYLE}
            />
            <HintText style={TABULAR}>= {formatCurrency(unitPrice)}</HintText>
          </FieldGroup>

          <FieldGroup>
            <InputLabel>{String(t("admin.feesMonthlySales"))}</InputLabel>
            <input
              type="number"
              min="0"
              step="50"
              aria-label={String(t("admin.feesMonthlySales"))}
              value={monthlySales}
              onChange={(e) => setMonthlySales(e.target.value)}
              style={INPUT_STYLE}
            />
            <HintText style={TABULAR}>
              {monthlyCount} {String(t("admin.feesTicketsPerMonth"))}
            </HintText>
          </FieldGroup>
        </div>
      </SectionCard>

      {/* ── Fee breakdown for one ticket ─────────────────────── */}
      <SectionCard>
        <Text variant="h4" weight="bold">
          {String(t("admin.feesModeComparison"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("admin.feesModeComparisonHint"))}
        </Text>

        <div style={COMPARE_GRID_STYLE}>
          {/* Pass-through column */}
          <YStack gap="$3" minWidth={0}>
            <ModeHeading
              backgroundColor="$brandSecondaryHover"
              label={String(t("admin.feesPassThroughLabel"))}
            />
            <Text variant="caption" tone="muted">
              {String(t("admin.feesPassThroughDesc"))}
            </Text>

            <YStack gap="$2">
              <Row
                label={String(t("admin.feesTicketPrice"))}
                value={formatCurrency(unitPrice)}
              />
              <Row
                label={String(t("admin.feesPlatformFee"))}
                value={formatCurrency(passThroughPreview.platformFee)}
                bold
              />
              <Row
                label={String(t("admin.feesProcessorFee"))}
                value={formatCurrency(passThroughPreview.processorFee)}
                muted
              />
              <Separator />
              <Row
                label={String(t("admin.feesBuyerTotal"))}
                value={formatCurrency(passThroughPreview.buyerTotal)}
                bold
              />
              <Row
                label={String(t("admin.feesOrganiserNet"))}
                value={formatCurrency(passThroughPreview.organiserNet)}
              />
            </YStack>
          </YStack>
        </div>
      </SectionCard>

      {/* ── Fixed-price examples: $1 and $5 tickets ───────────────────── */}
      <SectionCard>
        <Text variant="h4" weight="bold">
          {String(t("admin.feesExamplesTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("admin.feesExamplesHint"))}
        </Text>

        <div style={COMPARE_GRID_STYLE}>
          {examplePrices.map(({ price, passThrough }) => (
            <YStack key={price} gap="$3" minWidth={0}>
              {/* surfaceMuted, NOT backgroundStrong: on Stub the latter is the
                  ink value, so ink-on-ink rendered this band unreadable. */}
              <XStack
                backgroundColor="$surfaceMuted"
                borderWidth={1}
                borderColor="$borderColorSoft"
                paddingHorizontal="$3"
                paddingVertical="$2"
                borderRadius={0}
                alignItems="center"
                gap="$2"
              >
                <Text variant="caption" weight="bold" color="$color">
                  {formatCurrency(price)} {String(t("admin.feesExampleTicket"))}
                </Text>
              </XStack>

              <YStack gap="$1" paddingLeft="$2">
                <Text variant="caption" weight="bold" color="$color">
                  {String(t("admin.feesPassThroughLabel"))}
                </Text>
                <Row
                  label={String(t("admin.feesPlatformFee"))}
                  value={formatCurrency(passThrough.platformFee)}
                  bold
                />
                <Row
                  label={String(t("admin.feesProcessorFee"))}
                  value={formatCurrency(passThrough.processorFee)}
                  muted
                />
                <Row
                  label={String(t("admin.feesBuyerTotal"))}
                  value={formatCurrency(passThrough.buyerTotal)}
                  bold
                />
                <Row
                  label={String(t("admin.feesOrganiserNet"))}
                  value={formatCurrency(passThrough.organiserNet)}
                />
              </YStack>
            </YStack>
          ))}
        </div>
      </SectionCard>

      {/* ── Revenue projection ────────────────────────────────────────── */}
      <SectionCard>
        <YStack gap="$2">
          <Text variant="h4" weight="bold">
            {String(t("admin.feesProjection"))}
          </Text>
          <Text variant="body" tone="muted">
            {String(t("admin.feesProjectionHint"))}
          </Text>
        </YStack>

        <FeeProjectionChart data={projectionData} />
      </SectionCard>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Local pieces
// ─────────────────────────────────────────────────────────────────────────────

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <YStack
      padding="$5"
      gap="$3"
      alignItems="center"
      justifyContent="center"
      minHeight={300}
    >
      {children}
    </YStack>
  );
}

/** The constant + file path, in code type, selectable so it can be copied. */
function SourceOfTruth({ label }: { label: string }) {
  return (
    <YStack gap="$1" minWidth={0}>
      <Text variant="caption" tone="muted" fontSize={12}>
        {label}
      </Text>
      <Text variant="code" fontSize={12} style={BREAK_ANYWHERE}>
        {POLICY_SOURCE_CONSTANT}
      </Text>
      <Text variant="code" fontSize={12} tone="muted" style={BREAK_ANYWHERE}>
        {POLICY_SOURCE_PATH}
      </Text>
    </YStack>
  );
}

/**
 * One policy field: uppercase label, the value, the explanation. A labelled
 * value rather than a `disabled` input — the value is data, not a form field,
 * and a disabled control would drop out of the tab order and render at
 * reduced opacity, i.e. unreachable and under-contrast for no gain.
 */
function PolicyValue({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <YStack gap="$1" minWidth={0}>
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      <Text
        variant="h5"
        weight="bold"
        tone={muted ? "muted" : "default"}
        textTransform="none"
        style={TABULAR}
      >
        {value}
      </Text>
      {hint ? (
        <Text variant="caption" tone="muted" fontSize={12}>
          {hint}
        </Text>
      ) : null}
    </YStack>
  );
}

function ModeHeading({
  backgroundColor,
  label,
}: {
  backgroundColor: string;
  label: string;
}) {
  return (
    <XStack
      backgroundColor={backgroundColor}
      paddingHorizontal="$3"
      paddingVertical="$2"
      borderRadius={0}
      alignItems="center"
      gap="$2"
    >
      <Text variant="caption" weight="bold" tone="inverted">
        {label}
      </Text>
    </XStack>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <XStack justifyContent="space-between" gap="$2" paddingVertical="$1">
      <Text variant="body" tone={muted ? "muted" : "default"} flexShrink={1}>
        {label}
      </Text>
      <Text
        variant="body"
        weight={bold ? "bold" : "regular"}
        tone={muted ? "muted" : "default"}
        flexShrink={0}
        style={TABULAR}
      >
        {value}
      </Text>
    </XStack>
  );
}
