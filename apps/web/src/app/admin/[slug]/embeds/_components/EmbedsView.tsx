"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, styled } from "tamagui";
import {
  Text,
  CardSurface,
  Button,
  Checkbox,
  TextInput,
  Spinner,
  SegmentedControl,
  type SegmentedControlOption,
  useTranslations,
  useNotify,
  getStubThemeSnapshot,
} from "@th/ui";
import { Plus, Trash2, ExternalLink, Check, Copy } from "lucide-react";

import { trpc } from "@/trpc";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { getSiteUrl } from "@/config/site";
import { formatErrorMessage } from "@/lib/format-error-message";
import { mergeActivePreset } from "@/lib/theme-preset";
import { embedKnobDefaults } from "@/app/embed/[embedId]/_components/embed-theme";
import { DEFAULT_EMBED_SCOPE, type EmbedScope } from "@/lib/embed-scope";
import {
  DEFAULT_EMBED_VIEW,
  parseEmbedView,
  type EmbedView,
} from "@/lib/embed-view";
import {
  BOOKING_FORM_DEFAULT_HEIGHT,
  CALENDAR_DEFAULT_HEIGHT,
  MEMBERSHIPS_DEFAULT_HEIGHT,
  buildBookingIframeSnippet,
  buildBookingSnippet,
  buildEmbedWidgetUrl,
  buildMembershipsIframeSnippet,
  buildTicketsIframeSnippet,
  buildTicketsModalSnippet,
  buildTicketsReactSnippet,
  buildTicketsSdkSnippet,
  type EmbedSnippetOptions,
  type EmbedThemeEntries,
} from "@/lib/embed-snippets";
import { EmbedCodeBlock } from "@/components/embeds/EmbedCodeBlock";
import { EmbedModalPreview } from "@/components/embeds/EmbedModalPreview";
import {
  PlacePicker,
  type PlacePickerItem,
} from "@/components/places/PlacePicker";
import {
  EventPicker,
  type EventPickerItem,
} from "@/components/events/EventPicker";
import {
  CalendarSubjectPicker,
  type CalendarSubjectOption,
} from "./CalendarSubjectPicker";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import { EmbedCmsGuides } from "./EmbedCmsGuides";
import {
  nextTabForKey,
  type EmbedsPageTab,
  type EmbedsTabEntry,
} from "./embeds-tab-nav.helpers";
import {
  THEME_KNOBS,
  backgroundSeed,
  chooseSiteType,
  displayedSiteType,
  effectiveKnobColors,
  previewHostOnEnteringCustom,
  themeEntriesFor,
  type EmbedSiteType,
  type ThemeKnob,
  type ThemeOverrides,
} from "./embed-site-type.helpers";
import {
  confirmedDomainFor,
  displayForFormat,
  formatForDisplay,
  isDomainAlreadyListed,
  resizeNoteFor,
  type EventsDisplay,
  type SnippetFormat,
} from "./embed-format.helpers";

// tRPC cache utils – used for targeted invalidation after mutations
const useTrpcUtils = trpc.useUtils;

/**
 * Which THING the Events tab embeds. Maps onto the backend's `subjectType`:
 * `owner` → "organization" | "human" (depending on the admin context),
 * `event` → "event". There is deliberately no "venue" kind anymore — picking
 * a venue used to silently flip the whole page into the booking-button
 * variant, which is now its own page tab with `subjectType: "place"`.
 *
 * `owner` is deliberately one option rather than two: an organiser in a
 * personal admin context and one in an org context are doing the same job
 * ("embed my event list"), and the backend's org-vs-human split is an
 * authorization detail, not a user-facing choice. Sending "human" for a
 * personal context is the fix for the bug where this view hardcoded
 * "organization" but passed a humanId — the server looked up an org by a
 * humanId and 404'd, so personal contexts could not create embeds at all.
 *
 * `calendar` (venue-hierarchy FR-010) is the third kind: ONE named
 * programming stream of a place you control ("Social Club", "Drkmttr Live
 * Music"). It is a sibling of `owner`/`event` rather than a scope option
 * because the subject is a different ENTITY — the server resolves it through
 * `requireCalendarSubjectAccess` on the calendar's place, not through the
 * admin owner.
 */
type SubjectKind = "owner" | "event" | "calendar";

/** Resolved subject — exactly what `embeds.*` wants. */
type ResolvedSubject = {
  subjectType:
    | "organization"
    | "human"
    | "place"
    | "event"
    | "memberships"
    | "calendar";
  subjectId: string;
};

/**
 * Which embed PRODUCT is being configured — not which view. `events` is the
 * one org/human/event-scoped widget (list or calendar browse, both feeding the
 * same in-iframe checkout); `booking` is the place-scoped "Request to book"
 * widget (a modal trigger button or the inline request form), a genuinely
 * different product with no views at all; `memberships` is the tier-pitch
 * widget whose Join CTA links out to the owner's /p page (no in-iframe
 * commerce), so like booking it ships one inline snippet and no view/scope
 * controls.
 */
type WidgetVariant = "events" | "booking" | "memberships";

/**
 * ONE snippet set for the events embed regardless of view: a calendar is a
 * `?view=` param on the canonical widget URL, not a different code format, so
 * it reaches the SDK and modal distribution the old calendar tab lacked.
 */
const SNIPPET_TABS: SegmentedControlOption<SnippetFormat>[] = [
  { value: "html", label: "HTML" },
  { value: "react", label: "React" },
  { value: "sdk", label: "JS SDK" },
  { value: "modal", label: "Modal" },
];

const viewOptions = (
  t: ReturnType<typeof useTranslations>,
): SegmentedControlOption<EmbedView>[] => [
  { value: "list", label: String(t("admin.embedViewList")) },
  { value: "calendar", label: String(t("admin.embedViewCalendar")) },
];

/** In-iframe checkout vs a "Get Tickets on Ithas Fire" CTA. Events-only. */
type LinkOutMode = "inPage" | "newTab";

/**
 * Segment labels are UPPERCASE; only a genuinely long name is cut. The subject
 * row wraps instead (see the subject SegmentedControl), so an ordinary group
 * name like "Drkmttr Rehearsal" shows in full — the old 14-character cap cut
 * it to "DRKMTTR REHEA…" in front of the very place it names.
 */
const truncateLabel = (name: string, max = 40) =>
  name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name;

/**
 * Starting height of the inline events LIST snippet. Since hf-resize.js grows
 * the frame to fit the list on the host page (97e8485e3), this is only where
 * it starts, so the page no longer offers a Height control.
 */
const EVENTS_LIST_DEFAULT_HEIGHT = 600;

// ── Preview presets ──────────────────────────────────────────────────────────
// DATA, not chrome: the backdrop an organiser previews their widget against,
// simulating THEIR site's background. These are literal swatches the user picks
// (and compares against) — they must NOT track the Ithas Fire theme, so raw hex
// is correct here. Same for `customColor` below. (`THEME_DEFAULTS` is the
// opposite: it DOES track the platform — see there.)
//
// Only offered under "Is it light or dark?: Custom". Light and Dark pin the
// preview to a page of that kind (`PREVIEW_HOST_LIGHT` / `PREVIEW_HOST_DARK`),
// so the preview and the widget colours come from one answer. The labels name
// PAGE colours on purpose: "Light" / "Dark" here would share accessible names
// with the site-type radios above them.
/** The simulated host page behind the preview for a Light website. */
const PREVIEW_HOST_LIGHT = "#FFFFFF";
/** …and for "Dark": a near-black page, the common dark-site background. */
const PREVIEW_HOST_DARK = "#111111";

const BG_PRESETS = [
  {
    id: "checker",
    labelKey: "admin.embedBgCheckerboard",
    css: "repeating-conic-gradient(#e0e0e0 0% 25%, #fff 0% 50%) 0 0 / 16px 16px",
  },
  { id: PREVIEW_HOST_LIGHT, labelKey: "admin.embedBgWhite", css: PREVIEW_HOST_LIGHT },
  { id: "#F5F5F5", labelKey: "admin.embedBgLightGrey", css: "#F5F5F5" },
  { id: "#1a1a2e", labelKey: "admin.embedBgNavy", css: "#1a1a2e" },
  { id: PREVIEW_HOST_DARK, labelKey: "admin.embedBgNearBlack", css: PREVIEW_HOST_DARK },
] as const;

// ── "Is it light or dark?" (step 2) ─────────────────────────────────────────
// One question in place of choosing colours: organisers know whether their
// site is light or dark; they don't know that a dark site needs a light text
// colour. The answer is derived from the theme params (embed-site-type.helpers).
type Translate = ReturnType<typeof useTranslations>;

const siteTypeOptions = (t: Translate): SegmentedControlOption<EmbedSiteType>[] => [
  { value: "light", label: String(t("admin.embedSiteLight")) },
  { value: "dark", label: String(t("admin.embedSiteDark")) },
  { value: "custom", label: String(t("admin.embedSiteCustom")) },
];

const siteTypeDescription = (t: Translate, type: EmbedSiteType): string =>
  String(
    t(
      type === "light"
        ? "admin.embedSiteLightDesc"
        : type === "dark"
          ? "admin.embedSiteDarkDesc"
          : "admin.embedSiteCustomDesc",
    ),
  );

/**
 * The colour input's accessible name. One key per knob rather than
 * "{name} colour", so each language can phrase it naturally (Spanish
 * "Color de marca", not "Color de Marca").
 */
const knobAriaLabel = (t: Translate, knob: ThemeKnob): string =>
  String(
    t(
      knob === "brandColor"
        ? "admin.embedKnobBrandAria"
        : knob === "bg"
          ? "admin.embedKnobBgAria"
          : knob === "fontColor"
            ? "admin.embedKnobTextAria"
            : "admin.embedKnobAccentAria",
    ),
  );

const knobLabel = (t: Translate, knob: ThemeKnob): string =>
  String(
    t(
      knob === "brandColor"
        ? "admin.embedKnobBrand"
        : knob === "bg"
          ? "admin.embedKnobBg"
          : knob === "fontColor"
            ? "admin.embedKnobText"
            : "admin.embedKnobAccent",
    ),
  );

// Step 3's Display control for the events embed. The values ARE the format
// family (see embed-format.helpers): Inline ↔ HTML/React/SDK, Button ↔ Modal.
const eventsDisplayOptions = (
  t: Translate,
): SegmentedControlOption<EventsDisplay>[] => [
  { value: "inline", label: String(t("admin.embedDisplayInline")) },
  { value: "modal", label: String(t("admin.embedDisplayButton")) },
];

// DOM ids for the focus moves below: the Background "Set colour" and "Clear"
// buttons unmount themselves when pressed, so focus is handed on explicitly.
const THEME_BG_INPUT_ID = "theme-bg";
const THEME_BG_SET_ID = "theme-bg-set";
const THEME_BG_CLEAR_ID = "theme-bg-clear";
const SITE_TYPE_DESC_ID = "embed-site-type-description";

const widthPresets = (t: Translate): SegmentedControlOption<string>[] => [
  { label: String(t("admin.embedWidthFull")), value: "100%" },
  { label: "600px", value: "600px" },
  { label: "400px", value: "400px" },
];

// ── Page tabs ────────────────────────────────────────────────────────────────
// THREE tabs, one per PRODUCT: the events widget, the place-scoped "Request
// to book" button (which used to be implicitly selected by picking "Venue" in
// the subject picker) and the memberships widget. The old "Calendar" tab was
// the same events embed rendered a different way — it is now the Default view
// control inside the Events tab, so an organiser configures one embed instead
// of pasting two snippets. `?tab=booking` / `?tab=memberships` deep-link the
// non-default tabs; events is the default and carries no param, and the legacy `?tab=calendar` maps to
// events + `?view=calendar` (see `selectView`).
const embedsTabId = (tab: EmbedsPageTab) => `embeds-tab-${tab}`;
const EMBEDS_TAB_PANEL_ID = "embeds-tab-panel";

const EMBEDS_TAB_KEYS: EmbedsPageTab[] = ["events", "booking", "memberships"];

const tabLabel = (t: Translate, tab: EmbedsPageTab): string =>
  String(
    t(
      tab === "events"
        ? "admin.embedTabEvents"
        : tab === "booking"
          ? "admin.embedTabBooking"
          : "admin.embedTabMemberships",
    ),
  );

const EMBEDS_TAB_ORDER: EmbedsTabEntry[] = EMBEDS_TAB_KEYS.map((key) => ({
  key,
  id: embedsTabId(key),
}));

// Renders as a native <button> (like BookingInbox's TabButton) so Enter and
// Space activate the tab for keyboard users without a bespoke key handler.
const PageTabButton = styled(XStack, {
  name: "EmbedsPageTab",
  tag: "button",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderStyle: "solid",
  paddingHorizontal: "$3",
  paddingVertical: "$3",
  minHeight: 44,
  cursor: "pointer",
  borderBottomWidth: 2,
  borderBottomColor: "transparent",
  marginBottom: -2,
  variants: {
    active: {
      true: { borderBottomColor: "$accent" },
      false: {
        hoverStyle: { borderBottomColor: "$borderColor" },
      },
    },
  } as const,
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const EmbedsView = () => {
  const { slug } = useParams<{ slug: string }>();
  const t = useTranslations();
  const { toast } = useNotify();
  const {
    currentOwner,
    isLoading: ownerLoading,
    isError: ownerError,
  } = useCurrentAdminOwner(slug);
  // Hides the add/edit/revoke affordances for non-edit roles. UX-only; the
  // server 403s regardless.
  //
  // NOTE: this does NOT produce a read-only view of the embed list. `listEmbeds`
  // itself gates on ORG_EDIT_ROLES (see list-embeds.ts), so an org VIEWER can't
  // read embeds at all and lands on step 2's load-error state (with Retry), and
  // steps 3–4 stay locked — `canEdit` only ever
  // matters for humans and edit-capable org roles. Kept as-is deliberately:
  // embed IDs are bearer-ish (anyone with the id + an allowlisted domain can
  // render the widget), so widening the read is a real decision, not a tidy-up.
  const { canEdit } = useAdminOwnerCapabilities(currentOwner);
  const utils = useTrpcUtils();

  // ── Page tab (?tab=booking) + view (?view=calendar) ──────────────
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  // LEGACY: `?tab=calendar` used to be its own tab. There is no calendar tab
  // anymore, so it resolves to Events like any other unknown value and the
  // stale param is stripped from the address bar below (FR-007: no inbound
  // link 404s or lands on a dead tab).
  const isLegacyCalendarTab = tabParam === "calendar";
  const tabFromUrl: EmbedsPageTab =
    tabParam === "booking"
      ? "booking"
      : tabParam === "memberships"
        ? "memberships"
        : "events";
  // Local state answers the click instantly; `router.replace` round-trips the
  // server, so deriving the tab from the URL alone would lag the underline.
  const [activeTab, setActiveTab] = useState<EmbedsPageTab>(tabFromUrl);
  /**
   * The organiser's in-session view choice, set ONLY by using the control.
   * `null` means "show what's stored" — the displayed value falls back to the
   * selected subject's `defaultView` (see `selectedView`).
   *
   * Deliberately NOT seeded from the URL. A control labelled "Default view"
   * that reads Calendar over a row stored as List is a lie about persisted
   * config, and the legacy `?tab=calendar` link would have produced exactly
   * that on arrival — worse, a subsequent visitor-toggle write (which sends
   * only `viewToggle`) would have left the divergence in place indefinitely.
   * The link lands on Events showing the embed's real saved state; one click
   * changes it, and that click persists.
   */
  const [viewOverride, setViewOverride] = useState<EmbedView | null>(null);
  const [viewToggleOverride, setViewToggleOverride] = useState<boolean | null>(
    null,
  );

  // Back/forward (and future deep links from place settings) drive the tab.
  useEffect(() => {
    setActiveTab(tabFromUrl);
  }, [tabFromUrl]);

  // Strip the retired `?tab=calendar` so the address bar (and anything the
  // organiser copies out of it) names a tab that still exists. Runs once: the
  // replace clears `tab`, which flips `isLegacyCalendarTab` false.
  useEffect(() => {
    if (!isLegacyCalendarTab) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [isLegacyCalendarTab, searchParams, pathname, router]);

  const selectTab = useCallback(
    (next: EmbedsPageTab) => {
      setActiveTab(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === "events") params.delete("tab");
      else params.set("tab", next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [searchParams, pathname, router],
  );

  // ── Subject selection ────────────────────────────────────────────
  // Per-tab selections deliberately live in separate state slots so switching
  // tabs never clobbers the other tab's picks (the place survives a detour
  // through Tickets and vice versa).
  const [subjectKind, setSubjectKind] = useState<SubjectKind>("owner");
  const [selectedPlace, setSelectedPlace] = useState<PlacePickerItem | null>(
    null,
  );
  const [selectedEvent, setSelectedEvent] = useState<EventPickerItem | null>(
    null,
  );
  // Calendar subject: its own place slot, so hopping between the Booking tab's
  // place and the Events tab's calendar place never clobbers either pick.
  const [calendarPlace, setCalendarPlace] = useState<PlacePickerItem | null>(
    null,
  );
  const [selectedCalendar, setSelectedCalendar] =
    useState<CalendarSubjectOption | null>(null);

  // `orgId` is passed to PlacePicker ONLY in an org context — it filters to
  // places the org actually has access to. In a personal context there is no
  // org to scope by, and passing one would hide the human's own places.
  const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : undefined;
  const ownerType = currentOwner?.kind === "org" ? "ORGANIZATION" : "HUMAN";
  const ownerId =
    currentOwner?.kind === "org"
      ? currentOwner.orgId
      : (currentOwner?.humanId ?? "");

  const ownerLabel =
    currentOwner?.kind === "org"
      ? currentOwner.orgName
      : (currentOwner?.humanName ?? String(t("admin.embedOwnerYou")));

  const subject = useMemo<ResolvedSubject | null>(() => {
    if (!currentOwner) return null;
    if (activeTab === "booking") {
      return selectedPlace
        ? { subjectType: "place", subjectId: selectedPlace.placeId }
        : null;
    }
    if (activeTab === "memberships") {
      // The memberships subject IS the admin owner (org or human id) — the
      // server resolves which, org-first. No picker: like the events tab's
      // "owner" kind, there is exactly one possible subject per context.
      return {
        subjectType: "memberships",
        subjectId:
          currentOwner.kind === "org"
            ? currentOwner.orgId
            : currentOwner.humanId,
      };
    }
    // One owner/event subject model for the whole Events tab — list and
    // calendar are views of the SAME embed row, so there is nothing to keep
    // in separate state anymore.
    if (subjectKind === "owner") {
      return currentOwner.kind === "org"
        ? { subjectType: "organization", subjectId: currentOwner.orgId }
        : { subjectType: "human", subjectId: currentOwner.humanId };
    }
    if (subjectKind === "calendar") {
      return selectedCalendar
        ? { subjectType: "calendar", subjectId: selectedCalendar.id }
        : null;
    }
    return selectedEvent
      ? { subjectType: "event", subjectId: selectedEvent.eventId }
      : null;
  }, [
    currentOwner,
    activeTab,
    subjectKind,
    selectedPlace,
    selectedEvent,
    selectedCalendar,
  ]);

  const subjectReady = Boolean(subject);
  const isOwnerSubject =
    subject?.subjectType === "organization" || subject?.subjectType === "human";
  /**
   * Which subjects have browse VIEWS. Mirrors the server's own rule
   * (`VIEWLESS_SUBJECT_TYPES` in upsert-embed.ts = place | memberships): a
   * calendar embed is the events widget filtered to one stream, so list and
   * calendar views both apply and the fields are accepted. An `event` subject
   * is excluded here deliberately — a calendar of one event is a curiosity,
   * and the control stays pinned to "list" as before.
   */
  const supportsViews =
    isOwnerSubject || subject?.subjectType === "calendar";
  // The ACTIVE TAB decides the variant, not the subject type — each tab keeps
  // its variant even before a subject is picked.
  const widgetVariant: WidgetVariant =
    activeTab === "booking"
      ? "booking"
      : activeTab === "memberships"
        ? "memberships"
        : "events";

  // ── Scope (organization / human subjects only) ───────────────────
  const [scope, setScope] = useState<EmbedScope>(DEFAULT_EMBED_SCOPE);
  // Never send `scope` for a subject type the server ignores it for — a stale
  // param in a snippet is harmless, but the picker must not imply it applies.
  const effectiveScope: EmbedScope | null = isOwnerSubject ? scope : null;

  // ── Embeds list ─────────────────────────────────────────────────
  const embedsQuery = trpc.embeds.list.useQuery(
    subject ?? { subjectType: "organization", subjectId: "" },
    { enabled: subjectReady, staleTime: 15_000, retry: 1 },
  );

  // ── Active / revoked embeds ──────────────────────────────────────
  // Declared before the view + preview state below, which reads the stored
  // `defaultView` / `viewToggle` off these rows.
  const activeEmbeds = useMemo(
    () => (embedsQuery.data?.embeds ?? []).filter((e) => e.status === "ACTIVE"),
    [embedsQuery.data],
  );

  const revokedEmbeds = useMemo(
    () =>
      (embedsQuery.data?.embeds ?? []).filter((e) => e.status === "REVOKED"),
    [embedsQuery.data],
  );

  // ── Add domain form ──────────────────────────────────────────────
  const [newDomain, setNewDomain] = useState("");
  // The last domain added, tagged with the subject it was added to. Drives
  // step 2's inline "✓ <domain> can show the widget" line, which stays on the
  // page (the toast alone vanished before the rehearsal's place owner saw
  // it). Tagged so a confirmation never shows under a different subject.
  const [lastAdded, setLastAdded] = useState<{
    subjectKey: string;
    domain: string;
  } | null>(null);

  const invalidateList = useCallback(() => {
    if (subject) void utils.embeds.list.invalidate(subject);
  }, [utils, subject]);

  // ── View config (FR-006) ─────────────────────────────────────────
  // `defaultView` / `viewToggle` live on the same Embed row as `linkOut`, one
  // row per allowed domain — so a change writes to EVERY active domain of the
  // selected subject. The controls are page-level (not per-card) because the
  // view is a property of the EMBED, not of the code format: it drives the
  // preview and every snippet at once.
  //
  // Displayed value: the organiser's in-session choice, else what is stored on
  // the first active row, else the column default. Event subjects are pinned
  // to "list" — a calendar of one event is a curiosity the legacy
  // /embed/calendar/<id> route can keep serving, not something to offer here.
  const storedView = parseEmbedView(activeEmbeds[0]?.defaultView);
  const storedViewToggle = activeEmbeds[0]?.viewToggle ?? false;
  const selectedView: EmbedView = supportsViews
    ? (viewOverride ?? storedView ?? DEFAULT_EMBED_VIEW)
    : DEFAULT_EMBED_VIEW;
  const visitorToggleOn = supportsViews
    ? (viewToggleOverride ?? storedViewToggle)
    : false;

  // Switching subject must not carry the previous subject's choice over — the
  // control would then claim a view the newly-selected embed doesn't have.
  // Skipped on the FIRST resolution (null → subject), which is where a
  // `?view=` deep link is still the only signal we have.
  const subjectKey = subject
    ? `${subject.subjectType}:${subject.subjectId}`
    : null;
  const prevSubjectKeyRef = useRef<string | null>(subjectKey);
  useEffect(() => {
    const prev = prevSubjectKeyRef.current;
    prevSubjectKeyRef.current = subjectKey;
    if (prev === null || prev === subjectKey) return;
    setViewOverride(null);
    setViewToggleOverride(null);
  }, [subjectKey]);

  const viewMutation = trpc.embeds.upsert.useMutation();

  /**
   * Persist a view-config patch to every active domain row of the current
   * subject. Omitted fields preserve their stored values server-side, so this
   * never disturbs `linkOut`.
   *
   * With no domains added yet the control is still meaningful — the chosen
   * values ride the next add-domain upsert (`handleAddDomain`) — so there is
   * simply nothing to write.
   *
   * `allSettled`, not `all`: these are N INDEPENDENT writes. `all` rejects on
   * the first failure while the others have already committed, which would
   * leave the domains genuinely divergent — and since the control renders
   * `activeEmbeds[0]`, a failure on any LATER row would be invisible. So:
   * always re-read the server (`invalidateList`), and on any rejection drop
   * the optimistic override so the control snaps back to stored state instead
   * of displaying a value that only some rows accepted.
   */
  const applyViewConfig = useCallback(
    async (patch: { defaultView?: EmbedView; viewToggle?: boolean }) => {
      // Owner (organization/human) and calendar subjects only — place and
      // memberships subjects have no views and the server REJECTS the fields.
      if (!subject || !supportsViews) return;
      if (activeEmbeds.length === 0) return;
      const results = await Promise.allSettled(
        activeEmbeds.map((embed) =>
          viewMutation.mutateAsync({
            ...subject,
            domain: embed.domain,
            ...patch,
          }),
        ),
      );
      invalidateList();

      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [{ domain: activeEmbeds[index]!.domain, reason: result.reason }]
          : [],
      );
      if (failures.length === 0) {
        toast.success({
          id: "embed-view-updated",
          title: String(t("admin.embedViewUpdated")),
          message: String(t("admin.embedViewUpdatedDesc")),
        });
        return;
      }
      // Roll back to server state — the refetch above decides what the control
      // shows, so the organiser sees which rows actually took the change.
      setViewOverride(null);
      setViewToggleOverride(null);
      toast.danger({
        id: "embed-view-failed",
        title:
          failures.length === activeEmbeds.length
            ? String(t("admin.embedViewUpdateFailed"))
            : String(
                t("admin.embedViewUpdateFailedFor", {
                  domains: failures.map((f) => f.domain).join(", "),
                }),
              ),
        message: formatErrorMessage(failures[0]!.reason, t),
      });
    },
    [
      subject,
      supportsViews,
      activeEmbeds,
      viewMutation,
      invalidateList,
      toast,
      t,
    ],
  );

  const selectView = useCallback(
    (next: EmbedView) => {
      setViewOverride(next);
      void applyViewConfig({ defaultView: next });
    },
    [applyViewConfig],
  );

  const selectVisitorToggle = useCallback(
    (next: boolean) => {
      setViewToggleOverride(next);
      void applyViewConfig({ viewToggle: next });
    },
    [applyViewConfig],
  );

  const upsertMutation = trpc.embeds.upsert.useMutation({
    onSuccess: (data, variables) => {
      setNewDomain("");
      // The server's bare hostname, not what was typed ("https://Foo.com/"
      // is stored as "foo.com"), so the line names the row in the list.
      setLastAdded({
        subjectKey: `${variables.subjectType}:${variables.subjectId}`,
        domain: data.embed.domain,
      });
      invalidateList();
      toast.success({
        id: "embed-added",
        title: String(t("admin.embedDomainAdded")),
        message: String(t("admin.embedDomainAddedDesc")),
      });
    },
    onError: (err) => {
      toast.danger({
        id: "embed-add-failed",
        title: String(t("admin.embedAddFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const revokeMutation = trpc.embeds.revoke.useMutation({
    onSuccess: () => {
      invalidateList();
      toast.success({
        id: "embed-revoked",
        title: String(t("admin.embedRevoked")),
        message: String(t("admin.embedRevokedDesc")),
      });
    },
    onError: (err) => {
      toast.danger({
        id: "embed-revoke-failed",
        title: String(t("admin.embedRevokeFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  // Separate mutation for the per-embed link-out toggle so it shows its own
  // "updated" toast (not the "domain added" toast) and doesn't clear newDomain.
  const linkOutMutation = trpc.embeds.upsert.useMutation({
    onSuccess: () => {
      invalidateList();
      toast.success({
        id: "embed-linkout-updated",
        title: String(t("admin.embedLinkOutUpdated")),
        message: String(t("admin.embedLinkOutUpdatedDesc")),
      });
    },
    onError: (err) => {
      toast.danger({
        id: "embed-linkout-failed",
        title: String(t("admin.embedLinkOutFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const handleAddDomain = useCallback(() => {
    if (!subject || !newDomain.trim() || upsertMutation.isPending) return;
    const domain = newDomain.trim();
    // Upsert is by (subject, domain), so adding a domain that already exists
    // EDITS that row. Only seed the view config onto a genuinely NEW row:
    // otherwise re-adding a listed domain would silently rewrite its stored
    // view from whatever `activeEmbeds[0]` happens to show. Owner subjects
    // only — an event subject's control is pinned to "list" and would force
    // that onto the row, and a place subject has no views at all (upsert
    // REJECTS the fields outright, FR-002 / D-004).
    // Compared as HOSTNAMES, the way the server keys the row: typing
    // "https://foo.com" while "foo.com" is listed is the same row. Only
    // ACTIVE rows count — a revoked row is reactivated by the upsert and
    // takes the view config shown now (see isDomainAlreadyListed).
    const alreadyListed = isDomainAlreadyListed(
      domain,
      embedsQuery.data?.embeds ?? [],
    );
    const viewFields =
      supportsViews && !alreadyListed
        ? { defaultView: selectedView, viewToggle: visitorToggleOn }
        : {};
    upsertMutation.mutate({ ...subject, domain, ...viewFields });
  }, [
    subject,
    newDomain,
    upsertMutation,
    embedsQuery.data,
    supportsViews,
    selectedView,
    visitorToggleOn,
  ]);

  const handleToggleLinkOut = useCallback(
    (domain: string, linkOut: boolean) => {
      if (!subject) return;
      linkOutMutation.mutate({ ...subject, domain, linkOut });
    },
    [subject, linkOutMutation],
  );

  const handleRevoke = useCallback(
    (embedId: string) => {
      revokeMutation.mutate({ embedId });
    },
    [revokeMutation],
  );

  // ── Clipboard helper ─────────────────────────────────────────────
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string, id: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  // ── Preview state ────────────────────────────────────────────────
  const [previewBg, setPreviewBg] = useState<string>("checker");
  const [previewWidth, setPreviewWidth] = useState<string>("100%");
  const [customColor, setCustomColor] = useState<string>("#ffffff");
  // Which colour swatch holds keyboard focus. Its <input> is invisible (it
  // only opens the native picker), so the swatch draws the ring itself.
  const [focusedKnob, setFocusedKnob] = useState<ThemeKnob | "preview" | null>(
    null,
  );
  // The events embed's code format — ONE value behind both step 3's Display
  // control and step 4's format switcher, so the preview can never show a
  // button over an iframe snippet (or the reverse). Inline = HTML/React/SDK,
  // Button = Modal (embed-format.helpers). Shared by every domain card: the
  // organiser makes the choice once. Booking keeps its own slot below so
  // flipping page tabs never clobbers the other tab's choice.
  const [snippetFormat, setSnippetFormat] = useState<SnippetFormat>("html");
  const ticketsDisplay = displayForFormat(snippetFormat);
  const selectTicketsDisplay = useCallback(
    (next: EventsDisplay) => setSnippetFormat(formatForDisplay(next)),
    [],
  );
  // Booking can be a modal "Request to book" button OR the inline request
  // form (an iframe on /embed/book/<id>). Defaults to modal (the original
  // booking snippet, and the lighter-weight drop-in).
  const [bookingPreviewMode, setBookingPreviewMode] = useState<
    "modal" | "inline"
  >("modal");

  // ── Theme override state ─────────────────────────────────────────
  // Picker defaults = what an embed renders with the knob untouched: the
  // platform's LIGHT theme (Stub + the active preset — embeds are
  // appearance-locked to it, whatever mode this admin is viewing in), read
  // through the same knob→token map embed-theme.ts uses. Same query (and
  // cache entry) as ActiveThemeInjector, so this is normally already loaded.
  const { data: activeTheme } = trpc.platform.getActiveTheme.useQuery(
    undefined,
    { staleTime: 60_000, retry: false },
  );
  const THEME_DEFAULTS = useMemo(
    () =>
      embedKnobDefaults(
        mergeActivePreset(getStubThemeSnapshot(), activeTheme).tokens,
      ),
    [activeTheme],
  );

  const [themeOverrides, setThemeOverrides] = useState<ThemeOverrides>({});

  // The params the snippet AND the preview carry — one derivation, so the two
  // can't disagree (see `themeEntriesFor` for which knobs emit).
  const themeEntries = useMemo<EmbedThemeEntries>(
    () => themeEntriesFor(themeOverrides, THEME_DEFAULTS),
    [themeOverrides, THEME_DEFAULTS],
  );

  // "Your website is": DERIVED from `themeEntries`. `customPicked` records
  // only that the organiser chose Custom to edit colours; it can widen the
  // answer to Custom, never claim Light or Dark over params that differ.
  const [customPicked, setCustomPicked] = useState(false);
  // The last Custom colours, for this visit only: radios select on arrow
  // keys, so passing through Light or Dark must not wipe them.
  const [lastCustom, setLastCustom] = useState<ThemeOverrides | null>(null);
  const siteType = displayedSiteType(themeEntries, customPicked);
  const knobColors = effectiveKnobColors(themeOverrides, THEME_DEFAULTS);

  const selectSiteType = useCallback(
    (next: EmbedSiteType) => {
      // A template REPLACES the theme params (Light clears them, Dark writes
      // its one param); Custom restores the colours last set under it.
      // Focus stays on the radio the organiser just used (SegmentedControl
      // keeps its segments mounted).
      const nextState = chooseSiteType(
        { overrides: themeOverrides, customPicked, lastCustom },
        siteType,
        next,
      );
      setThemeOverrides(nextState.overrides);
      setCustomPicked(nextState.customPicked);
      setLastCustom(nextState.lastCustom);
    },
    [themeOverrides, customPicked, lastCustom, siteType],
  );

  // Entering Custom from a template — by the radio or by editing a swatch —
  // keeps the preview on that template's page colour instead of dropping to
  // the checkerboard mid-tune. Custom's own preview choice is left alone
  // otherwise.
  const prevSiteTypeRef = useRef<EmbedSiteType>(siteType);
  useEffect(() => {
    const prev = prevSiteTypeRef.current;
    prevSiteTypeRef.current = siteType;
    const host = previewHostOnEnteringCustom(prev, siteType);
    if (host === "dark") setPreviewBg(PREVIEW_HOST_DARK);
    else if (host === "light") setPreviewBg(PREVIEW_HOST_LIGHT);
  }, [siteType]);

  /** Hand focus to an element that mounts on the next render. */
  const focusAfterRender = useCallback((id: string, then?: () => void) => {
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      el?.focus();
      then?.();
    });
  }, []);

  // The events snippet carries `?view=calendar` when the View control says so
  // and NO param for list (the server-side default — same omission rule as
  // `scope: "own"`). Booking has no views at all, so it never sends one.
  const snippetOptions = useMemo<EmbedSnippetOptions>(
    () => ({
      themeEntries,
      scope: effectiveScope,
      // Views exist on the EVENTS widget only — booking and memberships have
      // none (the server rejects the fields on their subjects).
      view: widgetVariant === "events" ? selectedView : null,
    }),
    [themeEntries, effectiveScope, widgetVariant, selectedView],
  );

  // Every inline frame starts at its snippet's fixed default height and
  // hf-resize.js takes over on the host page (the events list too, since
  // 97e8485e3), so no height is user-set: booking's inline form, memberships,
  // the calendar VIEW's month grid and the events list each have a constant.
  const effectivePreviewHeight =
    widgetVariant === "booking"
      ? BOOKING_FORM_DEFAULT_HEIGHT
      : widgetVariant === "memberships"
        ? MEMBERSHIPS_DEFAULT_HEIGHT
        : selectedView === "calendar"
          ? CALENDAR_DEFAULT_HEIGHT
          : EVENTS_LIST_DEFAULT_HEIGHT;

  // ── Snippet + preview helpers (forked on widget variant) ─────────
  const getEmbedSnippet = useCallback(
    (embedId: string, height: number) => {
      if (widgetVariant === "memberships")
        // One inline snippet, like the booking form: no views, no scope, no
        // in-iframe commerce — the Join CTA opens the /p page in a new tab,
        // and hf-resize.js sizes the frame on the host.
        return buildMembershipsIframeSnippet({
          siteUrl: getSiteUrl(),
          embedId,
          height: MEMBERSHIPS_DEFAULT_HEIGHT,
          options: { themeEntries },
        });
      if (widgetVariant === "booking")
        // Height is the fixed snippet default, NOT the preview height param —
        // there is no booking height control, and hf-resize.js takes over on
        // the host page anyway.
        return bookingPreviewMode === "modal"
          ? buildBookingSnippet(getSiteUrl(), embedId, { themeEntries })
          : buildBookingIframeSnippet({
              siteUrl: getSiteUrl(),
              embedId,
              height: BOOKING_FORM_DEFAULT_HEIGHT,
              options: { themeEntries },
            });
      // ONE builder for both views — the view rides `snippetOptions` into the
      // canonical /embed/<id> URL, so the calendar finally gets the same
      // HTML/React/SDK/Modal distribution the list has.
      return buildTicketsIframeSnippet({
        siteUrl: getSiteUrl(),
        embedId,
        height,
        options: snippetOptions,
      });
    },
    [widgetVariant, bookingPreviewMode, themeEntries, snippetOptions],
  );

  // `snippetOptions.scope` is already null for a place subject (scope only
  // resolves for owner subjects), so the booking URL never carries it.
  const getPreviewUrl = useCallback(
    (embedId: string) =>
      buildEmbedWidgetUrl(getSiteUrl(), embedId, {
        ...snippetOptions,
        book: widgetVariant === "booking",
        memberships: widgetVariant === "memberships",
      }),
    [snippetOptions, widgetVariant],
  );

  // ── Owner loading / error ────────────────────────────────────────
  // Only the OWNER gates the whole page: the embeds list has its own inline
  // loading state, so switching subject never blanks the picker out from
  // under the organiser's cursor.
  if (ownerLoading) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingEmbeds"))}
      >
        {null}
      </AdminPageData>
    );
  }

  // A resolved-but-null owner means the slug matches no entity the actor can
  // administer. Say so rather than spinning forever (the old code silently
  // rendered an empty page).
  if (ownerError || !currentOwner) {
    return (
      <AdminPageData
        isLoading={false}
        isError
        errorMessage={String(t("admin.embedAccountLoadFailed"))}
      >
        {null}
      </AdminPageData>
    );
  }

  const subjectOptions: SegmentedControlOption<SubjectKind>[] = [
    // The full name, capped only when genuinely long: the row wraps (see the
    // control below), so the name no longer has to squeeze beside the other
    // two segments.
    { value: "owner", label: truncateLabel(ownerLabel) },
    { value: "calendar", label: String(t("admin.embedSubjectCalendar")) },
    { value: "event", label: String(t("admin.embedSubjectEvent")) },
  ];

  // The owner hint stays deliberately vague about WHICH events — the scope
  // control right below it is what answers that, and a hint claiming "events
  // you're showing" would contradict scope="venues".
  const subjectHint =
    subjectKind === "owner"
      ? selectedView === "calendar"
        ? String(t("admin.embedHintOwnerCalendar"))
        : String(t("admin.embedHintOwnerList"))
      : subjectKind === "calendar"
        ? // Says only what the public payload actually contains (NFR-002):
          // that calendar's published events, nothing about who booked them.
          selectedView === "calendar"
          ? String(t("admin.embedHintCalendarCalendar"))
          : String(t("admin.embedHintCalendarList"))
        : String(t("admin.embedHintEvent"));

  // ── Step gating ──────────────────────────────────────────────────
  // The four steps are a real sequence. Steps 2–4 need a subject (step 1);
  // steps 3–4 need an embed row, because the preview frame and the code both
  // carry the row's id, and the id exists only once a domain is added. A
  // locked step says which earlier step unlocks it instead of the page simply
  // having nothing below the picker (the rehearsal's "nothing appears" gap).
  const subjectLockedMessage =
    activeTab === "booking"
      ? String(t("admin.embedLockedBooking"))
      : subjectKind === "calendar"
        ? String(t("admin.embedLockedCalendar"))
        : String(t("admin.embedLockedEvent"));
  const hasActiveEmbed = subjectReady && activeEmbeds.length > 0;
  // Steps 3 and 4 while step 2 has no usable answer yet: the list is still
  // loading, failed (step 2 carries Retry), or has no active domain.
  const domainLockedMessage = (step: 3 | 4) =>
    embedsQuery.isLoading
      ? String(t("admin.embedLockedLoading"))
      : embedsQuery.error
        ? String(t("admin.embedLockedLoadFailed"))
        : !canEdit
          ? step === 3
            ? String(t("admin.embedLockedPreviewEditor"))
            : String(t("admin.embedLockedCodeEditor"))
          : step === 3
            ? String(t("admin.embedLockedPreviewAdd"))
            : String(t("admin.embedLockedCodeAdd"));
  // Step 2's confirmation names the domain just added — only under the
  // subject it was added to, and only while that row is still active (a
  // revoke right after an add must not leave "can show the widget" behind).
  const confirmedDomain = confirmedDomainFor(
    lastAdded,
    subjectKey,
    activeEmbeds,
  );

  // Roving-tabindex keyboard nav for the page tablist (same pattern as
  // BookingInbox): only the active tab sits in the Tab order,
  // and arrow keys move focus + selection per the ARIA tabs pattern.
  const handleTabKeyDown =
    (current: EmbedsPageTab) =>
    (e: { key: string; preventDefault: () => void }) => {
      const target = nextTabForKey(current, e.key, EMBEDS_TAB_ORDER);
      if (!target) return;
      e.preventDefault();
      selectTab(target.key);
      // Move focus to follow selection so the roving tabindex stays coherent.
      document.getElementById(target.id)?.focus();
    };

  return (
    // $sm trims the page gutter so the step cards keep usable width at 320
    // ($sm wins at ≤480, so there is no separate $xs rung).
    <YStack padding="$5" gap="$6" maxWidth={900} $sm={{ padding: "$3" }}>
      {/* ── Page header ─────────────────────────────────────── */}
      <AdminPageHeader
        title={String(t("admin.embedsHeading"))}
        subtitle={String(t("admin.embedsSubtitle"))}
        section="embeds"
      />

      {/* ── Page tabs: tickets widgets vs the booking button ── */}
      <XStack
        role="tablist"
        aria-label={String(t("admin.embedTabLabel"))}
        aria-orientation="horizontal"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
        gap="$1"
        // Three uppercase labels don't fit one line at 320; wrapping keeps
        // every tab visible rather than scrolling one off the edge.
        flexWrap="wrap"
      >
        {EMBEDS_TAB_KEYS.map((key) => {
          const label = tabLabel(t, key);
          // Web-only ARIA wiring (valid on the rendered <button>, absent from
          // Tamagui's RN prop types — a spread keeps the escape hatch scoped,
          // same as BookingInbox).
          const tabA11yProps = {
            id: embedsTabId(key),
            "aria-controls": EMBEDS_TAB_PANEL_ID,
            tabIndex: activeTab === key ? 0 : -1,
            onKeyDown: handleTabKeyDown(key),
          };
          return (
            <PageTabButton
              key={key}
              active={activeTab === key}
              role="tab"
              aria-selected={activeTab === key}
              onPress={() => selectTab(key)}
              testID={embedsTabId(key)}
              {...tabA11yProps}
            >
              <Text
                variant="label"
                color={activeTab === key ? "$color" : "$colorMuted"}
                style={{
                  fontWeight: activeTab === key ? 700 : 500,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}
              >
                {label}
              </Text>
            </PageTabButton>
          );
        })}
      </XStack>

      {/* Four numbered steps in the order a place owner takes them: what the
          widget shows, which site it goes on (and whether that site is light
          or dark), how it looks there, then the code. "Light or dark" sits in
          step 2 on purpose: in the rehearsal it lived under the code, the
          code was copied first, and a dark site got a dark-on-dark widget. */}
      <YStack
        id={EMBEDS_TAB_PANEL_ID}
        role="tabpanel"
        aria-labelledby={embedsTabId(activeTab)}
        tabIndex={0}
        gap="$5"
      >
        {/* ── Step 1: What it shows ─────────────────────────── */}
        <StepCard num={1} title={String(t("admin.embedStep1Title"))}>
          {activeTab === "events" ? (
            <>
              {/* Wraps instead of truncating: the owner segment carries the
                  group's full name, and at 320 Calendar / Event drop to a
                  second line rather than pushing the row off the card. A
                  name wider than the card itself wraps INSIDE its segment
                  (`wrap` on SegmentedControl). */}
              <SegmentedControl<SubjectKind>
                options={subjectOptions}
                value={subjectKind}
                onChange={setSubjectKind}
                ariaLabel={String(t("admin.embedSubjectLabel"))}
                testIdBase="embed-subject"
                wrap
              />
              <Text variant="caption" tone="muted">
                {subjectHint}
              </Text>

              {subjectKind === "event" && (
                <EventPicker
                  value={selectedEvent}
                  onChange={setSelectedEvent}
                  ownerType={ownerType}
                  ownerId={ownerId}
                  adminSlug={slug}
                  placeholder={String(t("admin.embedSelectEventPlaceholder"))}
                />
              )}

              {/* Calendar subject (FR-010): place first, then one of its
                  named calendars — the rows are grouped under their place
                  because calendar names are place-local. */}
              {subjectKind === "calendar" && (
                <CalendarSubjectPicker
                  place={calendarPlace}
                  onPlaceChange={setCalendarPlace}
                  value={selectedCalendar}
                  onChange={setSelectedCalendar}
                  orgId={orgId}
                  adminSlug={slug}
                />
              )}

              {/* View — organization/human/calendar subjects, and edit-gated
                  exactly like the link-mode control (ORG_EDIT_ROLES; the
                  server 403s regardless). An event subject has one event, so
                  it has nothing to lay out on a calendar. */}
              {supportsViews && canEdit && (
                <YStack gap="$2" paddingTop="$2">
                  <FieldLabel>{String(t("admin.embedDefaultView"))}</FieldLabel>
                  <SegmentedControl<EmbedView>
                    options={viewOptions(t)}
                    value={selectedView}
                    onChange={selectView}
                    size="sm"
                    disabled={viewMutation.isPending}
                    ariaLabel={String(t("admin.embedDefaultView"))}
                    testIdBase="embed-default-view"
                    wrap
                  />
                  <Text variant="caption" tone="muted">
                    {selectedView === "calendar"
                      ? String(t("admin.embedViewHintCalendar"))
                      : String(t("admin.embedViewHintList"))}
                  </Text>
                  <Checkbox
                    label={String(t("admin.embedViewToggleLabel"))}
                    description={String(t("admin.embedViewToggleDesc"))}
                    checked={visitorToggleOn}
                    disabled={viewMutation.isPending}
                    onCheckedChange={(checked) =>
                      selectVisitorToggle(checked === true)
                    }
                    testIdBase="embed-view-toggle"
                  />
                </YStack>
              )}

              {/* Scope — organization/human subjects only. */}
              {isOwnerSubject && (
                <YStack gap="$2" paddingTop="$2">
                  <FieldLabel>{String(t("admin.embedWhichEvents"))}</FieldLabel>
                  <SegmentedControl<EmbedScope>
                    options={[
                      { value: "own", label: String(t("admin.embedScopeOwn")) },
                      {
                        value: "venues",
                        label: String(t("admin.embedScopeVenues")),
                      },
                      { value: "all", label: String(t("admin.embedScopeAll")) },
                    ]}
                    value={scope}
                    onChange={setScope}
                    size="sm"
                    ariaLabel={String(t("admin.embedWhichEventsAria"))}
                    testIdBase="embed-scope"
                    wrap
                  />
                  <Text variant="caption" tone="muted">
                    {scope === "own"
                      ? String(t("admin.embedScopeOwnHint"))
                      : scope === "venues"
                        ? String(t("admin.embedScopeVenuesHint"))
                        : String(t("admin.embedScopeAllHint"))}
                  </Text>
                </YStack>
              )}
            </>
          ) : activeTab === "booking" ? (
            /* ── Booking place picker ── */
            <>
              <FieldLabel>{String(t("admin.embedWhichPlace"))}</FieldLabel>
              <PlacePicker
                value={selectedPlace}
                onChange={setSelectedPlace}
                orgId={orgId}
                adminSlug={slug}
                placeholder={String(t("admin.embedSelectPlace"))}
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.embedBookingHint1"))}
              </Text>
              <Text variant="caption" tone="muted">
                {String(t("admin.embedBookingHint2"))}
              </Text>
            </>
          ) : (
            /* ── Memberships explainer (no picker — the subject IS the
                  owner, same as the events tab's "owner" kind) ── */
            <>
              <Text variant="body" weight="bold">
                {String(
                  t("admin.embedMembershipsTitle", {
                    name: truncateLabel(ownerLabel),
                  }),
                )}
              </Text>
              <Text variant="caption" tone="muted">
                {String(t("admin.embedMembershipsDesc"))}
              </Text>
            </>
          )}
        </StepCard>

        {/* ── Step 2: Your website ──────────────────────────── */}
        {!subjectReady ? (
          <LockedStep num={2} title={String(t("admin.embedStep2Title"))}>
            {subjectLockedMessage}
          </LockedStep>
        ) : (
          <StepCard num={2} title={String(t("admin.embedStep2Title"))}>
            {/* Add domain — ORG_EDIT_ROLES only */}
            {canEdit && (
              <YStack gap="$2">
                <FieldLabel>{String(t("admin.embedItsAddress"))}</FieldLabel>
                <Text variant="caption" tone="muted">
                  {String(t("admin.embedAddDomainDesc"))}
                </Text>
                <XStack gap="$2" rowGap="$2" alignItems="center" flexWrap="wrap">
                  {/* TextInput's frame is a fixed 240px unless fullWidth, so
                      the wrapper takes the flex and the input fills it. The
                      floor sends Add to its own line at 320. */}
                  <YStack flexGrow={1} flexShrink={1} flexBasis={0} minWidth={160}>
                    <TextInput
                      placeholder="example.com"
                      value={newDomain}
                      onChangeText={setNewDomain}
                      fullWidth
                      size="$3"
                      aria-label={String(t("admin.embedItsAddress"))}
                      onSubmitEditing={handleAddDomain}
                    />
                  </YStack>
                  <Button
                    variant="primary"
                    size="$3"
                    onPress={handleAddDomain}
                    disabled={!newDomain.trim() || upsertMutation.isPending}
                  >
                    <Plus size={14} />
                    {String(t("admin.embedAdd"))}
                  </Button>
                </XStack>
                {/* Always mounted so the live region exists before its text
                    changes; screen readers announce the add without the
                    toast. It stays on the page after the toast has gone. */}
                <YStack role="status">
                  {confirmedDomain && (
                    <XStack
                      gap="$2"
                      alignItems="center"
                      borderWidth={2}
                      borderColor="$success"
                      paddingHorizontal="$3"
                      paddingVertical="$2"
                      testID="embed-domain-confirmation"
                    >
                      <Check
                        size={16}
                        aria-hidden
                        style={{
                          flexShrink: 0,
                          color: "var(--success, #166534)",
                        }}
                      />
                      <Text
                        variant="bodySmall"
                        weight="bold"
                        tone="success"
                        flexShrink={1}
                        style={{ overflowWrap: "anywhere" }}
                      >
                        {String(
                          t("admin.embedDomainConfirmed", {
                            domain: confirmedDomain,
                          }),
                        )}
                      </Text>
                    </XStack>
                  )}
                </YStack>
              </YStack>
            )}

            {/* Added domains, each with Revoke (moved here from the code
                cards: a domain is step 2's answer, so it is removed here). */}
            {embedsQuery.isLoading ? (
              <YStack padding="$3" alignItems="center">
                <Spinner
                  width={20}
                  height={20}
                  borderWidth={2}
                  indicatorColor="$colorMuted"
                />
              </YStack>
            ) : embedsQuery.error ? (
              <YStack gap="$2" alignItems="flex-start">
                <Text variant="body" weight="bold">
                  {String(t("admin.embedDomainsLoadFailedTitle"))}
                </Text>
                <Text variant="caption" tone="error">
                  {formatErrorMessage(embedsQuery.error, t)}
                </Text>
                <Button
                  variant="secondary"
                  size="$3"
                  onPress={() => void embedsQuery.refetch()}
                >
                  {String(t("admin.embedRetry"))}
                </Button>
              </YStack>
            ) : activeEmbeds.length > 0 ? (
              <YStack gap="$2">
                <FieldLabel>{String(t("admin.embedCanShowWidget"))}</FieldLabel>
                <YStack>
                  {activeEmbeds.map((embed) => (
                    <XStack
                      key={embed.id}
                      gap="$3"
                      rowGap="$2"
                      alignItems="center"
                      justifyContent="space-between"
                      flexWrap="wrap"
                      paddingVertical="$2"
                      borderTopWidth={1}
                      borderTopColor="$borderColorSoft"
                      testID={`embed-domain-row-${embed.id}`}
                    >
                      {/* A floor on the name's width: below it Revoke wraps
                          to its own line instead of the domain breaking
                          letter by letter. */}
                      <Text
                        variant="body"
                        weight="bold"
                        flexGrow={1}
                        flexShrink={1}
                        flexBasis={0}
                        minWidth={140}
                        style={{ overflowWrap: "anywhere" }}
                      >
                        {embed.domain}
                      </Text>
                      {canEdit && (
                        <Button
                          variant="secondary"
                          size="$3"
                          onPress={() => handleRevoke(embed.id)}
                          disabled={revokeMutation.isPending}
                          // One Revoke per domain: the name carries the domain
                          // so each is unique on the page.
                          aria-label={`${String(t("admin.embedRevoke"))} ${embed.domain}`}
                        >
                          <Trash2 size={14} />
                          {String(t("admin.embedRevoke"))}
                        </Button>
                      )}
                    </XStack>
                  ))}
                </YStack>
              </YStack>
            ) : !canEdit ? (
              <Text variant="body" tone="muted">
                {String(t("admin.embedNeedsEditor"))}
              </Text>
            ) : null}

            {/* Revoked embeds (collapsed) */}
            {revokedEmbeds.length > 0 && (
              <YStack gap="$1">
                <FieldLabel>
                  {String(t("admin.embedRevokedDomains"))} (
                  {revokedEmbeds.length})
                </FieldLabel>
                {revokedEmbeds.map((embed) => (
                  <XStack
                    key={embed.id}
                    gap="$3"
                    paddingVertical="$1"
                    alignItems="center"
                    justifyContent="space-between"
                    opacity={0.5}
                  >
                    <Text
                      variant="bodySmall"
                      flexShrink={1}
                      minWidth={0}
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {embed.domain}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {String(t("admin.embedStatusRevoked"))}
                    </Text>
                  </XStack>
                ))}
              </YStack>
            )}

            {/* "Is it light or dark?" — one question in place of two
                controls both called "Background" (a preview-only host swatch
                row and the widget's real background knob). The answer drives
                the widget's theme params AND the preview's simulated page, so
                the two can't disagree. Honoured by every widget: the booking
                form and memberships read the same params via
                useEmbedThemeOverrides. It is local state with no embed row
                behind it, so it works before any domain exists. */}
            <YStack
              gap="$2"
              paddingTop="$4"
              borderTopWidth={2}
              borderTopColor="$borderColor"
            >
              <FieldLabel>{String(t("admin.embedLightOrDark"))}</FieldLabel>
              <SegmentedControl<EmbedSiteType>
                options={siteTypeOptions(t)}
                value={siteType}
                onChange={selectSiteType}
                size="sm"
                ariaLabel={String(t("admin.embedLightOrDarkAria"))}
                testIdBase="embed-site-type"
                wrap
                {...({
                  "aria-describedby": SITE_TYPE_DESC_ID,
                } as object)}
              />
              <Text
                variant="caption"
                tone="muted"
                {...({ id: SITE_TYPE_DESC_ID } as object)}
              >
                {siteTypeDescription(t, siteType)}
              </Text>

              <YStack
                gap="$2"
                paddingTop="$3"
                borderTopWidth={1}
                borderTopColor="$borderColorSoft"
              >
                {/* The four swatches show in EVERY answer, at full
                    strength: they are the colours the widget really
                    renders with. Light and Dark stay editable, and
                    since the answer is derived from the params, any
                    change turns it into Custom by itself. */}
                <XStack gap="$3" alignItems="center" flexWrap="wrap">
                  {THEME_KNOBS.map((key) => {
                    const defaultVal = THEME_DEFAULTS[key];
                    // Background has no colour by default: an
                    // untouched embed is TRANSPARENT. Show that
                    // state as the checkerboard; the picker still
                    // opens on the platform surface as a start.
                    const isTransparentBg =
                      key === "bg" && !themeOverrides.bg;
                    const current = knobColors[key] ?? defaultVal;
                    const caption = isTransparentBg
                      ? String(t("admin.embedKnobBgTransparent"))
                      : knobLabel(t, key);
                    return (
                      <Fragment key={key}>
                        <XStack gap="$1" alignItems="center">
                          <label
                            htmlFor={`theme-${key}`}
                            style={{
                              width: 28,
                              height: 28,
                              border: themeOverrides[key]
                                ? "2px solid var(--brandSecondary, #E2481D)"
                                : "2px solid var(--borderColor, #211C16)",
                              // The input inside is invisible (it
                              // only opens the native picker), so
                              // the swatch carries its focus ring.
                              outline:
                                focusedKnob === key
                                  ? "2px solid var(--focus, #E2481D)"
                                  : "none",
                              outlineOffset: 2,
                              display: "block",
                              overflow: "hidden",
                              cursor: "pointer",
                              position: "relative",
                              background: isTransparentBg
                                ? BG_PRESETS[0].css
                                : `#${current}`,
                            }}
                          >
                            <input
                              id={`theme-${key}`}
                              type="color"
                              aria-label={
                                isTransparentBg
                                  ? String(t("admin.embedKnobBgTransparentAria"))
                                  : knobAriaLabel(t, key)
                              }
                              value={`#${current}`}
                              onFocus={() => setFocusedKnob(key)}
                              onBlur={() =>
                                setFocusedKnob((k) =>
                                  k === key ? null : k,
                                )
                              }
                              // Commits only on a real change:
                              // opening the picker and cancelling
                              // leaves Background transparent.
                              // (Keeping the starting colour fires
                              // no change event either — that is
                              // what "Set colour" is for.) Any
                              // change that leaves the params off
                              // a template's reads as Custom.
                              onChange={(e) => {
                                const hex = e.target.value
                                  .replace("#", "")
                                  .toUpperCase();
                                setThemeOverrides((prev) => ({
                                  ...prev,
                                  [key]: hex,
                                }));
                              }}
                              style={{
                                position: "absolute",
                                inset: 0,
                                width: "100%",
                                height: "100%",
                                opacity: 0,
                                cursor: "pointer",
                              }}
                            />
                          </label>
                          <Text variant="caption" tone="muted">
                            {caption}
                          </Text>
                        </XStack>
                        {/* Siblings in the wrapping row, not inside
                            the knob, so they drop to their own line
                            at narrow widths instead of running past
                            the card. Each unmounts when pressed, so
                            each hands focus on: Set colour to the
                            swatch it opens, Clear to the Set colour
                            button that replaces it. */}
                        {isTransparentBg && (
                          <Button
                            size="$2"
                            variant="ghost"
                            aria-label={String(t("admin.embedSetColourAria"))}
                            {...({ id: THEME_BG_SET_ID } as object)}
                            onPress={() => {
                              // The explicit way out of
                              // transparency: commit the starting
                              // colour, then open the picker on it.
                              // Seeded to pair with the text colour
                              // (see backgroundSeed): cancelling the
                              // picker must not leave paper on paper.
                              setThemeOverrides((prev) => ({
                                ...prev,
                                bg: backgroundSeed(prev, THEME_DEFAULTS),
                              }));
                              focusAfterRender(THEME_BG_INPUT_ID, () => {
                                const input = document.getElementById(
                                  THEME_BG_INPUT_ID,
                                ) as HTMLInputElement | null;
                                try {
                                  input?.showPicker();
                                } catch {
                                  input?.click();
                                }
                              });
                            }}
                          >
                            <Text variant="caption" tone="muted">
                              {String(t("admin.embedSetColour"))}
                            </Text>
                          </Button>
                        )}
                        {key === "bg" && themeOverrides.bg && (
                          <Button
                            size="$2"
                            variant="ghost"
                            aria-label={String(t("admin.embedClearBgAria"))}
                            {...({ id: THEME_BG_CLEAR_ID } as object)}
                            onPress={() => {
                              setThemeOverrides((prev) => {
                                const { bg: _bg, ...rest } = prev;
                                return rest;
                              });
                              focusAfterRender(THEME_BG_SET_ID);
                            }}
                          >
                            <Text variant="caption" tone="muted">
                              {String(t("admin.embedClear"))}
                            </Text>
                          </Button>
                        )}
                      </Fragment>
                    );
                  })}
                </XStack>
                {siteType === "custom" ? (
                  <>
                    <Text variant="caption" tone="muted">
                      {String(t("admin.embedCustomNoBgNote"))}
                    </Text>

                    {/* Preview-only: the page colour the preview sits
                        on. Light and Dark pin it; Custom lets the
                        organiser match their own site. */}
                    <YStack gap="$2" paddingTop="$2">
                      <Text variant="caption" weight="bold" tone="muted">
                        {String(t("admin.embedPreviewBgLabel"))}
                      </Text>
                      <XStack gap="$2" alignItems="center" flexWrap="wrap">
                        {BG_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => setPreviewBg(preset.id)}
                            aria-label={String(t(preset.labelKey))}
                            aria-pressed={previewBg === preset.id}
                            style={{
                              width: 32,
                              height: 32,
                              border:
                                previewBg === preset.id
                                  ? "2px solid var(--brandSecondary, #E2481D)"
                                  : "2px solid var(--borderColor, #211C16)",
                              background: preset.css,
                              cursor: "pointer",
                              padding: 0,
                              transition: "border-color 150ms ease-out",
                            }}
                          />
                        ))}
                        <XStack gap="$1" alignItems="center">
                          <label
                            htmlFor="embed-custom-color"
                            style={{
                              width: 32,
                              height: 32,
                              border:
                                previewBg === "custom"
                                  ? "2px solid var(--brandSecondary, #E2481D)"
                                  : "2px solid var(--borderColor, #211C16)",
                              outline:
                                focusedKnob === "preview"
                                  ? "2px solid var(--focus, #E2481D)"
                                  : "none",
                              outlineOffset: 2,
                              display: "block",
                              overflow: "hidden",
                              cursor: "pointer",
                              position: "relative",
                              background: customColor,
                            }}
                          >
                            <input
                              id="embed-custom-color"
                              type="color"
                              aria-label={String(t("admin.embedYourPageColour"))}
                              value={customColor}
                              onFocus={() => setFocusedKnob("preview")}
                              onBlur={() =>
                                setFocusedKnob((k) =>
                                  k === "preview" ? null : k,
                                )
                              }
                              onChange={(e) => {
                                setCustomColor(e.target.value);
                                setPreviewBg("custom");
                              }}
                              style={{
                                position: "absolute",
                                inset: 0,
                                width: "100%",
                                height: "100%",
                                opacity: 0,
                                cursor: "pointer",
                              }}
                            />
                          </label>
                          <Text variant="caption" tone="muted">
                            {String(t("admin.embedYourPageColour"))}
                          </Text>
                        </XStack>
                      </XStack>
                      <Text variant="caption" tone="muted">
                        {String(t("admin.embedPreviewOnlyNote"))}
                      </Text>
                    </YStack>
                  </>
                ) : (
                  <Text variant="caption" tone="muted">
                    {String(t("admin.embedChangeBecomesCustom"))}
                  </Text>
                )}
              </YStack>
            </YStack>
          </StepCard>
        )}

        {/* ── Step 3: How it looks on your site ─────────────── */}
        {!subjectReady ? (
          <LockedStep num={3} title={String(t("admin.embedStep3Title"))}>
            {subjectLockedMessage}
          </LockedStep>
        ) : !hasActiveEmbed ? (
          <LockedStep num={3} title={String(t("admin.embedStep3Title"))}>
            {domainLockedMessage(3)}
          </LockedStep>
        ) : (
          <StepCard num={3} title={String(t("admin.embedStep3Title"))}>
            <Text variant="caption" tone="muted">
              {String(t("admin.embedPreviewDesc"))}
            </Text>

            {/* Dimension controls */}
            <XStack gap="$4" rowGap="$3" alignItems="flex-end" flexWrap="wrap">
              {/* Display — events and booking. The events widget can be
                embedded inline OR as a modal "Get Tickets" button — in
                EITHER view, which is what the old calendar tab (iframe
                only) could not offer; booking can be a modal "Request to
                book" button OR the inline request form. For events this is
                the SAME value as step 4's format switcher (Inline ↔
                HTML/React/SDK, Button ↔ Modal), so the preview always shows
                the snippet being pasted. */}
              {widgetVariant === "events" && (
                <YStack gap="$1" flexShrink={1} minWidth={0}>
                  <FieldLabel>{String(t("admin.embedDisplay"))}</FieldLabel>
                  <SegmentedControl<EventsDisplay>
                    options={eventsDisplayOptions(t)}
                    value={ticketsDisplay}
                    onChange={selectTicketsDisplay}
                    size="sm"
                    ariaLabel={String(t("admin.embedDisplayAria"))}
                    testIdBase="embed-preview-display"
                    wrap
                  />
                </YStack>
              )}
              {widgetVariant === "booking" && (
                <YStack gap="$1" flexShrink={1} minWidth={0}>
                  <FieldLabel>{String(t("admin.embedDisplay"))}</FieldLabel>
                  <SegmentedControl<"modal" | "inline">
                    options={[
                      {
                        value: "modal",
                        label: String(t("admin.embedDisplayButton")),
                      },
                      {
                        value: "inline",
                        label: String(t("admin.embedDisplayInlineForm")),
                      },
                    ]}
                    value={bookingPreviewMode}
                    onChange={setBookingPreviewMode}
                    size="sm"
                    ariaLabel={String(t("admin.embedBookingDisplayAria"))}
                    testIdBase="embed-booking-display"
                    wrap
                  />
                </YStack>
              )}

              {/* Width — preview only. There is no Height control: every
                  inline frame grows to fit on the host page via
                  hf-resize.js, so the snippet's height is only where it
                  starts. */}
              <YStack gap="$1" flexShrink={1} minWidth={0}>
                <FieldLabel>{String(t("admin.embedPreviewWidth"))}</FieldLabel>
                <SegmentedControl<string>
                  options={widthPresets(t)}
                  value={previewWidth}
                  onChange={setPreviewWidth}
                  size="sm"
                  ariaLabel={String(t("admin.embedPreviewWidth"))}
                  testIdBase="embed-preview-width"
                  wrap
                />
              </YStack>
            </XStack>

            {/* Preview — "Button" mode (booking or events) shows the
                LITERAL trigger button that opens the themed modal.
                The inline events widget (either view) and the inline
                booking form render the inline iframe — getPreviewUrl
                already carries `book: true` for booking, so the iframe
                lands on /embed/book/<id>, and `?view=calendar` for the
                calendar view. All sit on the simulated page from step 2
                so the organiser sees how it lands on their own site. */}
            {(() => {
              const showModalButton =
                (widgetVariant === "booking" &&
                  bookingPreviewMode === "modal") ||
                (widgetVariant === "events" &&
                  ticketsDisplay === "modal");
              return (
                <div
                  style={{
                    margin: "0 auto",
                    overflow: "hidden",
                    border: "1px solid var(--borderColor, #211C16)",
                    width: previewWidth,
                    maxWidth: "100%",
                    // The simulated host page follows the answer:
                    // Light and Dark pin a page of that kind; Custom
                    // uses the organiser's chosen preview colour.
                    background:
                      siteType === "light"
                        ? PREVIEW_HOST_LIGHT
                        : siteType === "dark"
                          ? PREVIEW_HOST_DARK
                          : previewBg === "checker"
                            ? BG_PRESETS[0].css
                            : previewBg === "custom"
                              ? customColor
                              : previewBg,
                    transition:
                      "background 150ms ease-out, width 200ms ease-out",
                  }}
                >
                  {showModalButton ? (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "center",
                        padding: 32,
                      }}
                    >
                      <EmbedModalPreview
                        siteUrl={getSiteUrl()}
                        embedId={activeEmbeds[0]!.id}
                        widget={
                          widgetVariant === "booking"
                            ? "booking"
                            : "tickets"
                        }
                        themeEntries={themeEntries}
                        // Booking ignores scope + view; the events
                        // widget honours both, so the preview button
                        // opens exactly what the snippet pastes.
                        scope={
                          widgetVariant === "events"
                            ? effectiveScope
                            : undefined
                        }
                        view={
                          widgetVariant === "events"
                            ? selectedView
                            : undefined
                        }
                        // Snippet output, not page copy: this literal must
                        // match the calendar trigger label hard-coded in
                        // lib/embed-snippets.ts, so the preview shows what
                        // the organiser pastes (in every page language).
                        triggerText={
                          widgetVariant === "events" &&
                          selectedView === "calendar"
                            ? "View calendar"
                            : undefined
                        }
                      />
                    </div>
                  ) : (
                    <iframe
                      src={getPreviewUrl(activeEmbeds[0]!.id)}
                      width="100%"
                      height={effectivePreviewHeight}
                      style={{ border: "none", display: "block" }}
                      title={String(t("admin.embedPreviewFrameTitle"))}
                    />
                  )}
                </div>
              );
            })()}
          </StepCard>
        )}

        {/* ── Step 4: Copy it onto your site ────────────────── */}
        {!subjectReady ? (
          <LockedStep num={4} title={String(t("admin.embedStep4Title"))}>
            {subjectLockedMessage}
          </LockedStep>
        ) : !hasActiveEmbed ? (
          <LockedStep num={4} title={String(t("admin.embedStep4Title"))}>
            {domainLockedMessage(4)}
          </LockedStep>
        ) : (
          <StepCard num={4} title={String(t("admin.embedStep4Title"))}>
            {/* One block per active domain: each row has its own embed id,
                so each domain gets its own code. */}
            {activeEmbeds.map((embed, index) => (
              <EmbedCard
                key={embed.id}
                embed={embed}
                isFirst={index === 0}
                variant={widgetVariant}
                view={selectedView}
                bookingMode={bookingPreviewMode}
                format={snippetFormat}
                onFormatChange={setSnippetFormat}
                snippet={getEmbedSnippet(embed.id, effectivePreviewHeight)}
                previewUrl={getPreviewUrl(embed.id)}
                previewHeight={effectivePreviewHeight}
                snippetOptions={snippetOptions}
                canEdit={canEdit}
                onCopy={copyToClipboard}
                onToggleLinkOut={handleToggleLinkOut}
                isTogglingLinkOut={linkOutMutation.isPending}
                copiedId={copiedId}
                t={t}
              />
            ))}
          </StepCard>
        )}
      </YStack>
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field label in the mono label idiom (overline: 11px with its tracking).
 * Replaces the hand-uppercased caption labels so every label on the page
 * reads the same.
 */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text variant="overline" tone="muted">
      {children}
    </Text>
  );
}

/**
 * The step heading: a real <h3> (the page title is the h2) whose text is
 * "1 What it shows", so the number is part of what a screen reader reads.
 * The number box is a border graphic, so `$accent` is fine there; the digit
 * itself is small text and takes `$accentText` (the AA rung).
 */
function StepHeading({
  num,
  title,
  locked = false,
}: {
  num: number;
  title: string;
  locked?: boolean;
}) {
  return (
    <XStack tag="h3" gap="$3" alignItems="center" margin={0}>
      <XStack
        tag="span"
        width={28}
        height={28}
        flexShrink={0}
        alignItems="center"
        justifyContent="center"
        borderWidth={2}
        borderColor={locked ? "$colorMuted" : "$accent"}
      >
        <Text
          tag="span"
          variant="label"
          weight="bold"
          color={locked ? "$colorMuted" : "$accentText"}
        >
          {num}
        </Text>
      </XStack>
      <Text
        tag="span"
        variant="h4"
        weight="bold"
        color={locked ? "$colorMuted" : "$color"}
        // One step under the page title's own $sm size ($5), so a step
        // title isn't three lines tall at 320.
        $sm={{ fontSize: "$4", lineHeight: "$4" }}
        style={{ textTransform: "uppercase" }}
      >
        {title}
      </Text>
    </XStack>
  );
}

function StepCard({
  num,
  title,
  children,
}: {
  num: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    // $3 at ≤480: the admin shell leaves the card ~210px at 320, and the
    // widest buttons inside (Open preview, the guide tabs) need the 8px.
    <CardSurface
      padding="$4"
      gap="$3"
      $sm={{ padding: "$3" }}
      testID={`embed-step-${num}`}
    >
      <StepHeading num={num} title={title} />
      {children}
    </CardSurface>
  );
}

/**
 * A step that can't be used yet: dashed border, muted text, no inputs — just
 * which earlier step unlocks it. Deliberately not a CardSurface, so it reads
 * as a placeholder beside the live cards.
 */
function LockedStep({
  num,
  title,
  children,
}: {
  num: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <YStack
      padding="$4"
      gap="$2"
      $sm={{ padding: "$3" }}
      borderWidth={2}
      borderStyle="dashed"
      borderColor="$colorMuted"
      testID={`embed-step-${num}-locked`}
    >
      <StepHeading num={num} title={title} locked />
      <Text variant="body" tone="muted">
        {children}
      </Text>
    </YStack>
  );
}

function EmbedCard({
  embed,
  isFirst,
  variant,
  view = DEFAULT_EMBED_VIEW,
  bookingMode = "modal",
  format,
  onFormatChange,
  snippet,
  previewUrl,
  previewHeight,
  snippetOptions,
  canEdit,
  onCopy,
  onToggleLinkOut,
  isTogglingLinkOut,
  copiedId,
  t,
}: {
  embed: { id: string; domain: string; linkOut: boolean };
  /** First block in step 4; later ones get a rule above them. */
  isFirst: boolean;
  /**
   * "booking" (place subject) ships ONE snippet per display mode (see
   * `bookingMode`); "events" gets the full HTML/React/SDK/Modal switcher in
   * EITHER view.
   */
  variant: WidgetVariant;
  /**
   * Which browse view the emitted snippets pin. Already baked into `snippet`
   * / `previewUrl` / `snippetOptions`; the card only reads it for the copy
   * key. Ignored for booking.
   */
  view?: EmbedView;
  /**
   * Which booking snippet `snippet` currently is — the modal trigger button
   * or the inline form iframe. Drives the copy-state key and the resize
   * note; ignored for non-booking variants.
   */
  bookingMode?: "modal" | "inline";
  /**
   * The events code format, owned by EmbedsView so step 3's Display control
   * and this switcher are one choice. Ignored for booking and memberships.
   */
  format: SnippetFormat;
  onFormatChange: (next: SnippetFormat) => void;
  snippet: string;
  previewUrl: string;
  previewHeight: number;
  snippetOptions: EmbedSnippetOptions;
  /** Whether the actor may edit (ORG_EDIT_ROLES). Read + copy stay open. */
  canEdit: boolean;
  onCopy: (text: string, id: string) => void;
  onToggleLinkOut: (domain: string, linkOut: boolean) => void;
  isTogglingLinkOut: boolean;
  copiedId: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const isBooking = variant === "booking";
  // Memberships ships ONE inline snippet (no format switcher, no link-mode
  // control, no views) — the booking card's shape, minus the display-mode
  // fork, so it shares booking's single-snippet branches below.
  const isMemberships = variant === "memberships";
  const isSingleSnippet = isBooking || isMemberships;
  // Copy-state key. Includes the VARIANT and the VIEW because the same
  // EmbedCard instance (keyed by embed.id) survives both a page-tab switch and
  // a view flip — without them, a fresh "copied" checkmark would bleed onto a
  // DIFFERENT snippet under the same format name. Booking has no format
  // switcher but DOES have two display modes (button vs inline form) served by
  // the same card, so the key carries the mode for the same reason. The
  // format is lifted to EmbedsView now, but it still lands in the key here,
  // so flipping step 3's Display clears a stale checkmark too.
  const snippetKey = isBooking
    ? `${embed.id}-booking-${bookingMode}`
    : isMemberships
      ? `${embed.id}-memberships`
      : `${embed.id}-${variant}-${view}-${format}`;
  const isCopied = copiedId === snippetKey;

  // Which resize note is true for the snippet on screen (embed-format.helpers
  // has the per-format reasoning). Nothing on this page sets a height any
  // more, so no note points at a control.
  const resizeNote = resizeNoteFor({
    variant,
    format,
    bookingMode,
  });

  const siteUrl = getSiteUrl();

  const activeSnippet = useMemo(() => {
    if (isSingleSnippet) return snippet;
    switch (format) {
      case "html":
        return snippet;
      case "react":
        return buildTicketsReactSnippet({
          embedId: embed.id,
          src: previewUrl,
          height: previewHeight,
        });
      case "modal":
        return buildTicketsModalSnippet(siteUrl, embed.id, snippetOptions);
      case "sdk":
      default:
        return buildTicketsSdkSnippet(siteUrl, embed.id, snippetOptions);
    }
  }, [
    isSingleSnippet,
    format,
    snippet,
    embed.id,
    previewUrl,
    previewHeight,
    siteUrl,
    snippetOptions,
  ]);

  // The setup guides say "paste the code below", so they carry the format on
  // screen — except React, which no site builder's HTML block can run; the
  // guides fall back to the HTML snippet there.
  const guideSnippet =
    !isSingleSnippet && format === "react" ? snippet : activeSnippet;

  const copyThis = () => onCopy(activeSnippet, snippetKey);

  return (
    <YStack
      gap="$3"
      {...(isFirst
        ? {}
        : {
            paddingTop: "$4",
            borderTopWidth: 2,
            borderTopColor: "$borderColor",
          })}
      testID={`embed-code-${embed.id}`}
    >
      {/* "Code for <domain>" + copy. The domain is in every name so two
          domains' blocks never share an accessible name. */}
      <XStack
        gap="$3"
        rowGap="$2"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
      >
        <Text
          variant="body"
          weight="bold"
          flexShrink={1}
          minWidth={0}
          style={{ overflowWrap: "anywhere" }}
        >
          {String(t("admin.embedCodeFor", { domain: embed.domain }))}
        </Text>
        <Button
          variant="secondary"
          size="$3"
          onPress={copyThis}
          aria-label={String(
            t(isCopied ? "admin.embedCopiedCodeFor" : "admin.embedCopyCodeFor", {
              domain: embed.domain,
            }),
          )}
        >
          {isCopied ? <Check size={14} /> : <Copy size={14} />}
          {isCopied
            ? String(t("admin.embedCopiedShort"))
            : String(t("admin.embedCopyShort"))}
        </Button>
      </XStack>

      {/* Code block */}
      <EmbedCodeBlock
        code={activeSnippet}
        isCopied={isCopied}
        onCopy={copyThis}
        copyLabel={String(
          t("admin.embedCopyEmbedCodeFor", { domain: embed.domain }),
        )}
      />

      {/* Snippet-format switcher — hidden for booking in BOTH display
          modes (one snippet per mode; step 3's Display control picks
          between them) and for memberships. The events widget shows the
          full set (SNIPPET_TABS) in either view, and its value is
          step 3's Display value too: React or JS SDK selects Inline there,
          Modal selects Button.

          SegmentedControl, not a hand-rolled `role="tablist"`: there are no
          tabpanels here (one code block swaps its contents), so tab roles
          would promise a keyboard model that doesn't exist — the exact
          dishonest-ARIA pattern the SavedEvents migration retired. */}
      {!isSingleSnippet && (
        <YStack gap="$1">
          <FieldLabel>{String(t("admin.embedFormat"))}</FieldLabel>
          <SegmentedControl<SnippetFormat>
            options={SNIPPET_TABS}
            value={format}
            onChange={onFormatChange}
            size="sm"
            ariaLabel={String(
              t("admin.embedFormatAria", { domain: embed.domain }),
            )}
            testIdBase="embed-snippet-tab"
            wrap
          />
        </YStack>
      )}

      {/* The resize note true for this format. HTML, the inline booking form
          and memberships ship the hf-resize.js line; the JS SDK sizes its
          own frame; the React snippet has no resize script, so it says how
          tall it stays and how to change that. Modal triggers (the booking
          button, events in "modal" format) have no frame on the page. */}
      {resizeNote && (
        <Text variant="caption" tone="muted">
          {resizeNote === "hfResize"
            ? String(t("admin.embedAutoResizeNote"))
            : resizeNote === "sdk"
              ? String(t("admin.embedResizeSdk"))
              : String(
                  t("admin.embedResizeFixed", {
                    height: previewHeight,
                    code: `height={${previewHeight}}`,
                  }),
                )}
        </Text>
      )}

      {/* CMS setup guides */}
      <EmbedCmsGuides
        htmlSnippet={guideSnippet}
        siteUrl={siteUrl}
        domain={embed.domain}
      />

      {/* Link mode — in-page checkout vs open Ithas Fire in a new tab.
          EVENTS ONLY: it swaps in-iframe checkout for a "Get Tickets on
          Ithas Fire" CTA, which a booking button has no equivalent of.
          View-independent by design — it applies to list and calendar alike.
          Editing the mode is ORG_EDIT_ROLES; read-only roles don't see it. */}
      {canEdit && variant === "events" && (
        <YStack gap="$2">
          <FieldLabel>{String(t("admin.embedLinkOutLabel"))}</FieldLabel>
          <Text variant="caption" tone="muted">
            {String(t("admin.embedLinkOutDescription"))}
          </Text>
          {/* SegmentedControl handles the "only fire on a real change"
              guard itself, plus the radiogroup keyboard model the old
              two-Button group lacked. */}
          <SegmentedControl<LinkOutMode>
            options={[
              {
                value: "inPage",
                label: String(t("admin.embedLinkOutModeInPage")),
              },
              {
                value: "newTab",
                label: String(t("admin.embedLinkOutModeNewTab")),
              },
            ]}
            value={embed.linkOut ? "newTab" : "inPage"}
            onChange={(mode) => onToggleLinkOut(embed.domain, mode === "newTab")}
            disabled={isTogglingLinkOut}
            fullWidth
            ariaLabel={String(
              t("admin.embedLinkOutLabelFor", { domain: embed.domain }),
            )}
            testIdBase="embed-linkout"
          />
        </YStack>
      )}

      <XStack>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => window.open(previewUrl, "_blank")}
          aria-label={String(
            t("admin.embedOpenPreviewFor", { domain: embed.domain }),
          )}
        >
          <ExternalLink size={14} />
          {String(t("admin.embedOpenPreview"))}
        </Button>
      </XStack>
    </YStack>
  );
}
