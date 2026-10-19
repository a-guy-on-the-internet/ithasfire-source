"use client";

import { useId, useState } from "react";
import { ArrowRight } from "lucide-react";
import { XStack, YStack } from "tamagui";

import {
  AmountInput,
  Button,
  CharCountTextarea,
  Link,
  Text,
  useTranslations,
} from "@th/ui";

import { useIsMobile } from "@/hooks/useIsMobile";
import { ACCENT_TEXT, BORDER, DANGER_TEXT } from "@/lib/design-tokens";

import { SeatPriceNotice } from "./SeatPriceNotice";
import { fixedPriceText } from "./seat-price-labels";
import { MAX_CUSTOM_PRICE_CENTS, centsToInputValue } from "./seat-price-money";
import {
  notesReplacedBy,
  resolvePanelActions,
  resolvePriceVerdict,
  type PanelSelection,
  type PriceVerdict,
} from "./seat-price-panel-state";

/** The write's cap on the note (`reason`), in set-seat-price-overrides.ts. */
export const SEAT_PRICE_NOTE_MAX = 200;

/** Above this many seats the heading stops listing each label. */
const MAX_LISTED_SEATS = 12;

/**
 * What the organizer has typed. `null` means "not touched": the field then
 * follows the selection, showing the stored value only when every selected
 * seat shares it (price and note each on their own), and empty otherwise. The draft lives in the editor, above this component, so switching
 * between the sidebar and the phone sheet (and, in 5b-2, between Map and
 * List) keeps it.
 */
export type SeatPriceDraft = { price: string | null; note: string | null };

export const PRISTINE_DRAFT: SeatPriceDraft = { price: null, note: null };

export type SeatPricePanelProps = {
  panel: PanelSelection;
  draft: SeatPriceDraft;
  onDraftChange: (next: SeatPriceDraft) => void;
  /** Integer cents as display text, in the event's currency. */
  formatCents: (cents: number) => string;
  /** An instant on the event's clock, or `null` while the zone is unknown. */
  formatWhen: (at: Date) => string | null;
  /** "$" for the field label. */
  currencySymbol: string;
  payoutsHref: string;
  saving: boolean;
  onSetPrice: (priceCents: number, note: string | null) => void;
  onUseSectionPrice: () => void;
  onClearSelection: () => void;
};

const linkStyle = {
  color: ACCENT_TEXT,
  fontWeight: 700,
  fontSize: 12,
  textDecoration: "underline",
  textUnderlineOffset: 2,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  alignSelf: "flex-start",
} as const;

const monoPrice = {
  fontFamily: "$mono",
  fontSize: 13,
  letterSpacing: 0.4,
} as const;

/**
 * The one price panel: the sidebar on desktop, the body of the bottom sheet
 * on a phone, and the same component for the Map view in step 5b-2.
 *
 * Everything that can stop a save is said ABOVE the field, before the
 * organizer types (pro-social: "every rule visible to the person it applies
 * to"). The flags are the server's; this component only words them.
 */
export function SeatPricePanel({
  panel,
  draft,
  onDraftChange,
  formatCents,
  formatWhen,
  currencySymbol,
  payoutsHref,
  saving,
  onSetPrice,
  onUseSectionPrice,
  onClearSelection,
}: SeatPricePanelProps) {
  const t = useTranslations();
  const baseId = useId();
  const priceId = `${baseId}-price`;
  const priceErrorId = `${baseId}-price-error`;
  const noteId = `${baseId}-note`;
  const noteHintId = `${baseId}-note-hint`;
  // Errors show on blur or on a refused "Set price", never while typing.
  const [showPriceError, setShowPriceError] = useState(false);

  const priceText =
    draft.price ??
    (panel.sharedPriceCents !== null
      ? centsToInputValue(panel.sharedPriceCents)
      : "");
  const noteText = draft.note ?? panel.sharedNote ?? "";
  const nextNote = noteText.trim() === "" ? null : noteText.trim();
  const notesReplaced = notesReplacedBy(panel, nextNote);
  const verdict = resolvePriceVerdict(panel, priceText);
  const actions = resolvePanelActions(panel, verdict, saving);
  const zero = formatCents(0);
  const priceError = showPriceError
    ? priceErrorMessage(verdict, t, zero, formatCents(MAX_CUSTOM_PRICE_CENTS))
    : null;

  const heading = panelHeading(panel, t);
  const sectionPrice = panel.sectionPrice;
  const replaced = panel.replacedTicketTypes;
  const bySection = panel.replacedBySection;

  const handleSetPrice = () => {
    if (verdict.kind !== "ok") {
      setShowPriceError(true);
      document.getElementById(priceId)?.focus();
      return;
    }
    onSetPrice(verdict.priceCents, nextNote);
  };

  return (
    <YStack gap="$3" data-testid="seat-price-panel">
      <XStack justifyContent="space-between" alignItems="center" gap="$2">
        <Text variant="overline" tone="muted">
          {String(t("admin.seatPricesSelectedCount", { count: panel.seatCount }))}
        </Text>
        <Button
          size="$1"
          variant="ghost"
          // 44px: this sits in the phone sheet too, under a thumb.
          minHeight={44}
          onPress={onClearSelection}
          disabled={saving}
        >
          {String(t("admin.seatPricesClearSelection"))}
        </Button>
      </XStack>

      <YStack gap={2}>
        <Text variant="bodySmall" weight="bold">
          {heading.name}
        </Text>
        {heading.detail ? (
          <Text variant="caption" tone="muted">
            {heading.detail}
          </Text>
        ) : null}
      </YStack>

      {sectionPrice ? (
        <XStack justifyContent="space-between" alignItems="baseline" gap="$3">
          <Text variant="caption" tone="muted">
            {String(t("admin.seatPricesSectionPriceLabel"))}
          </Text>
          <Text {...monoPrice} weight="semibold" textAlign="right">
            {sectionPrice.ticketTypes.length === 1
              ? `${formatCents(sectionPrice.minCents)} ${sectionPrice.ticketTypes[0]!.name}`
              : fixedPriceText(sectionPrice, formatCents, t)}
          </Text>
        </XStack>
      ) : null}

      {panel.setRefusals.map((refusal) => (
        <SeatPriceNotice
          key={`refusal-${refusal.sectionId}`}
          testId="seat-price-notice-refusal"
          title={String(
            t("admin.seatPricesOffTitle", { section: refusal.sectionName }),
          )}
        >
          {String(
            refusal.reason === "ADJUSTABLE_TIER"
              ? t("admin.seatPricesOffPayWhatYouWantBody", {
                  ticketTypes: refusal.payWhatYouWantTypeNames.join(", "),
                })
              : t("admin.seatPricesOffNoFixedBody"),
          )}
        </SeatPriceNotice>
      ))}
      {panel.setRefusals.length > 0 &&
      panel.sections.length > panel.setRefusals.length ? (
        <Text variant="caption" tone="muted">
          {String(t("admin.seatPricesOffMixedHint"))}
        </Text>
      ) : null}

      {panel.unreadableCount > 0 ? (
        <SeatPriceNotice
          testId="seat-price-notice-unreadable"
          title={String(
            t(
              panel.seatCount === 1
                ? "admin.seatPricesUnreadableTitleOne"
                : "admin.seatPricesUnreadableTitleMany",
              { count: panel.unreadableCount },
            ),
          )}
        >
          {String(
            t("admin.seatPricesUnreadableBody", {
              count: panel.unreadableCount,
            }),
          )}
        </SeatPriceNotice>
      ) : null}

      {panel.canSetPrice
        ? panel.paidBlocks.map((block) =>
            block.reason === "STRIPE" ? (
              <SeatPriceNotice
                key={`paid-${block.sectionId}`}
                testId="seat-price-notice-payouts"
                title={String(
                  t("admin.seatPricesPaidStripeTitle", {
                    section: block.sectionName,
                  }),
                )}
                action={
                  <Link href={payoutsHref} style={linkStyle}>
                    {String(t("admin.ttSetUpPayouts"))}
                    <ArrowRight size={12} strokeWidth={2.5} aria-hidden />
                  </Link>
                }
              >
                {String(t("admin.seatPricesPaidStripeBody", { zero }))}
              </SeatPriceNotice>
            ) : (
              <SeatPriceNotice
                key={`paid-${block.sectionId}`}
                testId="seat-price-notice-fee-policy"
                title={String(
                  t("admin.seatPricesPaidFeePolicyTitle", {
                    section: block.sectionName,
                  }),
                )}
                action={
                  <Link href="/contact" style={linkStyle}>
                    {String(t("admin.seatPricesContactUs"))}
                    <ArrowRight size={12} strokeWidth={2.5} aria-hidden />
                  </Link>
                }
              >
                {String(t("admin.seatPricesPaidFeePolicyBody", { zero }))}
              </SeatPriceNotice>
            ),
          )
        : null}

      {panel.scheduledChanges.map((change) => {
        const when = formatWhen(change.at);
        const price = formatCents(change.toPriceCents);
        return (
          <SeatPriceNotice
            key={`scheduled-${change.ticketTypeId}`}
            testId="seat-price-notice-scheduled"
            title={String(
              when
                ? t("admin.seatPricesScheduledTitle", {
                    ticketType: change.ticketTypeName,
                    price,
                    when,
                  })
                : t("admin.seatPricesScheduledTitleNoDate", {
                    ticketType: change.ticketTypeName,
                    price,
                  }),
            )}
          >
            {String(t("admin.seatPricesScheduledBody"))}
          </SeatPriceNotice>
        );
      })}

      <YStack gap={6} opacity={panel.canSetPrice ? 1 : 0.45}>
        <label htmlFor={priceId}>
          <PanelFieldLabel>
            {String(
              t("admin.seatPricesCustomPriceLabel", { symbol: currencySymbol }),
            )}
          </PanelFieldLabel>
        </label>
        <AmountInput
          id={priceId}
          aria-label={String(
            t("admin.seatPricesCustomPriceLabel", { symbol: currencySymbol }),
          )}
          aria-invalid={priceError ? true : undefined}
          aria-describedby={priceError ? priceErrorId : undefined}
          value={panel.canSetPrice ? priceText : ""}
          placeholder={
            panel.canSetPrice
              ? sectionPrice && sectionPrice.minCents === sectionPrice.maxCents
                ? centsToInputValue(sectionPrice.minCents)
                : undefined
              : String(t("admin.seatPricesCustomPriceUnavailable"))
          }
          onChangeText={(value: string) => {
            setShowPriceError(false);
            onDraftChange({ ...draft, price: value });
          }}
          onBlur={() => {
            if (verdict.kind !== "empty") setShowPriceError(true);
          }}
          onSubmitEditing={handleSetPrice}
          inputMode="decimal"
          autoComplete="off"
          disabled={!panel.canSetPrice || saving}
          status={priceError ? "error" : undefined}
          fullWidth
        />
        {priceError ? (
          <Text
            id={priceErrorId}
            role="alert"
            variant="caption"
            style={{ color: DANGER_TEXT }}
          >
            {priceError}
          </Text>
        ) : null}
      </YStack>

      {verdict.kind === "ok" && verdict.priceCents === 0 ? (
        <Text variant="caption" tone="muted">
          {String(
            t("admin.seatPricesFreeSeatHint", {
              count: panel.seatCount,
              zero,
            }),
          )}
        </Text>
      ) : null}

      {panel.canSetPrice ? (
        <YStack gap={6}>
          <label htmlFor={noteId}>
            <PanelFieldLabel
              optional={String(t("common.optional"))}
            >
              {String(t("admin.seatPricesNoteLabel"))}
            </PanelFieldLabel>
          </label>
          <CharCountTextarea
            id={noteId}
            value={noteText}
            onChange={(value) => onDraftChange({ ...draft, note: value })}
            maxLength={SEAT_PRICE_NOTE_MAX}
            minHeight={44}
            maxLines={4}
            disabled={saving}
            ariaDescribedBy={noteHintId}
          />
          <Text id={noteHintId} variant="caption" tone="muted">
            {String(t("admin.seatPricesNoteHint"))}
          </Text>
          {notesReplaced > 0 ? (
            // The write replaces the whole stored value. Said before the
            // save, with the count, because a note has no undo.
            <Text
              variant="caption"
              weight="semibold"
              data-testid="seat-price-note-warning"
            >
              {String(
                t(
                  nextNote === null
                    ? "admin.seatPricesNoteWillRemove"
                    : "admin.seatPricesNoteWillReplace",
                  { count: notesReplaced },
                ),
              )}
            </Text>
          ) : null}
        </YStack>
      ) : null}

      {panel.canSetPrice && bySection.length === 1 && replaced.length === 1 ? (
        <Text variant="caption">
          {String(
            t("admin.seatPricesReplacesOne", {
              count: panel.seatCount,
              ticketType: replaced[0]!.name,
              price:
                replaced[0]!.priceCents === null
                  ? String(t("admin.seatPricesPayWhatYouWant"))
                  : formatCents(replaced[0]!.priceCents),
            }),
          )}
        </Text>
      ) : null}
      {panel.canSetPrice && (bySection.length > 1 || replaced.length > 1) ? (
        <YStack gap={6}>
          <Text variant="caption">
            {String(
              bySection.length > 1
                ? // A seat replaces only its own section's ticket types, so a
                  // selection across sections is listed section by section.
                  t("admin.seatPricesReplacesBySection", {
                    count: panel.seatCount,
                  })
                : t(
                    replaced.length === 2
                      ? "admin.seatPricesReplacesBoth"
                      : "admin.seatPricesReplacesAll",
                    { count: panel.seatCount, types: replaced.length },
                  ),
            )}
          </Text>
          {bySection.length > 1 ? (
            bySection.map((group) => (
              <YStack key={group.sectionId} gap={2}>
                <Text variant="caption" weight="bold">
                  {group.sectionName}
                </Text>
                <TicketTypeList
                  ticketTypes={group.ticketTypes}
                  formatCents={formatCents}
                  t={t}
                />
              </YStack>
            ))
          ) : (
            <TicketTypeList
              ticketTypes={replaced}
              formatCents={formatCents}
              t={t}
            />
          )}
          {verdict.kind === "ok" ? (
            <Text variant="caption" tone="muted">
              {String(
                t("admin.seatPricesWhicheverType", {
                  count: panel.seatCount,
                  price: formatCents(verdict.priceCents),
                }),
              )}
            </Text>
          ) : null}
        </YStack>
      ) : null}

      {/* Each button takes a full row when the two do not fit side by side
          (the sidebar and the phone sheet), and shares the row otherwise. */}
      <XStack gap="$2" flexWrap="wrap">
        <Button
          variant="primary"
          size="$4"
          flexGrow={1}
          flexBasis={180}
          onPress={handleSetPrice}
          disabled={actions.setPriceDisabled}
          data-testid="seat-price-set"
        >
          {String(
            t(saving ? "admin.seatPricesSaving" : "admin.seatPricesSetPrice"),
          )}
        </Button>
        <Button
          variant="ghost"
          size="$4"
          flexGrow={1}
          flexBasis={180}
          onPress={onUseSectionPrice}
          disabled={actions.useSectionPriceDisabled}
          data-testid="seat-price-use-section-price"
        >
          {String(t("admin.seatPricesUseSectionPrice"))}
        </Button>
      </XStack>
    </YStack>
  );
}

SeatPricePanel.displayName = "SeatPricePanel";

type Translate = ReturnType<typeof useTranslations>;

/**
 * The event builder's field-label treatment (11px, 700, +1.2 tracking,
 * uppercase, muted; 12px below 600px), set as explicit props. The builder's
 * own `FieldLabel` sets size and weight as styled() defaults, and `Text`
 * re-applies its body variant's size class and an inline 400 weight over
 * them, so it renders at 16px/400 here.
 */
function PanelFieldLabel({
  children,
  optional,
}: {
  children: string;
  /** The translated "optional" word, shown muted after the label. */
  optional?: string;
}) {
  const isMobile = useIsMobile();
  return (
    <Text
      tag="span"
      tone="muted"
      fontSize={isMobile ? 12 : 11}
      lineHeight={16}
      fontWeight="700"
      letterSpacing={1.2}
      textTransform="uppercase"
    >
      {children}
      {optional ? (
        <Text
          tag="span"
          tone="muted"
          fontSize={isMobile ? 12 : 11}
          lineHeight={16}
          fontWeight="400"
          letterSpacing={0.4}
          textTransform="none"
          marginLeft={6}
        >
          ({optional})
        </Text>
      ) : null}
    </Text>
  );
}

function TicketTypeList({
  ticketTypes,
  formatCents,
  t,
}: {
  ticketTypes: PanelSelection["replacedTicketTypes"];
  formatCents: (cents: number) => string;
  t: Translate;
}) {
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        borderTop: `1px solid ${BORDER}`,
      }}
    >
      {ticketTypes.map((type) => (
        <li
          key={type.id}
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            padding: "6px 0",
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          <Text variant="caption">{type.name}</Text>
          <Text {...monoPrice} weight="semibold">
            {type.priceCents === null
              ? String(t("admin.seatPricesPayWhatYouWant"))
              : formatCents(type.priceCents)}
          </Text>
        </li>
      ))}
    </ul>
  );
}

function priceErrorMessage(
  verdict: PriceVerdict,
  t: Translate,
  zero: string,
  max: string,
): string | null {
  if (verdict.kind === "paidBlocked") {
    return String(t("admin.seatPricesPaidBlockedError", { zero }));
  }
  if (verdict.kind !== "invalid") return null;
  switch (verdict.reason) {
    case "ambiguous":
      return String(t("admin.seatPricesPriceAmbiguous"));
    case "negative":
      return String(t("admin.seatPricesPriceNegative", { zero }));
    case "tooPrecise":
      return String(t("admin.seatPricesPriceTooPrecise"));
    case "tooLarge":
      return String(t("admin.seatPricesPriceTooLarge", { max }));
    case "invalid":
      return String(t("admin.seatPricesPriceInvalid"));
  }
}

/** "Orchestra · Row A" plus the seats, as far as one line can honestly say. */
function panelHeading(
  panel: PanelSelection,
  t: Translate,
): { name: string; detail: string | null } {
  const rowLabel = (row: string) => String(t("admin.seatPricesRowName", { row }));

  if (panel.sections.length > 1) {
    return {
      name: panel.sections.map((section) => section.name).join(", "),
      detail: null,
    };
  }
  const section = panel.sections[0]!;
  const seat = panel.singleSeat;
  if (seat) {
    const parts =
      seat.row !== null && seat.number !== null
        ? [
            section.name,
            rowLabel(seat.row),
            String(t("admin.seatPricesSeatName", { seat: seat.number })),
          ]
        : [section.name, String(t("admin.seatPricesSeatName", { seat: seat.label }))];
    return { name: parts.join(" · "), detail: null };
  }

  const namedRows = section.rowNames.filter(
    (row): row is string => row !== null,
  );
  const seats =
    section.seatLabels.length <= MAX_LISTED_SEATS
      ? section.seatLabels.join(", ")
      : null;
  if (section.rowNames.length === 1) {
    return {
      name:
        namedRows.length === 1
          ? `${section.name} · ${rowLabel(namedRows[0]!)}`
          : section.name,
      detail: seats,
    };
  }
  return {
    name: section.name,
    detail:
      seats ??
      (namedRows.length > 0
        ? String(t("admin.seatPricesRowsList", { rows: namedRows.join(", ") }))
        : null),
  };
}
