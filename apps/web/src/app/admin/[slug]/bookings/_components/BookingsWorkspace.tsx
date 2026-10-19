"use client";

import { useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { XStack, YStack, styled } from "tamagui";
import {
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { orgSettingsSectionHref } from "@/app/admin/[slug]/settings/_lib/org-settings-routes";
import { settingsSectionHref } from "@/app/account/settings/_lib/settings-routes";
import { useOrgPerformerEnabled } from "@/app/admin/[slug]/settings/_hooks/useOrgPerformerEnabled";

import { AvailabilitySetupBanner } from "./AvailabilitySetupBanner";
import { OrgReceivedRequestsTable } from "./OrgReceivedRequestsTable";
import { BookingInbox } from "@/components/bookings/BookingInbox";
import { BOOKING_INBOX_REQUEST_PARAM } from "@/components/bookings/booking-inbox-deep-link";
import { SentToActsList } from "./SentToActsList";

/**
 * Three DIFFERENT relationships, deliberately not merged into one list:
 *
 * - `venues`   — acts asking to play at a place this org owns (TO_VENUE, in);
 * - `received` — organizers asking this org to perform (TO_PERFORMER, in);
 * - `sent`     — this org asking acts to perform (TO_PERFORMER, out).
 *
 * "Requests to our venues" and "requests to us as an act" are answered by
 * different people, create different agreements and mean different things.
 * They share a page, never a list.
 *
 * Two of the three are CONDITIONAL — `venues` on owning any venue, `received`
 * on the org being an act — so the union stays three-valued while the rendered
 * set is computed once into `tabOrder`. Ordering, the landing tab, the clamp
 * and the arrow-key ring all read that one array.
 */
type WorkspaceTab = "venues" | "received" | "sent";

const TAB_PANEL_ID = "bookings-workspace-panel";

function workspaceTabId(tab: WorkspaceTab): string {
  return `bookings-workspace-tab-${tab}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives (the house tab strip — same pattern as BookingInbox)
// ─────────────────────────────────────────────────────────────────────────────

const PageContainer = styled(YStack, {
  name: "BookingsWorkspacePage",
  gap: "$4",
  padding: "$4",
  width: "100%",
  maxWidth: 1000,
  marginHorizontal: "auto",
  $gtMd: { padding: "$6" },
});

const TabStrip = styled(XStack, {
  name: "BookingsWorkspaceTabs",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  gap: "$1",
  // MEASURED at 320px inside the admin shell: the tab row gets 206px of
  // content width, and three labelled tabs need more than that. Tamagui
  // inherits RN's `flexShrink: 0`, so without this the third tab pushes the
  // DOCUMENT wider than the viewport and hangs off the right edge. Wrapping
  // keeps every tab reachable — a horizontally-scrolling strip would hide one,
  // which is the same class of bug this page is being fixed for.
  flexWrap: "wrap",
});

// Stand-in for the strip when only ONE panel survives the tab gating. A
// one-tab tablist is a lie to a screen reader (nothing to switch to) and reads
// as a broken control, but dropping the label entirely would leave an unheaded
// list of rows under a generic "Bookings" title. Same 2px rule, same height —
// the page keeps its rhythm.
const SoloHeader = styled(XStack, {
  name: "BookingsWorkspaceSoloHeader",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  paddingVertical: "$3",
  minHeight: 44,
  alignItems: "center",
});

// Renders as a native <button> so Enter and Space activate the tab without a
// bespoke key handler; arrow keys are wired below (ARIA tabs pattern).
const TabButton = styled(XStack, {
  name: "BookingsWorkspaceTab",
  tag: "button",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderStyle: "solid",
  // Tight at 320px on purpose — "Requests to you (12)" + "Sent to acts" only
  // clear a 288px content box with the compact padding. Paired with
  // flexShrink/minWidth so the strip can never push the PAGE into horizontal
  // scroll: worst case a label wraps inside its own tab.
  paddingHorizontal: "$2",
  paddingVertical: "$3",
  minHeight: 44,
  flexShrink: 1,
  minWidth: 0,
  alignItems: "center",
  cursor: "pointer",
  borderBottomWidth: 2,
  borderBottomColor: "transparent",
  marginBottom: -2,
  $gtXs: { paddingHorizontal: "$3" },
  variants: {
    active: {
      true: { borderBottomColor: "$accent" },
    },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Org-level Bookings workspace — the one first-class Bookings destination.
 *
 *   • "To your venues"    — EVERY request across every venue the org owns, in
 *                           one list, readable and answerable in place. This
 *                           replaced a block of link-outs: an org running six
 *                           venues used to have to open six inboxes to find
 *                           out whether anyone wanted to play, and could not
 *                           read, reply to, accept or decline anything without
 *                           first picking one.
 *   • "To you as an act"  — the org-as-act inbox (organizers asking the group
 *                           to perform). Different direction, different
 *                           counterparty, different agreement — never folded
 *                           into the venue list. GATED on performer mode: a
 *                           group that runs venues and never performs was
 *                           carrying this tab permanently empty. See
 *                           `showReceived` for why it hides on positive
 *                           knowledge only.
 *   • "Sent to acts"      — the org's outbound requests. NOT gated: booking
 *                           other people is an organizer activity and says
 *                           nothing about whether this group performs.
 *
 * ONE COUNT QUERY plus the shared performer-status read. `bookingRequests.
 * countOpen` supplies the tab badges AND the venue filter's set/names/counts,
 * replacing the old hub's capped fan-out of up to 12 full list queries;
 * `performers.getMyStatus` (via `useOrgPerformerEnabled`, the single owner of
 * that query's options) decides whether the act inbox is a tab at all. The
 * cross-venue ROWS come from one further query (`list` scope `org-venues`),
 * issued by the venues panel only when that panel is mounted. Route id, path,
 * nav item and the ORG_NON_SCANNER view gate are unchanged; respond/withdraw
 * stay server-gated to ORG_EDIT_ROLES inside the use cases.
 *
 * HUMAN admin context (`/admin/@me/bookings`) — a person can hold venues
 * DIRECTLY (PlaceOwnership with a human owner), and those requests used to
 * dead-end here behind a pointer to account settings. Now the same venues
 * panel renders with `countOpen({ owner: { kind: "human" } })` and the
 * `human-venues` list scope. ONLY the venues relationship applies: the
 * person's own act-side inbox and sent requests live in account settings
 * (Booking requests), so "To you as an act" and "Sent to acts" are never
 * rendered for a human, and a person who owns no venues still gets the
 * settings pointer instead of an empty page.
 */
export function BookingsWorkspace() {
  const { slug } = useParams<{ slug: string }>();
  const t = useTranslations();
  const { currentOwner, isLoading: ownerLoading } = useCurrentAdminOwner(slug);

  const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : null;
  const isHuman = currentOwner?.kind === "human";

  // One selector per owner kind. `{ orgId }` is the legacy shorthand the org
  // page has always sent; the human form has no id because the owner IS the
  // session actor (the server refuses to count anyone else's venues).
  const countQuery = trpc.bookingRequests.countOpen.useQuery(
    orgId !== null ? { orgId } : { owner: { kind: "human" as const } },
    {
      enabled: orgId !== null || isHuman,
      staleTime: 30_000,
      retry: false,
      meta: { silent: true },
    },
  );

  // Performer mode — the ONLY thing that makes "To you as an act" meaningful.
  // Same hook the settings routes use, so `getMyStatus` keeps exactly one set
  // of react-query options across the app.
  const performerStatus = useOrgPerformerEnabled(orgId, true);

  const venues = countQuery.data?.venues ?? [];
  const openReceivedCount = countQuery.data?.performerInbox ?? 0;
  const openVenueCount = venues.reduce(
    (sum, venue) => sum + venue.openCount,
    0,
  );

  // A pure-act org owns no venues, so the venues tab has nothing behind it and
  // is not rendered. On a FAILED count the venue set is unknown — the tab is
  // kept, because the cross-venue list is a SEPARATE query that may well
  // succeed, and hiding the page's primary surface on a badge failure would
  // hide requests.
  const hasVenuesTab = countQuery.isError || venues.length > 0;

  // ── "To you as an act" is gated on performer mode ────────────────────────
  //
  // An org that runs venues and never performs was carrying a permanently
  // empty third tab. It is now HIDDEN — but only on POSITIVE knowledge, and
  // only when there is nothing behind it. Hiding real inbound requests is
  // strictly worse than an extra empty tab, so every uncertain case shows it:
  //
  //   • performer mode ON                        → show (it is an act);
  //   • org ABSENT from `getMyStatus.orgs`       → show. `orgs` lists only the
  //     orgs the actor ADMINISTERS, so a FINANCE/VIEWER member's own org is
  //     missing from it — indistinguishable from "off" on the wire. Hiding on
  //     absence would hide real requests from those members;
  //   • status read in flight or FAILED          → show (`signal` is
  //     `unknown` for both);
  //   • anything OPEN in the act inbox           → show, whatever the mode
  //     says. A request someone is waiting on an answer to outranks tidiness.
  //
  // A zero open count is NOT on its own a safe hide signal — accepted and
  // declined rows still live in that panel, and `countOpen` cannot see them.
  // It is used only as an AND-clause that narrows an already-positive "not an
  // act": with performer mode deliberately off, the panel's history is a
  // toggle-flip away and nothing is waiting on anyone. It also has to be
  // KNOWN zero — a failed count reads as `0` through the `?? 0`, which would
  // otherwise hide the tab on a badge failure.
  const actInboxKnownEmpty =
    !countQuery.isError &&
    countQuery.data !== undefined &&
    openReceivedCount === 0;
  const showReceived = !(
    performerStatus.signal === "off" && actInboxKnownEmpty
  );

  // STICKY once shown, for the same reason the default tab is latched: without
  // it, an org with performer mode off but one open request lands on the tab,
  // declines the request, and watches the tab it is standing on evaporate —
  // responding to a request must never navigate. Latched only from a SETTLED
  // read, or the permissive in-flight answer would pin it open forever.
  const receivedEverShown = useRef(false);
  const countSettled = countQuery.isError || countQuery.data !== undefined;
  // A human never has the act tab, so the performer read (disabled for a
  // null org — it would never settle) is not in the human gate.
  const bothQueriesSettled = isHuman
    ? countSettled
    : countSettled && performerStatus.isSettled;
  if (bothQueriesSettled && showReceived && !isHuman) {
    receivedEverShown.current = true;
  }
  const hasReceivedTab = !isHuman && (showReceived || receivedEverShown.current);

  // The rendered tab set, in slot order — ONE list. Both conditional tabs are
  // decided here, and the default, the clamp and the arrow-key ring all read
  // this array, so nothing can select or navigate to a tab that is not on
  // screen. "Sent to acts" is unconditional for an ORG: booking other people
  // is an organizer activity and has nothing to do with whether this org
  // performs. For a HUMAN the set is `venues` or nothing — their act-side
  // inbox and sent list live in account settings, never here.
  const tabOrder: WorkspaceTab[] = [
    ...(hasVenuesTab ? (["venues"] as const) : []),
    ...(hasReceivedTab ? (["received"] as const) : []),
    ...(isHuman ? [] : (["sent"] as const)),
  ];

  // The default tab is DERIVED from the count so an org with something waiting
  // lands on it. It stays `null` until BOTH reads land: guessing a tab first
  // would mount that panel, fire its own list query, then unmount it and move
  // `aria-selected` with no user action — a visible jump and a wasted round
  // trip for the common "nothing waiting" org. The performer read is in that
  // gate too, so the tab SET is final at first paint rather than dropping a
  // tab out from under the cursor a moment later. Both queries fire in
  // parallel, so the wait is the slower one, not the sum.
  //
  // ORDER OF PRECEDENCE — venue requests first. They are the only inbound flow
  // an org can have that it cannot see anywhere else on the page, and for a
  // venue-running org they are the reason this screen exists. A pure-act org
  // (no venues) falls through to the act inbox, then to the sent list exactly
  // as before. The preference is filtered by the tab set that actually
  // rendered, so a hidden tab is never the landing.
  //
  // A FAILED count resolves to the venue inbox: we no longer know any number,
  // the venue list is independently queryable, and it is what this page is for.
  // The badges just go away.
  const [chosenTab, setChosenTab] = useState<WorkspaceTab | null>(null);
  // `?request=<id>` DEEP LINK: the row lives in the venue inbox, which only
  // the `venues` panel mounts — a landing on `received`/`sent` would strand
  // it. Read ONCE at mount (a ref): the inbox strips the param after it
  // consumes it, and a re-read would flip the preference back mid-session.
  // This only reorders the INITIAL landing; the latch below is untouched.
  const searchParams = useSearchParams();
  const deepLinkedToVenues = useRef<boolean>(
    Boolean(searchParams?.get(BOOKING_INBOX_REQUEST_PARAM)),
  );
  const defaultPreference: WorkspaceTab[] =
    deepLinkedToVenues.current || countQuery.isError || openVenueCount > 0
      ? ["venues", "received", "sent"]
      : openReceivedCount > 0
        ? ["received", "venues", "sent"]
        : ["venues", "sent", "received"];
  // For a human the only candidate is `venues`; an EMPTY human set never
  // reaches the tab render (see the no-venues branch below), so the org-only
  // `sent` fallback is just the last resort it always was.
  const resolvedDefault: WorkspaceTab | null = bothQueriesSettled
    ? (defaultPreference.find((key) => tabOrder.includes(key)) ??
      tabOrder[0] ??
      "sent")
    : null;

  // LATCHED: the default is a LANDING decision, taken once from the first
  // count that resolves — not a live function of the count.
  //
  // Without the latch, answering the LAST open request re-derives the default
  // and moves the user: observed in the real app, declining the final request
  // dropped the count to 0, which flipped the page to "Sent to acts" mid-task
  // with no interaction. Responding to a request must never navigate.
  //
  // A ref, not state: this is an idempotent "first non-null wins" derivation,
  // so writing it during render needs no extra pass and is safe under a
  // StrictMode double-render.
  const latchedDefault = useRef<WorkspaceTab | null>(null);
  if (latchedDefault.current === null && resolvedDefault !== null) {
    latchedDefault.current = resolvedDefault;
  }
  const requestedTab: WorkspaceTab | null = chosenTab ?? latchedDefault.current;

  // The selection is CLAMPED to the rendered set: an org that loses its last
  // venue mid-session must not be left on a panel with no tab to own it (a
  // tabpanel whose `aria-labelledby` points at nothing, and a tablist with
  // nothing selected — both broken states). This also catches a latched or
  // clicked `received` that the gating has since withdrawn.
  const tab: WorkspaceTab | null =
    requestedTab === null
      ? null
      : tabOrder.includes(requestedTab)
        ? requestedTab
        : tabOrder[0]!;

  // The human page has TWO possible shapes (inbox vs settings pointer) and the
  // count decides between them, so nothing page-shaped renders until it lands
  // — drawing the heading, subtitle and footer pointer and then swapping the
  // whole page for the pointer card would be a visible jump.
  if (ownerLoading || (isHuman && !countSettled)) {
    return (
      <YStack alignItems="center" paddingVertical="$6">
        <Spinner size="sm" />
      </YStack>
    );
  }

  // Human admin context with NO venues (or an unresolved owner): the only
  // booking surfaces this person has are personal ones, which live in account
  // settings. Decided on a SETTLED count only — a failed count keeps the
  // workspace (the venue list is a separate query that may succeed), and an
  // in-flight count falls through to the page spinner below rather than
  // flashing this pointer and then replacing it.
  if (!orgId && (!isHuman || (countSettled && !hasVenuesTab))) {
    return (
      <YStack
        gap="$2"
        padding="$4"
        maxWidth={720}
        testID="bookings-workspace-human-empty"
      >
        <Text variant="h3">{String(t("admin.navBookings"))}</Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.bkHubHumanInboxHint"))}
        </Text>
        {/* Deep-link to the Booking requests section, not the settings index
            (which renders the General section). */}
        <NextLinkAnchor href={settingsSectionHref("booking-requests")}>
          <Button tag="span" variant="outlined" size="$2">
            {String(t("admin.bkHubHumanInboxLink"))}
          </Button>
        </NextLinkAnchor>
      </YStack>
    );
  }

  // Labels carry the OPEN count only — an accepted request does not need
  // attention, and these badges are the same "needs you" signal the admin rail
  // shows. Zero renders no decoration rather than "(0)".
  const tabLabel = (key: WorkspaceTab): string => {
    switch (key) {
      case "venues":
        return openVenueCount > 0
          ? `${String(t("admin.bkWsTabVenues"))} (${openVenueCount})`
          : String(t("admin.bkWsTabVenues"));
      case "received":
        return openReceivedCount > 0
          ? `${String(t("admin.bkWsTabReceived"))} (${openReceivedCount})`
          : String(t("admin.bkWsTabReceived"));
      case "sent":
        return String(t("admin.bkWsTabSent"));
    }
  };
  const tabs: { key: WorkspaceTab; label: string }[] = tabOrder.map((key) => ({
    key,
    label: tabLabel(key),
  }));

  // The subtitle enumerates the page's contents, so it has to track the tab
  // set — promising "requests to your group as an act" to a venue-only org is
  // the exact confusion this gating removes.
  const subtitleKey = isHuman
    ? "admin.bkWsSubtitleHumanVenues"
    : hasReceivedTab
      ? "admin.bkWsSubtitle"
      : hasVenuesTab
        ? "admin.bkWsSubtitleNoAct"
        : "admin.bkWsSubtitleSentOnly";

  // One panel left: render a section label instead of a one-item tablist.
  const isSolo = tabOrder.length === 1;

  return (
    <PageContainer>
      <YStack gap="$1">
        <Text
          variant="h3"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {String(t("admin.navBookings"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t(subtitleKey))}
        </Text>
      </YStack>

      {/* Unconfigured-venue reminder (availability-onboarding FR-004). In
          normal flow above the tabs — it renders when its probes settle and
          simply pushes content down; nothing is reserved for it and nothing
          overlays the inbox. Renders only off the venue set the count already
          supplied, so a pure-act org never probes anything. */}
      {venues.length > 0 ? (
        <AvailabilitySetupBanner slug={slug} venues={venues} />
      ) : null}

      {tab === null ? (
        // A read still in flight. Withholding the strip keeps the tablist
        // honest (a tablist with nothing selected is a broken state) and keeps
        // the panel from mounting, unmounting and re-mounting the other one.
        <YStack
          alignItems="center"
          paddingVertical="$8"
          testID="bookings-workspace-loading"
        >
          <Spinner size="sm" />
        </YStack>
      ) : (
        <>
          {isSolo ? (
            // No tablist: a one-tab tablist announces a switcher with nothing
            // to switch to, and the roving tabindex/arrow-key contract has no
            // meaning with a single stop.
            <SoloHeader testID="bookings-workspace-solo-header">
              <Text variant="bodySmall" weight="bold" color="$color">
                {tabLabel(tab)}
              </Text>
            </SoloHeader>
          ) : (
            <TabStrip
              role="tablist"
              aria-label={String(t("admin.navBookings"))}
            >
              {tabs.map(({ key, label }) => {
                // Web-only ARIA wiring (valid on the rendered <button>, absent
                // from Tamagui's RN prop types — a spread keeps the escape hatch
                // scoped). `type` too: a styled `tag: "button"` otherwise
                // defaults to type="submit".
                // Roving tabIndex: only the active tab sits in the tab order;
                // arrow keys move between tabs per the ARIA tabs pattern.
                const tabA11yProps = {
                  type: "button",
                  id: workspaceTabId(key),
                  "aria-controls": TAB_PANEL_ID,
                  tabIndex: tab === key ? 0 : -1,
                  onKeyDown: (e: {
                    key: string;
                    preventDefault: () => void;
                  }) => {
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    const step = e.key === "ArrowRight" ? 1 : -1;
                    const from = tabOrder.indexOf(key);
                    const next =
                      tabOrder[
                        (from + step + tabOrder.length) % tabOrder.length
                      ]!;
                    setChosenTab(next);
                    document.getElementById(workspaceTabId(next))?.focus();
                  },
                };
                return (
                  <TabButton
                    key={key}
                    active={tab === key}
                    role="tab"
                    aria-selected={tab === key}
                    onPress={() => setChosenTab(key)}
                    testID={`bookings-workspace-tab-${key}`}
                    {...tabA11yProps}
                  >
                    <Text
                      variant="bodySmall"
                      weight={tab === key ? "bold" : "medium"}
                      color={tab === key ? "$color" : "$colorMuted"}
                    >
                      {label}
                    </Text>
                  </TabButton>
                );
              })}
            </TabStrip>
          )}

          <YStack
            id={TAB_PANEL_ID}
            {...(isSolo
              ? // A region, not a tabpanel — `aria-labelledby` would point at a
                // tab that is not rendered.
                ({ role: "region", "aria-label": tabLabel(tab) } as const)
              : ({
                  role: "tabpanel",
                  "aria-labelledby": workspaceTabId(tab),
                  tabIndex: 0,
                } as const))}
          >
            {tab === "venues" ? (
              <BookingInbox
                scope={
                  orgId !== null
                    ? { kind: "org-venues", orgId }
                    : { kind: "human-venues" }
                }
                slug={slug}
                venues={venues}
                venuesTruncated={
                  countQuery.data?.ownedPlacesTruncated ?? false
                }
                venuesLoading={countQuery.isLoading}
                venuesError={countQuery.isError}
                onRetryVenues={() => void countQuery.refetch()}
              />
            ) : orgId === null ? null : tab === "received" ? (
              // Org-only panels: `tabOrder` never holds these for a human, so
              // this branch is unreachable with a null org — the guard is for
              // the type, not the runtime.
              <OrgReceivedRequestsTable orgId={orgId} slug={slug} />
            ) : (
              <SentToActsList orgId={orgId} slug={slug} />
            )}
          </YStack>
        </>
      )}

      {orgId !== null ? (
        /* ── Performer settings pointer (org) ──────────────────────────── */
        <XStack
          gap="$2"
          alignItems="center"
          flexWrap="wrap"
          justifyContent="space-between"
        >
          <Text variant="caption" tone="muted" flex={1} minWidth={220}>
            {String(t("admin.bkHubSettingsHint"))}
          </Text>
          {/* Deep-link to the Performer section, not the settings index:
              settings is one route per section and the index renders General. */}
          <NextLinkAnchor href={orgSettingsSectionHref(slug, "performer")}>
            <Button tag="span" variant="ghost" size="$2">
              {String(t("admin.bkHubSettingsLink"))}
            </Button>
          </NextLinkAnchor>
        </XStack>
      ) : (
        /* ── Personal inbox pointer (human) ────────────────────────────────
           The person's OWN act-side inbox (requests to them as a performer,
           and the ones they sent) still lives in account settings. The
           venues panel above is only ever the venue side. */
        <XStack
          gap="$2"
          alignItems="center"
          flexWrap="wrap"
          justifyContent="space-between"
          testID="bookings-workspace-human-inbox-pointer"
        >
          <Text variant="caption" tone="muted" flex={1} minWidth={220}>
            {String(t("admin.bkHubHumanInboxHint"))}
          </Text>
          <NextLinkAnchor href={settingsSectionHref("booking-requests")}>
            <Button tag="span" variant="ghost" size="$2">
              {String(t("admin.bkHubHumanInboxLink"))}
            </Button>
          </NextLinkAnchor>
        </XStack>
      )}
    </PageContainer>
  );
}
