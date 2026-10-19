"use client";

import { useMemo, useState, useCallback } from "react";
import { PlaceDetailPanel } from "./PlaceDetailPanel";
import {
  effectiveVerificationStatus,
  type EffectiveVerificationStatus,
} from "@/lib/verification-config";
import { useParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { YStack, XStack, Stack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  DT_CELL_SUB_CLASS,
  Button,
  Text,
  Badge,
  Tooltip,
  useNotify,
} from "@th/ui";
import {
  Plus,
  Archive,
  RotateCcw,
  Pencil,
  MapPin,
  Users,
  Grid3x3,
  Calendar,
  Inbox,
  Send,
  Upload,
  FileText,
  Rows3,
} from "lucide-react";
import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { VERIFICATION_ICON_MAP } from "@/lib/verification-config";
import { ORG_EDIT_ROLES } from "@th/types";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import {
  ActionBar,
  AdminTableErrorState,
  TableContainer,
  SearchBar,
  FilterChips,
  FilterRow,
  Pagination,
  NoResults,
  ColumnSelector,
  type ColumnOption,
} from "@/components/AdminTableParts";
import {
  CsvImportDialog,
  type CsvImportResult,
} from "../../_components/CsvImportDialog";
import { RequestVerificationModal } from "./RequestVerificationModal";
import { NewPlaceDialog, type NewPlaceDraft } from "./NewPlaceDialog";
import { placePrivacyToUpsertInput } from "@/components/places/PlaceLocationPrivacyFields";
import { PLACE_IMPORT_FIELDS } from "@/lib/place-import-fields";
import { buildPlaceCsvAddress } from "@/lib/place-csv-address";
import { getPlaceVerificationEligibility } from "@th/core/use-cases/places";
import { useTranslations } from "@th/ui";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useTableDensity } from "@/hooks/useTableDensity";
import { usePageClamp } from "@/hooks/usePageClamp";
import { useIsMobile } from "@/hooks/useIsMobile";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

import {
  PlaceMobileCard,
  badgeToneForVerification,
  buildFullAddress,
  getStatusBadgeTone,
  type PlaceStatus,
  type PlaceVerificationStatus,
} from "./PlaceMobileCard";

type StatusFilter = "all" | "active" | "archived";

/**
 * Column ids the server can sort by (listHumanPlaces `sort.field`).
 * `verification` (composite effective-status ranking) and `events` are
 * deliberately NOT server-sortable yet — sort requests for them are ignored
 * rather than lying with a per-page client sort.
 */
const SERVER_SORT_FIELDS = ["name", "created", "capacity", "status"] as const;
type ServerSortField = (typeof SERVER_SORT_FIELDS)[number];

function isServerSortField(id: string): id is ServerSortField {
  return (SERVER_SORT_FIELDS as readonly string[]).includes(id);
}

interface PlaceRow {
  placeId: string;
  name: string;
  /**
   * ADDRESS PRIVACY (place-address-withholding). This listing includes
   * globally VERIFIED venues the actor does NOT own, so it is a cross-tenant
   * read: `listHumanPlaces` sends the real address only to an owner, and
   * nulls the street fields for everyone else. This flag says which happened,
   * so a redacted row reads as "withheld" rather than "no address on file".
   */
  locationIsExact: boolean;
  formattedAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  capacity: number | null;
  lat: number | null;
  lng: number | null;
  /** Count of PUBLISHED events at this place (drafts/cancelled excluded). */
  eventsCount: number;
  status: PlaceStatus;
  verificationStatus: PlaceVerificationStatus;
  activeVerificationRequestStatus: "PENDING" | "IN_REVIEW" | null;
  listedInDirectory: boolean;
  createdAt: Date | string;
  access: {
    orgIds: string[];
    humanIds: string[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

import { buildFreshClientKey } from "@/lib/crypto-utils";

const VERIFICATION_LABELS: Record<
  EffectiveVerificationStatus,
  { labelKey: string; descriptionKey: string }
> = {
  VERIFIED: {
    labelKey: "admin.placesVerified",
    descriptionKey: "admin.placesVerifiedDescription",
  },
  PENDING: {
    labelKey: "admin.placesPendingLabel",
    descriptionKey: "admin.placesPendingDescription",
  },
  IN_REVIEW: {
    labelKey: "admin.placesPendingLabel",
    descriptionKey: "admin.placesPendingDescription",
  },
  UNVERIFIED: {
    labelKey: "admin.placesUnverified",
    descriptionKey: "admin.placesUnverifiedDescription",
  },
  REJECTED: {
    labelKey: "admin.placesRejected",
    descriptionKey: "admin.placesRejectedDescription",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const PlacesTable = () => {
  const t = useTranslations();
  const { toast } = useNotify();
  const router = useRouter();
  const { slug } = useParams<{ slug: string }>();
  const utils = trpc.useUtils();
  const ownerEntities = useEventOwnerEntities();
  // Resolve the current owner's role for cosmetic write gating. Shares the
  // useEventOwnerEntities react-query cache — no extra fetch.
  const { currentOwner } = useCurrentAdminOwner(slug);
  // Content-edit (upsertPlace/bulkUpsert, archive) mirrors ORG_EDIT_ROLES;
  // verification (updatePlaceVerificationStatus) mirrors ORG_ADMIN_ROLES. Both
  // still compose with the existing isOwnedPlace check. UX-only; server 403s.
  const { canEdit, canManage } = useAdminOwnerCapabilities(currentOwner);
  const { gates } = useFeatureGates();
  const isMobile = useIsMobile();

  const [showImportDialog, setShowImportDialog] = useState(false);
  // The "New place" quick action collects a minimum honest address before it
  // writes anything — see NewPlaceDialog for why it is no longer one-click.
  const [showNewPlaceDialog, setShowNewPlaceDialog] = useState(false);
  // FR-013: the row action and the expanded panel both open THE shared
  // verification-request modal now (the same component the place editor and
  // the /verify route render) instead of flipping the status straight to
  // PENDING with no documents attached.
  //
  // Two pieces of state on purpose: the row STAYS set after close so the Modal
  // stays mounted and its focus-return effect — which fires on the open
  // true→false transition, and never runs at all if the component unmounts
  // instead — can hand focus back. Nothing inside the dialog renders while it
  // is closed, so the per-place `getPlaceDetail` read still only happens on
  // open.
  //
  // That alone is NOT sufficient from this surface, and it is worth being
  // precise about why: the modal captures its opener from
  // `document.activeElement`, and `RowActionMenu` used to detach the activated
  // menu item in the same commit that ran `onPress` — so the opener captured
  // was <body>, on the first open and every one after. Keeping the row set
  // bought nothing. The actual fix lives in `RowActionMenu.handleItemPress`
  // (refocus the trigger BEFORE invoking the item); this state shape is the
  // other half of the contract, not the whole of it.
  const [verifyModalRow, setVerifyModalRow] = useState<PlaceRow | null>(null);
  const [verifyModalOpen, setVerifyModalOpen] = useState(false);
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "name",
    direction: "asc",
  });

  const toggleExpand = useCallback((placeId: string) => {
    setExpandedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(placeId)) next.delete(placeId);
      else next.add(placeId);
      return next;
    });
  }, []);

  // ── Search / filter / pagination state (URL-synced) ─────────────────────
  const {
    searchQuery,
    debouncedSearch,
    page,
    pageSize,
    extra,
    handleSearchChange,
    setPage,
    setPageSize,
    setExtra,
  } = useAdminTableParams({ extraKeys: ["status", "verified"] });

  // "active" (the default, param omitted) = status != ARCHIVED — deliberately
  // INCLUDES SUSPENDED venues, matching the old client filter's semantics
  // (the server implements exactly this). "archived" / "all" round-trip via
  // `?status=`; anything else in the URL normalises to the default.
  const statusFilter: StatusFilter =
    extra.status === "archived" || extra.status === "all"
      ? extra.status
      : "active";
  const verifiedOnly = extra.verified === "1";

  // ── Column visibility ────────────────────────────────────────────────────
  const ALL_COL_IDS = [
    "name",
    "status",
    "events",
    "capacity",
    "verification",
    "created",
  ] as const;

  const columnOptions: ColumnOption[] = useMemo(
    () => [
      { id: "name", label: String(t("admin.placesColumnPlace")) },
      { id: "status", label: String(t("admin.placesColumnStatus")) },
      // Plain English on purpose (admin-only chrome; a new i18n key would
      // require editing the locale JSON catalogs). "Published" because the
      // count covers PUBLISHED events only — drafts/cancelled excluded.
      { id: "events", label: "Published" },
      { id: "capacity", label: String(t("admin.placesColumnCapacity")) },
      { id: "verification", label: "Verification" },
      { id: "created", label: "Created" },
    ],
    [t],
  );

  const colVis = useColumnVisibility("admin-places-columns", ALL_COL_IDS);
  // Destructured so the memos below can depend on the stable callback
  // instead of the whole colVis object (mirrors OrdersTable).
  const { isVisible: isColumnVisible } = colVis;

  // ── Row density (persisted per-table, mirroring the columns key) ────────
  const { density, toggleDensity } = useTableDensity("admin-places-density");

  // ── WHICH VENUES THIS PAGE COVERS ────────────────────────────────────────
  //
  // Scoped to the admin context in the URL, NOT to "everything this person can
  // reach". This used to send every org the signed-in human belongs to,
  // whatever context they were standing in, which had two consequences — one
  // confusing, one a disclosure:
  //
  //   • standing in one org you saw ANOTHER org's venues under "Manage your
  //     venues", while that org's Bookings page (correctly single-tenant)
  //     showed only its own — the two surfaces disagreeing about what "your
  //     venues" means;
  //   • paired with `ownedOnly: false` below, the query's access filter ORs in
  //     `verification: VERIFIED`, so the table listed EVERY verified venue on
  //     the platform. Measured in dev: an org owning ZERO venues was shown
  //     nine, none of them theirs. Nothing could be done with them (every
  //     write and the per-venue inbox are gated by `requirePlaceOwnership`,
  //     which returns ACCESS DENIED), but a directory of strangers' venues was
  //     being presented as this account's.
  //
  // The set now matches `listOwnerScopePlaces` on the booking side exactly:
  //   - org context      → that org's venues, and nothing else;
  //   - personal context → the person's own venues PLUS the venues of orgs
  //                        they can ACT for (a hub, not a tenant — same rule
  //                        the personal Bookings inbox uses).
  //
  // The personal leg is filtered to ORG_EDIT_ROLES, matching that inbox: a
  // personal hub answers "what is mine to manage", and a venue you can only
  // look at is not. A VIEWER/FINANCE/SCANNER member still sees that org's
  // venues in the ORG's own Places page — this only decides what lands in a
  // PERSONAL list.
  //
  // NOT a security boundary, and not pretending to be: the server authorizes
  // `orgIds` against real memberships (`resolveAuthorizedOrgIds`) whatever we
  // send, so this is scoping, the same way the org branch below is. The
  // ownership-only `ownedOnly: true` is what actually closed the leak.
  const isHumanContext = currentOwner?.kind === "human";
  const orgIds = useMemo(() => {
    const owners = ownerEntities.ownersWithSlugs ?? [];
    if (currentOwner?.kind === "org") return [currentOwner.orgId];
    // Personal context (or an unresolved owner — the query is gated on
    // `ownerEntities` settling, so this is the pre-resolution pass only).
    if (!isHumanContext) return [];
    return owners
      .filter(
        (o): o is Extract<typeof o, { kind: "org" }> =>
          o.kind === "org" && ORG_EDIT_ROLES.includes(o.role),
      )
      .map((o) => o.orgId);
  }, [ownerEntities.ownersWithSlugs, currentOwner, isHumanContext]);

  // Extract the current user's humanId for client-side ownership checks
  const actorHumanId = useMemo(() => {
    const owners = ownerEntities.ownersWithSlugs ?? [];
    const human = owners.find((o) => o.kind === "human");
    return human
      ? (human as Extract<typeof human, { kind: "human" }>).humanId
      : null;
  }, [ownerEntities.ownersWithSlugs]);

  /** True when the current admin user (or one of their orgs) owns a place. */
  const isOwnedPlace = useCallback(
    (row: PlaceRow): boolean => {
      if (actorHumanId && row.access.humanIds.includes(actorHumanId))
        return true;
      return orgIds.some((oid) => row.access.orgIds.includes(oid));
    },
    [actorHumanId, orgIds],
  );

  // Server-side sort, applied BEFORE pagination. Falls back to the default
  // (name asc) if the sort state ever lands on a non-server-sortable column
  // (e.g. a stale "verification" sort from an old default).
  // listHumanPlaces caps `limit` at 50 — clamp so a stale `?ps=100` URL (the
  // shared PAGE_SIZE_OPTIONS include 100 for other admin tables) degrades
  // gracefully instead of 400ing the page permanently.
  //
  // ONE derived value drives limit, offset, totalPages, AND the pager's
  // pageSize. Clamping only `limit` desynced the window from the pager: the
  // server returned 50 rows while the pager advanced by 100, so rows 50–99 of
  // every window were unreachable and totalPages under-counted — which
  // usePageClamp would then act on.
  const effectivePageSize = Math.min(pageSize, 50);

  const sortInput = useMemo(
    () =>
      isServerSortField(sort.columnId)
        ? { field: sort.columnId, direction: sort.direction }
        : ({ field: "name", direction: "asc" } as const),
    [sort],
  );

  // The `verification`/`events` columns opt out of sort affordances via
  // `sortable: false`, so DataTable never emits sort requests for them —
  // this guard is belt-and-braces against stale sort state (e.g. an old
  // URL/default) rather than pretending with a per-page sort.
  const handleSortChange = useCallback(
    (next: DataTableSortState) => {
      if (!isServerSortField(next.columnId)) return;
      setSort(next);
      // A new sort re-windows the whole result set — page 3 of the old
      // ordering is meaningless in the new one.
      setPage(0);
    },
    [setPage],
  );

  const listInput = useMemo(
    () => ({
      limit: effectivePageSize,
      offset: page * effectivePageSize,
      // Server search contract is trim + min(2) + max(140) — anything
      // shorter is sent as "no query" instead of a guaranteed BAD_REQUEST
      // on every 1-char keystroke.
      query:
        debouncedSearch.trim().length >= 2
          ? debouncedSearch.trim().slice(0, 140)
          : undefined,
      verifiedOnly,
      // OWNERSHIP-ONLY. `false` here ORs `verification: VERIFIED` into the
      // access filter server-side, which turns this table into the platform's
      // whole verified-venue directory — see the scoping note on `orgIds`.
      ownedOnly: true,
      // Personal context only: keep the venues the person owns DIRECTLY in the
      // result alongside their orgs'. Without this, `ownedOnly` + `orgIds`
      // means org-owned only (the event-builder rule) and a personally-held
      // venue would vanish from their own admin.
      ...(isHumanContext ? { includeActorOwnedWithOrgs: true } : {}),
      sort: sortInput,
      // Passed explicitly — omitting it would fall back to the legacy
      // ACTIVE-only scope and hide archived rows from the "archived"/"all"
      // filters.
      status: statusFilter,
      ...(orgIds.length > 0 ? { orgIds } : {}),
    }),
    [
      debouncedSearch,
      verifiedOnly,
      statusFilter,
      sortInput,
      orgIds,
      isHumanContext,
      page,
      effectivePageSize,
    ],
  );

  const { data, isLoading, isFetching, error, refetch } =
    trpc.places.listHumanPlaces.useQuery(listInput, {
      staleTime: 30_000,
      placeholderData: keepPreviousData,
      // Wait for the owner-entities query to settle so the FIRST fetch
      // already carries orgIds — an ungated fetch returns a human-only list
      // (and a wrong total that keepPreviousData shows) until orgs resolve.
      enabled: !ownerEntities.isPending,
    });
  const updateStatusMutation = trpc.places.updatePlaceStatus.useMutation({
    meta: { silent: true },
  });
  const upsertMutation = trpc.places.upsertPlace.useMutation({
    meta: { silent: true },
  });
  const bulkUpsertMutation = trpc.places.bulkUpsertPlaces.useMutation({
    meta: { silent: true },
  });
  // NOTE: this table used to call `places.updatePlaceVerificationStatus`
  // directly to flip a place to PENDING. That was a second, document-less
  // request path competing with the real doc-upload flow — it created a queue
  // entry a reviewer had nothing to review. Removed in favour of the shared
  // modal (FR-013); the status-flip procedure remains platform-staff-only.

  // Rows arrive filtered, sorted, and windowed by the server — no client
  // re-sort (a per-page sort would lie about the dataset's true order).
  const rows = data?.places ?? [];

  // Mutations
  const toggleArchived = useCallback(
    async (place: PlaceRow) => {
      const targetStatus = place.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED";
      try {
        await updateStatusMutation.mutateAsync({
          placeId: place.placeId,
          status: targetStatus,
          clientKey: buildFreshClientKey(),
        });
        toast.success({
          id: "place-status-updated",
          title: t("admin.placesUpdated") as string,
          message:
            targetStatus === "ARCHIVED"
              ? (t("admin.placesArchived") as string)
              : (t("admin.placesRestored") as string),
        });
        await utils.places.listHumanPlaces.invalidate();
      } catch (err) {
        toast.danger({
          id: "place-status-failed",
          title: t("admin.placesUpdateFailed") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    // `t` included: the toast copy above reads from it, so omitting it pinned
    // this callback to the locale that was active when the table first
    // rendered (react-hooks/exhaustive-deps).
    [toast, t, updateStatusMutation, utils.places.listHumanPlaces],
  );

  /** Opens the shared verification-request modal for a row (FR-013). */
  const requestVerification = useCallback((place: PlaceRow) => {
    setVerifyModalRow(place);
    setVerifyModalOpen(true);
  }, []);

  const handleCreatePlace = useCallback(
    async (draft: NewPlaceDraft) => {
      const firstOrg = ownerEntities.ownersWithSlugs?.find(
        (o) => o.kind === "org",
      );
      const firstHuman = ownerEntities.ownersWithSlugs?.find(
        (o) => o.kind === "human",
      );
      const owner:
        | { kind: "org"; orgId: string }
        | { kind: "human"; humanId: string }
        | null =
        firstOrg?.kind === "org"
          ? { kind: "org", orgId: firstOrg.orgId }
          : firstHuman?.kind === "human"
            ? { kind: "human", humanId: firstHuman.humanId }
            : null;

      if (!owner) {
        toast.danger({
          id: "place-no-owner",
          title: t("admin.placesNoOwner") as string,
          message: t("admin.placesNoOwnerMessage") as string,
        });
        return;
      }

      try {
        const result = await upsertMutation.mutateAsync({
          // Everything below came from the organiser via NewPlaceDialog.
          // NOTHING here is forged.
          //
          // The old quick action sent `name: "New Place"` with
          // `address: { formatted: "TBD", line1: "TBD" }` unconditionally, so
          // every place created from this table was born with a literal "TBD"
          // in `Place.addrLine1` — which persisted, fed `addressHash`, and
          // rendered as the venue's street on its public page.
          name: draft.name,
          address: {
            // Built from the parts we actually have, in the SAME order and
            // with the same `", "` join as the place editor's
            // `rebuiltAddress`, so `addressHash` (the adapter's
            // `formatted.toLowerCase()`) is consistent across surfaces and
            // does not churn when the editor next saves an unchanged address.
            formatted: [draft.city, draft.countryCode]
              .filter(Boolean)
              .join(", "),
            // `line1` is OMITTED, not sentinel-filled: `addressSchema` makes it
            // optional precisely so "no street address yet" is representable.
            // The editor this create bounces into collects it.
            city: draft.city,
            countryCode: draft.countryCode,
          },
          owner,
          // ADDRESS PRIVACY, as picked in the dialog (starts shown). Sent
          // explicitly so a hide reaches the create itself, where it also
          // decides the new venue's performer-review default.
          ...placePrivacyToUpsertInput(draft.privacy),
          clientKey: buildFreshClientKey(),
        });
        setShowNewPlaceDialog(false);
        // Invalidate in background so list is fresh when user navigates back
        void utils.places.listHumanPlaces.invalidate();
        router.push(`/admin/${slug}/places/${result.placeId}/settings`);
      } catch (err) {
        toast.danger({
          id: "place-create-failed",
          title: t("admin.placesCreateFailed") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    [
      ownerEntities.ownersWithSlugs,
      toast,
      t,
      upsertMutation,
      utils.places.listHumanPlaces,
      slug,
      router,
    ],
  );

  const handleRowPress = useCallback(
    (row: PlaceRow) => {
      toggleExpand(row.placeId);
    },
    [toggleExpand],
  );

  // ── CSV import ────────────────────────────────────────────────────────

  const handleCsvImport = useCallback(
    async (rows: Record<string, string>[]): Promise<CsvImportResult> => {
      const firstOrg = ownerEntities.ownersWithSlugs?.find(
        (o) => o.kind === "org",
      );
      const firstHuman = ownerEntities.ownersWithSlugs?.find(
        (o) => o.kind === "human",
      );
      const owner:
        | { kind: "org"; orgId: string }
        | { kind: "human"; humanId: string }
        | null =
        firstOrg?.kind === "org"
          ? { kind: "org", orgId: firstOrg.orgId }
          : firstHuman?.kind === "human"
            ? { kind: "human", humanId: firstHuman.humanId }
            : null;

      if (!owner) {
        throw new Error(String(t("admin.placesNoOwner")));
      }

      const bulkResult = await bulkUpsertMutation.mutateAsync({
        places: rows.map((row) => ({
          name: row.name,
          address: {
            // Shared with the platform importer. `line1` is now simply absent
            // when the row has no street address instead of being filled with
            // the literal "TBD" that used to persist to `Place.addrLine1`.
            ...buildPlaceCsvAddress(row),
            lat: row.lat ? parseFloat(row.lat) || undefined : undefined,
            lng: row.lng ? parseFloat(row.lng) || undefined : undefined,
          },
          owner,
          capacity: row.capacity
            ? parseInt(row.capacity, 10) || undefined
            : undefined,
          phone: row.phone || undefined,
          website: row.website || undefined,
          bio: row.bio || undefined,
          clientKey: buildFreshClientKey(),
        })),
      });

      void utils.places.listHumanPlaces.invalidate();
      return {
        total: bulkResult.total,
        imported: bulkResult.imported,
        skipped: bulkResult.skipped,
      };
    },
    [
      ownerEntities.ownersWithSlugs,
      bulkUpsertMutation,
      utils.places.listHumanPlaces,
      t,
    ],
  );

  // Column definitions
  const columns: DataTableColumn<PlaceRow>[] = useMemo(
    () => [
      {
        id: "name",
        header: String(t("admin.placesColumnPlace")),
        width: 3,
        truncate: false,
        cell: (row) => {
          const effective = effectiveVerificationStatus(
            row.verificationStatus,
            row.activeVerificationRequestStatus,
          );
          const vIcon = VERIFICATION_ICON_MAP[effective];
          const address = buildFullAddress(row);
          // The Verification badge column is the primary home for this
          // fact — the in-cell shield only steps in when that column is
          // hidden, so the same status is never shown twice per row.
          const showVerificationIcon = !isColumnVisible("verification");
          return (
            <XStack gap="$2" alignItems="flex-start">
              {showVerificationIcon && (
                <Tooltip
                  anchor={
                    <Stack flexShrink={0} justifyContent="center" height={20}>
                      <vIcon.Icon size={16} color={vIcon.color} />
                    </Stack>
                  }
                  placement="right"
                  tone="neutral"
                  maxWidth={260}
                >
                  <YStack gap="$1">
                    <Text variant="bodySmall" weight="bold">
                      {String(
                        t(VERIFICATION_LABELS[row.verificationStatus].labelKey),
                      )}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {String(
                        t(
                          VERIFICATION_LABELS[row.verificationStatus]
                            .descriptionKey,
                        ),
                      )}
                    </Text>
                  </YStack>
                </Tooltip>
              )}
              <YStack gap="$1" flex={1} minWidth={0}>
                <Text
                  variant="body"
                  style={{
                    fontWeight: 700,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.name}
                </Text>
                {/* DT_CELL_SUB_CLASS: the secondary line collapses away at
                    density="compact" — that collapse is what makes the
                    density toggle actually change row height, not just cell
                    padding. */}
                {(address || row.locationIsExact !== true) && (
                  <XStack
                    gap="$1"
                    alignItems="center"
                    opacity={0.7}
                    className={DT_CELL_SUB_CLASS}
                  >
                    <MapPin size={11} style={{ flexShrink: 0 }} />
                    <Text
                      variant="caption"
                      tone="muted"
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {/* "Withheld" rather than an empty cell: this listing
                          includes venues the actor does not own, and a blank
                          address otherwise reads as missing data someone
                          should go and fix. */}
                      {address ?? String(t("admin.placesAddressWithheld"))}
                    </Text>
                  </XStack>
                )}
              </YStack>
            </XStack>
          );
        },
      },
      {
        id: "status",
        header: String(t("admin.placesColumnStatus")),
        width: 0.8,
        truncate: true,
        tooltipValue: (row) => row.status,
        cell: (row) => (
          <Badge tone={getStatusBadgeTone(row.status)} size="sm">
            {row.status}
          </Badge>
        ),
      },
      {
        id: "events",
        // "Published", not "Events": the aggregate counts PUBLISHED events
        // only (drafts/cancelled excluded) and DataTableColumn has no
        // header-tooltip affordance to carry that nuance on a vaguer label.
        header: "Published",
        width: 0.8,
        align: "right",
        // Not in the server's sort fields — render a plain header instead
        // of a dead affordance.
        sortable: false,
        cell: (row) => (
          <Text
            variant="body"
            tone={row.eventsCount === 0 ? "muted" : "default"}
          >
            {row.eventsCount.toLocaleString()}
          </Text>
        ),
      },
      {
        id: "capacity",
        // 0.9 (was 0.7): at 0.7 the th content box (~65px) could not hold
        // the "Capacity" sort button (~84px = label + caret + gap) and the
        // header spilled into the neighbour column. ~133px/weight-unit at
        // 1440w → 0.9 ≈ 120px th ≈ 92px content, a comfortable fit.
        header: String(t("admin.placesColumnCapacity")),
        width: 0.9,
        align: "right",
        cell: (row) => (
          <XStack gap="$1" alignItems="center" justifyContent="flex-end">
            {row.capacity ? (
              <>
                <Users size={13} style={{ opacity: 0.5 }} />
                <Text variant="body">{row.capacity.toLocaleString()}</Text>
              </>
            ) : (
              <Text variant="body" tone="muted">
                —
              </Text>
            )}
          </XStack>
        ),
      },
      {
        id: "verification",
        header: "Verification",
        width: 1,
        truncate: true,
        // The composite effective-status ranking can't be server-sorted
        // (deliberate backend deferral) — no sort affordance rather than a
        // lying per-page sort.
        sortable: false,
        tooltipValue: (row) => {
          const effective = effectiveVerificationStatus(
            row.verificationStatus,
            row.activeVerificationRequestStatus,
          );
          return effective.replace("_", " ");
        },
        cell: (row) => {
          const effective = effectiveVerificationStatus(
            row.verificationStatus,
            row.activeVerificationRequestStatus,
          );
          return (
            <Badge tone={badgeToneForVerification(effective)} size="sm">
              {effective.replace("_", " ")}
            </Badge>
          );
        },
      },
      {
        id: "created",
        header: "Created",
        width: 1.2,
        truncate: true,
        tooltipValue: (row) => new Date(row.createdAt).toLocaleString(),
        cell: (row) => (
          <Text variant="bodySmall" tone="muted">
            {new Date(row.createdAt).toLocaleDateString()}
          </Text>
        ),
      },
    ],
    [isColumnVisible, t],
  );

  const visibleColumns = useMemo(
    () => columns.filter((c) => isColumnVisible(c.id)),
    [columns, isColumnVisible],
  );

  // Row actions — edit, layout, and archive are gated to owned places.
  const rowActions = useMemo(
    () => ({
      header: "",
      width: 0.8,
      render: (row: PlaceRow) => {
        const owned = isOwnedPlace(row);
        // Edit/layout/calendar/bookings/page/archive are ORG_EDIT_ROLES (canEdit);
        // verification is ORG_ADMIN_ROLES (canManage). Both still require the
        // actor to own the place. A read-only role that can't edit sees no
        // actions menu at all.
        if (!owned || !canEdit) return null;

        const items: RowActionMenuItem[] = [
          {
            key: "edit",
            label: String(t("admin.placesEditTooltip")),
            icon: <Pencil size={14} />,
            onPress: () =>
              router.push(`/admin/${slug}/places/${row.placeId}/settings`),
          },
          ...(gates?.seatingLayouts
            ? [
                {
                  key: "layout",
                  label: String(t("admin.placesLayoutTooltip")),
                  icon: <Grid3x3 size={14} />,
                  onPress: () =>
                    router.push(`/admin/${slug}/places/${row.placeId}/layout`),
                },
              ]
            : []),
          {
            key: "calendar",
            label: String(t("admin.placesCalendarTooltip")),
            icon: <Calendar size={14} />,
            onPress: () =>
              router.push(`/admin/${slug}/places/${row.placeId}/calendar`),
          },
          {
            // Same icon as the place rail's Bookings entry so the two
            // affordances read as one destination.
            key: "bookings",
            label: String(t("admin.placesBookingsTooltip")),
            icon: <Inbox size={14} />,
            onPress: () =>
              router.push(`/admin/${slug}/places/${row.placeId}/bookings`),
          },
          {
            key: "page",
            label: String(t("admin.placesPageEditorTooltip")),
            icon: <FileText size={14} />,
            onPress: () =>
              router.push(`/admin/${slug}/places/${row.placeId}/page`),
          },
          // Request-verification is ORG_ADMIN_ROLES — only surface the
          // actionable verify item to canManage roles. The read-only status
          // item below stays visible.
          ...(row.verificationStatus === "UNVERIFIED" && canManage
            ? (() => {
                const eligibility = getPlaceVerificationEligibility({
                  name: row.name,
                  addressLine1: row.addressLine1,
                  city: row.city,
                  countryCode: row.countryCode,
                  orgIdsWithAccess: row.access.orgIds,
                  humanIdsWithAccess: row.access.humanIds,
                });
                return [
                  {
                    key: "verify",
                    // The label still names the first blocker at a glance, but
                    // the item stays ENABLED: the modal lists every blocker in
                    // full, which beats a dead menu row the admin can't act on.
                    label: eligibility.eligible
                      ? String(t("admin.placesRequestVerification"))
                      : String(
                          t("admin.placesNotReady", {
                            reason: eligibility.reasons[0],
                          }),
                        ),
                    icon: <Send size={14} />,
                    onPress: () => requestVerification(row),
                  },
                ];
              })()
            : row.verificationStatus === "UNVERIFIED"
              ? []
              : [
                  {
                    key: "verification-status",
                    label:
                      row.verificationStatus === "PENDING"
                        ? String(t("admin.placesVerificationPending"))
                        : row.verificationStatus === "VERIFIED"
                          ? String(t("admin.placesVerified"))
                          : String(t("admin.placesVerificationRejected")),
                    icon: (() => {
                      const v = VERIFICATION_ICON_MAP[row.verificationStatus];
                      return <v.Icon size={14} color={v.color} />;
                    })(),
                    disabled: true,
                    onPress: () => {},
                  },
                ]),
          ...(row.status === "ARCHIVED"
            ? [
                {
                  key: "restore",
                  label: String(t("admin.placesRestoreTooltip")),
                  icon: <RotateCcw size={14} />,
                  disabled: updateStatusMutation.isPending,
                  onPress: () => void toggleArchived(row),
                },
              ]
            : [
                {
                  key: "archive",
                  label: String(t("admin.placesArchiveTooltip")),
                  icon: <Archive size={14} />,
                  tone: "danger" as const,
                  disabled: updateStatusMutation.isPending,
                  onPress: () => void toggleArchived(row),
                },
              ]),
        ];

        return (
          <XStack justifyContent="flex-end">
            <RowActionMenu
              items={items}
              ariaLabel={`Actions for ${row.name}`}
            />
          </XStack>
        );
      },
    }),
    [
      toggleArchived,
      requestVerification,
      updateStatusMutation.isPending,
      router,
      slug,
      isOwnedPlace,
      canEdit,
      canManage,
      gates?.seatingLayouts,
      t,
    ],
  );

  // ── Filters (URL-synced chips) ───────────────────────────────────────────
  // Standard admin-table chip grammar: resting = no chip = default scope
  // (active); chips express non-default scopes only. There is deliberately
  // NO "Active" chip — it would sit permanently selected at rest.
  const statusChipOptions = useMemo(
    () => [
      {
        value: "archived" as const,
        label: String(t("admin.placesArchivedStatus")),
      },
      { value: "all" as const, label: String(t("admin.placesAllStatuses")) },
    ],
    [t],
  );

  const clearFilters = useCallback(() => {
    handleSearchChange("");
    setExtra("status", undefined);
    setExtra("verified", undefined);
    // Same-commit page reset (see the chip handlers) — the hook's own
    // post-commit reset then no-ops.
    setPage(0);
  }, [handleSearchChange, setExtra, setPage]);

  const totalRows = data?.pageInfo?.total ?? 0;
  const totalPages = Math.ceil(totalRows / effectivePageSize);

  // Stale/shared URLs (?p=3 against a shrunken or newly-filtered dataset)
  // snap back to the last real page once the query settles, instead of
  // stranding an empty state with the pager hidden.
  usePageClamp({ page, totalPages, isFetching, setPage });

  const hasActiveSearch = debouncedSearch.length > 0;
  const hasActiveFilters =
    hasActiveSearch || statusFilter !== "active" || verifiedOnly;

  // ── Empty states (shared chrome) ─────────────────────────────────────────
  // Every branch is the SAME `NoResults` block OrdersTable uses; only the copy
  // and the presence of a clear button differ.
  // • active search        → NoResults + clear-search
  // • non-default filters  → NoResults + clear-filters (archived / all / verified)
  // • pristine             → NoResults describing the empty table, NO CTA.
  //   The page header already owns the one primary "New place" action (v2 §04
  //   one-primary-per-viewport); the old SkeletonEmptyState painted a second
  //   create button over 300px of ghost rows, duplicating it. One branch for
  //   both roles — the old canEdit split existed only because
  //   SkeletonEmptyState REQUIRED a CTA read-only roles cannot use.
  //   The DESCRIPTION is still role-gated: it is an imperative ("Create your
  //   first venue…") and the header's create button is canEdit-gated too, so a
  //   read-only viewer would be told to do something with no affordance
  //   anywhere on the page. They get the title alone. `placesSubtitle`
  //   ("Manage your venues and locations.") is not a neutral substitute — it
  //   already renders as this page's header subtitle a few rows above.
  const emptyState = hasActiveSearch ? (
    <NoResults
      title={String(t("admin.placesNoSearchResults"))}
      description={String(t("admin.placesNoSearchResultsDescription"))}
      onClearFilters={() => handleSearchChange("")}
    />
  ) : statusFilter !== "active" || verifiedOnly ? (
    <NoResults
      title={
        statusFilter === "archived"
          ? String(t("admin.placesEmptyArchived"))
          : String(t("admin.placesEmptyAll"))
      }
      description={String(t("admin.placesEmptyFilterDescription"))}
      onClearFilters={clearFilters}
    />
  ) : (
    <NoResults
      title={String(t("admin.placesEmptyActive"))}
      description={
        canEdit ? String(t("admin.placesEmptyCreateDescription")) : undefined
      }
    />
  );

  const summaryLabel = (() => {
    if (!data?.pageInfo || totalRows === 0) return undefined;
    const start = page * effectivePageSize + 1;
    const end = Math.min((page + 1) * effectivePageSize, totalRows);
    return String(t("admin.nOfTotal", { start, end, total: totalRows }));
  })();

  // `!data` (not `isLoading`) so the owner-gated period — where the places
  // query is disabled and isLoading is false — shows the loader instead of
  // flashing the create-first empty state.
  if (!data && !error) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingPlaces"))}
      >
        {null}
      </AdminPageData>
    );
  }

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      {/* Header */}
      <AdminPageHeader
        title={String(t("admin.placesHeading"))}
        subtitle={String(t("admin.placesSubtitle"))}
        section="places"
        trailing={
          canEdit ? (
            <Button
              variant="primary"
              size="$3"
              onPress={() => setShowNewPlaceDialog(true)}
            >
              <Plus size={16} />
              {String(t("admin.placesNewPlace"))}
            </Button>
          ) : undefined
        }
      />

      {/* Filters row — search + URL-synced status/verified chips. Stays
          mounted even when the query errors so a filter/search-induced
          failure is always self-recoverable in place. */}
      <FilterRow hasActiveFilters={hasActiveFilters} onClearAll={clearFilters}>
        <SearchBar
          value={searchQuery}
          onChangeText={handleSearchChange}
          placeholder={t("admin.placesSearchPlaceholder") as string}
          // Server cap on `query` (max 140).
          maxLength={140}
          testId="admin-places-search"
        />
        {/* Non-default lifecycle scopes only — nothing selected = the
            ACTIVE default; deselecting a chip drops `?status` and falls
            back to it. setPage(0) batches the page reset into the same
            commit as the filter change — the hook's own post-commit reset
            then no-ops instead of costing a stale-offset fetch. */}
        <FilterChips
          options={statusChipOptions}
          selected={statusFilter === "active" ? undefined : statusFilter}
          onSelect={(value) => {
            setExtra("status", value);
            setPage(0);
          }}
        />
        {/* Independent VERIFIED toggle (verifiedOnly) — orthogonal to the
            single-select scope group, so it stays a separate FilterChips,
            but icon={null} renders it as a continuation of the one chip
            row (single leading funnel icon total). */}
        <FilterChips
          options={[
            { value: "1", label: String(t("admin.placesVerifiedOnly")) },
          ]}
          selected={verifiedOnly ? "1" : undefined}
          onSelect={(value) => {
            setExtra("verified", value);
            setPage(0);
          }}
          icon={null}
          // Two chip groups share this row — distinct group names so screen
          // readers don't announce both as "Filters".
          ariaLabel="Verification filter"
        />
      </FilterRow>

      {/* Table area — replaced by the shared error surface on failure while
          the header + filters above stay mounted, so an error caused by a
          bad filter/search is always recoverable in place. */}
      {error ? (
        <YStack flex={1} minHeight={400}>
          <AdminTableErrorState
            message={String(
              t("admin.placesLoadFailed", {
                error: formatErrorMessage(error, t),
              }),
            )}
            onRetry={() => {
              void refetch();
            }}
            testId="admin-places-error"
          />
        </YStack>
      ) : (
        /* The 640px table floor drops only below useIsMobile's 600px
          breakpoint, the same breakpoint DataTable uses for card mode, so
          the page never overflows horizontally on phones and there is no
          floorless band (Tamagui's $gtSm media query starts at 641px). */
        <YStack flex={1} minWidth={isMobile ? 0 : 640} minHeight={400}>
          <ActionBar onRefresh={() => void refetch()} countLabel={summaryLabel}>
            {canEdit && (
              <Button
                size="$2"
                variant="ghost"
                onPress={() => setShowImportDialog(true)}
                paddingHorizontal="$3"
                data-testid="admin-places-csv-import"
              >
                <XStack gap="$2" alignItems="center">
                  <Upload size={14} />
                  <Text variant="bodySmall">
                    {String(t("admin.csvImportTitle"))}
                  </Text>
                </XStack>
              </Button>
            )}
            {/* Density toggle — plain-English label on purpose: admin-only
                chrome, and a new i18n key would require editing the locale
                JSON catalogs (same rule as the range label in Pagination). */}
            <Button
              variant="ghost"
              size="$2"
              onPress={toggleDensity}
              aria-pressed={density === "compact"}
              paddingHorizontal="$3"
            >
              <XStack gap="$2" alignItems="center">
                <Rows3 size={14} />
                <Text variant="overline">Density</Text>
              </XStack>
            </Button>
            <ColumnSelector
              options={columnOptions}
              isVisible={colVis.isVisible}
              onToggle={colVis.toggleColumn}
              onShowAll={colVis.showAll}
              hasHidden={colVis.hasHidden}
            />
          </ActionBar>

          <TableContainer>
            <DataTable
              columns={visibleColumns}
              rows={rows}
              getRowKey={(row) => row.placeId}
              isLoading={isLoading}
              emptyState={emptyState}
              density={density}
              sort={sort}
              onSortChange={handleSortChange}
              onRowPress={handleRowPress}
              rowActions={rowActions}
              renderMobileCard={(row) => <PlaceMobileCard row={row} />}
              renderExpandedRow={(row) =>
                expandedRowIds.has(row.placeId) ? (
                  <PlaceDetailPanel
                    placeId={row.placeId}
                    slug={slug}
                    // Compose ownership with role: edit-level actions need
                    // isOwnedPlace && canEdit (ORG_EDIT_ROLES); verification
                    // needs isOwnedPlace && canManage (ORG_ADMIN_ROLES).
                    canEdit={isOwnedPlace(row) && canEdit}
                    canManage={isOwnedPlace(row) && canManage}
                    // Mirror the rowActions menu's seating-layout gate so the
                    // panel and the menu expose the same set of actions.
                    seatingLayoutsEnabled={Boolean(gates?.seatingLayouts)}
                    // Archive/restore and request-verification live only in the
                    // rowActions menu, which card mode (<600px) does not render
                    // — surface them in the expanded panel so the actions stay
                    // reachable on phones.
                    status={row.status}
                    onToggleArchived={() => void toggleArchived(row)}
                    toggleArchivedPending={updateStatusMutation.isPending}
                    verificationEligibility={
                      row.verificationStatus === "UNVERIFIED"
                        ? getPlaceVerificationEligibility({
                            name: row.name,
                            addressLine1: row.addressLine1,
                            city: row.city,
                            countryCode: row.countryCode,
                            orgIdsWithAccess: row.access.orgIds,
                            humanIdsWithAccess: row.access.humanIds,
                          })
                        : undefined
                    }
                    onRequestVerification={() => requestVerification(row)}
                  />
                ) : null
              }
              testIdBase="places-manager-table"
            />
          </TableContainer>

          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            // The CLAMPED size, not the raw one: the pager's range label and
            // its page arithmetic must describe the window the server
            // actually returned (see effectivePageSize).
            pageSize={effectivePageSize}
            onPageSizeChange={setPageSize}
            // listHumanPlaces caps `limit` at 50 — offering the default 100
            // option would 400 the query.
            pageSizeOptions={[10, 25, 50]}
            total={totalRows}
          />
        </YStack>
      )}

      {/* New-place dialog — upsertPlace is ORG_EDIT_ROLES, and the header CTA
          that opens it is canEdit-gated too. */}
      {canEdit && (
        <NewPlaceDialog
          open={showNewPlaceDialog}
          onClose={() => setShowNewPlaceDialog(false)}
          onSubmit={(draft) => void handleCreatePlace(draft)}
          pending={upsertMutation.isPending}
        />
      )}

      {/* CSV Import dialog — bulkUpsert is ORG_EDIT_ROLES; only mount for canEdit */}
      {canEdit && (
        <CsvImportDialog
          open={showImportDialog}
          onClose={() => setShowImportDialog(false)}
          fields={PLACE_IMPORT_FIELDS}
          onSubmit={handleCsvImport}
        />
      )}

      {/* Verification request (FR-013) — the SAME modal the place editor
          opens. Rendered once a row has been chosen and toggled by `open`;
          closed means nothing inside it renders (see the state note above). */}
      {verifyModalRow && (
        <RequestVerificationModal
          open={verifyModalOpen}
          placeId={verifyModalRow.placeId}
          placeName={verifyModalRow.name}
          access={verifyModalRow.access}
          formState={{
            name: verifyModalRow.name,
            addressLine1: verifyModalRow.addressLine1 ?? "",
            city: verifyModalRow.city ?? "",
            countryCode: verifyModalRow.countryCode ?? "",
          }}
          onClose={() => setVerifyModalOpen(false)}
        />
      )}
    </YStack>
  );
};

PlacesTable.displayName = "PlacesTable";
