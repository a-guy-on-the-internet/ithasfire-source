"use client";

import { memo, type ComponentProps, type ReactNode, type Ref } from "react";
import { XStack, YStack } from "tamagui";
import {
  ArrowLeft,
  Ban,
  ExternalLink,
  EyeOff,
  Link as LinkIcon,
} from "lucide-react";

import { Text, useTranslations } from "@th/ui";

import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { guardedNavigate } from "@/hooks/navigation-guard";

import { EventStatusBadge } from "../../_components/EventStatusBadge";
import { EventViewModeToggle, type EventViewMode } from "./EventViewModeToggle";

/**
 * The builder's sticky top bar — ONE bar, owned entirely by the page:
 *
 * - back arrow, live title, status (inline, beside the title);
 * - the Edit|Preview toggle;
 * - Share (`secondaryActions`, a ghost), the commit pair (`actions`: Save /
 *   Publish, pre-rendered by `EventBuilder`), and the `⋯` menu, last.
 *
 * Each control has exactly one activation path, here — there is no
 * shell-rendered action bar behind it.
 *
 * One quiet row (2026-09-15). The row used to hold six framed controls at
 * equal weight, with the status chip flush against the toggle's dark EDIT
 * segment so "DRAFT · EDIT · PREVIEW" read as one control, and two exits to
 * one destination (the back arrow and a trailing ✕). Now:
 *
 * - the back arrow is the ONE way out (the ✕ is gone; Escape in
 *   `EventBuilder` still leaves);
 * - the status is text beside the title, not a chip beside the toggle;
 * - the ⋯ is unframed and last, and takes Unpublish, so a published event
 *   puts one ghost (Share) and one fill (Save) on the row instead of four
 *   outlined buttons;
 * - groups are separated by spacing, not rules: `$3` between the toggle and
 *   the button group, `$2` inside it;
 * - the commit pair reserves its wider label's width (`StableActionLabel`),
 *   so Save → Saving never shoves the title.
 *
 * Two layouts:
 * - Desktop: one row — [← title status] … [Edit|Preview] [Share] [Save]
 *   [Publish] [⋯].
 * - Mobile: row 1 is the title's (back arrow, title, ⋯); row 2 wraps the
 *   status, the toggle and the buttons — at 320px the toggle takes its own
 *   line rather than shrinking below its label width.
 *
 * `Cancel event` (destructive — cancels the real event and notifies buyers)
 * always lives in the ⋯ overflow, last, never inline.
 *
 * Memoized: it legitimately re-renders while the title is typed (it shows the
 * title), but it bails out of every OTHER builder state change — which is why
 * `EventBuilder` hands the whole action strip down as ONE pre-rendered node
 * and wraps every handler it passes in `useStableHandler`. Nothing pins the
 * bail-out itself: EventBuilderRenderIsolation.test.tsx mocks this component
 * to null and pins that the section components are memoized and that the
 * builder's own re-renders stay out of them, not that this bar skips work.
 */

const TITLE_STYLE = { minWidth: 0 } as const;

/**
 * Desktop title: takes whatever the fixed neighbours leave, and contributes
 * NOTHING to the leading group's intrinsic width (`contain: inline-size`).
 * That is what lets the group floor at its fixed content — back arrow, gap,
 * status, padding — instead of at the untruncated title: the group is
 * `flexShrink: 0` with an `auto` basis, so under pressure the tools cluster
 * wraps and the title truncates, and the status never lands on the toggle.
 * Without `contain`, an `auto` basis would be the whole title and nothing
 * would ever truncate.
 *
 * `minWidth` is the floor the title keeps before the tools cluster wraps;
 * without it the flex algorithm drains the title to an ellipsis first.
 */
const DESKTOP_TITLE_STYLE = {
  minWidth: 120,
  contain: "inline-size",
} as const;

/**
 * Sticky because the actions must stay reachable down a long builder page.
 * The style is INLINE on a plain <div>: Tamagui's react-native-web layer
 * silently strips `position: "sticky"` from styled stacks (RN has no such
 * keyword), so a styled(YStack) would render static.
 */
const STICKY_BAR_STYLE = {
  position: "sticky",
  top: 0,
  zIndex: 100,
  backgroundColor: "var(--surface, #FDFAF3)",
  borderBottom: "2px solid var(--structure, #211C16)",
} as const;

export type BuilderHeaderBarProps = {
  /** Measured by the builder's ResizeObserver to drive scroll offsets. */
  stickyBarRef: Ref<HTMLDivElement>;
  slug?: string;
  title: string;
  eventStatus: ComponentProps<typeof EventStatusBadge>["status"];
  canEditEvent: boolean;
  /** The edit payload has loaded — gates the Edit|Preview toggle. */
  eventLoaded: boolean;
  isPreviewMode: boolean;
  onViewModeChange: (mode: EventViewMode) => void;
  isMobile: boolean;
  isCancelling: boolean;
  /**
   * Opens the "cancel this event" confirmation. OMITTED (not just disabled)
   * when the surface has no cancel path at all — a community listing, whose
   * `cancelEvent` admits platform ADMINs only. An absent handler removes the
   * `⋯` item rather than offering one that fails.
   */
  onRequestCancelEvent?: () => void;
  /**
   * Opens the "take down this listing" confirmation. A community listing's
   * take-down, for a platform ADMIN (`showTakeDownListing` in
   * `builder-admin-action-gates.ts`). Not subject to `canEditEvent`: the
   * server decides on the role. Absent removes the `⋯` item.
   */
  onRequestTakeDownListing?: () => void;
  /**
   * Save / Publish, pre-rendered by `EventBuilder` as ONE node so this
   * component's `memo` bail-out survives (it re-renders on every title
   * keystroke).
   */
  actions?: ReactNode;
  /**
   * Share — reversible, non-committing, a ghost. Sits between the toggle and
   * the commit pair so the fill at the end of the row is the only thing
   * carrying weight.
   */
  secondaryActions?: ReactNode;
  /**
   * Takes a PUBLISHED event off the public page. A `⋯` item, not a button:
   * it is reversible and rare, and inline it was the fourth outlined control
   * on the row. Passed only when the builder's gate allows it (owned, admin
   * bar, published — see `builder-admin-action-gates.ts`) — an absent handler
   * removes the item.
   */
  onUnpublish?: () => void;
  /**
   * Opens the builder's own preview (`?view=preview`) in a new tab — NOT the
   * public page, which cannot render a draft for anyone. Lives in the `⋯` menu
   * rather than inline: as an icon-only button pressed against a labelled
   * Preview it read as part of that button, and its own comment admitted the
   * label had been dropped because the neighbour "already carries the word".
   * Absent on a published event, where the rail's View event covers it.
   */
  onOpenLiveDraft?: () => void;
  /**
   * Copies the event's public URL to the clipboard. The builder is where a
   * host is standing when someone asks them for the link, and the rail's
   * `View event` navigates to the page rather than handing over its address.
   *
   * Absent (prop omitted) until the event has a public slug — `EventBuilder`
   * owns that gate, because a never-published event's public URL 500s.
   */
  onCopyEventLink?: () => void;
  /**
   * Opens the event's LIVE PUBLIC page in a new tab, for a PUBLISHED event.
   *
   * The 2026-08-30 decision put the one "View event" activation in the admin
   * rail's context header and deliberately kept it off this bar. That still
   * holds for the rail, but it left the `⋯` menu with no route to the live
   * page at all once published: `onOpenLiveDraft` is gated
   * `eventStatus !== "PUBLISHED"`, so publishing REMOVED the only item here
   * that opened the page. A host standing in the builder had to go find the
   * rail. This restores a path from the menu without touching the rail's.
   *
   * Distinct from `onOpenLiveDraft` on purpose — that one is the pre-publish
   * draft ("Open in new tab"), this is the live page ("View event") — so the
   * two are never offered at the same time.
   */
  onViewEvent?: () => void;
};

function BuilderHeaderBarImpl({
  stickyBarRef,
  slug,
  title,
  eventStatus,
  canEditEvent,
  eventLoaded,
  isPreviewMode,
  onViewModeChange,
  isMobile,
  isCancelling,
  onRequestCancelEvent,
  onRequestTakeDownListing,
  actions,
  secondaryActions,
  onUnpublish,
  onOpenLiveDraft,
  onCopyEventLink,
  onViewEvent,
}: BuilderHeaderBarProps) {
  const t = useTranslations();

  const requestCancelEvent =
    canEditEvent && (eventStatus === "DRAFT" || eventStatus === "PUBLISHED")
      ? onRequestCancelEvent
      : undefined;

  // Overflow "⋯" menu — the same set on every width, each item present only
  // with its handler. Order: the ways to look at the event, then the
  // reversible change, then the destructive one, last.
  const overflowCandidates: Array<RowActionMenuItem | undefined> = [
    onViewEvent && {
      key: "view-event",
      label: String(t("pageActions.viewEvent")),
      icon: <ExternalLink size={16} aria-hidden />,
      testId: "event-view-live",
      onPress: onViewEvent,
    },
    onCopyEventLink && {
      key: "copy-event-link",
      label: String(t("eventDetail.shareCopyLink")),
      icon: <LinkIcon size={16} aria-hidden />,
      testId: "event-copy-link",
      onPress: onCopyEventLink,
    },
    onOpenLiveDraft && {
      key: "open-live-draft",
      label: String(t("admin.ebPreviewNewTab")),
      icon: <ExternalLink size={16} aria-hidden />,
      // Kept from the retired inline button so existing specs still address
      // the same action, now with a real label instead of a bare icon.
      testId: "event-preview-link",
      onPress: onOpenLiveDraft,
    },
    onUnpublish && {
      key: "unpublish",
      label: String(t("pageActions.unpublishEvent")),
      icon: <EyeOff size={16} aria-hidden />,
      // Same id the inline button carried, so specs address the same action.
      testId: "event-unpublish-btn",
      onPress: onUnpublish,
    },
    requestCancelEvent && {
      key: "cancel-event",
      label: isCancelling
        ? String(t("admin.ebCancelling"))
        : String(t("admin.ebCancelEvent")),
      tone: "danger",
      disabled: isCancelling,
      icon: <Ban size={16} aria-hidden />,
      testId: "event-cancel-event-btn",
      onPress: requestCancelEvent,
    },
    onRequestTakeDownListing && {
      key: "take-down-listing",
      label: isCancelling
        ? String(t("admin.ebTakingDown"))
        : String(t("admin.ebTakeDownListing")),
      tone: "danger",
      disabled: isCancelling,
      icon: <Ban size={16} aria-hidden />,
      testId: "event-takedown-listing-btn",
      onPress: onRequestTakeDownListing,
    },
  ];
  const overflowItems = overflowCandidates.filter(
    (item): item is RowActionMenuItem => item !== undefined,
  );

  const overflowMenu: ReactNode =
    overflowItems.length > 0 ? (
      <RowActionMenu
        items={overflowItems}
        triggerVariant="ghost"
        ariaLabel={String(t("pageActions.moreActions") ?? "More actions")}
      />
    ) : null;

  const backButton = slug ? (
    <XStack
      // Was a bare div: aria-label but no role and no tab stop, so keyboard
      // users could not reach it. It is the only nav affordance in the mobile
      // header, so that mattered more after the two-row rework (NFR-002).
      tag="button"
      // No `type="button"`: Tamagui's view props don't accept it, and the
      // builder has no <form> ancestor, so there is no implicit submit to
      // suppress (same shape as TicketScheduledPriceField).
      cursor="pointer"
      // Through the unsaved-changes guard, so it asks with the same dialog
      // as every other way out instead of the browser's own prompt.
      onPress={() => {
        guardedNavigate(() => {
          window.location.href = `/admin/${slug}/events`;
        });
      }}
      alignItems="center"
      justifyContent="center"
      padding={6}
      borderWidth={0}
      backgroundColor="transparent"
      borderRadius={0}
      flexShrink={0}
      hoverStyle={{ backgroundColor: "$surfaceMuted" }}
      focusVisibleStyle={{
        outlineWidth: 2,
        outlineStyle: "solid",
        outlineColor: "$accent",
        outlineOffset: -2,
      }}
      data-testid="event-builder-back"
      aria-label={t("admin.ebBackToEvents") as string}
    >
      <ArrowLeft size={20} color="currentColor" />
    </XStack>
  ) : null;

  const titleNode = (
    <Text
      variant="h3"
      weight="bold"
      truncate
      flex={1}
      // Both widths take every pixel the fixed controls leave (flex 1);
      // phones additionally drop to a compact heading scale — 32px hero
      // type in a 64px bar left ~3 characters.
      {...(isMobile
        ? { fontSize: "$6" as const, lineHeight: "$6" as const }
        : undefined)}
      style={isMobile ? TITLE_STYLE : DESKTOP_TITLE_STYLE}
      data-testid="event-builder-title"
    >
      {title.trim() || String(t("admin.ebUntitledEvent"))}
    </Text>
  );

  // Inline, not a chip: a suffix to the title, in the mono label idiom. It
  // never shrinks — the title is the one thing on the row that gives.
  const statusInline = (
    <XStack flexShrink={0}>
      <EventStatusBadge status={eventStatus} appearance="inline" />
    </XStack>
  );

  // Edit | Preview toggle (D4 reversed): the primary preview affordance —
  // swaps the builder's main column to the in-place preview of the CURRENT
  // form state. Editors only, gated on the edit payload so the preview never
  // opens on an empty form.
  const viewModeToggle =
    canEditEvent && eventLoaded ? (
      <EventViewModeToggle
        value={isPreviewMode ? "preview" : "edit"}
        onChange={onViewModeChange}
      />
    ) : null;

  if (isMobile) {
    return (
      <div ref={stickyBarRef} style={STICKY_BAR_STYLE}>
        <YStack
          width="100%"
          minWidth={0}
          gap="$2"
          paddingVertical="$2"
          paddingHorizontal="$3"
        >
          {/* Row 1 is the title's: only the back arrow and the ⋯ take width
              from it. */}
          <XStack alignItems="center" gap="$2" width="100%" minWidth={0}>
            {backButton}
            {titleNode}
            {overflowMenu}
          </XStack>
          {/* Row 2: status left, toggle right. Wraps rather than compresses:
              if the toggle cannot sit beside the status it takes its own line
              — shrinking it made its labels paint over each other. */}
          <XStack
            alignItems="center"
            flexWrap="wrap"
            gap="$2"
            width="100%"
            minWidth={0}
          >
            {statusInline}
            <XStack flex={1} minWidth={0} />
            {viewModeToggle}
          </XStack>
          {/* Row 3: Share (content-sized) and the commit pair, which
              `EventBuilder` renders `flex: 1` on mobile so they split this
              row equally and never stack — four lines of sticky chrome at
              320px is what a wrapping row produced. Omitted when there is
              nothing to commit. */}
          {secondaryActions || actions ? (
            <XStack alignItems="center" gap="$2" width="100%" minWidth={0}>
              {secondaryActions}
              {actions}
            </XStack>
          ) : null}
        </YStack>
      </div>
    );
  }

  return (
    <div ref={stickyBarRef} style={STICKY_BAR_STYLE}>
      <XStack alignItems="center" width="100%" minWidth={0}>
        <XStack
          gap="$3"
          alignItems="center"
          // Grows into everything the tools leave; never shrinks below its
          // own fixed content (see DESKTOP_TITLE_STYLE for why the title
          // does not count). Measured failure this replaces: a 625px bar
          // (the rail had grown to fit a long title) squeezed this group to
          // nothing — title 0px wide, status 2px from the toggle.
          flexGrow={1}
          flexShrink={0}
          flexBasis="auto"
          minWidth={0}
          paddingVertical="$2"
          paddingLeft="$5"
          // Never less than 24px between the status and the toggle's dark
          // EDIT segment — flush, "DRAFT · EDIT · PREVIEW" read as one
          // control.
          paddingRight="$5"
        >
          {backButton}
          {titleNode}
          {statusInline}
        </XStack>
        {/* The tools cluster is the one thing on the row that gives after the
            title: it wraps (toggle stays, buttons drop a line, packed right)
            rather than pushing into the leading group. */}
        <XStack
          gap="$3"
          alignItems="center"
          justifyContent="flex-end"
          paddingRight="$5"
          flexShrink={1}
          minWidth={0}
          flexWrap="wrap"
          data-testid="event-builder-tools"
        >
          {viewModeToggle}
          {secondaryActions || actions || overflowMenu ? (
            <XStack
              gap="$2"
              alignItems="center"
              justifyContent="flex-end"
              flexWrap="wrap"
            >
              {secondaryActions}
              {actions}
              {overflowMenu}
            </XStack>
          ) : null}
        </XStack>
      </XStack>
    </div>
  );
}

export const BuilderHeaderBar = memo(BuilderHeaderBarImpl);

BuilderHeaderBar.displayName = "BuilderHeaderBar";
