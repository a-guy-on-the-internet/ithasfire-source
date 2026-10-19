"use client";

import { useMemo, useState } from "react";
import { XStack, YStack, useTheme } from "tamagui";
import { Check, CalendarClock, AlertTriangle } from "lucide-react";

import { Text, TextInput, useTranslations, useFormatters } from "@th/ui";

import { useIsMobile } from "@/hooks/useIsMobile";
import { fmtCurrency } from "@/lib/format";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";
import { NativeDateTimeInput } from "./_form-bits";
import {
  formatZonedInstant,
  resolveScheduledPriceAtIso,
  type ScheduledPriceDraft,
  type ScheduledPriceProblem,
} from "./ticket-type-schedule";

/**
 * "Price changes later" — the organizer-facing control for FR-005's two-step
 * schedule, collapsed by default.
 *
 * Collapsed is the whole point: the overwhelming majority of ticket types are
 * one price forever (NFR-001), so this sits as a single unchecked box beside
 * "Allow resale" and costs the common case one line. Expanding it is the only
 * way to configure a schedule, and unchecking it is how you remove one — both
 * paths send the two columns TOGETHER (see `resolveScheduledPriceChange`), so
 * TICKET_TYPE_SCHEDULE_INCOMPLETE is unreachable from this UI.
 *
 * The read-back line under the fields is the FR-007 verification surface and
 * is not decoration: it renders the resolved instant on the EVENT's clock with
 * the zone abbreviation, which is the only way the organizer can tell that
 * "8pm" landed on the venue's 8pm rather than their laptop's.
 *
 * Checkbox chrome deliberately mirrors the hand-rolled "Allow resale" toggle
 * a few lines below it in the same form (18px box, 2px border, radius 0)
 * rather than `@th/ui`'s `Checkbox` — two visually different checkboxes
 * stacked in one panel is a worse outcome than one non-canonical one. Unlike
 * that sibling this box IS keyboard-operable (`tag="button"`, `role`,
 * `aria-checked`, and the DS focus state: border → `$accent`, no ring).
 * Follow-up: migrate both to the DS `Checkbox` together.
 */

export type TicketScheduledPriceFieldProps = {
  /** Distinguishes the add form's controls from the edit form's. */
  idPrefix: "add" | "edit";
  value: ScheduledPriceDraft;
  onChange: (next: ScheduledPriceDraft) => void;
  /**
   * `Event.timezone`. `null` while the event query is still in flight — the
   * control disables itself rather than falling back to the BROWSER's zone,
   * which is the exact mistake FR-007 exists to prevent.
   */
  timeZone: string | null;
  /** ISO 4217 code for the read-back's money, e.g. "usd". */
  currency?: string;
  /**
   * The editor's resolution of THIS draft, narrowed to its refusal. `null` when
   * the draft resolves cleanly (or when the editor is not validating it — an
   * untouched edit sends nothing and therefore refuses nothing).
   *
   * Same object that disables the submit, so a blocked form always says why.
   * Before it existed, an open-but-unfinished schedule stopped the save with a
   * toast the organizer only saw AFTER pressing a button the form had shown as
   * ready.
   */
  problem?: ScheduledPriceProblem | null;
  /**
   * Render the "times are on the event's clock" footnote. The editor sets this
   * false when the sales-window panel below is already showing it — the note is
   * about the whole form, and two copies of one sentence a few lines apart read
   * as a rendering bug.
   */
  showZoneNote?: boolean;
  disabled?: boolean;
};

export function TicketScheduledPriceField({
  idPrefix,
  value,
  onChange,
  timeZone,
  currency = "usd",
  problem = null,
  showZoneNote = true,
  disabled = false,
}: TicketScheduledPriceFieldProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const theme = useTheme();
  const isMobile = useIsMobile();

  const testId = (suffix: string) =>
    `ticket-type-${idPrefix}-schedule-${suffix}`;

  /** Drives the checked-state focus fill — see the toggle box below. */
  const [isFocused, setIsFocused] = useState(false);

  // Field widths mirror the add form's own `moneyFieldWidth` / `countFieldWidth`
  // one section up: on desktop a money box the width of the card "reads as an
  // empty bar and tells the organiser nothing about what belongs in it". Left
  // to `flex: 1` these two stretched to ~400px each, so a "$20.00" field was
  // three times the width of the Price field directly above it. On mobile they
  // go full width so the 44px touch targets are easy to hit.
  const moneyFieldWidth = isMobile
    ? ({ flex: 1, minWidth: 120, maxWidth: "100%" } as const)
    : ({ width: 132, flexGrow: 0, flexShrink: 0 } as const);
  // A datetime-local needs room for "10/03/2026, 12:00 AM" plus the picker
  // glyph; below ~240px browsers start clipping the meridiem.
  const dateFieldWidth = isMobile
    ? ({ flex: 1, minWidth: 180, maxWidth: "100%" } as const)
    : ({ width: 240, flexGrow: 0, flexShrink: 0 } as const);

  const controlDisabled = disabled || timeZone == null;

  // Recomputed on every keystroke on purpose: a read-back that lags the fields
  // lets an organizer "verify" an instant they are no longer about to save.
  const resolved = useMemo(() => {
    if (!value.enabled || !timeZone) return null;
    const iso = resolveScheduledPriceAtIso(value.atLocal, timeZone);
    if (!iso) return null;
    const when = formatZonedInstant(iso, timeZone, fmt.dateTime);
    if (!when) return null;
    return { iso, when, isPast: new Date(iso).getTime() <= Date.now() };
  }, [value.enabled, value.atLocal, timeZone, fmt.dateTime]);

  // Read through the SHARED parser — the same one the submit path uses — so
  // the preview can never show a number the save would refuse (or, worse, a
  // different number). Unreadable/blank simply produces no read-back; refusing
  // is the submit's job, with a toast the organizer can act on.
  const readbackCents = useMemo(() => {
    if (!value.enabled) return null;
    const parsed = parseMoneyInputToCents(value.priceDollars);
    return parsed.ok ? parsed.cents : null;
  }, [value.enabled, value.priceDollars]);

  // The timezone-pending refusal already has its own dedicated line at the
  // bottom of the panel; repeating it as an alert two lines up is noise.
  const inlineProblem =
    problem && problem.messageKey !== "admin.ttScheduleTimezonePending"
      ? problem
      : null;

  const toggle = () => {
    if (controlDisabled) return;
    onChange(
      value.enabled
        ? // Unchecking CLEARS the fields as well as the flag. Leaving stale
          // text behind would let a re-check silently resurrect a price the
          // organizer thought they had removed.
          { enabled: false, priceDollars: "", atLocal: "" }
        : { ...value, enabled: true },
    );
  };

  return (
    <YStack gap={8} data-testid={testId("section")}>
      <XStack gap={8} alignItems="center" opacity={controlDisabled ? 0.5 : 1}>
        <XStack
          tag="button"
          // No `type="button"`: Tamagui's view props don't accept it (it is a
          // type error, see BuilderHeaderBar for the same shape) and nothing
          // here sits inside a <form>, so there is no implicit submit to
          // suppress — the editor's Add/Save are onPress handlers.
          role="checkbox"
          aria-checked={value.enabled}
          aria-label={String(t("admin.ttScheduleToggle"))}
          disabled={controlDisabled}
          width={18}
          height={18}
          borderWidth={2}
          borderColor={value.enabled ? "$accent" : "$borderColor"}
          borderRadius={0}
          padding={0}
          alignItems="center"
          justifyContent="center"
          // Focus is tracked in React rather than left entirely to
          // `focusStyle` because the DS signature — border becomes `$accent` —
          // is a NO-OP on a CHECKED box, whose border is already `$accent`. A
          // keyboard user tabbing into a configured schedule would get no
          // indication of where they are, throwing away the one advantage that
          // justified hand-rolling this box instead of using `@th/ui`'s
          // Checkbox. So focus additionally FILLS the box: transparent /
          // `$accentSoft` → solid `$accent`, with the tick flipping to the
          // on-accent ink. Unambiguous in both states, still no outline ring.
          backgroundColor={
            isFocused
              ? "$accent"
              : value.enabled
                ? "$accentSoft"
                : "transparent"
          }
          cursor={controlDisabled ? "default" : "pointer"}
          focusStyle={{ borderColor: "$accent", outlineWidth: 0 }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onPress={toggle}
          data-testid={testId("toggle")}
        >
          {value.enabled && (
            <Check
              size={12}
              color={
                isFocused ? theme.onBrandSecondary?.val : theme.accent?.val
              }
            />
          )}
        </XStack>
        <XStack
          gap={8}
          alignItems="center"
          // The label is a mouse/touch affordance only — the box above is the
          // single focusable control, so tabbing never lands on a duplicate.
          cursor={controlDisabled ? "default" : "pointer"}
          minHeight={isMobile ? 44 : undefined}
          flexShrink={1}
          minWidth={0}
          onPress={toggle}
          data-testid={testId("toggle-label")}
        >
          <CalendarClock size={13} color={theme.colorMuted?.val} />
          <Text variant="caption" color="$color" flexShrink={1}>
            {String(t("admin.ttScheduleToggle"))}
          </Text>
        </XStack>
      </XStack>

      {!value.enabled && (
        <Text
          tag="span"
          style={{ fontSize: 11 }}
          tone="muted"
          paddingLeft={26}
          data-testid={testId("help")}
        >
          {String(t("admin.ttScheduleHelp"))}
        </Text>
      )}

      {value.enabled && (
        <YStack gap={10} paddingLeft={26} data-testid={testId("panel")}>
          <XStack gap={16} flexWrap="wrap">
            <YStack gap={4} {...moneyFieldWidth}>
              <Text
                tag="span"
                style={{ fontSize: 11, textTransform: "uppercase" }}
                tone="muted"
              >
                {String(t("admin.ttScheduleNewPrice"))}
              </Text>
              <TextInput
                value={value.priceDollars}
                onChangeText={(next: string) =>
                  onChange({ ...value, priceDollars: next })
                }
                placeholder="0.00"
                fullWidth
                disabled={controlDisabled}
                testId={testId("price")}
              />
            </YStack>
            <YStack gap={4} {...dateFieldWidth}>
              <Text
                tag="span"
                style={{ fontSize: 11, textTransform: "uppercase" }}
                tone="muted"
              >
                {String(t("admin.ttScheduleAt"))}
              </Text>
              <NativeDateTimeInput
                type="datetime-local"
                // `NativeDateTimeInput` is `width: "auto"`, and at the 16px
                // mobile font a datetime-local's intrinsic width is close to
                // the available 260px. Pin it to the column so the INPUT can
                // never be what overflows — the columns already wrap.
                width="100%"
                maxWidth="100%"
                minWidth={0}
                value={value.atLocal}
                disabled={controlDisabled}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  onChange({ ...value, atLocal: event.target.value })
                }
                aria-label={String(t("admin.ttScheduleAt"))}
                data-testid={testId("at")}
              />
            </YStack>
          </XStack>

          {/* ── FR-007 read-back (Q-002, RESOLVED: not optional). The
              organizer is the only person who can catch a timezone mistake,
              so this states the resolved instant on the EVENT's clock, zone
              abbreviation included. ─────────────────────────────────────── */}
          {resolved && readbackCents != null ? (
            <Text
              tag="span"
              style={{ fontSize: 12, fontWeight: "700" }}
              color="$color"
              data-testid={testId("readback")}
            >
              {String(
                t("admin.ttScheduleReadback", {
                  price: fmtCurrency(fmt, readbackCents, currency),
                  when: resolved.when,
                }),
              )}
            </Text>
          ) : null}

          {/* Why the Add/Save button is disabled, said where the organizer is
              looking. `danger` = something is wrong (unreadable money, a date
              that can't be read). `pending` = the panel is open and not filled
              in yet — muted and un-iconed, because it appears the moment the
              box is ticked. */}
          {inlineProblem && (
            <XStack
              gap={6}
              alignItems="flex-start"
              role={inlineProblem.tone === "danger" ? "alert" : undefined}
              data-testid={testId("error")}
            >
              {inlineProblem.tone === "danger" && (
                <AlertTriangle
                  size={12}
                  color={theme.danger?.val}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
              )}
              <Text
                tag="span"
                style={{ fontSize: 11 }}
                // `$colorMuted` is what `tone="muted"` resolves to; written as
                // a colour so the two tones are one expression.
                color={
                  inlineProblem.tone === "danger" ? "$danger" : "$colorMuted"
                }
                flexShrink={1}
              >
                {String(t(inlineProblem.messageKey))}
              </Text>
            </XStack>
          )}

          {resolved?.isPast && (
            <XStack
              gap={6}
              // Top-aligned, not centred: at 320px this warning wraps to two
              // lines and a centred icon floats in the gap between them
              // instead of reading as the marker for the sentence. The 2px
              // nudge drops it onto the first line's cap height.
              alignItems="flex-start"
              data-testid={testId("past")}
            >
              <AlertTriangle
                size={12}
                color={theme.warning?.val}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <Text
                tag="span"
                style={{ fontSize: 11 }}
                tone="muted"
                flexShrink={1}
              >
                {String(t("admin.ttSchedulePastWarning"))}
              </Text>
            </XStack>
          )}

          {/* One zone footnote per FORM, not per panel — see `showZoneNote`. */}
          {showZoneNote &&
            (timeZone == null ? (
              <Text
                tag="span"
                style={{ fontSize: 11 }}
                tone="muted"
                data-testid={testId("tz-pending")}
              >
                {String(t("admin.ttScheduleTimezonePending"))}
              </Text>
            ) : (
              <Text
                tag="span"
                style={{ fontSize: 11 }}
                tone="muted"
                data-testid={testId("zone-note")}
              >
                {String(t("admin.ttScheduleZoneNote", { timeZone }))}
              </Text>
            ))}
        </YStack>
      )}
    </YStack>
  );
}

TicketScheduledPriceField.displayName = "TicketScheduledPriceField";
