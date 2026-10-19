"use client";

import { memo, useMemo, type Ref } from "react";
import { useTheme, XStack, YStack } from "tamagui";
import { CalendarClock, Landmark, Link2, Lock, Settings } from "lucide-react";

import { Text, useTranslations } from "@th/ui";
import type {
  AddressRevealPreset,
  EventGateType,
  EventLocationMode,
  EventVisibility,
  PayoutSchedule,
  WaitlistStatus,
} from "@th/types";

import type { VenueLocationCeiling } from "@/lib/places/venue-location-ceiling";

import {
  BlocksSection,
  BlocksSectionHeader,
  FormSection,
  SectionDivider,
  SettingsGroupsStack,
} from "./_builder-styled";
import { Field, FieldLabel } from "./_form-bits";
import { EventFinanceSettings } from "./EventFinanceSettings";
import { EventGateSettings } from "./EventGateSettings";
import { toTemplateOwnerRef } from "./ticket-type-template-helpers";
import { EventSlugSection } from "./EventSlugSection";
import {
  eventSharingSummary,
  type EventLinkState,
} from "./event-public-link.helpers";
import { EventTaxSection } from "./EventTaxSection";
import { EventWaiverSection } from "./EventWaiverSection";
import { LocationVisibilitySection } from "./LocationVisibilitySection";
import { RecurrenceBuilder, type RecurrenceConfig } from "./RecurrenceBuilder";
import { SettingsGroup, type SettingsGroupHandle } from "./SettingsGroup";

/**
 * Settings — the named accordion groups at the bottom of the builder
 * (FR-102): Scheduling · Access & privacy · Money & compliance · Sharing,
 * plus the collapsed-state summaries derived from data the builder already
 * holds.
 *
 * Perf contract: every prop is a primitive, a stable ref object, or a
 * `useCallback`'d handler, so `React.memo` bails out for every keystroke in
 * Title / Details. Group open state is owned by each `SettingsGroup`
 * (uncontrolled) — toggling one re-renders only that group; deep links force a
 * group open through its `SettingsGroupHandle` ref instead of parent state.
 */

const repeatKeyByFreq: Record<string, string> = {
  DAILY: "admin.ebSummaryRepeatsDaily",
  WEEKLY: "admin.ebSummaryRepeatsWeekly",
  MONTHLY: "admin.ebSummaryRepeatsMonthly",
  YEARLY: "admin.ebSummaryRepeatsYearly",
};

/**
 * PARTIAL on purpose. `NEVER` ("this address is never revealed, to anyone")
 * has no reveal line to summarise — the visibility part of the summary already
 * says the address is hidden, and a "revealed …" clause would contradict it.
 * A missing key drops the clause rather than rendering an empty string.
 */
const revealKeyByPreset: Partial<Record<AddressRevealPreset, string>> = {
  IMMEDIATELY: "admin.ebSummaryAddressRevealImmediately",
  ONE_HOUR_BEFORE: "admin.ebSummaryAddressRevealHourBefore",
  DAY_BEFORE: "admin.ebSummaryAddressRevealDayBefore",
  WEEK_BEFORE: "admin.ebSummaryAddressRevealWeekBefore",
  CUSTOM: "admin.ebSummaryAddressRevealCustom",
};

export type BuilderSettingsSectionsProps = {
  eventId: string;
  slug?: string;
  ownerType: "human" | "org";
  ownerId: string;
  /** Sticky-header height — drives each group anchor's scroll-margin. */
  stickyTopOffset: number;

  // ── Scheduling ────────────────────────────────────────────────────────
  /** Scroll target for the `?section=scheduling` deep link. */
  schedulingAnchorRef: Ref<HTMLDivElement>;
  /** Imperative open handle for the same deep link. */
  schedulingGroupRef: Ref<SettingsGroupHandle>;
  /** Expanded on mount when the builder was opened with `?section=scheduling`. */
  schedulingDefaultOpen: boolean;
  recurrenceEnabled: boolean;
  recurrenceConfig: RecurrenceConfig | null;
  onRecurrenceEnabledChange: (enabled: boolean) => void;
  onRecurrenceConfigChange: (config: RecurrenceConfig | null) => void;
  startsAt: string | undefined;
  /** Builder wall-clock end (same format and zone as `startsAt`). */
  endsAt: string | undefined;
  /**
   * The Essentials start-date setter, handed to the RecurrenceBuilder so its
   * inline start field edits the builder's single `startsAt` state (and keeps
   * the end-time shift) instead of a copy.
   */
  onStartDateChange: (value: string | undefined) => void;
  eventTimezone: string;
  seriesId: string | null | undefined;

  // ── Access & privacy ──────────────────────────────────────────────────
  accessAnchorRef: Ref<HTMLDivElement>;
  accessGroupRef: Ref<SettingsGroupHandle>;
  /** Focus target for the "Hide the address?" jump. */
  accessHeaderId: string;
  gateVisibility: EventVisibility | undefined;
  gateType: EventGateType | undefined;
  gatePasswordSet: boolean | undefined;
  gateWaitlistStatus: WaitlistStatus | undefined;
  gateWaitlistDescription: string | null | undefined;
  gateWaitlistCap: number | null | undefined;
  /** Gate query settled — until then the summary omits the visibility half. */
  gateStateLoaded: boolean;
  onOpenFormBuilder: () => void;
  visibilityMode: EventLocationMode;
  visibilityRadius: number | null;
  visibilityLabel: string;
  addressRevealPreset: AddressRevealPreset;
  addressRevealAt: string;
  /** The selected venue's address-privacy ceiling. See LocationVisibilitySection. */
  venueCeiling: VenueLocationCeiling;
  /** Whether the viewer manages the selected venue. See LocationVisibilitySection. */
  viewerManagesVenue?: boolean;
  /** The selected place is archived (its name), or null. See LocationVisibilitySection. */
  placeArchivedName?: string | null;
  locationCountryCode: string | undefined;
  saving: boolean;
  revealCustomError: string | null;
  onVisibilityModeChange: (mode: EventLocationMode) => void;
  onVisibilityRadiusChange: (radius: number | null) => void;
  onVisibilityLabelChange: (label: string) => void;
  onAddressRevealPresetChange: (preset: AddressRevealPreset) => void;
  onAddressRevealAtChange: (value: string) => void;

  // ── Money & compliance ────────────────────────────────────────────────
  waiversEnabled: boolean;
  waiverTemplateId: string | null;
  instructionalAdmission: boolean;
  /** US state code from the event location (falls back to the saved event). */
  eventStateCode: string | null;
  payoutsEnabled: boolean;
  payoutSchedule: PayoutSchedule | null;

  // ── Sharing ───────────────────────────────────────────────────────────
  eventSlug: string | null;
  eventShortId: string | null;
  /**
   * Status + first-publish time: whether the short link works for
   * a stranger (`isEventPubliclyReadable`). A draft has a short ID from
   * creation, but `/e/` 404s it, so the group prints the long path and no
   * short line until then.
   */
  eventStatus: EventLinkState["status"];
  eventPublishedAt: EventLinkState["publishedAt"];
  /**
   * Offer "Regenerate slug"? Edit roles on a draft, admin roles once the
   * event is PUBLISHED — the `regenerateEventSlug` bar. The link itself (and
   * Copy / Open) stays for everyone who reaches this group.
   */
  canRegenerateSlug: boolean;
  /** The builder's Copy link handler; the Sharing group's field uses it. */
  onCopyEventLink: () => void;
};

function BuilderSettingsSectionsImpl({
  eventId,
  slug,
  ownerType,
  ownerId,
  stickyTopOffset,
  schedulingAnchorRef,
  schedulingGroupRef,
  schedulingDefaultOpen,
  recurrenceEnabled,
  recurrenceConfig,
  onRecurrenceEnabledChange,
  onRecurrenceConfigChange,
  startsAt,
  endsAt,
  onStartDateChange,
  eventTimezone,
  seriesId,
  accessAnchorRef,
  accessGroupRef,
  accessHeaderId,
  gateVisibility,
  gateType,
  gatePasswordSet,
  gateWaitlistStatus,
  gateWaitlistDescription,
  gateWaitlistCap,
  gateStateLoaded,
  onOpenFormBuilder,
  visibilityMode,
  visibilityRadius,
  visibilityLabel,
  addressRevealPreset,
  addressRevealAt,
  venueCeiling,
  viewerManagesVenue,
  placeArchivedName = null,
  locationCountryCode,
  saving,
  revealCustomError,
  onVisibilityModeChange,
  onVisibilityRadiusChange,
  onVisibilityLabelChange,
  onAddressRevealPresetChange,
  onAddressRevealAtChange,
  waiversEnabled,
  waiverTemplateId,
  instructionalAdmission,
  eventStateCode,
  payoutsEnabled,
  payoutSchedule,
  eventSlug,
  eventShortId,
  eventStatus,
  eventPublishedAt,
  canRegenerateSlug,
  onCopyEventLink,
}: BuilderSettingsSectionsProps) {
  const t = useTranslations();
  const theme = useTheme();
  const muted = theme.colorMuted?.val;

  const anchorStyle = useMemo(
    () => ({ scrollMarginTop: stickyTopOffset + 8, outline: "none" as const }),
    [stickyTopOffset],
  );
  const scrollAnchorStyle = useMemo(
    () => ({ scrollMarginTop: stickyTopOffset + 8 }),
    [stickyTopOffset],
  );
  // The EVENT's owner (not the URL workspace) owns the application templates
  // the gate's "Start from a template" picker lists.
  const templateOwner = useMemo(
    () => toTemplateOwnerRef(ownerType, ownerId),
    [ownerType, ownerId],
  );

  // ── Collapsed-state summaries (FR-102) ──────────────────────────────
  // Derived exclusively from state/queries the builder already holds — no new
  // endpoints.
  const freqMatch = /FREQ=([A-Z]+)/.exec(recurrenceConfig?.rrule ?? "");
  const schedulingSummary = recurrenceEnabled
    ? String(
        t(repeatKeyByFreq[freqMatch?.[1] ?? ""] ?? "admin.ebSummaryRecurring"),
      )
    : String(t("admin.ebSummaryOneTime"));

  // Omit the visibility half until the gate query settles — a PRIVATE event
  // must never flash a "public" summary while loading.
  const visibilitySummaryPart = gateStateLoaded
    ? String(
        t(
          gateVisibility === "PRIVATE"
            ? "admin.ebSummaryVisibilityPrivate"
            : "admin.ebSummaryVisibilityPublic",
        ),
      )
    : null;
  const addressSummaryKey =
    visibilityMode === "EXACT"
      ? "admin.ebSummaryAddressExact"
      : revealKeyByPreset[addressRevealPreset];
  const addressSummaryPart = addressSummaryKey
    ? String(t(addressSummaryKey))
    : "";
  const accessSummary = [visibilitySummaryPart, addressSummaryPart]
    .filter(Boolean)
    .join(" · ");

  const taxSummaryPart = String(
    t(
      instructionalAdmission
        ? "admin.ebSummaryTaxInstructional"
        : "admin.ebSummaryTaxStandard",
    ),
  );
  const waiverSummaryPart = waiversEnabled
    ? String(
        t(
          waiverTemplateId
            ? "admin.ebSummaryWaiverRequired"
            : "admin.ebSummaryWaiverNone",
        ),
      )
    : null;
  const moneySummary = waiverSummaryPart
    ? `${taxSummaryPart} · ${waiverSummaryPart}`
    : taxSummaryPart;

  const sharingSummary = eventSharingSummary({
    status: eventStatus,
    publishedAt: eventPublishedAt,
    slug: eventSlug,
    shortId: eventShortId,
  });

  const waiverBody = waiversEnabled ? (
    <EventWaiverSection
      eventId={eventId}
      orgId={ownerType === "org" ? ownerId : undefined}
      humanId={ownerType === "human" ? ownerId : undefined}
      initialWaiverTemplateId={waiverTemplateId}
      eventStateCode={eventStateCode}
    />
  ) : null;
  const financeBody = payoutsEnabled ? (
    <EventFinanceSettings
      eventId={eventId}
      payoutSchedule={payoutSchedule}
      eventStartsAt={startsAt}
      eventEndsAt={endsAt}
      eventTimezone={eventTimezone}
    />
  ) : null;

  return (
    <>
      <BlocksSection>
        <BlocksSectionHeader marginBottom={0}>
          <XStack gap={10} alignItems="center">
            <Settings size={16} color={muted} aria-hidden />
            <Text variant="h4" weight="bold">
              {String(t("admin.ebSettingsHeading"))}
            </Text>
          </XStack>
        </BlocksSectionHeader>
      </BlocksSection>
      <SettingsGroupsStack data-testid="advanced-settings-section">
        <div ref={schedulingAnchorRef} tabIndex={-1} style={anchorStyle}>
          <SettingsGroup
            ref={schedulingGroupRef}
            label={String(t("admin.ebSettingsScheduling"))}
            icon={<CalendarClock size={16} color={muted} aria-hidden />}
            summary={schedulingSummary}
            testId="advanced-section-recurrence"
            defaultOpen={schedulingDefaultOpen}
          >
            <FormSection>
              <Field>
                <FieldLabel>{String(t("admin.ebRecurrence"))}</FieldLabel>
                <RecurrenceBuilder
                  enabled={recurrenceEnabled}
                  onEnabledChange={onRecurrenceEnabledChange}
                  value={recurrenceConfig}
                  onChange={onRecurrenceConfigChange}
                  eventStartsAt={startsAt}
                  onEventStartsAtChange={onStartDateChange}
                  eventTimezone={eventTimezone}
                  seriesId={seriesId}
                  manageDatesHref={
                    seriesId
                      ? `/admin/${slug}/events/${eventId}/dates`
                      : undefined
                  }
                />
              </Field>
            </FormSection>
          </SettingsGroup>
        </div>
        <div ref={accessAnchorRef} style={scrollAnchorStyle}>
          <SettingsGroup
            ref={accessGroupRef}
            label={String(t("admin.ebSettingsAccessPrivacy"))}
            icon={<Lock size={16} color={muted} aria-hidden />}
            summary={accessSummary}
            testId="advanced-section-gate"
            headerId={accessHeaderId}
          >
            <EventGateSettings
              eventId={eventId}
              slug={slug}
              templateOwner={templateOwner}
              initialVisibility={gateVisibility}
              initialGateType={gateType}
              initialPasswordSet={gatePasswordSet}
              initialWaitlistStatus={gateWaitlistStatus}
              initialWaitlistDescription={gateWaitlistDescription}
              initialWaitlistCap={gateWaitlistCap}
              onOpenFormBuilder={onOpenFormBuilder}
            />
            <SectionDivider />
            {/* D2: moved out of Essentials into Access & privacy. No longer
                required-framed — new events default to "exact address, shown
                immediately" and only organizers who opt in change it here. */}
            <FormSection>
              <Field>
                <FieldLabel>
                  {String(t("admin.ebLocationVisibility"))}
                </FieldLabel>
                <LocationVisibilitySection
                  visibilityMode={visibilityMode}
                  visibilityRadius={visibilityRadius}
                  visibilityLabel={visibilityLabel}
                  addressRevealPreset={addressRevealPreset}
                  addressRevealAt={addressRevealAt}
                  eventTimezone={eventTimezone}
                  countryCode={locationCountryCode}
                  disabled={saving}
                  customRevealError={revealCustomError}
                  venueCeiling={venueCeiling}
                  viewerManagesVenue={viewerManagesVenue}
                  placeArchivedName={placeArchivedName}
                  onVisibilityModeChange={onVisibilityModeChange}
                  onVisibilityRadiusChange={onVisibilityRadiusChange}
                  onVisibilityLabelChange={onVisibilityLabelChange}
                  onAddressRevealPresetChange={onAddressRevealPresetChange}
                  onAddressRevealAtChange={onAddressRevealAtChange}
                />
              </Field>
            </FormSection>
          </SettingsGroup>
        </div>
        <SettingsGroup
          label={String(t("admin.ebSettingsMoneyCompliance"))}
          icon={<Landmark size={16} color={muted} aria-hidden />}
          summary={moneySummary}
          testId="advanced-section-money"
        >
          <YStack data-testid="advanced-section-tax">
            <EventTaxSection
              eventId={eventId}
              initialInstructionalAdmission={instructionalAdmission}
              eventStateCode={eventStateCode}
            />
          </YStack>
          {waiverBody && (
            <>
              <SectionDivider />
              <YStack data-testid="advanced-section-waiver">{waiverBody}</YStack>
            </>
          )}
          {financeBody && (
            <>
              <SectionDivider />
              <YStack data-testid="advanced-section-finance">
                {financeBody}
              </YStack>
            </>
          )}
        </SettingsGroup>
        {eventSlug && (
          <SettingsGroup
            label={String(t("admin.ebSettingsSharing"))}
            icon={<Link2 size={16} color={muted} aria-hidden />}
            summary={sharingSummary}
            testId="advanced-section-slug"
          >
            <EventSlugSection
              eventId={eventId}
              slug={eventSlug}
              shortId={eventShortId}
              eventStatus={eventStatus}
              publishedAt={eventPublishedAt}
              canRegenerate={canRegenerateSlug}
              onCopyEventLink={onCopyEventLink}
            />
          </SettingsGroup>
        )}
      </SettingsGroupsStack>
    </>
  );
}

export const BuilderSettingsSections = memo(BuilderSettingsSectionsImpl);

BuilderSettingsSections.displayName = "BuilderSettingsSections";
