"use client";

/**
 * Org-settings information architecture — "which sections may this member see,
 * and how are they grouped".
 *
 * Same shape as the account page's `_lib/settings-sections.tsx` (identity →
 * work → footer danger) because the two surfaces render the same `SettingsNav`.
 * Kept OUT of the view component so the gating rules — the part that is easiest
 * to get quietly wrong — live in one pure function with direct unit tests.
 *
 * HARD PRODUCT RULE encoded here, in two halves:
 *
 *   1. Organizer / organization CONFIGURATION lives on THIS page, not in
 *      `/account/settings`. Org performer mode and org booking defaults are
 *      org config and stay here; `/account/settings` owns the individual's
 *      equivalents, never the group's.
 *   2. WORK QUEUES do NOT live here. A queue is something a member opens daily
 *      to act on other people's input; configuration is something they set once
 *      and forget. Settings is a rail nobody re-visits, so anything with daily
 *      traffic belongs beside Events / Places / Orders in the admin nav. The
 *      org's received-as-act booking inbox used to be a section on this page
 *      (`booking-requests`) and now lives at `/admin/[slug]/bookings` for
 *      exactly that reason — do not move it, or any other inbox, back. The old
 *      URL is kept alive by `ORG_SETTINGS_LEGACY_REDIRECTS`.
 *
 * The "Getting booked" group below is therefore config-only: the availability
 * switches and the booking defaults.
 *
 * Route vocabulary (slugs, hrefs) lives in `org-settings-routes.ts` so the
 * Server Component route guard can import it.
 */

import {
  AlertTriangle,
  Building2,
  CalendarCheck,
  Globe,
  Mail,
  Mic,
  Tag,
  Tags,
} from "lucide-react";

import type { SettingsNavGroup, SettingsNavItem } from "@/components/settings";

import {
  orgSettingsSectionHref,
  type OrgSettingsSectionSlug,
} from "./org-settings-routes";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => unknown;

export interface OrgSettingsNavInput {
  /** Admin URL slug — every href is built from it. */
  slug: string;
  /** OWNER or ADMIN. Read-only members (VIEWER) get the informational sections only. */
  canEdit: boolean;
  /** OWNER. Gates the delete-group footer item. */
  isOwner: boolean;
}

export interface BuiltOrgSettingsNav {
  groups: SettingsNavGroup[];
  footerItems: SettingsNavItem[];
  /**
   * Sections this member may open. The view redirects to the bare settings
   * route for anything outside it — but only once the owner lookup has
   * resolved, otherwise a legitimate admin gets bounced mid-load.
   */
  entitled: ReadonlySet<OrgSettingsSectionSlug>;
}

const ICON_SIZE = 16;

/**
 * Summary → nav groups + the entitlement set, in one pass so the rail and the
 * route guard can never disagree about who may see what.
 */
export function buildOrgSettingsGroups(
  { slug, canEdit, isOwner }: OrgSettingsNavInput,
  { t }: { t: Translate },
): BuiltOrgSettingsNav {
  const navItem = (
    section: OrgSettingsSectionSlug,
    label: string,
    icon: SettingsNavItem["icon"],
    extra?: Pick<SettingsNavItem, "count" | "tone">,
  ): SettingsNavItem => ({
    id: section,
    label,
    icon,
    href: orgSettingsSectionHref(slug, section),
    ...extra,
  });

  // Always reachable by anyone who can open the settings page at all. The
  // sections themselves render read-only for non-editors (the inputs are
  // `editable={canEdit}`), which is the pre-existing behaviour.
  const entitled = new Set<OrgSettingsSectionSlug>([
    "general",
    "contact",
    "page",
    "performer",
  ]);

  const groups: SettingsNavGroup[] = [
    {
      id: "organization",
      label: String(t("admin.settingsGroupOrganization")),
      items: [
        navItem("general", String(t("admin.settingsGeneral")), (
          <Building2 size={ICON_SIZE} />
        )),
        navItem("contact", String(t("admin.settingsContact")), (
          <Mail size={ICON_SIZE} />
        )),
        navItem("page", String(t("admin.settingsPublicPage")), (
          <Globe size={ICON_SIZE} />
        )),
      ],
    },
  ];

  const bookingItems: SettingsNavItem[] = [
    navItem("performer", String(t("admin.settingsPerformer")), (
      <Mic size={ICON_SIZE} />
    )),
  ];
  // Booking defaults is an edit surface — it only ever rendered for
  // OWNER/ADMIN, so it only ever lists for them. Booking tags (booking-holds
  // FR-017) is the org's venue-internal filing vocabulary for received
  // requests — config, not a queue — and gates the same way.
  if (canEdit) {
    entitled.add("booking-defaults");
    bookingItems.push(
      navItem("booking-defaults", String(t("admin.settingsBookingDefaults")), (
        <CalendarCheck size={ICON_SIZE} />
      )),
    );
    entitled.add("booking-tags");
    bookingItems.push(
      navItem("booking-tags", String(t("admin.settingsBookingTags")), (
        <Tags size={ICON_SIZE} />
      )),
    );
  }
  groups.push({
    id: "booking",
    label: String(t("admin.settingsGroupBooking")),
    items: bookingItems,
  });

  if (canEdit) {
    // Not behind the `resale` gate: the page holds the group's default deal
    // too. Only its resale parts are gated, inside the page.
    entitled.add("default-agreement");
    groups.push({
      id: "policies",
      label: String(t("admin.settingsGroupPolicies")),
      items: [
        navItem("default-agreement", String(t("admin.settingsDefaultAgreement")), (
          <Tag size={ICON_SIZE} />
        )),
      ],
    });
  }

  const footerItems: SettingsNavItem[] = [];
  if (isOwner) {
    entitled.add("danger");
    footerItems.push(
      navItem(
        "danger",
        // "Danger Zone", NOT "Delete group" — the destination's own heading.
        // The route's trigger button is already "Delete group", and a rail LINK
        // sharing that exact phrase makes a screen reader announce the same
        // words twice on one page. Nav items name places; buttons name actions.
        String(t("admin.settingsDanger")),
        <AlertTriangle size={ICON_SIZE} />,
        { tone: "danger" },
      ),
    );
  }

  return { groups, footerItems, entitled };
}
