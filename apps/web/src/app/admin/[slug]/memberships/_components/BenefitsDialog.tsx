"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Modal,
  Button,
  Text,
  TextInput,
  StyledSelect,
  FormErrorBanner,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";
import { categoryDisplayName } from "@/lib/category-display-name";
import { ChevronDown, ChevronRight, Tag } from "lucide-react";
import { computeBenefitBreakEven } from "@th/core/lib/pricing/compute-benefit-break-even";

import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";
import { formatCents } from "@/lib/format";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";

import type { BenefitDiscountKind, TierRow } from "./tier-row";

// ─────────────────────────────────────────────────────────────────────────────
// Add / edit / remove DISCOUNT benefits on a tier.
//
// A benefit carries its own terms — there is no promo to pick, no code, and no
// window to manage. It applies automatically at ticket checkout for active
// members and lasts exactly as long as their membership. Narrowing
// (category / place) is optional and lives behind an "advanced" expander; the
// common case is "applies to all my events".
//
// The break-even calculator sits under the terms and recomputes live, because
// the only question an owner actually has at setup is "at what point does this
// cost me more than they pay me". Its maths is `computeBenefitBreakEven`
// (@th/core), which is the REAL pipeline's arithmetic for a sale under the
// 2026-10-11 ruling: the owner is credited the full ticket price, so a
// discounted ticket costs them min(discount, face) and no fee term appears.
// The note under it says how the buyer's platform fee is computed.
//
// Money entry follows the established pattern: text field + inputMode, a
// permissive keystroke filter, and ONE submit-time read through
// `parseMoneyInputToCents`, which refuses ambiguous input ("1,500") rather than
// guessing. Never `type="number"` — react-native-web reverses the caret.
// ─────────────────────────────────────────────────────────────────────────────

const NONE = "__none__";

/**
 * Prefill for the calculator's ticket price. Deliberately a constant the owner
 * can edit rather than a query: the spec's preferred prefill is the median
 * face of their upcoming published events, and there is no cheap read for that
 * today (no procedure returns ticket-type prices in bulk, so it would mean a
 * new repo aggregate + use case + procedure for a prefill the owner retypes in
 * one keystroke).
 */
const DEFAULT_TYPICAL_TICKET_CENTS = 2000;

/** Keeps digits, separators, sign and whitespace; the parser adjudicates. */
function sanitizeAmountInput(input: string): string {
  return input.replace(/[^0-9.,\s-]/g, "");
}

/** Percent is a plain integer field — digits only, no separators to disambiguate. */
function sanitizePercentInput(input: string): string {
  return input.replace(/[^0-9]/g, "").slice(0, 3);
}

function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

export interface BenefitsDialogProps {
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
  tier: TierRow;
  onClose: () => void;
  /** Fired after any add/edit/remove so the caller can refresh the tier list. */
  onChanged: () => void;
}

type TermsDraft = {
  discountKind: BenefitDiscountKind;
  /** Dollar string for AMOUNT. */
  amount: string;
  /** Integer string for PERCENT. */
  percent: string;
  /** Dollar string; blank = no clamp. */
  maxDiscount: string;
  categoryId: string;
  placeId: string;
  label: string;
};

const EMPTY_DRAFT: TermsDraft = {
  discountKind: "AMOUNT",
  amount: "",
  percent: "",
  maxDiscount: "",
  categoryId: NONE,
  placeId: NONE,
  label: "",
};

function draftFromBenefit(benefit: TierRow["benefits"][number]): TermsDraft {
  return {
    discountKind: benefit.discountKind,
    amount:
      benefit.discountKind === "AMOUNT"
        ? centsToDollarsInput(benefit.discountValue)
        : "",
    percent:
      benefit.discountKind === "PERCENT" ? String(benefit.discountValue) : "",
    maxDiscount: centsToDollarsInput(benefit.maxDiscountCents),
    categoryId: benefit.categoryId ?? NONE,
    placeId: benefit.placeId ?? NONE,
    label: benefit.label ?? "",
  };
}

/** The parsed terms, or the first message key that stops the submit. */
type ResolvedTerms =
  | {
      ok: true;
      discountKind: BenefitDiscountKind;
      discountValue: number;
      maxDiscountCents: number | null;
    }
  | { ok: false; messageKey: string };

export function resolveBenefitTerms(draft: TermsDraft): ResolvedTerms {
  let maxDiscountCents: number | null = null;
  if (draft.maxDiscount.trim() !== "") {
    const parsedMax = parseMoneyInputToCents(draft.maxDiscount);
    if (!parsedMax.ok || parsedMax.cents <= 0) {
      return {
        ok: false,
        messageKey: "adminMemberships.maxDiscountInvalid",
      };
    }
    maxDiscountCents = parsedMax.cents;
  }

  if (draft.discountKind === "PERCENT") {
    const percent = Number.parseInt(draft.percent, 10);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      return { ok: false, messageKey: "adminMemberships.percentRange" };
    }
    return { ok: true, discountKind: "PERCENT", discountValue: percent, maxDiscountCents };
  }

  const parsed = parseMoneyInputToCents(draft.amount);
  if (!parsed.ok) {
    return {
      ok: false,
      messageKey:
        parsed.reason === "empty"
          ? "adminMemberships.amountRequired"
          : parsed.reason === "ambiguous"
            ? "adminMemberships.amountAmbiguous"
            : "adminMemberships.amountInvalid",
    };
  }
  if (parsed.cents < 1) {
    return { ok: false, messageKey: "adminMemberships.amountPositive" };
  }
  // Mirrors the core rule (assertBenefitTerms): a cap under the amount means
  // the amount could never apply in full, which is a typo rather than a plan.
  if (maxDiscountCents != null && maxDiscountCents < parsed.cents) {
    return { ok: false, messageKey: "adminMemberships.maxDiscountBelowAmount" };
  }
  return {
    ok: true,
    discountKind: "AMOUNT",
    discountValue: parsed.cents,
    maxDiscountCents,
  };
}

export function BenefitsDialog({
  ownerType,
  ownerId,
  tier,
  onClose,
  onChanged,
}: BenefitsDialogProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();

  const [editingBenefitId, setEditingBenefitId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TermsDraft>(EMPTY_DRAFT);
  const [narrowingOpen, setNarrowingOpen] = useState(false);

  // Calculator inputs — owner-editable, seeded from the tier and a default
  // ticket price (see DEFAULT_TYPICAL_TICKET_CENTS).
  const [ticketPrice, setTicketPrice] = useState(
    centsToDollarsInput(DEFAULT_TYPICAL_TICKET_CENTS),
  );
  const [ticketsPerPeriod, setTicketsPerPeriod] = useState("2");

  const setDraftField = useCallback(
    <K extends keyof TermsDraft>(key: K, value: TermsDraft[K]) =>
      setDraft((current) => ({ ...current, [key]: value })),
    [],
  );

  // ── Data ──────────────────────────────────────────────────────────────
  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 300_000,
  });
  // OWNERSHIP-ONLY. This picker narrows a benefit to one of THIS owner's
  // venues ("free entry, but only at our room"). It used to pass
  // `ownedOnly: false`, which ORs `verification: VERIFIED` into the server's
  // access filter — so the dropdown offered the first 50 verified venues on
  // the PLATFORM, alphabetically, most of them strangers'.
  //
  // Nothing leaked: `placeId` is an opaque narrowing key matched on exact
  // equality at resolve time, and a benefit can only ever discount its own
  // owner's revenue (see attach-tier-benefit.ts). But picking a venue you do
  // not own silently created a benefit that can NEVER fire — a dead setting
  // with no error, which is worse than an empty list.
  const placesQuery = trpc.places.listHumanPlaces.useQuery(
    {
      // Wire cap: listHumanPlacesInputSchema is `.max(50)`.
      limit: 50,
      offset: 0,
      ownedOnly: true,
      ...(ownerType === "ORGANIZATION" ? { orgIds: [ownerId] } : {}),
    },
    { staleTime: 60_000 },
  );

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categoriesQuery.data?.categories ?? []) {
      map.set(category.id, categoryDisplayName(category, locale));
    }
    return map;
  }, [categoriesQuery.data, locale]);

  const placeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const place of placesQuery.data?.places ?? []) {
      map.set(place.placeId, place.name);
    }
    return map;
  }, [placesQuery.data]);

  const categoryOptions = useMemo(
    () => [
      { value: NONE, label: String(t("adminMemberships.anyCategory")) },
      ...(categoriesQuery.data?.categories ?? []).map((category) => ({
        value: category.id,
        label: categoryDisplayName(category, locale),
      })),
    ],
    [categoriesQuery.data, locale, t],
  );

  const placeOptions = useMemo(
    () => [
      { value: NONE, label: String(t("adminMemberships.anyPlace")) },
      ...(placesQuery.data?.places ?? []).map((place) => ({
        value: place.placeId,
        label: place.name,
      })),
    ],
    [placesQuery.data, t],
  );

  const discountKindOptions = useMemo(
    () => [
      {
        value: "AMOUNT" as const,
        label: String(t("adminMemberships.discountKindAmount")),
      },
      {
        value: "PERCENT" as const,
        label: String(t("adminMemberships.discountKindPercent")),
      },
    ],
    [t],
  );

  // ── Mutations ─────────────────────────────────────────────────────────
  const utils = trpc.useUtils();
  const invalidate = useCallback(() => {
    void utils.memberships.tiers.list.invalidate();
    onChanged();
  }, [utils, onChanged]);

  const resetForm = useCallback(() => {
    setEditingBenefitId(null);
    setDraft(EMPTY_DRAFT);
    setNarrowingOpen(false);
  }, []);

  const attachMutation = trpc.memberships.benefits.attach.useMutation({
    onSuccess: () => {
      toast.success(String(t("adminMemberships.benefitAttached")));
      resetForm();
      invalidate();
    },
    onError: (err) => setError(err),
  });

  const updateMutation = trpc.memberships.benefits.update.useMutation({
    onSuccess: () => {
      toast.success(String(t("adminMemberships.benefitUpdated")));
      resetForm();
      invalidate();
    },
    onError: (err) => setError(err),
  });

  const removeMutation = trpc.memberships.benefits.remove.useMutation({
    onSuccess: () => {
      toast.success(String(t("adminMemberships.benefitRemoved")));
      resetForm();
      invalidate();
    },
    onError: (err) => setError(err),
  });

  const isPending =
    attachMutation.isPending ||
    updateMutation.isPending ||
    removeMutation.isPending;

  // The benefit being edited can vanish under us (another tab removed it, or
  // the list refetched after a delete). Fall back to the add form rather than
  // leaving a submit button pointed at a dead id.
  useEffect(() => {
    if (
      editingBenefitId &&
      !tier.benefits.some((benefit) => benefit.id === editingBenefitId)
    ) {
      resetForm();
    }
  }, [editingBenefitId, tier.benefits, resetForm]);

  // ── Validation (single read per submit-relevant field) ────────────────
  const terms = useMemo(() => resolveBenefitTerms(draft), [draft]);
  // A pristine empty form should not shout at the owner before they type.
  const touchedTerms =
    draft.discountKind === "AMOUNT"
      ? draft.amount.trim() !== "" || draft.maxDiscount.trim() !== ""
      : draft.percent.trim() !== "" || draft.maxDiscount.trim() !== "";
  const termsError =
    !terms.ok && touchedTerms ? String(t(terms.messageKey)) : null;

  const handleSubmit = useCallback(() => {
    if (!terms.ok) return;
    clearAll();

    const payload = {
      tierId: tier.id,
      discountKind: terms.discountKind,
      discountValue: terms.discountValue,
      maxDiscountCents: terms.maxDiscountCents,
      categoryId: draft.categoryId === NONE ? null : draft.categoryId,
      placeId: draft.placeId === NONE ? null : draft.placeId,
      label: draft.label.trim() === "" ? null : draft.label.trim(),
    };

    if (editingBenefitId) {
      updateMutation.mutate({ ...payload, benefitId: editingBenefitId });
    } else {
      attachMutation.mutate(payload);
    }
  }, [
    terms,
    clearAll,
    tier.id,
    draft.categoryId,
    draft.placeId,
    draft.label,
    editingBenefitId,
    updateMutation,
    attachMutation,
  ]);

  const narrowingLabel = useCallback(
    (benefit: TierRow["benefits"][number]): string => {
      const parts: string[] = [];
      if (benefit.categoryId) {
        parts.push(
          String(
            t("adminMemberships.benefitCategory", {
              name:
                categoryNameById.get(benefit.categoryId) ?? benefit.categoryId,
            }),
          ),
        );
      }
      if (benefit.placeId) {
        parts.push(
          String(
            t("adminMemberships.benefitPlace", {
              name: placeNameById.get(benefit.placeId) ?? benefit.placeId,
            }),
          ),
        );
      }
      if (parts.length === 0) {
        return String(t("adminMemberships.benefitAnyEvent"));
      }
      return parts.join(" · ");
    },
    [t, categoryNameById, placeNameById],
  );

  const termsSummary = useCallback(
    (benefit: TierRow["benefits"][number]): string => {
      const head =
        benefit.discountKind === "AMOUNT"
          ? String(
              t("adminMemberships.benefitAmountSummary", {
                amount: formatCents(benefit.discountValue, tier.currency),
              }),
            )
          : String(
              t("adminMemberships.benefitPercentSummary", {
                percent: benefit.discountValue,
              }),
            );
      if (benefit.maxDiscountCents == null) return head;
      return `${head} · ${String(
        t("adminMemberships.benefitCapSummary", {
          amount: formatCents(benefit.maxDiscountCents, tier.currency),
        }),
      )}`;
    },
    [t, tier.currency],
  );

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={560}>
        <Modal.Header
          title={String(
            t("adminMemberships.benefitsTitle", { tierName: tier.name }),
          )}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <FormErrorBanner message={formError} onDismiss={clearAll} />

            <Text variant="bodySmall" tone="muted">
              {String(t("adminMemberships.benefitsIntro"))}
            </Text>

            {/* Current benefits */}
            <YStack gap="$2">
              <SectionLabel>
                {String(t("adminMemberships.currentBenefits"))}
              </SectionLabel>
              {tier.benefits.length === 0 ? (
                <Text variant="bodySmall" tone="muted">
                  {String(t("adminMemberships.noBenefits"))}
                </Text>
              ) : (
                tier.benefits.map((benefit) => (
                  <XStack
                    key={benefit.id}
                    alignItems="center"
                    justifyContent="space-between"
                    gap="$2"
                    padding="$2"
                    borderWidth={1}
                    borderColor="$borderColorSoft"
                    flexWrap="wrap"
                  >
                    <XStack alignItems="center" gap="$2" flex={1} minWidth={0}>
                      <Tag size={14} color="var(--colorMuted, #5C544A)" />
                      <YStack flex={1} minWidth={0}>
                        <Text variant="body" weight="bold">
                          {termsSummary(benefit)}
                        </Text>
                        <Text variant="caption" tone="muted">
                          {narrowingLabel(benefit)}
                        </Text>
                      </YStack>
                    </XStack>
                    <XStack gap="$1" alignItems="center">
                      <Button
                        variant="ghost"
                        size="$2"
                        disabled={isPending}
                        onPress={() => {
                          clearAll();
                          setEditingBenefitId(benefit.id);
                          setDraft(draftFromBenefit(benefit));
                          setNarrowingOpen(
                            benefit.categoryId != null ||
                              benefit.placeId != null,
                          );
                        }}
                      >
                        {String(t("adminMemberships.editBenefit"))}
                      </Button>
                      <Button
                        variant="ghost"
                        size="$2"
                        disabled={isPending}
                        onPress={() =>
                          removeMutation.mutate({
                            tierId: tier.id,
                            benefitId: benefit.id,
                          })
                        }
                      >
                        {String(t("adminMemberships.removeBenefit"))}
                      </Button>
                    </XStack>
                  </XStack>
                ))
              )}
            </YStack>

            {/* Terms form — add or edit */}
            <YStack gap="$2">
              <SectionLabel>
                {String(
                  editingBenefitId
                    ? t("adminMemberships.editHeading")
                    : t("adminMemberships.addHeading"),
                )}
              </SectionLabel>

              <XStack gap="$3" flexWrap="wrap">
                <YStack flex={1} minWidth={160} gap="$1">
                  <Text variant="label">
                    {String(t("adminMemberships.discountKindLabel"))}
                  </Text>
                  <StyledSelect
                    options={discountKindOptions}
                    value={draft.discountKind}
                    onChange={(v) =>
                      setDraftField("discountKind", v as BenefitDiscountKind)
                    }
                    fullWidth
                    aria-label={String(
                      t("adminMemberships.discountKindLabel"),
                    )}
                  />
                </YStack>

                <YStack flex={1} minWidth={160} gap="$1">
                  {draft.discountKind === "AMOUNT" ? (
                    <MoneyField
                      label={String(t("adminMemberships.amountLabel"))}
                      value={draft.amount}
                      onChange={(v) => setDraftField("amount", v)}
                      placeholder="5.00"
                    />
                  ) : (
                    <PercentField
                      label={String(t("adminMemberships.percentLabel"))}
                      value={draft.percent}
                      onChange={(v) => setDraftField("percent", v)}
                    />
                  )}
                </YStack>
              </XStack>

              <MoneyField
                label={String(t("adminMemberships.maxDiscountLabel"))}
                value={draft.maxDiscount}
                onChange={(v) => setDraftField("maxDiscount", v)}
                placeholder="20.00"
              />

              {termsError ? (
                <Text variant="bodySmall" color="$red10" role="alert">
                  {termsError}
                </Text>
              ) : null}

              <YStack gap="$1">
                <Text variant="label">
                  {String(t("adminMemberships.labelLabel"))}
                </Text>
                <TextInput
                  placeholder={String(t("adminMemberships.labelPlaceholder"))}
                  value={draft.label}
                  onChangeText={(v) => setDraftField("label", v)}
                  maxLength={80}
                  fullWidth
                  aria-label={String(t("adminMemberships.labelLabel"))}
                />
              </YStack>

              {/* Optional narrowing, collapsed by default */}
              {/* The label is a wrapped <Text>, not a bare string child: at
                  320px a bare child does not wrap and the button CLIPPED it
                  mid-word ("LIMIT WHERE IT APPLIES (OPTIO"). `flexShrink` +
                  normal white-space lets it take a second line instead. */}
              <Button
                variant="ghost"
                size="$2"
                alignSelf="flex-start"
                maxWidth="100%"
                onPress={() => setNarrowingOpen((open) => !open)}
                aria-expanded={narrowingOpen}
              >
                {narrowingOpen ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )}
                <Text
                  variant="label"
                  flexShrink={1}
                  style={{ whiteSpace: "normal" }}
                >
                  {String(t("adminMemberships.narrowingToggle"))}
                </Text>
              </Button>
              {narrowingOpen && (
                <XStack gap="$3" flexWrap="wrap">
                  <YStack flex={1} minWidth={180} gap="$1">
                    <Text variant="label">
                      {String(t("adminMemberships.narrowingCategoryLabel"))}
                    </Text>
                    <StyledSelect
                      options={categoryOptions}
                      value={draft.categoryId}
                      onChange={(v) => setDraftField("categoryId", v || NONE)}
                      fullWidth
                      aria-label={String(
                        t("adminMemberships.narrowingCategoryLabel"),
                      )}
                    />
                  </YStack>
                  <YStack flex={1} minWidth={180} gap="$1">
                    <Text variant="label">
                      {String(t("adminMemberships.narrowingPlaceLabel"))}
                    </Text>
                    <StyledSelect
                      options={placeOptions}
                      value={draft.placeId}
                      onChange={(v) => setDraftField("placeId", v || NONE)}
                      fullWidth
                      aria-label={String(
                        t("adminMemberships.narrowingPlaceLabel"),
                      )}
                    />
                  </YStack>
                </XStack>
              )}

              <XStack gap="$2" flexWrap="wrap">
                <Button
                  variant="secondary"
                  size="$3"
                  onPress={handleSubmit}
                  disabled={!terms.ok || isPending}
                >
                  {attachMutation.isPending || updateMutation.isPending
                    ? String(t("adminMemberships.adding"))
                    : editingBenefitId
                      ? String(t("adminMemberships.save"))
                      : String(t("adminMemberships.add"))}
                </Button>
                {editingBenefitId ? (
                  <Button
                    variant="ghost"
                    size="$3"
                    onPress={resetForm}
                    disabled={isPending}
                  >
                    {String(t("adminMemberships.cancelEdit"))}
                  </Button>
                ) : null}
              </XStack>
            </YStack>

            <BreakEvenPanel
              tier={tier}
              terms={terms}
              ticketPrice={ticketPrice}
              onTicketPriceChange={setTicketPrice}
              ticketsPerPeriod={ticketsPerPeriod}
              onTicketsPerPeriodChange={setTicketsPerPeriod}
            />
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          {/* "Done", not "Close": the panel header already renders a ×
              labelled "Close", and two controls with the same accessible name
              on one page is the defect class that shipped twice before. It is
              also the more honest word — edits commit via Add/Save above, so
              this button only dismisses. */}
          <Button variant="ghost" onPress={onClose}>
            {String(t("adminMemberships.done"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </Text>
  );
}

/**
 * Dollar entry. `inputMode="decimal"` + a permissive filter, never
 * `type="number"` — react-native-web's number input reverses typed characters.
 */
function MoneyField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <YStack gap="$1">
      <Text variant="label">{label}</Text>
      <XStack alignItems="center" gap="$2">
        <Text variant="body" tone="muted" style={{ minWidth: 12 }}>
          $
        </Text>
        <TextInput
          placeholder={placeholder}
          value={value}
          onChangeText={(v) => onChange(sanitizeAmountInput(v))}
          inputMode="decimal"
          fullWidth
          aria-label={label}
        />
      </XStack>
    </YStack>
  );
}

function PercentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <YStack gap="$1">
      <Text variant="label">{label}</Text>
      <XStack alignItems="center" gap="$2">
        <TextInput
          placeholder="10"
          value={value}
          onChangeText={(v) => onChange(sanitizePercentInput(v))}
          inputMode="numeric"
          fullWidth
          aria-label={label}
        />
        <Text variant="body" tone="muted" style={{ minWidth: 12 }}>
          %
        </Text>
      </XStack>
    </YStack>
  );
}

/**
 * The break-even answer, recomputed on every keystroke from the SAME pure
 * function the spec pins to the real checkout pipeline. It reads the terms
 * currently in the form (not the saved benefit), so an owner sees the cost of
 * the change before committing it.
 */
function BreakEvenPanel({
  tier,
  terms,
  ticketPrice,
  onTicketPriceChange,
  ticketsPerPeriod,
  onTicketsPerPeriodChange,
}: {
  tier: TierRow;
  terms: ResolvedTerms;
  ticketPrice: string;
  onTicketPriceChange: (next: string) => void;
  ticketsPerPeriod: string;
  onTicketsPerPeriodChange: (next: string) => void;
}) {
  const t = useTranslations();

  const periodLabel = String(
    tier.interval === "YEAR"
      ? t("adminMemberships.breakEvenPeriodYear")
      : t("adminMemberships.breakEvenPeriodMonth"),
  );

  const parsedTicketPrice = parseMoneyInputToCents(ticketPrice);
  const faceCents = parsedTicketPrice.ok
    ? parsedTicketPrice.cents
    : DEFAULT_TYPICAL_TICKET_CENTS;
  const tickets = Math.max(
    0,
    Number.parseInt(ticketsPerPeriod, 10) || 0,
  );

  const result = useMemo(
    () =>
      terms.ok
        ? computeBenefitBreakEven({
            tierPriceCents: tier.priceCents,
            interval: tier.interval,
            discountKind: terms.discountKind,
            discountValue: terms.discountValue,
            maxDiscountCents: terms.maxDiscountCents,
            typicalTicketFaceCents: faceCents,
            discountedTicketsPerPeriod: tickets,
          })
        : null,
    [terms, tier.priceCents, tier.interval, faceCents, tickets],
  );

  const money = (cents: number) => formatCents(cents, tier.currency);

  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColorSoft"
    >
      <SectionLabel>
        {String(t("adminMemberships.breakEvenHeading"))}
      </SectionLabel>

      <XStack gap="$3" flexWrap="wrap">
        <YStack flex={1} minWidth={160}>
          <MoneyField
            label={String(t("adminMemberships.breakEvenTicketPriceLabel"))}
            value={ticketPrice}
            onChange={onTicketPriceChange}
            placeholder="20.00"
          />
        </YStack>
        <YStack flex={1} minWidth={160} gap="$1">
          <Text variant="label">
            {String(
              t("adminMemberships.breakEvenTicketsLabel", {
                period: periodLabel,
              }),
            )}
          </Text>
          <TextInput
            value={ticketsPerPeriod}
            onChangeText={(v) =>
              onTicketsPerPeriodChange(v.replace(/[^0-9]/g, "").slice(0, 3))
            }
            inputMode="numeric"
            fullWidth
            aria-label={String(
              t("adminMemberships.breakEvenTicketsLabel", {
                period: periodLabel,
              }),
            )}
          />
        </YStack>
      </XStack>

      {result ? (
        <YStack gap="$1">
          <Text variant="body">
            {result.breakEvenTicketsPerPeriod == null
              ? String(t("adminMemberships.breakEvenNever"))
              : String(
                  t("adminMemberships.breakEvenAnswer", {
                    count: result.breakEvenTicketsPerPeriod,
                    period: periodLabel,
                  }),
                )}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {String(
              result.ownerNetPerMemberCents >= 0
                ? t("adminMemberships.breakEvenNetPositive", {
                    tickets,
                    period: periodLabel,
                    net: money(result.ownerNetPerMemberCents),
                    given: money(result.ownerCostPerTicketCents * tickets),
                  })
                : t("adminMemberships.breakEvenNetNegative", {
                    tickets,
                    period: periodLabel,
                    net: money(Math.abs(result.ownerNetPerMemberCents)),
                    given: money(result.ownerCostPerTicketCents * tickets),
                  }),
            )}
          </Text>
        </YStack>
      ) : null}

      {/* How the buyer's platform fee is computed on a discounted ticket. */}
      <Text variant="caption" tone="muted">
        {String(t("adminMemberships.breakEvenFeeNote"))}
      </Text>
    </YStack>
  );
}
