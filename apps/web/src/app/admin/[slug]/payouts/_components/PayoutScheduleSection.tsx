"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  YStack,
  XStack,
  styled,
  useTheme,
  type TamaguiElement,
} from "tamagui";
import { Text, Button, Spinner, useNotify, useTranslations } from "@th/ui";
import { Check, Info } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import type { PayoutSchedule } from "@th/types";
import { isForbiddenError } from "../_lib/is-forbidden-error";
import { DisclosureButton } from "./PayoutsSections";
import {
  isSelectionKey,
  nextScheduleForKey,
  scheduleOptionDomId,
} from "./payout-schedule-nav.helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The five schedules. Copy is i18n KEYS (admin namespace), translated at
 * render. The facts are load-bearing: Sundays, midnight CT, two business
 * days to clear; change them only with the batch (and `payoutSchedTimingLine`).
 */
const SCHEDULE_OPTIONS: {
  value: PayoutSchedule;
  titleKey: string;
  descriptionKey: string;
  /** One sentence: when it is released. The settings row's summary. */
  shortKey: string;
}[] = [
  {
    value: "ASAP",
    titleKey: "admin.payoutSchedAsapTitle",
    descriptionKey: "admin.payoutSchedAsapBody",
    shortKey: "admin.payoutSchedAsapShort",
  },
  {
    value: "WEEK_OF_EVENT",
    titleKey: "admin.payoutSchedWeekOfTitle",
    descriptionKey: "admin.payoutSchedWeekOfBody",
    shortKey: "admin.payoutSchedWeekOfShort",
  },
  {
    value: "ONE_WEEK_AFTER",
    titleKey: "admin.payoutSchedOneWeekTitle",
    descriptionKey: "admin.payoutSchedOneWeekBody",
    shortKey: "admin.payoutSchedOneWeekShort",
  },
  {
    value: "TWO_WEEKS_AFTER",
    titleKey: "admin.payoutSchedTwoWeeksTitle",
    descriptionKey: "admin.payoutSchedTwoWeeksBody",
    shortKey: "admin.payoutSchedTwoWeeksShort",
  },
  {
    value: "FOUR_WEEKS_AFTER",
    titleKey: "admin.payoutSchedFourWeeksTitle",
    descriptionKey: "admin.payoutSchedFourWeeksBody",
    shortKey: "admin.payoutSchedFourWeeksShort",
  },
];

/**
 * Keyboard order for the radio group, derived from the rendered list so the two
 * can never drift — adding an option to SCHEDULE_OPTIONS puts it in the arrow
 * order automatically.
 */
const SCHEDULE_VALUE_ORDER: readonly PayoutSchedule[] = SCHEDULE_OPTIONS.map(
  (o) => o.value,
);

/**
 * The i18n key of the option title the radio group shows for a schedule.
 * The settings row's summary reads it from here so the two can never name the
 * same schedule differently. Null for an unknown value.
 */
export function payoutScheduleTitleKey(value: string): string | null {
  return SCHEDULE_OPTIONS.find((o) => o.value === value)?.titleKey ?? null;
}

/** DOM id of the disclosed picker (the Change button's `aria-controls`). */
export const PAYOUT_SCHEDULE_PICKER_ID = "payout-schedule-picker";

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const OptionRow = styled(XStack, {
  name: "ScheduleOptionRow",
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: "$3",
  gap: "$3",
  alignItems: "flex-start",
  variants: {
    selected: {
      true: {
        borderColor: "$accent",
        backgroundColor: "$backgroundHover",
      },
    },
    /**
     * The hover/cursor affordance is a VARIANT, not a `hoverStyle` prop
     * override, because a prop-level `hoverStyle={{}}` MERGES with the styled
     * definition rather than replacing it — a base hover rule survived it, so
     * read-only rows still lit up under the cursor and advertised an
     * interaction that does nothing. Declaring the affordance only on the
     * `true` branch means the inert state has no hover rule at all.
     */
    interactive: {
      true: {
        cursor: "pointer",
        hoverStyle: {
          backgroundColor: "$backgroundHover",
        },
      },
      false: {
        cursor: "default",
      },
    },
  } as const,
});

const RadioDot = styled(XStack, {
  name: "RadioDot",
  width: 20,
  height: 20,
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  alignItems: "center",
  justifyContent: "center",
  marginTop: 2,
  variants: {
    selected: {
      true: {
        borderColor: "$accent",
      },
    },
  } as const,
});

const RadioDotInner = styled(XStack, {
  name: "RadioDotInner",
  width: 10,
  height: 10,
  borderRadius: 0,
  backgroundColor: "$accent",
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type PayoutScheduleEntity =
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string };

export type PayoutScheduleSectionProps = {
  entity: PayoutScheduleEntity;
  /**
   * Whether the actor may change the payout schedule. Mirrors the server
   * `agreements.updatePayoutSchedule` check (ORG_FINANCE_ROLES). When false the
   * section renders read-only: the current schedule stays visible but the
   * option rows and Save/Cancel controls are suppressed. Defaults to `true` so
   * existing callers keep their behaviour.
   */
  canEdit?: boolean;
  /**
   * Whether the entity's Stripe payout onboarding is complete (a usable payee
   * exists). Only consulted when the entity has NO payout terms yet: the
   * server-side `updatePayoutSchedule` provisions default terms on demand, but
   * throws `PAYEE_NOT_READY` without a usable payee — so pre-terms we disable
   * the picker and point at the Stripe Connect section instead of letting the
   * save fail. Once terms exist this prop has no effect. Defaults to `true` so
   * existing callers keep their behaviour.
   */
  payoutsReady?: boolean;
  /**
   * Id of the row heading that names the section (the Payouts page's
   * "Payout schedule" overline). The radiogroup takes its accessible name
   * from it, so the announced label can never drift from the visible one.
   */
  labelledBy: string;
  /**
   * The "finish setup first" note, shown in the summary while setup blocks
   * the picker. The caller says where the setup is.
   */
  setupRequiredMessage: string;
  /**
   * The Payouts page's Settings row (board B, 2026-10-14): a one-line summary
   * — the current schedule, when it releases, "every schedule costs the
   * same" — and a "Change schedule" button that discloses the full picker
   * with its trade-off notes. Controlled, so a jump to `#schedule` can open
   * it.
   */
  disclosure: { open: boolean; onOpenChange: (open: boolean) => void };
};

export function PayoutScheduleSection({
  entity,
  canEdit = true,
  payoutsReady = true,
  labelledBy,
  setupRequiredMessage,
  disclosure,
}: PayoutScheduleSectionProps) {
  const theme = useTheme();
  const { toast } = useNotify();
  const t = useTranslations();

  const payoutTermsQuery = trpc.agreements.getDefaultPayoutTerms.useQuery(
    { entity },
    { staleTime: 30_000 },
  );

  const currentSchedule = payoutTermsQuery.data?.primaryPayoutTerms
    ?.payoutSchedule as PayoutSchedule | undefined;

  const [pendingSchedule, setPendingSchedule] = useState<PayoutSchedule | null>(
    null,
  );

  // Save and Cancel unmount once they have done their job, which would drop
  // focus to <body>. The toggle takes it back after the render that removed
  // them (it may still be disabled during that render) — but only if focus
  // really was lost: if the organiser has moved on, it stays where they put it.
  const toggleRef = useRef<TamaguiElement>(null);
  const [refocusToggle, setRefocusToggle] = useState(false);
  useEffect(() => {
    if (!refocusToggle) return;
    setRefocusToggle(false);
    const active = document.activeElement;
    const picker = document.getElementById(PAYOUT_SCHEDULE_PICKER_ID);
    const lost =
      !active || active === document.body || Boolean(picker?.contains(active));
    if (lost) (toggleRef.current as HTMLElement | null)?.focus?.();
  }, [refocusToggle]);

  const utils = trpc.useUtils();
  const updateMutation = trpc.agreements.updatePayoutSchedule.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: (saved) => {
      // Write the saved schedule into the cache first, so the summary names
      // it even if the refetch below fails.
      utils.agreements.getDefaultPayoutTerms.setData({ entity }, (prev) => ({
        // The server names the terms row it wrote; trust it over the cache.
        defaultPrimaryPayoutTermsId: saved.payoutTermsId,
        defaultResalePayoutTermsId: prev?.defaultResalePayoutTermsId ?? null,
        resalePayoutTerms: prev?.resalePayoutTerms ?? null,
        primaryPayoutTerms: {
          ...(prev?.primaryPayoutTerms ?? {}),
          id: saved.payoutTermsId,
          payoutSchedule: saved.payoutSchedule,
        },
      }));
      void payoutTermsQuery.refetch();
      setPendingSchedule(null);
    },
  });

  // No terms row yet (pre-first-event). The server provisions default terms on
  // save, so the picker stays live — UNLESS payout onboarding is incomplete, in
  // which case saving would throw PAYEE_NOT_READY, so we disable it instead.
  const noPayoutTerms = Boolean(
    payoutTermsQuery.data && !payoutTermsQuery.data.primaryPayoutTerms,
  );
  const setupRequired = noPayoutTerms && !payoutsReady;
  const interactive = canEdit && !setupRequired;

  const handleSelect = useCallback(
    (value: PayoutSchedule) => {
      if (!interactive) return;
      setPendingSchedule(value);
    },
    [interactive],
  );

  const handleSave = useCallback(async () => {
    if (!pendingSchedule) return;
    try {
      await updateMutation.mutateAsync({
        entity,
        payoutSchedule: pendingSchedule,
      });
      toast.success({
        id: "payout-schedule-saved",
        title: String(t("admin.payoutSchedSaved")),
        message: "",
      });
      // Saved: the summary line now names the new schedule, so the picker
      // can fold away. A FAILED save keeps it open with the pick in place.
      disclosure.onOpenChange(false);
      setRefocusToggle(true);
    } catch (error) {
      toast.danger({
        id: "payout-schedule-failed",
        title: String(t("admin.payoutSchedSaveFailed")),
        // Thread `t` so catalog copy for error codes (e.g.
        // `errors.payeeNotReady`) is consulted instead of the generic fallback.
        message: formatErrorMessage(error, t),
      });
    }
  }, [entity, pendingSchedule, updateMutation, toast, t, disclosure]);

  const handleCancel = useCallback(() => {
    setPendingSchedule(null);
    setRefocusToggle(true);
  }, []);

  // ARIA radio-group keys. Arrows move focus AND selection together (the radio
  // pattern, unlike a listbox); Space selects whatever Tab landed on. Focus is
  // moved by DOM id so the roving tabindex stays coherent — same approach as
  // the admin tablists (`embeds-tab-nav.helpers.ts`).
  const handleOptionKeyDown = useCallback(
    (optionValue: PayoutSchedule) =>
      (e: { key: string; preventDefault: () => void }) => {
        if (!interactive) return;

        if (isSelectionKey(e.key)) {
          e.preventDefault();
          handleSelect(optionValue);
          return;
        }

        const target = nextScheduleForKey(
          optionValue,
          e.key,
          SCHEDULE_VALUE_ORDER,
        );
        if (!target) return;
        e.preventDefault();
        handleSelect(target);
        document.getElementById(scheduleOptionDomId(target))?.focus();
      },
    [interactive, handleSelect],
  );

  // Which value to show as selected in the UI. With no terms row yet
  // `currentSchedule` is undefined, so nothing renders selected until the user
  // picks — and any pick counts as an unsaved change.
  const activeSchedule = pendingSchedule ?? currentSchedule;
  const hasUnsavedChange =
    pendingSchedule != null && pendingSchedule !== currentSchedule;

  // The terms read is ORG_EDIT_OR_FINANCE_ROLES. A VIEWER who opens the
  // page by URL gets a plain role notice, not an empty picker.
  if (isForbiddenError(payoutTermsQuery.error)) {
    return (
      <Text
        variant="body"
        tone="muted"
        data-testid="payout-schedule-role-notice"
      >
        {String(t("admin.payoutsRoleNoticeAccount"))}
      </Text>
    );
  }

  // Any other failed read: the current schedule is unknown. Saying "Not
  // chosen yet" would be false, and an unselected picker could overwrite the
  // real schedule, so there is no Change button until the read succeeds.
  if (payoutTermsQuery.error && !payoutTermsQuery.data) {
    return (
      <XStack
        gap="$3"
        alignItems="center"
        flexWrap="wrap"
        data-testid="payout-schedule-load-failed"
      >
        <Text variant="body" tone="muted" flexShrink={1}>
          {String(t("admin.payoutSchedLoadFailed"))}
        </Text>
        <Button
          variant="secondary"
          size="$4"
          onPress={() => void payoutTermsQuery.refetch()}
          data-testid="payout-schedule-retry"
        >
          {String(t("admin.retry"))}
        </Button>
      </XStack>
    );
  }

  if (payoutTermsQuery.isLoading) {
    return (
      <YStack minHeight={44} justifyContent="center" aria-busy>
        <Spinner size="sm" />
      </YStack>
    );
  }

  // The picker itself: the one rule about which events a change reaches, the
  // five options (each carries its own refund trade-off), Save. The setup
  // note, the timing facts and "costs the same" sit in the summary, so each
  // is said once.
  const picker = (
    <>
      {setupRequired ? null : (
        <YStack
          gap="$2"
          padding="$3"
          borderRadius="$0"
          backgroundColor="$backgroundHover"
        >
          <XStack gap="$2" alignItems="flex-start">
            <Info
              size={16}
              color={theme.colorMuted?.val}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <Text variant="caption" tone="muted" flex={1}>
              {String(t("admin.payoutSchedAppliesToNew"))}
            </Text>
          </XStack>
        </YStack>
      )}

      <YStack
        gap="$2"
        role="radiogroup"
        aria-labelledby={labelledBy}
        // Dimmed only while setup blocks the picker (the note above says
        // why, at full contrast). Read-only for a role is NOT dimmed — the
        // current schedule is real information for them.
        opacity={setupRequired ? 0.5 : 1}
        data-dimmed={setupRequired ? "true" : undefined}
        {...(interactive ? {} : { "aria-disabled": true })}
      >
        {SCHEDULE_OPTIONS.map((option, index) => {
          const isSelected = activeSchedule === option.value;
          const isFirst = index === 0;
          return (
            <OptionRow
              key={option.value}
              selected={isSelected}
              interactive={interactive}
              onPress={
                interactive ? () => handleSelect(option.value) : undefined
              }
              id={scheduleOptionDomId(option.value)}
              role="radio"
              aria-checked={isSelected}
              {...(interactive
                ? {
                    // Roving tabindex: exactly one row is in the Tab order, so
                    // the group is a single tab stop and arrows move within it.
                    // With nothing selected yet the first row is the entry
                    // point.
                    tabIndex: isSelected || (!activeSchedule && isFirst) ? 0 : -1,
                    onKeyDown: handleOptionKeyDown(option.value),
                    // Focus indication is deliberately left to the UA focus
                    // ring (measured present). An accent border here would be
                    // byte-identical to the `selected` variant's border, so a
                    // focused-but-unselected row — reachable before the first
                    // save — would read as chosen when it isn't.
                  }
                : { "aria-disabled": true, tabIndex: -1 })}
              data-testid={`schedule-option-${option.value}`}
            >
              <RadioDot selected={isSelected}>
                {isSelected && <RadioDotInner />}
              </RadioDot>
              <YStack flex={1} gap="$1">
                {/*
                  Tamagui's web Stack defaults to `flex-shrink: 0`, so at 320px
                  the title wraps but the "Current" chip cannot shrink and
                  spills past the row's right border. Wrap + shrink drops the chip onto
                  its own line instead.
                */}
                <XStack gap="$2" alignItems="center" flexWrap="wrap">
                  <Text
                    variant="body"
                    weight="bold"
                    color="$color"
                    flexShrink={1}
                    minWidth={0}
                  >
                    {String(t(option.titleKey))}
                  </Text>
                  {currentSchedule === option.value && !hasUnsavedChange && (
                    <XStack gap="$1" alignItems="center" flexShrink={1}>
                      <Check
                        size={12}
                        color={theme.success?.val}
                        strokeWidth={3}
                        style={{ flexShrink: 0 }}
                      />
                      <Text variant="caption" tone="success" flexShrink={1}>
                        {String(t("admin.payoutSchedCurrent"))}
                      </Text>
                    </XStack>
                  )}
                </XStack>
                <Text variant="caption" tone="muted">
                  {String(t(option.descriptionKey))}
                </Text>
              </YStack>
            </OptionRow>
          );
        })}
      </YStack>

      {interactive && hasUnsavedChange && (
        <XStack gap="$2" justifyContent="flex-end">
          <Button
            variant="ghost"
            size="$3"
            onPress={handleCancel}
            disabled={updateMutation.isPending}
          >
            {String(t("admin.cancel"))}
          </Button>
          <Button
            variant="primary"
            size="$3"
            onPress={handleSave}
            disabled={updateMutation.isPending}
            data-testid="save-payout-schedule-btn"
          >
            {updateMutation.isPending
              ? String(t("admin.saving"))
              : String(t("admin.payoutSchedSave"))}
          </Button>
        </XStack>
      )}
    </>
  );

  const currentOption = SCHEDULE_OPTIONS.find((o) => o.value === currentSchedule);

  // A pick not yet saved, or a save in flight, holds the picker open: folding
  // it would hide the unsaved choice (and its Save) from the organiser.
  const holdOpen = hasUnsavedChange || updateMutation.isPending;

  const { open, onOpenChange } = disclosure;
  return (
    <YStack gap="$3" data-testid="payout-schedule-section">
      <YStack gap="$1" data-testid="payout-schedule-summary">
        <Text variant="body" weight="bold">
          {currentOption
            ? String(t(currentOption.titleKey))
            : currentSchedule ?? String(t("admin.payoutSchedNoneYet"))}
        </Text>
        <Text variant="caption" tone="muted">
          {currentOption
            ? `${String(t(currentOption.shortKey))} ${String(
                t("admin.payoutSchedSameCost"),
              )}`
            : String(t("admin.payoutSchedSameCost"))}
        </Text>
        <Text
          variant="caption"
          tone="muted"
          data-testid="payout-schedule-timing"
        >
          {String(t("admin.payoutSchedTimingLine"))}
        </Text>
        {setupRequired && (
          <Text
            variant="caption"
            tone="muted"
            data-testid="payout-schedule-setup-required"
          >
            {setupRequiredMessage}
          </Text>
        )}
      </YStack>
      <DisclosureButton
        ref={toggleRef}
        open={open}
        onToggle={() => {
          if (open && holdOpen) return;
          onOpenChange(!open);
        }}
        disabled={open && holdOpen}
        controlsId={PAYOUT_SCHEDULE_PICKER_ID}
        label={String(
          t(interactive ? "admin.payoutSchedChange" : "admin.payoutSchedSeeAll"),
        )}
        testId="payout-schedule-toggle"
      />
      {/* Always in the DOM (hidden when folded): `aria-controls` must
          point at an element that exists. */}
      <YStack
        id={PAYOUT_SCHEDULE_PICKER_ID}
        gap="$4"
        display={open ? "flex" : "none"}
        data-testid="payout-schedule-picker"
        data-open={open ? "true" : "false"}
      >
        {open && picker}
      </YStack>
    </YStack>
  );
}

export default PayoutScheduleSection;
