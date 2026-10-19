"use client";

import React from "react";
import { useTranslations } from "@th/ui";

import { AmountSlider } from "./AmountSlider";
import { DANGER_TEXT, FOREGROUND } from "@/lib/design-tokens";
import {
  MAX_DONATION_AMOUNT_CENTS,
  formatAmountDraft,
  parseAmountDraft,
  payWhatYouWantFloorCents,
  payWhatYouWantSliderMaxCents,
  presetAmountsCents,
  sanitizeAmountDraft,
} from "@/lib/pricing/pay-what-you-want";

// The checkout's type and ink tokens (`checkout-tokens.ts` holds the same
// values). Spelled here so this shared control does not import a route.
const fg = FOREGROUND;
const fgAlpha = (pct: number) =>
  `color-mix(in srgb, ${FOREGROUND} ${pct}%, transparent)`;
const FS_SM = "var(--fs-sm, 13.3px)";
const FS_CAP = "var(--fs-cap, 11.9px)";

/** DOM id of a tier's amount input — the hold guard focuses it on refusal. */
export const donationInputId = (ticketTypeId: string) =>
  `donation-amount-${ticketTypeId}`;

/** Screen-reader-only text: in the accessible name, not on screen. */
const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export type PayWhatYouWantAmountTier = {
  id: string;
  name: string;
  minimumCents?: number | null;
  suggestedCents?: number | null;
};

export type PayWhatYouWantAmountProps = {
  tier: PayWhatYouWantAmountTier;
  /** The committed amount (cents) — what the order will be priced at. */
  valueCents: number;
  onChange: (amountCents: number) => void;
  formatPrice: (cents: number) => string;
  disabled?: boolean;
  /** Show the field's error without waiting for blur (a refused Hold). */
  forceShowError?: boolean;
};

/** DOM test id of a tier's amount slider. */
export const donationSliderTestId = (ticketTypeId: string) =>
  `donation-slider-${ticketTypeId}`;

/**
 * The buyer's amount for one pay-what-you-want tier: the field, the slider,
 * the preset chips, the minimum and the non-refundable note. Shared by the
 * ticket grid, the seat-map path (an ADJUSTABLE tier CAN be linked to a seat
 * section) and the embed, so every buyer names their price the same way.
 *
 * The FIELD is the authority: it takes any amount up to the $10,000 cap, and
 * the hold guard focuses it on refusal. The SLIDER is the box office's
 * (`AmountSlider`): it runs from the floor to `payWhatYouWantSliderMaxCents`
 * and pins at its end for a typed amount above that. Both commit through
 * `onChange`, so the order summary follows either one.
 */
export const PayWhatYouWantAmount = ({
  tier,
  valueCents,
  onChange,
  formatPrice,
  disabled = false,
  forceShowError = false,
}: PayWhatYouWantAmountProps) => {
  const t = useTranslations();
  const minimumCents = payWhatYouWantFloorCents(tier);
  const presets = presetAmountsCents(tier);
  const sliderMaxCents = payWhatYouWantSliderMaxCents(tier);
  const anchorsCents = [minimumCents, tier.suggestedCents ?? null].filter(
    (cents): cents is number => cents != null && cents >= minimumCents,
  );

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 3 }}
    >
      <DonationAmountField
        tier={tier}
        valueCents={valueCents}
        minimumCents={minimumCents}
        disabled={disabled}
        forceShowError={forceShowError}
        onCommit={onChange}
        formatPrice={formatPrice}
      />

      {/* A track that cannot move (floor at the cap) is not a control. */}
      {sliderMaxCents > minimumCents && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <AmountSlider
            valueCents={valueCents}
            floorCents={minimumCents}
            maxCents={sliderMaxCents}
            onChange={onChange}
            // Its own name, tied to the tier ("Set amount for Sliding
            // Scale"), never the field's "Choose your amount for …", and
            // without the word "slider" (the role already says it).
            label={String(t("checkout.pwywSliderFor", { name: tier.name }))}
            valueText={formatPrice(valueCents)}
            magnetAnchorsCents={anchorsCents}
            keyboardCeilingCents={sliderMaxCents}
            disabled={disabled}
            testId={donationSliderTestId(tier.id)}
          />
          {/* The track's ends. Decorative: the slider announces its value. */}
          <div
            aria-hidden
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              fontSize: FS_CAP,
              fontVariantNumeric: "tabular-nums",
              color: fgAlpha(55),
            }}
          >
            <span>{formatPrice(minimumCents)}</span>
            <span>{formatPrice(sliderMaxCents)}</span>
          </div>
        </div>
      )}

      {presets.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {presets.map((amount) => {
            const pressed = valueCents === amount;
            return (
              <button
                key={amount}
                type="button"
                aria-pressed={pressed}
                aria-label={String(
                  t("checkout.pwywPresetFor", {
                    amount: formatPrice(amount),
                    name: tier.name,
                  }),
                )}
                onClick={() => onChange(amount)}
                disabled={disabled}
                style={{
                  padding: "6px 14px",
                  fontSize: FS_SM,
                  fontWeight: pressed ? 700 : 500,
                  border: `1px solid ${pressed ? fg : fgAlpha(15)}`,
                  borderRadius: 0,
                  background: pressed ? fgAlpha(8) : "transparent",
                  color: fg,
                  cursor: disabled ? "default" : "pointer",
                }}
              >
                {formatPrice(amount)}
              </button>
            );
          })}
        </div>
      )}

      {minimumCents > 0 && (
        <p style={{ fontSize: FS_CAP, color: fgAlpha(55), margin: 0 }}>
          {String(t("checkout.pwywMinimum", { amount: formatPrice(minimumCents) }))}
        </p>
      )}

      <p
        style={{
          fontSize: 11,
          color: fgAlpha(45),
          margin: 0,
          fontStyle: "italic",
        }}
      >
        {String(t("checkout.pwywNonRefundable"))}
      </p>
    </div>
  );
};

type DonationAmountFieldProps = {
  tier: PayWhatYouWantAmountTier;
  valueCents: number;
  minimumCents: number;
  disabled: boolean;
  forceShowError: boolean;
  onCommit: (amountCents: number) => void;
  formatPrice: (cents: number) => string;
};

/**
 * The PWYW amount input. The buyer types into a local DRAFT string, and every
 * keystroke that reads as an amount is committed straight away (so the order
 * summary follows along) — but the text is never reformatted under their
 * cursor. It is normalised to two decimals on blur. An empty field commits 0,
 * which the minimum then refuses: what the field shows is what gets priced.
 *
 * A text input (with a decimal keypad), not `type="number"`: a number input
 * reports "" for half-typed values like "12." and cannot be kept in step with
 * a draft.
 */
const DonationAmountField = ({
  tier,
  valueCents,
  minimumCents,
  disabled,
  forceShowError,
  onCommit,
  formatPrice,
}: DonationAmountFieldProps) => {
  const t = useTranslations();
  const [draft, setDraft] = React.useState(() => formatAmountDraft(valueCents));
  const [touched, setTouched] = React.useState(false);

  // Follow a commit that did not come from typing (a preset chip, a resumed
  // hold). A value that already matches the draft is the draft's own commit —
  // leave the text alone so "12." is not snapped to "12.00" mid-keystroke.
  React.useEffect(() => {
    if (parseAmountDraft(draft) !== valueCents) {
      if (draft === "" && valueCents === 0) return;
      setDraft(formatAmountDraft(valueCents));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new committed value may rewrite the draft
  }, [valueCents]);

  const draftCents = parseAmountDraft(draft);
  // Above the cap is shown at once, not on blur: it is never a half-typed
  // amount on its way to a valid one.
  const aboveMaximum = (draftCents ?? 0) > MAX_DONATION_AMOUNT_CENTS;
  const errorText = aboveMaximum
    ? String(
        t("checkout.donationAboveMaximum", {
          max: formatPrice(MAX_DONATION_AMOUNT_CENTS),
        }),
      )
    : draftCents === null && minimumCents > 0
      ? String(t("errors.donationAmountRequired"))
      : (draftCents ?? 0) < minimumCents
        ? String(t("errors.donationBelowMinimum"))
        : null;
  const showError =
    errorText !== null && (aboveMaximum || touched || forceShowError);
  const inputId = donationInputId(tier.id);
  const errorId = `${inputId}-error`;

  return (
    <>
      <label
        htmlFor={inputId}
        style={{
          fontSize: FS_CAP,
          fontWeight: 600,
          color: fgAlpha(70),
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {String(t("checkout.pwywChooseAmount"))}
        {/* The tier name completes the accessible name ("Choose your amount
            for Pay What You Want") so two PWYW tiers never announce two
            identical fields. Visually the row's own heading already says it. */}
        <span style={visuallyHidden}>
          {" "}
          {String(t("checkout.pwywAmountForTier", { name: tier.name }))}
        </span>
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ fontSize: 16, fontWeight: 700, color: fg }}>
          $
        </span>
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={draft}
          onChange={(e) => {
            const next = sanitizeAmountDraft(e.target.value);
            if (next === null) return;
            setDraft(next);
            onCommit(parseAmountDraft(next) ?? 0);
          }}
          onBlur={() => {
            setTouched(true);
            const cents = parseAmountDraft(draft);
            if (cents !== null) setDraft(formatAmountDraft(cents));
          }}
          disabled={disabled}
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
          style={{
            width: 110,
            padding: "8px 12px",
            fontSize: 16,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            border: `2px solid ${showError ? DANGER_TEXT : fgAlpha(15)}`,
            borderRadius: 0,
            background: "transparent",
            color: fg,
          }}
        />
      </div>
      {showError && (
        <p
          id={errorId}
          role="alert"
          style={{
            fontSize: FS_SM,
            fontWeight: 600,
            color: DANGER_TEXT,
            margin: 0,
          }}
        >
          {errorText}
        </p>
      )}
    </>
  );
};
