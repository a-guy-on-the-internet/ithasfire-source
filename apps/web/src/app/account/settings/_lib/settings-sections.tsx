"use client";

/**
 * Account-settings information architecture — the single source of truth for
 * "which sections is this user entitled to see, and how are they grouped".
 *
 * Kept OUT of the page component on purpose: the gating rules are the part of
 * this surface that is easiest to get quietly wrong, so they live in one pure
 * function with direct unit tests (`__tests__/settings-sections.test.tsx`).
 *
 * HARD PRODUCT RULE encoded here: organizer / organization configuration stays
 * in `/admin/[slug]/settings`. There is deliberately no "Your groups" entry, no
 * org switcher and no link-out list of administered orgs, and NOTHING here
 * widens on org administration. `humans.getMyWorkSummary` no longer even
 * returns `adminOrgCount` — it had no consumer (the "you also administer
 * groups" hint in `PerformerSection` reads `performers.getMyStatus.orgs`), and
 * a field that must never gate anything is safest not shipped at all.
 *
 * Route vocabulary (slugs, hrefs, legacy anchors) lives in `settings-routes.ts`
 * so the Server Component route guard can import it.
 */

import { YStack } from "tamagui";
import { NextLinkAnchor, Text } from "@th/ui";
import {
  AlertTriangle,
  Bell,
  Briefcase,
  Building2,
  CalendarCheck,
  CreditCard,
  Inbox,
  Lock,
  Mail,
  Mic,
  Pencil,
  User,
} from "lucide-react";

import type { SettingsNavGroup, SettingsNavItem } from "@/components/settings";

import { settingsSectionHref, type SettingsSectionSlug } from "./settings-routes";

/** The subset of `humans.getMyWorkSummary` this module reads. */
export interface SettingsWorkSummary {
  /**
   * At least one sub-read failed and was substituted with 0. Every count below
   * may therefore be understated, so entitlement is NOT decidable — see
   * `entitlementDecidable`.
   */
  degraded: boolean;
  performerEnabled: boolean;
  hasWorkRoles: boolean;
  /** Stored organizer-request acceptance gate, independent of performer mode. */
  acceptsBookingRequests: boolean;
  /** All statuses — history, not just open. */
  sentBookingRequestCount: number;
  /** All statuses — history, not just open. */
  receivedBookingRequestCount: number;
  pendingReceivedBookingRequestCount: number;
  placeClaimCount: number;
  editSuggestionCount: number;
}

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => unknown;

export interface BuiltSettingsNav {
  groups: SettingsNavGroup[];
  footerItems: SettingsNavItem[];
  /**
   * Sections this user may open. Read it ONLY when `entitlementDecidable` —
   * absence from this set otherwise means "we don't know", not "not allowed".
   */
  entitled: ReadonlySet<SettingsSectionSlug>;
  /**
   * Whether `entitled` is trustworthy enough to redirect someone away from a
   * page they asked for.
   *
   * False while the summary is unresolved (bouncing a user mid-load) AND when
   * it resolved degraded (bouncing a user on counts the server already knows
   * are wrong — e.g. a partial outage zeroes `placeClaimCount` and a claimant
   * gets thrown off their own claims page). Failing open is cheap: a section
   * the user really has nothing in renders its own empty state.
   */
  entitlementDecidable: boolean;
}

const ICON_SIZE = 16;

function navItem(
  slug: SettingsSectionSlug,
  label: string,
  icon: SettingsNavItem["icon"],
  extra?: Pick<SettingsNavItem, "count" | "tone" | "ariaLabel">,
): SettingsNavItem {
  return {
    id: slug,
    label,
    icon,
    href: settingsSectionHref(slug),
    ...extra,
  };
}

/**
 * True when the personal "Your work" group applies.
 *
 * The rule is deliberately RATCHETING: once you have ever pitched or been
 * pitched, the work scope stays yours. `performerEnabled || hasWorkRoles` alone
 * was not enough, because nothing requires job roles to enable performer mode
 * (`set-performer-mode.ts` never touches `jobs`), so `jobs: []` + performer ON
 * is an ordinary state — and turning performer mode OFF from
 * `/account/settings/performer` then deleted the group containing the toggle
 * that turns it back on, and stranded any open booking request with it.
 *
 * Request HISTORY (all statuses, not just open) is what makes it a ratchet:
 * `BookingRequestsSection` states that neither list is gated on performer mode,
 * because a request received or sent before the toggle went off must stay
 * actionable. The nav now honours the same contract the section does.
 *
 * Still NOT in the rule: org administration. Someone who only administers a
 * group manages that group's performer mode, booking defaults and inbox in
 * `/admin/[slug]/settings`; account settings is about THEM. A true ticket buyer
 * — no jobs, no performer mode, no request history — still gets no work group,
 * which is the whole point of gating it.
 */
export function hasPersonalWork(summary: SettingsWorkSummary): boolean {
  return (
    summary.performerEnabled ||
    summary.hasWorkRoles ||
    summary.acceptsBookingRequests ||
    hasBookingRequestHistory(summary)
  );
}

/**
 * True when the user has ever sent or received a booking request.
 *
 * Entitles `booking-requests` on its own, independently of `hasPersonalWork`.
 * That redundancy is deliberate: the organizer-request notification email deep
 * links to `/account/settings/booking-requests`, and
 * `ReceivedBookingRequestsList owner={{ownerType:"human"}}` is mounted nowhere
 * else in the app — so if that route ever redirects, the request becomes
 * unreachable and the organizer waits forever. This keeps the deep link alive
 * no matter how the broader work rule evolves.
 */
export function hasBookingRequestHistory(
  summary: SettingsWorkSummary,
): boolean {
  return (
    summary.receivedBookingRequestCount > 0 ||
    summary.sentBookingRequestCount > 0
  );
}

function WorkGroupEmptyState({ t }: { t: Translate }) {
  return (
    <YStack gap="$2" paddingHorizontal="$3" paddingBottom="$2">
      <Text variant="caption" tone="muted">
        {String(t("account.settingsWorkEmpty"))}
      </Text>
      <NextLinkAnchor
        href={settingsSectionHref("roles")}
        data-testid="settings-nav-work-empty-cta"
        style={{ textDecoration: "none" }}
      >
        {/* `accentText`, not `accent`: this is an interactive control's
            accessible label, and raw accent is 3.57:1 as small text on Stub. */}
        <Text
          variant="caption"
          weight="bold"
          color="$accentText"
          textTransform="uppercase"
          letterSpacing={1.2}
        >
          {String(t("account.settingsWorkEmptyCta"))}
        </Text>
      </NextLinkAnchor>
    </YStack>
  );
}

/**
 * Summary → nav groups + the entitlement set, in one pass so the rail and the
 * route guard can never disagree about who may see what.
 *
 * `summary == null` means "not resolved yet" (loading, or the query failed). In
 * that state we render the always-available Account group and the danger footer
 * only, and OMIT the work and submissions groups entirely — not an empty group.
 * Two reasons: flashing "tell us what you do" at a working performer for one
 * paint is worse than the group arriving a beat late, and emitting a bare
 * "YOUR WORK" header above a divider with nothing under it is an orphaned label
 * on every single settings load.
 *
 * Note a resolved-but-degraded summary still gets a normal render: the counts
 * may be understated, so `SettingsSurface` suppresses the entitlement redirect
 * rather than the nav.
 */
export function buildSettingsGroups(
  summary: SettingsWorkSummary | null | undefined,
  { t }: { t: Translate },
): BuiltSettingsNav {
  const entitled = new Set<SettingsSectionSlug>([
    "profile",
    "email",
    "security",
    "notifications",
    "billing",
    // Always reachable: the work group's empty state links straight here, so
    // it must stay openable even when that group has no items.
    "roles",
    "danger",
  ]);

  const groups: SettingsNavGroup[] = [
    {
      id: "account",
      label: String(t("account.settingsGroupAccount")),
      items: [
        navItem("profile", String(t("account.sProfileTitle")), (
          <User size={ICON_SIZE} />
        )),
        navItem("email", String(t("account.sEmailTitle")), (
          <Mail size={ICON_SIZE} />
        )),
        // Security sits ABOVE Notifications on purpose: nothing
        // security-critical should live below a booking form.
        navItem("security", String(t("account.sSecurityTitle")), (
          <Lock size={ICON_SIZE} />
        )),
        navItem("notifications", String(t("account.sNotificationsTitle")), (
          <Bell size={ICON_SIZE} />
        )),
        navItem("billing", String(t("account.sBillingTitle")), (
          <CreditCard size={ICON_SIZE} />
        )),
      ],
    },
  ];

  if (summary) {
    // Entitlement is computed BEFORE the item list, and `booking-requests`
    // gets its own predicate, so the email deep link survives even if the work
    // group itself is empty.
    if (hasBookingRequestHistory(summary)) entitled.add("booking-requests");

    // Grouping is split (Your work / Booking) but the ENTITLEMENT is one
    // predicate for all four sections — `hasPersonalWork` decides whether
    // you get any of them, and the booking group simply holds three of them.
    const workItems: SettingsNavItem[] = [];
    const bookingItems: SettingsNavItem[] = [];
    if (hasPersonalWork(summary)) {
      entitled.add("performer");
      entitled.add("booking-defaults");
      entitled.add("booking-requests");

      const pending = summary.pendingReceivedBookingRequestCount;
      const bookingRequestsLabel = String(
        t("account.sBookingRequestsTitle"),
      );
      workItems.push(
        navItem("roles", String(t("account.sRolesCraftTitle")), (
          <Briefcase size={ICON_SIZE} />
        )),
      );
      bookingItems.push(
        navItem("performer", String(t("account.sPerformerTitle")), (
          <Mic size={ICON_SIZE} />
        )),
        navItem("booking-defaults", String(t("account.sBkDefTitle")), (
          <CalendarCheck size={ICON_SIZE} />
        )),
        navItem(
          "booking-requests",
          bookingRequestsLabel,
          <Inbox size={ICON_SIZE} />,
          pending > 0
            ? {
                count: pending,
                // Otherwise the link announces "Booking requests 3" — a
                // numeral with no unit.
                ariaLabel: String(
                  t("account.settingsNavPendingAria", {
                    label: bookingRequestsLabel,
                    count: pending,
                  }),
                ),
              }
            : undefined,
        ),
      );
    }

    groups.push({
      id: "work",
      label: String(t("account.settingsGroupWork")),
      items: workItems,
      emptyState: <WorkGroupEmptyState t={t} />,
    });

    // Same posture as Submissions: no items means no header. The work
    // group's empty state already carries the "tell us what you do" prompt,
    // so an empty Booking header on top of it would be pure chrome.
    if (bookingItems.length > 0) {
      groups.push({
        id: "booking",
        label: String(t("account.settingsGroupBooking")),
        items: bookingItems,
      });
    }
  }

  const submissionItems: SettingsNavItem[] = [];
  if (summary && summary.placeClaimCount > 0) {
    entitled.add("venues");
    submissionItems.push(
      navItem("venues", String(t("account.sVenueClaimsTitle")), (
        <Building2 size={ICON_SIZE} />
      )),
    );
  }
  if (summary && summary.editSuggestionCount > 0) {
    entitled.add("contributions");
    submissionItems.push(
      navItem("contributions", String(t("account.sContributionsTitle")), (
        <Pencil size={ICON_SIZE} />
      )),
    );
  }
  // The whole group disappears when nothing has been filed — an empty
  // "Submissions" header is chrome for a state the user has never been in.
  if (submissionItems.length > 0) {
    groups.push({
      id: "submissions",
      label: String(t("account.settingsGroupSubmissions")),
      items: submissionItems,
    });
  }

  const footerItems: SettingsNavItem[] = [
    navItem(
      "danger",
      String(t("account.settingsDeleteAccount")),
      <AlertTriangle size={ICON_SIZE} />,
      { tone: "danger" },
    ),
  ];

  return {
    groups,
    footerItems,
    entitled,
    entitlementDecidable: Boolean(summary) && !summary?.degraded,
  };
}
