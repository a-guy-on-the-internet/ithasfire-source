"use client";

import { MultiChipGroup, Reveal } from "@th/ui";
import { PAYMENT_LABELS } from "../_shared/labels";
import { INPUT_STYLE, MAX } from "../_shared/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// PaymentMethodChips — multi-select with conditional OTHER freeform
// ─────────────────────────────────────────────────────────────────────────────

interface PaymentMethodChipsProps {
  values: string[];
  onChange: (vs: string[]) => void;
  otherValue: string;
  onOtherChange: (v: string) => void;
  detail: string;
  onDetailChange: (v: string) => void;
  error?: boolean;
}

export function PaymentMethodChips({
  values,
  onChange,
  otherValue,
  onOtherChange,
  detail,
  onDetailChange,
  error,
}: PaymentMethodChipsProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <MultiChipGroup
        options={Object.entries(PAYMENT_LABELS).map(([key, label]) => ({
          key,
          label,
        }))}
        value={values}
        onChange={onChange}
        fillContainer
        detail={detail}
        onDetailChange={onDetailChange}
        detailPlaceholder="e.g. $200 guarantee + 50% door…"
        error={error}
      />
      <Reveal show={values.includes("OTHER")}>
        <div style={{ paddingTop: 4 }}>
          <input
            type="text"
            aria-label="Other payment method description"
            value={otherValue}
            onChange={(e) => onOtherChange(e.target.value)}
            placeholder="Describe the payment arrangement…"
            maxLength={MAX.DETAIL}
            enterKeyHint="done"
            autoComplete="off"
            style={INPUT_STYLE}
          />
        </div>
      </Reveal>
    </div>
  );
}
