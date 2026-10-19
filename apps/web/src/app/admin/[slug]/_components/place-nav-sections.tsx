import {
  Calendar,
  CalendarRange,
  FileText,
  Grid3x3,
  HeartHandshake,
  Inbox,
  Settings,
} from "lucide-react";

import type { NavigationSection } from "@th/ui";

import type { PlaceVerificationStatus } from "./place-verification-labels";

export type PlaceAdminPathContext = {
  placeId: string;
  /** First segment after the place id ("settings", "calendar", …) or null. */
  subRoute: string | null;
};

/**
 * Detects a place-context admin path: `/admin/{slug}/places/{placeId}[/…]`.
 * Returns null for the places list (`/places`), a hypothetical create flow
 * (`/places/new` and below), and any non-place admin path — mirroring
 * `parseEventAdminPath` (place-admin-rail-context FR-202). Pure so it's
 * unit-testable.
 */
export function parsePlaceAdminPath(
  pathname: string | null | undefined,
): PlaceAdminPathContext | null {
  if (!pathname) return null;
  const cleaned = pathname.split(/[?#]/, 1)[0] ?? "";
  const match = /^\/admin\/[^/]+\/places\/([^/]+)(?:\/([^/]+))?/.exec(cleaned);
  if (!match) return null;
  const placeId = match[1];
  if (!placeId || placeId === "new") return null;
  return { placeId, subRoute: match[2] ?? null };
}

export type BuildPlaceNavSectionsArgs = {
  placeId: string;
  /**
   * Verification status from `places.getPlaceTitle`, threaded by
   * `usePlaceRailContext` (undefined while the title query is in flight).
   * UNVERIFIED/REJECTED dresses the Settings item in tone danger + badge —
   * the "needs your attention" state of FR-302, which moved with the
   * verification workflow into the settings page.
   */
  verification?: PlaceVerificationStatus;
  t: (key: string) => unknown;
};

/**
 * Place-context sections for the admin rail (place-admin-rail-context D3/
 * FR-201): a "Venue" group (Settings, Public page, Spaces & availability,
 * Seat layout) and an
 * "Operate" group (Calendar, Bookings, Volunteers). Item `route` values are
 * stable ids that AdminShell namespaces under `/admin/{slug}` — no slug or
 * flag plumbing here: feature-flag filtering rides the item's `featureFlag`
 * through NavigationShell (D1), exactly like the workspace sections.
 *
 * Deliberately NO `rbac` fields (D4): place access is boolean ownership
 * (direct human owner or ANY role in an owning org — get-place-for-edit.ts),
 * which NavRole cannot express; the server gates every read. The Public page
 * item renders enabled and keeps its existing in-page verification gate.
 *
 * No Bookings badge: `bookingRequests.countOpen` is org-scoped (input is
 * `{ orgId }` with no place filter) and unavailable in human workspaces, so
 * a per-place count has no existing endpoint — and FR-201 forbids adding one
 * just for a badge.
 *
 * Mobile bottom bar (FR-203): the bar flattens sections in order into 4
 * slots. Spaces & availability, Seat layout and Volunteers carry
 * `hideInBottomBar` so the bar reads Settings · Page · Calendar · Bookings;
 * all three stay in the rail and drawer. (Settings took Details' slot when
 * the two Venue items merged — the arithmetic did not change.)
 */
export function buildPlaceNavSections({
  placeId,
  verification,
  t,
}: BuildPlaceNavSectionsArgs): NavigationSection[] {
  const base = `places/${placeId}`;

  // FR-302: the item always renders; only its dress is conditional. The
  // danger tone + badge are the rail's "action needed" signal for a place
  // that has never verified or came back rejected. PENDING and VERIFIED are
  // calm states — no badge, or the rail would nag about a done/queued thing.
  const needsVerification =
    verification === "UNVERIFIED" || verification === "REJECTED";

  return [
    {
      id: "place-venue",
      label: String(t("admin.plNavGroupVenue")),
      items: [
        {
          // FR-401: ONE item for the merged venue settings page. It replaces
          // Details (`/edit`) and Verification (`/verify`), whose surfaces are
          // now sections of it — both old routes redirect there. It inherits
          // Verification's FR-302 dress: tone danger + a badge while the
          // place is UNVERIFIED or REJECTED, because the thing that needs the
          // owner's attention now lives behind this item.
          id: "settings",
          label: String(t("admin.plNavSettings")),
          route: `${base}/settings`,
          icon: <Settings size={18} />,
          ...(needsVerification
            ? { tone: "danger" as const, badgeCount: 1 }
            : {}),
        },
        {
          id: "public-page",
          label: String(t("admin.plNavPublicPage")),
          route: `${base}/page`,
          icon: <FileText size={18} />,
        },
        {
          // Venue-hierarchy management (spaces + named calendars +
          // availability) — venue STRUCTURE, so it lives in the Venue group
          // and is labelled "Spaces & availability" (NOT "Calendars") so it
          // cannot be mistaken for the Operate group's "Calendar", which is
          // the day-to-day schedule view. The route and key keep their
          // historical `calendars` name. Hidden from the 4-slot mobile bottom
          // bar (FR-203's Settings · Page · Calendar · Bookings reading is
          // pinned).
          id: "calendars",
          label: String(t("admin.plNavCalendars")),
          route: `${base}/calendars`,
          icon: <CalendarRange size={18} />,
          hideInBottomBar: true,
        },
        {
          id: "seat-layout",
          label: String(t("admin.plNavSeatLayout")),
          route: `${base}/layout`,
          icon: <Grid3x3 size={18} />,
          // Same gate the old tab bar applied inline (`gates?.seatingLayouts`
          // in places/[placeId]/layout.tsx) — now declarative on the item.
          featureFlag: "seatingLayouts",
          // Owns a sub-route (`layout/designer`); without prefix matching the
          // rail entry would go dark inside the designer.
          activeMatch: "prefix",
          hideInBottomBar: true,
        },
      ],
    },
    {
      id: "place-operate",
      label: String(t("admin.plNavGroupOperate")),
      items: [
        {
          id: "calendar",
          label: String(t("admin.placeTabCalendar")),
          route: `${base}/calendar`,
          icon: <Calendar size={18} />,
        },
        {
          id: "bookings",
          label: String(t("admin.placeTabBookings")),
          route: `${base}/bookings`,
          icon: <Inbox size={18} />,
        },
        {
          id: "volunteers",
          label: String(t("volunteering.placeTabVolunteers")),
          route: `${base}/volunteers`,
          icon: <HeartHandshake size={18} />,
          hideInBottomBar: true,
        },
      ],
    },
  ];
}
