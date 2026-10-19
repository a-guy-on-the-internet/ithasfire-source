"use client";

import { useMemo, useState } from "react";
import { XStack, YStack, useTheme } from "tamagui";
import { Check, CalendarRange, AlertTriangle } from "lucide-react";

import { Text, useTranslations, useFormatters } from "@th/ui";

import { useIsMobile } from "@/hooks/useIsMobile";
import { NativeDateTimeInput } from "./_form-bits";
import { formatZonedInstant } from "./ticket-type-schedule";
import {
  resolveSalesWindowBoundIso,
  type SalesWindowDraft,
  type SalesWindowProblem,
} from "./ticket-type-sales-window";

/**
 * "Limit when this tier is on sale" — the organizer-facing control for the
 * per-type sales window (FR-013), collapsed by default.
 *
 * Shaped as the deliberate twin of `TicketScheduledPriceField`: same collapsed
 * checkbox, same hand-rolled box chrome, same read-back-in-the-event's-zone
 * discipline. Three things about it are NOT copies, and each is load-bearing:
 *
 *  1. EITHER FIELD ALONE IS A COMPLETE ANSWER. The panel says so in its help
 *     text, and the resolver honours it. "Opens Friday" with no close and
 *     "closes Friday" with no open are both real configurations an organizer
 *     needs (advance-to-door handovers are exactly this), so neither input is
 *     marked required and leaving one blank never blocks a save.
 *
 *  2. THE HALF-OPEN BOUNDARY IS EXPLAINED, NOT JUST ENFORCED. `salesCloseAt` is
 *     EXCLUSIVE, so "closes at 6:00 PM" means the last sale is 5:59 PM and a
 *     sibling tier opening at 6:00 PM picks up with no gap and no overlap. An
 *     organizer building an advance/door pair has to know that to set the pair
 *     correctly, so it is stated in the panel — a comment in a source file is
 *     not a place they can read it.
 *
 *  3. IT STAYS MOUNTED FOR PAY-WHAT-YOU-WANT. The scheduled price and the door
 *     price are hidden in ADJUSTABLE mode because a buyer-chosen price has
 *     nothing to override. A window is about SELLABILITY, not amount —
 *     `upsertTicketType` deliberately does not clear it for ADJUSTABLE — so
 *     hiding it here would remove a legitimate setting from every
 *     pay-what-you-can tier.
 *
 * The inline message under the two fields is the UI half of
 * TICKET_TYPE_SALES_WINDOW_INVALID. It is PASSED IN rather than derived here:
 * the editor resolves the draft once and feeds that one answer to both this
 * message and the Add/Save button's disabled state. When this control computed
 * its own inverted-pair check, the button did not know about it — the form
 * showed a refusal and still invited the click that would fail.
 */

export type TicketSalesWindowFieldProps = {
  /** Distinguishes the add form's controls from the edit form's. */
  idPrefix: "add" | "edit";
  value: SalesWindowDraft;
  onChange: (next: SalesWindowDraft) => void;
  /**
   * `Event.timezone`. `null` while the event query is still in flight — the
   * control disables itself rather than falling back to the BROWSER's zone,
   * which is the exact mistake FR-007 exists to prevent.
   */
  timeZone: string | null;
  /**
   * The editor's resolution of THIS draft, narrowed to its refusal. `null` when
   * the draft resolves cleanly (or when the editor is not validating it — an
   * untouched edit sends nothing and therefore refuses nothing).
   *
   * Same object that disables the submit, so the two can never disagree.
   */
  problem?: SalesWindowProblem | null;
  /**
   * Render the "times are on the event's clock" footnote. The editor sets this
   * false when a SIBLING panel below is already showing it — the note is about
   * the whole form, and two copies of one sentence a few lines apart read as a
   * rendering bug.
   */
  showZoneNote?: boolean;
  disabled?: boolean;
};

export function TicketSalesWindowField({
  idPrefix,
  value,
  onChange,
  timeZone,
  problem = null,
  showZoneNote = true,
  disabled = false,
}: TicketSalesWindowFieldProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const theme = useTheme();
  const isMobile = useIsMobile();

  const testId = (suffix: string) => `ticket-type-${idPrefix}-window-${suffix}`;

  /** Drives the checked-state focus fill — see the toggle box below. */
  const [isFocused, setIsFocused] = useState(false);

  // Matches `TicketScheduledPriceField`'s `dateFieldWidth`: a datetime-local
  // needs room for "10/03/2026, 12:00 AM" plus the picker glyph, and below
  // ~240px browsers start clipping the meridiem. Full width on mobile so the
  // 44px touch target is easy to hit.
  const dateFieldWidth = isMobile
    ? ({ flex: 1, minWidth: 180, maxWidth: "100%" } as const)
    : ({ width: 240, flexGrow: 0, flexShrink: 0 } as const);

  const controlDisabled = disabled || timeZone == null;

  // Recomputed on every keystroke on purpose: a read-back that lags the fields
  // lets an organizer "verify" an instant they are no longer about to save.
  const readback = useMemo(() => {
    if (!value.enabled || !timeZone) return { opens: null, closes: null };
    const resolve = (local: string) => {
      const iso = resolveSalesWindowBoundIso(local, timeZone);
      if (!iso) return null;
      return formatZonedInstant(iso, timeZone, fmt.dateTime);
    };
    return {
      opens: resolve(value.openLocal),
      closes: resolve(value.closeLocal),
    };
  }, [
    value.enabled,
    value.openLocal,
    value.closeLocal,
    timeZone,
    fmt.dateTime,
  ]);

  // The timezone-pending refusal already has its own dedicated line at the
  // bottom of the panel; repeating it as an alert two lines up would be the
  // same duplication this control just stopped doing with the zone note.
  const inlineProblem =
    problem && problem.messageKey !== "admin.ttWindowTimezonePending"
      ? problem
      : null;

  const toggle = () => {
    if (controlDisabled) return;
    onChange(
      value.enabled
        ? // Unchecking CLEARS the fields as well as the flag. Leaving stale
          // text behind would let a re-check silently resurrect a window the
          // organizer thought they had removed.
          { enabled: false, openLocal: "", closeLocal: "" }
        : { ...value, enabled: true },
    );
  };

  return (
    <YStack gap={8} data-testid={testId("section")}>
      <XStack gap={8} alignItems="center" opacity={controlDisabled ? 0.5 : 1}>
        <XStack
          tag="button"
          // No `type="button"`: Tamagui's view props don't accept it, and
          // nothing here sits inside a <form>, so there is no implicit submit
          // to suppress — the editor's Add/Save are onPress handlers.
          role="checkbox"
          aria-checked={value.enabled}
          aria-label={String(t("admin.ttWindowToggle"))}
          disabled={controlDisabled}
          width={18}
          height={18}
          borderWidth={2}
          borderColor={value.enabled ? "$accent" : "$borderColor"}
          borderRadius={0}
          padding={0}
          alignItems="center"
          justifyContent="center"
          // Focus is tracked in React rather than left to `focusStyle` alone
          // because the DS signature — border becomes `$accent` — is a NO-OP on
          // a CHECKED box, whose border is already `$accent`. So focus
          // additionally FILLS the box, with the tick flipping to on-accent
          // ink. Unambiguous in both states, still no outline ring.
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
          <CalendarRange size={13} color={theme.colorMuted?.val} />
          <Text variant="caption" color="$color" flexShrink={1}>
            {String(t("admin.ttWindowToggle"))}
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
          {String(t("admin.ttWindowHelp"))}
        </Text>
      )}

      {value.enabled && (
        <YStack gap={10} paddingLeft={26} data-testid={testId("panel")}>
          <XStack gap={16} flexWrap="wrap">
            <YStack gap={4} {...dateFieldWidth}>
              <Text
                tag="span"
                style={{ fontSize: 11, textTransform: "uppercase" }}
                tone="muted"
              >
                {String(t("admin.ttWindowOpensAt"))}
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
                value={value.openLocal}
                disabled={controlDisabled}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  onChange({ ...value, openLocal: event.target.value })
                }
                aria-label={String(t("admin.ttWindowOpensAt"))}
                data-testid={testId("open")}
              />
              {readback.opens ? (
                <Text
                  tag="span"
                  style={{ fontSize: 12, fontWeight: "700" }}
                  color="$color"
                  data-testid={testId("open-readback")}
                >
                  {String(
                    t("admin.ttWindowOpensReadback", { when: readback.opens }),
                  )}
                </Text>
              ) : null}
            </YStack>
            <YStack gap={4} {...dateFieldWidth}>
              <Text
                tag="span"
                style={{ fontSize: 11, textTransform: "uppercase" }}
                tone="muted"
              >
                {String(t("admin.ttWindowClosesAt"))}
              </Text>
              <NativeDateTimeInput
                type="datetime-local"
                width="100%"
                maxWidth="100%"
                minWidth={0}
                value={value.closeLocal}
                disabled={controlDisabled}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  onChange({ ...value, closeLocal: event.target.value })
                }
                aria-label={String(t("admin.ttWindowClosesAt"))}
                data-testid={testId("close")}
              />
              {readback.closes ? (
                <Text
                  tag="span"
                  style={{ fontSize: 12, fontWeight: "700" }}
                  color="$color"
                  data-testid={testId("close-readback")}
                >
                  {String(
                    t("admin.ttWindowClosesReadback", {
                      when: readback.closes,
                    }),
                  )}
                </Text>
              ) : null}
            </YStack>
          </XStack>

          {/* ── The UI half of TICKET_TYPE_SALES_WINDOW_INVALID, and the reason
              the Add/Save button is disabled. Same resolution drives both, so
              the organizer never meets a refusal the button didn't already
              show — nor a dead button with nothing on screen explaining it.

              `danger` = the pair is contradictory (inverted, zero-width, an
              unreadable bound). `pending` = ticked but not filled in yet, which
              is muted and un-iconed: it appears the instant the box is ticked,
              and red-flagging someone for not having typed anything is how the
              message that matters gets ignored. ──────────────────────────── */}
          {inlineProblem && (
            <XStack
              gap={6}
              // Top-aligned, not centred: at 320px this wraps to several lines
              // and a centred icon would float in the gap between them instead
              // of marking the sentence. The 2px nudge drops it onto the first
              // line's cap height.
              alignItems="flex-start"
              // A `danger` refusal appears without the organizer acting on THIS
              // element — it materialises as they finish typing the second
              // date — so a screen-reader user would otherwise only discover it
              // by tabbing back over the region. It cannot chatter: both bounds
              // have to parse first. The `pending` line is NOT an alert: it is
              // the direct, immediate consequence of ticking the box they are
              // standing on.
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

          {/* The half-open boundary, in the organizer's language. Not a nicety:
              an advance/door pair is only set correctly if they know the
              closing time is EXCLUSIVE. */}
          <Text
            tag="span"
            style={{ fontSize: 11 }}
            tone="muted"
            data-testid={testId("boundary-note")}
          >
            {String(t("admin.ttWindowBoundaryNote"))}
          </Text>

          {/* One zone footnote per FORM, not per panel — see `showZoneNote`. */}
          {showZoneNote &&
            (timeZone == null ? (
              <Text
                tag="span"
                style={{ fontSize: 11 }}
                tone="muted"
                data-testid={testId("tz-pending")}
              >
                {String(t("admin.ttWindowTimezonePending"))}
              </Text>
            ) : (
              <Text
                tag="span"
                style={{ fontSize: 11 }}
                tone="muted"
                data-testid={testId("zone-note")}
              >
                {String(t("admin.ttWindowZoneNote", { timeZone }))}
              </Text>
            ))}
        </YStack>
      )}
    </YStack>
  );
}

TicketSalesWindowField.displayName = "TicketSalesWindowField";
