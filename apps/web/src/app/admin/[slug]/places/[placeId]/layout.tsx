"use client";

import { use, useCallback, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack, useTheme } from "tamagui";
import { Button, Text, useTranslations } from "@th/ui";
import { AlertTriangle, ArrowLeft, MapPin } from "lucide-react";

import { trpc } from "@/trpc";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

// The hand-rolled tab bar + header that used to live here died with
// place-admin-rail-context FR-203: navigation is the admin rail's place
// context now (place-rail-context.tsx), and the back-arrow + name +
// verification chip moved into PlaceRailContextHeader. This layout keeps the
// page container, the per-surface document title (FR-204), and the
// owner-resolution gate: a non-owner (or dead link) gets the access card
// below instead of a fully chromed place workspace.

// Maps the active surface segment to its label key — the SAME labels the
// place rail shows (place-nav-sections.tsx), so nav item and history title
// agree. Prefix semantics: `layout/designer` resolves to the Seat layout
// label, like the old tab bar's prefix match.
// `edit` and `verify` are gone: both redirect to `settings` (FR-401) before
// this layout ever renders a title for them.
const SECTION_LABEL_KEY: Record<string, string> = {
  settings: "admin.plNavSettings",
  page: "admin.plNavPublicPage",
  calendars: "admin.plNavCalendars",
  layout: "admin.plNavSeatLayout",
  calendar: "admin.placeTabCalendar",
  bookings: "admin.placeTabBookings",
  volunteers: "volunteering.placeTabVolunteers",
};

type LayoutProps = {
  params: Promise<{ slug: string; placeId: string }>;
  children: ReactNode;
};

export default function PlaceDetailLayout({ params, children }: LayoutProps) {
  const { slug, placeId } = use(params);
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations();
  const theme = useTheme();

  // Light title fetch (NFR-1) — same query + key the rail's place context
  // uses, so React Query dedupes. Doubles as the layout's ownership gate:
  // getPlaceTitle enforces the same owner resolution getPlaceForEdit enforced
  // for the old header (direct human owner OR owning-org member).
  const placeTitleQuery = trpc.places.getPlaceTitle.useQuery(
    { placeId },
    { enabled: Boolean(placeId), staleTime: 60_000, retry: 2 },
  );
  const placeName = placeTitleQuery.data?.name;

  // Segment AFTER the placeId (never the last segment — `layout/designer`
  // must resolve to "layout"). Splitting on the id sidesteps slug-encoding
  // differences between params and usePathname.
  const segments = pathname.split("/");
  const idIndex = segments.indexOf(placeId);
  const subRoute =
    (idIndex >= 0 ? segments[idIndex + 1] : undefined) ?? "settings";
  const sectionKey = SECTION_LABEL_KEY[subRoute] ?? "admin.plNavSettings";

  // FR-204: descriptive history title per surface, "<Tab> · <Place name>" —
  // the exact format the deleted tab layout produced.
  useDocumentTitle(
    placeName ? `${String(t(sectionKey))} · ${placeName}` : null,
  );

  const backToPlaces = useCallback(
    () => router.push(`/admin/${slug}/places`),
    [router, slug],
  );

  // ── Access / not-found gate (FR-203) ─────────────────────────────────────
  // Every surface re-enforces ownership server-side; this branch keeps a
  // non-owner from getting a fully rendered place workspace around six
  // FORBIDDEN payloads. Same card + copy as edit/page.tsx's error state, and
  // the same FORBIDDEN vs NOT_FOUND distinction (nothing finer — the server
  // already collapses anything more detailed). Children still render while
  // the query is in flight, exactly like the old tab layout did — each
  // surface owns its own loading UI.
  if (placeTitleQuery.isError) {
    const error = placeTitleQuery.error;
    const isForbidden = error.data?.code === "FORBIDDEN";
    const isNotFound = error.data?.code === "NOT_FOUND";

    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$6"
        gap="$4"
        maxWidth={480}
        marginHorizontal="auto"
      >
        <YStack
          width={64}
          height={64}
          borderRadius={0}
          backgroundColor={isForbidden ? "$dangerMuted" : "$warningMuted"}
          justifyContent="center"
          alignItems="center"
        >
          {isForbidden ? (
            <AlertTriangle size={28} color={theme.danger?.val} />
          ) : (
            <MapPin size={28} color={theme.warning?.val} />
          )}
        </YStack>

        <YStack gap="$2" alignItems="center">
          <Text variant="h3" textAlign="center">
            {isForbidden
              ? String(t("admin.placeEditAccessDenied"))
              : isNotFound
                ? String(t("admin.placeEditNotFound"))
                : String(t("admin.placeEditGenericError"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center">
            {isForbidden
              ? String(t("admin.placeEditAccessDeniedDescription"))
              : isNotFound
                ? String(t("admin.placeEditNotFoundDescription"))
                : (error.message ??
                  String(t("admin.placeEditGenericErrorDescription")))}
          </Text>
        </YStack>

        <Button variant="secondary" size="$3" onPress={backToPlaces}>
          <ArrowLeft size={16} />
          {String(t("admin.placeEditBackToPlaces"))}
        </Button>
      </YStack>
    );
  }

  return <YStack flex={1}>{children}</YStack>;
}
