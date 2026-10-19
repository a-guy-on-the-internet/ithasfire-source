"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { YStack, XStack } from "tamagui";
import {
  Modal,
  Button,
  Text,
  TextInput,
  AmountInput,
  StyledSelect,
  Checkbox,
  FormErrorBanner,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";
import { parsePercentInputToBasisPoints } from "@/lib/money/parse-percent-input";
import {
  DateTimeLocalInput,
  isDateTimeFieldIncomplete,
  useIncompleteField,
} from "@/components/forms/DateTimeLocalInput";

// ── ISO ↔ datetime-local string helpers ─────────────────────────────────────
// Native <input type="datetime-local"> works in YYYY-MM-DDTHH:mm. We keep
// using it because every browser ships a polished native picker (calendar
// + time wheel on mobile, dropdown on desktop) — better than rolling our
// own and a11y-correct out of the box.

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ── Dollars ↔ cents helpers ─────────────────────────────────────────────────
// We store cents in state for parity with the API, but render dollar fields
// to admins so "in cents" footguns disappear (5000 = $50, not $5000).

function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null || cents === 0) return "";
  return (cents / 100).toFixed(2);
}

// ── Input sanitizers ─────────────────────────────────────────────────────────
// We keep these fields as type="text" + inputMode (mobile numeric keypad) and
// enforce numeric content in JS. `type="number"` is deliberately NOT used:
// React-Native-Web's TextInput re-derives `type` from `inputMode` on every
// commit, which fights the imperative `type` patch and resets the caret to 0
// (typing "12.34" comes out "43.21"). Filtering keystrokes rejects free-form
// text on every platform without that footgun.

/** Digits only — for integer count fields (e.g. max redemptions). */
function sanitizeIntegerInput(input: string): string {
  return input.replace(/[^0-9]/g, "");
}

/**
 * Keystroke filter for the amount / percent fields.
 *
 * DELIBERATELY PERMISSIVE. Its predecessor stripped everything but digits and
 * `.`, which destroyed information AT KEYSTROKE TIME: an `es` organiser typing
 * `15,50` for a fixed-amount promo watched the field become `1550` and saved a
 * **$1,550 discount**. No single keystroke rule can serve both typists —
 * swallowing `,` breaks es, treating `,` as a decimal breaks an en typist's
 * `1,500` — so the field now keeps what was typed and the SUBMIT adjudicates
 * it with the shared money/percent parsers, which refuse anything they cannot
 * read with certainty instead of guessing.
 *
 * Whitespace is kept for the same reason: swallowing it turns `15 50` into
 * `1550` (a 100x overcharge), whereas keeping it lets the parser refuse.
 * `-` is kept so a negative is visibly refused rather than silently flipped
 * positive. Everything else — letters, currency symbols — is still dropped,
 * so the field keeps behaving like a number field.
 */
function sanitizeAmountInput(input: string): string {
  return input.replace(/[^0-9.,\s-]/g, "");
}

// ── Submit-time field resolution ─────────────────────────────────────────────
// Pure, exported, and unit-tested (`__tests__/promo-numeric-fields.test.ts`).
// Every numeric field in this dialog goes through one of these, so the inline
// error the organiser sees and the number that reaches the mutation are
// derived from the SAME read — there is no second, laxer parse at submit.

/**
 * Three-way, because "blank" is not the reader's decision to make:
 *   value → the number to submit (cents for money, whole percent for PERCENT)
 *   blank → the field was empty; the CALLER decides what empty means
 *   error → unreadable/ambiguous/negative; SHOW `messageKey` AND REFUSE
 */
export type PromoNumericField =
  | { kind: "value"; value: number }
  | { kind: "blank" }
  | { kind: "error"; messageKey: string };

/**
 * An optional dollar field (min order, max discount) in cents.
 *
 * Blank stays blank — the caller maps it to "no minimum" / "no cap". Anything
 * unreadable is an ERROR, never `null`: the old converter coerced a typo to
 * `null`, which silently meant "no minimum" / "no cap" — a second silent
 * failure hiding behind the first.
 */
export function resolvePromoMoneyField(raw: string): PromoNumericField {
  const parsed = parseMoneyInputToCents(raw);
  if (parsed.ok) return { kind: "value", value: parsed.cents };
  if (parsed.reason === "empty") return { kind: "blank" };
  return {
    kind: "error",
    messageKey:
      parsed.reason === "ambiguous"
        ? "admin.cpAmountAmbiguous"
        : "admin.cpAmountInvalid",
  };
}

/**
 * The DUAL-PURPOSE `value` field: dollars when the promo is AMOUNT, percent
 * when it is PERCENT. Required either way, so blank is an error here.
 *
 * PERCENT submits a WHOLE percent — the wire contract is
 * `z.number().int().min(1)` and settlement computes `subtotal * value / 100` —
 * so `20.5` is refused rather than rounded. Rounding a percent silently moves
 * money, which is the whole bug class this replaces.
 */
export function resolvePromoValueField(
  raw: string,
  promoKind: "PERCENT" | "AMOUNT",
): PromoNumericField {
  if (promoKind === "AMOUNT") {
    const parsed = parseMoneyInputToCents(raw);
    if (!parsed.ok) {
      return {
        kind: "error",
        messageKey:
          parsed.reason === "empty"
            ? "admin.cpValueRequired"
            : parsed.reason === "ambiguous"
              ? "admin.cpAmountAmbiguous"
              : "admin.cpAmountInvalid",
      };
    }
    // The wire rejects 0; a $0 discount is not a discount.
    if (parsed.cents === 0) {
      return { kind: "error", messageKey: "admin.cpValuePositive" };
    }
    return { kind: "value", value: parsed.cents };
  }

  const parsed = parsePercentInputToBasisPoints(raw);
  if (!parsed.ok) {
    return {
      kind: "error",
      messageKey:
        parsed.reason === "empty"
          ? "admin.cpValueRequired"
          : parsed.reason === "ambiguous"
            ? "admin.cpAmountAmbiguous"
            : parsed.reason === "out_of_range"
              ? "admin.cpValuePercentRange"
              : // `invalid` / `negative`: the input was unreadable or signed,
                // which has nothing to do with whole-vs-fractional. Telling a
                // organiser who typed `-20` to "use a whole number" sends them
                // looking for the wrong mistake. `cpValuePercentWhole` is
                // reserved for the genuine fractional case below.
                "admin.cpAmountInvalid",
    };
  }
  if (parsed.basisPoints === 0) {
    return { kind: "error", messageKey: "admin.cpValuePositive" };
  }
  if (parsed.basisPoints % 100 !== 0) {
    return { kind: "error", messageKey: "admin.cpValuePercentWhole" };
  }
  return { kind: "value", value: parsed.basisPoints / 100 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PromoRow {
  id: string;
  code: string;
  kind: "PERCENT" | "AMOUNT";
  value: number;
  scope: string;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  totalRedemptions: number;
  stackable: boolean;
  isPublic: boolean;
  minOrderCents: number;
  maxDiscountCents: number | null;
  createdAt: Date;
}

export interface PromoFormDialogProps {
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
  editingPromo: PromoRow | null;
  onClose: () => void;
  onSuccess: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small layout helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Section divider + heading — "Discount", "Eligibility", etc. Lets the form
 * read as four short stacks instead of a tall ungrouped list. */
function SectionHeader({ label }: { label: string }) {
  return (
    <XStack alignItems="center" gap="$2">
      <Text
        variant="label"
        tone="muted"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 700,
          fontSize: 11,
        }}
      >
        {label}
      </Text>
      <YStack flex={1} height={1} backgroundColor="$borderColor" />
    </XStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PromoFormDialog({
  ownerType,
  ownerId,
  editingPromo,
  onClose,
  onSuccess,
}: PromoFormDialogProps) {
  const isEdit = editingPromo !== null;
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();

  // Stable ids so labels can `htmlFor` and helper text can `aria-describedby`
  // — was missing entirely.
  const idPrefix = useId();
  const codeId = `${idPrefix}-code`;
  const valueId = `${idPrefix}-value`;
  const startsAtId = `${idPrefix}-starts`;
  const endsAtId = `${idPrefix}-ends`;
  const maxRedemptionsId = `${idPrefix}-max-redemptions`;
  const minOrderId = `${idPrefix}-min-order`;
  const maxDiscountId = `${idPrefix}-max-discount`;

  // ── Form state ────────────────────────────────────────────────────
  const [code, setCode] = useState(editingPromo?.code ?? "");
  const [kind, setKind] = useState<"PERCENT" | "AMOUNT">(
    editingPromo?.kind ?? "PERCENT",
  );
  // Value is rendered in user units: percent (e.g. "20") or dollars (e.g. "5.00").
  // Server still receives cents for AMOUNT — converted at submit.
  const [value, setValue] = useState(() => {
    if (!editingPromo) return "";
    return editingPromo.kind === "AMOUNT"
      ? (editingPromo.value / 100).toFixed(2)
      : String(editingPromo.value);
  });
  const [maxRedemptions, setMaxRedemptions] = useState(
    editingPromo?.maxRedemptions != null
      ? String(editingPromo.maxRedemptions)
      : "",
  );
  const [minOrderDollars, setMinOrderDollars] = useState(
    centsToDollarsInput(editingPromo?.minOrderCents),
  );
  const [maxDiscountDollars, setMaxDiscountDollars] = useState(
    centsToDollarsInput(editingPromo?.maxDiscountCents),
  );
  const [stackable, setStackable] = useState(editingPromo?.stackable ?? false);
  const [isPublic, setIsPublic] = useState(editingPromo?.isPublic ?? false);
  const [startsAt, setStartsAt] = useState<string | undefined>(
    editingPromo?.startsAt ? editingPromo.startsAt.toISOString() : undefined,
  );
  const [endsAt, setEndsAt] = useState<string | undefined>(
    editingPromo?.endsAt ? editingPromo.endsAt.toISOString() : undefined,
  );
  // "Starts immediately" / "No expiry" toggles disable the picker. Empty
  // state implies these by default; the toggles make the affordance
  // explicit so users don't wonder whether the placeholder was real.
  const [startsImmediately, setStartsImmediately] = useState(
    !editingPromo?.startsAt,
  );
  const [hasNoExpiry, setHasNoExpiry] = useState(!editingPromo?.endsAt);
  // A half-typed date reads as "" (Chrome fires no input event until every
  // segment is filled), which would save as "no start" / "no expiry". A
  // disabled field (its toggle is on) never blocks.
  const startsField = useIncompleteField();
  const endsField = useIncompleteField();
  const { refuse: refuseStarts } = startsField;
  const { refuse: refuseEnds } = endsField;
  const startsAtRef = useRef<HTMLInputElement>(null);
  const endsAtRef = useRef<HTMLInputElement>(null);
  const startsIncomplete = startsField.incomplete && !startsImmediately;
  const endsIncomplete = endsField.incomplete && !hasNoExpiry;
  const showStartsIncomplete = startsField.shown && !startsImmediately;
  const showEndsIncomplete = endsField.shown && !hasNoExpiry;

  // Dirty-state tracking: a snapshot of every initial value, compared at
  // cancel time so an accidental click doesn't drop in-progress work.
  const initialSnapshot = useMemo(
    () => ({
      code: editingPromo?.code ?? "",
      kind: editingPromo?.kind ?? "PERCENT",
      value: editingPromo
        ? editingPromo.kind === "AMOUNT"
          ? (editingPromo.value / 100).toFixed(2)
          : String(editingPromo.value)
        : "",
      maxRedemptions:
        editingPromo?.maxRedemptions != null
          ? String(editingPromo.maxRedemptions)
          : "",
      minOrderDollars: centsToDollarsInput(editingPromo?.minOrderCents),
      maxDiscountDollars: centsToDollarsInput(editingPromo?.maxDiscountCents),
      stackable: editingPromo?.stackable ?? false,
      isPublic: editingPromo?.isPublic ?? false,
      startsAt: editingPromo?.startsAt
        ? editingPromo.startsAt.toISOString()
        : "",
      endsAt: editingPromo?.endsAt ? editingPromo.endsAt.toISOString() : "",
      startsImmediately: !editingPromo?.startsAt,
      hasNoExpiry: !editingPromo?.endsAt,
    }),
    [editingPromo],
  );

  const isDirty =
    code !== initialSnapshot.code ||
    kind !== initialSnapshot.kind ||
    value !== initialSnapshot.value ||
    maxRedemptions !== initialSnapshot.maxRedemptions ||
    minOrderDollars !== initialSnapshot.minOrderDollars ||
    maxDiscountDollars !== initialSnapshot.maxDiscountDollars ||
    stackable !== initialSnapshot.stackable ||
    isPublic !== initialSnapshot.isPublic ||
    (startsAt ?? "") !== initialSnapshot.startsAt ||
    (endsAt ?? "") !== initialSnapshot.endsAt ||
    startsImmediately !== initialSnapshot.startsImmediately ||
    hasNoExpiry !== initialSnapshot.hasNoExpiry;

  const kindOptions = useMemo(
    () => [
      { value: "PERCENT" as const, label: String(t("admin.cpPercent")) },
      { value: "AMOUNT" as const, label: String(t("admin.cpFixed")) },
    ],
    [t],
  );

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = trpc.promos.create.useMutation({
    onSuccess: () => {
      toast.success(String(t("admin.cpCreated")));
      onSuccess();
    },
    onError: (err) => setError(err),
  });

  const updateMutation = trpc.promos.update.useMutation({
    onSuccess: () => {
      toast.success(String(t("admin.cpUpdated")));
      onSuccess();
    },
    onError: (err) => setError(err),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  // ── Validation ────────────────────────────────────────────────────
  const trimmedCode = code.trim();
  const codeError = useMemo(() => {
    if (!trimmedCode)
      return String(t("admin.cpCodeRequired") ?? "Code is required.");
    if (trimmedCode.length > 64)
      return String(t("admin.cpCodeTooLong") ?? "Max 64 characters.");
    if (!/^[A-Z0-9_-]+$/.test(trimmedCode)) {
      return String(
        t("admin.cpCodeFormat") ??
          "Use letters, numbers, dashes, or underscores only.",
      );
    }
    return null;
  }, [trimmedCode, t]);

  // Each numeric field is read ONCE, here, and both the inline error and the
  // submitted number come off that single read.
  const valueField = useMemo(
    () => resolvePromoValueField(value, kind),
    [value, kind],
  );
  const minOrderField = useMemo(
    () => resolvePromoMoneyField(minOrderDollars),
    [minOrderDollars],
  );
  // The cap is only SENT for PERCENT promos (AMOUNT submits null and the input
  // is disabled + cleared on switch), so it must not be able to block a submit
  // that discards it — that would refuse over a field the organiser can't edit.
  //
  // A cap of exactly 0 is its own case. `0 ?? undefined` is `0`, not undefined,
  // so it would reach the wire — where `maxDiscountCents` is `.int().min(1)` —
  // and come back as a raw server error in the banner. In a dialog whose whole
  // point is that blank / 0 / unreadable are three different things, "$0 cap"
  // deserves the same inline answer as a $0 discount: blank means no cap, 0
  // means no discount is ever possible.
  const maxDiscountField = useMemo<PromoNumericField>(() => {
    if (kind !== "PERCENT") return { kind: "blank" };
    const field = resolvePromoMoneyField(maxDiscountDollars);
    if (field.kind === "value" && field.value === 0) {
      return { kind: "error", messageKey: "admin.cpMaxDiscountPositive" };
    }
    return field;
  }, [kind, maxDiscountDollars]);

  const valueError =
    valueField.kind === "error" ? String(t(valueField.messageKey)) : null;
  const minOrderError =
    minOrderField.kind === "error" ? String(t(minOrderField.messageKey)) : null;
  const maxDiscountError =
    maxDiscountField.kind === "error"
      ? String(t(maxDiscountField.messageKey))
      : null;

  const dateError = useMemo(() => {
    if (startsImmediately || hasNoExpiry) return null;
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      return String(
        t("admin.cpEndsBeforeStarts") ?? "End must be after start.",
      );
    }
    return null;
  }, [startsAt, endsAt, startsImmediately, hasNoExpiry, t]);

  const isValid =
    !codeError &&
    !valueError &&
    !minOrderError &&
    !maxDiscountError &&
    !dateError &&
    !startsIncomplete &&
    !endsIncomplete;

  // ── Submit ────────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    if (!isValid) return;
    // Re-read the fields: a half-typed date must never save as "no date".
    const startsNow =
      !startsImmediately &&
      startsAtRef.current !== null &&
      isDateTimeFieldIncomplete(startsAtRef.current);
    const endsNow =
      !hasNoExpiry &&
      endsAtRef.current !== null &&
      isDateTimeFieldIncomplete(endsAtRef.current);
    if (startsNow || endsNow) {
      refuseStarts(startsNow);
      refuseEnds(endsNow);
      return;
    }
    // Belt and braces: `isValid` already gates the button, but a refusal must
    // NEVER be able to fall through to a mutation with a coerced number.
    if (
      valueField.kind !== "value" ||
      minOrderField.kind === "error" ||
      maxDiscountField.kind === "error"
    ) {
      return;
    }
    clearAll();

    // PERCENT is a whole percent, AMOUNT is cents — resolved above, once.
    const valueAtRest = valueField.value;

    const parsedMaxRedemptions = maxRedemptions
      ? parseInt(maxRedemptions, 10)
      : null;
    // Blank still means "no minimum" / "no cap". What changed is that an
    // UNREADABLE value no longer collapses into that same null: it is refused
    // above, so a typo can't silently become "no cap".
    const minOrderCents =
      minOrderField.kind === "value" ? minOrderField.value : null;
    const maxDiscountCents =
      maxDiscountField.kind === "value" ? maxDiscountField.value : null;

    const shared = {
      kind,
      value: valueAtRest,
      stackable,
      isPublic,
    };

    if (isEdit && editingPromo) {
      updateMutation.mutate({
        ownerType,
        ownerId,
        promoId: editingPromo.id,
        code: trimmedCode,
        ...shared,
        startsAt: startsImmediately ? null : (startsAt ?? null),
        endsAt: hasNoExpiry ? null : (endsAt ?? null),
        maxRedemptions: parsedMaxRedemptions,
        minOrderCents: minOrderCents ?? 0,
        maxDiscountCents,
      });
    } else {
      createMutation.mutate({
        ownerType,
        ownerId,
        code: trimmedCode,
        ...shared,
        startsAt: startsImmediately ? undefined : (startsAt ?? undefined),
        endsAt: hasNoExpiry ? undefined : (endsAt ?? undefined),
        maxRedemptions: parsedMaxRedemptions ?? undefined,
        minOrderCents: minOrderCents ?? undefined,
        maxDiscountCents: maxDiscountCents ?? undefined,
      });
    }
  }, [
    isValid,
    isEdit,
    editingPromo,
    ownerType,
    ownerId,
    trimmedCode,
    kind,
    stackable,
    isPublic,
    startsAt,
    endsAt,
    startsImmediately,
    hasNoExpiry,
    maxRedemptions,
    valueField,
    minOrderField,
    maxDiscountField,
    createMutation,
    updateMutation,
    clearAll,
    refuseStarts,
    refuseEnds,
  ]);

  // ── Cancel guard ──────────────────────────────────────────────────
  // Confirm before discarding in-progress edits. If the form is pristine
  // (just opened, nothing typed) cancel is silent. window.confirm is
  // pragmatic here — Modal-on-Modal would feel heavy and the dirty edge
  // case is rare enough to not warrant a custom dialog.
  const handleClose = useCallback(() => {
    if (isPending) return;
    if (isDirty) {
      const confirmed = window.confirm(
        String(
          t("admin.cpDiscardConfirm") ??
            "Discard changes? Anything you typed will be lost.",
        ),
      );
      if (!confirmed) return;
    }
    onClose();
  }, [isDirty, isPending, onClose, t]);

  // ── Render ────────────────────────────────────────────────────────
  const showFieldError = (msg: string | null, id: string) =>
    msg ? (
      <Text id={`${id}-error`} variant="bodySmall" color="$red10">
        {msg}
      </Text>
    ) : null;

  return (
    <Modal open onClose={handleClose}>
      <Modal.Panel width={560}>
        <Modal.Header
          title={String(
            isEdit ? t("admin.cpEditPromo") : t("admin.cpCreatePromo"),
          )}
          onClose={handleClose}
        />
        <Modal.Body>
          {/* Tightened from gap="$3" — eight rows × 4px = ~32px reclaimed. */}
          <YStack gap="$2">
            <FormErrorBanner message={formError} onDismiss={clearAll} />

            {/* Identity ───────────────────────────────────────── */}
            <YStack gap="$1">
              <Text tag="label" variant="label" htmlFor={codeId}>
                {String(t("admin.cpCodeLabel"))}
              </Text>
              <TextInput
                id={codeId}
                placeholder="SUMMER2026"
                value={code}
                // Uppercase via CSS keeps caret position stable; hard-cast
                // to upper at submit so the wire format is canonical.
                onChangeText={setCode}
                autoFocus={!isEdit}
                maxLength={64}
                fullWidth
                disabled={isEdit}
                aria-invalid={codeError ? true : undefined}
                aria-describedby={codeError ? `${codeId}-error` : undefined}
                {...({ style: { textTransform: "uppercase" } } as Record<
                  string,
                  unknown
                >)}
              />
              {isEdit ? (
                <Text variant="bodySmall" tone="muted">
                  {String(t("admin.cpCodeReadonly"))}
                </Text>
              ) : (
                showFieldError(codeError, codeId)
              )}
            </YStack>

            {/* Discount ───────────────────────────────────────── */}
            <SectionHeader
              label={String(t("admin.cpSectionDiscount") ?? "Discount")}
            />
            <XStack gap="$3">
              <YStack flex={1} gap="$1">
                <Text variant="label">{String(t("admin.cpTypeLabel"))}</Text>
                <StyledSelect
                  options={kindOptions}
                  value={kind}
                  onChange={(v) => {
                    const next = v as "PERCENT" | "AMOUNT";
                    // Clear cap when leaving PERCENT — was silently
                    // preserved before and could submit a stale cents
                    // value with an AMOUNT promo.
                    if (next !== "PERCENT") setMaxDiscountDollars("");
                    // Reset value because units change (percent ↔ dollars).
                    setValue("");
                    setKind(next);
                  }}
                  fullWidth
                />
              </YStack>
              <YStack flex={1} gap="$1">
                <Text tag="label" variant="label" htmlFor={valueId}>
                  {String(t("admin.cpValueLabel"))}
                </Text>
                <AmountInput
                  id={valueId}
                  prefix={kind === "AMOUNT" ? "$" : undefined}
                  suffix={kind === "PERCENT" ? "%" : undefined}
                  placeholder={kind === "PERCENT" ? "20" : "5.00"}
                  value={value}
                  // Same permissive filter for both units — `12,5` has to
                  // survive the keystroke so the submit can tell the
                  // organiser it isn't a whole percent, rather than the old
                  // digits-only filter turning it into 125%.
                  onChangeText={(v) => setValue(sanitizeAmountInput(v))}
                  inputMode={kind === "PERCENT" ? "numeric" : "decimal"}
                  fullWidth
                  aria-invalid={valueError ? true : undefined}
                  aria-describedby={
                    valueError ? `${valueId}-error` : undefined
                  }
                />
                {showFieldError(valueError, valueId)}
              </YStack>
            </XStack>

            {/* Reserve the slot so type-toggle doesn't make the form
						    leap. Disabled when the field doesn't apply. */}
            <YStack gap="$1" opacity={kind === "PERCENT" ? 1 : 0.4}>
              <Text tag="label" variant="label" htmlFor={maxDiscountId}>
                {String(t("admin.cpMaxDiscount"))}
              </Text>
              <AmountInput
                id={maxDiscountId}
                prefix="$"
                placeholder={String(t("admin.cpNoLimit"))}
                value={maxDiscountDollars}
                onChangeText={(v) =>
                  setMaxDiscountDollars(sanitizeAmountInput(v))
                }
                inputMode="decimal"
                fullWidth
                disabled={kind !== "PERCENT"}
                aria-invalid={maxDiscountError ? true : undefined}
                aria-describedby={
                  maxDiscountError ? `${maxDiscountId}-error` : undefined
                }
              />
              {showFieldError(maxDiscountError, maxDiscountId)}
              <Text variant="bodySmall" tone="muted">
                {String(
                  t("admin.cpMaxDiscountHintDollars") ??
                    "Cap the discount amount for percent promos.",
                )}
              </Text>
            </YStack>

            {/* Eligibility ────────────────────────────────────── */}
            <SectionHeader
              label={String(t("admin.cpSectionEligibility") ?? "Eligibility")}
            />
            <YStack gap="$1">
              <Text tag="label" variant="label" htmlFor={minOrderId}>
                {String(t("admin.cpMinOrder"))}
              </Text>
              <AmountInput
                id={minOrderId}
                prefix="$"
                placeholder="0.00"
                value={minOrderDollars}
                onChangeText={(v) => setMinOrderDollars(sanitizeAmountInput(v))}
                inputMode="decimal"
                fullWidth
                aria-invalid={minOrderError ? true : undefined}
                aria-describedby={
                  minOrderError ? `${minOrderId}-error` : undefined
                }
              />
              {showFieldError(minOrderError, minOrderId)}
            </YStack>
            <Checkbox
              label={String(t("admin.cpStackable"))}
              description={String(t("admin.cpStackableHint"))}
              checked={stackable}
              onCheckedChange={(v) => setStackable(v === true)}
            />
            <Checkbox
              label={
                String(t("admin.cpPublicCode") ?? "Public code") as string
              }
              description={
                String(
                  t("admin.cpPublicCodeHint") ??
                    "Public codes can be auto-applied from shareable URLs (e.g. ?p=CODE). Leave off for comp/employee codes you don't want exposed.",
                ) as string
              }
              checked={isPublic}
              onCheckedChange={(v) => setIsPublic(v === true)}
            />

            {/* Schedule ───────────────────────────────────────── */}
            <SectionHeader
              label={String(t("admin.cpSectionSchedule") ?? "Schedule")}
            />
            <XStack gap="$3">
              <YStack flex={1} gap="$1" minWidth={0}>
                <Text tag="label" variant="label" htmlFor={startsAtId}>
                  {String(t("admin.cpStartsAt"))}
                </Text>
                <DateTimeLocalInput
                  ref={startsAtRef}
                  id={startsAtId}
                  type="datetime-local"
                  variant="boxed"
                  value={startsImmediately ? "" : isoToLocalInput(startsAt)}
                  onChange={(e) =>
                    setStartsAt(localInputToIso(e.target.value) ?? "")
                  }
                  onIncompleteChange={startsField.onIncompleteChange}
                  disabled={startsImmediately}
                  aria-invalid={showStartsIncomplete ? true : undefined}
                  aria-describedby={
                    showStartsIncomplete ? `${startsAtId}-incomplete` : undefined
                  }
                  data-testid="promo-starts-at"
                />
                {showStartsIncomplete ? (
                  <Text
                    id={`${startsAtId}-incomplete`}
                    variant="bodySmall"
                    color="$red10"
                    role="alert"
                  >
                    {String(t("common.dateTimeStartIncomplete"))}
                  </Text>
                ) : null}
                <Checkbox
                  label={String(
                    t("admin.cpStartsImmediately") ?? "Start immediately",
                  )}
                  checked={startsImmediately}
                  onCheckedChange={(v) => setStartsImmediately(v === true)}
                />
              </YStack>
              <YStack flex={1} gap="$1" minWidth={0}>
                <Text tag="label" variant="label" htmlFor={endsAtId}>
                  {String(t("admin.cpEndsAt"))}
                </Text>
                <DateTimeLocalInput
                  ref={endsAtRef}
                  id={endsAtId}
                  type="datetime-local"
                  variant="boxed"
                  value={hasNoExpiry ? "" : isoToLocalInput(endsAt)}
                  onChange={(e) =>
                    setEndsAt(localInputToIso(e.target.value) ?? "")
                  }
                  onIncompleteChange={endsField.onIncompleteChange}
                  disabled={hasNoExpiry}
                  {...(startsAt && !startsImmediately
                    ? { min: isoToLocalInput(startsAt) }
                    : {})}
                  aria-invalid={dateError || showEndsIncomplete ? true : undefined}
                  aria-describedby={
                    [
                      dateError ? `${endsAtId}-error` : null,
                      showEndsIncomplete ? `${endsAtId}-incomplete` : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  data-testid="promo-ends-at"
                />
                {showEndsIncomplete ? (
                  <Text
                    id={`${endsAtId}-incomplete`}
                    variant="bodySmall"
                    color="$red10"
                    role="alert"
                  >
                    {String(t("common.dateTimeEndIncomplete"))}
                  </Text>
                ) : null}
                <Checkbox
                  label={String(t("admin.cpNoExpiry") ?? "No expiry")}
                  checked={hasNoExpiry}
                  onCheckedChange={(v) => setHasNoExpiry(v === true)}
                />
                {showFieldError(dateError, endsAtId)}
              </YStack>
            </XStack>

            {/* Limits ─────────────────────────────────────────── */}
            <SectionHeader
              label={String(t("admin.cpSectionLimits") ?? "Limits")}
            />
            <YStack gap="$1">
              <Text tag="label" variant="label" htmlFor={maxRedemptionsId}>
                {String(t("admin.cpMaxRedemptions"))}
              </Text>
              <TextInput
                id={maxRedemptionsId}
                placeholder={String(t("admin.cpUnlimited"))}
                value={maxRedemptions}
                onChangeText={(v) => setMaxRedemptions(sanitizeIntegerInput(v))}
                inputMode="numeric"
                fullWidth
              />
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={handleClose} disabled={isPending}>
            {String(t("admin.cancel"))}
          </Button>
          <Button
            variant="primary"
            onPress={handleSubmit}
            disabled={!isValid || isPending}
          >
            {isPending
              ? String(t("admin.cpSaving"))
              : isEdit
                ? String(t("admin.cpSave"))
                : String(t("admin.cpCreatePromo"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
