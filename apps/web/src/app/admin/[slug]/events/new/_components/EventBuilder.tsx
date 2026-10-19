"use client";

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  useId,
  useDeferredValue,
  memo,
  type CSSProperties,
} from "react";
import { nanoid } from "nanoid";
import { useTheme, XStack, YStack } from "tamagui";
import { LayoutGrid, Gift, Send, Share2 } from "lucide-react";

import {
  Text,
  Button,
  Modal,
  useLocale,
  useNotify,
  useTranslations,
  FormErrorBanner,
} from "@th/ui";
import {
  HOST_ATTESTATION_FIELDS,
  type HostAttestationField,
} from "@th/core/use-cases/events/host-attestation-text";
import type { ProseMirrorDoc, EventBody } from "@th/schema";
import type { AddressRevealPreset, EventLocationMode } from "@th/types";

import { useRouter } from "@bprogress/next/app";

import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { extractOwnWithheldPlaceMeta } from "@/lib/own-withheld-place-error";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useFormErrors } from "@/hooks/useFormErrors";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { normalizeError } from "@/lib/errors/normalize-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { copyText } from "@/lib/calendar/calendar-actions";
import {
  extractQuotaExceededMeta,
  type QuotaExceededMeta,
} from "@/lib/quota-error";
import { QuotaExceededDialog } from "@/components/errors/QuotaExceededDialog";

const useTrpcUtils = trpc.useUtils;
import nextDynamic from "next/dynamic";
import {
  useEventImageUpload,
  MAX_EVENT_IMAGE_BYTES,
} from "./useEventImageUpload";
import { useStableHandler } from "./use-stable-handler";
import { cancelEventResultToasts } from "./cancel-event-toasts";
import { useEventMediaMaps } from "./useEventMediaMaps";
import {
  EVENT_IMAGE_UPLOAD_TYPES,
  validateImageUploadType,
} from "@/lib/images/event-image-upload";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";
import { useEventAudioUpload } from "./useEventAudioUpload";
// Heavy secondary surfaces are dynamically imported so Turbopack only pulls
// them into the dev module graph when actually rendered. Eager imports were
// adding ~85s of cold compile time on /admin/[slug]/events/[id] (see
// profiling notes). The ops surfaces (attendees / volunteers / comp /
// suggestions / feedback) now live at their own routes (FR-201/FR-207) and
// are imported by those pages instead.
const EventPreview = nextDynamic(
  () => import("./EventPreview").then((m) => ({ default: m.EventPreview })),
  { ssr: false },
);
const SeatingLayoutEditor = nextDynamic(
  () =>
    import("./SeatingLayoutEditor").then((m) => ({
      default: m.SeatingLayoutEditor,
    })),
  { ssr: false },
);
const ApplicationFormBuilder = nextDynamic(
  () =>
    import("./ApplicationFormBuilder").then((m) => ({
      default: m.ApplicationFormBuilder,
    })),
  { ssr: false },
);
import { createEmptyDoc, hasContent } from "./prose-editor";
import { computeEventReadiness } from "./event-readiness";
import { mapReadinessInput } from "./readiness-input";
import { PublishReadinessRail } from "./PublishReadinessRail";
import type { PlacePickerItem } from "@/components/places/PlacePicker";
import { TicketTypeEditor } from "./TicketTypeEditor";
import { toTemplateOwnerRef } from "./ticket-type-template-helpers";
import { LineupEditor } from "./LineupEditor";
import { SplitsEditor } from "./SplitsEditor";
import { PayoutsOwnerOnlyNote } from "./PayoutsOwnerOnlyNote";
import type { RecurrenceConfig } from "./RecurrenceBuilder";
import { reconcileWindowEndForConfig } from "./recurrence-helpers";
import { SeriesEditScopeDialog } from "./SeriesEditScopeDialog";
import {
  composeSyncToastMessage,
  shouldOfferScopeDialog,
  syncScopeForChoice,
  includeArrivalAreasForSave,
  arrivalAreasSyncField,
  type SeriesEditScope,
} from "./series-scope-helpers";
import { formatRowDate } from "../../[id]/dates/_components/series-dates-helpers";
import { ShareEventDialog } from "../../_components/ShareEventDialog";
import {
  clampToCeiling,
  isArchivedPlacePrivacyRead,
  shouldRetryPlacePrivacyRead,
  type VenueLocationCeiling,
} from "@/lib/places/venue-location-ceiling";
import type { LocationState, LocationMode } from "./LocationSection";
import { SettingsGroup, type SettingsGroupHandle } from "./SettingsGroup";
import {
  Container,
  BlocksSection,
  SectionDivider,
  SettingsGroupsStack,
} from "./_builder-styled";
import { BuilderHeaderBar } from "./BuilderHeaderBar";
import {
  buildBuilderSnapshot,
  comparableBody,
  hasUnsavedChanges,
  loadedFieldsSnapshot,
  rebaseBodyOnEditorSeed,
  savedFieldsSnapshot,
  snapshotBody,
  type BuilderSnapshotFields,
  type EditorSeed,
} from "./builder-unsaved.helpers";
import { StableActionLabel } from "./StableActionLabel";
import { BuilderEssentialsSection } from "./BuilderEssentialsSection";
import { EventPublicLinkField } from "./EventPublicLinkField";
import { eventPublicLink } from "./event-public-link.helpers";
import {
  EventProvenanceNote,
  type JustSavedBookingRequest,
} from "./EventProvenanceNote";
import {
  placementIsComplete,
  resolveBuilderPlacement,
  type BuilderPlacement,
  type BuilderPlacementSource,
} from "./builder-placement.helpers";
import {
  eventFirstSkipFromSave,
  eventFirstSkipIsCurrent,
  eventFirstSkipSnapshot,
  type EventFirstSkipSnapshot,
  type SaveEventBookingSkip,
} from "./event-first-skip.helpers";
import { BuilderDetailsSection } from "./BuilderDetailsSection";
import {
  resolveStarterCategory,
  starterKindForCategory,
} from "./description-starters";
import { BuilderSettingsSections } from "./BuilderSettingsSections";
import { builderAdminActionGates } from "./builder-admin-action-gates";
import {
  CommunityLiveEditNotice,
  CommunityLockedNotice,
} from "./CommunityListingNotices";
import { CommunityLiveSaveDialog } from "./CommunityLiveSaveDialog";
import {
  anchorCommunityFieldError,
  buildCommunityUpdateFields,
  communityIsLive,
  communityLocationIsPinned,
  communityPlaceRefusalMessageKey,
  communityLockedStatus,
  diffCommunityMaterialGroups,
  formatCommunityAddressLabel,
  formatCommunityScheduleWindow,
  isCommunityStewardship,
  type CommunityLiveSaveDiff,
} from "./community-builder.helpers";
import {
  BuilderReconcileDialog,
  type ReconcilePendingItem,
} from "./BuilderReconcileDialog";
import {
  ChargebackTermsDialog,
  HostAttestationDialog,
} from "./BuilderPublishDialogs";
import {
  buildHostAttestationSubmission,
  createEmptyHostAttestationState,
  extractMissingHostAttestationFields,
  isAttestationIncompleteError,
  isHoldLineOpenChallengeError,
  resolveChargebackTermsAcceptanceTarget,
  resolveStoredChargebackTermsOwner,
  type ChargebackTermsModalMode,
  type HostAttestationState,
  type HostAttestationSubmission,
} from "./publish-gate-helpers";
import { isChargebackTermsRequiredError } from "@/lib/chargeback-terms-errors";
import { useStoredChargebackTermsAcceptance } from "@/app/admin/[slug]/payouts/_components/chargeback-terms-acceptance";
import {
  getEditableAddressRevealPreset,
  getPreviewDateTimeIso,
  isLocationUnsaved,
  isStartInPast,
  resolveAddressRevealSaveInput,
  toDateTimeLocalValue,
  toIsoInTimeZone,
} from "./event-builder-helpers";
import {
  resolveTimezoneForPlaceSelection,
  type TimezoneAdoptionSource,
} from "./event-timezone";
import { useAddressTimezoneAdoption } from "./use-address-timezone";
import {
  useEventNavActions,
  type EventBuildSectionId,
} from "../../../_components/event-nav-context";
import type { EventViewMode } from "./EventViewModeToggle";

// ── Re-render isolation (perf) ────────────────────────────────────────────
// EventBuilder keeps every field as its own useState, so each keystroke
// re-renders this component. What it renders is therefore kept deliberately
// small: the authoring surface itself lives in memoized sibling components
// (BuilderHeaderBar / BuilderEssentialsSection / BuilderDetailsSection /
// BuilderSettingsSections / the publish dialogs), each of which takes only
// primitives, state objects, and useCallback'd handlers so React.memo really
// bails out. The heavy always-mounted child surfaces get the same treatment
// here. TicketTypeEditor's `eventTitle` is the one churny prop — it's fed
// through useDeferredValue below so typing in the Title field stays
// high-priority while the ticket editor catches up at idle.
const MemoTicketTypeEditor = memo(TicketTypeEditor);
const MemoLineupEditor = memo(LineupEditor);
const MemoSplitsEditor = memo(SplitsEditor);
const MemoPublishReadinessRail = memo(PublishReadinessRail);

// Static inline styles, hoisted so they aren't re-created (and re-diffed)
// on every keystroke.
const MAIN_COLUMN_STYLE: CSSProperties = { minWidth: 0 };
const HIDDEN_STYLE: CSSProperties = { display: "none" };
const GRID_LAYOUT_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 296px",
  gap: 24,
  alignItems: "start",
  width: "100%",
  maxWidth: 1328,
  margin: "0 auto",
  paddingLeft: 24,
  paddingRight: 24,
};

export type EventBuilderProps = {
  ownerType: "human" | "org";
  ownerId: string;
  /**
   * Admin slug used for building navigation links (e.g. to applications page).
   */
  slug?: string;
  /**
   * The event being edited. Always required (FR-302) — the quick-create page
   * (`/events/new`, FR-301) creates the draft and routes here, so the builder
   * has no create mode.
   */
  eventId: string;
  onSave?: (eventId: string) => void;
  onCancel?: () => void;
  /**
   * Open the seating-layout takeover on mount (FR-205). Set by the /edit page
   * when the legacy `?tab=seating` deep link lands as `?seating=legacy` — the
   * takeover only actually renders when the event has a placeLayoutId and the
   * seatingLayouts gate is on, so a stale link degrades to the plain Build
   * surface.
   */
  initialSeatingOpen?: boolean;
  /**
   * Whether the current viewer can mutate this event. When false (FINANCE,
   * VIEWER, SCANNER), the tab bar and Save/Publish affordances are hidden and
   * the surface renders the read-only event preview directly (FR-204 —
   * the old read-only Preview tab, minus the tab chrome). Ops surfaces
   * (attendees / volunteers) remain reachable at their own routes.
   */
  canEditEvent?: boolean;
  /**
   * Whether the viewer may take ADMIN-LEVEL actions: unpublish, cancel, and
   * regenerate a PUBLISHED event's slug. ORG_ADMIN_ROLES on an org event; the
   * owner or an OWNER/ADMIN delegate on a personal one — the bar
   * `unpublishEvent`, `cancelEvent` and `regenerateEventSlug` enforce. From
   * `EventAdminPageShell`'s `canManageEvent`. Defaults to false: a mount that
   * does not say hides the actions rather than offer ones the server refuses.
   */
  canManageEvent?: boolean;
  /**
   * Surface mode (event-builder regroup FR-201). When `"edit"` the builder is
   * mounted at `/admin/:slug/events/:id/edit`; the ops surfaces (attendees /
   * volunteers / comp / suggestions / feedback) live at their REAL sibling
   * routes and are reached from the contextual admin rail (FR-202) — the
   * temporary in-builder tab bar is gone (FR-207).
   */
  surface?: "edit";
  /**
   * Deep-link target section (`?section=…` on the edit route): scrolls the
   * matching Build section into view once the edit data has rendered.
   * `"scheduling"` additionally expands the Scheduling settings group (the
   * Dates page's "Edit schedule" action — the builder's recurrence section
   * stays the canonical schedule editor).
   */
  focusSection?: EventBuildSectionId | "scheduling";
  /**
   * Initial main-column mode (`?view=preview` on the edit route — D4
   * reversed): "preview" opens the in-place preview of the current form
   * state instead of the authoring form. Editors only; read-only viewers
   * always render the preview as the whole surface.
   */
  initialViewMode?: EventViewMode;
};

const EMPTY_DOC: ProseMirrorDoc = createEmptyDoc();

/** Out of layout, still read aloud (the `.sr-only` rule, which this route does not load). */
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * The preview toggle's own history entry: the unsaved-changes guard must not
 * base its Back sentinel on it, since the toggle pops it on its own.
 */
const isPreviewUrl = (url: URL) => url.searchParams.get("view") === "preview";

export function EventBuilder({
  ownerType,
  ownerId,
  slug,
  eventId,
  onSave,
  onCancel,
  initialSeatingOpen = false,
  canEditEvent = true,
  canManageEvent = false,
  surface,
  focusSection,
  initialViewMode,
}: EventBuilderProps) {
  const theme = useTheme();
  const t = useTranslations();
  const locale = useLocale();
  const utils = useTrpcUtils();
  const router = useRouter();
  const isMobile = useIsMobile();
  /**
   * `community.*` writes sit behind the staff second-factor guard, which
   * answers FORBIDDEN / `SECOND_FACTOR_REQUIRED`. The shared handler shows the
   * enrolment prompt WITH a link rather than hard-redirecting: a redirect out
   * of the builder would throw away whatever the moderator had typed.
   */
  const handleSecondFactorRequired = useSecondFactorRequiredToast();
  const stickyTopBarRef = useRef<HTMLDivElement | null>(null);
  const {
    fieldErrors,
    formError,
    setError: setSaveError,
    setFieldError,
    clearField,
    clearAll: clearErrors,
  } = useFormErrors<"title" | "startsAt" | "endsAt">();
  const [title, setTitle] = useState("");
  // Low-priority mirror of `title` for the memoized TicketTypeEditor: typing
  // in the Title field re-renders at input priority with the old deferred
  // value (memo bails out), and the ticket editor catches up at idle.
  const deferredTitle = useDeferredValue(title);
  const [stickyTopOffset, setStickyTopOffset] = useState(0);
  const [startsAt, setStartsAt] = useState<string | undefined>();
  const [endsAt, setEndsAt] = useState<string | undefined>();
  const [locationSearch, setLocationSearch] = useState("");
  const [location, setLocation] = useState<LocationState>({});
  const [locationMode, setLocationMode] = useState<LocationMode>("address");
  const [selectedPlace, setSelectedPlace] = useState<PlacePickerItem | null>(
    null,
  );
  /**
   * Third-party venue cascade (intent / calendar / space) — see
   * `builder-placement.helpers.ts`. Null = nothing minted: an owned or
   * granted venue, an address, or a hydrated venue the organizer has not
   * touched (the save then leaves the stored placement alone).
   */
  const [placement, setPlacement] = useState<BuilderPlacement | null>(null);
  const [placementSource, setPlacementSource] =
    useState<BuilderPlacementSource>("hydrated");
  /**
   * True once the organizer touched the cascade (or a venue picked this
   * session committed its defaults). Only a dirty placement goes on the wire:
   * a hydrated venue's STORED placement is seeded for display and must not be
   * re-sent as if it were a change.
   */
  const [placementDirty, setPlacementDirty] = useState(false);
  const handlePlacementChange = useCallback(
    (next: BuilderPlacement | null) => {
      setPlacement(next);
      setPlacementDirty(true);
    },
    [],
  );
  /** The booking request the LAST save created or found, for the tie band. */
  const [savedBookingRequest, setSavedBookingRequest] =
    useState<JustSavedBookingRequest | null>(null);
  /**
   * The LAST save's REFUSED ask (`bookingRequest.outcome === "skipped"`),
   * with a snapshot of what it was made of. Visibility is DERIVED: the
   * notice shows while venue / intent / calendar / start date still match
   * the snapshot and vanishes the moment any changes — a fresh attempt —
   * or the next save replaces it. Nothing survives a reload on purpose: a
   * refusal leaves no request row, so the provenance read has nothing to
   * report and the builder opens clean. That is expected, not a gap.
   */
  const [savedBookingSkip, setSavedBookingSkip] = useState<{
    skip: SaveEventBookingSkip;
    snapshot: EventFirstSkipSnapshot;
  } | null>(null);
  const visibleBookingSkip = useMemo(
    () =>
      savedBookingSkip &&
      eventFirstSkipIsCurrent(savedBookingSkip.snapshot, {
        placement,
        startsAt,
      })
        ? savedBookingSkip.skip
        : null,
    [savedBookingSkip, placement, startsAt],
  );
  const [visibilityMode, setVisibilityMode] =
    useState<EventLocationMode>("EXACT");
  /** Obfuscation radius in meters under OBSCURED; null = FULLY HIDDEN (no public map). */
  const [visibilityRadius, setVisibilityRadius] = useState<number | null>(500);
  const [visibilityLabel, setVisibilityLabel] = useState<string>("");
  const [addressRevealPreset, setAddressRevealPreset] =
    useState<AddressRevealPreset>("DAY_BEFORE");

  // ── THE VENUE CEILING (place-address-withholding) ────────────────────────
  //
  // An event at a venue that withholds its address cannot publish one either.
  // The server enforces this inside the save transaction (`save-event-shared`)
  // and re-applies it on read (`buildEventSeo`); everything below is the UI
  // courtesy that keeps an organizer from filling in a choice that is going to
  // be overruled without explanation.
  //
  // `places.getPlacePublic` is the read, deliberately: it is the ANONYMOUS
  // projection, so it answers the question actually being asked — "what may
  // this venue publish?" — rather than "what is this organizer allowed to
  // see?". It is also available for venues the organizer does not own, which
  // is most of the ones that need this (a performer booked into somebody's
  // house reaches this builder and is exactly who the address is hidden from).
  const ceilingPlaceId = selectedPlace?.placeId ?? null;
  const venuePrivacyQuery = trpc.places.getPlacePublic.useQuery(
    { placeId: ceilingPlaceId ?? "" },
    {
      enabled: Boolean(ceilingPlaceId),
      staleTime: 30_000,
      // A failed read falls back to `checking`, which LOCKS the exact option:
      // a place whose setting we cannot read is treated as withholding. One
      // retry, for transient failures only; a NOT_FOUND is final.
      retry: shouldRetryPlacePrivacyRead,
      // An archived place is a handled state, not an incident to log, report
      // or toast: `placeArchivedName` below shows it inline instead.
      meta: { silentWhen: isArchivedPlacePrivacyRead },
    },
  );
  /**
   * The selected place is ARCHIVED: its privacy read answered NOT_FOUND /
   * PLACE_ARCHIVED. That failure is silenced above, so this is the organizer's
   * only signal: the location field (both modes) shows "<name> is archived.
   * Pick another place." and the address-visibility lock names the same cause
   * instead of "checking". The ceiling itself stays `checking` (exact locked).
   * Null when the place is not known to be archived, and when it has no name
   * to give (" is archived" says nothing; the lock then reads "checking").
   */
  const placeArchivedName =
    ceilingPlaceId && isArchivedPlacePrivacyRead(venuePrivacyQuery.error)
      ? selectedPlace?.name?.trim() || null
      : null;

  const venueCeiling = useMemo<VenueLocationCeiling>(() => {
    if (!ceilingPlaceId) return { state: "none" };
    const place = venuePrivacyQuery.data?.place;
    // No answer yet, or the read failed: unknown locks, it does not open.
    if (!place) return { state: "checking" };
    if (place.locationIsExact) return { state: "none" };
    const venueName = place.name?.trim() || selectedPlace?.name || "";
    if (place.locationHidden || place.locationRadiusMeters == null) {
      return { state: "hidden", venueName };
    }
    return {
      state: "area",
      venueName,
      radiusMeters: place.locationRadiusMeters,
    };
  }, [ceilingPlaceId, venuePrivacyQuery.data, selectedPlace?.name]);

  /**
   * Does the viewer MANAGE the selected venue? No read the builder makes
   * carries that as a flag, so it is read off the redaction: for a venue that
   * withholds its address, both reads that fill `selectedPlace` with a street
   * address — the picker's "Your venues" (`listHumanPlaces`) and edit
   * hydration (`getEventForEdit`'s place summary) — run `canManagePlace`
   * before handing `formattedAddress` over, and an "All venues" pick comes
   * from the anonymous projection, which never has one. So a withheld venue
   * with a street address in hand is one the viewer manages.
   *
   * Only consulted while the ceiling is a confirmed withhold — an EXACT
   * venue's address is public and says nothing about the viewer. The failure
   * direction is the safe one: a managed venue with no stored address reads
   * as unmanaged and gets one notice too many.
   */
  const viewerManagesVenue = Boolean(selectedPlace?.formattedAddress?.trim());

  /**
   * Bring the form's own state under the ceiling.
   *
   * Without this the lock would be cosmetic in the one case that matters: an
   * event created at an EXACT venue, then moved to a withheld one, would still
   * be holding `EXACT` in state and would still POST it — the server would
   * clamp it, silently, and the organizer would never learn their choice had
   * been discarded. Clamping here makes what is submitted match what is shown.
   *
   * It is NOT the guarantee (an API caller never runs this), and it
   * deliberately does nothing while the ceiling is `checking`: rewriting a
   * saved choice on the strength of a read that has not come back would be the
   * UI inventing policy. The functional updaters below return the identical
   * value when nothing needs to change, so React bails out and this does not
   * loop.
   */
  useEffect(() => {
    if (venueCeiling.state === "none" || venueCeiling.state === "checking") {
      return;
    }
    const clamped = clampToCeiling(
      { mode: visibilityMode, radiusMeters: visibilityRadius },
      venueCeiling,
    );
    // Guarded so the effect is a no-op once the state already satisfies the
    // ceiling — it re-runs on every slider nudge and must not set state (and
    // re-render) for a value it is not changing.
    if (clamped.mode !== visibilityMode) setVisibilityMode(clamped.mode);
    if (clamped.radiusMeters !== visibilityRadius) {
      setVisibilityRadius(clamped.radiusMeters);
    }
  }, [venueCeiling, visibilityMode, visibilityRadius]);
  const [addressRevealAt, setAddressRevealAt] = useState<string>("");
  const [addressRevealPresetTouched, setAddressRevealPresetTouched] =
    useState(false);
  /** Inline error for the CUSTOM reveal datetime — set on save attempt, cleared on edit. */
  const [revealCustomError, setRevealCustomError] = useState<string | null>(
    null,
  );
  /**
   * The zone the organizer's typed wall clock is interpreted in — read by
   * every `toIsoInTimeZone` call in the save path and sent as `timezone`.
   *
   * Seeded from the browser as the LAST resort only: an existing event
   * overwrites it from `existing.timezone` during hydration, and picking a
   * venue adopts that venue's derived zone (see `./event-timezone.ts`, which
   * documents the wall-clock-stays interpretation). The browser value is not a
   * good guess — it is just the only one available before either arrives, and
   * it is what the wall clock in the date inputs already means at that point.
   */
  const [eventTimezone, setEventTimezone] = useState<string>(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
  );
  /**
   * What the builder most recently adopted its zone FROM — a picked venue or a
   * freeform address's coordinates — or null. Drives the note under the date
   * fields: the zone must never move silently, because on a saved event it
   * moves the show.
   */
  const [timezoneAdoptedFrom, setTimezoneAdoptedFrom] =
    useState<TimezoneAdoptionSource | null>(null);
  /**
   * COMMUNITY mode only. Owned events keep saving their category through
   * `CategoryTagsSection`'s own mutation; a community listing has no owner, so
   * `categories.setEventCategory` refuses it and `categoryId` rides the
   * `community.updateListing` whitelist instead — which means the builder has
   * to hold the value.
   */
  const [communityCategoryId, setCommunityCategoryId] = useState<string | null>(
    null,
  );
  const [heroImageUrl, setHeroImageUrl] = useState<string | undefined>();
  const [heroImageFile, setHeroImageFile] = useState<File | null>(null);
  /** True when the user explicitly removed the hero image (send heroImageId: null). */
  const [heroImageRemoved, setHeroImageRemoved] = useState(false);
  const [bodyContent, setBodyContent] = useState<ProseMirrorDoc>(EMPTY_DOC);
  const handleBodyChange = useCallback(
    (doc: ProseMirrorDoc) => setBodyContent(doc),
    [],
  );
  // Seating-layout takeover (FR-205): launched from the Tickets section (or
  // the legacy `?tab=seating` deep link) instead of living as a peer tab.
  const [seatingTakeoverOpen, setSeatingTakeoverOpen] =
    useState(initialSeatingOpen);
  const { gates } = useFeatureGates();
  const [isSaving, setIsSaving] = useState(false);
  const [quotaMeta, setQuotaMeta] = useState<QuotaExceededMeta | null>(null);
  const [recurrenceEnabled, setRecurrenceEnabled] = useState(false);
  const [recurrenceConfig, setRecurrenceConfig] =
    useState<RecurrenceConfig | null>(null);
  /**
   * One-shot guard for the series prefill effect. Guarding on
   * `!recurrenceConfig` would re-fire after the user picks "Doesn't repeat"
   * (which emits a null config) and snap the select back to the stored
   * schedule — making "Doesn't repeat" unreachable for series events.
   */
  const seriesPrefilledRef = useRef(false);
  // ── Series edit-scope dialog (Phase 3) ──────────────────────────────────
  // "Apply changes to: this show / this and following / all shows" — asked
  // before saving an event that already belongs to a series.
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
  const [scopeChoice, setScopeChoice] = useState<SeriesEditScope>("this");
  /** The dialog's "Also replace parking and drop-off areas" box (Q13). */
  const [scopeIncludeArrivalAreas, setScopeIncludeArrivalAreas] =
    useState(false);
  /** Busy state for the dialog's Save — held through save + draft sync. */
  const [scopeSaving, setScopeSaving] = useState(false);
  const scopeSavingRef = useRef(false);
  /** Re-entrancy guard for the save funnel (header, Cmd/Ctrl+S, scope dialog). */
  const saveInFlightRef = useRef(false);
  /**
   * syncSeriesDrafts scope for the IN-FLIGHT save; null = no propagation
   * ("This show only"). A ref (not state) because the reconcile-confirm
   * detour re-enters the flow asynchronously (handleReconcileConfirm) and
   * must still see the choice stashed by the interrupted save.
   */
  const pendingSyncScopeRef = useRef<"future" | "all" | null>(null);
  /** Rides with `pendingSyncScopeRef`: replace sibling drafts' arrival areas too. */
  const pendingSyncIncludeAreasRef = useRef(false);
  const [hasLoadedExisting, setHasLoadedExisting] = useState(false);
  const [formBuilderOpen, setFormBuilderOpen] = useState(false);
  const handleOpenFormBuilder = useCallback(() => setFormBuilderOpen(true), []);
  const savedLocationRef = useRef<{
    location: LocationState;
    search: string;
  } | null>(null);

  // ── Unsaved changes (derived) ───────────────────────────────────────────
  // Dirty = the Save-button fields or the body differ from a baseline taken
  // once the event has loaded, and replaced by what each successful save
  // sent. Nothing stores "dirty"; see `builder-unsaved.helpers.ts`.
  const formFields = useMemo<BuilderSnapshotFields>(
    () => ({
      title,
      startsAt,
      endsAt,
      location,
      locationMode,
      placeId: selectedPlace?.placeId ?? null,
      placement: placementDirty ? placement : null,
      visibilityMode,
      visibilityRadius,
      visibilityLabel,
      addressRevealPreset,
      addressRevealAt,
      eventTimezone,
      communityCategoryId,
      heroStaged: heroImageFile !== null,
      heroRemoved: heroImageRemoved,
      recurrenceEnabled,
      recurrenceConfig,
    }),
    [
      title,
      startsAt,
      endsAt,
      location,
      locationMode,
      selectedPlace?.placeId,
      placementDirty,
      placement,
      visibilityMode,
      visibilityRadius,
      visibilityLabel,
      addressRevealPreset,
      addressRevealAt,
      eventTimezone,
      communityCategoryId,
      heroImageFile,
      heroImageRemoved,
      recurrenceEnabled,
      recurrenceConfig,
    ],
  );
  const fieldsSnapshot = useMemo(
    () => buildBuilderSnapshot(formFields),
    [formFields],
  );
  const rawBodySnapshot = useMemo(
    () => snapshotBody(bodyContent),
    [bodyContent],
  );
  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null);
  const bodySnapshot = comparableBody(rawBodySnapshot, editorSeed);
  /** The form as a save sends it; read at send time by both save paths. */
  const sendableFormRef = useRef({ fields: formFields, body: bodySnapshot });
  useEffect(() => {
    sendableFormRef.current = { fields: formFields, body: bodySnapshot };
  });
  const [baselineFields, setBaselineFields] = useState<string | null>(null);
  const [baselineBody, setBaselineBody] = useState<string | null>(null);
  /** Call after a successful save with what that save sent. */
  const markSaved = useCallback(
    (sent: { fields: BuilderSnapshotFields; body: string }) => {
      setBaselineFields(savedFieldsSnapshot(sent.fields));
      setBaselineBody(sent.body);
    },
    [],
  );

  // ── Settings-group disclosure (FR-102/FR-103) ───────────────────────────
  // Each SettingsGroup owns its own open state (uncontrolled), so a header
  // click re-renders that group and nothing else. The three groups that a deep
  // link must be able to FORCE open are reached imperatively through their
  // `SettingsGroupHandle` — never through builder state.
  const accessAnchorRef = useRef<HTMLDivElement | null>(null);
  const accessGroupRef = useRef<SettingsGroupHandle | null>(null);
  const accessHeaderId = useId();
  const handleHideAddressLink = useCallback(() => {
    accessGroupRef.current?.open();
    if (typeof window === "undefined") return;
    // Wait a frame so the group region has rendered before scrolling; honour
    // prefers-reduced-motion by swapping smooth scrolling for an instant jump.
    requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      document.getElementById(accessHeaderId)?.focus({ preventScroll: true });
      accessAnchorRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    });
  }, [accessHeaderId]);

  // Scheduling group (deep-linked via ?section=scheduling): expanded on mount
  // for the Dates page's "Edit schedule" link, and re-openable via the handle
  // when the jump funnel replays a later in-app navigation.
  const schedulingAnchorRef = useRef<HTMLDivElement | null>(null);
  const schedulingGroupRef = useRef<SettingsGroupHandle | null>(null);
  const schedulingDefaultOpen = focusSection === "scheduling";
  // The rail's "Revenue splits" anchor expands the collapsed no-lineup
  // disclosure before scrolling to it (same pattern as scheduling).
  const splitsGroupRef = useRef<SettingsGroupHandle | null>(null);

  // ── Build-section anchors (FR-202 rail scroll-spy + FR-104 readiness) ───
  // Scroll/focus targets for the contextual rail's Build anchors, the
  // readiness rail's deep-links, and the `?section=` deep link. Mirrors the
  // "Hide the address?" pattern: instant jump under prefers-reduced-motion,
  // scroll-margin so the sticky bar never covers the section heading.
  const essentialsSectionRef = useRef<HTMLDivElement | null>(null);
  const detailsSectionRef = useRef<HTMLDivElement | null>(null);
  const ticketsSectionRef = useRef<HTMLDivElement | null>(null);
  const lineupSectionRef = useRef<HTMLDivElement | null>(null);
  const splitsSectionRef = useRef<HTMLDivElement | null>(null);
  const settingsSectionRef = useRef<HTMLDivElement | null>(null);

  const getBuildSectionEl = useCallback(
    (sectionId: EventBuildSectionId): HTMLDivElement | null => {
      switch (sectionId) {
        case "essentials":
          return essentialsSectionRef.current;
        case "details":
          return detailsSectionRef.current;
        case "tickets":
          return ticketsSectionRef.current;
        case "lineup":
          return lineupSectionRef.current;
        case "splits":
          return splitsSectionRef.current;
        case "settings":
          return settingsSectionRef.current;
      }
    },
    [],
  );

  const jumpToBuildSection = useCallback(
    (sectionId: EventBuildSectionId | "scheduling") => {
      if (typeof window === "undefined") return;
      if (sectionId === "scheduling") {
        // The recurrence editor lives inside the Scheduling settings group —
        // expand it so the scroll target isn't a collapsed header.
        schedulingGroupRef.current?.open();
      }
      if (sectionId === "splits") {
        // With no lineup the splits editor renders as a collapsed disclosure —
        // expand it so the jump lands on content, not a closed header.
        // (No-op when a lineup exists: the group isn't rendered then.)
        splitsGroupRef.current?.open();
      }
      const target =
        sectionId === "scheduling"
          ? schedulingAnchorRef.current
          : getBuildSectionEl(sectionId);
      if (!target) return;
      // Wait a frame so any just-expanded content has rendered; honour
      // prefers-reduced-motion by swapping smooth scrolling for an instant
      // jump. Keyboard focus moves to the section container (tabIndex=-1 —
      // programmatic focus only, no tab-order pollution, no trap).
      requestAnimationFrame(() => {
        const reduceMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        target.focus({ preventScroll: true });
        target.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "start",
        });
      });
    },
    [getBuildSectionEl],
  );

  // Readiness-rail deep-links reuse the same targets under their own ids.
  // The category item lands on the category picker itself (it sits mid-way
  // down Essentials) and focuses its input, which opens the list. The ids are
  // CategoryTagsSection's `testIdBase="event-category-picker"` — the
  // AutocompleteField container, and `-input` on the <input>. Falls back to
  // the Essentials section if the picker isn't rendered.
  const handleJumpToReadinessSection = useCallback(
    (sectionId: "essentials" | "category" | "details" | "ticketTypes") => {
      if (sectionId === "category" && typeof window !== "undefined") {
        const picker = getBuildSectionEl(
          "essentials",
        )?.querySelector<HTMLElement>('[data-testid="event-category-picker"]');
        if (picker) {
          requestAnimationFrame(() => {
            const reduceMotion = window.matchMedia(
              "(prefers-reduced-motion: reduce)",
            ).matches;
            picker
              .querySelector<HTMLElement>(
                '[data-testid="event-category-picker-input"]',
              )
              ?.focus({ preventScroll: true });
            picker.scrollIntoView({
              behavior: reduceMotion ? "auto" : "smooth",
              block: "center",
            });
          });
          return;
        }
      }
      jumpToBuildSection(
        sectionId === "ticketTypes"
          ? "tickets"
          : sectionId === "category"
            ? "essentials"
            : sectionId,
      );
    },
    [getBuildSectionEl, jumpToBuildSection],
  );

  // ── In-view preview toggle (D4 reversed, 2026-07-28) ────────────────────
  // "preview" swaps the main column to EventPreview fed with the CURRENT
  // in-memory form state (unsaved edits preview live — the old Preview tab's
  // key property). The edit column stays mounted (display:none) so form and
  // child-editor state survive the round trip. Editors only.
  const [viewMode, setViewMode] = useState<EventViewMode>(
    canEditEvent && initialViewMode === "preview" ? "preview" : "edit",
  );
  const isPreviewMode = canEditEvent && viewMode === "preview";
  /**
   * Mirror of `viewMode`, updated SYNCHRONOUSLY on every switch so the
   * `popstate` listener (an async browser event) never reads a stale value
   * mid-render.
   */
  const viewModeRef = useRef(viewMode);
  /** Edit-column scroll position, restored when leaving preview. */
  const editModeScrollYRef = useRef(0);
  /** Rail jump requested while in preview — replayed once Edit re-renders. */
  const pendingRailJumpRef = useRef<EventBuildSectionId | "scheduling" | null>(
    null,
  );
  /**
   * True while the CURRENT history entry is a preview entry WE pushed on top
   * of the edit URL — exiting can then `history.back()` instead of growing
   * the stack. False when the user deep-linked straight into `?view=preview`
   * (no edit entry behind us), where exit falls back to `replaceState`.
   */
  const pushedPreviewEntryRef = useRef(false);
  /**
   * Re-entrancy guard: set right before OUR OWN `history.back()` so the
   * resulting `popstate` is swallowed (the mode/scroll change was already
   * applied by the toggle path).
   */
  const selfPopRef = useRef(false);
  /**
   * The builder's pathname, captured at mount. A `popstate` that lands on a
   * DIFFERENT pathname is a cross-route navigation owned by Next's router
   * (which unmounts us) — never interpret it as a view-mode change.
   */
  const mountPathnameRef = useRef<string | null>(
    typeof window === "undefined" ? null : window.location.pathname,
  );

  // Shallow URL sync (`?view=preview`) via the native history API — the
  // Next-sanctioned shallow-routing tool (see next/dist/docs "Shallow routing
  // on the client"); no Next re-navigation, same pattern as SettingsSurface.
  //
  // Entering preview PUSHES a new entry (marked `{ thPreview: true }`) so the
  // browser Back button returns to the editor instead of leaving the builder
  // — the natural inclination on a full-screen preview. Exiting pops that
  // entry back off when we pushed it, keeping the stack flat.
  const applyViewModeToUrl = useCallback((mode: EventViewMode) => {
    if (typeof window === "undefined") return;
    if (mode === "preview") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "preview");
      window.history.pushState(
        { thPreview: true },
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
      pushedPreviewEntryRef.current = true;
    } else if (
      pushedPreviewEntryRef.current &&
      new URL(window.location.href).searchParams.get("view") === "preview"
    ) {
      // We pushed this preview entry from the edit URL — pop it so
      // enter/exit round trips don't grow the history stack. Guarded on the
      // URL still SAYING preview: if a browser-Back traversal already moved
      // location off our entry (Back-then-toggle race), a second
      // history.back() here would land one entry too far — outside the
      // builder.
      pushedPreviewEntryRef.current = false;
      selfPopRef.current = true;
      window.history.back();
    } else {
      // Deep-linked straight into `?view=preview` (no edit entry behind us),
      // or the raced traversal above already landed — rewrite in place.
      pushedPreviewEntryRef.current = false;
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      window.history.replaceState(
        {},
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  }, []);

  /**
   * Core mode switch (state + scroll choreography). `syncUrl: false` is the
   * popstate path — the browser already moved the URL, so touching history
   * again would corrupt the stack.
   */
  const switchViewMode = useCallback(
    (mode: EventViewMode, opts: { syncUrl: boolean }) => {
      if (mode === viewModeRef.current) return;
      if (typeof window !== "undefined") {
        if (mode === "preview") {
          editModeScrollYRef.current = window.scrollY;
          window.scrollTo({ top: 0 });
        } else if (!pendingRailJumpRef.current) {
          // Restore where the user was in the form — after the re-render, so
          // the edit column has its height back. Skipped when a rail jump is
          // pending (the jump owns the scroll destination).
          const top = editModeScrollYRef.current;
          requestAnimationFrame(() => window.scrollTo({ top }));
        }
      }
      viewModeRef.current = mode;
      setViewMode(mode);
      if (opts.syncUrl) applyViewModeToUrl(mode);
    },
    [applyViewModeToUrl],
  );

  const handleViewModeChange = useCallback(
    (mode: EventViewMode) => switchViewMode(mode, { syncUrl: true }),
    [switchViewMode],
  );

  // Browser Back/Forward over the preview entry: exit (or re-enter) preview
  // in place instead of letting Back feel like it should leave the builder.
  // Read-only roles have no toggle — preview IS their surface — so no
  // listener. Same popstate pattern as SettingsSurface: pops that land
  // outside this page are left to Next's router.
  useEffect(() => {
    if (!canEditEvent) return;
    const onPopState = () => {
      if (selfPopRef.current) {
        // Echo of our own history.back() — already handled by the toggle.
        selfPopRef.current = false;
        return;
      }
      if (window.location.pathname !== mountPathnameRef.current) return;
      const wantsPreview =
        new URLSearchParams(window.location.search).get("view") === "preview";
      if (wantsPreview && viewModeRef.current === "edit") {
        // Forward into the preview entry we pushed earlier — the edit entry
        // sits right behind it again, so a toggle-exit may pop.
        pushedPreviewEntryRef.current = true;
        switchViewMode("preview", { syncUrl: false });
      } else if (!wantsPreview && viewModeRef.current === "preview") {
        // Browser Back out of preview → return to the editor.
        pushedPreviewEntryRef.current = false;
        switchViewMode("edit", { syncUrl: false });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [canEditEvent, switchViewMode]);

  /**
   * Jump funnel for the rail anchors + `?section=` deep link: from preview,
   * switch back to Edit first and replay the jump once the edit column is
   * visible again (its sections are display:none while previewing).
   */
  const handleSectionJumpRequest = useCallback(
    (sectionId: EventBuildSectionId | "scheduling") => {
      if (isPreviewMode) {
        pendingRailJumpRef.current = sectionId;
        handleViewModeChange("edit");
        return;
      }
      jumpToBuildSection(sectionId);
    },
    [isPreviewMode, handleViewModeChange, jumpToBuildSection],
  );

  useEffect(() => {
    if (viewMode !== "edit") return;
    const pending = pendingRailJumpRef.current;
    if (!pending) return;
    pendingRailJumpRef.current = null;
    jumpToBuildSection(pending);
  }, [viewMode, jumpToBuildSection]);

  // `?section=` deep link: scroll once the edit data has rendered (the
  // sections only exist then). Keyed per value so a later in-app navigation
  // to a different section re-fires, but data refetches don't re-scroll.
  // Routed through the jump funnel so `?section=` wins over `?view=preview`
  // (a section link is edit intent).
  const focusSectionDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusSection || focusSectionDoneRef.current === focusSection) return;
    if (!hasLoadedExisting) return;
    if (typeof window === "undefined") return;
    focusSectionDoneRef.current = focusSection;
    handleSectionJumpRequest(focusSection);
  }, [focusSection, hasLoadedExisting, handleSectionJumpRequest]);

  // ── Contextual-rail bridge (FR-202) ─────────────────────────────────────
  // Registers the jump handler (rail Build anchors scroll in place instead of
  // re-navigating) and reports the active section from an
  // IntersectionObserver-driven, rAF-throttled scroll-spy.
  //
  // Perf: consume the ACTIONS context only — its identity is stable, so the
  // scroll-spy state this component itself reports can never re-render the
  // whole builder tree (that state lives in the sibling STATE context, which
  // only the rail consumes).
  const eventNavActions = useEventNavActions();
  const registerJumpHandler = eventNavActions?.registerJumpHandler;
  const reportActiveSection = eventNavActions?.setActiveSection;

  useEffect(() => {
    if (!registerJumpHandler || surface !== "edit" || !canEditEvent) return;
    // The funnel (not the raw jump): a rail anchor clicked while previewing
    // switches back to Edit and then jumps.
    return registerJumpHandler(handleSectionJumpRequest);
  }, [registerJumpHandler, surface, canEditEvent, handleSectionJumpRequest]);

  useEffect(() => {
    if (!reportActiveSection || surface !== "edit" || !canEditEvent) return;
    if (!hasLoadedExisting) return;
    // Scroll-spy pauses while previewing — the sections are display:none and
    // would report garbage rects.
    if (viewMode !== "edit") return;
    if (
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const sectionIds: EventBuildSectionId[] = [
      "essentials",
      "details",
      "tickets",
      "lineup",
      "splits",
      "settings",
    ];

    let rafId: number | null = null;
    const compute = () => {
      rafId = null;
      // Reading line: just under the sticky bar plus a quarter of the
      // remaining viewport — the active section is the last one whose top
      // sits above it.
      const line =
        stickyTopOffset + (window.innerHeight - stickyTopOffset) * 0.25;
      // Default to the first rendered section (viewport above it all), then
      // advance to the last section whose top sits above the reading line.
      let active: EventBuildSectionId | null = null;
      for (const id of sectionIds) {
        const el = getBuildSectionEl(id);
        if (!el) continue;
        if (active === null) active = id;
        if (el.getBoundingClientRect().top <= line) active = id;
      }
      if (active) reportActiveSection(active);
    };
    const schedule = () => {
      if (rafId == null) rafId = requestAnimationFrame(compute);
    };

    // The observer only fires at band crossings; the rAF-throttled compute
    // then resolves which section owns the reading line.
    const observer = new IntersectionObserver(schedule, {
      rootMargin: `-${Math.round(stickyTopOffset)}px 0px -75% 0px`,
      threshold: [0, 1],
    });
    for (const id of sectionIds) {
      const el = getBuildSectionEl(id);
      if (el) observer.observe(el);
    }
    schedule();

    return () => {
      observer.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [
    reportActiveSection,
    surface,
    canEditEvent,
    hasLoadedExisting,
    viewMode,
    stickyTopOffset,
    getBuildSectionEl,
  ]);

  const handleLocationModeChange = useCallback(
    (mode: LocationMode) => {
      setLocationMode(mode);
      if (mode === "place") {
        savedLocationRef.current = { location, search: locationSearch };
        setLocation({});
        setLocationSearch("");
      } else if (mode === "address" && savedLocationRef.current) {
        setLocation(savedLocationRef.current.location);
        setLocationSearch(savedLocationRef.current.search);
        setSelectedPlace(null);
        setPlacement(null);
        setPlacementDirty(false);
        // The venue is gone, so the "adopted from <venue>" note would be
        // stale. The ZONE itself deliberately stays: the organizer's typed
        // times keep meaning what they meant, and a freeform address has no
        // zone of its own to fall back to.
        setTimezoneAdoptedFrom(null);
      }
    },
    [location, locationSearch],
  );

  /**
   * Place-picker selection. Adopts the venue's zone so the wall clock the
   * organizer types means "at the venue" — the whole rule (and the
   * wall-clock-stays interpretation) lives in `./event-timezone.ts`.
   *
   * `useStableHandler` keeps the identity permanently stable so the memoized
   * Essentials section still bails out on unrelated builder state changes
   * (see EventBuilderRenderIsolation.test.tsx).
   */
  const handlePlaceSelect = useStableHandler(
    (place: PlacePickerItem | null) => {
      setSelectedPlace(place);
      // Re-picking the venue the event is already at is not a new venue:
      // the stored placement (and its dirty/hydrated state) stays, exactly
      // as the zone below no-ops on the same re-pick. Otherwise a venue
      // chosen NOW: the cascade (third parties only) commits its defaults
      // once the options load, and any placement minted for the previous
      // venue is dropped — it belongs to another place's rows.
      const samePlace =
        place !== null && place.placeId === selectedPlace?.placeId;
      if (!samePlace) {
        setPlacement(null);
        setPlacementDirty(false);
        setPlacementSource("picked");
      }
      const { timezone, adopted } = resolveTimezoneForPlaceSelection({
        currentTimezone: eventTimezone,
        previousPlaceId: selectedPlace?.placeId ?? null,
        place,
      });
      if (adopted) {
        setEventTimezone(timezone);
        setTimezoneAdoptedFrom(adopted.source);
      } else if (!place) {
        setTimezoneAdoptedFrom(null);
      }
    },
  );

  /**
   * Freeform-address zone adoption — the other half of the same rule.
   *
   * A picked venue hands over `Place.timezone` synchronously; a typed or
   * dragged address only has coordinates, so the zone is looked up
   * (`places.resolveTimezone`) and then judged by the SAME test. See
   * `./use-address-timezone.ts` for the request gating and why `enabled` waits
   * on `hasLoadedExisting` — hydrating a saved event fills these coordinates
   * in, and re-deriving a zone there would restamp an event whose stored
   * `timezone` is authoritative.
   */
  const addressCoordinates = useMemo(
    () =>
      location.lat != null && location.lng != null
        ? { lat: location.lat, lng: location.lng }
        : null,
    [location.lat, location.lng],
  );
  const handleTimezoneAdoptedFromAddress = useStableHandler(
    (adopted: { timezone: string; source: TimezoneAdoptionSource }) => {
      setEventTimezone(adopted.timezone);
      setTimezoneAdoptedFrom(adopted.source);
    },
  );
  useAddressTimezoneAdoption({
    enabled: canEditEvent && hasLoadedExisting && locationMode === "address",
    coordinates: addressCoordinates,
    currentTimezone: eventTimezone,
    onAdopt: handleTimezoneAdoptedFromAddress,
  });

  const handleAddressRevealPresetChange = useCallback(
    (preset: AddressRevealPreset) => {
      setAddressRevealPresetTouched(true);
      setAddressRevealPreset(preset);
      setRevealCustomError(null);
      if (preset !== "CUSTOM") {
        setAddressRevealAt("");
      }
    },
    [],
  );

  const handleAddressRevealAtChange = useCallback((value: string) => {
    setAddressRevealAt(value);
    setRevealCustomError(null);
  }, []);

  // Full event payload (includes body, heroImageUrl, status).
  const eventForEditQuery = trpc.events.getEventForEdit.useQuery({ eventId });

  // ── COMMUNITY mode ──────────────────────────────────────────────────────
  // Community-managed listings are authored in THIS builder (same fields, same
  // live preview, same publish button) but they are ownerless, so every
  // surface that presumes an owning org with a payee is absent: tickets,
  // seating, revenue splits, the access gate, applications, tax/waiver/payout,
  // promos, comps. The readiness rail goes with them — every item it can check
  // (ticket types, Stripe Connect, chargeback terms, host attestation) is one
  // of those, so on a listing it would render as a permanently-blocked
  // checklist against gates that do not apply.
  //
  // Derived from the HYDRATED event, not from a route prop, so a deep link
  // straight to `/edit` picks the right surface. `stewardship` is on the edit
  // payload for exactly this reason (see `get-event-for-edit.ts`) — inferring
  // it from null owner columns would also catch an orphaned OWNED row.
  const isCommunity = isCommunityStewardship(
    eventForEditQuery.data?.stewardship,
  );
  // Description starter that fits the picked category. Owned: the saved
  // category on the edit payload (the picker saves on select and invalidates
  // it). Community: the unsaved picker id, looked up in `categories.list`
  // (same query key as CommunityCategoryField, so no extra request).
  const communityCategoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
    enabled: isCommunity,
  });
  const suggestedStarter = starterKindForCategory(
    resolveStarterCategory({
      isCommunity,
      pickerId: communityCategoryId,
      categories: communityCategoriesQuery.data?.categories ?? [],
      savedCategory: eventForEditQuery.data?.category ?? null,
    }),
  );
  // A community listing opened cold would show the default order and then
  // reorder when the list lands; hold the row until it settles. (`enabled` is
  // true whenever `isCommunity` is, so `isPending` here is a real fetch.)
  const startersCategoryPending =
    isCommunity && communityCategoriesQuery.isPending;
  /**
   * Stewardship is a TRI-STATE, and treating it as a boolean was a real bug.
   *
   * `isCommunity` is `false` while `getEventForEdit` is in flight, so every
   * `!isCommunity` gate READ AS "owned" on the first render and the whole
   * owned-event tree mounted for one tick — firing `listTicketTypesForEdit`,
   * `getEventFeePreview`, `getPerformerShareLinks` and `getEventProvenance` in
   * the SAME BATCH as the read that was about to say "this row is ownerless".
   * MEASURED on a draft community listing: five FORBIDDEN responses per load,
   * from queries the gates above were written to prevent.
   *
   * So the gates key off "known to be owned", never "not yet known to be
   * community". Unknown renders nothing owner-gated and asks nothing
   * owner-gated; the cost is one render of a leaner tree on an owned event,
   * which is the same tick the data arrives in.
   */
  const stewardshipKnown = eventForEditQuery.isSuccess;
  const isOwnedEvent = stewardshipKnown && !isCommunity;
  /**
   * A live community listing — editable since 2026-09-16, and the reason this
   * surface needs to say more than a draft does.
   *
   * `community.updateListing` used to refuse a PUBLISHED listing outright
   * (EVENT_NOT_DRAFT, a code that no longer exists), so the builder opened one
   * read-only and pointed at the public suggestion queue. It takes one now, so
   * the form is here — but a save on this listing is public immediately and,
   * when it moves the schedule or the venue, mails everyone who RSVP'd or
   * saved it. Two affordances carry that: the standing
   * `CommunityLiveEditNotice` band, and `CommunityLiveSaveDialog` at the
   * commit point for the material case only.
   */
  const communityLive = communityIsLive(
    eventForEditQuery.data?.stewardship,
    eventForEditQuery.data?.status,
  );
  /**
   * CANCELLED / COMPLETED / ARCHIVED — the three states `updateListing` still
   * refuses (EVENT_NOT_EDITABLE / EVENT_ARCHIVED). This is where the
   * read-only treatment genuinely belongs: rewriting a listing people were
   * already told about would rewrite the record. Null on every owned event,
   * so the ticketed path keeps its own status rules untouched.
   */
  const communityLocked = communityLockedStatus(
    eventForEditQuery.data?.stewardship,
    eventForEditQuery.data?.status,
  );
  /**
   * The effective edit right. Identical to `canEditEvent` for every owned
   * event (`communityLocked` is null there), so the ticketed path is
   * unchanged; false for a community listing in an end state, which routes
   * into the builder's existing read-only preview surface.
   */
  const canEdit = canEditEvent && communityLocked === null;

  /**
   * Publish the event's identity to the admin rail and the `[id]` layout.
   *
   * Both of them used to fetch `events.getEventTitle` for the title, status
   * and public slug. That procedure is OWNER-gated, so on a COMMUNITY listing
   * it answered NOT_RESOURCE_OWNER twice per load — for three facts this
   * component had just read successfully out of `getEventForEdit`, which a
   * community moderator CAN read. One reader, published upward.
   *
   * `stewardship` rides along so the rail can drop the Build anchors an
   * ownerless listing has no panel for (Tickets / Revenue splits / Settings).
   */
  const publishIdentity = eventNavActions?.publishIdentity;
  const identityTitle = eventForEditQuery.data?.title ?? null;
  const identityStatus = eventForEditQuery.data?.status ?? null;
  const identitySlug = eventForEditQuery.data?.slug ?? null;
  const identityStewardship = eventForEditQuery.data?.stewardship ?? null;
  useEffect(() => {
    if (!publishIdentity || surface !== "edit") return;
    if (!stewardshipKnown) return;
    publishIdentity({
      eventId,
      title: identityTitle,
      status: identityStatus,
      slug: identitySlug,
      stewardship: identityStewardship,
    });
    // Withdraw on unmount: the rail outlives this surface and must fall back
    // to its own read rather than keep painting a departed event's title.
    return () => publishIdentity(null);
  }, [
    publishIdentity,
    surface,
    stewardshipKnown,
    eventId,
    identityTitle,
    identityStatus,
    identitySlug,
    identityStewardship,
  ]);


  // The event's current series membership (null for brand-new drafts and
  // non-repeating events). Hoisted out of handleSave so the scope-dialog
  // gate (requestSave) and the save flow read the same value.
  const existingSeriesId = eventForEditQuery.data?.seriesId ?? null;

  // `listEventTicketTypesForEdit` is owner-gated (org membership, else
  // `humanId === actor`), so an ownerless community listing answers
  // NOT_RESOURCE_OWNER. Community mode renders no ticketing at all, so the
  // query is switched off rather than fired to fail — and stays off until
  // stewardship is KNOWN (see `isOwnedEvent`), or it fires once anyway.
  const ticketTypesForEditQuery = trpc.events.listTicketTypesForEdit.useQuery(
    { eventId },
    { enabled: canEditEvent && isOwnedEvent },
  );

  // Gate state (access-control settings).
  const gateStateQuery = trpc.events.getGateState.useQuery({ eventId });

  // Lineup entries — drives the Revenue-splits presentation (decision D1):
  // collapsed disclosure with no lineup, expanded section otherwise. Shares
  // the exact query key LineupEditor uses ({ eventId }), so React Query
  // dedupes this into the single fetch the promoted LineupEditor already
  // makes — no new endpoint, no duplicate request.
  const lineupListQuery = trpc.eventHumans.list.useQuery(
    { eventId },
    // Splits are an owned-event surface, so this presentational read follows
    // them. (`eventHumans.list` itself now admits a community moderator — the
    // LINEUP section reads it directly for a listing — but a listing has no
    // splits to present, so there is nothing here to ask for.)
    { enabled: canEditEvent && isOwnedEvent },
  );
  const hasLineupEntries = (lineupListQuery.data?.length ?? 0) > 0;
  // Hold the splits section in its collapsed-disclosure state until the lineup
  // query settles — otherwise events WITH a lineup flash collapsed→expanded
  // (and remount SplitsEditor) when the data arrives.
  const lineupCountSettled =
    lineupListQuery.isSuccess || lineupListQuery.isError;

  // PAYOUT ROUTING is owner-only on a human-owned event (owner ruling
  // 2026-09-28): an edit-role delegate hydrates this builder but is not
  // offered splits — the server refuses them. On create (no `eventId`) the
  // creator owns the event: true. For an EXISTING event it stays false until
  // the server answers, so a delegate never sees the splits editor flash in
  // while it loads.
  const viewerCanManagePayouts =
    eventForEditQuery.data?.viewerCanManagePayouts ?? !eventId;

  // Ticket + application templates live in the EVENT owner's library, not the
  // URL workspace's: a delegate on a principal's event lists, applies and
  // saves the principal's templates. Memoized — it rides into the memoized
  // ticket editor.
  const templateOwner = useMemo(
    () => toTemplateOwnerRef(ownerType, ownerId),
    [ownerType, ownerId],
  );

  // Fetch Stripe Connect status to conditionally show payout schedule
  const isOrgOwner = ownerType === "org";
  const connectStatusQuery = trpc.stripeConnect.getStatus.useQuery(
    { orgId: ownerId },
    // Not community: an ownerless listing takes no money, so the payee's
    // capabilities gate nothing here. (`ownerId` is the ADMIN CONTEXT's org,
    // not the listing's — reading it would answer a question nobody asked.)
    { enabled: isOrgOwner && isOwnedEvent, staleTime: 120_000 },
  );
  // Both flags, not just payouts. The server's publish gate checks
  // `status === "ACTIVE" && chargesEnabled && payoutsEnabled`, and the Payee
  // row's status is derived from exactly these two booleans
  // (`deriveConnectCapabilities`), so this pair is an exact mirror — a
  // RESTRICTED payee has both false. Checking `payoutsEnabled` alone let an
  // account with payouts on but charges off enable Publish and then 4xx.
  const payoutsEnabled = connectStatusQuery.data?.payoutsEnabled === true;
  const connectFullyEnabled =
    payoutsEnabled && connectStatusQuery.data?.chargesEnabled === true;

  const eventStatus = eventForEditQuery.data?.status ?? "DRAFT";

  /**
   * CLIENT MIRROR of the server's `hasPaidTicketTypes`
   * (core/lib/payments/chargeback-terms.ts → `isEverPaidTicketType`). Drives the
   * readiness rail's chargeback-terms blocker.
   *
   * This is a WILL-IT-EVER predicate, not a what-does-it-cost-now read — hence
   * no time resolution: an org must accept chargeback terms BEFORE the tier
   * starts taking money, not at the moment it does. A $0-now/$20-Friday tier is
   * a paid tier today.
   */
  const hasPaidTicketTypesForChargebackTerms = useMemo(
    () =>
      ticketTypesForEditQuery.data?.ticketTypes.some(
        (ticketType) =>
          ticketType.priceCents > 0 ||
          (ticketType.scheduledPriceCents ?? 0) > 0 ||
          ticketType.pricingMode === "ADJUSTABLE",
      ) ?? false,
    [ticketTypesForEditQuery.data?.ticketTypes],
  );

  // The event-first request's INTENT is not on the edit projection; it rides
  // `getEventProvenance` (`EventProvenanceNote` reads the same key with the
  // same options, so React Query serves both from one cache entry). It seeds
  // the hydrated placement's intent, and only while the cascade is untouched
  // — a dirty placement is the organizer's, whatever the request said.
  const provenanceQuery = trpc.events.getEventProvenance.useQuery(
    { eventId },
    {
      // `getEventProvenance` refuses a COMMUNITY listing outright (an
      // ownerless row has no booking provenance to report), and community
      // mode renders no venue cascade to seed — so it is never asked.
      enabled: Boolean(eventId) && isOwnedEvent,
      staleTime: 60_000,
      retry: 1,
      meta: { silent: true },
    },
  );
  const provenanceIntent =
    provenanceQuery.data?.bookingRequest?.intent ?? null;
  // `placement` is a dep on purpose: provenance can land BEFORE the edit read
  // (or in the same batched commit), when there is no placement yet to seed.
  // Re-running once the hydration effect has seeded one lands the intent; the
  // functional updater returns `current` when it already matches, so it
  // settles in one pass.
  useEffect(() => {
    if (!provenanceIntent || placementDirty || placementSource !== "hydrated") {
      return;
    }
    setPlacement((current) =>
      current && current.bookingIntent !== provenanceIntent
        ? { ...current, bookingIntent: provenanceIntent }
        : current,
    );
  }, [provenanceIntent, placementDirty, placementSource, placement]);

  /**
   * A hydrated placement whose INTENT is still a guess: the edit read landed,
   * provenance has not, the cascade is untouched. LocationSection shows the
   * skeleton for that one round trip instead of live controls seeded with
   * PERFORM — a touch in that window would otherwise build from the guess.
   */
  const placementIntentPending =
    placementSource === "hydrated" &&
    placement !== null &&
    !placementDirty &&
    provenanceQuery.isPending;

  // Pre-populate form when event data loads
  useEffect(() => {
    if (hasLoadedExisting || !eventForEditQuery.data) return;

    const existing = eventForEditQuery.data;

    if (existing.title) setTitle(existing.title);
    if (existing.startsAt) {
      setStartsAt(
        toDateTimeLocalValue(
          existing.startsAt,
          existing.timezone ?? "America/Chicago",
        ),
      );
    }
    if (existing.endsAt) {
      setEndsAt(
        toDateTimeLocalValue(
          existing.endsAt,
          existing.timezone ?? "America/Chicago",
        ),
      );
    }

    const restoredLocation: LocationState = {
      addressText: existing.addressText ?? undefined,
      lat: existing.lat ?? undefined,
      lng: existing.lng ?? undefined,
      locality: existing.locality ?? undefined,
      region: existing.region ?? undefined,
      countryCode: existing.countryCode ?? undefined,
      postalCode: existing.postalCode ?? undefined,
    };

    // If the event was linked to a Ithas Fire Place, restore place mode
    if (existing.placeId && existing.place) {
      restoredLocation.thPlaceId = existing.placeId;
      restoredLocation.thPlaceName = existing.place.name;
      // Place-based events may not store lat/lng on the event itself — fall
      // back to the place's coordinates so the preview map can render.
      if (restoredLocation.lat == null && existing.place.lat != null) {
        restoredLocation.lat = existing.place.lat;
      }
      if (restoredLocation.lng == null && existing.place.lng != null) {
        restoredLocation.lng = existing.place.lng;
      }
      setLocationMode("place");
      // Hydration, not a pick: seed the STORED placement so the cascade shows
      // what was saved (the calendar from the edit projection; the intent
      // arrives with the provenance read below). Not dirty — nothing is sent
      // until the organizer touches a control, and a touch then builds from
      // the stored values, never from defaults. The stored SPACE is not read:
      // the cascade has no room control, and a value the organizer cannot see
      // must not ride along on the save (owner ruling — the venue names the
      // room when it accepts).
      setPlacement(
        existing.calendarId
          ? {
              placeId: existing.placeId,
              // Provenance usually lands in the SAME batched commit as the
              // edit read: take its intent right here so the cascade never
              // shows PERFORM for a RENT/USE event; the seeding effect above
              // covers the later-landing case.
              bookingIntent: provenanceIntent ?? "PERFORM",
              calendarId: existing.calendarId,
            }
          : null,
      );
      setPlacementDirty(false);
      setPlacementSource("hydrated");
      setSelectedPlace({
        placeId: existing.placeId,
        name: existing.place.name,
        formattedAddress: existing.place.formattedAddress ?? null,
        city: existing.place.city,
        region: existing.place.region,
        lat: existing.place.lat ?? null,
        lng: existing.place.lng ?? null,
        // Unknown here on purpose: `getEventForEdit`'s place summary does not
        // carry the column, and this is a HYDRATION write, not a user
        // selection — the stored `existing.timezone` below is authoritative
        // for a saved event and must not be second-guessed. Adoption only
        // runs through `handlePlaceSelect`, which additionally no-ops when the
        // organizer re-picks the venue the event is already at.
        timezone: null,
        status: existing.place.status,
        verificationStatus: existing.place.verificationStatus,
      });
    }

    setLocation(restoredLocation);
    const searchText = existing.addressText ?? "";
    setLocationSearch(searchText);

    // Snapshot the persisted location so the user can reset later
    savedLocationRef.current = {
      location: restoredLocation,
      search: searchText,
    };

    // Restore location visibility settings. Under OBSCURED a null radius is
    // the FULLY-HIDDEN sentinel and must round-trip as null; under EXACT the
    // radius is meaningless, so keep the 500 m default for a later mode switch.
    if (existing.locationMode)
      setVisibilityMode(existing.locationMode as EventLocationMode);
    setVisibilityRadius(
      existing.locationMode === "OBSCURED"
        ? (existing.locationRadiusMeters ?? null)
        : (existing.locationRadiusMeters ?? 500),
    );
    if (existing.locationLabel) setVisibilityLabel(existing.locationLabel);
    setAddressRevealPreset(
      getEditableAddressRevealPreset(
        existing.addressRevealPreset as AddressRevealPreset | null | undefined,
      ),
    );
    setAddressRevealPresetTouched(false);
    if (existing.addressRevealAt) {
      setAddressRevealAt(
        toDateTimeLocalValue(
          existing.addressRevealAt,
          existing.timezone ?? "America/Chicago",
        ),
      );
    } else {
      setAddressRevealAt("");
    }
    if (existing.timezone) setEventTimezone(existing.timezone);

    // Community mode holds the category itself (see `communityCategoryId`).
    // Seeded unconditionally: the field is inert on an owned event, where
    // CategoryTagsSection owns both the value and its save.
    setCommunityCategoryId(existing.categoryId ?? null);

    // Restore hero image URL
    if (existing.heroImageUrl) {
      setHeroImageUrl(existing.heroImageUrl);
    }

    // Restore body content from EventBody structure
    if (existing.content) {
      const body = existing.content as EventBody;
      if ("sections" in body && Array.isArray(body.sections)) {
        // V1 format: extract from first section's first column's first richText block
        for (const section of body.sections) {
          if ("layout" in section && "columns" in section.layout) {
            for (const col of section.layout.columns) {
              const rtBlock = col.blocks?.find(
                (b: { type: string }) => b.type === "richText",
              );
              if (rtBlock && "doc" in rtBlock) {
                setBodyContent(rtBlock.doc as ProseMirrorDoc);
                break;
              }
            }
          }
        }
      } else if ("blocks" in body && Array.isArray(body.blocks)) {
        // Legacy format: flat blocks array with richText block containing the doc
        const rtBlock = body.blocks.find(
          (b: { type: string }) => b.type === "richText",
        );
        if (rtBlock && "doc" in rtBlock) {
          setBodyContent(rtBlock.doc as ProseMirrorDoc);
        }
      }
    }

    setHasLoadedExisting(true);
    // `provenanceIntent` is read above; the `hasLoadedExisting` guard makes
    // any re-run after hydration a no-op.
  }, [hasLoadedExisting, eventForEditQuery.data, provenanceIntent]);

  // Pre-populate recurrence state when editing an event that belongs to a series
  useEffect(() => {
    if (!eventForEditQuery.data) return;
    const { seriesId: sid, seriesRrule, seriesUntil } = eventForEditQuery.data;
    if (!sid || !seriesRrule || !startsAt || seriesPrefilledRef.current) return;

    // Initialize ONCE when edit payload + local datetime state are ready —
    // the ref (not `!recurrenceConfig`) makes this one-shot, so choosing
    // "Doesn't repeat" (config → null) doesn't restore the stored schedule.
    seriesPrefilledRef.current = true;
    setRecurrenceEnabled(true);
    setRecurrenceConfig({
      rrule: seriesRrule,
      dtstart: toIsoInTimeZone(startsAt, eventTimezone),
      ...(seriesUntil ? { until: seriesUntil } : {}),
    });
  }, [eventForEditQuery.data, startsAt, eventTimezone]);

  /** Visibility as hydration set it, read off the first loaded render. */
  const hydratedVisibilityRef = useRef<{
    mode: string;
    radius: number | null;
  } | null>(null);
  // A series event's schedule is prefilled one render after hydration (it
  // needs the hydrated `startsAt`); a baseline taken before it lands would
  // read the stored schedule as an edit. Mirrors the prefill effect's guard.
  const awaitingSeriesPrefill =
    Boolean(
      eventForEditQuery.data?.seriesId &&
        eventForEditQuery.data?.seriesRrule &&
        startsAt,
    ) && recurrenceConfig === null;
  useEffect(() => {
    if (!hasLoadedExisting || baselineFields !== null) return;
    // The first loaded render holds the hydrated visibility: the venue
    // ceiling clamp can only run once hydration has set the place, and its
    // write lands a render later.
    hydratedVisibilityRef.current ??= {
      mode: visibilityMode,
      radius: visibilityRadius,
    };
    if (awaitingSeriesPrefill) return;
    setBaselineFields(
      loadedFieldsSnapshot(formFields, hydratedVisibilityRef.current),
    );
    setBaselineBody(bodySnapshot);
  }, [
    hasLoadedExisting,
    baselineFields,
    visibilityMode,
    visibilityRadius,
    awaitingSeriesPrefill,
    formFields,
    bodySnapshot,
  ]);
  /**
   * The description editor reports the doc it was mounted with, normalised.
   * From then on the body compares in that shape (see `EditorSeed`).
   */
  const handleEditorReady = useStableHandler(
    (doc: ProseMirrorDoc, mountedWith: ProseMirrorDoc) => {
      // `raw` is the doc the editor was MOUNTED with, not the current body:
      // the editor's URL sync can already have replaced the body via onChange.
      const seed: EditorSeed = {
        raw: snapshotBody(mountedWith),
        normalized: snapshotBody(doc),
      };
      setEditorSeed(seed);
      setBaselineBody((b) =>
        b === null ? null : rebaseBodyOnEditorSeed(b, seed),
      );
    },
  );
  const hasUnsaved =
    canEditEvent &&
    hasUnsavedChanges(
      { fields: baselineFields, body: baselineBody },
      { fields: fieldsSnapshot, body: bodySnapshot },
    );
  const unsavedGuard = useUnsavedChangesGuard(hasUnsaved, {
    deferBackGuardOn: isPreviewUrl,
  });
  const unsavedStatusId = useId();
  const requestNavigation = unsavedGuard.requestNavigation;

  const { toast } = useNotify();

  // Memoized so `uploadImage`/`uploadAudio` don't take a fresh `onError`
  // dependency on every render (which defeated their own useCallback).
  const handleImageUploadError = useCallback(
    (err: Error) => {
      console.error("Image upload failed:", err);
      const message =
        err.message === "image_too_large"
          ? (t("admin.ebHeroImageTooLarge") as string)
          : err.message === "invalid_image_type"
            ? (t("admin.ebImageInvalidType") as string)
            : err.message?.includes("storage")
              ? (t("admin.ebUploadStorageError") as string)
              : (t("admin.ebUploadFailedMessage") as string);
      toast.danger({
        id: "image-upload-failed",
        title: t("admin.ebUploadFailedTitle") as string,
        message,
      });
    },
    [t, toast],
  );

  const handleAudioUploadError = useCallback(
    (err: Error) => {
      console.error("Audio upload failed:", err);
      toast.danger({
        id: "audio-upload-failed",
        title: t("admin.ebAudioUploadFailedTitle") as string,
        message: t("admin.ebAudioUploadFailedMessage") as string,
      });
    },
    [t, toast],
  );

  const { uploadImage, isUploading } = useEventImageUpload({
    eventId,
    onError: handleImageUploadError,
  });

  const { uploadAudio, isUploadingAudio } = useEventAudioUpload({
    eventId,
    onError: handleAudioUploadError,
  });

  // Stable-identity wrappers: `uploadImage`/`uploadAudio` close over tRPC
  // mutation objects, whose identity react-query recreates every render, so
  // the raw handlers would defeat BuilderDetailsSection's React.memo.
  const handleProseImageUpload = useStableHandler(uploadImage);
  const handleProseAudioUpload = useStableHandler(uploadAudio);

  const { imageUrlMap, audioUrlMap } = useEventMediaMaps(eventId, bodyContent);

  const createForHuman = trpc.events.createEventForHuman.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const createForOrg = trpc.events.createEventForOrg.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const updateSeries = trpc.series.updateEventSeries.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const reconcileSeries = trpc.series.reconcileSeriesSchedule.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const convertSeries = trpc.series.convertEventToSeries.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const generateSeries = trpc.series.generateEventsFromSeries.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const syncDrafts = trpc.series.syncSeriesDrafts.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const requestImageUpload = trpc.events.requestImageUpload.useMutation();
  const finalizeImageUpload = trpc.events.finalizeImageUpload.useMutation();
  // COMMUNITY mode's save/publish pair. Separate procedures, not a variant of
  // the owned ones: `createEventForOrg/Human` writes an OWNED event and
  // `publishEvent` requires an owner, ticket types and payout terms.
  const updateCommunityListing = trpc.community.updateListing.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const publishCommunityListing = trpc.community.publishListing.useMutation({
    retry: false,
    meta: { silent: true },
  });

  /**
   * Presign → PUT → finalize the STAGED hero file, returning its image id.
   * `undefined` when nothing is staged.
   *
   * Extracted from `handleSave` so the community save path uses the identical
   * three-step sequence rather than a second copy of it — the sequence is
   * load-bearing (the presigned URL signs the headers, so they must be sent
   * verbatim) and the two paths must never drift.
   */
  const uploadStagedHeroImage = useCallback(
    async (targetEventId: string): Promise<string | undefined> => {
      if (!heroImageFile) return undefined;
      const { imageId, uploadUrl, uploadHeaders } =
        await requestImageUpload.mutateAsync({
          eventId: targetEventId,
          contentType: heroImageFile.type,
          sizeBytes: heroImageFile.size,
        });
      // Send the server-provided headers VERBATIM — for SVG they include a
      // Content-Disposition that is signed into the presigned URL, so
      // hand-building headers here would 403 the PUT.
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: uploadHeaders,
        body: heroImageFile,
      });
      if (!uploadRes.ok) {
        throw new Error(`Hero image upload failed (HTTP ${uploadRes.status})`);
      }
      await finalizeImageUpload.mutateAsync({ imageId });
      return imageId;
    },
    [heroImageFile, requestImageUpload, finalizeImageUpload],
  );

  // Single funnel for "something went wrong" mutation errors. Stores the
  // error in the form-error state (drives the inline FormErrorBanner) AND
  // pops a toast so the failure is visible even when the banner is below
  // the fold or the user is interacting elsewhere on the page.
  /**
   * The one click behind EVENT_ADDRESS_IS_OWN_WITHHELD_PLACE: the typed
   * address is a venue this person manages that hides its address, and the
   * save refused rather than re-linking it silently. This makes the switch the
   * error asks for — My Places, with that venue selected.
   *
   * Read through `getPlaceForEdit`: the server only raises this error for
   * someone who passes `canManagePlace`, which is that read's bar, so the
   * selection carries the street and the builder treats the venue as managed
   * (see `viewerManagesVenue`). That read has no zone column; `timezone: null`
   * leaves the event's zone alone (the `PlacePickerItem` contract).
   */
  const switchToOwnWithheldPlace = useStableHandler(
    async (placeId: string) => {
      try {
        const { place } = await utils.places.getPlaceForEdit.fetch({
          placeId,
        });
        handleLocationModeChange("place");
        handlePlaceSelect({
          placeId: place.placeId,
          name: place.name,
          formattedAddress: place.formattedAddress,
          city: place.city,
          region: place.region,
          lat: place.lat,
          lng: place.lng,
          timezone: null,
          status: place.status,
          verificationStatus: place.verificationStatus,
        });
      } catch (err) {
        toast.danger({
          id: "event-builder-use-place-failed",
          title: formatErrorMessage(err, t),
        });
      }
    },
  );

  const reportError = useCallback(
    (error: unknown, fallbackTitle?: string) => {
      setSaveError(error);
      const { formError, fieldErrors } = normalizeError(error, t);
      const message =
        formError ?? Object.values(fieldErrors)[0] ?? "Something went wrong.";
      const ownWithheldPlace = extractOwnWithheldPlaceMeta(error);
      toast.danger({
        id: "event-builder-error",
        title: fallbackTitle ?? (t("admin.ebSaveFailedTitle") as string),
        message,
        ...(ownWithheldPlace
          ? {
              // Long enough to read the action before auto-dismiss.
              durationMs: 10_000,
              action: {
                label: String(
                  t("admin.ebUseOwnWithheldPlace", {
                    placeName: ownWithheldPlace.placeName,
                  }),
                ),
                onPress: () =>
                  void switchToOwnWithheldPlace(ownWithheldPlace.placeId),
              },
            }
          : {}),
      });
    },
    [setSaveError, t, toast, switchToOwnWithheldPlace],
  );

  // HOLD_LINE_HAS_OPEN_CHALLENGE is a rule, not a failure (spec FR-018): an
  // act's reply clock is running on a hold for this calendar+date, so the
  // date can't be taken by a published event until they answer or the venue
  // releases the hold. It reads as a warning with the rule's sentence — never
  // "Publish failed" — and the event stays a draft; the refetch keeps the
  // status pill honest.
  const handleHoldLineOpenChallenge = useCallback(() => {
    toast.warning({
      id: "event-builder-hold-open-challenge",
      title: String(t("errors.holdLineHasOpenChallengePublish")),
    });
    void utils.events.getEventForEdit.invalidate({ eventId });
  }, [eventId, t, toast, utils]);

  // ── Series reconcile confirmation (events with sales) ─────────────────
  /**
   * Which series save flow a reconcile pass belongs to:
   * - `update` — the event already belongs to a series; the schedule patch
   *   went through `updateEventSeries`.
   * - `convert` — the event was just converted into a fresh series and the
   *   flow still owes a `generateEventsFromSeries` call for the new drafts.
   */
  type SeriesSaveMode = "update" | "convert";
  const [showReconcileConfirm, setShowReconcileConfirm] = useState(false);
  const [reconcilePending, setReconcilePending] = useState<
    ReconcilePendingItem[]
  >([]);
  /** Stashed params so the second pass can re-call reconcileSeries. */
  const reconcileParamsRef = useRef<{
    seriesId: string;
    windowStart: string;
    windowEnd: string;
    mode: SeriesSaveMode;
    /** The event being edited — used for cache invalidation + onSave. */
    eventId: string;
  } | null>(null);

  /**
   * First reconcile pass for a series schedule (no confirmed cancellations).
   * When published events with sales would be detached, stashes the params +
   * opens the confirm dialog and reports `pending: true`; the second pass then
   * runs in `handleReconcileConfirm` with the confirmed occurrence ids.
   * Shared by the update-series and convert-to-series save flows.
   */
  const runReconcilePass = useCallback(
    async (params: {
      seriesId: string;
      windowStart: string;
      windowEnd: string;
      mode: SeriesSaveMode;
      eventId: string;
    }) => {
      const result = await reconcileSeries.mutateAsync({
        seriesId: params.seriesId,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        clientKey: nanoid(12),
      });

      if (result.published.pendingConfirmation.length > 0) {
        setReconcilePending(result.published.pendingConfirmation);
        reconcileParamsRef.current = params;
        setShowReconcileConfirm(true);
        return { pending: true as const };
      }

      return { pending: false as const, result };
    },
    [reconcileSeries],
  );

  /**
   * Shared tail of the series save flow — runs after a reconcile pass that
   * needs no (further) confirmation. BOTH modes generate draft events here:
   * a fresh conversion owes all of its drafts, and a schedule update can add
   * PLANNED occurrences (e.g. extending `until`) that would otherwise never
   * get drafts — generateEventsFromSeries is idempotent (only PLANNED
   * occurrences without an event are processed; an empty result is fine).
   * The series exists by this point, so a generate failure is partial
   * success — saving again re-runs the flow. Note no current consumer wires
   * `onSave`, so in practice the user stays on the form either way.
   */
  const completeSeriesFlow = useCallback(
    async (
      mode: SeriesSaveMode,
      seriesId: string,
      sourceEventId: string,
      reconcileResult: {
        generated: { detached: number };
        published: { detached: number };
      },
    ) => {
      let generatedCount: number | null = null; // null = generate failed
      try {
        const generated = await generateSeries.mutateAsync({
          seriesId,
          limit: 100,
          clientKey: nanoid(12),
        });
        generatedCount = generated.generated.length;
      } catch (error) {
        toast.warning({
          id: "series-convert-partial",
          title: t("admin.ebSeriesConvertPartialTitle") as string,
          message: t("admin.ebSeriesConvertPartialMessage", {
            reason: formatErrorMessage(error, t),
          }) as string,
        });
      }

      // Refresh the edit payload so the form sees the current series state
      // (seriesId/rrule/until) on the next render instead of stale data.
      void utils.events.getEventForEdit.invalidate({ eventId: sourceEventId });

      if (generatedCount !== null) {
        if (mode === "update") {
          const totalDetached =
            reconcileResult.generated.detached +
            reconcileResult.published.detached;
          const base =
            totalDetached > 0
              ? t("admin.ebSeriesReconciledWithDetach", {
                  detached: totalDetached,
                })
              : t("admin.ebSeriesUpdatedMessage");
          const msg =
            generatedCount > 0
              ? `${String(base)} ${String(
                  t("admin.ebSeriesConvertedMessage", {
                    count: generatedCount,
                  }),
                )}`
              : (base as string);

          toast.success({
            id: "series-updated",
            title: t("admin.ebSeriesUpdatedTitle") as string,
            message: msg,
          });
        } else {
          toast.success({
            id: "series-converted",
            title: t("admin.ebSeriesConvertedTitle") as string,
            message: t("admin.ebSeriesConvertedMessage", {
              count: generatedCount,
            }) as string,
          });
        }
      }

      onSave?.(sourceEventId);
    },
    [generateSeries, onSave, t, toast, utils.events.getEventForEdit],
  );

  /**
   * Propagates the just-saved event's definition fields onto sibling
   * GENERATED drafts when the scope dialog's choice was "This and following
   * shows" (future) or "All shows" (all). Consumes `pendingSyncScopeRef` —
   * no-ops for "This show only" — so the reconcile-confirm detour
   * (handleReconcileConfirm) can resume the propagation after its second
   * pass. Non-fatal by design: the event itself already saved, so a sync
   * failure warns and the user retries by saving again with the same choice.
   */
  const runScopedDraftSync = useCallback(
    async (seriesId: string, sourceEventId: string) => {
      const scope = pendingSyncScopeRef.current;
      const includeArrivalAreas = pendingSyncIncludeAreasRef.current;
      if (!scope) return;
      pendingSyncScopeRef.current = null;
      pendingSyncIncludeAreasRef.current = false;
      try {
        const result = await syncDrafts.mutateAsync({
          seriesId,
          sourceEventId,
          scope,
          ...arrivalAreasSyncField(includeArrivalAreas),
          clientKey: nanoid(12),
        });
        // Sibling drafts changed server-side — refresh every surface that
        // renders them: the Dates list, the admin events list, and cached
        // edit payloads. Siblings are OTHER events, so getEventForEdit is
        // invalidated broadly (argless = every cached key), matching the
        // argless listSeriesDatesForAdmin/listMine precedent on the Dates
        // page.
        void utils.series.listSeriesDatesForAdmin.invalidate();
        void utils.events.listMine.invalidate();
        void utils.events.getEventForEdit.invalidate();
        toast.success({
          id: "series-drafts-synced",
          title: t("admin.ebScopeSyncedTitle") as string,
          message: composeSyncToastMessage(
            (key, params) => t(key, params) as string,
            result,
          ),
        });
      } catch (error) {
        toast.warning({
          id: "series-drafts-sync-failed",
          title: t("admin.ebScopeSyncFailedTitle") as string,
          message: t("admin.ebScopeSyncFailedMessage", {
            reason: formatErrorMessage(error, t),
          }) as string,
        });
      }
    },
    [
      syncDrafts,
      t,
      toast,
      utils.events.getEventForEdit,
      utils.events.listMine,
      utils.series.listSeriesDatesForAdmin,
    ],
  );

  const handleStartDateChange = useCallback(
    (value: string | undefined) => {
      setStartsAt(value);
      // If the new start is at or after the current end, push end forward by the
      // same duration the event previously had (or default to 2 hours ahead).
      if (value && endsAt) {
        const newStart = new Date(value);
        const currentEnd = new Date(endsAt);
        if (newStart >= currentEnd) {
          const prevStart = startsAt ? new Date(startsAt) : null;
          const durationMs = prevStart
            ? currentEnd.getTime() - prevStart.getTime()
            : 2 * 60 * 60 * 1000; // default 2 hours
          const safeDuration = durationMs > 0 ? durationMs : 2 * 60 * 60 * 1000;
          setEndsAt(
            toDateTimeLocalValue(new Date(newStart.getTime() + safeDuration)),
          );
        }
      }
    },
    [endsAt, startsAt],
  );

  const handleEndDateChange = useCallback((value: string | undefined) => {
    setEndsAt(value);
  }, []);

  const handleTitleChange = useCallback(
    (value: string) => {
      setTitle(value);
      clearField("title");
    },
    [clearField],
  );

  // ── Hero image handlers ────────────────────────────────────────────────
  const handleHeroImageSelected = useCallback(
    async (file: File, previewUrl: string) => {
      // Convert HEIC/HEIF (iPhone photos) to JPEG before the size check and
      // before staging, so the size cap runs against the JPEG, the preview
      // actually renders (browsers can't display HEIC), and the eventual
      // presign + PUT use a server-supported content-type.
      try {
        const prepared = await prepareImageForUpload(file);
        if (prepared !== file) {
          // The original preview was made from the HEIC bytes and won't
          // render — swap it for a blob URL of the converted JPEG.
          if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
          previewUrl = URL.createObjectURL(prepared);
          file = prepared;
        }
      } catch (err) {
        console.error("Hero image HEIC conversion failed:", err);
        if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
        toast.danger({
          id: "hero-image-convert-failed",
          title: String(t("admin.ebUploadFailedTitle")),
          message: String(t("admin.ebUploadFailedMessage")),
        });
        return;
      }

      // Mirror the server's content-type allowlist (jpeg/png/gif/webp)
      // so a bad pick fails with a clear toast instead of a presign error.
      // Runs after HEIC prep, so iPhone photos have already become JPEG.
      if (!validateImageUploadType(file, EVENT_IMAGE_UPLOAD_TYPES).ok) {
        if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
        toast.danger({
          id: "hero-image-invalid-type",
          title: String(t("admin.ebUploadFailedTitle")),
          message: String(t("admin.ebImageInvalidType")),
        });
        return;
      }

      if (file.size > MAX_EVENT_IMAGE_BYTES) {
        if (previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
        toast.danger({
          id: "hero-image-too-large",
          title: String(t("admin.ebSaveFailedTitle")),
          message: String(t("admin.ebHeroImageTooLarge")),
        });
        return;
      }
      setHeroImageUrl(previewUrl);
      setHeroImageFile(file);
      setHeroImageRemoved(false);
    },
    [t, toast],
  );

  const handleHeroImageRemoved = useCallback(() => {
    if (heroImageUrl?.startsWith("blob:")) URL.revokeObjectURL(heroImageUrl);
    setHeroImageUrl(undefined);
    setHeroImageFile(null);
    setHeroImageRemoved(true);
  }, [heroImageUrl]);

  // ── Location handlers ──────────────────────────────────────────────────
  const handleResetLocation = useCallback(() => {
    if (!savedLocationRef.current) return;
    setLocation(savedLocationRef.current.location);
    setLocationSearch(savedLocationRef.current.search);
  }, []);

  const handleSave = useCallback(
    async (
      scope: SeriesEditScope = "this",
      options: { includeArrivalAreas?: boolean } = {},
    ) => {
      // Re-entrancy guard: the header button, Cmd/Ctrl+S, and the scope dialog all
      // funnel here; a second entry while a save is in flight would double-fire
      // mutations (state-based `isSaving` lags a render behind).
      if (saveInFlightRef.current) return;
      clearErrors();

      // Field-level validation
      let valid = true;
      if (!title) {
        setFieldError(
          "title",
          String(t("errors.titleRequired") ?? "Title is required"),
        );
        valid = false;
      }
      if (!startsAt) {
        setFieldError(
          "startsAt",
          String(t("errors.startDateRequired") ?? "Start date is required"),
        );
        valid = false;
      }
      if (!endsAt) {
        setFieldError(
          "endsAt",
          String(t("errors.endDateRequired") ?? "End date is required"),
        );
        valid = false;
      }
      if (!valid) return;

      if (
        visibilityMode === "OBSCURED" &&
        addressRevealPreset === "CUSTOM" &&
        !addressRevealAt
      ) {
        setRevealCustomError(String(t("admin.ebRevealCustomRequiredMessage")));
        // The reveal control lives inside the Access & privacy accordion — force
        // it open so the inline field error is never hidden behind a collapsed
        // group.
        accessGroupRef.current?.open();
        reportError({
          message: String(t("admin.ebRevealCustomRequiredMessage")),
        });
        return;
      }
      setRevealCustomError(null);

      // Third-party venue placement (intent / calendar). `{}` for an address,
      // an owned or granted venue, or an untouched hydrated venue — the save
      // then leaves the stored columns alone. A placement with no calendar
      // cannot be routed; the cascade always fills one, so this is the
      // backstop.
      const placementPayload = resolveBuilderPlacement({
        locationMode,
        location,
        placement,
        dirty: placementDirty,
      });
      if (
        placement &&
        placementPayload.calendarId !== undefined &&
        !placementIsComplete(placement)
      ) {
        reportError({ message: String(t("admin.ebCalendarRequired")) });
        return;
      }

      // Stash the propagation choice for this save. Consumed (and cleared) by
      // runScopedDraftSync — possibly later than this call returns, when the
      // reconcile-confirm dialog interrupts the series flow.
      pendingSyncScopeRef.current = syncScopeForChoice(scope);
      pendingSyncIncludeAreasRef.current = includeArrivalAreasForSave({
        scope,
        arrivalAreasGateOn: gates?.arrivalAreas === true,
        ticked: options.includeArrivalAreas === true,
      });

      saveInFlightRef.current = true;
      // What this save sends, taken now: edits typed while it is in flight
      // must still read as unsaved when it resolves.
      const sentForm = sendableFormRef.current;
      setIsSaving(true);

      try {
        const locationPayload: {
          placeId?: string;
          addressText?: string;
          lat?: number;
          lng?: number;
          locality?: string;
          region?: string;
          countryCode?: string;
          postalCode?: string;
        } = {};

        if (location.thPlaceId) {
          // Ithas Fire Place — send the UUID
          locationPayload.placeId = location.thPlaceId;
        } else if (location.addressText && location.lat && location.lng) {
          // Freeform address
          locationPayload.addressText = location.addressText;
          locationPayload.lat = location.lat;
          locationPayload.lng = location.lng;
          if (location.locality) locationPayload.locality = location.locality;
          if (location.region) locationPayload.region = location.region;
          if (location.countryCode)
            locationPayload.countryCode = location.countryCode;
          if (location.postalCode)
            locationPayload.postalCode = location.postalCode;
        }

        // Determine heroImageId to include in the save payload:
        // - If we have a pending file, upload first so we can include
        //   heroImageId in the single save call.
        // - If hero was removed (no URL), explicitly null it out.
        let heroImageId: string | null | undefined;
        if (heroImageFile) {
          heroImageId = (await uploadStagedHeroImage(eventId)) ?? undefined;
        } else if (heroImageRemoved) {
          // User explicitly removed the hero image
          heroImageId = null;
        }

        // ── Event save flow ──
        const addressRevealInput = resolveAddressRevealSaveInput({
          visibilityMode,
          selectedPreset: addressRevealPreset,
          selectedCustomAt: addressRevealAt,
          eventTimezone,
          existingVisibilityMode: eventForEditQuery.data?.locationMode as
            | EventLocationMode
            | null
            | undefined,
          existingPreset: eventForEditQuery.data?.addressRevealPreset as
            | AddressRevealPreset
            | null
            | undefined,
          hasPresetBeenTouched: addressRevealPresetTouched,
        });

        const baseInput = {
          eventId,
          title,
          startsAt: toIsoInTimeZone(startsAt!, eventTimezone),
          endsAt: toIsoInTimeZone(endsAt!, eventTimezone),
          location: locationPayload,
          locationMode: visibilityMode,
          // Under OBSCURED, null radius = FULLY HIDDEN (no public map) — the
          // server treats it as a sentinel, not a default. EXACT ignores it.
          locationRadiusMeters:
            visibilityMode === "OBSCURED" ? visibilityRadius : null,
          locationLabel:
            visibilityMode !== "EXACT" && visibilityLabel.trim()
              ? visibilityLabel.trim()
              : null,
          addressRevealAt: addressRevealInput.addressRevealAt,
          timezone: eventTimezone,
          content: {
            layoutId: "default" as const,
            blocks: [
              {
                id: nanoid(),
                type: "richText" as const,
                doc: bodyContent,
              },
            ],
          },
          clientKey: nanoid(12),
          ...(addressRevealInput.addressRevealPreset !== undefined
            ? { addressRevealPreset: addressRevealInput.addressRevealPreset }
            : {}),
          ...(heroImageId !== undefined ? { heroImageId } : {}),
          ...placementPayload,
        };

        let result;

        if (ownerType === "human") {
          const createForHumanInput: Parameters<
            typeof createForHuman.mutateAsync
          >[0] = baseInput;
          result = await createForHuman.mutateAsync(createForHumanInput);
        } else {
          const createForOrgInput: Parameters<
            typeof createForOrg.mutateAsync
          >[0] = {
            ...baseInput,
            orgId: ownerId,
          };
          result = await createForOrg.mutateAsync(createForOrgInput);
        }

        // Clear the pending file since it's been uploaded
        if (heroImageFile) {
          setHeroImageFile(null);
        }
        setHeroImageRemoved(false);

        // Invalidate the edit query so the UI picks up new data
        if (result.eventId) {
          void utils.events.getEventForEdit.invalidate({
            eventId: result.eventId,
          });
          void utils.events.getGateState.invalidate({
            eventId: result.eventId,
          });
          // The tie band: what this save did with the venue. Handed straight
          // to the note so it appears without waiting on the provenance
          // refetch — which is invalidated so the next read is the truth
          // (a re-save may have FOUND a request the venue has since answered).
          void utils.events.getEventProvenance.invalidate({
            eventId: result.eventId,
          });
        }
        // `skipped` (the venue refused the ask) is not a request the band can
        // show; it goes to the Location field's notice instead, pinned to
        // the ask it answers (`event-first-skip.helpers.ts`).
        setSavedBookingRequest(
          result.bookingRequest?.outcome === "skipped"
            ? null
            : (result.bookingRequest ?? null),
        );
        const bookingSkip = eventFirstSkipFromSave(result.bookingRequest);
        setSavedBookingSkip(
          bookingSkip
            ? {
                skip: bookingSkip,
                snapshot: eventFirstSkipSnapshot({
                  placement,
                  startsAt,
                  skip: bookingSkip,
                }),
              }
            : null,
        );

        toast.success({
          id: "event-saved",
          title: t("admin.ebSavedTitle") as string,
          message: t("admin.ebSavedMessage") as string,
        });
        markSaved(sentForm);

        // Nudge: suggest creating a Place when this freeform address has been
        // used multiple times (data comes from the SavedLocation usageCount).
        if (
          result.savedLocationUsageCount != null &&
          result.savedLocationUsageCount >= 3 &&
          !location.thPlaceId &&
          slug
        ) {
          toast.info({
            id: "place-nudge",
            title: t("admin.ebPlaceNudgeTitle") as string,
            message: t("admin.ebPlaceNudgeMessage", {
              count: result.savedLocationUsageCount,
            }) as string,
          });
        }

        // ── Series update flow (event already in a series) ──
        // Runs AFTER the single-event save (mirroring the convert flow below)
        // so the event's own field edits — title/date/location/etc — are never
        // silently dropped, and the schedule anchors on the JUST-SAVED start:
        // recurrenceConfig.dtstart is stashed at emit time and goes stale when
        // the user changes the event date in the same save.
        if (recurrenceEnabled && recurrenceConfig && existingSeriesId) {
          const recurrenceUntil = recurrenceConfig.until?.trim() || undefined;
          // Anchor on the just-saved event start (the same expression
          // baseInput.startsAt used above).
          const updateDtstart = toIsoInTimeZone(startsAt!, eventTimezone);
          // COUNT-bounded schedules have no `until` — reconcile through the
          // final enumerated occurrence instead of a zero-width dtstart window.
          const reconcileWindowEnd = reconcileWindowEndForConfig(
            {
              rrule: recurrenceConfig.rrule,
              dtstart: updateDtstart,
              until: recurrenceUntil,
            },
            eventTimezone,
          );

          try {
            await updateSeries.mutateAsync({
              seriesId: existingSeriesId,
              patch: {
                name: title,
                schedule: {
                  kind: "RRULE" as const,
                  rrule: recurrenceConfig.rrule,
                  dtstart: updateDtstart,
                  until: recurrenceUntil,
                  maxOccurrencesPerExpand: 100,
                },
              },
              clientKey: nanoid(12),
            });

            // Reconcile occurrences — diff old vs new schedule (first pass: no
            // confirmed cancellations). If published events with sales would be
            // detached the confirm dialog takes over and the flow continues in
            // handleReconcileConfirm (which also resumes the scoped draft
            // sync).
            const pass = await runReconcilePass({
              seriesId: existingSeriesId,
              windowStart: updateDtstart,
              windowEnd: reconcileWindowEnd,
              mode: "update",
              eventId: result.eventId,
            });
            if (pass.pending) return;

            await completeSeriesFlow(
              "update",
              existingSeriesId,
              result.eventId,
              pass.result,
            );
          } catch (error) {
            // The event itself saved above — a failed schedule update is
            // partial success, not a failed save. Warn (don't reportError:
            // that reads as "save failed") and still attempt the scoped draft
            // propagation below, which is independent of the schedule
            // bookkeeping. Saving again re-runs the series flow.
            toast.warning({
              id: "series-update-partial",
              title: t("admin.ebSeriesUpdatePartialTitle") as string,
              message: t("admin.ebSeriesUpdatePartialMessage", {
                reason: formatErrorMessage(error, t),
              }) as string,
            });
          }

          await runScopedDraftSync(existingSeriesId, result.eventId);
          return;
        }

        // ── Series convert flow (recurrence enabled, event not in a series) ──
        // Runs AFTER the event save so the backend validates the schedule
        // against the just-saved start date (converting first would check the
        // stale DB start and could reject a combined date+recurrence edit).
        if (recurrenceEnabled && recurrenceConfig && !existingSeriesId) {
          const recurrenceUntil = recurrenceConfig.until?.trim() || undefined;
          // Anchor the schedule on the JUST-SAVED event start (the same
          // expression baseInput.startsAt used above) — recurrenceConfig.dtstart
          // is stashed at emit time and goes stale when the user changes the
          // event date in the same save.
          const convertDtstart = toIsoInTimeZone(startsAt!, eventTimezone);
          // COUNT-bounded schedules have no `until` — reconcile through the
          // final enumerated occurrence (anchored on the just-saved start).
          const reconcileWindowEnd = reconcileWindowEndForConfig(
            {
              rrule: recurrenceConfig.rrule,
              dtstart: convertDtstart,
              until: recurrenceUntil,
            },
            eventTimezone,
          );

          let seriesId: string;
          try {
            const converted = await convertSeries.mutateAsync({
              eventId: result.eventId,
              schedule: {
                kind: "RRULE" as const,
                rrule: recurrenceConfig.rrule,
                dtstart: convertDtstart,
                until: recurrenceUntil,
                maxOccurrencesPerExpand: 100,
              },
              clientKey: nanoid(12),
            });
            seriesId = converted.seriesId;
          } catch (error) {
            // Nothing series-side changed — surface the error and stay on
            // the form (the event's own field changes saved above), so the
            // user can fix the schedule and hit save again.
            reportError(error, t("admin.ebRecurrenceFailedTitle") as string);
            return;
          }

          // The event now belongs to a series — refresh the edit payload
          // immediately so a re-save takes the update branch even when the
          // reconcile/generate tail below fails (re-firing convert would error
          // EVENT_ALREADY_IN_SERIES).
          void utils.events.getEventForEdit.invalidate({
            eventId: result.eventId,
          });

          try {
            const pass = await runReconcilePass({
              seriesId,
              windowStart: convertDtstart,
              windowEnd: reconcileWindowEnd,
              mode: "convert",
              eventId: result.eventId,
            });
            if (pass.pending) return; // confirm dialog continues the flow

            await completeSeriesFlow(
              "convert",
              seriesId,
              result.eventId,
              pass.result,
            );
          } catch (error) {
            // Convert succeeded but the occurrence bookkeeping didn't —
            // partial success: the series exists and saving again re-runs
            // reconcile + generate. (No consumer wires `onSave` today, so the
            // user stays on the form and can simply save again.)
            toast.warning({
              id: "series-convert-partial",
              title: t("admin.ebSeriesConvertPartialTitle") as string,
              message: t("admin.ebSeriesConvertPartialMessage", {
                reason: formatErrorMessage(error, t),
              }) as string,
            });
            onSave?.(result.eventId);
          }
          return;
        }

        // Plain save of an event that belongs to a series (recurrence section
        // untouched or toggled off) — still honour a "following"/"all"
        // propagation choice from the scope dialog (no-op for "this").
        if (existingSeriesId) {
          await runScopedDraftSync(existingSeriesId, result.eventId);
        }

        onSave?.(result.eventId);
      } catch (error) {
        // The save itself failed — drop any stashed propagation choice so a
        // stale scope can never leak into a later flow.
        pendingSyncScopeRef.current = null;
        pendingSyncIncludeAreasRef.current = false;
        const meta = extractQuotaExceededMeta(error);
        if (meta) {
          setQuotaMeta(meta);
        } else if (isHoldLineOpenChallengeError(error)) {
          // A PUBLISHED event moved onto a held date meets the same rule as
          // publish; the server refuses the save and nothing was written.
          handleHoldLineOpenChallenge();
        } else {
          console.error("Failed to save event:", error);
          reportError(error);
        }
      } finally {
        saveInFlightRef.current = false;
        setIsSaving(false);
      }
    },
    [
      eventId,
      title,
      startsAt,
      endsAt,
      location,
      locationMode,
      placement,
      placementDirty,
      bodyContent,
      visibilityMode,
      visibilityRadius,
      visibilityLabel,
      addressRevealPreset,
      addressRevealAt,
      addressRevealPresetTouched,
      eventTimezone,
      ownerType,
      ownerId,
      recurrenceEnabled,
      recurrenceConfig,
      heroImageFile,
      heroImageRemoved,
      uploadStagedHeroImage,
      createForHuman,
      createForOrg,
      updateSeries,
      convertSeries,
      runReconcilePass,
      completeSeriesFlow,
      runScopedDraftSync,
      gates?.arrivalAreas,
      existingSeriesId,
      eventForEditQuery.data,
      onSave,
      markSaved,
      toast,
      t,
      slug,
      utils.events.getEventForEdit,
      utils.events.getGateState,
      utils.events.getEventProvenance,
      clearErrors,
      setFieldError,
      reportError,
      handleHoldLineOpenChallenge,
    ],
  );

  // ── COMMUNITY save / publish ────────────────────────────────────────────
  // The community counterparts of `handleSave` / `handlePublish`. They are
  // siblings rather than branches inside those two because almost nothing is
  // shared: no series flow, no venue placement, no address-reveal payload, no
  // Stripe/attestation/chargeback gates, and a different pair of procedures.
  // What they DO share is deliberately shared, not re-typed — the same
  // validation messages, the same staged-hero upload sequence
  // (`uploadStagedHeroImage`), the same error funnel.

  /**
   * Shared required-field check. Community listings need the same three the
   * ticketed builder does, PLUS a geocoded pin: `createCommunityListing`
   * requires `addressText` + `lat`/`lng` + `countryCode` because an ownerless
   * listing has no Place to fall back on, and `updateListing`'s whitelist
   * rejects a lone `lat` or `lng` outright (`lat_lng_must_pair`).
   */
  /**
   * The location a community save sends: what the toggle SHOWS. Switching a
   * linked listing to Address restores the snapshot, which still carries the
   * place id, so without this the form would read "Address" and the save
   * would keep the link. In Address mode the listing is unlinked.
   * (`handleBuilderLocationModeChange` clears the id on the switch too; this
   * also covers "Reset location", which restores the hydrated snapshot.)
   */
  const communityLocation = useMemo<LocationState>(
    () =>
      locationMode === "address" && location.thPlaceId
        ? { ...location, thPlaceId: undefined, thPlaceName: undefined }
        : location,
    [locationMode, location],
  );
  /**
   * The mode toggle, plus one community rule: switching to Address LEAVES the
   * link. `handleLocationModeChange` restores the pre-place snapshot, which on
   * a hydrated linked listing still names the place; the functional update
   * below runs after that restore and drops the place id and name, so the
   * form, the preview and the save all read "unlinked".
   */
  const handleBuilderLocationModeChange = useCallback(
    (mode: LocationMode) => {
      handleLocationModeChange(mode);
      if (isCommunity && mode === "address") {
        setLocation((current) =>
          current.thPlaceId || current.thPlaceName
            ? { ...current, thPlaceId: undefined, thPlaceName: undefined }
            : current,
        );
      }
    },
    [handleLocationModeChange, isCommunity],
  );
  const validateCommunityFields = useCallback((): boolean => {
    let valid = true;
    if (!title) {
      setFieldError("title", String(t("errors.titleRequired")));
      valid = false;
    }
    if (!startsAt) {
      setFieldError("startsAt", String(t("errors.startDateRequired")));
      valid = false;
    }
    if (!endsAt) {
      setFieldError("endsAt", String(t("errors.endDateRequired")));
      valid = false;
    }
    // A linked venue is the server's call, not the pin check's: it copies the
    // address from the place, and refuses a withholding or unpinned venue with
    // its own reason (`communityPlaceRefusalMessageKey`). A picker item can
    // legitimately arrive without an address or pin (the public read redacts
    // a withheld one), and "pick the address" would be the wrong advice.
    if (
      !communityLocation.thPlaceId &&
      !communityLocationIsPinned(communityLocation)
    ) {
      reportError({ message: String(t("communityBuilder.errLocationPin")) });
      valid = false;
    }
    return valid;
  }, [
    title,
    startsAt,
    endsAt,
    communityLocation,
    setFieldError,
    reportError,
    t,
  ]);

  /**
   * Route a community write failure to the place the reader can act on it:
   * the 2FA enrolment prompt, the offending field, or — last — the form
   * banner. Returns true once handled.
   */
  const handleCommunityWriteError = useCallback(
    (error: unknown, fallbackTitleKey: string): void => {
      if (handleSecondFactorRequired(error)) return;

      const code = getAppErrorCode(error);
      // The listing reached an end state under us (another tab, another
      // moderator, the completion job). EVENT_NOT_DRAFT used to live here and
      // caught PUBLISHED too; a live listing is saveable now, so the only
      // status refusals left are the terminal ones. Refetch so the surface
      // flips to the locked notice instead of offering a Save that cannot
      // land.
      if (code === "EVENT_NOT_EDITABLE" || code === "EVENT_ARCHIVED") {
        void utils.events.getEventForEdit.invalidate({ eventId });
        reportError(
          { message: String(t("communityBuilder.errListingLocked")) },
          String(t(fallbackTitleKey)),
        );
        return;
      }

      // A refused place link names the venue's problem, not "invalid input".
      const placeRefusalKey = communityPlaceRefusalMessageKey(error);
      if (placeRefusalKey) {
        reportError(
          { message: String(t(placeRefusalKey)) },
          String(t(fallbackTitleKey)),
        );
        return;
      }

      const anchored = anchorCommunityFieldError(error);
      if (anchored) {
        setFieldError(anchored.field, String(t(anchored.messageKey)));
        // The banner names the class of problem; the inline error is the fix.
        reportError({ message: String(t(anchored.messageKey)) }, String(t(fallbackTitleKey)));
        return;
      }

      reportError(error, String(t(fallbackTitleKey)));
    },
    [
      handleSecondFactorRequired,
      utils.events.getEventForEdit,
      eventId,
      reportError,
      setFieldError,
      t,
    ],
  );

  // ── FR-013 materiality, computed where the moderator can still act on it ─
  //
  // The server decides whether a schedule edit notifies attendees from the KEY
  // SET it receives, not from whether a value moved. The builder sends the whole form
  // every save, so a live listing used to arrive carrying an unchanged
  // schedule and an unchanged address — which `recordCommunityEditApplied`
  // reads as a reschedule AND a venue move, and mails everyone who RSVP'd or
  // saved the listing about neither.
  //
  // So the diff is computed here and travels two ways: it trims the payload
  // (`include`), which makes the server's materiality honest, and it decides
  // whether the confirm opens, which makes the moderator's information honest.
  // Both come out of ONE diff — a second, independently-derived "is this
  // material" would be free to disagree with the one that actually notifies.
  // They differ only for the venue: an address whose values differ but whose
  // pin moved 50 m or less and whose street line is the same is SENT
  // (`include.venue`) but notifies nobody (`venue` false), by the server's own
  // `addressVenueChanged` rule.
  //
  // DRAFT includes both groups on every save: a draft is being authored and
  // nothing is material. One exception, by design: a draft LINKED to a place
  // sends no address at all, because the place is the address and the server
  // refuses address fields on a linked listing (`buildCommunityUpdateFields`,
  // rule 5).
  const savedListing = eventForEditQuery.data ?? null;
  const communityMaterial: CommunityLiveSaveDiff = useMemo(() => {
    if (!communityLive) {
      return {
        schedule: true,
        venue: true,
        include: { schedule: true, venue: true },
      };
    }
    return diffCommunityMaterialGroups({
      startsAtLocal: startsAt ?? "",
      endsAtLocal: endsAt ?? "",
      timezone: eventTimezone,
      location: communityLocation,
      saved: savedListing,
    });
  }, [
    communityLive,
    startsAt,
    endsAt,
    eventTimezone,
    communityLocation,
    savedListing,
  ]);

  const [liveSaveConfirmOpen, setLiveSaveConfirmOpen] = useState(false);

  /**
   * The before/after pairs the confirm dialog prints — built only while it is
   * open, so a live listing pays nothing for them on every keystroke.
   */
  const liveSaveChanges = useMemo(() => {
    if (!liveSaveConfirmOpen) return { schedule: null, venue: null };
    const notSet = String(t("communityBuilder.liveSaveNotSet"));

    let schedule: { from: string; to: string } | null = null;
    if (communityMaterial.schedule) {
      const storedStart = savedListing?.startsAt
        ? new Date(savedListing.startsAt)
        : null;
      const storedEnd = savedListing?.endsAt
        ? new Date(savedListing.endsAt)
        : null;
      const pendingStart = startsAt
        ? new Date(toIsoInTimeZone(startsAt, eventTimezone))
        : null;
      const pendingEnd = endsAt
        ? new Date(toIsoInTimeZone(endsAt, eventTimezone))
        : storedEnd;
      schedule = {
        from: storedStart
          ? formatCommunityScheduleWindow({
              start: storedStart,
              end: storedEnd,
              timeZone: eventTimezone,
              locale,
            })
          : notSet,
        to: pendingStart
          ? formatCommunityScheduleWindow({
              start: pendingStart,
              end: pendingEnd,
              timeZone: eventTimezone,
              locale,
            })
          : notSet,
      };
    }

    let venue: { from: string; to: string } | null = null;
    if (communityMaterial.venue) {
      const from = formatCommunityAddressLabel({
        addressText: savedListing?.addressText,
        locality: savedListing?.locality,
        region: savedListing?.region,
        postalCode: savedListing?.postalCode,
      });
      const to = formatCommunityAddressLabel(communityLocation);
      venue = { from: from || notSet, to: to || notSet };
    }

    return { schedule, venue };
  }, [
    liveSaveConfirmOpen,
    communityMaterial,
    savedListing,
    startsAt,
    endsAt,
    eventTimezone,
    communityLocation,
    locale,
    t,
  ]);

  const handleCommunitySave = useCallback(async () => {
    if (saveInFlightRef.current) return;
    clearErrors();
    if (!validateCommunityFields()) return;

    saveInFlightRef.current = true;
    // Taken at send time, as in the owned save above.
    const sentForm = sendableFormRef.current;
    setIsSaving(true);
    try {
      // The hero is staged locally until save, exactly as it is for an owned
      // event: the image key is `events/{eventId}/…`, and the row already
      // exists (quick-create minted the DRAFT), so one upload then one save.
      let heroImageId: string | null | undefined;
      if (heroImageFile) {
        heroImageId = (await uploadStagedHeroImage(eventId)) ?? undefined;
      } else if (heroImageRemoved) {
        heroImageId = null;
      }

      await updateCommunityListing.mutateAsync({
        eventId,
        fields: buildCommunityUpdateFields({
          title,
          startsAtLocal: startsAt ?? "",
          endsAtLocal: endsAt ?? "",
          timezone: eventTimezone,
          location: communityLocation,
          bodyContent,
          bodyBlockId: nanoid(),
          categoryId: communityCategoryId,
          // `{ schedule: true, venue: true }` on a DRAFT — see
          // `communityMaterial`.
          include: communityMaterial.include,
          // The stored link: a new pick sends `placeId`, leaving one sends
          // `placeId: null`, keeping it sends neither.
          savedPlaceId: savedListing?.placeId ?? null,
          ...(heroImageId !== undefined ? { heroImageId } : {}),
        }),
      });

      if (heroImageFile) setHeroImageFile(null);
      setHeroImageRemoved(false);
      void utils.events.getEventForEdit.invalidate({ eventId });
      toast.success({
        id: "event-saved",
        title: t("admin.ebSavedTitle") as string,
        message: t("admin.ebSavedMessage") as string,
      });
      markSaved(sentForm);
      onSave?.(eventId);
    } catch (error) {
      handleCommunityWriteError(error, "admin.ebSaveFailedTitle");
    } finally {
      saveInFlightRef.current = false;
      setIsSaving(false);
    }
  }, [
    clearErrors,
    validateCommunityFields,
    heroImageFile,
    heroImageRemoved,
    uploadStagedHeroImage,
    eventId,
    updateCommunityListing,
    title,
    startsAt,
    endsAt,
    eventTimezone,
    communityLocation,
    savedListing,
    bodyContent,
    communityCategoryId,
    communityMaterial,
    utils.events.getEventForEdit,
    toast,
    t,
    onSave,
    markSaved,
    handleCommunityWriteError,
  ]);

  // ── Series edit-scope gate (Phase 3) ────────────────────────────────────
  // Events that already belong to a series ask which shows the edit applies
  // to before saving. The dialog governs ONLY event-field propagation;
  // schedule (recurrence-section) changes apply series-wide regardless.
  //
  // Dirtiness caveat: the builder tracks fields as independent useState (no
  // form lib) and the edit-payload restore is lossy (body content keeps only
  // the first richText block), so there is no reliable "event fields
  // changed" signal. We therefore ALWAYS ask for series events, with
  // "This show only" preselected as the safe zero-extra-effect default.
  const requestSave = useCallback(() => {
    if (saveInFlightRef.current || isSaving) return;
    // Community listings save through `community.updateListing` and never
    // belong to a series, so they skip the scope gate entirely — but a LIVE
    // one has a gate of its own when the pending diff moves the schedule or
    // the venue, because that save mails everyone who RSVP'd or saved it.
    // Non-material saves on a live listing go straight through: a speed bump
    // in front of every title fix is a speed bump nobody reads.
    if (isCommunity) {
      if (
        communityLive &&
        (communityMaterial.schedule || communityMaterial.venue)
      ) {
        setLiveSaveConfirmOpen(true);
        return;
      }
      void handleCommunitySave();
      return;
    }
    // Cmd/Ctrl+S while the scope dialog (or the reconcile confirm) is
    // already up must not re-enter: it would reset scopeChoice to "this" —
    // silently discarding a picked "following"/"all" propagation.
    if (scopeDialogOpen || showReconcileConfirm) return;
    if (shouldOfferScopeDialog({ seriesId: existingSeriesId })) {
      setScopeChoice("this");
      setScopeIncludeArrivalAreas(false);
      setScopeDialogOpen(true);
      return;
    }
    void handleSave();
  }, [
    isSaving,
    scopeDialogOpen,
    showReconcileConfirm,
    existingSeriesId,
    handleSave,
    isCommunity,
    communityLive,
    communityMaterial,
    handleCommunitySave,
  ]);

  /**
   * Commit from the live-save confirm. `handleCommunitySave` reports its own
   * failures into the form banner and never throws, so the dialog closes
   * either way — leaving it up would hide the banner behind it.
   */
  const handleLiveSaveConfirm = useCallback(async () => {
    await handleCommunitySave();
    setLiveSaveConfirmOpen(false);
  }, [handleCommunitySave]);

  const handleLiveSaveCancel = useCallback(() => {
    if (saveInFlightRef.current) return;
    setLiveSaveConfirmOpen(false);
  }, []);

  const handleScopeConfirm = useCallback(async () => {
    if (scopeSavingRef.current) return;
    scopeSavingRef.current = true;
    setScopeSaving(true);
    try {
      // handleSave never throws (it reports internally); the finally is for
      // symmetry, so the dialog can never wedge open in a busy state.
      await handleSave(scopeChoice, {
        includeArrivalAreas: scopeIncludeArrivalAreas,
      });
    } finally {
      scopeSavingRef.current = false;
      setScopeSaving(false);
      // Close AFTER the round trip — the Save button stays busy through
      // save + draft propagation. When the reconcile-confirm dialog took
      // over (pending pass), handleSave already returned and that dialog is
      // on screen; closing this one avoids stacked modals.
      setScopeDialogOpen(false);
    }
  }, [handleSave, scopeChoice, scopeIncludeArrivalAreas]);

  const handleScopeCancel = useCallback(() => {
    if (scopeSavingRef.current) return;
    setScopeDialogOpen(false);
  }, []);

  // "FRI JUL 31" — the show being saved, from the CURRENT form value (what
  // the save will write), formatted in the event timezone like the Dates
  // page rows. Falls back to the stored start when the form field is empty
  // (validation hasn't run yet when the dialog opens), so the "This show
  // only" description never renders "Only  changes."
  const storedStartsAt = eventForEditQuery.data?.startsAt ?? null;
  const scopeDateLabel = useMemo(() => {
    const start = startsAt
      ? new Date(toIsoInTimeZone(startsAt, eventTimezone))
      : storedStartsAt
        ? new Date(storedStartsAt)
        : null;
    if (!start || Number.isNaN(start.getTime())) return "";
    return formatRowDate(start, eventTimezone, locale);
  }, [startsAt, storedStartsAt, eventTimezone, locale]);

  const publishMutation = trpc.events.publishEvent.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.events.getEventForEdit.invalidate({ eventId });
      void utils.events.getGateState.invalidate({ eventId });
    },
  });

  const acceptOrgChargebackTermsMutation =
    trpc.orgs.acceptChargebackTerms.useMutation({
      retry: false,
      meta: { silent: true },
    });

  const acceptHumanChargebackTermsMutation =
    trpc.humans.acceptMyChargebackTerms.useMutation({
      retry: false,
      meta: { silent: true },
    });

  const [isPublishing, setIsPublishing] = useState(false);
  const [showChargebackTerms, setShowChargebackTerms] = useState(false);
  const [chargebackTermsMode, setChargebackTermsMode] =
    useState<ChargebackTermsModalMode>("publish-retry");
  const [chargebackTermsAccepted, setChargebackTermsAccepted] = useState(false);
  const [
    chargebackTermsAcceptedThisSession,
    setChargebackTermsAcceptedThisSession,
  ] = useState(false);
  const [chargebackTermsError, setChargebackTermsError] = useState<
    string | null
  >(null);
  const [showHostAttestation, setShowHostAttestation] = useState(false);
  const [hostAttestation, setHostAttestation] = useState<HostAttestationState>(
    () => createEmptyHostAttestationState(),
  );
  const [hostAttestationError, setHostAttestationError] = useState<
    string | null
  >(null);
  const [missingHostAttestationFields, setMissingHostAttestationFields] =
    useState<HostAttestationField[]>([]);
  const pendingHostAttestationRef = useRef<HostAttestationSubmission | null>(
    null,
  );
  const hostAttestationModeRef = useRef<boolean | null>(null);
  // Synchronous re-entrancy guard for publish. The header's Publish CTA's
  // disabled/loading visual is driven by `publishMutation.isPending`, which
  // only flips once React re-renders the floating dock — a fast double-click
  // (or the attestation/terms retry firing back-to-back) can call the publish
  // funnel twice before that propagates, which is what batched the observed
  // `publishEvent,publishEvent` request. This ref blocks the second call
  // within the same tick.
  const publishInFlightRef = useRef(false);

  const isChargebackTermsSubmitting =
    isPublishing ||
    acceptOrgChargebackTermsMutation.isPending ||
    acceptHumanChargebackTermsMutation.isPending;
  const isHostAttestationSubmitting = isPublishing || publishMutation.isPending;
  const usesPrivateHostAttestation = visibilityMode === "OBSCURED";
  const allHostAttestationChecked = useMemo(
    () => HOST_ATTESTATION_FIELDS.every((field) => hostAttestation[field]),
    [hostAttestation],
  );

  useEffect(() => {
    if (hostAttestationModeRef.current === null) {
      hostAttestationModeRef.current = usesPrivateHostAttestation;
      return;
    }

    if (hostAttestationModeRef.current === usesPrivateHostAttestation) return;

    hostAttestationModeRef.current = usesPrivateHostAttestation;
    pendingHostAttestationRef.current = null;
    setHostAttestation(createEmptyHostAttestationState());
    setMissingHostAttestationFields([]);
    setHostAttestationError(null);
  }, [usesPrivateHostAttestation]);

  const chargebackTermsTarget = useMemo(
    () => resolveChargebackTermsAcceptanceTarget(eventForEditQuery.data),
    [eventForEditQuery.data],
  );

  // The owner's STORED acceptance, so terms accepted on the payments page (or
  // in an earlier builder session) count here too. Read only while it can
  // matter: an editor (`canEdit`) on an owned event with paid tickets. The
  // owner resolver returns null for a delegate on a human-owned event (the
  // profile read is the viewer's own row), so nothing is read for them. It
  // feeds the readiness rail alone; publish still goes through the server's
  // check, and a `chargeback_terms_required` refusal still opens the dialog.
  const storedChargebackTermsOwner = useMemo(
    () =>
      resolveStoredChargebackTermsOwner(eventForEditQuery.data, {
        ownerType,
        ownerId,
      }),
    [eventForEditQuery.data, ownerType, ownerId],
  );
  const storedChargebackTermsAcceptance = useStoredChargebackTermsAcceptance(
    storedChargebackTermsOwner,
    {
      enabled:
        canEdit && !isCommunity && hasPaidTicketTypesForChargebackTerms,
    },
  );

  // Pre-flight Stripe Connect gate. Paid tickets can't be checked out unless
  // the organizer's payee has chargesEnabled + payoutsEnabled. It surfaces the
  // requirement early so the organizer isn't sent to Publish only to get a 4xx.
  //
  // ── What this does and does NOT mirror ──────────────────────────────────
  // It corresponds to `ensureStripeConnectedForPaidEvent` (publish-event.ts),
  // and it is deliberately NOT claimed to be an exact mirror — it previously
  // was, and the claim was false in ways that produced a real outage:
  //
  //  - Data source: this reads LIVE Stripe via `stripeConnect.getStatus`; the
  //    server reads the `Payee` DB row. Those used to be reconciled by nothing
  //    at all, so a missed `account.updated` meant Publish was enabled here and
  //    refused there, forever. `getConnectStatus` now writes the live state
  //    back onto the row, so the two converge on any Payments-page or
  //    builder load — but they are still two systems, and this query is served
  //    from a 2-minute `staleTime` cache on top.
  //  - Owner type: human-owned events are NOT gated here at all (`isOrgOwner`);
  //    the server gates them identically via `derivePayeeSubject`. They fall
  //    back to the server error path. TODO: expose getStatus for humanId too.
  //  - Co-payees: publish-event.ts has a SECOND payout gate that blocks on
  //    every split line's payee once any line requires confirmation. Nothing on
  //    this flag knows about it; `getEventSplits.publishGateBlockers` carries
  //    that answer and is only rendered inside the splits editor.
  const blockedByStripeConnect =
    canEdit &&
    !isCommunity &&
    hasPaidTicketTypesForChargebackTerms &&
    eventStatus === "DRAFT" &&
    isOrgOwner &&
    connectStatusQuery.isSuccess &&
    !connectFullyEnabled;

  // ── Publish-readiness rail (FR-104/FR-105) ────────────────────────────
  // Replaces the chargeback-terms + Stripe-Connect banners. The per-item
  // semantics are mirrored inside `mapReadinessInput` (pure, unit-tested).
  // Purely presentational — publish gating itself is unchanged.
  //
  // DRAFT-only. It is a PRE-publish checklist ("Ready to publish?"), so it
  // renders exactly where the Publish CTA can appear (`ebShowPublish` is
  // `canEditEvent && eventStatus === "DRAFT"`, minus the Stripe block — the
  // rail must still show while Stripe is what's blocking, since it carries the
  // fix link). Post-publish the framing is meaningless. The chargeback-terms
  // item reads an in-builder acceptance or the owner's stored acceptance of
  // the current version; when the stored record is unreadable (a non-finance
  // org member, a delegate on a human-owned event) it falls back to the
  // in-builder acceptance alone, and on a non-DRAFT event that left a blocker
  // the organizer could never clear — one more reason the rail is DRAFT-only.
  // Unpublishing returns the event to DRAFT and the rail with it.
  // Never for a community listing: every item the rail can check (ticket
  // types, Stripe Connect, chargeback terms, host attestation) belongs to an
  // owned event, so on a listing it would be a checklist of gates that do not
  // apply and can never be cleared.
  const readinessEligible =
    canEdit &&
    !isCommunity &&
    eventForEditQuery.isSuccess &&
    eventStatus === "DRAFT";
  const showDesktopReadinessRail = readinessEligible && !isMobile;
  // Readiness only ever checks Boolean(title) / hasContent(body) — dep on the
  // BOOLEANS, not the raw values, so keystrokes in Title/Details don't mint a
  // new readiness object every render (that identity churn was silently
  // defeating MemoPublishReadinessRail).
  const titleIsSet = Boolean(title);
  const detailsNonEmpty = useMemo(() => hasContent(bodyContent), [bodyContent]);
  const { input: readinessInput, hideStripeItem } = useMemo(
    () =>
      mapReadinessInput({
        // Sentinel string with stable identity; readiness semantics are
        // `!title`, so only emptiness matters (see event-readiness.ts).
        title: titleIsSet ? "set" : "",
        startsAt,
        // Mirrors the save payload's location branch: a linked Place or a
        // fully geocoded freeform address counts as a venue.
        hasVenue: Boolean(
          location.thPlaceId ||
          (location.addressText && location.lat && location.lng),
        ),
        // The SAVED category — publish reads the row, not the picker. The
        // picker's `setEventCategory` onSuccess invalidates getEventForEdit,
        // so this flips as soon as a pick is persisted.
        hasCategory: Boolean(eventForEditQuery.data?.categoryId),
        detailsNonEmpty,
        ticketTypeCount: ticketTypesForEditQuery.data?.ticketTypes.length ?? 0,
        hasPaidTicketTypes: hasPaidTicketTypesForChargebackTerms,
        isOrgOwner,
        eventStatus,
        connectStatusKnown: connectStatusQuery.isSuccess,
        // Same value the Publish CTA gates on, so the rail can't say "ready"
        // while the CTA stays hidden.
        payoutsEnabled: connectFullyEnabled,
        chargebackTermsAcceptedThisSession,
        storedChargebackTermsAcceptance: storedChargebackTermsAcceptance.status,
        visibilityMode,
        allHostAttestationChecked,
        lineupCount: lineupListQuery.data?.length ?? 0,
      }),
    [
      titleIsSet,
      startsAt,
      location.thPlaceId,
      location.addressText,
      location.lat,
      location.lng,
      eventForEditQuery.data?.categoryId,
      detailsNonEmpty,
      ticketTypesForEditQuery.data?.ticketTypes.length,
      hasPaidTicketTypesForChargebackTerms,
      isOrgOwner,
      eventStatus,
      connectStatusQuery.isSuccess,
      connectFullyEnabled,
      chargebackTermsAcceptedThisSession,
      storedChargebackTermsAcceptance.status,
      visibilityMode,
      allHostAttestationChecked,
      lineupListQuery.data?.length,
    ],
  );
  const readiness = useMemo(
    () => computeEventReadiness(readinessInput),
    [readinessInput],
  );

  // Publish is a page-owned button in the builder header, so it can take
  // `aria-describedby` directly. Unset whenever the rail (and therefore the
  // referenced list element) isn't rendered, so the reference never dangles.
  const readinessBlockerListId = useId();
  const publishBlockersId =
    showDesktopReadinessRail && !isPreviewMode && readiness.blockers.length > 0
      ? readinessBlockerListId
      : undefined;

  const openChargebackTermsForPublishRetry = useCallback(
    (message?: string | null) => {
      setChargebackTermsMode("publish-retry");
      setChargebackTermsAccepted(false);
      setChargebackTermsError(message ?? null);
      setShowChargebackTerms(true);
    },
    [],
  );

  const handleHostAttestationIncomplete = useCallback(
    (error: unknown) => {
      const missingFields = extractMissingHostAttestationFields(error);
      pendingHostAttestationRef.current = null;
      setMissingHostAttestationFields(
        missingFields.length > 0 ? missingFields : [...HOST_ATTESTATION_FIELDS],
      );
      setHostAttestationError(
        String(t("admin.ebHostAttestationIncompleteError")),
      );
      setShowChargebackTerms(false);
      setShowHostAttestation(true);
    },
    [t],
  );

  const publishCurrentEvent = useCallback(
    async (attestation?: HostAttestationSubmission) => {
      // Guard against a concurrent in-flight publish (see publishInFlightRef).
      if (publishInFlightRef.current) return;
      publishInFlightRef.current = true;

      try {
        await publishMutation.mutateAsync({
          eventId,
          clientKey: nanoid(12),
          ...(attestation ? { attestation } : {}),
        });
        pendingHostAttestationRef.current = null;
        toast.success({
          id: "event-published",
          title: t("admin.ebEventPublishedTitle") as string,
          message: t("admin.ebEventPublishedMessage") as string,
        });
      } finally {
        // Always release the guard — errors still propagate to callers'
        // catch blocks (the finally runs, then re-throws).
        publishInFlightRef.current = false;
      }
    },
    [eventId, publishMutation, t, toast],
  );

  const handleCloseChargebackTerms = useCallback(() => {
    if (isChargebackTermsSubmitting) return;
    setShowChargebackTerms(false);
    setChargebackTermsAccepted(false);
    setChargebackTermsError(null);
  }, [isChargebackTermsSubmitting]);

  const handleCloseHostAttestation = useCallback(() => {
    if (isHostAttestationSubmitting) return;
    setShowHostAttestation(false);
    setHostAttestationError(null);
    setMissingHostAttestationFields([]);
  }, [isHostAttestationSubmitting]);

  // `setX(null)` when the value is already null is a React bail-out, so these
  // no longer need to read the error state — which keeps their identity stable
  // for the memoized dialog.
  const handleHostAttestationChange = useCallback(
    (field: HostAttestationField, checked: boolean) => {
      setHostAttestation((current) => ({
        ...current,
        [field]: checked,
      }));
      if (checked) {
        setMissingHostAttestationFields((current) =>
          current.filter((missingField) => missingField !== field),
        );
      }
      setHostAttestationError(null);
    },
    [],
  );

  const handleStandardHostAttestationChange = useCallback(
    (checked: boolean) => {
      setHostAttestation(
        Object.fromEntries(
          HOST_ATTESTATION_FIELDS.map((field) => [field, checked]),
        ) as HostAttestationState,
      );
      setMissingHostAttestationFields([]);
      setHostAttestationError(null);
    },
    [],
  );

  const handleChargebackTermsAcceptedChange = useCallback(
    (accepted: boolean) => {
      setChargebackTermsAccepted(accepted);
      setChargebackTermsError(null);
    },
    [],
  );

  const handleOpenChargebackTermsStandalone = useCallback(() => {
    if (isChargebackTermsSubmitting) return;
    setChargebackTermsMode("standalone");
    setChargebackTermsAccepted(false);
    setChargebackTermsError(null);
    setShowChargebackTerms(true);
  }, [isChargebackTermsSubmitting]);

  // Opens the host-attestation dialog with a clean error state. Shared by
  // the publish funnel (DRAFT + OBSCURED pre-publish gate below) and the
  // readiness rail's deep-link (FR-104) — one opener, one dialog.
  const handleOpenHostAttestationDialog = useCallback(() => {
    setHostAttestationError(null);
    setMissingHostAttestationFields([]);
    setShowHostAttestation(true);
  }, []);

  const handlePublish = useCallback(async () => {
    // ── Pre-publish guard: unsaved location ───────────────────────────────
    // Publish reads the persisted event record, but the location lives in
    // local builder state until the user hits Save. If a location is shown in
    // the form yet the saved record has none, the server rejects with
    // EVENT_LOCATION_REQUIRED — which surfaces as "Add a location" even though
    // one is visibly selected. Tell the user to save first instead of leaking
    // that misleading precondition error.
    if (isLocationUnsaved(location, eventForEditQuery.data)) {
      reportError(
        { message: String(t("admin.ebSaveBeforePublish")) },
        t("admin.ebPublishFailedTitle") as string,
      );
      return;
    }

    // ── Pre-publish guard: start date in the past ─────────────────────────
    // The native datetime control pins `min` to "now", but a typed value can
    // still land in the past and the server doesn't reject it. Validate here
    // so a stale/past start surfaces a clear message rather than silently
    // publishing an event that already started.
    if (isStartInPast(startsAt, eventTimezone)) {
      reportError(
        { message: String(t("errors.startDateInPast")) },
        t("admin.ebPublishFailedTitle") as string,
      );
      return;
    }

    // Host responsibilities attestation is only required for **private
    // locations** (OBSCURED location mode = residential / house show /
    // obscured-or-hidden address). Commercial venues already carry their own
    // liability and licensing, so prompting their organizers is noise. The
    // server side mirrors this gate in `publish-event.ts`.
    if (eventStatus === "DRAFT" && usesPrivateHostAttestation) {
      handleOpenHostAttestationDialog();
      return;
    }

    setIsPublishing(true);
    try {
      await publishCurrentEvent();
    } catch (error) {
      if (isChargebackTermsRequiredError(error)) {
        openChargebackTermsForPublishRetry();
        return;
      }
      if (isAttestationIncompleteError(error)) {
        handleHostAttestationIncomplete(error);
        return;
      }
      if (isHoldLineOpenChallengeError(error)) {
        handleHoldLineOpenChallenge();
        return;
      }
      reportError(error, t("admin.ebPublishFailedTitle") as string);
    } finally {
      setIsPublishing(false);
    }
  }, [
    eventStatus,
    usesPrivateHostAttestation,
    location,
    startsAt,
    eventTimezone,
    eventForEditQuery.data,
    handleHostAttestationIncomplete,
    handleOpenHostAttestationDialog,
    openChargebackTermsForPublishRetry,
    publishCurrentEvent,
    reportError,
    handleHoldLineOpenChallenge,
    t,
  ]);

  const handleCommunityPublish = useCallback(async () => {
    if (publishInFlightRef.current) return;
    // Publish reads the PERSISTED row, so unsaved edits would silently not be
    // part of what goes live. Same reasoning as the owned builder's
    // "save before publish" guard, applied to the field a listing cannot
    // publish without, and to every other unsaved field (a title or
    // description edit would be dropped the same way).
    if (hasUnsaved || isLocationUnsaved(location, eventForEditQuery.data)) {
      reportError(
        { message: String(t("admin.ebSaveBeforePublish")) },
        t("admin.ebPublishFailedTitle") as string,
      );
      return;
    }
    if (isStartInPast(startsAt, eventTimezone)) {
      reportError(
        { message: String(t("errors.startDateInPast")) },
        t("admin.ebPublishFailedTitle") as string,
      );
      return;
    }

    publishInFlightRef.current = true;
    setIsPublishing(true);
    try {
      const result = await publishCommunityListing.mutateAsync({ eventId });
      void utils.events.getEventForEdit.invalidate({ eventId });
      // `changed: false` means it was ALREADY live — an idempotent success
      // (a double-submit), never an error. Saying so is more useful than a
      // second "Published!" that implies this click did something.
      toast.success({
        id: "event-published",
        title: t(
          result.changed
            ? "admin.ebEventPublishedTitle"
            : "communityBuilder.alreadyLiveTitle",
        ) as string,
        message: t(
          result.changed
            ? "communityBuilder.publishedMessage"
            : "communityBuilder.alreadyLiveMessage",
        ) as string,
      });
      // Matches what the retired standalone form did: a published listing's
      // home is its public page, and the builder can no longer edit it.
      router.push(`/events/${result.event.slug ?? result.event.id}`);
    } catch (error) {
      handleCommunityWriteError(error, "admin.ebPublishFailedTitle");
    } finally {
      publishInFlightRef.current = false;
      setIsPublishing(false);
    }
  }, [
    location,
    eventForEditQuery.data,
    startsAt,
    eventTimezone,
    publishCommunityListing,
    eventId,
    utils.events.getEventForEdit,
    toast,
    t,
    router,
    hasUnsaved,
    reportError,
    handleCommunityWriteError,
  ]);

  const handleSubmitHostAttestation = useCallback(async () => {
    const attestation = buildHostAttestationSubmission(hostAttestation);
    if (!attestation) {
      setMissingHostAttestationFields(
        HOST_ATTESTATION_FIELDS.filter((field) => !hostAttestation[field]),
      );
      setHostAttestationError(
        String(t("admin.ebHostAttestationIncompleteError")),
      );
      return;
    }

    pendingHostAttestationRef.current = attestation;
    setHostAttestationError(null);
    setMissingHostAttestationFields([]);
    setIsPublishing(true);

    try {
      await publishCurrentEvent(attestation);
      setShowHostAttestation(false);
      setHostAttestation(createEmptyHostAttestationState());
    } catch (error) {
      if (isChargebackTermsRequiredError(error)) {
        setShowHostAttestation(false);
        openChargebackTermsForPublishRetry();
        return;
      }
      if (isAttestationIncompleteError(error)) {
        handleHostAttestationIncomplete(error);
        return;
      }
      if (isHoldLineOpenChallengeError(error)) {
        handleHoldLineOpenChallenge();
        return;
      }
      pendingHostAttestationRef.current = null;
      reportError(error, t("admin.ebPublishFailedTitle") as string);
    } finally {
      setIsPublishing(false);
    }
  }, [
    handleHostAttestationIncomplete,
    hostAttestation,
    openChargebackTermsForPublishRetry,
    publishCurrentEvent,
    reportError,
    handleHoldLineOpenChallenge,
    t,
  ]);

  const handleAcceptChargebackTerms = useCallback(async () => {
    if (!chargebackTermsAccepted) return;
    if (!chargebackTermsTarget) {
      setChargebackTermsError(String(t("admin.ebChargebackTermsOwnerMissing")));
      return;
    }

    setChargebackTermsError(null);
    setIsPublishing(true);

    try {
      if (chargebackTermsTarget.type === "org") {
        await acceptOrgChargebackTermsMutation.mutateAsync({
          orgId: chargebackTermsTarget.id,
        });
      } else {
        await acceptHumanChargebackTermsMutation.mutateAsync();
      }
    } catch (error) {
      const message = formatErrorMessage(error, t);
      setChargebackTermsError(message);
      toast.danger({
        id: "chargeback-terms-accept-failed",
        title: t("admin.ebChargebackTermsAcceptFailedTitle") as string,
        message,
      });
      return;
    } finally {
      setIsPublishing(false);
    }

    void utils.events.getEventForEdit.invalidate({ eventId });
    void utils.events.listTicketTypesForEdit.invalidate({ eventId });
    // The owner record the payments page and the stored-acceptance read share.
    if (chargebackTermsTarget.type === "org") {
      void utils.orgs.getOrg.invalidate({ orgId: chargebackTermsTarget.id });
    } else {
      void utils.humans.getMyProfile.invalidate();
    }

    setChargebackTermsAcceptedThisSession(true);
    setShowChargebackTerms(false);
    setChargebackTermsAccepted(false);

    if (chargebackTermsMode === "standalone") {
      toast.success({
        id: "chargeback-terms-accepted",
        title: t("admin.ebChargebackTermsAcceptedTitle") as string,
        message: t("admin.ebChargebackTermsAcceptedMessage") as string,
      });
      return;
    }

    const attestationForRetry =
      pendingHostAttestationRef.current ??
      buildHostAttestationSubmission(hostAttestation);
    if (!attestationForRetry) {
      setShowChargebackTerms(false);
      setChargebackTermsAccepted(false);
      setMissingHostAttestationFields([...HOST_ATTESTATION_FIELDS]);
      setHostAttestationError(
        String(t("admin.ebHostAttestationIncompleteError")),
      );
      setShowHostAttestation(true);
      return;
    }

    setIsPublishing(true);
    try {
      await publishCurrentEvent(attestationForRetry);
    } catch (error) {
      if (isChargebackTermsRequiredError(error)) {
        openChargebackTermsForPublishRetry(
          String(t("admin.ebChargebackTermsStillRequired")),
        );
      } else if (isAttestationIncompleteError(error)) {
        handleHostAttestationIncomplete(error);
      } else if (isHoldLineOpenChallengeError(error)) {
        handleHoldLineOpenChallenge();
      } else {
        reportError(error, t("admin.ebPublishFailedTitle") as string);
      }
    } finally {
      setIsPublishing(false);
    }
  }, [
    eventId,
    chargebackTermsAccepted,
    chargebackTermsMode,
    chargebackTermsTarget,
    acceptOrgChargebackTermsMutation,
    acceptHumanChargebackTermsMutation,
    handleHoldLineOpenChallenge,
    handleHostAttestationIncomplete,
    hostAttestation,
    openChargebackTermsForPublishRetry,
    publishCurrentEvent,
    reportError,
    t,
    toast,
    utils.events.getEventForEdit,
    utils.events.listTicketTypesForEdit,
    utils.orgs.getOrg,
    utils.humans.getMyProfile,
  ]);

  // ── Primary actions — page-owned (2026-08-27) ─────────────────────────
  // These used to be registered into a floating action bar; the bar is gone
  // and the builder header renders them itself. `eventPublicSlug` lives here
  // because the admin route is /admin/:slug/events/:id while the public page
  // is /events/:slug — only the builder knows the resolved slug.
  const eventPublicSlug = eventForEditQuery.data?.slug ?? null;
  // The event's PUBLIC page. Only ever opened for an event a stranger may
  // read — `publicLink` below, the server's `isEventPubliclyReadable` rule —
  // by `View event` and `Copy link`, and only through the encoded path
  // builders: there is no `/events/<uuid>` fallback any more.
  //
  // It is NOT the draft preview any more. `/events/<slug>` reads ANONYMOUSLY
  // (`getEventSeo`), and since N3 (place-address-withholding) that read
  // refuses a non-PUBLISHED event, so the draft link 404'd. It had been
  // broken before that too: the UUID fallback 500'd, because `mapEventToSeo`
  // throws on a null slug and only `publish-event` assigns one (measured
  // 2026-09-03). Same root both times — a draft is not a public page — so the
  // draft item now opens the builder's own preview instead
  // (`handleOpenPreviewTab`), which reads with the editor's identity.
  //
  // The link a stranger can actually open, or null (`eventPublicLink`: the
  // "publicly readable" rule `/e/<shortId>` and `/events/<slug>` apply).
  // Drives the Public link field, the `⋯` View
  // event / Copy link gates and URLs, and the Settings → Sharing short link,
  // so none of them can offer a dead link.
  const eventPublishedAt = eventForEditQuery.data?.publishedAt ?? null;
  const eventShortId = eventForEditQuery.data?.shortId ?? null;
  const publicLink = eventPublicLink({
    status: eventStatus,
    publishedAt: eventPublishedAt,
    slug: eventPublicSlug,
    shortId: eventShortId,
  });

  // ── Share event with promo (header chip + dialog) ─────────────────────
  const [shareOpen, setShareOpen] = useState(false);
  const sharePromosQuery = trpc.promos.list.useQuery(
    {
      ownerType: ownerType === "org" ? "ORGANIZATION" : "HUMAN",
      ownerId,
      status: "ACTIVE",
      limit: 200,
    },
    {
      // Only fetch once the event is published — pre-publish there's no
      // shareable URL anyway, so the control stays hidden and the dialog
      // never opens.
      enabled: !!ownerId && eventStatus === "PUBLISHED" && !!eventPublicSlug,
      staleTime: 60_000,
    },
  );
  const shareableCount = useMemo(() => {
    const items = sharePromosQuery.data?.items ?? [];
    return items.filter((p) => {
      if (!p.isPublic || p.status !== "ACTIVE") return false;
      switch (p.scope) {
        case "ORG":
          return ownerType === "org" && p.scopeId === ownerId;
        case "EVENT":
          return p.scopeId === eventId;
        case "TICKET_TYPE":
          // Conservative: count it as applicable; server re-validates at
          // checkout. The user will see the actual list inside the dialog.
          return true;
        case "GLOBAL":
        default:
          return false;
      }
    }).length;
  }, [sharePromosQuery.data, ownerType, ownerId, eventId]);

  // No "View event" in the header row: the admin rail's event context header
  // carries the link to the live page for every ops surface (2026-08-30).
  // The builder repeats it twice, deliberately: the `⋯` item below, and the
  // Public link field at the top of the body (owner's pick, 2026-09-30 —
  // the link should be visible where the event is edited).
  const showShare =
    !isCommunity &&
    eventStatus === "PUBLISHED" &&
    Boolean(eventPublicSlug) &&
    shareableCount > 0;
  // Gates the `⋯` menu's "Open live draft" only (2026-08-30): the labelled
  // Preview button this used to render was a second activation path for the
  // Edit|Preview toggle. Editors only, pre-publish only — once live, the
  // rail's View event covers the same destination — and gated on the edit
  // payload so the item doesn't appear before status is known.
  const showPreview =
    canEdit && Boolean(eventForEditQuery.data) && eventStatus !== "PUBLISHED";
  // The published-event counterpart to `showPreview`. Publishing used to
  // REMOVE the only `⋯` item that opened the live page (showPreview turns off
  // at exactly that moment), leaving the rail as the sole route. Not
  // role-gated: a published event's page is public, so withholding the link
  // from a VIEWER or SCANNER would protect nothing — the same reasoning the
  // rail's own gate already applies (`event-rail-context.tsx`). Also needs
  // `publicLink`: a slugless event has no page.
  const showViewEvent = eventStatus === "PUBLISHED" && publicLink !== null;
  const showPublish =
    canEdit && eventStatus === "DRAFT" && !blockedByStripeConnect;
  // Unpublish / Cancel event / Regenerate slug: each mirrors the use case
  // that would refuse it — see `builder-admin-action-gates.ts` for why.
  // Whether the viewer is a platform ADMIN: the one role `cancelEvent`
  // admits on an ownerless community listing. Asked only for a
  // listing (an owned event never needs it); `checkStaffAccess` answers
  // `allowed: false` rather than throwing for a non-staff viewer.
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    enabled: isCommunity,
    retry: false,
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });
  const isPlatformAdmin =
    staffAccessQuery.data?.allowed === true &&
    // The server refuses staff without an enrolled second factor, so the item
    // is not offered to them (it would be a button that fails).
    staffAccessQuery.data.secondFactorEnrolled === true &&
    staffAccessQuery.data.roles.includes("ADMIN");
  const {
    showUnpublish,
    showCancel,
    showTakeDownListing,
    canRegenerateSlug,
  } = builderAdminActionGates({
    canEdit,
    canManageEvent,
    // "Known to be owned", not "not yet known to be community": while the
    // edit payload is in flight nothing admin-level is offered.
    isCommunity: !isOwnedEvent,
    isPlatformAdmin: isCommunity && isPlatformAdmin,
    eventStatus,
  });
  const showSave = canEdit;

  // ── Cancel event ──────────────────────────────────────────────────────────

  const cancelEventMutation = trpc.events.cancelEvent.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.events.getEventForEdit.invalidate({ eventId });
      void utils.events.getGateState.invalidate({ eventId });
    },
  });

  // Unpublish ≠ cancel: reverts PUBLISHED → DRAFT without refunding
  // anyone. The use case refuses if any successful orders exist (in which
  // case the organizer must use cancel instead, which actually refunds).
  const unpublishEventMutation = trpc.events.unpublishEvent.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      void utils.events.getEventForEdit.invalidate({ eventId });
      void utils.events.getGateState.invalidate({ eventId });
    },
  });
  const handleUnpublish = useCallback(async () => {
    try {
      await unpublishEventMutation.mutateAsync({ eventId });
      toast.success({
        id: "event-unpublished",
        title: t("admin.ebEventUnpublishedTitle") as string,
        message: t("admin.ebEventUnpublishedMessage") as string,
      });
    } catch (error) {
      reportError(error, t("admin.ebUnpublishFailedTitle") as string);
    }
  }, [eventId, unpublishEventMutation, reportError, t, toast]);
  /**
   * The `⋯` item's press handler — fire-and-forget over the async above.
   * `useStableHandler`, not `useCallback`: `handleUnpublish` depends on the
   * mutation result, which react-query recreates every render, so a
   * `useCallback` here would hand the memoized header a new prop identity on
   * every keystroke of a published event.
   */
  const handleUnpublishPress = useStableHandler(() => {
    void handleUnpublish();
  });

  // Two pre-rendered nodes: `BuilderHeaderBar` is memo'd and re-renders on
  // every title keystroke, so handing it whole nodes (and stable handlers)
  // is what lets that bail-out happen. Note nothing pins the bail-out:
  // EventBuilderRenderIsolation.test.tsx mocks the header to null and pins
  // the section components' memoization, not this bar's.
  //
  // They are split because the header ranks them differently (2026-09-15,
  // "one quiet row"): `secondaryActions` is Share alone, a ghost — reversible,
  // and the only labelled control on the row that neither commits nor
  // toggles; `headerActions` is the commit pair, and carries the row's only
  // fill. Unpublish is a `⋯` item now (`onUnpublish` below): a published
  // event was putting eight framed controls on one row.
  //
  // Gone from both: the labelled "Preview" button, which called the SAME
  // handler as the Edit|Preview toggle two controls to its right, and the
  // icon-only new-tab preview, now a labelled item in the `⋯` menu.
  const secondaryActions = useMemo(() => {
    if (!showShare) return null;
    return (
      <Button
        variant="ghost"
        size="$3"
        data-testid="event-share-btn"
        onPress={() => setShareOpen(true)}
      >
        <Share2 size={16} aria-hidden />
        {String(t("pageActions.shareEvent"))}
      </Button>
    );
  }, [showShare, t]);

  /**
   * The in-flight signal for whichever publish procedure this event uses —
   * the two mutations are separate objects, so reading only the owned one
   * would leave the community Publish button live through its own round trip.
   */
  const publishPending = isCommunity
    ? publishCommunityListing.isPending
    : publishMutation.isPending;

  const headerActions = useMemo(() => {
    if (!showSave && !showPublish) return null;
    // Mobile: the commit pair splits its own header row equally and never
    // stacks (measured: a wrapping row put Save and Publish on separate
    // lines at 320px). Desktop buttons stay content-sized.
    const commitButtonLayout = isMobile
      ? ({ flex: 1, minWidth: 0 } as const)
      : undefined;
    return (
      // Desktop: content-sized, shrinkable. Mobile: takes the rest of its
      // row so the `flex: 1` buttons inside have a width to split.
      <XStack
        alignItems="center"
        gap="$2"
        flexShrink={1}
        minWidth={0}
        {...(isMobile ? { flex: 1 } : { flexWrap: "wrap" as const })}
      >
        {showSave ? (
          // Mounted for as long as Save is, so a screen reader hears the text
          // appear. Visible beside Save on desktop only: the mobile row
          // already splits its width between Save and Publish and wraps at
          // 320px, so there the dot on Save carries it. Out of flow while
          // empty, so it adds no gap to the row.
          <span
            id={unsavedStatusId}
            role="status"
            data-testid="event-unsaved-status"
            style={hasUnsaved && !isMobile ? undefined : VISUALLY_HIDDEN}
          >
            {hasUnsaved ? (
              <Text variant="caption" tone="muted">
                {String(t("admin.ebUnsavedChanges"))}
              </Text>
            ) : null}
          </span>
        ) : null}
        {showSave ? (
          <Button
            // Secondary only while Publish is on the row to carry the fill.
            // On a published event Save is the one thing that commits, so it
            // takes the primary back rather than leaving the row with no
            // weight.
            variant={showPublish ? "secondary" : "primary"}
            size="$3"
            data-testid="event-save-btn"
            // Name stays "Save"; the status region describes it while dirty
            // (on mobile the dot is the only visible sign).
            aria-describedby={hasUnsaved ? unsavedStatusId : undefined}
            disabled={isSaving}
            {...commitButtonLayout}
            onPress={() => {
              requestSave();
            }}
          >
            <StableActionLabel
              // Mobile: the dot beside the label stands in for the caption.
              icon={
                isMobile && hasUnsaved ? (
                  <span
                    aria-hidden
                    data-testid="event-unsaved-dot"
                    style={{
                      display: "block",
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      background: "currentColor",
                    }}
                  />
                ) : undefined
              }
              idle={String(t("pageActions.save"))}
              busy={String(t("pageActions.saving"))}
              pending={isSaving}
            />
          </Button>
        ) : null}
        {showPublish ? (
          // The one irreversible, audience-facing action on a draft — it gets
          // the fill. It used to look exactly like Close.
          <Button
            variant="primary"
            size="$3"
            data-testid="event-publish-btn"
            disabled={publishPending}
            {...commitButtonLayout}
            aria-describedby={publishBlockersId}
            onPress={() => {
              // Community listings go live through
              // `community.publishListing`: `publishEvent` requires an owner,
              // ticket types and payout terms, none of which an ownerless
              // listing has.
              void (isCommunity ? handleCommunityPublish() : handlePublish());
            }}
          >
            <StableActionLabel
              // Through the prop, not as a sibling: the reserved cell must
              // cover icon + label as one unit or the visible label centres
              // alone and drifts away from the icon.
              icon={<Send size={16} aria-hidden />}
              idle={String(t("pageActions.publishEvent"))}
              busy={String(t("pageActions.publishing"))}
              pending={publishPending}
            />
          </Button>
        ) : null}
      </XStack>
    );
  }, [
    isMobile,
    showSave,
    showPublish,
    publishPending,
    publishBlockersId,
    isSaving,
    isCommunity,
    handlePublish,
    handleCommunityPublish,
    requestSave,
    hasUnsaved,
    unsavedStatusId,
    t,
  ]);

  /**
   * The `⋯` menu's "Open preview in a new tab" (pre-publish): this builder's
   * own edit route deep-linked into the in-builder preview (`?view=preview`,
   * the edit page's `initialViewMode`). It reads through `getEventForEdit`
   * with the editor's session, so a draft renders — the public page cannot
   * (see `publicLink`). Like the old link, the new tab shows SAVED state;
   * the in-view toggle is the live-edits preview.
   *
   * Stable so `BuilderHeaderBar`'s memo survives a title keystroke.
   */
  const handleOpenPreviewTab = useCallback(() => {
    const href = slug
      ? `/admin/${slug}/events/${eventId}/edit?view=preview`
      : `${window.location.pathname}?view=preview`;
    window.open(href, "_blank", "noopener,noreferrer");
  }, [slug, eventId]);

  /**
   * The `⋯` menu's "View event" (and the read-only Cmd/Ctrl+Shift+P): the
   * canonical public page, built segment-wise by `eventPublicPath`
   * (multi-segment slugs). Does nothing without a `publicLink`. The Public
   * link field renders its own `<a>` to the same path.
   */
  const publicCanonicalPath = publicLink?.canonicalPath ?? null;
  const handleViewEvent = useCallback(() => {
    if (!publicCanonicalPath) return;
    window.open(publicCanonicalPath, "_blank", "noopener,noreferrer");
  }, [publicCanonicalPath]);

  /**
   * The `⋯` menu's "Copy link" — the event's absolute public URL.
   *
   * Offered ONLY while a stranger could open the link (`publicLink`, see the
   * gate at the call site). A draft's link 404s, and a slugless event has no
   * page at all (its old `/events/<uuid>` fallback 500'd) — handing either to
   * a host to paste into a group chat is worse than not offering the item.
   *
   * `copyText` is the guarded write: in a non-secure context (the dev stack
   * over a LAN IP, an embedded webview) `navigator.clipboard` is `undefined`,
   * so calling `writeText` on it throws synchronously rather than rejecting —
   * a bare `.then(ok, fail)` would never reach its failure branch.
   *
   * Neither toast carries the URL. An event slug runs to ~120 unbroken
   * characters; as a toast body it does not wrap, so it painted as a tall
   * empty box (verified on a seeded event at 1440px). Every other copy site
   * here — `PlaceHeroActions`, `EntityHeroActions` — is title-only too.
   *
   * Copies the SHORT link (`/e/<shortId>`) when the event has one, the
   * canonical page otherwise (`publicLink.sharePath`). The Public link field's
   * Copy button calls this same handler, so both copy the same URL.
   */
  const publicSharePath = publicLink?.sharePath ?? null;
  const handleCopyEventLink = useCallback(() => {
    if (!publicSharePath) return;
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}${publicSharePath}`
        : publicSharePath;
    void copyText(url).then((copied) => {
      if (copied) {
        toast.success({
          id: "event-link-copied",
          title: t("eventDetail.shareLinkCopied") as string,
        });
        return;
      }
      // Names the FAILURE — a toast titled "Copy link" read as a confirmation
      // in a slightly different colour.
      toast.danger({
        id: "event-link-copy-failed",
        title: t("places.shareCopyFailedToast") as string,
      });
    });
  }, [publicSharePath, toast, t]);

  const [isCancelling, setIsCancelling] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const handleCancelEvent = useCallback(async () => {
    setIsCancelling(true);
    setShowCancelConfirm(false);
    try {
      const result = await cancelEventMutation.mutateAsync({
        eventId,
        clientKey: nanoid(12),
      });
      // The cancellation, then one toast per thing still needing a person:
      // failed card refunds, door cash to hand back, cash sales not yet
      // marked refunded, door card sales that could not be cancelled.
      for (const { tone, ...options } of cancelEventResultToasts(result, t)) {
        toast[tone](options);
      }
    } catch (error) {
      reportError(error, t("admin.ebCancelFailedTitle") as string);
    } finally {
      setIsCancelling(false);
    }
  }, [cancelEventMutation, eventId, reportError, t, toast]);

  // Take down listing (community, platform ADMIN): `cancelEvent` — every
  // remaining night off, savers and RSVPers told once. `isCancelling` doubles
  // as the busy flag.
  const [showTakeDownConfirm, setShowTakeDownConfirm] = useState(false);
  const closeTakeDownConfirm = useCallback(
    () => setShowTakeDownConfirm(false),
    [],
  );
  const handleRequestTakeDownListing = useCallback(
    () => setShowTakeDownConfirm(true),
    [],
  );

  // A take-down failure: the 2FA prompt first, then — when the listing moved
  // under us (already cancelled elsewhere) — a refetch so the menu stops
  // offering what no longer applies, then the toast.
  const reportTakedownError = useCallback(
    async (error: unknown, titleKey: string) => {
      if (handleSecondFactorRequired(error)) return;
      const code = getAppErrorCode(error);
      if (
        code === "EVENT_ALREADY_CANCELLED" ||
        code === "EVENT_NOT_CANCELLABLE"
      ) {
        await utils.events.getEventForEdit.invalidate({ eventId });
      }
      reportError(error, t(titleKey) as string);
    },
    [handleSecondFactorRequired, utils.events.getEventForEdit, eventId, reportError, t],
  );

  const handleTakeDownListing = useCallback(async () => {
    setIsCancelling(true);
    setShowTakeDownConfirm(false);
    try {
      await cancelEventMutation.mutateAsync({
        eventId,
        clientKey: nanoid(12),
      });
      // Settle the refetch before the busy flag clears, so the menu never
      // flashes the old status's item.
      await utils.events.getEventForEdit.invalidate({ eventId });
      toast.success({
        id: "listing-taken-down",
        title: t("admin.ebListingTakenDownTitle") as string,
      });
    } catch (error) {
      await reportTakedownError(error, "admin.ebTakeDownFailedTitle");
    } finally {
      setIsCancelling(false);
    }
  }, [
    cancelEventMutation,
    eventId,
    reportTakedownError,
    t,
    toast,
    utils.events.getEventForEdit,
  ]);

  // ── Reconcile confirmation: second pass with confirmed IDs ─────────────
  const handleReconcileConfirm = useCallback(async () => {
    const params = reconcileParamsRef.current;
    if (!params) return;

    setShowReconcileConfirm(false);
    setIsSaving(true);

    try {
      const confirmedIds = reconcilePending.map((p) => p.occurrenceId);
      const result = await reconcileSeries.mutateAsync({
        seriesId: params.seriesId,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        confirmedCancellations: confirmedIds,
        clientKey: nanoid(12),
      });

      await completeSeriesFlow(
        params.mode,
        params.seriesId,
        params.eventId,
        result,
      );

      // Resume the scoped draft propagation ("This and following" / "All
      // shows") that this confirmation interrupted — no-ops unless the
      // interrupted save stashed a scope (convert-mode saves never do; the
      // scope dialog only shows for events already in a series).
      await runScopedDraftSync(params.seriesId, params.eventId);
    } catch (error) {
      if (params.mode === "convert") {
        // The series was already created — treat a failed confirmed pass as
        // partial success: saving again re-runs reconcile + generate. Refresh
        // the edit payload so that re-save takes the update branch instead of
        // re-firing convert (EVENT_ALREADY_IN_SERIES). (No consumer wires
        // `onSave` today, so the user stays on the form.)
        void utils.events.getEventForEdit.invalidate({
          eventId: params.eventId,
        });
        toast.warning({
          id: "series-convert-partial",
          title: t("admin.ebSeriesConvertPartialTitle") as string,
          message: t("admin.ebSeriesConvertPartialMessage", {
            reason: formatErrorMessage(error, t),
          }) as string,
        });
        onSave?.(params.eventId);
      } else {
        // Update mode: the event's own edits already saved before the series
        // flow started (post-reorder), so a failed second reconcile pass is
        // partial success — warn like the first-pass catch, don't claim the
        // save failed. Saving again re-runs the series flow (and the scoped
        // propagation, if re-chosen).
        toast.warning({
          id: "series-update-partial",
          title: t("admin.ebSeriesUpdatePartialTitle") as string,
          message: t("admin.ebSeriesUpdatePartialMessage", {
            reason: formatErrorMessage(error, t),
          }) as string,
        });
      }
    } finally {
      setIsSaving(false);
      setReconcilePending([]);
      reconcileParamsRef.current = null;
      // Consumed on the success path; cleared here so a failed second pass
      // can't leak a stale propagation choice into a later flow.
      pendingSyncScopeRef.current = null;
      pendingSyncIncludeAreasRef.current = false;
    }
  }, [
    reconcilePending,
    reconcileSeries,
    completeSeriesFlow,
    runScopedDraftSync,
    onSave,
    toast,
    t,
    utils.events.getEventForEdit,
  ]);

  const handleReconcileDismiss = useCallback(() => {
    setShowReconcileConfirm(false);
    setReconcilePending([]);
    reconcileParamsRef.current = null;
    // Abandoning the reconcile abandons the propagation stashed by the same
    // save — the event's own edits are already saved.
    pendingSyncScopeRef.current = null;
    pendingSyncIncludeAreasRef.current = false;
    setIsSaving(false);
  }, []);

  // Stable-identity bridges for the memoized dialogs. The underlying async
  // handlers depend on tRPC mutation objects (fresh identity every render), so
  // passing them straight through would defeat the dialogs' React.memo.
  const submitHostAttestation = useStableHandler(() => {
    void handleSubmitHostAttestation();
  });
  const acceptChargebackTerms = useStableHandler(() => {
    void handleAcceptChargebackTerms();
  });
  const confirmReconcile = useStableHandler(() => {
    void handleReconcileConfirm();
  });
  const handleRequestCancelEvent = useCallback(
    () => setShowCancelConfirm(true),
    [],
  );

  const isValid = Boolean(
    title && startsAt && endsAt && (!recurrenceEnabled || recurrenceConfig),
  );

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + S  → Save (routes through the series scope gate)
      if (mod && e.key === "s") {
        e.preventDefault();
        if (isValid && !isSaving) {
          requestSave();
        }
        return;
      }

      // Cmd/Ctrl + Shift + P  → toggle the in-view preview (D4 reversed).
      // Read-only viewers already ARE the preview, so for them it opens the
      // public page — only when there is one (published, with a slug); a
      // draft's public URL renders for nobody (see `publicLink`).
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (canEditEvent) {
          handleViewModeChange(viewMode === "preview" ? "edit" : "preview");
        } else if (showViewEvent) {
          handleViewEvent();
        }
        return;
      }

      // Escape  → leave preview first; otherwise Cancel / go back.
      if (e.key === "Escape") {
        // Any open overlay (seating takeover, publish/terms/attestation
        // dialogs, share sheet, form builder…) owns Escape. Window keydown
        // listeners fire in REGISTRATION order, so this handler can run
        // before a just-opened Modal's stopImmediatePropagation — checking
        // the DOM for an open dialog avoids racing it (and avoids keeping a
        // dep list of every overlay flag in sync).
        //
        //
        // NOT `[role="menu"]`: `ShareDropdown` and `CalendarDropdown` render
        // `role="menu"` unconditionally (hidden with CSS), and the in-place
        // preview mounts both — a menu selector here shielded Escape on every
        // preview and, for read-only roles, on every load. The header's `⋯`
        // stops Escape's propagation at `document` when it consumes the key
        // (RowActionMenu), so this window listener never sees that keystroke
        // and unsaved edits survive it.
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
          return;
        }
        if (canEditEvent && viewMode === "preview") {
          e.preventDefault();
          handleViewModeChange("edit");
          return;
        }
        if (onCancel) {
          e.preventDefault();
          // Through the unsaved-changes guard: leaving drops the edits.
          requestNavigation(onCancel);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    isValid,
    isSaving,
    requestSave,
    onCancel,
    requestNavigation,
    showViewEvent,
    handleViewEvent,
    canEditEvent,
    viewMode,
    handleViewModeChange,
  ]);

  useEffect(() => {
    const element = stickyTopBarRef.current;
    if (!element) return;

    const updateStickyTopOffset = () => {
      setStickyTopOffset(element.getBoundingClientRect().height);
    };

    updateStickyTopOffset();

    const resizeObserver = new ResizeObserver(() => {
      updateStickyTopOffset();
    });

    resizeObserver.observe(element);
    window.addEventListener("resize", updateStickyTopOffset);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateStickyTopOffset);
    };
  }, []);

  // ── Inline styles that depend on state ─────────────────────────────────
  // Memoized so a keystroke doesn't mint fresh style objects for the section
  // anchors, the two-column grid, or the sticky rail.
  // `outline: none` stays: every consumer is a `tabIndex={-1}` scroll anchor
  // that takes focus after a jump, so the system ring would fire on a target
  // the user never tabbed to.
  const anchorStyle = useMemo<CSSProperties>(
    () => ({ scrollMarginTop: stickyTopOffset + 8, outline: "none" }),
    [stickyTopOffset],
  );
  const railStyle = useMemo<CSSProperties>(
    () => ({
      position: "sticky",
      top: stickyTopOffset + 16,
      marginTop: 16,
      maxHeight: `calc(100vh - ${stickyTopOffset + 32}px)`,
      overflowY: "auto",
    }),
    [stickyTopOffset],
  );
  const editLayoutStyle = useMemo<CSSProperties>(
    () => ({
      ...(showDesktopReadinessRail ? GRID_LAYOUT_STYLE : {}),
      ...(isPreviewMode ? HIDDEN_STYLE : {}),
    }),
    [showDesktopReadinessRail, isPreviewMode],
  );
  const paymentsHref = `/admin/${slug}/payouts`;
  const mutedIconColor = theme.colorMuted?.val;

  return (
    <Container>
      <BuilderHeaderBar
        stickyBarRef={stickyTopBarRef}
        slug={slug}
        title={title}
        eventStatus={eventStatus}
        canEditEvent={canEdit}
        eventLoaded={Boolean(eventForEditQuery.data)}
        isPreviewMode={isPreviewMode}
        onViewModeChange={handleViewModeChange}
        isMobile={isMobile}
        isCancelling={isCancelling}
        // Only when the gate passes: an absent handler removes the `⋯` item,
        // so the menu never offers an Unpublish that the server would refuse.
        onUnpublish={showUnpublish ? handleUnpublishPress : undefined}
        // Admin bar, not edit; never on a community listing (moderation
        // side). See `builder-admin-action-gates.ts`.
        onRequestCancelEvent={
          showCancel ? handleRequestCancelEvent : undefined
        }
        // Community take-down, platform ADMIN only, DRAFT or PUBLISHED.
        onRequestTakeDownListing={
          showTakeDownListing ? handleRequestTakeDownListing : undefined
        }
        actions={headerActions}
        secondaryActions={secondaryActions}
        onOpenLiveDraft={showPreview ? handleOpenPreviewTab : undefined}
        onViewEvent={showViewEvent ? handleViewEvent : undefined}
        // Offered exactly when the Public link field shows (`publicLink`):
        // the link must open for a stranger. This was slug-gated (plus
        // PUBLISHED for community listings), but EVERY draft has a slug now —
        // `assign-slug-on-create` mints slug + short ID at creation — so an
        // owned draft (or an unpublished event) offered a link that 404s.
        // The shared rule also lets a CANCELLED / COMPLETED community listing
        // that was live copy its link, which does resolve.
        onCopyEventLink={publicLink ? handleCopyEventLink : undefined}
      />

      {formError && (
        <YStack paddingHorizontal={32} paddingTop={16}>
          <FormErrorBanner
            message={formError}
            onDismiss={clearErrors}
            testId="event-builder-error"
          />
        </YStack>
      )}

      {/* The Build surface (FR-207: no tab chrome — the contextual admin
          rail owns navigation between event surfaces). */}
      <YStack width="100%">
        {(() => {
          // Shared in-place preview of the CURRENT in-memory form state:
          // read-only roles get it as the whole surface (FR-204), editors get
          // it via the Edit|Preview toggle (D4 reversed) — unsaved edits
          // preview live either way.
          const previewSurface = (
            <EventPreview
              title={title}
              startsAt={getPreviewDateTimeIso(startsAt, eventTimezone)}
              endsAt={getPreviewDateTimeIso(endsAt, eventTimezone)}
              // Community reads the toggle's location: a listing switched to
              // Address no longer shows the venue it is leaving.
              location={
                (isCommunity ? communityLocation : location).thPlaceName ??
                location.addressText
              }
              heroImageUrl={heroImageUrl}
              bodyContent={bodyContent}
              imageUrlMap={imageUrlMap}
              audioUrlMap={audioUrlMap}
              eventId={eventId}
              // The public page renders a COMMUNITY listing in its own layout
              // (stub head, WHERE/ENDS/LISTED BY fact rail, sticky two-track).
              // Without this the preview would show the ticketed shape and be
              // a lie about the page being authored.
              communityLayout={isCommunity}
              // Tri-state: `communityLayout` is false while the edit read is
              // in flight, so the preview must be told to ask nothing yet.
              stewardshipPending={!stewardshipKnown}
              currency={eventForEditQuery.data?.currency ?? undefined}
              addressText={location.addressText}
              // The structured half of the location. The community head prints
              // a short `locality, region` line and the fact rail prints the
              // full street address; feeding both from the single `location`
              // string made them identical on a quick-created listing, whose
              // geocode lands whole in `addressText`.
              venueName={
                (isCommunity ? communityLocation : location).thPlaceName
              }
              locality={location.locality}
              region={location.region}
              postalCode={location.postalCode}
              countryCode={location.countryCode}
              timezone={eventTimezone}
              locationCoords={
                location.lat != null && location.lng != null
                  ? {
                      latitude: location.lat,
                      longitude: location.lng,
                      isExact: visibilityMode === "EXACT",
                      radiusMeters:
                        visibilityMode === "OBSCURED"
                          ? (visibilityRadius ?? undefined)
                          : undefined,
                      areaLabel:
                        visibilityMode !== "EXACT" && visibilityLabel.trim()
                          ? visibilityLabel.trim()
                          : undefined,
                    }
                  : undefined
              }
            />
          );

          if (!canEdit) {
            // Two ways in:
            //  - read-only ROLES (FINANCE / VIEWER / SCANNER): the preview IS
            //    the surface — no toggle chrome. Attendees / volunteers stay
            //    reachable at their sibling routes.
            //  - a COMMUNITY listing in an end state (CANCELLED / COMPLETED /
            //    ARCHIVED): `community.updateListing` refuses those, so there
            //    is nothing here that could be saved. The notice above the
            //    preview names the state. A PUBLISHED listing no longer lands
            //    here — it gets the real form, plus the live band below.
            return (
              <>
                {communityLocked && (
                  <CommunityLockedNotice status={communityLocked} />
                )}
                {previewSurface}
              </>
            );
          }

          return (
            <>
              {/* Above BOTH the preview and the form, directly under the
                  sticky bar: it is a property of the whole surface, not of
                  one column, and the Save it is about lives in that bar. */}
              {communityLive && <CommunityLiveEditNotice />}
              {isPreviewMode && (
                <div data-testid="event-preview-surface">{previewSurface}</div>
              )}
              {/* Two-column desktop layout (FR-104): main authoring column +
            ~296px sticky readiness rail. Grid because the columns must align
            (skeleton), asymmetric fr per the DS grid rules. On mobile (or
            when the rail is ineligible) the same elements render single-
            column with no grid styles — element identity is stable across
            the breakpoint so form state never remounts. While the in-place
            preview is shown, this whole layout (form + readiness rail —
            edit chrome) stays MOUNTED but display:none, so form and child
            editor state survive toggling. */}
              <div style={editLayoutStyle} data-testid="event-edit-layout">
                <div style={MAIN_COLUMN_STYLE}>
                  {/* ── Public link ──────────────────────────────────────────
                      The event's shareable URL, first in the column so it is
                      visible without opening Settings → Sharing. Renders
                      nothing unless a stranger could open it (never for a
                      draft). Inside the edit layout: the preview is the
                      public page itself, and read-only roles see only that. */}
                  <EventPublicLinkField
                    status={eventStatus}
                    publishedAt={eventPublishedAt}
                    slug={eventPublicSlug}
                    shortId={eventShortId}
                    onCopy={handleCopyEventLink}
                  />
                  {/* ── Where this event came from ───────────────────────────
                      Renders NOTHING unless this event was booked through a
                      request (the uncommon case), so ordinary events open on
                      Essentials exactly as before — no wrapper, no gap. At the
                      top of the authoring column (under the Public link)
                      because it is the event's history, not one of its fields; it sits inside the edit
                      layout so it stays out of the public-facing preview and
                      out of the read-only surface (whose viewers cannot read
                      the provenance procedure anyway). The component owns its
                      own FormSection gutter, so returning null removes the
                      padded box too rather than leaving a blank band. */}
                  {/* `getEventProvenance` refuses a COMMUNITY listing (an
                      ownerless row has no booking behind it), so the note is
                      not even mounted there — and not before stewardship is
                      known either, or it mounts for one tick and asks. */}
                  {isOwnedEvent && (
                    <EventProvenanceNote
                      eventId={eventId}
                      bookingRequest={savedBookingRequest}
                    />
                  )}

                  {/* ── Essential fields (always visible) ────────────────────── */}
                  <div
                    ref={essentialsSectionRef}
                    tabIndex={-1}
                    style={anchorStyle}
                  >
                    <BuilderEssentialsSection
                      eventId={eventId}
                      ownerType={ownerType}
                      ownerId={ownerId}
                      slug={slug}
                      heroImageUrl={heroImageUrl}
                      onHeroImageSelected={handleHeroImageSelected}
                      onHeroImageRemoved={handleHeroImageRemoved}
                      title={title}
                      onTitleChange={handleTitleChange}
                      titleHasError={Boolean(fieldErrors.title)}
                      startsAt={startsAt}
                      endsAt={endsAt}
                      onStartDateChange={handleStartDateChange}
                      onEndDateChange={handleEndDateChange}
                      eventTimezone={eventTimezone}
                      timezoneAdoptedFrom={timezoneAdoptedFrom}
                      location={location}
                      locationSearch={locationSearch}
                      locationMode={locationMode}
                      selectedPlace={selectedPlace}
                      visibilityMode={visibilityMode}
                      visibilityRadius={visibilityRadius}
                      hasSavedLocation={!!savedLocationRef.current}
                      onLocationChange={setLocation}
                      onLocationSearchChange={setLocationSearch}
                      onLocationModeChange={handleBuilderLocationModeChange}
                      onPlaceSelect={handlePlaceSelect}
                      onResetLocation={handleResetLocation}
                      placement={placement}
                      placementSource={placementSource}
                      placementIntentPending={placementIntentPending}
                      onPlacementChange={handlePlacementChange}
                      bookingSkip={visibleBookingSkip}
                      placeArchivedName={placeArchivedName}
                      onHideAddressLink={handleHideAddressLink}
                      communityMode={isCommunity}
                      communityCategoryId={communityCategoryId}
                      onCommunityCategoryChange={setCommunityCategoryId}
                    />
                  </div>

                  {/* ── Event Details (prose body — always visible) ──────────── */}
                  <SectionDivider />

                  <div
                    ref={detailsSectionRef}
                    tabIndex={-1}
                    style={anchorStyle}
                  >
                    <BuilderDetailsSection
                      hasLoadedExisting={hasLoadedExisting}
                      bodyContent={bodyContent}
                      onBodyChange={handleBodyChange}
                      stickyTopOffset={stickyTopOffset}
                      onImageUpload={handleProseImageUpload}
                      imageUrlMap={imageUrlMap}
                      isUploading={isUploading}
                      onAudioUpload={handleProseAudioUpload}
                      audioUrlMap={audioUrlMap}
                      isUploadingAudio={isUploadingAudio}
                      onReady={handleEditorReady}
                      startersReady={
                        baselineFields !== null && !startersCategoryPending
                      }
                      suggestedStarter={suggestedStarter}
                    />
                  </div>

                  {/* ── Owned-event surfaces ─────────────────────────────
              Tickets + seating, Lineup, Revenue splits and the Settings
              accordion (scheduling · access gate · tax/waiver/payout ·
              sharing) all presume an owning org with a payee, and every one
              of their writes refuses an ownerless row server-side. A
              COMMUNITY listing renders none of them — Essentials, Details and
              the live Preview are the whole surface.

              Recurrence is inside Settings and goes with it: community
              listings repeat through `EventDate` rows + `recurrenceSchedule`
              (`community.updateRecurrence`), NOT through `EventSeries`, and
              the edit payload carries no `recurrenceSchedule` to hydrate the
              builder's RRULE editor from. The cadence is set at create; see
              the follow-up note.

              LINEUP IS THE EXCEPTION (2026-09-15). `eventHumans.*` was opened
              to community moderators, so a listing can name who is playing —
              it renders below, OUTSIDE this gate, in a community variant that
              drops the payout-shaped affordances (referral links, "invite to
              set up payouts") an ownerless row still cannot use. */}
                  {isOwnedEvent && (
                    <>
                  {/* ── Ticket Types (always visible since ticketing is core)
              The chargeback-terms + Stripe-Connect banners that used to
              interject here were replaced by the publish-readiness rail
              (FR-104/FR-105) — same conditions, same deep-links. */}
                  <SectionDivider />
                  <div
                    ref={ticketsSectionRef}
                    tabIndex={-1}
                    style={anchorStyle}
                  >
                    <MemoTicketTypeEditor
                      eventId={eventId}
                      disabled={(eventForEditQuery.data?.ticketsSold ?? 0) > 0}
                      templateOwner={templateOwner}
                      canCustomiseTemplates={canManageEvent}
                      eventTitle={deferredTitle}
                      hasSeatingLayout={Boolean(
                        eventForEditQuery.data?.placeLayoutId,
                      )}
                    />
                    {/* ── Seating map entry (FR-205/D3): the seating editor is a
                full-screen takeover launched from the Tickets card —
                only when the event has a place layout and the gate is
                on (same visibility the old Seating tab had). ─────── */}
                    {gates?.seatingLayouts &&
                      eventForEditQuery.data?.placeLayoutId && (
                        <BlocksSection paddingTop={0}>
                          <XStack>
                            <Button
                              variant="secondary"
                              onPress={() => setSeatingTakeoverOpen(true)}
                              data-testid="open-seating-takeover"
                            >
                              <LayoutGrid size={14} aria-hidden />
                              {String(t("admin.ebSeatingMap"))}
                            </Button>
                          </XStack>
                          {/* Seat prices: single seats' custom prices. Its own
                              page, so it stays open after tickets sell. */}
                          {slug ? (
                            <XStack marginTop="$2">
                              <Button
                                variant="secondary"
                                tag="a"
                                href={`/admin/${slug}/events/${eventId}/seat-prices`}
                                data-testid="open-seat-prices"
                              >
                                {String(t("admin.seatPricesTitle"))}
                              </Button>
                            </XStack>
                          ) : null}
                        </BlocksSection>
                      )}
                  </div>
                    </>
                  )}

                  {/* ── Lineup (promoted out of Advanced — FR-101) ────────────
              Rendered for an owned event AND for a community listing, but not
              until stewardship is known: the editor's referral-link read
              (`getPerformerShareLinks`) is owner-gated, and mounting it on a
              maybe-ownerless row is what fired it into a FORBIDDEN. */}
                  {stewardshipKnown && (
                    <>
                  <SectionDivider />
                  <div
                    ref={lineupSectionRef}
                    tabIndex={-1}
                    data-testid="advanced-section-lineup"
                    style={anchorStyle}
                  >
                    <MemoLineupEditor
                      eventId={eventId}
                      communityMode={isCommunity}
                    />
                  </div>
                    </>
                  )}

                  {isOwnedEvent && (
                    <>
                  {/* ── Revenue splits (promoted — FR-101/D1): expanded section
              once a lineup exists, collapsed disclosure otherwise. ──── */}
                  {!lineupCountSettled ? null : hasLineupEntries ? (
                    <>
                      <SectionDivider />
                      <div
                        ref={splitsSectionRef}
                        tabIndex={-1}
                        data-testid="advanced-section-splits"
                        style={anchorStyle}
                      >
                        {viewerCanManagePayouts ? (
                          <MemoSplitsEditor eventId={eventId} />
                        ) : (
                          <PayoutsOwnerOnlyNote />
                        )}
                      </div>
                    </>
                  ) : (
                    <div
                      ref={splitsSectionRef}
                      tabIndex={-1}
                      style={anchorStyle}
                    >
                      <SettingsGroupsStack>
                        <SettingsGroup
                          ref={splitsGroupRef}
                          label={String(t("admin.ebRevenueSplits"))}
                          icon={
                            <Gift
                              size={16}
                              color={mutedIconColor}
                              aria-hidden
                            />
                          }
                          testId="advanced-section-splits"
                        >
                          {viewerCanManagePayouts ? (
                          <MemoSplitsEditor eventId={eventId} />
                        ) : (
                          <PayoutsOwnerOnlyNote />
                        )}
                        </SettingsGroup>
                      </SettingsGroupsStack>
                    </div>
                  )}

                  {/* ── Mobile readiness summary (FR-104): compact disclosure near
              the Publish affordance in the header, rendered as the last
              block before the Settings groups. Desktop uses the sticky
              rail instead. ─────────────────────────────────────────── */}
                  {isMobile && readinessEligible && (
                    <>
                      <SectionDivider />
                      <BlocksSection data-testid="readiness-summary-block">
                        <MemoPublishReadinessRail
                          variant="summary"
                          readiness={readiness}
                          hideStripeItem={hideStripeItem}
                          paymentsHref={paymentsHref}
                          onJumpToSection={handleJumpToReadinessSection}
                          onOpenChargebackTerms={
                            handleOpenChargebackTermsStandalone
                          }
                          onOpenHostAttestation={
                            handleOpenHostAttestationDialog
                          }
                        />
                      </BlocksSection>
                    </>
                  )}

                  {/* ── Settings — four named groups (FR-102) ────────────────── */}
                  <SectionDivider />
                  <div
                    ref={settingsSectionRef}
                    tabIndex={-1}
                    style={anchorStyle}
                  >
                    <BuilderSettingsSections
                      eventId={eventId}
                      slug={slug}
                      ownerType={ownerType}
                      ownerId={ownerId}
                      stickyTopOffset={stickyTopOffset}
                      schedulingAnchorRef={schedulingAnchorRef}
                      schedulingGroupRef={schedulingGroupRef}
                      schedulingDefaultOpen={schedulingDefaultOpen}
                      recurrenceEnabled={recurrenceEnabled}
                      recurrenceConfig={recurrenceConfig}
                      onRecurrenceEnabledChange={setRecurrenceEnabled}
                      onRecurrenceConfigChange={setRecurrenceConfig}
                      startsAt={startsAt}
                      endsAt={endsAt}
                      onStartDateChange={handleStartDateChange}
                      eventTimezone={eventTimezone}
                      seriesId={existingSeriesId}
                      accessAnchorRef={accessAnchorRef}
                      accessGroupRef={accessGroupRef}
                      accessHeaderId={accessHeaderId}
                      gateVisibility={gateStateQuery.data?.visibility}
                      gateType={gateStateQuery.data?.gateType}
                      gatePasswordSet={gateStateQuery.data?.passwordSet}
                      gateWaitlistStatus={gateStateQuery.data?.waitlistStatus}
                      gateWaitlistDescription={
                        gateStateQuery.data?.waitlistDescription
                      }
                      gateWaitlistCap={gateStateQuery.data?.waitlistCap}
                      gateStateLoaded={gateStateQuery.isSuccess}
                      onOpenFormBuilder={handleOpenFormBuilder}
                      visibilityMode={visibilityMode}
                      visibilityRadius={visibilityRadius}
                      visibilityLabel={visibilityLabel}
                      addressRevealPreset={addressRevealPreset}
                      addressRevealAt={addressRevealAt}
                      venueCeiling={venueCeiling}
                      viewerManagesVenue={viewerManagesVenue}
                      placeArchivedName={placeArchivedName}
                      locationCountryCode={location.countryCode}
                      saving={isSaving}
                      revealCustomError={revealCustomError}
                      onVisibilityModeChange={setVisibilityMode}
                      onVisibilityRadiusChange={setVisibilityRadius}
                      onVisibilityLabelChange={setVisibilityLabel}
                      onAddressRevealPresetChange={
                        handleAddressRevealPresetChange
                      }
                      onAddressRevealAtChange={handleAddressRevealAtChange}
                      // Org-owned events only: `assignWaiverToEvent`
                      // (core/use-cases/waivers/assign-waiver-to-event.ts)
                      // refuses without an orgId, so on a person-owned event
                      // every pick would fail and roll back.
                      waiversEnabled={Boolean(gates?.waivers) && isOrgOwner}
                      waiverTemplateId={
                        eventForEditQuery.data?.waiverTemplateId ?? null
                      }
                      instructionalAdmission={Boolean(
                        eventForEditQuery.data?.instructionalAdmission,
                      )}
                      eventStateCode={
                        location.region ??
                        eventForEditQuery.data?.region ??
                        null
                      }
                      payoutsEnabled={payoutsEnabled}
                      payoutSchedule={
                        eventForEditQuery.data?.payoutSchedule ?? null
                      }
                      eventSlug={eventForEditQuery.data?.slug ?? null}
                      eventShortId={eventForEditQuery.data?.shortId ?? null}
                      eventStatus={eventStatus}
                      eventPublishedAt={eventPublishedAt}
                      canRegenerateSlug={canRegenerateSlug}
                      onCopyEventLink={handleCopyEventLink}
                    />
                  </div>
                    </>
                  )}
                </div>
                {/* ── Sticky readiness rail (FR-104, desktop only) ─────────── */}
                {showDesktopReadinessRail && (
                  <div style={railStyle}>
                    <MemoPublishReadinessRail
                      variant="rail"
                      readiness={readiness}
                      hideStripeItem={hideStripeItem}
                      paymentsHref={paymentsHref}
                      onJumpToSection={handleJumpToReadinessSection}
                      onOpenChargebackTerms={
                        handleOpenChargebackTermsStandalone
                      }
                      onOpenHostAttestation={handleOpenHostAttestationDialog}
                      listId={readinessBlockerListId}
                    />
                  </div>
                )}
              </div>
            </>
          );
        })()}
      </YStack>

      {/* ── Seating-layout takeover (FR-205/D3) ──────────────────────────
          Full-screen editor launched from the Tickets section (or the legacy
          `?tab=seating` deep link). Reuses the DS Modal (portal, Esc-to-close,
          body scroll lock, focus-in on open + focus-restore on close) with a
          viewport-filling panel. The editor keeps its own save flow —
          closing just exits (it exposes no dirty signal to confirm against).
          Editors only: section assignment is a mutation surface, so a
          read-only viewer following a stale deep link degrades to the plain
          preview instead. */}
      {canEdit &&
        gates?.seatingLayouts &&
        eventForEditQuery.data?.placeLayoutId && (
          <Modal
            open={seatingTakeoverOpen}
            onClose={() => setSeatingTakeoverOpen(false)}
          >
            <Modal.Panel
              width="100vw"
              height="100vh"
              maxWidth="100vw"
              maxHeight="100vh"
              borderWidth={0}
              data-testid="seating-takeover"
            >
              <Modal.Header
                title={String(t("admin.ebSeatingMap"))}
                onClose={() => setSeatingTakeoverOpen(false)}
              />
              <Modal.Body padding={0}>
                <SeatingLayoutEditor
                  eventId={eventId}
                  placeId={eventForEditQuery.data.placeId!}
                  placeLayoutId={eventForEditQuery.data.placeLayoutId}
                  currency={eventForEditQuery.data.currency ?? undefined}
                />
              </Modal.Body>
            </Modal.Panel>
          </Modal>
        )}

      {/* Application Form Builder Drawer. Not mounted for a community
          listing: applications are an owned-event gate type, and the only
          thing that opens this drawer (Settings · Access & privacy) is not
          rendered there. */}
      {!isCommunity && (
        <ApplicationFormBuilder
          eventId={eventId}
          open={formBuilderOpen}
          onClose={() => setFormBuilderOpen(false)}
          templateOwner={templateOwner}
        />
      )}

      {/* Cancel Event Confirmation Modal */}
      <Modal
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
      >
        <Modal.Panel width={440}>
          <Modal.Header
            title={t("admin.ebCancelConfirmTitle") as string}
            onClose={() => setShowCancelConfirm(false)}
          />
          <Modal.Body>
            <Text variant="body">{String(t("admin.ebCancelConfirmBody"))}</Text>
            {eventStatus === "PUBLISHED" && (
              <Text variant="body" tone="muted">
                {String(t("admin.ebCancelConfirmRefundNote"))}
              </Text>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={() => setShowCancelConfirm(false)}>
              {String(t("admin.ebGoBack"))}
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                void handleCancelEvent();
              }}
              disabled={isCancelling}
              data-testid="event-cancel-confirm-btn"
            >
              {isCancelling
                ? String(t("admin.ebCancelling"))
                : String(t("admin.ebYesCancelEvent"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      {/* Take down listing Confirmation Modal (platform ADMIN). */}
      <Modal open={showTakeDownConfirm} onClose={closeTakeDownConfirm}>
        <Modal.Panel width={440}>
          <Modal.Header
            title={String(t("admin.ebTakeDownListingConfirmTitle"))}
            onClose={closeTakeDownConfirm}
          />
          <Modal.Body>
            <Text variant="body">
              {String(t("admin.ebTakeDownListingConfirmBody"))}
            </Text>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={closeTakeDownConfirm}>
              {String(t("admin.ebGoBack"))}
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                void handleTakeDownListing();
              }}
              disabled={isCancelling}
              data-testid="event-listing-takedown-confirm-btn"
            >
              {String(t("admin.ebYesTakeDownListing"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      {/* Live community listing: asked before a save that moves the schedule
          or the venue, and only then. */}
      <CommunityLiveSaveDialog
        open={liveSaveConfirmOpen}
        saving={isSaving}
        schedule={liveSaveChanges.schedule}
        venue={liveSaveChanges.venue}
        onCancel={handleLiveSaveCancel}
        onConfirm={() => {
          void handleLiveSaveConfirm();
        }}
      />

      {/* Leave-page confirm for an in-app link (or Escape) with unsaved
          edits, or for browser Back (see useUnsavedChangesGuard). Tab close
          and reload get the browser's own prompt. */}
      <Modal open={unsavedGuard.prompting} onClose={unsavedGuard.stay}>
        <Modal.Panel width={440} data-testid="event-unsaved-dialog">
          <Modal.Header
            title={String(t("admin.ebLeaveTitle"))}
            onClose={unsavedGuard.stay}
          />
          <Modal.Body>
            <Text style={{ fontSize: 14 }}>{String(t("admin.ebLeaveBody"))}</Text>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="outlined"
              size="$3"
              onPress={unsavedGuard.stay}
              data-testid="event-unsaved-stay"
            >
              {String(t("admin.ebLeaveStay"))}
            </Button>
            <Button
              variant="destructive"
              size="$3"
              onPress={unsavedGuard.leave}
              data-testid="event-unsaved-leave"
            >
              {String(t("admin.ebLeaveDiscard"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      {/* Series edit-scope dialog (Phase 3) — asked before saving an event
          that already belongs to a series. */}
      <SeriesEditScopeDialog
        open={scopeDialogOpen}
        dateLabel={scopeDateLabel}
        value={scopeChoice}
        saving={scopeSaving}
        onChange={setScopeChoice}
        arrivalAreasGateOn={gates?.arrivalAreas === true}
        includeArrivalAreas={scopeIncludeArrivalAreas}
        onIncludeArrivalAreasChange={setScopeIncludeArrivalAreas}
        onCancel={handleScopeCancel}
        onConfirm={() => {
          void handleScopeConfirm();
        }}
      />

      {/* Reconcile Series Confirmation Modal (events with sales will be detached) */}
      <BuilderReconcileDialog
        open={showReconcileConfirm}
        pending={reconcilePending}
        saving={isSaving}
        onConfirm={confirmReconcile}
        onDismiss={handleReconcileDismiss}
      />

      <HostAttestationDialog
        open={showHostAttestation}
        onClose={handleCloseHostAttestation}
        usesPrivateHostAttestation={usesPrivateHostAttestation}
        attestation={hostAttestation}
        missingFields={missingHostAttestationFields}
        allChecked={allHostAttestationChecked}
        submitting={isHostAttestationSubmitting}
        error={hostAttestationError}
        onFieldChange={handleHostAttestationChange}
        onStandardChange={handleStandardHostAttestationChange}
        onSubmit={submitHostAttestation}
      />

      <ChargebackTermsDialog
        open={showChargebackTerms}
        onClose={handleCloseChargebackTerms}
        mode={chargebackTermsMode}
        accepted={chargebackTermsAccepted}
        onAcceptedChange={handleChargebackTermsAcceptedChange}
        targetType={chargebackTermsTarget?.type ?? null}
        submitting={isChargebackTermsSubmitting}
        error={chargebackTermsError}
        onAccept={acceptChargebackTerms}
      />

      <QuotaExceededDialog
        open={quotaMeta !== null}
        onClose={() => setQuotaMeta(null)}
        meta={quotaMeta}
      />

      {shareOpen && eventId && (
        <ShareEventDialog
          open
          onClose={() => setShareOpen(false)}
          ownerContext={
            ownerType === "org"
              ? { kind: "org", orgId: ownerId }
              : { kind: "human", humanId: ownerId }
          }
          fixedEvent={{
            id: eventId,
            title: eventForEditQuery.data?.title ?? null,
            slug: eventPublicSlug,
            status: eventStatus,
          }}
        />
      )}
    </Container>
  );
}

export default EventBuilder;
