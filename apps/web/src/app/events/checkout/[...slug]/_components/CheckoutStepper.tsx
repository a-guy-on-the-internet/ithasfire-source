"use client";

import { Check } from "lucide-react";
import { useTranslations } from "@th/ui";
import {
  FG as fg,
  BG as bg,
  FG_MUTED as fgMuted,
  fgAlpha,
  labelIdiomStyle,
  FS_MONO_SM,
  TR_MONO_SM,
  FONT_MONO,
} from "./checkout-tokens";
import type { StepperPayment } from "./confirmed-payment";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────


export type CheckoutStepId = "tickets" | "details" | "payment" | "confirmed";

type StepDef = {
  id: CheckoutStepId;
  labelKey: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STEPS: StepDef[] = [
  { id: "tickets", labelKey: "checkout.stepTickets" },
  { id: "details", labelKey: "checkout.stepDetails" },
  { id: "payment", labelKey: "checkout.stepPayment" },
  { id: "confirmed", labelKey: "checkout.stepConfirmed" },
];

/** Marker edge. Under the 44px touch minimum on purpose — see HIT_SIZE. */
const MARKER_SIZE = 32;
/**
 * The tap target wrapping each marker. The marker is the thing you see; this
 * is the thing you hit. Completed steps are real buttons, so they need the
 * full 44px even though a 32px square is the right visual weight in the row.
 */
const HIT_SIZE = 44;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export type CheckoutStepperProps = {
  currentStepId: CheckoutStepId;
  completedStepIds: CheckoutStepId[];
  /** Callback when a user clicks on a completed or past step indicator. */
  onStepClick?: (stepId: CheckoutStepId) => void;
  /**
   * No step is clickable — set once payment is confirming or confirmed.
   * Going "back" from there would release a paid order's hold (refused by
   * the server, and the buyer was dropped back to selection).
   */
  backNavigationLocked?: boolean;
  /**
   * Whether the confirmed step's money moved (see `StepperPayment`). Step 4
   * reads "Confirmed" only when paid: "Payment processing" for a bank debit
   * still clearing, "Not confirmed" when nothing says the money moved,
   * "Checking payment" while a restored confirmation is read (owner,
   * 2026-10-14). The ticket checkout always passes it (`stepperPayment`).
   * Left out, step 4 reads "Confirmed": today only the embed's steppers
   * (EmbedCheckout, EmbedConfirmation, EmbedEventDetail) omit it, and their
   * processing state is outside this prop.
   */
  payment?: StepperPayment;
  "aria-label"?: string;
};

/**
 * Where you are in checkout, as a state indicator rather than a decorative
 * strip.
 *
 * Three states, each encoded in FORM and not just weight, because this has to
 * be read in a hurry on a phone in a venue queue:
 *
 *   current   — solid ink fill, page-coloured numeral. The loudest mark in the
 *               row, and the only one that reads as "here".
 *   completed — 2px ink rule and a check. Tappable: it is the way back.
 *   remaining — hairline and muted. Present, quiet, not a target.
 *
 * The per-step labels are gone. Four names at the mono label rung do not fit
 * 320px, and shrinking them to 10px sans — below the smallest rung the system
 * has — is what made the old strip read as decoration. The current step is
 * named once, below the row, beside a plain count.
 *
 * Theme-aware via checkout-tokens, so it renders correctly in both the web
 * checkout and the embed's forced-light palette.
 */
export const CheckoutStepper = ({
  currentStepId,
  completedStepIds,
  onStepClick,
  backNavigationLocked = false,
  payment,
  "aria-label": ariaLabel,
}: CheckoutStepperProps) => {
  const t = useTranslations();
  const currentIdx = STEPS.findIndex((s) => s.id === currentStepId);
  const currentLabel = String(
    t(
      currentStepId === "confirmed" && payment === "processing"
        ? "checkout.stepPaymentProcessing"
        : currentStepId === "confirmed" && payment === "unknown"
          ? "checkout.stepPaymentUnconfirmed"
          : currentStepId === "confirmed" && payment === "checking"
            ? "checkout.stepPaymentChecking"
            : (STEPS[currentIdx]?.labelKey ?? ""),
    ),
  );

  return (
    // A plain wrapper. `progressbar` lives on the count line below, NOT here:
    // its children are presentational, so wrapping the marker row in it took
    // the way-back buttons ("Go back to Tickets") out of the accessibility
    // tree entirely.
    <div style={{ padding: "12px 16px" }}>
      {/* Marker row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {STEPS.map((step, idx) => {
          const isCurrent = step.id === currentStepId;
          const isDone = completedStepIds.includes(step.id) || idx < currentIdx;
          const isClickable =
            Boolean(onStepClick) && !backNavigationLocked && isDone && !isCurrent;
          const stepName = String(t(step.labelKey));

          const markerStyle: React.CSSProperties = isCurrent
            ? { background: fg, color: bg, border: `2px solid ${fg}` }
            : isDone
              ? { background: "transparent", color: fg, border: `2px solid ${fg}` }
              : {
                  background: "transparent",
                  // Quiet by FORM — no fill, hairline rule — not by dimming the
                  // numeral until it cannot be read. Ink at 35% measured
                  // 2.41:1 on cream, under even the 3:1 non-text floor, and the
                  // design system reserves faint for disabled and decorative
                  // marks only. `FG_MUTED` is 7.1:1 and still reads clearly
                  // quieter than the completed steps' full ink.
                  color: fgMuted,
                  // --color-border-hair, rgba(33,28,22,.18).
                  border: `1px solid ${fgAlpha(18)}`,
                };

          const marker = (
            <span
              aria-hidden
              style={{
                display: "flex",
                height: MARKER_SIZE,
                width: MARKER_SIZE,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 0,
                fontFamily: FONT_MONO,
                fontSize: FS_MONO_SM,
                letterSpacing: TR_MONO_SM,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                ...markerStyle,
              }}
            >
              {isDone && !isCurrent ? (
                <Check size={14} strokeWidth={3} />
              ) : (
                idx + 1
              )}
            </span>
          );

          const hitBox: React.CSSProperties = {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: MARKER_SIZE,
            height: HIT_SIZE,
            flexShrink: 0,
          };

          return isClickable ? (
            <button
              key={step.id}
              type="button"
              data-testid={`checkout-step-${step.id}`}
              onClick={() => onStepClick!(step.id)}
              aria-label={String(
                t("checkout.stepGoBack", { step: stepName }),
              )}
              style={{
                all: "unset",
                ...hitBox,
                cursor: "pointer",
                boxSizing: "border-box",
              }}
            >
              {marker}
            </button>
          ) : (
            <div
              key={step.id}
              data-testid={`checkout-step-${step.id}`}
              data-current={isCurrent ? "true" : undefined}
              style={hitBox}
            >
              {marker}
            </div>
          );
        })}
      </div>

      {/* Count + the current step's name. One mono line at the label rung —
          the count is the "where am I" a glance actually needs, and naming
          only the current step keeps it legible at 320px. */}
      <p
        role="progressbar"
        aria-label={
          ariaLabel ??
          String(
            t("checkout.stepperProgressLabel", {
              current: currentIdx + 1,
              total: STEPS.length,
            }),
          )
        }
        aria-valuenow={currentIdx + 1}
        aria-valuemin={1}
        aria-valuemax={STEPS.length}
        // The current step is announced HERE ("2 / 4 — Details"): the
        // markers are aria-hidden squares, so an `aria-current` on one had
        // nothing for assistive tech to read.
        aria-valuetext={String(
          t("checkout.stepperProgressValue", {
            current: currentIdx + 1,
            total: STEPS.length,
            step: currentLabel,
          }),
        )}
        style={{
          ...labelIdiomStyle,
          margin: "2px 0 0",
          // The count is the "where am I" a glance needs, so it takes muted
          // (7.1:1) rather than an alpha that lands at ~4.6 — the system routes
          // all informational meta to muted, and faint is not for this.
          color: fgMuted,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {String(
            t("checkout.stepProgress", {
              current: currentIdx + 1,
              total: STEPS.length,
            }),
          )}
        </span>
        {/* Both halves are mono uppercase at the same rung, so a weight change
            alone ran them together — measured, "STEP 1 OF 4 TICKETS" read as
            one string. The rule separates them. */}
        <span aria-hidden style={{ color: fgMuted }}>
          /
        </span>
        <span style={{ color: fg, fontWeight: 700 }}>{currentLabel}</span>
      </p>
    </div>
  );
};
