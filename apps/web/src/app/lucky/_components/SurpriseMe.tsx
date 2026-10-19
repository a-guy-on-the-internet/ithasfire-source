"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dices, MapPin } from "lucide-react";
import { XStack, YStack, styled } from "tamagui";

import {
  Button,
  RangeSlider,
  Spinner,
  Switch,
  Text,
  TextInput,
  useTranslations,
} from "@th/ui";

import { useUserLocation } from "@/hooks/user-location/useUserLocation";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useImperial } from "@/hooks/useImperial";
import {
  PageContainer,
  HeroSection,
} from "@/components/layout/PagePrimitives";
import {
  DEFAULT_RADIUS_KM,
  formatRadiusLabel,
  kmToSliderValue,
  normalizeRadiusForUnit,
  radiusSliderConfig,
  radiusToNearFilter,
  sliderValueToKm,
} from "@/lib/search/radius";
import { useSurpriseMe, type SurpriseMeFilters } from "@/hooks/useSurpriseMe";

// ---------------------------------------------------------------------------
// SurpriseMe — the user-facing "/lucky" experience. Friendly, optional filters
// (near me + radius, when, keyword) feeding a single big "Pick a random event"
// CTA that rolls a published event and navigates to it. Replaces the old
// developer form that exposed every raw getRandomEvent input.
// ---------------------------------------------------------------------------

type WindowPreset = "anytime" | "week" | "weekend" | "month";

const WINDOW_OPTIONS: readonly { value: WindowPreset; label: string }[] = [
  { value: "anytime", label: "Anytime" },
  { value: "week", label: "This week" },
  { value: "weekend", label: "This weekend" },
  { value: "month", label: "This month" },
];

const startOfToday = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date: Date): Date => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * Map a friendly preset to a concrete date window. Computed in the client
 * component (the user's local clock is the right reference for "this weekend").
 * `anytime` returns undefined so the server applies its own default window.
 */
const resolveWindow = (
  preset: WindowPreset,
): SurpriseMeFilters["window"] | undefined => {
  if (preset === "anytime") return undefined;

  const from = startOfToday();

  if (preset === "week") {
    // From now through the end of the next 7 days.
    const to = endOfDay(new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000));
    return { from, to };
  }

  if (preset === "month") {
    // Through the last day of the current calendar month.
    const to = endOfDay(
      new Date(from.getFullYear(), from.getMonth() + 1, 0),
    );
    return { from, to };
  }

  // weekend: upcoming Saturday + Sunday (or today through Sunday if it's
  // already the weekend).
  const day = from.getDay(); // 0 Sun … 6 Sat
  const daysUntilSaturday = (6 - day + 7) % 7;
  const saturday =
    day === 0
      ? // Sunday: treat today as the tail of the weekend.
        from
      : new Date(from.getTime() + daysUntilSaturday * 24 * 60 * 60 * 1000);
  const sunday =
    day === 0
      ? from
      : new Date(saturday.getTime() + 1 * 24 * 60 * 60 * 1000);
  return { from: saturday, to: endOfDay(sunday) };
};

// ── Near-me state (pure, so the gating logic is unit-testable) ──────────────

export type NearMeState = {
  /** True while the browser is resolving the position — hold the CTA. */
  waiting: boolean;
  /** True when near-me is on but we have no usable coordinates (denied/failed). */
  blocked: boolean;
  /** Inline hint describing the current near-me situation. */
  hint: string;
};

/**
 * Derive the near-me UI state from the toggle + geolocation status. Kept pure
 * (no hooks) so the "stays interactive / un-gates on abort / is honest when
 * denied" rules can be tested without rendering the whole panel.
 */
export const deriveNearMeState = (params: {
  nearMe: boolean;
  hasCoords: boolean;
  locating: boolean;
  hasError: boolean;
}): NearMeState => {
  const { nearMe, hasCoords, locating, hasError } = params;

  // Off, or already resolved with coordinates → never gate.
  const waiting = nearMe && !hasCoords && locating;
  const blocked = nearMe && !hasCoords && !locating && hasError;

  let hint: string;
  if (!nearMe) {
    hint = "Off — picking from anywhere.";
  } else if (hasCoords) {
    hint = "On — picking events near your current location.";
  } else if (locating) {
    hint = "Getting your location…";
  } else if (hasError) {
    // Honest: the toggle is on but unusable, so the roll will ignore location.
    hint =
      "Location unavailable — this roll will ignore Near me. Check browser permissions or turn it off.";
  } else {
    hint = "Allow location access to use this.";
  }

  return { waiting, blocked, hint };
};

// ── Layout primitives (strict Swiss: zero radius, thick borders) ────────────

const Panel = styled(YStack, {
  name: "SurpriseMePanel",
  gap: "$5",
  padding: "$5",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
});

const Segmented = styled(XStack, {
  name: "SurpriseMeSegmented",
  flexWrap: "wrap",
  gap: "$2",
});

const FilterBlock = ({
  label,
  labelId,
  children,
}: {
  label: string;
  /** When set, exposes the block's heading id so a child group can reference
   * it via `aria-labelledby` (avoids duplicate group labels). */
  labelId?: string;
  children: ReactNode;
}) => (
  <YStack gap="$3">
    <Text id={labelId} variant="overline" tone="muted" weight="bold">
      {label}
    </Text>
    {children}
  </YStack>
);

/** A single segmented-control option rendered as a strict-Swiss toggle button. */
const SegmentButton = ({
  selected,
  onPress,
  disabled,
  children,
  testID,
}: {
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
  testID?: string;
}) => (
  <Button
    variant={selected ? "primary" : "secondary"}
    size="$3"
    onPress={onPress}
    disabled={disabled}
    aria-pressed={selected}
    data-testid={testID}
  >
    {children}
  </Button>
);

export const SurpriseMe = () => {
  const t = useTranslations();
  const { roll, isRolling } = useSurpriseMe();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [imperial] = useImperial();
  const {
    coords,
    request: requestLocation,
    loading: locating,
    error: locationError,
  } = useUserLocation({ requestOnMount: false });

  const [nearMe, setNearMe] = useState(false);
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("anytime");
  const [keyword, setKeyword] = useState("");

  // "No events found" is a transient, recoverable outcome — surfaced inline
  // beneath the CTA rather than as a toast, so the user can adjust and retry.
  const [noEvent, setNoEvent] = useState(false);
  const [rollError, setRollError] = useState(false);

  const handleToggleNearMe = useCallback(
    (next: boolean) => {
      setNearMe(next);
      if (next && !coords) {
        requestLocation();
      }
    },
    [coords, requestLocation],
  );

  const handleRoll = useCallback(async () => {
    setNoEvent(false);
    setRollError(false);

    const filters: SurpriseMeFilters = {};

    if (nearMe && coords) {
      // The Worldwide sentinel returns null → omit `near` for a roll from
      // anywhere (getRandomEvent caps radius at 500km).
      const near = radiusToNearFilter(radiusKm);
      if (near) {
        filters.near = { lat: coords.lat, lng: coords.lng, ...near };
      }
    }
    const dateWindow = resolveWindow(windowPreset);
    if (dateWindow) {
      filters.window = dateWindow;
    }
    const trimmed = keyword.trim();
    if (trimmed) {
      filters.q = trimmed;
    }

    const outcome = await roll(filters);
    if (outcome.status === "no-event") {
      setNoEvent(true);
    } else if (outcome.status === "error") {
      setRollError(true);
    }
    // On "navigated" the router takes over; nothing else to do here.
  }, [coords, keyword, nearMe, radiusKm, roll, windowPreset]);

  // Near-me state is derived purely. While the browser resolves the position
  // we hold the CTA, but the toggle stays interactive so the user can abort —
  // and the moment near-me is toggled off (or coords arrive), the CTA un-gates.
  const {
    waiting: nearMeWaitingForCoords,
    blocked: nearMeBlocked,
    hint: nearMeHint,
  } = useMemo(
    () =>
      deriveNearMeState({
        nearMe,
        hasCoords: Boolean(coords),
        locating,
        hasError: Boolean(locationError),
      }),
    [coords, locating, locationError, nearMe],
  );

  const ctaDisabled = isRolling || nearMeWaitingForCoords;

  // Shared radius formatting (km / mi / Worldwide) — identical to the search
  // filter's label so the controls read the same. Only the Worldwide string is
  // translated (reusing the existing search key); the rest of this page's copy
  // stays hardcoded for now.
  const radiusDisplayLabel = useMemo(
    () => formatRadiusLabel(radiusKm, { imperial, t }),
    [imperial, radiusKm, t],
  );

  // The slider widget presents unit-appropriate stops (mi grid for imperial),
  // but state stays canonical km. When the unit flips — async auto-detect or a
  // manual toggle elsewhere — snap the current km onto the new unit's grid so
  // the label / thumb / queried km agree. Guarded by a ref so it never runs on
  // mount (won't stomp a URL-provided radius) or loop.
  const prevImperial = useRef(imperial);
  useEffect(() => {
    if (prevImperial.current === imperial) return;
    prevImperial.current = imperial;
    setRadiusKm((km) => normalizeRadiusForUnit(km, imperial));
  }, [imperial]);

  const sliderConfig = radiusSliderConfig(imperial);

  return (
    <PageContainer gap={40}>
      <HeroSection
        badge="Discover"
        title="Surprise me"
        description="Not sure what you're in the mood for? Let us pick a random event for you. Add a filter or two, or just roll."
      />

      <Panel>
        {/* Near me */}
        <FilterBlock label="Near me">
          <YStack gap="$3">
            <XStack
              gap="$3"
              alignItems="center"
              justifyContent="space-between"
              flexWrap="wrap"
            >
              <XStack gap="$2" alignItems="center" flexShrink={1}>
                <MapPin
                  size={18}
                  strokeWidth={2}
                  aria-hidden
                  style={{ flexShrink: 0 }}
                />
                {/* Stays interactive while locating so the user can abort; the
                    "Getting your location…" hint is the sole busy signal. */}
                <Switch
                  checked={nearMe}
                  onCheckedChange={handleToggleNearMe}
                  label="Use my location"
                  testId="surprise-near-me"
                />
              </XStack>
            </XStack>
            <Text variant="bodySmall" tone={nearMeBlocked ? "error" : "muted"}>
              {nearMeHint}
            </Text>

            {nearMe && (
              <YStack gap="$2">
                <XStack
                  alignItems="center"
                  justifyContent="space-between"
                  gap="$2"
                >
                  <Text variant="bodySmall" tone="muted" weight="bold">
                    Within
                  </Text>
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    data-testid="surprise-radius-value"
                  >
                    {radiusDisplayLabel}
                  </Text>
                </XStack>
                {/* Native range input → built-in arrow-key support. Widget
                    stops follow the active unit (mi grid for imperial); state
                    stays canonical km via kmToSliderValue/sliderValueToKm. The
                    label sets the accessible name; valueText makes the screen
                    reader announce the unit-aware value ("31 mi" / "Worldwide"). */}
                <RangeSlider
                  min={sliderConfig.min}
                  max={sliderConfig.max}
                  step={sliderConfig.step}
                  value={kmToSliderValue(radiusKm, imperial)}
                  onValueChange={(v) =>
                    setRadiusKm(sliderValueToKm(v, imperial))
                  }
                  disabled={isRolling}
                  label="Search radius"
                  valueText={radiusDisplayLabel}
                  testId="surprise-radius-slider"
                />
              </YStack>
            )}
          </YStack>
        </FilterBlock>

        {/* When */}
        <FilterBlock label="When" labelId="surprise-when-label">
          <Segmented role="group" aria-labelledby="surprise-when-label">
            {WINDOW_OPTIONS.map((option) => (
              <SegmentButton
                key={option.value}
                selected={windowPreset === option.value}
                onPress={() => setWindowPreset(option.value)}
                disabled={isRolling}
                testID={`surprise-window-${option.value}`}
              >
                {option.label}
              </SegmentButton>
            ))}
          </Segmented>
        </FilterBlock>

        {/* Keyword */}
        <FilterBlock label="Keyword">
          <TextInput
            value={keyword}
            onChangeText={setKeyword}
            placeholder="e.g. music, comedy, food"
            aria-label="Keyword"
            fullWidth
            clearable
            onSubmitEditing={handleRoll}
            disabled={isRolling}
          />
        </FilterBlock>

        {/* CTA + recoverable states */}
        <YStack gap="$3">
          <Button
            variant="primary"
            size="$5"
            onPress={handleRoll}
            disabled={ctaDisabled}
            aria-busy={isRolling || undefined}
            data-testid="surprise-roll"
          >
            <XStack gap="$3" alignItems="center">
              {isRolling ? (
                <Spinner
                  size="small"
                  indicatorColor="$onBrandSecondary"
                  reducedMotion={prefersReducedMotion}
                />
              ) : (
                <Dices size={20} strokeWidth={2} aria-hidden />
              )}
              <Text variant="body" weight="bold" tone="inherit" tag="span">
                {isRolling ? "Finding an event…" : "Pick a random event"}
              </Text>
            </XStack>
          </Button>

          {/* Live region so screen readers announce a no-result / error outcome. */}
          <YStack role="status" aria-live="polite">
            {noEvent && (
              <Text
                variant="bodySmall"
                tone="warning"
                data-testid="surprise-empty"
              >
                No events match those filters. Try widening your search — a
                larger radius, a longer date range, or no keyword.
              </Text>
            )}
            {rollError && (
              <Text
                variant="bodySmall"
                tone="error"
                data-testid="surprise-error"
              >
                Something went wrong while picking an event. Please try again.
              </Text>
            )}
          </YStack>
        </YStack>
      </Panel>
    </PageContainer>
  );
};

SurpriseMe.displayName = "SurpriseMe";
