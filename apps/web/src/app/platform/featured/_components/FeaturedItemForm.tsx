"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { XStack, YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";
import { Star } from "lucide-react";

import { ACCENT } from "@/lib/design-tokens";

import {
  type ItemType,
  ITEM_TYPES,
  TYPE_BADGE_KEYS,
  CTA_URL_PLACEHOLDERS,
  SectionHeader,
  FormCard,
  FieldRow,
  FieldLabel,
  SubmitButton,
  WebInput,
  WebSelect,
  WebTextarea,
} from "./styled";
import {
  DateTimeLocalInput,
  isDateTimeFieldIncomplete,
  useIncompleteField,
} from "@/components/forms/DateTimeLocalInput";

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface FeaturedItemFormProps {
  onSubmit: (data: FeaturedItemFormData) => void;
  isPending: boolean;
  mutationErrorMessage: string | null;
  validationErrorMessage: string | null;
  resetSignal: number;
}

export interface FeaturedItemFormData {
  itemType: ItemType;
  itemId: string;
  title: string | undefined;
  subtitle: string | undefined;
  heroImageUrl: string | undefined;
  ctaUrl: string | undefined;
  ctaLabel: string | undefined;
  sortOrder: number;
  active: boolean;
  curatedUntil: Date | undefined;
  notes: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FeaturedItemForm({
  onSubmit,
  isPending,
  mutationErrorMessage,
  validationErrorMessage,
  resetSignal,
}: FeaturedItemFormProps) {
  const t = useTranslations();
  const itemTypeInputId = "featured-item-type";
  const itemIdInputId = "featured-item-id";
  const titleInputId = "featured-item-title";
  const subtitleInputId = "featured-item-subtitle";
  const heroImageUrlInputId = "featured-hero-image-url";
  const ctaUrlInputId = "featured-cta-url";
  const ctaLabelInputId = "featured-cta-label";
  const sortOrderInputId = "featured-sort-order";
  const activeInputId = "featured-active";
  const curatedUntilInputId = "featured-curated-until";
  const notesInputId = "featured-notes";

  const ctaHelpKeyByType: Record<ItemType, string> = {
    EVENT: "admin.featuredCtaPathHintEvent",
    HUMAN: "admin.featuredCtaPathHintHuman",
    ORGANIZATION: "admin.featuredCtaPathHintOrg",
    PLACE: "admin.featuredCtaPathHintPlace",
  };

  // ── Form state ───────────────────────────────────────────────────────────
  const [itemType, setItemType] = useState<ItemType>("EVENT");
  const [itemId, setItemId] = useState("");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [heroImageUrl, setHeroImageUrl] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [active, setActive] = useState(true);
  const [curatedUntil, setCuratedUntil] = useState("");
  const [notes, setNotes] = useState("");
  // A half-typed date reads as "" (Chrome fires no input event until every
  // segment is filled), which would save as "no end".
  const curatedUntilField = useIncompleteField();
  const curatedUntilIncomplete = curatedUntilField.incomplete;
  const { refuse: refuseCuratedUntil } = curatedUntilField;
  const curatedUntilRef = useRef<HTMLInputElement>(null);

  const resetForm = useCallback(() => {
    setItemType("EVENT");
    setItemId("");
    setTitle("");
    setSubtitle("");
    setHeroImageUrl("");
    setCtaUrl("");
    setCtaLabel("");
    setSortOrder(0);
    setActive(true);
    setCuratedUntil("");
    setNotes("");
  }, []);

  const ctaUrlHelp = String(t(ctaHelpKeyByType[itemType]));

  const handleSubmit = useCallback(() => {
    if (!itemId.trim()) return;
    // Re-read the field: a half-typed date must never save as "no date".
    if (
      curatedUntilRef.current &&
      isDateTimeFieldIncomplete(curatedUntilRef.current)
    ) {
      refuseCuratedUntil(true);
      return;
    }

    onSubmit({
      itemType,
      itemId: itemId.trim(),
      title: title.trim() || undefined,
      subtitle: subtitle.trim() || undefined,
      heroImageUrl: heroImageUrl.trim() || undefined,
      ctaUrl: ctaUrl.trim() || undefined,
      ctaLabel: ctaLabel.trim() || undefined,
      sortOrder,
      active,
      curatedUntil: curatedUntil ? new Date(curatedUntil) : undefined,
      notes: notes.trim() || undefined,
    });
  }, [
    itemType,
    itemId,
    title,
    subtitle,
    heroImageUrl,
    ctaUrl,
    ctaLabel,
    sortOrder,
    active,
    curatedUntil,
    notes,
    onSubmit,
    refuseCuratedUntil,
  ]);

  useEffect(() => {
    resetForm();
  }, [resetForm, resetSignal]);

  return (
    <YStack gap={12}>
      <SectionHeader>
        <Text variant="kicker" tone="accent" style={{ marginRight: 8 }}>
          01.
        </Text>
        {String(t("admin.featuredAddTitle"))}
      </SectionHeader>

      <FormCard>
        {/* Row: Type + ID */}
        <XStack gap={12} flexWrap="wrap">
          <FieldRow flex={1} minWidth={140}>
            <FieldLabel htmlFor={itemTypeInputId}>
              {String(t("admin.featuredItemType"))}
            </FieldLabel>
            <WebSelect
              id={itemTypeInputId}
              value={itemType}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setItemType(e.target.value as ItemType)
              }
            >
              {ITEM_TYPES.map((it) => (
                <option key={it} value={it}>
                  {String(t(TYPE_BADGE_KEYS[it]))}
                </option>
              ))}
            </WebSelect>
          </FieldRow>

          <FieldRow flex={2} minWidth={200}>
            <FieldLabel htmlFor={itemIdInputId}>
              {String(t("admin.featuredItemId"))}
            </FieldLabel>
            <WebInput
              id={itemIdInputId}
              value={itemId}
              placeholder={String(t("admin.featuredUuidPlaceholder"))}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setItemId(e.target.value)
              }
            />
          </FieldRow>
        </XStack>

        {/* Row: Title + Subtitle */}
        <XStack gap={12} flexWrap="wrap">
          <FieldRow flex={1} minWidth={200}>
            <FieldLabel htmlFor={titleInputId}>
              {String(t("admin.featuredTitle"))}
            </FieldLabel>
            <WebInput
              id={titleInputId}
              value={title}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setTitle(e.target.value)
              }
            />
          </FieldRow>

          <FieldRow flex={1} minWidth={200}>
            <FieldLabel htmlFor={subtitleInputId}>
              {String(t("admin.featuredSubtitle"))}
            </FieldLabel>
            <WebInput
              id={subtitleInputId}
              value={subtitle}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setSubtitle(e.target.value)
              }
            />
          </FieldRow>
        </XStack>

        {/* Hero image URL */}
        <FieldRow>
          <FieldLabel htmlFor={heroImageUrlInputId}>
            {String(t("admin.featuredHeroImage"))}
          </FieldLabel>
          <WebInput
            id={heroImageUrlInputId}
            value={heroImageUrl}
            placeholder="/images/featured/homepage-hero.jpg"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setHeroImageUrl(e.target.value)
            }
          />
          <Text fontSize={12} tone="muted">
            {String(t("admin.featuredHeroImagePathHint"))}
          </Text>
        </FieldRow>

        {/* Row: CTA URL + CTA Label */}
        <XStack gap={12} flexWrap="wrap">
          <FieldRow flex={2} minWidth={200}>
            <FieldLabel htmlFor={ctaUrlInputId}>
              {String(t("admin.featuredCtaUrl"))}
            </FieldLabel>
            <WebInput
              id={ctaUrlInputId}
              value={ctaUrl}
              placeholder={CTA_URL_PLACEHOLDERS[itemType]}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setCtaUrl(e.target.value)
              }
            />
            <Text fontSize={12} tone="muted">
              {ctaUrlHelp}
            </Text>
          </FieldRow>

          <FieldRow flex={1} minWidth={140}>
            <FieldLabel htmlFor={ctaLabelInputId}>
              {String(t("admin.featuredCtaLabel"))}
            </FieldLabel>
            <WebInput
              id={ctaLabelInputId}
              value={ctaLabel}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setCtaLabel(e.target.value)
              }
            />
          </FieldRow>
        </XStack>

        {/* Row: Sort order + Active + Expiry */}
        <XStack gap={12} flexWrap="wrap" alignItems="flex-end">
          <FieldRow minWidth={100}>
            <FieldLabel htmlFor={sortOrderInputId}>
              {String(t("admin.featuredSortOrder"))}
            </FieldLabel>
            <WebInput
              id={sortOrderInputId}
              type="number"
              value={sortOrder}
              min={0}
              max={9999}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setSortOrder(Number(e.target.value) || 0)
              }
            />
          </FieldRow>

          <FieldRow minWidth={100}>
            <FieldLabel htmlFor={activeInputId}>
              {String(t("admin.featuredActive"))}
            </FieldLabel>
            <XStack alignItems="center" gap={8} paddingVertical={8}>
              <input
                id={activeInputId}
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                style={{
                  width: 18,
                  height: 18,
                  accentColor: ACCENT,
                  cursor: "pointer",
                }}
                aria-label={String(t("admin.featuredActive"))}
              />
              <Text fontSize={13} color="$color">
                {active
                  ? String(t("admin.featuredStatusOn"))
                  : String(t("admin.featuredStatusOff"))}
              </Text>
            </XStack>
          </FieldRow>

          <FieldRow flex={1} minWidth={180}>
            <FieldLabel htmlFor={curatedUntilInputId}>
              {String(t("admin.featuredCuratedUntil"))}
            </FieldLabel>
            <DateTimeLocalInput
              ref={curatedUntilRef}
              id={curatedUntilInputId}
              type="datetime-local"
              variant="boxed"
              // The boxed look, at this form's WebInput size and fill.
              style={{
                fontSize: 14,
                padding: "8px 12px",
                backgroundColor: "var(--background, #f6f0e4)",
              }}
              value={curatedUntil}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setCuratedUntil(e.target.value)
              }
              onIncompleteChange={curatedUntilField.onIncompleteChange}
              aria-invalid={curatedUntilField.shown ? true : undefined}
              aria-describedby={
                curatedUntilField.shown
                  ? `${curatedUntilInputId}-incomplete`
                  : undefined
              }
              data-testid="featured-curated-until"
            />
            {curatedUntilField.shown ? (
              <Text
                id={`${curatedUntilInputId}-incomplete`}
                fontSize={13}
                color="$danger"
                role="alert"
              >
                {String(t("common.dateTimeIncomplete"))}
              </Text>
            ) : null}
          </FieldRow>
        </XStack>

        {/* Notes */}
        <FieldRow>
          <FieldLabel htmlFor={notesInputId}>
            {String(t("admin.featuredNotes"))}
          </FieldLabel>
          <WebTextarea
            id={notesInputId}
            value={notes}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setNotes(e.target.value)
            }
          />
        </FieldRow>

        {/* Submit */}
        <SubmitButton
          onPress={handleSubmit}
          disabled={curatedUntilIncomplete}
          aria-disabled={curatedUntilIncomplete ? true : undefined}
          opacity={isPending || curatedUntilIncomplete ? 0.6 : 1}
          data-testid="featured-submit"
          aria-label={String(t("admin.featuredSubmit"))}
        >
          <Star size={14} aria-hidden />
          <Text
            fontSize={12}
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1.5}
            tone="inherit"
          >
            {String(t("admin.featuredSubmit"))}
          </Text>
        </SubmitButton>

        {mutationErrorMessage && (
          <Text fontSize={13} color="$danger">
            {mutationErrorMessage}
          </Text>
        )}

        {validationErrorMessage && (
          <Text fontSize={13} color="$danger">
            {validationErrorMessage}
          </Text>
        )}
      </FormCard>
    </YStack>
  );
}
