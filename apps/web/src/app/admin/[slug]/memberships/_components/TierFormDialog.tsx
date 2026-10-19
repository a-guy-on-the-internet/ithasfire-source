"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Modal,
  Button,
  Text,
  TextInput,
  AmountInput,
  StyledSelect,
  FormErrorBanner,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";

import type { TierRow, TierInterval } from "./tier-row";

// ─────────────────────────────────────────────────────────────────────────────
// Create / edit a membership tier.
//
// Field editability mirrors the server locks so the owner discovers them here,
// not on submit (core: update-membership-tier.ts):
//   - price     → locked once `priceLocked` (ever had a member OR Stripe Price
//                 minted). MEMBERSHIP_TIER_PRICE_LOCKED server-side.
//   - interval  → create-only; the update schema has no interval field at all.
//
// There is deliberately NO tax-category control. It used to sit here as "What
// does this tier deliver?", it could never change a rate (the lookup takes only
// postal code + country), and it locked itself permanently once the tier had
// live members. `benefitsDescription` — the owner's own claim about what
// members get — takes its place. No deductibility language: a membership is
// not a donation (AB 488).
//
// Price entry follows the promo-dialog money pattern: text field +
// inputMode="decimal", permissive keystroke filter, and ONE submit-time read
// through `parseMoneyInputToCents`, which refuses ambiguous input ("1,500")
// instead of guessing — the same footgun class as the $1,550-promo bug.
// ─────────────────────────────────────────────────────────────────────────────

/** Keeps digits, separators, sign and whitespace; the parser adjudicates. */
function sanitizeAmountInput(input: string): string {
  return input.replace(/[^0-9.,\s-]/g, "");
}

function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null || cents === 0) return "";
  return (cents / 100).toFixed(2);
}

/** Wire cap on priceCents (create/update schemas: `.max(100_000_00)`). */
const MAX_PRICE_CENTS = 100_000_00;

type PriceField =
  | { kind: "value"; cents: number }
  | { kind: "error"; messageKey: string };

export function resolveTierPriceField(raw: string): PriceField {
  const parsed = parseMoneyInputToCents(raw);
  if (!parsed.ok) {
    return {
      kind: "error",
      messageKey:
        parsed.reason === "empty"
          ? "adminMemberships.priceRequired"
          : parsed.reason === "ambiguous"
            ? "adminMemberships.priceAmbiguous"
            : "adminMemberships.priceInvalid",
    };
  }
  if (parsed.cents === 0) {
    return { kind: "error", messageKey: "adminMemberships.pricePositive" };
  }
  if (parsed.cents > MAX_PRICE_CENTS) {
    return { kind: "error", messageKey: "adminMemberships.priceTooHigh" };
  }
  return { kind: "value", cents: parsed.cents };
}

export interface TierFormDialogProps {
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
  editingTier: TierRow | null;
  onClose: () => void;
  onSuccess: () => void;
}

export function TierFormDialog({
  ownerType,
  ownerId,
  editingTier,
  onClose,
  onSuccess,
}: TierFormDialogProps) {
  const isEdit = editingTier !== null;
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();

  const idPrefix = useId();
  const nameId = `${idPrefix}-name`;
  const descriptionId = `${idPrefix}-description`;
  const benefitsDescriptionId = `${idPrefix}-benefits-description`;
  const priceId = `${idPrefix}-price`;

  // ── Locks (mirror the server; server still enforces) ──────────────────
  const priceLocked = isEdit && editingTier.priceLocked;

  // ── Form state ────────────────────────────────────────────────────────
  const [name, setName] = useState(editingTier?.name ?? "");
  const [description, setDescription] = useState(
    editingTier?.description ?? "",
  );
  const [benefitsDescription, setBenefitsDescription] = useState(
    editingTier?.benefitsDescription ?? "",
  );
  const [price, setPrice] = useState(
    centsToDollarsInput(editingTier?.priceCents),
  );
  const [interval, setBillingInterval] = useState<TierInterval>(
    editingTier?.interval ?? "MONTH",
  );

  const isDirty =
    name !== (editingTier?.name ?? "") ||
    description !== (editingTier?.description ?? "") ||
    benefitsDescription !== (editingTier?.benefitsDescription ?? "") ||
    price !== centsToDollarsInput(editingTier?.priceCents) ||
    interval !== (editingTier?.interval ?? "MONTH");

  const intervalOptions = useMemo(
    () => [
      {
        value: "MONTH" as const,
        label: String(t("adminMemberships.intervalMonth")),
      },
      {
        value: "YEAR" as const,
        label: String(t("adminMemberships.intervalYear")),
      },
    ],
    [t],
  );

  // ── Mutations ─────────────────────────────────────────────────────────
  const createMutation = trpc.memberships.tiers.create.useMutation({
    onSuccess: () => {
      toast.success(String(t("adminMemberships.created")));
      onSuccess();
    },
    onError: (err) => setError(err),
  });
  const updateMutation = trpc.memberships.tiers.update.useMutation({
    onSuccess: () => {
      toast.success(String(t("adminMemberships.updated")));
      onSuccess();
    },
    onError: (err) => setError(err),
  });
  const isPending = createMutation.isPending || updateMutation.isPending;

  // ── Validation (single read per field) ────────────────────────────────
  const trimmedName = name.trim();
  const nameError = !trimmedName
    ? String(t("adminMemberships.nameRequired"))
    : null;

  // A locked price is not re-read: the disabled input keeps the stored value
  // and the update mutation simply never sends priceCents.
  const priceField = useMemo<PriceField>(
    () =>
      priceLocked
        ? { kind: "value", cents: editingTier?.priceCents ?? 0 }
        : resolveTierPriceField(price),
    [price, priceLocked, editingTier?.priceCents],
  );
  const priceError =
    priceField.kind === "error" ? String(t(priceField.messageKey)) : null;

  const isValid = !nameError && !priceError;

  // ── Submit ────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    if (!isValid || priceField.kind !== "value") return;
    clearAll();

    const trimmedDescription = description.trim();
    const trimmedBenefits = benefitsDescription.trim();

    if (isEdit && editingTier) {
      updateMutation.mutate({
        tierId: editingTier.id,
        name: trimmedName,
        description: trimmedDescription === "" ? null : trimmedDescription,
        benefitsDescription: trimmedBenefits === "" ? null : trimmedBenefits,
        // Only send fields the server would accept — a locked price is omitted
        // entirely rather than echoed (echoing an unchanged value is legal, but
        // omitting keeps the audit log's `changed` map honest).
        ...(priceLocked || priceField.cents === editingTier.priceCents
          ? {}
          : { priceCents: priceField.cents }),
      });
    } else {
      createMutation.mutate({
        ...(ownerType === "ORGANIZATION"
          ? { ownerOrgId: ownerId }
          : { ownerHumanId: ownerId }),
        name: trimmedName,
        ...(trimmedDescription === ""
          ? {}
          : { description: trimmedDescription }),
        ...(trimmedBenefits === ""
          ? {}
          : { benefitsDescription: trimmedBenefits }),
        priceCents: priceField.cents,
        currency: "usd",
        interval,
      });
    }
  }, [
    isValid,
    priceField,
    clearAll,
    description,
    benefitsDescription,
    isEdit,
    editingTier,
    updateMutation,
    trimmedName,
    priceLocked,
    createMutation,
    ownerType,
    ownerId,
    interval,
  ]);

  // ── Cancel guard ──────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (isPending) return;
    if (isDirty) {
      const confirmed = window.confirm(
        String(t("adminMemberships.discardConfirm")),
      );
      if (!confirmed) return;
    }
    onClose();
  }, [isDirty, isPending, onClose, t]);

  const showFieldError = (msg: string | null, id: string) =>
    msg ? (
      <Text id={`${id}-error`} variant="bodySmall" color="$red10">
        {msg}
      </Text>
    ) : null;

  return (
    <Modal open onClose={handleClose}>
      <Modal.Panel width={520}>
        <Modal.Header
          title={String(
            isEdit
              ? t("adminMemberships.formEditTitle")
              : t("adminMemberships.formCreateTitle"),
          )}
          onClose={handleClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <FormErrorBanner message={formError} onDismiss={clearAll} />

            {/* Name */}
            <YStack gap="$1">
              <Text tag="label" variant="label" htmlFor={nameId}>
                {String(t("adminMemberships.nameLabel"))}
              </Text>
              <TextInput
                id={nameId}
                placeholder={String(t("adminMemberships.namePlaceholder"))}
                value={name}
                onChangeText={setName}
                autoFocus={!isEdit}
                maxLength={80}
                fullWidth
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? `${nameId}-error` : undefined}
              />
              {showFieldError(nameError, nameId)}
            </YStack>

            {/* Description */}
            <YStack gap="$1">
              <Text tag="label" variant="label" htmlFor={descriptionId}>
                {String(t("adminMemberships.descriptionLabel"))}
              </Text>
              <TextInput
                id={descriptionId}
                placeholder={String(
                  t("adminMemberships.descriptionPlaceholder"),
                )}
                value={description}
                onChangeText={setDescription}
                maxLength={500}
                fullWidth
                {...({ multiline: true, numberOfLines: 3 } as Record<
                  string,
                  unknown
                >)}
              />
            </YStack>

            {/* Price + interval */}
            <XStack gap="$3" flexWrap="wrap">
              <YStack flex={1} minWidth={160} gap="$1">
                <Text tag="label" variant="label" htmlFor={priceId}>
                  {String(t("adminMemberships.priceLabel"))}
                </Text>
                <AmountInput
                  id={priceId}
                  prefix="$"
                  placeholder="10.00"
                  value={price}
                  onChangeText={(v) => setPrice(sanitizeAmountInput(v))}
                  inputMode="decimal"
                  fullWidth
                  disabled={priceLocked}
                  aria-invalid={!priceLocked && priceError ? true : undefined}
                  aria-describedby={
                    priceLocked
                      ? `${priceId}-locked`
                      : priceError
                        ? `${priceId}-error`
                        : undefined
                  }
                />
                {priceLocked ? (
                  <Text id={`${priceId}-locked`} variant="bodySmall" tone="muted">
                    {String(t("adminMemberships.priceLockedHint"))}
                  </Text>
                ) : (
                  showFieldError(priceError, priceId)
                )}
              </YStack>
              <YStack flex={1} minWidth={160} gap="$1">
                <Text variant="label">
                  {String(t("adminMemberships.intervalLabel"))}
                </Text>
                <StyledSelect
                  options={intervalOptions}
                  value={interval}
                  onChange={(v) => setBillingInterval(v as TierInterval)}
                  fullWidth
                  disabled={isEdit}
                />
                {isEdit && (
                  <Text variant="bodySmall" tone="muted">
                    {String(t("adminMemberships.intervalLockedHint"))}
                  </Text>
                )}
              </YStack>
            </XStack>

            {/* What members get — the owner's claim, in their words */}
            <YStack gap="$1">
              <Text tag="label" variant="label" htmlFor={benefitsDescriptionId}>
                {String(t("adminMemberships.benefitsDescriptionLabel"))}
              </Text>
              <TextInput
                id={benefitsDescriptionId}
                placeholder={String(
                  t("adminMemberships.benefitsDescriptionPlaceholder"),
                )}
                value={benefitsDescription}
                onChangeText={setBenefitsDescription}
                maxLength={500}
                fullWidth
                aria-describedby={`${benefitsDescriptionId}-hint`}
                {...({ multiline: true, numberOfLines: 3 } as Record<
                  string,
                  unknown
                >)}
              />
              <Text
                id={`${benefitsDescriptionId}-hint`}
                variant="bodySmall"
                tone="muted"
              >
                {String(t("adminMemberships.benefitsDescriptionHint"))}
              </Text>
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
              ? String(t("adminMemberships.saving"))
              : isEdit
                ? String(t("adminMemberships.save"))
                : String(t("adminMemberships.createTier"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
