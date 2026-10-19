"use client";

/**
 * PackEditorView — one pack's metadata, catalogue roles and shift presets
 * (FR-014), with the DRAFT-inclusive "preview as an organizer" of FR-016.
 *
 * Three deliberate separations, all mirroring the use cases:
 *
 * 1. **Save ≠ publish.** `upsert` never accepts a status, so fixing a typo
 *    cannot ship an unfinished pack; publishing is its own button, its own
 *    mutation and its own audit row.
 * 2. **Preview reads the SAVED pack**, not the editor's local state — that is
 *    what an organizer would actually get, and saying otherwise about
 *    unsaved edits would be the one lie a preview must never tell.
 * 3. **Roles are matched by NAME server-side.** Renaming a role is therefore
 *    delete + create, which is honest: an org that forked the old name keeps
 *    their copy and stops being shadowed. The editor says so in the copy
 *    rather than pretending ids are stable across a rename.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack, styled } from "tamagui";
import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Button,
  Modal,
  MultiChipGroup,
  Spinner,
  Switch,
  Text,
  TextInput,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";
import { withCategoryDisplayNames } from "@/lib/category-display-name";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { PackRoleCatalogue } from "@/components/volunteering/PackRoleCatalogue";
import {
  minuteOfDayToTime,
  parseShiftDraftFields,
  type TemplateShiftAnchor,
} from "@/lib/template-shift-offset";
import {
  PlatformContainer,
  PlatformPageTitle,
  PlatformSectionTitle,
  PlatformSubtitle,
} from "../../_components/PlatformPageParts";
import { PackStatusPill } from "./PackStatusPill";
import { PackShiftsEditor, type PackShiftDraft } from "./PackShiftsEditor";
import styles from "./volunteer-packs.module.css";
import { lookupOwn } from "@/lib/lookup-own";

// ─────────────────────────────────────────────────────────────────────────────
// Swiss content primitives
// ─────────────────────────────────────────────────────────────────────────────

const Panel = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  padding: 16,
  gap: 12,
});

const RoleCard = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
  padding: 16,
  gap: 12,
});

const StateFrame = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 28,
  gap: 12,
  alignItems: "center",
  justifyContent: "center",
  minHeight: 200,
  backgroundColor: "$surface",
});

/** Mirrors `MAX_PACK_ROLES` in the use case. */
const MAX_PACK_ROLES = 50;

/**
 * Canonical error code → the `errors.*` copy that already exists for it.
 *
 * `fail()` sets `message = code`, so a typed failure arrives as
 * `VOLUNTEER_PACK_HAS_PLATFORM_ROLES`. That has no whitespace, so
 * `formatErrorMessage`'s "already a sentence" test misses it; it is not in the
 * lowercase `ERROR_MESSAGES` map either; and `toCamelCase` (`/_([a-z])/g`)
 * cannot fold SCREAMING_SNAKE, so even passing `t` would look up
 * `errors.VOLUNTEER_PACK_HAS_PLATFORM_ROLES` and miss the
 * `errors.volunteerPackHasPlatformRoles` copy that is right there in both
 * catalogues. Result: correct, translated copy that no curator could ever see.
 *
 * Resolving the code with `getAppErrorCode` first is the sanctioned pattern —
 * `VolunteerTemplatesView` does exactly this for `TEMPLATE_NAME_TAKEN`. The
 * map is explicit rather than derived so an unmapped code still falls through
 * to `formatErrorMessage` instead of guessing at a key.
 */
const PACK_ERROR_COPY_KEYS: Record<string, string> = {
  VOLUNTEER_PACK_NOT_FOUND: "errors.volunteerPackNotFound",
  VOLUNTEER_PACK_KEY_TAKEN: "errors.volunteerPackKeyTaken",
  VOLUNTEER_PACK_HAS_PLATFORM_ROLES: "errors.volunteerPackHasPlatformRoles",
  // Reachable from the SAVE path: the pack's roles are platform templates, so
  // the partial unique index surfaces the org-side collision code.
  TEMPLATE_NAME_TAKEN: "errors.templateNameTaken",
};

interface RoleDraft {
  /** Local only — the server matches roles by NAME, never by id. */
  localId: string;
  name: string;
  description: string;
  defaultCapacity: string;
  shifts: PackShiftDraft[];
}

const newLocalId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `pack-role-${Math.random().toString(36).slice(2, 10)}`;

function emptyRoleDraft(): RoleDraft {
  return {
    localId: newLocalId(),
    name: "",
    description: "",
    defaultCapacity: "",
    shifts: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// View
// ─────────────────────────────────────────────────────────────────────────────

export function PackEditorView({ packKey }: { packKey: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const { toast } = useNotify();
  const router = useRouter();
  const utils = trpc.useUtils();

  // `admin.get` keys on the pack ID, and the route keys on the stable slug —
  // so the list is also the key→id lookup. It hits the cache only when the
  // catalogue page was on the ALL filter: a filtered catalogue runs
  // `list({status})`, a different query key, so arriving from there is a fresh
  // fetch. See the loading gate below for what that costs.
  const listQuery = trpc.volunteerPacks.admin.list.useQuery(
    {},
    { staleTime: 15_000 },
  );
  const packSummary = useMemo(
    () => listQuery.data?.packs.find((pack) => pack.key === packKey) ?? null,
    [listQuery.data?.packs, packKey],
  );
  const packId = packSummary?.id ?? null;

  const packQuery = trpc.volunteerPacks.admin.get.useQuery(
    { packId: packId ?? "" },
    { enabled: !!packId, staleTime: 5_000 },
  );

  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  // ── Editor state ───────────────────────────────────────────────────────

  const [name, setName] = useState("");
  const [blurb, setBlurb] = useState("");
  const [rankFirst, setRankFirst] = useState(false);
  const [sortOrder, setSortOrder] = useState("0");
  const [targetCategoryIds, setTargetCategoryIds] = useState<string[]>([]);
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  /**
   * Re-seed after every successful save: the server reconciles roles by name,
   * so a rename comes back as a different row and local ids are stale. Bumped
   * rather than one-shot so "saved" always means "showing what was stored".
   */
  const [seedVersion, setSeedVersion] = useState(0);
  const seededForRef = useRef<string | null>(null);

  const pack = packQuery.data?.pack ?? null;

  useEffect(() => {
    if (!pack) return;
    const token = `${pack.id}:${seedVersion}`;
    if (seededForRef.current === token) return;
    seededForRef.current = token;

    setName(pack.name);
    setBlurb(pack.blurb ?? "");
    setRankFirst(pack.rankFirst);
    setSortOrder(String(pack.sortOrder));
    setTargetCategoryIds([...pack.targetCategoryIds]);
    setRoles(
      [...pack.roles]
        .sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        )
        .map((role) => ({
          localId: role.id,
          name: role.name,
          description: role.description ?? "",
          defaultCapacity:
            role.defaultCapacity != null ? String(role.defaultCapacity) : "",
          shifts: [...role.shifts]
            .sort((a, b) => a.position - b.position)
            .map((shift) => ({
              id: shift.id,
              label: shift.label,
              startTime: minuteOfDayToTime(shift.startMinuteOfDay),
              endTime: minuteOfDayToTime(shift.endMinuteOfDay),
              dayOffset: String(shift.startDayOffset),
              capacity: shift.capacity != null ? String(shift.capacity) : "",
              // Round-trip the anchor verbatim. Dropping either field would
              // silently flatten an anchored preset to wall clock on save.
              anchor: shift.anchor as TemplateShiftAnchor,
              offsetMinutes: String(shift.offsetMinutes),
              notes: shift.notes ?? "",
            })),
        })),
    );
    setDirty(false);
    setSaveError(null);
  }, [pack, seedVersion]);

  const upsertMutation = trpc.volunteerPacks.admin.upsert.useMutation({
    meta: { silent: true },
  });
  const statusMutation = trpc.volunteerPacks.admin.setStatus.useMutation({
    meta: { silent: true },
  });
  const removeMutation = trpc.volunteerPacks.admin.remove.useMutation({
    meta: { silent: true },
  });

  const busy =
    upsertMutation.isPending ||
    statusMutation.isPending ||
    removeMutation.isPending;

  /** @see PACK_ERROR_COPY_KEYS — typed codes first, generic formatting after. */
  const packErrorMessage = useCallback(
    (err: unknown): string => {
      const key = lookupOwn(PACK_ERROR_COPY_KEYS, getAppErrorCode(err));
      return key ? String(t(key)) : formatErrorMessage(err, t);
    },
    [t],
  );

  const patchRole = useCallback((index: number, patch: Partial<RoleDraft>) => {
    setDirty(true);
    setRoles((current) =>
      current.map((role, i) => (i === index ? { ...role, ...patch } : role)),
    );
  }, []);

  // ── Save ───────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSaveError(String(t("admin.volunteerPackNameRequired")));
      return;
    }

    const parsedSortOrder = Number(sortOrder.trim() || "0");
    if (
      !Number.isInteger(parsedSortOrder) ||
      parsedSortOrder < 0 ||
      parsedSortOrder > 9999
    ) {
      setSaveError(String(t("admin.volunteerPackSortOrderInvalid")));
      return;
    }

    const seen = new Set<string>();
    const payloadRoles: Array<{
      name: string;
      description: string | null;
      defaultCapacity: number | null;
      sortOrder: number;
      shifts: Array<{
        label: string;
        startMinuteOfDay: number;
        endMinuteOfDay: number;
        startDayOffset: number;
        endsNextDay: boolean;
        capacity: number | null;
        position: number;
        anchor: TemplateShiftAnchor;
        offsetMinutes: number;
        notes: string | null;
      }>;
    }> = [];

    for (const [index, role] of roles.entries()) {
      const roleName = role.name.trim();
      if (!roleName) {
        setSaveError(String(t("admin.volunteerPackRoleNameRequired")));
        return;
      }
      // Same invariant as the partial unique index
      // `VolunteerRoleTemplate_platform_pack_name_key`, caught here so the
      // curator gets a sentence instead of a constraint violation.
      if (seen.has(roleName.toLowerCase())) {
        setSaveError(
          String(t("admin.volunteerPackRoleNameDuplicate", { name: roleName })),
        );
        return;
      }
      seen.add(roleName.toLowerCase());

      let capacity: number | null = null;
      if (role.defaultCapacity.trim()) {
        const parsed = Number(role.defaultCapacity.trim());
        if (!Number.isInteger(parsed) || parsed < 1) {
          setSaveError(
            String(
              t("admin.volunteerPackRoleCapacityInvalid", { name: roleName }),
            ),
          );
          return;
        }
        capacity = parsed;
      }

      const shifts: (typeof payloadRoles)[number]["shifts"] = [];
      for (const [position, shift] of role.shifts.entries()) {
        const result = parseShiftDraftFields(shift);
        if (!result.ok) {
          setSaveError(
            String(t("admin.volunteerPackShiftInvalid", { name: roleName })),
          );
          return;
        }
        shifts.push({
          label: result.value.label,
          startMinuteOfDay: result.value.startMinuteOfDay,
          endMinuteOfDay: result.value.endMinuteOfDay,
          startDayOffset: result.value.startDayOffset,
          endsNextDay: result.value.endsNextDay,
          capacity: result.value.capacity,
          position,
          anchor: result.value.anchor,
          offsetMinutes: result.value.offsetMinutes,
          notes: shift.notes.trim() ? shift.notes.trim() : null,
        });
      }

      payloadRoles.push({
        name: roleName,
        description: role.description.trim() ? role.description.trim() : null,
        defaultCapacity: capacity,
        sortOrder: index,
        shifts,
      });
    }

    setSaveError(null);
    try {
      await upsertMutation.mutateAsync({
        key: packKey,
        name: trimmedName,
        // Explicit `null` clears the blurb; the field is nullish, so the use
        // case can tell "cleared" from "untouched".
        blurb: blurb.trim() ? blurb.trim() : null,
        targetCategoryIds,
        rankFirst,
        sortOrder: parsedSortOrder,
        roles: payloadRoles,
      });
      await Promise.all([
        utils.volunteerPacks.admin.list.invalidate(),
        utils.volunteerPacks.admin.get.invalidate(),
        utils.volunteerPacks.list.invalidate(),
      ]);
      setSeedVersion((v) => v + 1);
      toast.success({
        id: "volunteer-pack-saved",
        title: String(t("admin.volunteerPackSaved")),
      });
    } catch (err) {
      setSaveError(packErrorMessage(err));
    }
  }, [
    name,
    blurb,
    sortOrder,
    rankFirst,
    targetCategoryIds,
    roles,
    packKey,
    packErrorMessage,
    upsertMutation,
    utils.volunteerPacks.admin.list,
    utils.volunteerPacks.admin.get,
    utils.volunteerPacks.list,
    toast,
    t,
  ]);

  // ── Publish / unpublish ────────────────────────────────────────────────

  const handleSetStatus = useCallback(
    async (next: "DRAFT" | "LIVE") => {
      if (!packId) return;
      try {
        await statusMutation.mutateAsync({ packId, status: next });
        await Promise.all([
          utils.volunteerPacks.admin.list.invalidate(),
          utils.volunteerPacks.admin.get.invalidate(),
          utils.volunteerPacks.list.invalidate(),
        ]);
        toast.success({
          id: "volunteer-pack-status",
          title: String(
            t(
              next === "LIVE"
                ? "admin.volunteerPackPublished"
                : "admin.volunteerPackUnpublished",
            ),
          ),
        });
      } catch (err) {
        toast.danger({
          id: "volunteer-pack-status-failed",
          title: String(t("admin.volunteerPackStatusFailed")),
          message: packErrorMessage(err),
        });
      }
    },
    [
      packId,
      packErrorMessage,
      statusMutation,
      utils.volunteerPacks.admin.list,
      utils.volunteerPacks.admin.get,
      utils.volunteerPacks.list,
      toast,
      t,
    ],
  );

  const handleDelete = useCallback(async () => {
    if (!packId) return;
    try {
      await removeMutation.mutateAsync({ packId });
      await Promise.all([
        utils.volunteerPacks.admin.list.invalidate(),
        utils.volunteerPacks.list.invalidate(),
      ]);
      setDeleteOpen(false);
      toast.success({
        id: "volunteer-pack-deleted",
        title: String(t("admin.volunteerPackDeleted")),
      });
      router.push("/platform/volunteer-packs");
    } catch (err) {
      // The dialog STAYS OPEN on failure. Closing it dropped the curator back
      // on the editor with a toast and no retry affordance — and the most
      // likely failure here (VOLUNTEER_PACK_HAS_PLATFORM_ROLES) is one they
      // fix and immediately re-try.
      toast.danger({
        id: "volunteer-pack-delete-failed",
        title: String(t("admin.volunteerPackDeleteFailed")),
        message: packErrorMessage(err),
      });
    }
  }, [
    packId,
    packErrorMessage,
    removeMutation,
    utils.volunteerPacks.admin.list,
    utils.volunteerPacks.list,
    toast,
    t,
    router,
  ]);

  // ── Early states ───────────────────────────────────────────────────────

  const backButton = (
    <Button
      variant="ghost"
      size="$3"
      onPress={() => router.push("/platform/volunteer-packs")}
      data-testid="volunteer-pack-back"
    >
      <ArrowLeft size={16} aria-hidden />
      {String(t("admin.volunteerPackBackToList"))}
    </Button>
  );

  /**
   * `isFetching`, not just `isLoading`: the key→id lookup rides a CACHED
   * `admin.list({})`, and a cache entry can be present but stale. Right after
   * a create on a filtered catalogue the ACTIVE query is `{status}`, so the
   * default `refetchType: "active"` invalidate marks `{}` stale without
   * refetching it — this component then mounts against a list that predates
   * the new pack. `isLoading` is false, `packSummary` is null, and the curator
   * gets "No pack with the key … exists" one frame after "Pack created".
   * Waiting out the in-flight refetch is what makes that impossible;
   * `PackCatalogueView` also refetches inactive entries on create so the wait
   * is short.
   */
  if (
    listQuery.isLoading ||
    (!packSummary && listQuery.isFetching) ||
    (packId && packQuery.isLoading)
  ) {
    return (
      <PlatformContainer size="md">
        <StateFrame>
          <Spinner size="large" />
          <Text variant="body" tone="muted">
            {String(t("admin.volunteerPacksLoading"))}
          </Text>
        </StateFrame>
      </PlatformContainer>
    );
  }

  const loadError = listQuery.error ?? packQuery.error;
  if (loadError) {
    return (
      <PlatformContainer size="md">
        <XStack>{backButton}</XStack>
        <StateFrame>
          <AlertTriangle size={26} color="var(--danger, #B91C1C)" aria-hidden />
          <Text variant="body" tone="error" textAlign="center">
            {packErrorMessage(loadError)}
          </Text>
        </StateFrame>
      </PlatformContainer>
    );
  }

  if (!packSummary || !pack) {
    return (
      <PlatformContainer size="md">
        <XStack>{backButton}</XStack>
        <StateFrame>
          <Text variant="h4" weight="bold" textAlign="center">
            {String(t("admin.volunteerPackNotFoundTitle"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
            {String(
              t("admin.volunteerPackNotFoundDescription", { key: packKey }),
            )}
          </Text>
        </StateFrame>
      </PlatformContainer>
    );
  }

  const categories = withCategoryDisplayNames(
    categoriesQuery.data?.categories ?? [],
    locale,
  );
  /** DRAFT → LIVE only. Unpublishing stays available while dirty — see below. */
  const publishBlocked = pack.status !== "LIVE" && dirty;

  return (
    <PlatformContainer size="md">
      <XStack>{backButton}</XStack>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <YStack gap={8}>
        <XStack gap={10} alignItems="center" flexWrap="wrap">
          <PlatformPageTitle>{pack.name}</PlatformPageTitle>
          <PackStatusPill
            status={pack.status}
            size="md"
            testId="volunteer-pack-editor-status"
          />
        </XStack>
        <PlatformSubtitle>{pack.key}</PlatformSubtitle>
        {/* `flex-start`, not `center`: the Publish column grows a caption when
            the editor is dirty, and centring would stagger the sibling buttons
            against it every time the curator typed. */}
        <XStack gap={8} flexWrap="wrap" alignItems="flex-start">
          <Button
            variant="secondary"
            size="$3"
            onPress={() => setPreviewOpen(true)}
            data-testid="volunteer-pack-preview-open"
          >
            <Eye size={16} aria-hidden />
            {String(t("admin.volunteerPackPreviewCta"))}
          </Button>
          {/*
            Publish is BLOCKED while the editor is dirty; Unpublish is not.

            `setStatus` ships the last SAVED pack, so publishing with unsaved
            edits on screen puts a pack live platform-wide that does not match
            what the curator is looking at — and the only signal was an
            "Unsaved changes" marker a page-height away, next to a different
            button. Save-then-publish in one click was the other option and is
            worse: `upsert` deliberately refuses a status ("save ≠ publish", see
            the file header) so a typo fix can never ship a draft, and merging
            them would undo that separation and add a half-succeeded state
            (saved, not published) that needs its own copy.

            The gate is DIRECTIONAL. Unpublishing is the safe direction — a
            curator who has spotted a mistake needs to pull the pack down NOW,
            and forcing a save first would push those very edits into the live
            pack before removing it.
          */}
          {/* `flex-start`: YStack stretches its children by default, which
              would widen the button to the caption's 260px the instant the
              curator typed — the control must not resize under them. */}
          <YStack gap={4} alignItems="flex-start">
            <Button
              variant="secondary"
              size="$3"
              onPress={() =>
                void handleSetStatus(pack.status === "LIVE" ? "DRAFT" : "LIVE")
              }
              disabled={busy || publishBlocked}
              data-testid="volunteer-pack-toggle-status"
            >
              <Upload size={16} aria-hidden />
              {String(
                t(
                  pack.status === "LIVE"
                    ? "admin.volunteerPackUnpublishCta"
                    : "admin.volunteerPackPublishCta",
                ),
              )}
            </Button>
            {publishBlocked ? (
              <Text
                variant="caption"
                tone="muted"
                maxWidth={260}
                data-testid="volunteer-pack-publish-blocked"
              >
                {String(t("admin.volunteerPackPublishBlockedUnsaved"))}
              </Text>
            ) : null}
          </YStack>
          {/*
            Ghost, not `destructive`: a red fill in the page header would be
            the loudest thing on a screen whose actual primary action is Save,
            and the destructive weight belongs on the CONFIRM — which is where
            `ConfirmDialog tone="danger"` puts it. Same shape the categories
            panel uses for its delete affordance.
          */}
          <Button
            variant="ghost"
            size="$3"
            onPress={() => setDeleteOpen(true)}
            disabled={busy}
            data-testid="volunteer-pack-delete-open"
          >
            <Trash2 size={16} aria-hidden />
            {String(t("admin.volunteerPackDeleteCta"))}
          </Button>
        </XStack>
      </YStack>

      {/* ── Metadata + targeting ─────────────────────────────────────────── */}
      <div className={styles.editorColumns}>
        <Panel>
          <PlatformSectionTitle>
            {String(t("admin.volunteerPackDetailsTitle"))}
          </PlatformSectionTitle>
          <YStack gap="$1">
            <Text variant="label">
              {String(t("admin.volunteerPackFieldName"))}
            </Text>
            <TextInput
              value={name}
              onChangeText={(value) => {
                setName(value);
                setDirty(true);
              }}
              maxLength={120}
              disabled={busy}
              fullWidth
              // `Text variant="label"` renders a <span>, not a <label htmlFor>,
              // so the visible label is decoration as far as a screen reader is
              // concerned. Same fix `ShiftAnchorFields` already uses.
              aria-label={String(t("admin.volunteerPackFieldName"))}
              testId="volunteer-pack-name"
            />
          </YStack>
          <YStack gap="$1">
            <Text variant="label">
              {String(t("admin.volunteerPackFieldBlurb"))}
            </Text>
            <TextInput
              value={blurb}
              onChangeText={(value) => {
                setBlurb(value);
                setDirty(true);
              }}
              placeholder={String(
                t("admin.volunteerPackFieldBlurbPlaceholder"),
              )}
              multiline
              numberOfLines={3}
              maxLength={2000}
              disabled={busy}
              fullWidth
              aria-label={String(t("admin.volunteerPackFieldBlurb"))}
              testId="volunteer-pack-blurb"
            />
          </YStack>
          <XStack gap="$3" flexWrap="wrap" alignItems="flex-end">
            <YStack gap="$1" width={140}>
              <Text variant="label">
                {String(t("admin.volunteerPackFieldSortOrder"))}
              </Text>
              <TextInput
                value={sortOrder}
                onChangeText={(value) => {
                  setSortOrder(value);
                  setDirty(true);
                }}
                inputMode="numeric"
                disabled={busy}
                fullWidth
                aria-label={String(t("admin.volunteerPackFieldSortOrder"))}
                testId="volunteer-pack-sort-order"
              />
            </YStack>
            <XStack gap="$2" alignItems="center" paddingBottom={8}>
              <Switch
                checked={rankFirst}
                onCheckedChange={(checked) => {
                  setRankFirst(checked);
                  setDirty(true);
                }}
                disabled={busy}
                aria-label={String(t("admin.volunteerPackFieldRankFirst"))}
                size="small"
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.volunteerPackFieldRankFirst"))}
              </Text>
            </XStack>
          </XStack>
        </Panel>

        <Panel>
          <PlatformSectionTitle>
            {String(t("admin.volunteerPackTargetingTitle"))}
          </PlatformSectionTitle>
          <Text variant="caption" tone="muted">
            {String(t("admin.volunteerPackTargetingHelp"))}
          </Text>
          {categories.length === 0 ? (
            <Text variant="caption" tone="muted">
              {String(t("admin.volunteerPackTargetsNone"))}
            </Text>
          ) : (
            // The sanctioned multi-select control: `role="group"`,
            // `aria-pressed` per chip, 44px targets, radius 0, and the
            // selected fill already on the AA-safe #B93312 rung. Hand-rolling
            // it out of `Button variant="primary"` would have put one primary
            // button per selected category on a viewport that already has a
            // Save CTA.
            <MultiChipGroup
              options={categories.map((category) => ({
                key: category.id,
                label: category.name,
              }))}
              value={targetCategoryIds}
              onChange={(next) => {
                setDirty(true);
                setTargetCategoryIds(next);
              }}
              // Every other control on this page freezes during a save; without
              // this the chips were the one thing still live, and the post-save
              // re-seed overwrote whatever was clicked (then cleared `dirty`),
              // so the click vanished with nothing on screen to say so.
              disabled={busy}
              testIdBase="volunteer-pack-targets"
            />
          )}
        </Panel>
      </div>

      {/* ── Roles ────────────────────────────────────────────────────────── */}
      <YStack gap={12}>
        <XStack
          justifyContent="space-between"
          alignItems="flex-end"
          gap={12}
          flexWrap="wrap"
        >
          <YStack gap={4} flex={1} minWidth={240}>
            <PlatformSectionTitle>
              {String(t("admin.volunteerPackRolesTitle"))}
            </PlatformSectionTitle>
            <Text variant="caption" tone="muted">
              {String(t("admin.volunteerPackRolesHelp"))}
            </Text>
          </YStack>
          <Button
            variant="secondary"
            size="$3"
            onPress={() => {
              setDirty(true);
              setRoles((current) => [...current, emptyRoleDraft()]);
            }}
            disabled={busy || roles.length >= MAX_PACK_ROLES}
            data-testid="volunteer-pack-add-role"
          >
            <Plus size={16} aria-hidden />
            {String(t("admin.volunteerPackAddRoleCta"))}
          </Button>
        </XStack>

        {roles.length === 0 ? (
          <StateFrame>
            <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
              {String(t("admin.volunteerPackRolesEmpty"))}
            </Text>
          </StateFrame>
        ) : (
          roles.map((role, index) => (
            <RoleCard
              key={role.localId}
              // The card is what tells a sighted curator which "Role name" box
              // belongs to which role. A screen reader gets that from the group
              // label instead, so the per-field `aria-label`s below can stay
              // short and identical across cards.
              role="group"
              aria-label={
                role.name.trim() ||
                String(
                  t("admin.volunteerPackRoleGroupLabel", {
                    position: index + 1,
                  }),
                )
              }
              data-testid={`volunteer-pack-role-${index}`}
            >
              <XStack gap="$3" flexWrap="wrap" alignItems="flex-end">
                <YStack gap="$1" flex={1} minWidth={200}>
                  <Text variant="label">
                    {String(t("admin.volunteerPackRoleNameLabel"))}
                  </Text>
                  <TextInput
                    value={role.name}
                    onChangeText={(value) => patchRole(index, { name: value })}
                    placeholder={String(
                      t("admin.volunteerPackRoleNamePlaceholder"),
                    )}
                    maxLength={120}
                    disabled={busy}
                    fullWidth
                    aria-label={String(
                      t("admin.volunteerPackRoleNameLabel"),
                    )}
                    testId={`volunteer-pack-role-${index}-name`}
                  />
                </YStack>
                <YStack gap="$1" width={160}>
                  <Text variant="label">
                    {String(t("admin.volunteerPackRoleCapacityLabel"))}
                  </Text>
                  <TextInput
                    value={role.defaultCapacity}
                    onChangeText={(value) =>
                      patchRole(index, { defaultCapacity: value })
                    }
                    placeholder={String(
                      t("admin.volunteerTemplateShiftCapacityPlaceholder"),
                    )}
                    inputMode="numeric"
                    disabled={busy}
                    fullWidth
                    aria-label={String(
                      t("admin.volunteerPackRoleCapacityLabel"),
                    )}
                    testId={`volunteer-pack-role-${index}-capacity`}
                  />
                </YStack>
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => {
                    setDirty(true);
                    setRoles((current) =>
                      current.filter((_, i) => i !== index),
                    );
                  }}
                  disabled={busy}
                  aria-label={String(t("admin.volunteerPackRemoveRoleCta"))}
                  data-testid={`volunteer-pack-role-${index}-remove`}
                >
                  <Trash2 size={14} />
                </Button>
              </XStack>

              <YStack gap="$1">
                <Text variant="label">
                  {String(t("admin.volunteerPackRoleDescriptionLabel"))}
                </Text>
                <TextInput
                  value={role.description}
                  onChangeText={(value) =>
                    patchRole(index, { description: value })
                  }
                  placeholder={String(
                    t("admin.volunteerPackRoleDescriptionPlaceholder"),
                  )}
                  multiline
                  numberOfLines={2}
                  maxLength={2000}
                  disabled={busy}
                  fullWidth
                  aria-label={String(
                    t("admin.volunteerPackRoleDescriptionLabel"),
                  )}
                  testId={`volunteer-pack-role-${index}-description`}
                />
              </YStack>

              <PackShiftsEditor
                shifts={role.shifts}
                onChange={(next) => patchRole(index, { shifts: next })}
                disabled={busy}
                testIdBase={`volunteer-pack-role-${index}`}
              />
            </RoleCard>
          ))
        )}
      </YStack>

      {/* ── Save bar ─────────────────────────────────────────────────────── */}
      <XStack
        gap={12}
        alignItems="center"
        justifyContent="flex-end"
        flexWrap="wrap"
      >
        {saveError ? (
          <Text
            variant="caption"
            tone="error"
            flex={1}
            data-testid="volunteer-pack-save-error"
          >
            {saveError}
          </Text>
        ) : null}
        {dirty ? (
          <Text
            variant="caption"
            tone="muted"
            data-testid="volunteer-pack-dirty"
          >
            {String(t("admin.volunteerPackUnsaved"))}
          </Text>
        ) : null}
        <Button
          variant="primary"
          size="$4"
          onPress={() => void handleSave()}
          disabled={busy}
          data-testid="volunteer-pack-save"
        >
          {String(t("admin.volunteerPackSaveCta"))}
        </Button>
      </XStack>

      {/* ── Preview as an organizer (FR-016) ─────────────────────────────── */}
      {previewOpen ? (
        <Modal open onClose={() => setPreviewOpen(false)}>
          <Modal.Panel width={880}>
            <Modal.Header
              title={String(t("admin.volunteerPackPreviewTitle"))}
              onClose={() => setPreviewOpen(false)}
            />
            <Modal.Body>
              <YStack gap="$3">
                <Text variant="caption" tone="muted">
                  {String(
                    t(
                      pack.status === "LIVE"
                        ? "admin.volunteerPackPreviewLiveNote"
                        : "admin.volunteerPackPreviewDraftNote",
                    ),
                  )}
                </Text>
                {dirty ? (
                  <Text
                    variant="caption"
                    tone="error"
                    data-testid="volunteer-pack-preview-stale"
                  >
                    {String(t("admin.volunteerPackPreviewUnsaved"))}
                  </Text>
                ) : null}
                {/*
                  The organizer's OWN component, fed the saved pack. No
                  "Customise" action: staff are looking, not forking.

                  A role-less pack is FILTERED OUT rather than rendered as an
                  empty card, mirroring `PackPickerGrid`'s
                  `.filter(pack => pack.roles.length > 0)`. Showing the card
                  would be the preview telling the one lie it exists to prevent
                  — the organizer never sees this pack at all.
                */}
                {pack.roles.length === 0 ? (
                  <Text
                    variant="body"
                    tone="muted"
                    maxWidth={480}
                    data-testid="volunteer-pack-preview-no-roles"
                  >
                    {String(t("admin.volunteerPackPreviewNoRoles"))}
                  </Text>
                ) : (
                  <PackRoleCatalogue
                    packs={[pack]}
                    testId="volunteer-pack-preview"
                  />
                )}
              </YStack>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                size="$3"
                onPress={() => setPreviewOpen(false)}
              >
                {String(t("admin.volunteerPackPreviewDone"))}
              </Button>
            </Modal.Footer>
          </Modal.Panel>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title={String(t("admin.volunteerPackDeleteConfirmTitle"))}
        description={String(t("admin.volunteerPackDeleteConfirmDescription"))}
        confirmLabel={String(t("admin.volunteerPackDeleteCta"))}
        cancelLabel={String(t("admin.cancel"))}
        tone="danger"
        loading={removeMutation.isPending}
      />
    </PlatformContainer>
  );
}
