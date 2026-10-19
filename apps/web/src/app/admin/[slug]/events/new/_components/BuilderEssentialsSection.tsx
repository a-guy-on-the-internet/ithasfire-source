"use client";

import { memo } from "react";
import { styled, XStack, YStack } from "tamagui";

import { Text, TextInput, useTranslations } from "@th/ui";
import type { EventLocationMode } from "@th/types";

import type { PlacePickerItem } from "@/components/places/PlacePicker";

import {
  FormSection,
  INSET_DIVIDER_XS,
  SectionDivider,
} from "./_builder-styled";
import { Field, FieldLabel, NativeDateTimeInput } from "./_form-bits";
import { CategoryTagsSection } from "./CategoryTagsSection";
import { CommunityCategoryField } from "./CommunityCategoryField";
import type { TimezoneAdoptionSource } from "./event-timezone";
import { EventTimezoneNote } from "./EventTimezoneNote";
import { HeroImageField } from "./HeroImageField";
import {
  LocationSection,
  type LocationState,
  type LocationMode,
} from "./LocationSection";
import type {
  BuilderPlacement,
  BuilderPlacementSource,
} from "./builder-placement.helpers";
import type { SaveEventBookingSkip } from "./event-first-skip.helpers";
import { toDateTimeLocalValue } from "./event-builder-helpers";

/**
 * Essentials — the always-visible top block of the event builder: hero image,
 * title, start/end datetime, category & tags, venue, and the "Hide the
 * address?" jump into Settings · Access & privacy.
 *
 * Perf contract (why this is its own memoized component): the field VALUES
 * still live in EventBuilder — save, publish, and the readiness rail all read
 * them — so this component takes value + setter pairs. The win is directional:
 * a keystroke here re-renders this section (and the builder shell) but no
 * longer re-renders Details, Settings, Tickets, Lineup or Splits. Every prop is
 * a primitive, a state object whose identity only changes when its own value
 * does, or a `useCallback`'d handler, so `React.memo` genuinely bails out when
 * something ELSE in the builder changes.
 */

const DateRow = styled(XStack, {
  gap: 12,
  flexWrap: "wrap",
  alignItems: "flex-end",
  // Stack the start/end date inputs on phones so each gets full width and
  // the native date picker isn't squeezed.
  $xs: { flexDirection: "column", alignItems: "stretch" },
});

const DateField = styled(YStack, {
  gap: 4,
  // On phones the inputs need full width since DateRow stacks vertically.
  $xs: { width: "100%" },
});

/**
 * Small muted link-button rendered under the venue field: expands the
 * Access & privacy settings group and scrolls to it (decision D2). A real
 * <button> so it is keyboard-activatable with a visible focus ring.
 */
const HideAddressLink = styled(XStack, {
  tag: "button",
  alignSelf: "flex-start",
  alignItems: "center",
  minHeight: 44,
  paddingVertical: 4,
  paddingHorizontal: 0,
  gap: 4,
  cursor: "pointer",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

const UNDERLINE = { textDecoration: "underline" } as const;

/** Stable no-op so an omitted community handler can't churn the memo. */
const noop = () => {};

export type BuilderEssentialsSectionProps = {
  eventId: string;
  ownerType: "human" | "org";
  ownerId: string;
  slug?: string;

  /** Hero image (staged preview URL or the persisted one). */
  heroImageUrl: string | undefined;
  onHeroImageSelected: (file: File, previewUrl: string) => void | Promise<void>;
  onHeroImageRemoved: () => void;

  title: string;
  onTitleChange: (value: string) => void;
  /** Boolean (not the message) so keystrokes don't churn this prop. */
  titleHasError: boolean;

  startsAt: string | undefined;
  endsAt: string | undefined;
  onStartDateChange: (value: string | undefined) => void;
  onEndDateChange: (value: string | undefined) => void;

  /**
   * IANA zone the two `datetime-local` readings above are interpreted in at
   * save time. Shown, not editable — it follows the location.
   */
  eventTimezone: string;
  /**
   * What the zone was just adopted FROM (a venue, or a freeform address), or
   * null. Non-null renders the "what just happened to my times" note: the wall
   * clock is kept and the instant moves, which on a saved event moves the show
   * — so it is stated.
   */
  timezoneAdoptedFrom: TimezoneAdoptionSource | null;

  location: LocationState;
  locationSearch: string;
  locationMode: LocationMode;
  selectedPlace: PlacePickerItem | null;
  visibilityMode: EventLocationMode;
  visibilityRadius: number | null;
  hasSavedLocation: boolean;
  onLocationChange: (loc: LocationState) => void;
  onLocationSearchChange: (search: string) => void;
  onLocationModeChange: (mode: LocationMode) => void;
  onPlaceSelect: (place: PlacePickerItem | null) => void;
  onResetLocation: () => void;
  /** Third-party venue cascade state — see `builder-placement.helpers.ts`. */
  placement: BuilderPlacement | null;
  placementSource: BuilderPlacementSource;
  /** The hydrated intent is still in flight — show the skeleton, not a guess. */
  placementIntentPending: boolean;
  onPlacementChange: (placement: BuilderPlacement | null) => void;
  /** The last save's refused ask, gated by the builder — see `LocationSection`. */
  bookingSkip: SaveEventBookingSkip | null;
  /** The selected place is archived (its name), or null. See `LocationSection`. */
  placeArchivedName?: string | null;

  /** Expands Settings · Access & privacy and scrolls to it. */
  onHideAddressLink: () => void;

  // ── COMMUNITY mode ────────────────────────────────────────────────────
  /**
   * The event is an ownerless COMMUNITY listing. Three things change, each
   * because the owned equivalent refuses an ownerless row server-side:
   *
   * - **Venue picker** — kept (`community.updateListing` takes `placeId`
   *   since 2026-10-06), but searching ALL venues only, with no booking
   *   cascade: linking a listing to a venue books and confirms nothing. See
   *   `LocationSection`'s `communityMode`.
   * - **Category & tags** — `categories.setEventCategory` and
   *   `tags.setEventTags` both throw `NOT_RESOURCE_OWNER` for an ownerless
   *   event. The category moves onto the builder's own save (it IS in the
   *   whitelist); tags have no community write path and are not offered.
   * - **"Hide the address?"** — its target is the Settings · Access & privacy
   *   group, which community mode does not render. A link that expands
   *   nothing is worse than no link.
   */
  communityMode?: boolean;
  /** Controlled category value in community mode (`null` = none). */
  communityCategoryId?: string | null;
  onCommunityCategoryChange?: (categoryId: string | null) => void;
};

function BuilderEssentialsSectionImpl({
  eventId,
  ownerType,
  ownerId,
  slug,
  heroImageUrl,
  onHeroImageSelected,
  onHeroImageRemoved,
  title,
  onTitleChange,
  titleHasError,
  startsAt,
  endsAt,
  onStartDateChange,
  onEndDateChange,
  eventTimezone,
  timezoneAdoptedFrom,
  location,
  locationSearch,
  locationMode,
  selectedPlace,
  visibilityMode,
  visibilityRadius,
  hasSavedLocation,
  onLocationChange,
  onLocationSearchChange,
  onLocationModeChange,
  onPlaceSelect,
  onResetLocation,
  placement,
  placementSource,
  placementIntentPending,
  onPlacementChange,
  bookingSkip,
  placeArchivedName = null,
  onHideAddressLink,
  communityMode = false,
  communityCategoryId = null,
  onCommunityCategoryChange,
}: BuilderEssentialsSectionProps) {
  const t = useTranslations();

  return (
    <FormSection>
      <Field>
        <FieldLabel optional>{String(t("admin.ebHeroImage"))}</FieldLabel>
        <HeroImageField
          imageUrl={heroImageUrl}
          onImageSelected={onHeroImageSelected}
          onImageRemoved={onHeroImageRemoved}
        />
      </Field>

      <Field>
        <FieldLabel required>{String(t("admin.ebEventTitle"))}</FieldLabel>
        <TextInput
          value={title}
          onChangeText={onTitleChange}
          placeholder={t("admin.ebEventTitlePlaceholder") as string}
          maxLength={140}
          fullWidth
          clearable
          required
          status={titleHasError ? "error" : undefined}
          testId="event-title"
        />
      </Field>

      <Field>
        <FieldLabel required>{String(t("admin.ebDateTime"))}</FieldLabel>
        <DateRow>
          <DateField>
            <FieldLabel>{String(t("admin.ebStarts"))}</FieldLabel>
            <NativeDateTimeInput
              type="datetime-local"
              value={startsAt ?? ""}
              min={toDateTimeLocalValue(new Date())}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onStartDateChange(e.target.value || undefined)
              }
              required
              data-testid="event-starts-at"
            />
          </DateField>
          <DateField>
            {/* Community listings genuinely require an end instant —
                `createCommunityListing` refines `endsAt > startsAt` — so the
                "(optional)" marker would be a lie there. (The owned path keeps
                its existing marker; see the follow-up note.) */}
            <FieldLabel optional={!communityMode}>
              {String(t("admin.ebEnds"))}
            </FieldLabel>
            <NativeDateTimeInput
              type="datetime-local"
              value={endsAt ?? ""}
              min={startsAt || toDateTimeLocalValue(new Date())}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onEndDateChange(e.target.value || undefined)
              }
              data-testid="event-ends-at"
            />
          </DateField>
        </DateRow>
        <EventTimezoneNote
          timezone={eventTimezone}
          adoptedFrom={timezoneAdoptedFrom}
        />
      </Field>

      <SectionDivider marginHorizontal={-32} $xs={INSET_DIVIDER_XS} />

      {communityMode ? (
        <CommunityCategoryField
          value={communityCategoryId}
          onChange={onCommunityCategoryChange ?? noop}
        />
      ) : (
        <CategoryTagsSection eventId={eventId} />
      )}
      <SectionDivider marginHorizontal={-32} $xs={INSET_DIVIDER_XS} />

      <Field>
        {/* Community: the label names the one-box combobox (a span can't
            label by wrapping). Owned events keep their DOM unchanged. */}
        <FieldLabel
          required
          id={communityMode ? "event-location-label" : undefined}
        >
          {String(t("admin.ebLocation"))}
        </FieldLabel>
        <LocationSection
          required
          labelledBy={communityMode ? "event-location-label" : undefined}
          location={location}
          locationSearch={locationSearch}
          locationMode={locationMode}
          selectedPlace={selectedPlace}
          visibilityMode={visibilityMode}
          visibilityRadius={visibilityRadius}
          ownerType={ownerType}
          ownerId={ownerId}
          slug={slug}
          hasSavedLocation={hasSavedLocation}
          onLocationChange={onLocationChange}
          onLocationSearchChange={onLocationSearchChange}
          onLocationModeChange={onLocationModeChange}
          onPlaceSelect={onPlaceSelect}
          onResetLocation={onResetLocation}
          placement={placement}
          placementSource={placementSource}
          placementIntentPending={placementIntentPending}
          onPlacementChange={onPlacementChange}
          bookingSkip={bookingSkip}
          placeArchivedName={placeArchivedName}
          communityMode={communityMode}
        />
        {/* D2: address visibility now lives in Settings · Access &
            privacy. New events default to "exact address, shown
            immediately"; this link is the discoverable path to hiding
            it — it expands that group and scrolls it into view.
            Community mode renders no Settings groups, so the link would
            jump to nothing. */}
        {!communityMode && (
          <HideAddressLink
            onPress={onHideAddressLink}
            data-testid="hide-address-link"
          >
            <Text variant="caption" tone="muted" style={UNDERLINE}>
              {String(t("admin.ebHideAddressLink"))}
            </Text>
          </HideAddressLink>
        )}
      </Field>
    </FormSection>
  );
}

export const BuilderEssentialsSection = memo(BuilderEssentialsSectionImpl);

BuilderEssentialsSection.displayName = "BuilderEssentialsSection";
