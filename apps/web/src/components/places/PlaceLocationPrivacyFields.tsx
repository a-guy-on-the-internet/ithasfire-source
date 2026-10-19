"use client";

import { useId } from "react";
import { useTheme, XStack, YStack } from "tamagui";
import { MapPin, CircleDashed, EyeOff } from "lucide-react";
import { Text, TextInput, useLocale, useTranslations } from "@th/ui";

import { useImperial } from "@/hooks/useImperial";
import {
  drawnRadiusMeters,
  formatObfuscationRadius,
  radiusForSliderPosition,
  sliderPositionForRadius,
  RADIUS_SLIDER_STOPS,
} from "@/lib/location/obfuscation-radius";
import { RadiusSlider } from "./RadiusSlider";

/**
 * A venue's address privacy, as three mutually-exclusive choices.
 *
 * ONE component, every surface — the admin venue editor
 * (`/admin/[slug]/places/[placeId]/settings`), the admin "New place" dialog
 * (`places/_components/NewPlaceDialog`, the web app's one reachable create
 * path) — because a person meets this setting on whichever they reach first,
 * and two implementations would eventually describe the same column
 * differently. The create surface passes `newPlace` and starts from
 * {@link newPlacePrivacyValue} (address shown).
 *
 * It intentionally MIRRORS the event builder's `LocationVisibilitySection`:
 * same bordered choice cards, same accent-fill selection, same radius ladder,
 * same coarse public label at the bottom. It is the same underlying model
 * (`EventLocationMode` + `locationRadiusMeters`, where a null radius is the
 * fully-hidden sentinel), so it should not feel like a different control.
 *
 * The one deliberate divergence: the builder folds "fully hidden" into the far
 * end-stop of its precision slider, and here it is a THIRD CARD. On an event
 * the slider is a precision dial you nudge; on a venue "we do not publish where
 * we live" is a stance, and a stance should be a thing you pick, not a thing
 * you arrive at by dragging.
 */

// ── Model ───────────────────────────────────────────────────────────────────

/**
 * The three states, flattened to one discriminator for the UI. Maps to the
 * stored pair as:
 *   exact  → { locationMode: "EXACT",    locationRadiusMeters: <ignored> }
 *   area   → { locationMode: "OBSCURED", locationRadiusMeters: <radius>  }
 *   hidden → { locationMode: "OBSCURED", locationRadiusMeters: null      }
 */
export type PlacePrivacyChoice = "exact" | "area" | "hidden";

/** Radius applied when someone picks "approximate area" with nothing stored. */
export const DEFAULT_PLACE_OBFUSCATION_RADIUS_METERS = 1_000;

export type PlaceLocationPrivacyValue = {
  choice: PlacePrivacyChoice;
  /**
   * Radius in metres for the `area` choice. Held even while another choice is
   * selected so switching away and back does not lose the number the owner
   * picked.
   */
  radiusMeters: number;
  /** Coarse public area label. Empty string = "fall back to city, region". */
  areaLabel: string;
};

/**
 * The value a NEW place starts from: the address SHOWN.
 *
 * Mirrors core's `NEW_PLACE_DEFAULT_LOCATION_PRIVACY` (EXACT), per the
 * 2026-09-17 ruling: every address is shown unless the person creating the
 * venue chooses to hide it. The protection for a home is the question asked at
 * creation (`newPlace` on the component below), not a hidden default.
 *
 * A function, not a constant, so no two forms ever share one mutable object.
 * Do NOT seed a create form from `placePrivacyValueFromRecord({})`: that reads
 * an empty record as withheld, which is right for a stored row the form cannot
 * classify and wrong for a venue that does not exist yet.
 */
export function newPlacePrivacyValue(): PlaceLocationPrivacyValue {
  return {
    choice: "exact",
    radiusMeters: DEFAULT_PLACE_OBFUSCATION_RADIUS_METERS,
    areaLabel: "",
  };
}

/**
 * Read an EXISTING place's stored triple into this component's value.
 * FAIL-CLOSED: anything but the literal "EXACT" reads as withheld, including
 * an empty record — which is also why the admin editor can use `{}` as its
 * placeholder while the row is still loading. A create form starts from
 * {@link newPlacePrivacyValue} instead.
 */
export function placePrivacyValueFromRecord(record: {
  locationMode?: string | null;
  locationRadiusMeters?: number | null;
  locationLabel?: string | null;
}): PlaceLocationPrivacyValue {
  const radiusMeters =
    typeof record.locationRadiusMeters === "number" &&
    Number.isFinite(record.locationRadiusMeters)
      ? record.locationRadiusMeters
      : DEFAULT_PLACE_OBFUSCATION_RADIUS_METERS;

  // Only the literal "EXACT" reads as exact — the same fail-closed test core's
  // `redactPlaceLocation` applies. A row this form cannot classify is shown as
  // withheld, which is the state whose mistake is recoverable.
  if (record.locationMode === "EXACT") {
    return { choice: "exact", radiusMeters, areaLabel: record.locationLabel ?? "" };
  }

  const hasRadius =
    typeof record.locationRadiusMeters === "number" &&
    Number.isFinite(record.locationRadiusMeters);

  return {
    choice: hasRadius ? "area" : "hidden",
    radiusMeters,
    areaLabel: record.locationLabel ?? "",
  };
}

/** The `upsertPlace` fields for a value. Always sends all three, explicitly. */
export function placePrivacyToUpsertInput(value: PlaceLocationPrivacyValue): {
  locationMode: "EXACT" | "OBSCURED";
  locationRadiusMeters: number | null;
  locationLabel: string | null;
} {
  const areaLabel = value.areaLabel.trim();
  return {
    locationMode: value.choice === "exact" ? "EXACT" : "OBSCURED",
    // `null` is MEANINGFUL on this field (fully hidden), not a clear.
    locationRadiusMeters: value.choice === "area" ? value.radiusMeters : null,
    locationLabel: areaLabel.length > 0 ? areaLabel : null,
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export type PlaceLocationPrivacyFieldsProps = {
  value: PlaceLocationPrivacyValue;
  onChange: (next: PlaceLocationPrivacyValue) => void;
  /** ISO country code, so the radius reads in miles where miles are expected. */
  countryCode?: string | null;
  disabled?: boolean;
  /**
   * The venue is being created. Swaps the intro line for the question the
   * choice exists to answer ("Is this someone's home?"), so the person listing
   * a house is asked, on the form they are already filling in, rather than
   * relied upon to find a settings page later.
   */
  newPlace?: boolean;
  testIdPrefix?: string;
};

export function PlaceLocationPrivacyFields({
  value,
  onChange,
  countryCode,
  disabled = false,
  newPlace = false,
  testIdPrefix = "place-privacy",
}: PlaceLocationPrivacyFieldsProps) {
  const t = useTranslations();
  const locale = useLocale();
  const theme = useTheme();
  const [imperial] = useImperial(countryCode);
  // Native radios need a group name unique to this mount — two of these on one
  // page (not a thing today, but cheap insurance) must not share a group.
  const groupName = useId();
  const freeTextWarningId = useId();
  const areaInputId = useId();
  const areaHelperId = useId();
  const withheld = value.choice !== "exact";

  const formatDistance = (meters: number): string =>
    formatObfuscationRadius(meters, { imperial, locale });

  const options = [
    {
      choice: "exact" as const,
      label: String(t("admin.placePrivacyExact")),
      description: String(t("admin.placePrivacyExactDesc")),
      icon: MapPin,
    },
    {
      choice: "area" as const,
      label: String(t("admin.placePrivacyApprox")),
      description: String(t("admin.placePrivacyApproxDesc")),
      icon: CircleDashed,
    },
    {
      choice: "hidden" as const,
      label: String(t("admin.placePrivacyHidden")),
      description: String(t("admin.placePrivacyHiddenDesc")),
      icon: EyeOff,
    },
  ];

  // The circle the public is actually shown: the stored radius snapped UP to
  // its ladder rung — the stop the slider thumb sits on. The preview and
  // `aria-valuetext` format THIS, never the raw radius: a legacy 700 m row is
  // drawn at 1 km, and "700 m" would promise a tighter circle than anyone sees.
  const drawnRadius =
    drawnRadiusMeters(value.radiusMeters) ??
    DEFAULT_PLACE_OBFUSCATION_RADIUS_METERS;

  const trimmedArea = value.areaLabel.trim();
  const preview =
    value.choice === "exact"
      ? String(t("admin.placePrivacyPreviewExact"))
      : value.choice === "area"
        ? String(
            t("admin.placePrivacyPreviewApprox", {
              distance: formatDistance(drawnRadius),
            }),
          )
        : trimmedArea.length > 0
          ? String(
              t("admin.placePrivacyPreviewHidden", { area: trimmedArea }),
            )
          : String(t("admin.placePrivacyPreviewHiddenNoArea"));

  return (
    <YStack gap="$3">
      {newPlace ? (
        // Full ink, body size: on a create form this line is the question,
        // not a caption under one.
        <Text variant="body" data-testid={`${testIdPrefix}-prompt`}>
          {String(t("admin.placePrivacyNewPlacePrompt"))}
        </Text>
      ) : (
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.placePrivacyHint"))}
        </Text>
      )}

      {/* Native radios inside label cards: arrow-key navigation, grouping and
          the "one of these" announcement all come free, and a `<fieldset>`
          gives the set a real accessible name. A roving-tabindex hand-roll
          would only be a worse version of this. */}
      <fieldset
        style={{
          border: "none",
          margin: 0,
          padding: 0,
          minInlineSize: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        // Points at the free-text warning while it is on screen, so a screen
        // reader entering the group on an already-withheld venue hears it.
        aria-describedby={withheld ? freeTextWarningId : undefined}
        data-testid={`${testIdPrefix}-group`}
      >
        <legend
          style={{
            // Visually hidden: the surrounding section heading already names
            // this, but the fieldset still needs a programmatic name.
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
          }}
        >
          {String(t("admin.placePrivacyGroupAria"))}
        </legend>

        {options.map(({ choice, label, description, icon: Icon }) => {
          const selected = value.choice === choice;
          return (
            <YStack
              key={choice}
              tag="label"
              minHeight={44}
              paddingVertical={12}
              paddingHorizontal={14}
              gap={4}
              borderWidth={2}
              // The SELECTED fill is `$brandSecondaryHover` (#B93312), not
              // `$accent` (#E2481D), and that is a deliberate divergence from
              // the event builder's otherwise-identical cards: these carry an
              // 11px overline and a caption ON the fill, and white on `$accent`
              // is 4.06:1 — below AA in both polarities (design-system-v2,
              // "Divergences"). On this rung white reaches 5.92:1. The BORDER
              // stays `$accent`, which only needs the 3:1 non-text floor, so
              // the card still reads as the same brand mark.
              borderColor={selected ? "$accent" : "$borderColorStrong"}
              borderRadius={0}
              backgroundColor={selected ? "$brandSecondaryHover" : "$surface"}
              cursor={disabled ? "default" : "pointer"}
              opacity={disabled ? 0.6 : 1}
              hoverStyle={
                disabled
                  ? undefined
                  : {
                      backgroundColor: selected
                        ? "$brandSecondaryHover"
                        : "$surfaceMuted",
                    }
              }
              // `:focus-within` is what carries the focus ring: the visible box
              // is a <label>, and the thing that actually takes focus is the
              // visually-hidden radio inside it.
              focusWithinStyle={{
                outlineWidth: 2,
                outlineStyle: "solid",
                outlineColor: "$accent",
                outlineOffset: 2,
              }}
              data-testid={`${testIdPrefix}-${choice}`}
            >
              <input
                type="radio"
                name={groupName}
                value={choice}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange({ ...value, choice })}
                style={{
                  position: "absolute",
                  width: 1,
                  height: 1,
                  opacity: 0,
                  margin: 0,
                  pointerEvents: "none",
                }}
              />
              <XStack gap={6} alignItems="center">
                <Icon
                  size={14}
                  color={
                    selected
                      ? theme.onBrandSecondary?.val
                      : theme.color?.val
                  }
                  aria-hidden
                />
                <Text
                  variant="overline"
                  color={selected ? "$onBrandSecondary" : "$color"}
                >
                  {label}
                </Text>
              </XStack>
              <Text
                variant="caption"
                color={selected ? "$onBrandSecondary" : "$colorMuted"}
                style={{ textAlign: "left" }}
              >
                {description}
              </Text>
            </YStack>
          );
        })}
      </fieldset>

      {/* The free-text leak (W5). Withholding covers the address columns and
          the map, and nothing else: a bio, the area name, a House Rules block
          or an event description is published exactly as typed. Directly
          under the choices because this is the moment someone decides the
          street is secret. Styled as the event builder's "never reveal"
          consequence block, the sibling control this one mirrors. */}
      {withheld && (
        <YStack
          id={freeTextWarningId}
          paddingVertical={10}
          paddingHorizontal={12}
          borderLeftWidth={3}
          borderLeftColor="$accent"
          backgroundColor="$surfaceMuted"
          data-testid={`${testIdPrefix}-free-text-warning`}
        >
          <Text variant="bodySmall">
            {String(t("admin.placePrivacyFreeTextWarning"))}
          </Text>
        </YStack>
      )}

      {value.choice === "area" && (
        <YStack gap="$2">
          <Text variant="overline">
            {String(t("admin.placePrivacyRadiusLabel"))}
          </Text>
          <RadiusSlider
            min={0}
            max={RADIUS_SLIDER_STOPS.length - 1}
            step={1}
            value={sliderPositionForRadius(value.radiusMeters)}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                // Never null on this slider — "no map at all" is the third
                // CARD here, not the slider's end-stop (see the module doc).
                radiusMeters:
                  radiusForSliderPosition(Number(e.target.value)) ??
                  DEFAULT_PLACE_OBFUSCATION_RADIUS_METERS,
              })
            }
            aria-label={String(t("admin.placePrivacyRadiusAria"))}
            aria-valuetext={formatDistance(drawnRadius)}
            data-testid={`${testIdPrefix}-radius`}
            style={{ width: "100%" }}
          />
        </YStack>
      )}

      {/* Area name. Offered for BOTH withheld states — it is the only place
          string either of them publishes — and hidden under "exact", where the
          real address is already the label. */}
      {withheld && (
        <YStack gap="$2">
          <label htmlFor={areaInputId}>
            <Text variant="overline">
              {String(t("admin.placePrivacyAreaLabel"))}
            </Text>
          </label>
          <TextInput
            id={areaInputId}
            value={value.areaLabel}
            onChangeText={(areaLabel) => onChange({ ...value, areaLabel })}
            placeholder={t("admin.placePrivacyAreaPlaceholder") as string}
            maxLength={200}
            editable={!disabled}
            fullWidth
            // The helper says the name is PUBLIC; a screen reader should hear
            // that at the field, not only if it reads on past it.
            aria-describedby={areaHelperId}
            testId={`${testIdPrefix}-area-label`}
          />
          <Text id={areaHelperId} variant="caption" tone="muted">
            {String(t("admin.placePrivacyAreaHelper"))}
          </Text>
        </YStack>
      )}

      {/* Fixed min height so switching choices does not shift the layout. */}
      <YStack
        gap="$2"
        minHeight={40}
        borderTopWidth={1}
        borderTopColor="$borderColor"
        paddingTop="$3"
      >
        <Text
          variant="bodySmall"
          aria-live="polite"
          data-testid={`${testIdPrefix}-preview`}
        >
          {preview}
        </Text>
        {withheld && (
          <Text variant="caption" tone="muted">
            {String(t("admin.placePrivacyCeiling"))}
          </Text>
        )}
      </YStack>
    </YStack>
  );
}
