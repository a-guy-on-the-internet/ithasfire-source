"use client";

import { useTheme, XStack, YStack } from "tamagui";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { Text, TextInput, useLocale, useTranslations } from "@th/ui";
import type { AddressRevealPreset, EventLocationMode } from "@th/types";
import { useImperial } from "@/hooks/useImperial";
import { formatObfuscationRadius } from "@/lib/location/obfuscation-radius";
import { RadiusSlider } from "@/components/places/RadiusSlider";
import {
  ceilingLocksExact,
  ceilingRadiusFloor,
  type VenueLocationCeiling,
} from "@/lib/places/venue-location-ceiling";
import {
  HIDDEN_SLIDER_POSITION,
  radiusForSliderPosition,
  sliderPositionForRadius,
} from "./event-builder-helpers";
import { DateTimeLocalInput } from "@/components/forms/DateTimeLocalInput";

// ── Props ────────────────────────────────────────────────────────────────────

export type LocationVisibilitySectionProps = {
  visibilityMode: EventLocationMode;
  /** Obfuscation radius in meters; null = FULLY HIDDEN (no public map). */
  visibilityRadius: number | null;
  visibilityLabel: string;
  addressRevealPreset: AddressRevealPreset;
  addressRevealAt: string;
  eventTimezone?: string;
  countryCode: string | undefined;
  /** Disables every control (e.g. while the event is saving). */
  disabled?: boolean;
  /** Inline validation error for the CUSTOM reveal datetime (set on save attempt). */
  customRevealError?: string | null;
  /**
   * THE VENUE CEILING (place-address-withholding). An event at a venue that
   * withholds its address cannot publish one either — the server enforces it
   * inside the save transaction and again on read. This prop is what makes the
   * lock LEGIBLE: the exact-address option is marked unavailable and the reason
   * names the venue, rather than the organizer meeting a dead radio.
   *
   * Omitted defaults to `{ state: "none" }` for the freeform-address path,
   * which genuinely has no venue to inherit from.
   */
  venueCeiling?: VenueLocationCeiling;
  /**
   * Whether the viewer MANAGES the selected venue (passes `canManagePlace`).
   * Decides whether the reveal-timing notice below the select is shown: at a
   * venue that withholds its address, someone else's event only releases it
   * once the venue confirms, and never earlier than a day before the start,
   * so the organizer's reveal choice is not the whole story. A venue manager
   * saving there is not in that position.
   *
   * Omitted = false: the notice shows whenever the ceiling is a confirmed
   * withhold. Telling a manager one sentence too many is the cheap mistake;
   * letting an organizer believe "Immediately" means immediately is not.
   */
  viewerManagesVenue?: boolean;
  /**
   * The selected place is ARCHIVED (its name), or null. Its privacy read
   * failed for good, so the ceiling stays `checking` and the exact option
   * stays locked, but "checking … until it answers" would never come true:
   * the lock names the real cause instead.
   */
  placeArchivedName?: string | null;
  onVisibilityModeChange: (mode: EventLocationMode) => void;
  onVisibilityRadiusChange: (radius: number | null) => void;
  onVisibilityLabelChange: (label: string) => void;
  onAddressRevealPresetChange: (preset: AddressRevealPreset) => void;
  onAddressRevealAtChange: (value: string) => void;
};

// ── Component ────────────────────────────────────────────────────────────────

export function LocationVisibilitySection({
  visibilityMode,
  visibilityRadius,
  visibilityLabel,
  addressRevealPreset,
  addressRevealAt,
  eventTimezone,
  countryCode,
  disabled = false,
  customRevealError,
  venueCeiling = { state: "none" },
  viewerManagesVenue = false,
  placeArchivedName = null,
  onVisibilityModeChange,
  onVisibilityRadiusChange,
  onVisibilityLabelChange,
  onAddressRevealPresetChange,
  onAddressRevealAtChange,
}: LocationVisibilitySectionProps) {
  const theme = useTheme();
  const t = useTranslations();
  const locale = useLocale();
  const [imperial, toggleImperial] = useImperial(countryCode);

  const isHidden = visibilityRadius === null;
  const sliderPosition = sliderPositionForRadius(visibilityRadius);

  // ── The venue ceiling, resolved once ──────────────────────────────────────
  const exactLocked = ceilingLocksExact(venueCeiling);
  const radiusFloorMeters = ceilingRadiusFloor(venueCeiling);
  // A circle ceiling makes every tighter stop unreachable; a fully-hidden
  // ceiling removes the slider entirely (there is one legal value left).
  const minSliderPosition =
    radiusFloorMeters === null ? 0 : sliderPositionForRadius(radiusFloorMeters);
  const shownSliderPosition = Math.max(sliderPosition, minSliderPosition);
  // The circle the public is actually shown: the stored radius snapped UP to
  // its ladder rung and never under the venue's floor — the stop the thumb
  // sits on. The preview line and `aria-valuetext` format THIS, never the raw
  // radius: a legacy 700 m row is drawn at 1 km, and "700 m" would claim a
  // tighter circle than anyone sees. Null = fully hidden.
  const drawnRadius = radiusForSliderPosition(shownSliderPosition);
  const venueForcesHidden = venueCeiling.state === "hidden";
  const ceilingNotice =
    venueCeiling.state === "hidden"
      ? String(
          t("admin.ebVisibilityLockedByVenueHidden", {
            venue: venueCeiling.venueName,
          }),
        )
      : venueCeiling.state === "area"
        ? String(
            t("admin.ebVisibilityLockedByVenueArea", {
              venue: venueCeiling.venueName,
            }),
          )
        : venueCeiling.state === "checking"
          ? placeArchivedName !== null
            ? String(
                t("communityCreate.pfArchivedTitle", {
                  name: placeArchivedName,
                }),
              )
            : String(t("admin.ebVisibilityLockedChecking"))
          : null;
  // An archived place never answers, so the lock says what to do about it.
  const ceilingNoticeAction =
    venueCeiling.state === "checking" && placeArchivedName !== null
      ? String(t("communityCreate.pfIsArchivedBody"))
      : null;
  // The reveal select is the organizer's choice, but at a venue that hides its
  // address it is not the last word: the venue's confirmation gates it, and a
  // confirmed event still reveals no earlier than a day before the start. Only
  // for a KNOWN withhold (`checking` is unknown, and this states a fact), and
  // not under NEVER, which is already stricter than anything the venue adds.
  const revealGatedByVenue =
    (venueCeiling.state === "area" || venueCeiling.state === "hidden") &&
    !viewerManagesVenue &&
    addressRevealPreset !== "NEVER";

  const formatDistance = (meters: number): string =>
    formatObfuscationRadius(meters, { imperial, locale });

  // Raw <select>/<input> can't take Tamagui $tokens, so these read the theme
  // CSS vars directly. Fallbacks are the Stub values — Stub is what SSR paints
  // before the theme injector hydrates.
  const nativeInputStyle = {
    width: "100%",
    border: "2px solid var(--borderColorStrong, #000000)",
    borderRadius: 0,
    background: "var(--background, #F6F0E4)",
    color: "var(--color, #211C16)",
    padding: "10px 12px",
    opacity: disabled ? 0.6 : 1,
  } as const;

  return (
    <>
      <Text variant="caption" tone="muted">
        {String(t("admin.ebLocationVisibilityHint"))}
      </Text>

      {/* ── Mode choice cards: Exact address / Obscured ─────────────────── */}
      <XStack gap={12} marginTop={8} $xs={{ flexDirection: "column" } as never}>
        {(
          [
            {
              value: "EXACT" as const,
              label: String(t("admin.ebVisibilityExactAddress")),
              description: String(t("admin.ebVisibilityExactAddressDesc")),
              icon: ShieldCheck,
              testId: "visibility-mode-exact",
            },
            {
              value: "OBSCURED" as const,
              label: String(t("admin.ebVisibilityObscured")),
              description: String(t("admin.ebVisibilityObscuredDesc")),
              icon: ShieldOff,
              testId: "visibility-mode-obscured",
            },
          ] as const
        ).map(({ value, label, description, icon: Icon, testId }) => {
          const selected = visibilityMode === value;
          // The venue ceiling only ever forbids EXACT — being MORE private is
          // always allowed. `checking` counts: unknown locks, it does not open.
          const lockedByVenue = value === "EXACT" && exactLocked;
          const inert = disabled || lockedByVenue;
          return (
            <YStack
              key={value}
              tag="button"
              flex={1}
              minHeight={44}
              paddingVertical={12}
              paddingHorizontal={14}
              gap={4}
              alignItems="flex-start"
              borderWidth={2}
              borderColor={selected ? "$accent" : "$borderColorStrong"}
              borderRadius={0}
              backgroundColor={selected ? "$accent" : "$surface"}
              cursor={inert ? "default" : "pointer"}
              opacity={inert ? 0.6 : 1}
              disabled={inert}
              aria-pressed={selected}
              // `aria-disabled` alongside the real `disabled`: the card stays
              // in the tab order when the venue is what locks it, because the
              // explanation below is the thing a keyboard user needs to reach,
              // and a control that silently vanishes from the tab order takes
              // its own reason with it.
              aria-disabled={lockedByVenue || undefined}
              aria-describedby={
                lockedByVenue ? "visibility-venue-ceiling" : undefined
              }
              onPress={() => {
                if (!inert) onVisibilityModeChange(value);
              }}
              hoverStyle={
                inert
                  ? undefined
                  : {
                      backgroundColor: selected ? "$accent" : "$surfaceMuted",
                    }
              }
              focusStyle={{
                outlineWidth: 2,
                outlineStyle: "solid",
                outlineColor: "$accent",
                outlineOffset: 2,
              }}
              data-testid={testId}
              data-locked-by-venue={lockedByVenue ? "true" : undefined}
            >
              <XStack gap={6} alignItems="center" flexWrap="wrap">
                <Icon
                  size={14}
                  color={selected ? theme.colorInverted?.val : theme.color?.val}
                  aria-hidden
                />
                <Text
                  variant="overline"
                  color={selected ? "$colorInverted" : "$color"}
                >
                  {label}
                </Text>
                {lockedByVenue && (
                  <Text
                    variant="overline"
                    color="$colorMuted"
                    data-testid="visibility-exact-unavailable"
                  >
                    {String(t("admin.ebVisibilityExactUnavailable"))}
                  </Text>
                )}
              </XStack>
              <Text
                variant="caption"
                color={selected ? "$colorInverted" : "$colorMuted"}
                style={{ textAlign: "left" }}
              >
                {description}
              </Text>
            </YStack>
          );
        })}
      </XStack>

      {/* WHY the exact option is unavailable, naming the venue. A disabled
          radio with no reason reads as a bug; this reads as a decision
          somebody else already made, which is what it is. */}
      {ceilingNotice && (
        <YStack
          id="visibility-venue-ceiling"
          marginTop={10}
          paddingVertical={10}
          paddingHorizontal={12}
          borderLeftWidth={3}
          borderLeftColor="$accent"
          backgroundColor="$surfaceMuted"
          data-testid="visibility-venue-ceiling"
        >
          <Text variant="bodySmall">{ceilingNotice}</Text>
          {ceilingNoticeAction && (
            <Text variant="bodySmall">{ceilingNoticeAction}</Text>
          )}
        </YStack>
      )}

      {visibilityMode === "OBSCURED" && (
        <>
          {/* ── Public precision slider (radius → Hidden end-stop) ──────── */}
          <YStack gap={8} marginTop={16}>
            <XStack gap={8} alignItems="center" justifyContent="space-between">
              <Text variant="overline">
                {String(t("admin.ebPublicPrecision"))}
              </Text>
              <XStack
                gap={0}
                borderWidth={2}
                borderColor="$borderColor"
                borderRadius={0}
                overflow="hidden"
                data-testid="unit-toggle"
              >
                <XStack
                  tag="button"
                  // ≥44px hit target (matches the mode cards' minHeight={44});
                  // the caption text keeps the toggle visually light.
                  minHeight={44}
                  minWidth={44}
                  paddingHorizontal={10}
                  alignItems="center"
                  justifyContent="center"
                  cursor={disabled ? "default" : "pointer"}
                  disabled={disabled}
                  aria-pressed={!imperial}
                  aria-label={String(t("admin.ebUnitsMetricAria"))}
                  backgroundColor={!imperial ? "$accentSoft" : "transparent"}
                  onPress={() => {
                    if (!disabled && imperial) toggleImperial();
                  }}
                >
                  <Text
                    variant="caption"
                    weight={!imperial ? "semibold" : "regular"}
                    color={!imperial ? "$accent" : "$colorMuted"}
                  >
                    km
                  </Text>
                </XStack>
                <XStack width={1} backgroundColor="$borderColor" />
                <XStack
                  tag="button"
                  // ≥44px hit target (matches the mode cards' minHeight={44}).
                  minHeight={44}
                  minWidth={44}
                  paddingHorizontal={10}
                  alignItems="center"
                  justifyContent="center"
                  cursor={disabled ? "default" : "pointer"}
                  disabled={disabled}
                  aria-pressed={imperial}
                  aria-label={String(t("admin.ebUnitsImperialAria"))}
                  backgroundColor={imperial ? "$accentSoft" : "transparent"}
                  onPress={() => {
                    if (!disabled && !imperial) toggleImperial();
                  }}
                >
                  <Text
                    variant="caption"
                    weight={imperial ? "semibold" : "regular"}
                    color={imperial ? "$accent" : "$colorMuted"}
                  >
                    mi
                  </Text>
                </XStack>
              </XStack>
            </XStack>
            <RadiusSlider
              // The venue's own circle is a FLOOR: every tighter stop below it
              // is a precision the server would clamp away on save, so it is
              // removed from the track rather than offered and overruled.
              min={minSliderPosition}
              max={HIDDEN_SLIDER_POSITION}
              step={1}
              value={shownSliderPosition}
              disabled={disabled || venueForcesHidden}
              onChange={(e) =>
                onVisibilityRadiusChange(
                  radiusForSliderPosition(
                    Math.max(Number(e.target.value), minSliderPosition),
                  ),
                )
              }
              aria-label={String(t("admin.ebPublicPrecisionSliderAria"))}
              aria-valuetext={
                drawnRadius === null
                  ? String(t("admin.ebPrecisionHiddenStop"))
                  : String(
                      t("admin.ebPublicPrecisionCircleValue", {
                        distance: formatDistance(drawnRadius),
                      }),
                    )
              }
              data-testid="visibility-radius-slider"
              style={{ width: "100%" }}
            />
            <XStack justifyContent="space-between" gap={8}>
              <Text variant="caption" tone="muted">
                {String(t("admin.ebPrecisionTightCircle"))}
              </Text>
              <Text
                variant="caption"
                weight={isHidden ? "bold" : "regular"}
                color={isHidden ? "$color" : "$colorMuted"}
              >
                {String(t("admin.ebPrecisionHiddenStop"))}
              </Text>
            </XStack>
            {/* Live preview of the public pre-reveal view. Fixed min height so
                toggling between the two strings doesn't shift the layout. */}
            <XStack
              minHeight={24}
              alignItems="center"
              data-testid="visibility-public-preview"
              aria-live="polite"
            >
              <Text variant="bodySmall" tone="muted">
                {drawnRadius === null
                  ? String(t("admin.ebPublicPreviewHidden"))
                  : String(
                      t("admin.ebPublicPreviewCircle", {
                        distance: formatDistance(drawnRadius),
                      }),
                    )}
              </Text>
            </XStack>
          </YStack>

          {/* ── Reveal timing (REQUIRED — no 'never' option) ─────────────── */}
          <YStack gap={6} marginTop={16}>
            <Text variant="overline">{String(t("admin.ebAddressReveal"))}</Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.ebAddressRevealHint"))}
            </Text>
            {eventTimezone && (
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.ebRevealTimezoneNote", { timezone: eventTimezone }),
                )}
              </Text>
            )}
            <select
              value={addressRevealPreset}
              disabled={disabled}
              onChange={(e) =>
                onAddressRevealPresetChange(
                  e.target.value as AddressRevealPreset,
                )
              }
              aria-label={String(t("admin.ebAddressRevealSelectAria"))}
              // The venue notice below qualifies every option in this list, so
              // a screen reader hears it at the control, not only if it reads on.
              aria-describedby={
                revealGatedByVenue ? "address-reveal-venue-gate" : undefined
              }
              data-testid="address-reveal-preset"
              style={nativeInputStyle}
            >
              <option value="IMMEDIATELY">
                {String(t("admin.ebRevealImmediately"))}
              </option>
              <option value="ONE_HOUR_BEFORE">
                {String(t("admin.ebRevealOneHour"))}
              </option>
              <option value="DAY_BEFORE">
                {String(t("admin.ebRevealDayBefore"))}
              </option>
              <option value="WEEK_BEFORE">
                {String(t("admin.ebRevealWeekBefore"))}
              </option>
              <option value="CUSTOM">
                {String(t("admin.ebRevealCustom"))}
              </option>
              {/* "Never reveal, to anyone." The ONE preset that resolves a null
                  `addressRevealAt` on purpose (see `AddressRevealPreset`).
                  Last in the list because it is the most severe, and its
                  consequence is spelled out below rather than left to the
                  option label — this is a setting people pick by accident. */}
              <option value="NEVER">{String(t("admin.ebRevealNever"))}</option>
            </select>

            {revealGatedByVenue && (
              <YStack
                id="address-reveal-venue-gate"
                paddingVertical={10}
                paddingHorizontal={12}
                borderLeftWidth={3}
                borderLeftColor="$accent"
                backgroundColor="$surfaceMuted"
                data-testid="address-reveal-venue-gate"
              >
                <Text variant="bodySmall">
                  {String(t("admin.ebRevealGatedByVenue"))}
                </Text>
              </YStack>
            )}

            {addressRevealPreset === "NEVER" && (
              <YStack
                paddingVertical={10}
                paddingHorizontal={12}
                borderLeftWidth={3}
                borderLeftColor="$accent"
                backgroundColor="$surfaceMuted"
                data-testid="address-reveal-never-consequence"
              >
                <Text variant="bodySmall" aria-live="polite">
                  {String(t("admin.ebRevealNeverConsequence"))}
                </Text>
              </YStack>
            )}

            {addressRevealPreset === "CUSTOM" && (
              <YStack gap={4}>
                <Text variant="bodySmall" tone="muted">
                  {String(t("admin.ebRevealCustomLabel"))}
                </Text>
                <DateTimeLocalInput
                  type="datetime-local"
                  value={addressRevealAt}
                  disabled={disabled}
                  required
                  onChange={(e) => onAddressRevealAtChange(e.target.value)}
                  aria-invalid={customRevealError ? true : undefined}
                  aria-describedby={
                    customRevealError ? "address-reveal-at-error" : undefined
                  }
                  data-testid="address-reveal-at"
                  style={{
                    ...nativeInputStyle,
                    border: customRevealError
                      ? "2px solid var(--danger, #B91C1C)"
                      : nativeInputStyle.border,
                  }}
                />
                {customRevealError && (
                  <Text
                    id="address-reveal-at-error"
                    variant="caption"
                    tone="error"
                    role="alert"
                  >
                    {customRevealError}
                  </Text>
                )}
              </YStack>
            )}
          </YStack>

          {/* ── Public label ─────────────────────────────────────────────── */}
          <YStack gap={4} marginTop={16}>
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.ebPublicLabel"))}
            </Text>
            <TextInput
              value={visibilityLabel}
              onChangeText={onVisibilityLabelChange}
              placeholder={
                isHidden
                  ? (t("admin.ebPublicLabelPlaceholderHidden") as string)
                  : (t("admin.ebPublicLabelPlaceholderApprox") as string)
              }
              maxLength={200}
              editable={!disabled}
              testId="visibility-label-input"
            />
          </YStack>
        </>
      )}
    </>
  );
}
