"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { YStack, XStack } from "tamagui";
import {
  Modal,
  Text,
  Button,
  Badge,
  DateTime,
  LabeledTextInput,
  NextLinkAnchor,
  Switch,
  Tooltip,
  useNotify,
  useTranslations,
} from "@th/ui";
import {
  Archive,
  ArrowRight,
  BadgeCheck,
  ExternalLink,
  Eye,
  Merge,
  Pencil,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";

import { trpc } from "@/trpc";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import {
  PlaceDialog,
  REFUSAL_COPY,
  SecondFactorNotice,
  type PlaceDialogMode,
} from "@/components/places/PlaceDialog";
import type { PlacePickerItem } from "@/components/places/PlacePicker";
import { toRefusalReason } from "@/components/places/place-or-address.helpers";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { buildFreshClientKey } from "@/lib/crypto-utils";
import { VERIFICATION_ICON_MAP } from "@/lib/verification-config";
import {
  PlaceArchivedBadge,
  buildLocationString,
} from "./PlatformPlaceMobileCard";
import { LINK_ACTION_STYLE } from "./link-action-style";
import { PlaceMergeDialog } from "./PlaceMergeDialog";
import { moderatorPlacePageHref } from "@/lib/places/moderator-place-page-href";
import { type PlatformPlaceRow, type PlaceVerificationStatus } from "./types";

interface PlaceDetailPanelProps {
  place: PlatformPlaceRow;
  open: boolean;
  onClose: () => void;
  /** Called after any mutation so the parent can invalidate queries. */
  onMutated: () => void;
  /** Open the consolidated verification review flow for PENDING places. */
  onOpenReview: (place: PlatformPlaceRow) => void;
  /** Swap the panel to another place (the active duplicate of this one). */
  onOpenPlace: (place: PlatformPlaceRow) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const VERIFICATION_BADGE_TONE: Record<
  PlaceVerificationStatus,
  "success" | "info" | "danger" | "warning"
> = {
  VERIFIED: "success",
  PENDING: "info",
  REJECTED: "danger",
  UNVERIFIED: "warning",
};

const VERIFICATION_LABEL_KEY: Record<PlaceVerificationStatus, string> = {
  VERIFIED: "admin.ppVerified",
  PENDING: "admin.ppPending",
  REJECTED: "admin.ppRejected",
  UNVERIFIED: "admin.ppUnverified",
};

/** One plain line of where verification stands. */
const VERIFICATION_STATE_KEY: Record<PlaceVerificationStatus, string> = {
  UNVERIFIED: "admin.ppDetailStateUnverified",
  PENDING: "admin.ppDetailStatePending",
  VERIFIED: "admin.ppDetailStateVerified",
  REJECTED: "admin.ppDetailStateRejected",
};

/** Matches the core input's `plainTextOptional(280)` bound. */
const MAX_BYPASS_NOTE_LENGTH = 280;

/**
 * Statuses a place can be waived FROM.
 *
 * PENDING is excluded on purpose — see the button's comment below. The
 * authoritative guard is server-side (`VERIFICATION_REQUEST_IN_PROGRESS`);
 * this list only keeps the UI from offering a doomed action.
 */
const WAIVABLE_STATUSES: PlaceVerificationStatus[] = ["UNVERIFIED", "REJECTED"];

/** A list row in the picker's shape, for the shared PlaceDialog. */
function toPickerItem(place: PlatformPlaceRow): PlacePickerItem {
  return {
    placeId: place.placeId,
    name: place.name,
    formattedAddress: place.formattedAddress,
    city: place.city,
    region: place.region,
    // PlaceDialog's edit mode reads the coordinates from the public place
    // read before it shows the form; this item only names the place.
    lat: null,
    lng: null,
    timezone: null,
    status: place.status,
    verificationStatus: place.verificationStatus,
  };
}

/**
 * The address as one line. Some rows store only the street in
 * `formattedAddress`; the city line is added when it is not already there.
 */
function fullAddress(place: PlatformPlaceRow): string | null {
  const street = place.formattedAddress?.trim() || null;
  const location = buildLocationString({ ...place, formattedAddress: null });
  if (!street) return location;
  if (!location || (place.city && street.includes(place.city))) return street;
  return `${street}, ${location}`;
}

function SectionHead({
  label,
  right,
}: {
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <XStack
      alignItems="center"
      justifyContent="space-between"
      gap="$3"
      flexWrap="wrap"
    >
      <Text variant="overline" tone="muted" tag="h3">
        {label}
      </Text>
      {right}
    </XStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PlaceDetailPanel({
  place: placeProp,
  open,
  onClose,
  onMutated,
  onOpenReview,
  onOpenPlace,
}: PlaceDetailPanelProps) {
  const { toast } = useNotify();
  const t = useTranslations();
  const tr = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      String(t(key, values)),
    [t],
  );
  const utils = trpc.useUtils();
  const pathname = usePathname();
  const switchId = `${useId()}-directory`;

  // An edit made here shows at once, before the list refetch lands.
  const [patch, setPatch] = useState<Partial<PlatformPlaceRow>>({});
  const place = useMemo(() => ({ ...placeProp, ...patch }), [placeProp, patch]);

  // ── "Waive verification" confirmation state ──────────────────────────
  // Named `bypassReview` in code on purpose: `place-waivers.ts` in core is an
  // unrelated concept (place liability waivers shown at checkout), so no code
  // symbol here is called "waive". "Waive verification" is the user-facing
  // label only.
  const [showBypassConfirm, setShowBypassConfirm] = useState(false);
  const [bypassNote, setBypassNote] = useState("");

  // ── Lifecycle (ADMIN) state ──────────────────────────────────────────
  const [dialog, setDialog] = useState<PlaceDialogMode | null>(null);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [secondFactor, setSecondFactor] = useState(false);
  const [opening, setOpening] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const restoreKeyRef = useRef(buildFreshClientKey());

  // Reset per place.
  useEffect(() => {
    setPatch({});
    setShowBypassConfirm(false);
    setBypassNote("");
    setDialog(null);
    setShowRestoreConfirm(false);
    setSecondFactor(false);
    setShowMerge(false);
    restoreKeyRef.current = buildFreshClientKey();
  }, [placeProp.placeId]);

  // ── Who may do what ──────────────────────────────────────────────────
  //
  // The page itself (and `platform.listPlaces`) admits the WIDER staff set —
  // ADMIN/REVIEWER/SUPPORT/DEVELOPER. Every verification MUTATION is gated on
  // ADMIN/REVIEWER (`VERIFICATION_DECISION_ROLES` in the platform router), and
  // the place lifecycle writes (`community.*`: edit, archive, restore) admit
  // COMMUNITY_MODERATOR + ADMIN, of which only ADMIN can reach this page. So
  // edit/archive/restore are ADMIN-only here, and only ADMIN asks for
  // editability. Fail-closed either way; the server re-checks everything.
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    staleTime: 60_000,
  });
  const roles = staffAccessQuery.data?.roles ?? [];
  const canDecideVerification = roles.some(
    (role) => role === "ADMIN" || role === "REVIEWER",
  );
  const isAdmin = roles.includes("ADMIN");
  const ownerless = place.ownerCount === 0;
  const archived = place.status === "ARCHIVED";

  const editabilityQuery = trpc.community.getPlaceEditability.useQuery(
    { placeId: place.placeId },
    {
      enabled: open && isAdmin,
      staleTime: 0,
      retry: false,
      // Said inline (second factor, or the load failure), not as a toast.
      meta: { silent: true },
    },
  );
  const editability = editabilityQuery.data;

  // May this admin write the place's PAGE as a community moderator (unowned,
  // ACTIVE place; moderator-place-page D8)? Advisory: the editor route and
  // every write re-check. Owned or archived places never ask.
  const pageAccessQuery = trpc.entityPages.placePageEditAccess.useQuery(
    { placeId: place.placeId },
    {
      enabled: open && isAdmin && ownerless && !archived,
      staleTime: 0,
      retry: false,
      meta: { silent: true },
    },
  );
  const canEditPageAsModerator =
    pageAccessQuery.data?.canEditPage === true &&
    pageAccessQuery.data.editorKind === "community_moderator";
  const editabilityNeedsSecondFactor =
    getAppErrorCode(editabilityQuery.error) === "SECOND_FACTOR_REQUIRED";
  const showSecondFactor = secondFactor || editabilityNeedsSecondFactor;
  // Lifecycle actions need a fresh answer and no step-up gate in the way.
  const lifecycleReady =
    isAdmin && ownerless && editability !== undefined && !showSecondFactor;

  // ── Mutations ────────────────────────────────────────────────────────
  const [listed, setListed] = useState(placeProp.listedInDirectory);
  useEffect(() => {
    setListed(placeProp.listedInDirectory);
  }, [placeProp.placeId, placeProp.listedInDirectory]);

  const toggleDirectoryMut =
    trpc.placeReviews.toggleDirectoryListing.useMutation({
      onSuccess: (_data, vars) => {
        setListed(vars.listedInDirectory);
        void utils.platform.listPlaces.invalidate();
        onMutated();
      },
    });
  const verifyMut = trpc.platform.updatePlaceVerificationStatus.useMutation({
    onSuccess: () => {
      void utils.platform.listPlaces.invalidate();
      onMutated();
    },
  });
  const restoreMut = trpc.community.restorePlace.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const refreshAfterLifecycle = useCallback(() => {
    void utils.platform.listPlaces.invalidate();
    void utils.community.getPlaceEditability.invalidate({
      placeId: place.placeId,
    });
    onMutated();
  }, [utils, place.placeId, onMutated]);

  const handleVerify = useCallback(async () => {
    try {
      await verifyMut.mutateAsync({
        placeId: place.placeId,
        verificationStatus: "VERIFIED",
        clientKey: buildFreshClientKey(),
      });
      toast.success({ title: tr("admin.ppDetailVerified") });
      onClose();
    } catch (err) {
      toast.danger({
        title: tr("admin.ppDetailVerificationFailed"),
        message: formatErrorMessage(err, t),
      });
    }
  }, [place.placeId, verifyMut, toast, onClose, t, tr]);

  /**
   * "Waive verification" (FR-014).
   *
   * Same procedure and same use case as the staff Verify button — NOT a
   * parallel path — so it inherits the ADMIN/REVIEWER gate, the single
   * transaction, and the audit write (NFR-004). The only difference is the
   * `reason` discriminator (+ optional note) landing on the audit row, which
   * is what lets a later reader tell "we skipped document review" apart from
   * "we approved submitted documents".
   */
  const handleBypassReview = useCallback(async () => {
    try {
      await verifyMut.mutateAsync({
        placeId: place.placeId,
        verificationStatus: "VERIFIED",
        clientKey: buildFreshClientKey(),
        reason: "WAIVED_DOCUMENT_REVIEW",
        ...(bypassNote.trim() ? { note: bypassNote.trim() } : {}),
      });
      toast.success({ title: tr("admin.ppDetailWaiveSuccess") });
      setShowBypassConfirm(false);
      setBypassNote("");
      onClose();
    } catch (err) {
      toast.danger({
        title: tr("admin.ppDetailWaiveFailed"),
        message: formatErrorMessage(err, t),
      });
    }
  }, [place.placeId, bypassNote, verifyMut, toast, onClose, t, tr]);

  const handleToggleDirectory = useCallback(
    (next: boolean) => {
      toggleDirectoryMut.mutate({
        placeId: place.placeId,
        listedInDirectory: next,
      });
    },
    [place.placeId, toggleDirectoryMut],
  );

  /**
   * PlaceDialog's contract: editability is asked right before it opens, so
   * the dialog never offers a write the server has just started refusing.
   */
  const openDialog = useCallback(
    async (startAt: "form" | "archive") => {
      if (opening) return;
      setOpening(true);
      try {
        const e = await utils.community.getPlaceEditability.fetch(
          { placeId: place.placeId },
          { staleTime: 0 },
        );
        if (startAt === "form" ? !e.canEdit : !e.canArchive) return;
        setDialog({
          kind: "edit",
          place: toPickerItem(place),
          canEdit: e.canEdit,
          canArchive: e.canArchive,
          linkedListingCount: e.linkedListingCount,
          startAt,
        });
      } catch (err) {
        if (getAppErrorCode(err) === "SECOND_FACTOR_REQUIRED") {
          setSecondFactor(true);
        } else {
          toast.danger({
            title: tr("communityCreate.pfEditabilityFailed"),
            message: formatErrorMessage(err, t),
          });
        }
      } finally {
        setOpening(false);
      }
    },
    [opening, utils, place, toast, t, tr],
  );

  /**
   * Open another place's panel from its id: the list read's exact id filter
   * returns its row whatever its status or name. Read fresh (a cached row can
   * predate a merge or restore). True when the panel moved.
   */
  const openPlaceById = useCallback(
    async (placeId: string): Promise<boolean> => {
      if (opening) return false;
      setOpening(true);
      try {
        const res = await utils.platform.listPlaces.fetch(
          { placeIds: [placeId], limit: 1, offset: 0 },
          { staleTime: 0 },
        );
        const row = res.places.find((p) => p.placeId === placeId);
        if (row) {
          onOpenPlace(row);
          return true;
        }
        toast.danger({ title: tr("admin.ppDetailOpenPlaceFailed") });
        return false;
      } catch (err) {
        toast.danger({
          title: tr("admin.ppDetailOpenPlaceFailed"),
          message: formatErrorMessage(err, t),
        });
        return false;
      } finally {
        setOpening(false);
      }
    },
    [opening, utils, onOpenPlace, toast, t, tr],
  );

  const handleRestore = useCallback(async () => {
    if (restoreMut.isPending) return;
    try {
      await restoreMut.mutateAsync({
        placeId: place.placeId,
        clientKey: restoreKeyRef.current,
      });
      restoreKeyRef.current = buildFreshClientKey();
      setShowRestoreConfirm(false);
      toast.success({
        title: tr("admin.ppDetailRestored", { name: place.name }),
      });
      refreshAfterLifecycle();
      onClose();
    } catch (err) {
      const code = getAppErrorCode(err);
      // A definitive answer released the key; an unknown failure keeps it,
      // so a retry of a restore that DID land is answered, not doubled.
      if (code !== null) restoreKeyRef.current = buildFreshClientKey();
      setShowRestoreConfirm(false);
      if (code === "SECOND_FACTOR_REQUIRED") {
        setSecondFactor(true);
        return;
      }
      toast.danger({
        title: tr("admin.ppDetailRestoreFailed", { name: place.name }),
        message: formatErrorMessage(err, t),
      });
      // The refusal (owner, claim, duplicate…) then shows in Details.
      void editabilityQuery.refetch();
    }
  }, [
    restoreMut,
    place.placeId,
    place.name,
    toast,
    tr,
    t,
    refreshAfterLifecycle,
    onClose,
    editabilityQuery,
  ]);

  // ── Derived view state ───────────────────────────────────────────────
  const vIcon = VERIFICATION_ICON_MAP[place.verificationStatus];
  const subtitle = fullAddress(place) ?? undefined;
  const address = subtitle ?? "—";

  const canEditHere =
    lifecycleReady && !archived && editability?.canEdit === true;
  const canArchiveHere =
    lifecycleReady &&
    place.status === "ACTIVE" &&
    editability?.canArchive === true;
  const canRestoreHere =
    lifecycleReady && archived && editability?.canRestore === true;
  // Archive waits for the place's upcoming listings; say so where the
  // button would be instead of leaving the slot empty. ADDRESS_WITHHELD
  // refuses only edit, so there too the listings are what block archive.
  const archiveBlockedCount =
    lifecycleReady &&
    place.status === "ACTIVE" &&
    editability?.canArchive === false &&
    (editability.reason === null || editability.reason === "ADDRESS_WITHHELD")
      ? editability.linkedListingCount
      : 0;
  // Said by the server: an ADMIN may restore what a moderator did not
  // archive (owner ruling 2026-10-14), so canRestore no longer implies it.
  const archivedByModerator = editability?.archivedByModerator === true;

  // The reason replaces the action it blocks (restore when archived, edit
  // when active).
  let refusal: {
    title: string | null;
    body: string | null;
    duplicateId?: string;
  } | null = null;
  if (lifecycleReady && editability?.reason) {
    const reason = editability.reason;
    if (reason === "DUPLICATE_ACTIVE") {
      refusal = {
        title: tr("admin.ppDetailRefusedDuplicate"),
        body: null,
        duplicateId: editability.duplicatePlaceId ?? undefined,
      };
    } else {
      const copy = REFUSAL_COPY[toRefusalReason(reason)];
      refusal = { title: tr(copy.title), body: tr(copy.body) };
    }
  }

  const showRestore = canRestoreHere && refusal === null;

  const archivedAt = editability?.statusChangedAt ?? null;
  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  // ── Details header action ────────────────────────────────────────────
  let detailsAction: React.ReactNode = null;
  if (!ownerless) {
    detailsAction = (
      <Text variant="bodySmall" tone="muted">
        {tr("admin.ppDetailOwnerEdits")}
      </Text>
    );
  } else if (canEditHere && refusal === null) {
    detailsAction = (
      <button
        type="button"
        style={{
          ...LINK_ACTION_STYLE,
          opacity: opening ? 0.55 : 1,
        }}
        // aria-disabled, not `disabled`: a natively disabled button drops
        // focus to <body>, and Modal then restores focus there on close.
        // openDialog ignores presses while a check is running.
        aria-disabled={opening || undefined}
        onClick={() => void openDialog("form")}
        data-testid="platform-place-edit"
      >
        <Pencil size={14} aria-hidden />
        {tr("admin.ppDetailEdit")}
      </button>
    );
  }

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={720}>
        <Modal.Header
          title={place.name}
          subtitle={subtitle}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$5">
            {/* ── Badge strip + public page ───────────────────────── */}
            <XStack
              gap="$3"
              rowGap="$2"
              flexWrap="wrap"
              alignItems="center"
              justifyContent="space-between"
            >
              {/* maxWidth: as a flex item this strip sizes to its content,
                  so without a cap its own wrap never kicks in at 320px. */}
              <XStack
                gap="$3"
                rowGap="$2"
                flexWrap="wrap"
                alignItems="center"
                maxWidth="100%"
              >
                {archived ? <PlaceArchivedBadge /> : null}
                <XStack gap="$2" alignItems="center">
                  <vIcon.Icon size={16} color={vIcon.color} aria-hidden />
                  <Badge
                    tone={VERIFICATION_BADGE_TONE[place.verificationStatus]}
                    size="sm"
                  >
                    {tr(VERIFICATION_LABEL_KEY[place.verificationStatus])}
                  </Badge>
                </XStack>
                <Badge tone="neutral" size="sm">
                  {tr("admin.ppOwnerCount", { count: place.ownerCount })}
                </Badge>
              </XStack>
              <XStack gap="$4" rowGap="$2" flexWrap="wrap" alignItems="center">
                {canEditPageAsModerator ? (
                  <NextLinkAnchor
                    href={moderatorPlacePageHref(place.placeId)}
                    style={LINK_ACTION_STYLE}
                    data-testid="platform-place-edit-page"
                  >
                    <Pencil size={14} aria-hidden />
                    {tr("communityPlacePage.editorTitle")}
                  </NextLinkAnchor>
                ) : null}
                {place.publicPath ? (
                  <a
                    href={place.publicPath}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={LINK_ACTION_STYLE}
                    data-testid="platform-place-public-link"
                  >
                    {tr("admin.ppDetailViewPage")}
                    <ExternalLink size={14} aria-hidden />
                  </a>
                ) : null}
              </XStack>
            </XStack>

            {/* ── Details ─────────────────────────────────────────── */}
            <YStack gap="$3">
              <SectionHead
                label={tr("admin.ppDetailSectionDetails")}
                right={detailsAction}
              />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "max-content minmax(0, 1fr)",
                  columnGap: 16,
                  rowGap: 8,
                  alignItems: "baseline",
                }}
              >
                <Text variant="bodySmall" weight="bold">
                  {tr("admin.ppDetailAddress")}
                </Text>
                <Text variant="body" style={{ overflowWrap: "anywhere" }}>
                  {address}
                </Text>
                {place.capacity ? (
                  <>
                    <Text variant="bodySmall" weight="bold">
                      {tr("admin.ppCapacity")}
                    </Text>
                    <Text variant="body">
                      {place.capacity.toLocaleString()}
                    </Text>
                  </>
                ) : null}
                {ownerless && !archived && editability ? (
                  <>
                    <Text variant="bodySmall" weight="bold">
                      {tr("admin.ppDetailListings")}
                    </Text>
                    <Text variant="body">
                      {tr("admin.ppDetailListingsUpcoming", {
                        count: editability.linkedListingCount,
                      })}
                    </Text>
                  </>
                ) : null}
                {archived && archivedAt ? (
                  <>
                    <Text variant="bodySmall" weight="bold">
                      {tr("admin.ppDetailArchivedOn")}
                    </Text>
                    <Text variant="body">
                      <DateTime
                        tag="span"
                        value={archivedAt}
                        timeZone={timeZone}
                        format="date"
                        variant="body"
                      />
                      {archivedByModerator
                        ? `, ${tr("admin.ppDetailByModerator")}`
                        : null}
                    </Text>
                  </>
                ) : null}
              </div>

              {showSecondFactor && isAdmin && ownerless ? (
                <SecondFactorNotice pathname={pathname} />
              ) : refusal ? (
                <YStack
                  role="note"
                  gap="$1"
                  paddingVertical="$2.5"
                  paddingHorizontal="$3"
                  backgroundColor="$surfaceMuted"
                  borderLeftWidth={3}
                  borderLeftColor="$warning"
                  data-testid="platform-place-refusal"
                >
                  {refusal.title ? (
                    <Text variant="bodySmall" weight="bold">
                      {refusal.title}
                    </Text>
                  ) : null}
                  {refusal.body ? (
                    <Text variant="caption" tone="muted">
                      {refusal.body}
                    </Text>
                  ) : null}
                  {refusal.duplicateId ? (
                    <button
                      type="button"
                      style={{
                        ...LINK_ACTION_STYLE,
                        alignSelf: "flex-start",
                        opacity: opening ? 0.55 : 1,
                      }}
                      // Keeps focus (see Edit); openPlaceById ignores
                      // presses while a lookup is running.
                      aria-disabled={opening || undefined}
                      onClick={() =>
                        void openPlaceById(refusal.duplicateId!)
                      }
                      data-testid="platform-place-open-duplicate"
                    >
                      {tr("admin.ppDetailOpenActive")}
                      <ArrowRight size={14} aria-hidden />
                    </button>
                  ) : null}
                </YStack>
              ) : canRestoreHere ? (
                <Text variant="bodySmall" tone="muted">
                  {tr("admin.ppDetailArchivedNote")}
                </Text>
              ) : null}

              {isAdmin &&
              ownerless &&
              editabilityQuery.isError &&
              !editabilityNeedsSecondFactor ? (
                <Text variant="bodySmall" tone="error" role="alert">
                  {tr("communityCreate.pfEditabilityFailed")}
                </Text>
              ) : null}
            </YStack>

            {/* ── Verification (not for an archived place) ────────── */}
            {!archived ? (
              <YStack gap="$3">
                <SectionHead label={tr("admin.ppDetailSectionVerification")} />
                <Text variant="body">
                  {tr(VERIFICATION_STATE_KEY[place.verificationStatus])}
                </Text>
                <XStack gap="$2" flexWrap="wrap">
                  {/* Verify (only for UNVERIFIED) */}
                  {canDecideVerification &&
                    place.verificationStatus === "UNVERIFIED" && (
                      <Tooltip
                        anchor={
                          <Button
                            variant="primary"
                            size="$3"
                            onPress={() => void handleVerify()}
                            disabled={verifyMut.isPending}
                          >
                            <ShieldCheck size={15} />
                            {verifyMut.isPending
                              ? tr("admin.ppDetailVerifying")
                              : tr("admin.ppDetailVerifyPlace")}
                          </Button>
                        }
                        placement="top"
                      >
                        {tr("admin.ppDetailVerifyHint")}
                      </Tooltip>
                    )}

                  {/* Override a rejection (only for REJECTED) */}
                  {canDecideVerification &&
                    place.verificationStatus === "REJECTED" && (
                      <Tooltip
                        anchor={
                          <Button
                            variant="primary"
                            size="$3"
                            onPress={() => void handleVerify()}
                            disabled={verifyMut.isPending}
                          >
                            <ShieldCheck size={15} />
                            {verifyMut.isPending
                              ? tr("admin.ppDetailVerifying")
                              : tr("admin.ppDetailOverrideVerifyPlace")}
                          </Button>
                        }
                        placement="top"
                      >
                        {tr("admin.ppDetailOverrideVerifyHint")}
                      </Tooltip>
                    )}

                  {/* Waive verification.
                      Offered ONLY on UNVERIFIED / REJECTED — deliberately NOT
                      on PENDING. A PENDING place has an open
                      PlaceVerificationRequest, and this action flips
                      `Place.verification` without touching that request, so it
                      would orphan it in the review queue where the next
                      reviewer's Approve/Reject silently overwrites the waive.
                      The server refuses that case outright
                      (VERIFICATION_REQUEST_IN_PROGRESS); this predicate just
                      keeps the UI from offering an action the API will reject.
                      Deliberately `secondary`: skipping document review must
                      never read as the default click. */}
                  {canDecideVerification &&
                    WAIVABLE_STATUSES.includes(place.verificationStatus) && (
                      <Tooltip
                        anchor={
                          <Button
                            variant="secondary"
                            size="$3"
                            onPress={() => setShowBypassConfirm(true)}
                            // Also disabled while its own confirmation is
                            // open, so the trigger can't be re-fired from
                            // behind the dialog.
                            disabled={verifyMut.isPending || showBypassConfirm}
                            data-testid="platform-place-waive-verification"
                          >
                            <BadgeCheck size={15} />
                            {tr("admin.ppDetailWaiveVerification")}
                          </Button>
                        }
                        placement="top"
                      >
                        {tr("admin.ppDetailWaiveHint")}
                      </Tooltip>
                    )}

                  {/* Review (only for PENDING) */}
                  {place.verificationStatus === "PENDING" && (
                    <Button
                      variant="secondary"
                      size="$3"
                      onPress={() => {
                        onOpenReview(place);
                        onClose();
                      }}
                    >
                      <Eye size={15} />
                      {tr("admin.ppDetailReviewVerificationRequest")}
                    </Button>
                  )}
                </XStack>
              </YStack>
            ) : null}

            {/* ── Directory (not for an archived place) ───────────── */}
            {!archived ? (
              <YStack gap="$3">
                <SectionHead label={tr("admin.ppDetailSectionDirectory")} />
                <XStack
                  alignItems="center"
                  justifyContent="space-between"
                  gap="$3"
                >
                  <label htmlFor={switchId} style={{ minWidth: 0 }}>
                    <Text variant="body" tag="span">
                      {tr("admin.ppDetailDirectorySwitch")}
                    </Text>
                  </label>
                  <Switch
                    id={switchId}
                    checked={listed}
                    onCheckedChange={handleToggleDirectory}
                    saving={toggleDirectoryMut.isPending}
                    disabled={toggleDirectoryMut.isPending}
                    testId="platform-place-directory-switch"
                  />
                </XStack>
              </YStack>
            ) : null}
          </YStack>
        </Modal.Body>

        {/* Footer: lifecycle on the left (room for one more action, e.g. a
            later "Merge into…"), at most one primary on the right. The
            header's X closes the panel. Verify lives in the body, and only
            on a place that is not archived, so the footer's one primary
            (Restore) never shares the viewport with it. */}
        {canArchiveHere || archiveBlockedCount > 0 || showRestore || isAdmin ? (
          <Modal.Footer justifyContent="space-between" flexWrap="wrap" gap="$2">
            <XStack gap="$2" flexWrap="wrap" alignItems="center" minWidth={0}>
              {canArchiveHere ? (
                <Button
                  variant="destructiveGhost"
                  size="$3"
                  // Text weight at rest, like the moderator dialog's Archive;
                  // the variant's soft-red fill still answers hover.
                  borderColor="transparent"
                  onPress={() => void openDialog("archive")}
                  // Keeps focus (see Edit); openDialog ignores presses
                  // while a check is running.
                  aria-disabled={opening || undefined}
                  data-testid="platform-place-archive"
                >
                  <Archive size={15} aria-hidden />
                  {tr("admin.ppDetailArchivePlace")}
                </Button>
              ) : archiveBlockedCount > 0 ? (
                <Text
                  variant="caption"
                  tone="muted"
                  data-testid="platform-place-archive-blocked"
                >
                  {tr("communityCreate.pdArchiveBlocked", {
                    count: archiveBlockedCount,
                  })}
                </Text>
              ) : null}
              {/* Merge (ADMIN only, spec D5): owned and archived places
                  too; the preview says what the server would refuse. */}
              {isAdmin ? (
                <Button
                  variant="ghost"
                  size="$3"
                  onPress={() => setShowMerge(true)}
                  data-testid="platform-place-merge"
                >
                  <Merge size={15} aria-hidden />
                  {tr("admin.ppMergeAction")}
                </Button>
              ) : null}
            </XStack>
            {showRestore ? (
              <XStack gap="$2" flexWrap="wrap" marginLeft="auto">
                <Button
                  variant="primary"
                  size="$3"
                  onPress={() => {
                    if (!restoreMut.isPending) setShowRestoreConfirm(true);
                  }}
                  // Keeps focus for the confirm's return (see Edit).
                  aria-disabled={
                    restoreMut.isPending || showRestoreConfirm || undefined
                  }
                  data-testid="platform-place-restore"
                >
                  <RotateCcw size={15} aria-hidden />
                  {tr("admin.ppDetailRestorePlace")}
                </Button>
              </XStack>
            ) : null}
          </Modal.Footer>
        ) : null}

        {/* Waive confirmation. Matches the ConfirmDialog pattern the sibling
            Approve action already uses (VerificationReviewDetail) rather than
            inventing a bespoke step. `danger` tone for the caution
            affordance — this grants trust without evidence and there is no
            undo button. Rendered INSIDE Modal.Panel (a portal, so it adds no
            DOM here) to stay in the panel's stopPropagation subtree. */}
        <ConfirmDialog
          open={showBypassConfirm}
          onConfirm={() => void handleBypassReview()}
          onCancel={() => {
            setShowBypassConfirm(false);
            setBypassNote("");
          }}
          title={tr("admin.ppDetailWaiveConfirmTitle")}
          description={
            <YStack gap="$3">
              <Text variant="body" tone="muted">
                {tr("admin.ppDetailWaiveConfirmBody", { name: place.name })}
              </Text>
              <LabeledTextInput
                label={tr("admin.ppDetailWaiveNoteLabel")}
                name="waiveVerificationNote"
                value={bypassNote}
                onChangeText={setBypassNote}
                placeholder={tr("admin.ppDetailWaiveNotePlaceholder")}
                helperText={tr("admin.ppDetailWaiveNoteHelp")}
                maxLength={MAX_BYPASS_NOTE_LENGTH}
                editable={!verifyMut.isPending}
                testId="platform-place-waive-note"
              />
            </YStack>
          }
          confirmLabel={tr("admin.ppDetailWaiveConfirmCta")}
          cancelLabel={tr("admin.ppDetailWaiveCancelCta")}
          tone="danger"
          loading={verifyMut.isPending}
          loadingLabel={tr("admin.ppDetailVerifying")}
        />

        {/* Restore confirmation. Its button names differ from the footer's
            "Restore place" so the two dialogs never expose twin buttons. */}
        <ConfirmDialog
          open={showRestoreConfirm}
          onConfirm={() => void handleRestore()}
          onCancel={() => setShowRestoreConfirm(false)}
          title={tr("admin.ppDetailRestoreConfirmTitle", { name: place.name })}
          // The directory shows ACTIVE places that are listed, so a place
          // archived while listed goes back into it on restore.
          description={tr(
            listed
              ? "admin.ppDetailRestoreConfirmBodyListed"
              : "admin.ppDetailRestoreConfirmBody",
          )}
          confirmLabel={tr("admin.ppDetailRestoreConfirmCta")}
          cancelLabel={tr("admin.ppDetailRestoreCancelCta")}
          loading={restoreMut.isPending}
          loadingLabel={tr("admin.ppDetailRestoring")}
        />

        {/* Merge into another place. Mounted only while open, so its
            preview read never runs for a panel nobody is merging from. */}
        {showMerge ? (
          <PlaceMergeDialog
            open
            place={place}
            onClose={() => setShowMerge(false)}
            onMerged={({ survivorId }) => {
              setShowMerge(false);
              // The survivor's answers changed (owners, listings). When it is
              // this very place (swapped), placeId does not change, so nothing
              // else would ask again.
              void utils.community.getPlaceEditability.invalidate({
                placeId: survivorId,
              });
              // Move to the survivor first (its row is read fresh by id), then
              // refresh the list, which no longer has the merged place. The
              // deleted place's own reads are left alone: refetching them
              // would only flash a not-found error before the panel moves.
              void openPlaceById(survivorId).then((moved) => {
                // Never leave the panel on a place that no longer exists.
                if (!moved) onClose();
                void utils.platform.listPlaces.invalidate();
                onMutated();
              });
            }}
          />
        ) : null}

        {/* Edit and archive: the shared dialog moderators already use. */}
        <PlaceDialog
          mode={dialog}
          onClose={() => {
            setDialog(null);
            // The dialog may have learnt something (a refusal, live
            // listings); ask again rather than show a stale answer.
            void utils.community.getPlaceEditability.invalidate({
              placeId: place.placeId,
            });
          }}
          onSaved={(saved) => {
            setDialog(null);
            setPatch({
              name: saved.name,
              formattedAddress: saved.formattedAddress,
              city: saved.city,
              region: saved.region,
            });
            toast.success({ title: tr("admin.ppDetailUpdated") });
            refreshAfterLifecycle();
          }}
          onUseExisting={(existing) => {
            // A rename collided with another place: open that one instead.
            setDialog(null);
            void openPlaceById(existing.placeId);
          }}
          onArchived={() => {
            setDialog(null);
            toast.success({
              title: tr("admin.ppDetailArchivedToast", { name: place.name }),
            });
            refreshAfterLifecycle();
            onClose();
          }}
        />
      </Modal.Panel>
    </Modal>
  );
}
