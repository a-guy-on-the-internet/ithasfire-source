"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Button,
  NextLinkAnchor,
  Text,
  Badge,
  Tooltip,
  Switch,
  Modal,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Archive, Copy, Layers, Pencil, Plus, Trash2 } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { TableContainer } from "@/components/AdminTableParts";
import { PlatformTemplateTag } from "@/components/volunteering/PlatformTemplateTag";
import {
  ShiftAnchorFields,
  ShiftAnchorPreview,
  useSampleShowtimeTargets,
} from "@/components/volunteering/ShiftAnchorFields";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import {
  type ShiftDraftFields,
  type TemplateShiftAnchor,
  emptyShiftDraftFields,
  minuteOfDayToTime,
  parseShiftDraftFields,
} from "@/lib/template-shift-offset";
import { PackPickerGrid, packRoleShadowKey } from "./PackPickerGrid";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  defaultCapacity: number | null;
  archived: boolean;
  /**
   * Platform catalogue row (orgId null, curated by Ithas Fire). Read-only to
   * organizers: every mutating template use case refuses one server-side, and
   * `getWithShifts` returns null for it — so this row offers Customise, never
   * Edit / Archive / shift editing.
   */
  isPlatform: boolean;
  /** Owning pack on a catalogue row; source pack on an org's fork. */
  packId: string | null;
}

type DialogState =
  | null
  | { mode: "create" }
  | { mode: "edit"; id: string; initial: TemplateRow };

/**
 * A Customise that came back `TEMPLATE_NAME_TAKEN`: the org already owns a
 * template by that name which is NOT this catalogue role's fork. The documented
 * recovery is to re-submit with an explicit name, so we hold the attempt and
 * ask — without it the collision is a dead end.
 */
interface ForkRenameState {
  templateId: string;
  originalName: string;
}

const MAX_TEMPLATE_SHIFTS = 25;

// ─────────────────────────────────────────────────────────────────────────────
// View
// ─────────────────────────────────────────────────────────────────────────────

export function VolunteerTemplatesView() {
  const t = useTranslations();
  const { toast } = useNotify();
  const { slug } = useParams<{ slug: string }>();
  const {
    currentOwner,
    isLoading: isOwnerLoading,
    ownerEntities,
  } = useCurrentAdminOwner(slug);
  // `/admin` sends a person with no groups straight to their own dashboard,
  // so "Choose an account" is only a real choice when they have a group.
  const hasGroup = Boolean(
    ownerEntities.ownersWithSlugs?.some((o) => o.kind === "org"),
  );
  // Server enforces ORG_ADMIN_ROLES for template create/update/archive AND for
  // upsertShifts (manage-role-templates.ts create/update/archive/upsertShifts
  // all requireOrgMembership with ORG_ADMIN_ROLES). The create/edit dialog and
  // its embedded shifts editor are one surface, so every write affordance gates
  // behind canManage (OWNER/ADMIN). The list read (`listRoleTemplates`) admits
  // any org member, which is why the nav offers this page to every role.
  // UX-only; server 403s.
  const { canManage } = useAdminOwnerCapabilities(currentOwner);
  const utils = trpc.useUtils();

  const [includeArchived, setIncludeArchived] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [archiveTarget, setArchiveTarget] = useState<TemplateRow | null>(null);
  const [packPickerOpen, setPackPickerOpen] = useState(false);
  const [forkingTemplateId, setForkingTemplateId] = useState<string | null>(
    null,
  );
  const [forkRename, setForkRename] = useState<ForkRenameState | null>(null);

  const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : null;

  const { data, isLoading, error, refetch } =
    trpc.volunteer.templates.list.useQuery(
      { orgId: orgId!, includeArchived },
      { enabled: !!orgId, staleTime: 30_000 },
    );

  /**
   * A second read, INCLUDING archived rows, purely to key the pack picker's
   * "Customised" state.
   *
   * The fork keys used to come off the visible rows, which hide archived
   * templates unless the toggle is on — so an org that archived a fork was
   * offered "Customise" again, took it, and landed in the name-collision rename
   * dialog with nothing on screen explaining the collision (the server shadows
   * on `(pack, name)` whether or not the row is archived).
   *
   * Gated on the picker actually being on screen, and skipped entirely when
   * `includeArchived` already covers it, so browsing the table stays one
   * request. `data?.length === 0` is false while `data` is undefined, which
   * keeps it from firing during the first load of an org that does have
   * templates.
   */
  const packPickerVisible = canManage && (packPickerOpen || data?.length === 0);
  const forkKeysQuery = trpc.volunteer.templates.list.useQuery(
    { orgId: orgId!, includeArchived: true },
    {
      enabled: !!orgId && packPickerVisible && !includeArchived,
      staleTime: 30_000,
    },
  );

  const createMutation = trpc.volunteer.templates.create.useMutation({
    meta: { silent: true },
  });
  const updateMutation = trpc.volunteer.templates.update.useMutation({
    meta: { silent: true },
  });
  const archiveMutation = trpc.volunteer.templates.archive.useMutation({
    meta: { silent: true },
  });
  const upsertShiftsMutation =
    trpc.volunteer.templates.upsertShifts.useMutation({
      meta: { silent: true },
    });
  const forkMutation = trpc.volunteer.templates.fork.useMutation({
    meta: { silent: true },
  });

  const rows = useMemo<TemplateRow[]>(
    () =>
      (data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        defaultCapacity: row.defaultCapacity,
        archived: row.archived,
        isPlatform: row.isPlatform,
        packId: row.packId,
      })),
    [data],
  );

  /**
   * (pack, name) keys of catalogue roles this org has already customised — the
   * same identity the server shadows on, so the pack picker can show
   * "Customised" instead of offering a second fork of a role already theirs.
   *
   * Read off the ARCHIVE-INCLUSIVE list, not the visible rows: an archived fork
   * still collides server-side. Falls back to the visible rows while that query
   * is in flight.
   */
  const forkedRoleKeys = useMemo(() => {
    const source = includeArchived ? data : (forkKeysQuery.data ?? data);
    const keys = new Set<string>();
    for (const row of source ?? []) {
      if (row.isPlatform) continue;
      const key = packRoleShadowKey(row);
      if (key) keys.add(key);
    }
    return keys;
  }, [data, forkKeysQuery.data, includeArchived]);

  /**
   * Customise: fork a catalogue role into an org-owned copy, then drop the
   * organizer straight into the edit dialog on the new copy — "make it theirs"
   * ends in editing it, not in hunting the table for the row that appeared.
   *
   * Idempotent server-side (keyed on org + source template), so a double click
   * cannot make two copies. `name` is only sent on the retry path — the fork
   * copies the catalogue name by default, and the server refuses rather than
   * overwrite an org's own row of that name.
   */
  const handleFork = useCallback(
    async (role: { id: string; name: string }, name?: string) => {
      if (!orgId) return;
      setForkingTemplateId(role.id);
      try {
        const forked = await forkMutation.mutateAsync({
          orgId,
          templateId: role.id,
          ...(name ? { name } : {}),
        });
        toast.success({
          id: "volunteer-template-forked",
          title: String(t("admin.volunteerTemplateCustomised")),
          message: String(
            t("admin.volunteerTemplateCustomisedMessage", {
              name: forked.name,
            }),
          ),
        });
        setForkRename(null);
        // Close the pack picker (if the fork came from the modal) and open the
        // SAME edit dialog the row's Edit button uses, seeded with the record
        // the fork mutation returned. The dialog lazy-loads shift presets via
        // getWithShifts itself, so no wait on the list refetch is needed.
        setPackPickerOpen(false);
        setDialog({
          mode: "edit",
          id: forked.id,
          initial: {
            id: forked.id,
            name: forked.name,
            description: forked.description,
            defaultCapacity: forked.defaultCapacity,
            archived: forked.archived,
            isPlatform: forked.isPlatform,
            packId: forked.packId,
          },
        });
        await utils.volunteer.templates.list.invalidate();
      } catch (err) {
        if (getAppErrorCode(err) === "TEMPLATE_NAME_TAKEN") {
          // The documented escape hatch — ask for a different name and
          // re-submit. Never silently overwrite the org's own template.
          setForkRename({
            templateId: role.id,
            originalName: name ?? role.name,
          });
          return;
        }
        toast.danger({
          id: "volunteer-template-fork-failed",
          title: String(t("admin.volunteerTemplateCustomiseFailed")),
          message: formatErrorMessage(err, t),
        });
      } finally {
        setForkingTemplateId(null);
      }
    },
    [orgId, forkMutation, toast, t, utils.volunteer.templates.list],
  );

  const handleArchive = useCallback(async () => {
    if (!archiveTarget) return;
    try {
      await archiveMutation.mutateAsync({ id: archiveTarget.id });
      toast.success({
        id: "volunteer-template-archived",
        title: t("admin.volunteerTemplateArchived") as string,
      });
      await utils.volunteer.templates.list.invalidate();
      setArchiveTarget(null);
    } catch (err) {
      toast.danger({
        id: "volunteer-template-archive-failed",
        title: t("admin.volunteerTemplateArchiveFailed") as string,
        message: formatErrorMessage(err, t),
      });
    }
  }, [
    archiveTarget,
    archiveMutation,
    toast,
    utils.volunteer.templates.list,
    t,
  ]);

  const columns = useMemo<DataTableColumn<TemplateRow>[]>(
    () => [
      {
        id: "name",
        header: String(t("admin.volunteerTemplateNameColumn")),
        width: 2.5,
        sortValue: (row) => row.name,
        cell: (row) => (
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Text variant="body" style={{ fontWeight: 700 }}>
              {row.name}
            </Text>
            {row.isPlatform ? (
              <PlatformTemplateTag
                testId={`volunteer-template-platform-tag-${row.id}`}
              />
            ) : null}
          </XStack>
        ),
      },
      {
        id: "description",
        header: String(t("admin.volunteerTemplateDescriptionColumn")),
        width: 4,
        cell: (row) => (
          <Text
            variant="caption"
            tone="muted"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 480,
            }}
          >
            {row.description ?? "—"}
          </Text>
        ),
      },
      {
        id: "defaultCapacity",
        header: String(t("admin.volunteerTemplateDefaultCapacityColumn")),
        width: 1.2,
        sortValue: (row) => row.defaultCapacity ?? 0,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {row.defaultCapacity ?? "—"}
          </Text>
        ),
      },
      {
        id: "status",
        header: String(t("admin.volunteerTemplateStatusColumn")),
        width: 1.2,
        cell: (row) => (
          <Badge tone={row.archived ? "neutral" : "success"} size="sm">
            {String(
              t(
                row.archived
                  ? "admin.volunteerTemplateStatusArchived"
                  : "admin.volunteerTemplateStatusActive",
              ),
            )}
          </Badge>
        ),
      },
    ],
    [t],
  );

  const rowActions = useMemo(
    () =>
      canManage
        ? {
            header: "",
            width: 1.6,
            render: (row: TemplateRow) =>
              // A platform row is read-only to this org — the server refuses
              // update / archive / upsertShifts on one, and getWithShifts
              // returns null — so it offers Customise INSTEAD of edit
              // affordances that would only ever 404.
              row.isPlatform ? (
                <XStack gap="$2" justifyContent="flex-end">
                  <Button
                    size="$2"
                    variant="secondary"
                    onPress={() => void handleFork(row)}
                    disabled={forkingTemplateId === row.id}
                    data-testid={`volunteer-template-customise-${row.id}`}
                  >
                    <Copy size={14} aria-hidden />
                    {String(t("admin.volunteerTemplateCustomiseCta"))}
                  </Button>
                </XStack>
              ) : (
                <XStack gap="$2" justifyContent="flex-end">
                  <Tooltip
                    anchor={
                      <Button
                        size="$2"
                        variant="ghost"
                        icon
                        onPress={() =>
                          setDialog({ mode: "edit", id: row.id, initial: row })
                        }
                        aria-label={String(
                          t("admin.volunteerTemplateEditTooltip"),
                        )}
                      >
                        <Pencil size={14} />
                      </Button>
                    }
                    placement="top"
                  >
                    {String(t("admin.volunteerTemplateEditTooltip"))}
                  </Tooltip>
                  {!row.archived ? (
                    <Tooltip
                      anchor={
                        <Button
                          size="$2"
                          variant="ghost"
                          icon
                          onPress={() => setArchiveTarget(row)}
                          aria-label={String(
                            t("admin.volunteerTemplateArchiveTooltip"),
                          )}
                        >
                          <Archive size={14} />
                        </Button>
                      }
                      placement="top"
                    >
                      {String(t("admin.volunteerTemplateArchiveTooltip"))}
                    </Tooltip>
                  ) : null}
                </XStack>
              ),
          }
        : undefined,
    [t, canManage, handleFork, forkingTemplateId],
  );

  // ── Early returns ──────────────────────────────────────────────────────

  if (isOwnerLoading || isLoading) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingVolunteerTemplates"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!currentOwner) {
    return (
      <YStack padding="$4">
        <Text>{String(t("admin.unableToDetermineOwnerAudiences"))}</Text>
      </YStack>
    );
  }

  if (!orgId) {
    return (
      <YStack
        gap="$4"
        flex={1}
        padding="$4"
        maxWidth={1440}
        marginHorizontal="auto"
        width="100%"
      >
        <AdminPageHeader
          title={String(t("admin.volunteerTemplatesTitle"))}
          subtitle={String(t("admin.volunteerTemplatesSubtitle"))}
          sectionNumber="05"
        />
        <YStack padding="$8" alignItems="center" gap="$3">
          <Text variant="body" tone="muted" textAlign="center" maxWidth={480}>
            {String(t("admin.volunteerTemplatesHumanOwnerNotice"))}
          </Text>
          {hasGroup ? (
            <NextLinkAnchor
              href="/admin"
              data-testid="volunteers-choose-account"
              style={{ textDecoration: "none" }}
            >
              <Button tag="span" variant="secondary">
                {String(t("admin.chooseAccountLink"))}
              </Button>
            </NextLinkAnchor>
          ) : null}
        </YStack>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack padding="$4" gap="$3">
        <Text variant="body" tone="error">
          {formatErrorMessage(error)}
        </Text>
        <Button variant="secondary" size="$2" onPress={() => refetch()}>
          {String(t("admin.retry"))}
        </Button>
      </YStack>
    );
  }

  const hasRows = rows.length > 0;

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      <AdminPageHeader
        title={String(t("admin.volunteerTemplatesTitle"))}
        subtitle={String(t("admin.volunteerTemplatesSubtitle"))}
        sectionNumber="05"
        trailing={
          /* This cluster keeps its own XStack (gap $3 + the switch grouping),
             so it must carry the same wrap/shrink trio as the header's
             trailing slot: without them it is a single flex item whose
             min-content width is the un-wrapped sum of switch + buttons,
             which pans the whole document on phones. Wrap precedes shrink,
             so wide viewports stay single-line. */
          <XStack
            gap="$3"
            alignItems="center"
            flexWrap="wrap"
            flexShrink={1}
            minWidth={0}
          >
            <XStack gap="$2" alignItems="center">
              <Switch
                checked={includeArchived}
                onCheckedChange={setIncludeArchived}
                aria-label={String(t("admin.volunteerTemplateIncludeArchived"))}
                size="small"
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.volunteerTemplateIncludeArchived"))}
              </Text>
            </XStack>
            {canManage && hasRows ? (
              // Once the org has templates of their own, the catalogue stops
              // being the point of the page and moves behind this action.
              <Button
                variant="secondary"
                size="$3"
                onPress={() => setPackPickerOpen(true)}
                data-testid="volunteer-templates-open-pack-picker"
              >
                <Layers size={18} aria-hidden />
                {String(t("admin.volunteerPackPickerCta"))}
              </Button>
            ) : null}
            {canManage ? (
              <Button
                variant="primary"
                size="$3"
                onPress={() => setDialog({ mode: "create" })}
              >
                <Plus size={18} />
                {String(t("admin.volunteerTemplatesNewCta"))}
              </Button>
            ) : null}
          </XStack>
        }
      />

      {/* The 640px table floor lives INSIDE TableContainer (the overflow:auto
          box) so on phones the table scrolls within its own container instead
          of forcing the whole document wide — the shell no longer clips
          horizontal overflow, so an outer floor pans the entire page. */}
      <YStack flex={1} minWidth={0}>
        <TableContainer>
          <YStack minWidth={640}>
            <DataTable
            rows={rows}
            columns={columns}
            clientSort
            getRowKey={(row) => row.id}
            isLoading={isLoading}
            emptyState={
              !hasRows ? (
                <YStack padding="$8" alignItems="center" gap="$3">
                  <Text variant="h4" weight="bold" textAlign="center">
                    {String(t("admin.volunteerTemplatesEmptyTitle"))}
                  </Text>
                  <Text
                    variant="body"
                    tone="muted"
                    textAlign="center"
                    maxWidth={360}
                  >
                    {String(t("admin.volunteerTemplatesEmptyDescription"))}
                  </Text>
                  {canManage ? (
                    <Button
                      variant="secondary"
                      size="$3"
                      onPress={() => setDialog({ mode: "create" })}
                    >
                      <Plus size={18} />
                      {String(t("admin.volunteerTemplatesCreateFirst"))}
                    </Button>
                  ) : null}
                </YStack>
              ) : undefined
            }
            rowActions={rowActions}
            testIdBase="volunteer-templates-table"
          />
          </YStack>
        </TableContainer>
      </YStack>

      {/*
        Empty state: the catalogue IS the page. Once the org has rows of their
        own it moves behind the "Start from a pack" action in the header, so it
        never competes with the templates the organizer actually made.
      */}
      {!hasRows && canManage ? (
        <YStack
          gap="$3"
          borderTopWidth={1}
          borderTopColor="$borderColor"
          paddingTop="$4"
        >
          <Text
            variant="h4"
            weight="bold"
            style={{ textTransform: "uppercase" }}
          >
            {String(t("admin.volunteerPackPickerTitle"))}
          </Text>
          <PackPickerGrid
            orgId={orgId}
            canManage={canManage}
            onCustomise={(role) => void handleFork(role)}
            busyTemplateId={forkingTemplateId}
            forkedRoleKeys={forkedRoleKeys}
          />
        </YStack>
      ) : null}

      {packPickerOpen ? (
        <Modal open onClose={() => setPackPickerOpen(false)}>
          <Modal.Panel width={880}>
            <Modal.Header
              title={String(t("admin.volunteerPackPickerTitle"))}
              onClose={() => setPackPickerOpen(false)}
            />
            <Modal.Body>
              <PackPickerGrid
                orgId={orgId}
                canManage={canManage}
                onCustomise={(role) => void handleFork(role)}
                busyTemplateId={forkingTemplateId}
                forkedRoleKeys={forkedRoleKeys}
              />
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                size="$3"
                onPress={() => setPackPickerOpen(false)}
              >
                {String(t("admin.volunteerPackPickerDone"))}
              </Button>
            </Modal.Footer>
          </Modal.Panel>
        </Modal>
      ) : null}

      {forkRename ? (
        <ForkRenameDialog
          state={forkRename}
          isSaving={forkMutation.isPending}
          onCancel={() => setForkRename(null)}
          onSubmit={(name) =>
            handleFork(
              { id: forkRename.templateId, name: forkRename.originalName },
              name,
            )
          }
        />
      ) : null}

      {dialog ? (
        <TemplateDialog
          key={dialog.mode === "edit" ? `edit-${dialog.id}` : "create"}
          state={dialog}
          onClose={() => setDialog(null)}
          isSaving={
            createMutation.isPending ||
            updateMutation.isPending ||
            upsertShiftsMutation.isPending
          }
          onSubmit={async (values) => {
            try {
              let templateId: string;
              if (dialog.mode === "edit") {
                const updated = await updateMutation.mutateAsync({
                  id: dialog.id,
                  name: values.name,
                  description: values.description,
                  defaultCapacity: values.defaultCapacity,
                });
                templateId = updated.id;
              } else {
                const created = await createMutation.mutateAsync({
                  orgId,
                  name: values.name,
                  description: values.description,
                  defaultCapacity: values.defaultCapacity,
                });
                templateId = created.id;
              }

              // Persist shift presets in a second mutation. Server uses
              // replace-set semantics, so an empty array clears the list.
              await upsertShiftsMutation.mutateAsync({
                templateId,
                shifts: values.shifts,
              });

              toast.success({
                id:
                  dialog.mode === "edit"
                    ? "volunteer-template-updated"
                    : "volunteer-template-created",
                title: t(
                  dialog.mode === "edit"
                    ? "admin.volunteerTemplateUpdated"
                    : "admin.volunteerTemplateCreated",
                ) as string,
              });
              await Promise.all([
                utils.volunteer.templates.list.invalidate(),
                utils.volunteer.templates.getWithShifts.invalidate({
                  templateId,
                }),
              ]);
              setDialog(null);
            } catch (err) {
              toast.danger({
                id: "volunteer-template-save-failed",
                title: t("admin.volunteerTemplateSaveFailed") as string,
                message: formatErrorMessage(err, t),
              });
            }
          }}
        />
      ) : null}

      <ConfirmDialog
        open={!!archiveTarget}
        onCancel={() => setArchiveTarget(null)}
        onConfirm={handleArchive}
        title={String(t("admin.volunteerTemplateArchiveConfirmTitle"))}
        description={String(
          t("admin.volunteerTemplateArchiveConfirmDescription"),
        )}
        confirmLabel={String(t("admin.volunteerTemplateArchiveConfirmCta"))}
        cancelLabel={String(t("admin.cancel"))}
        loading={archiveMutation.isPending}
      />
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateDialogValues {
  name: string;
  description: string | null;
  defaultCapacity: number | null;
  shifts: Array<{
    label: string;
    startMinuteOfDay: number;
    endMinuteOfDay: number;
    startDayOffset: number;
    endsNextDay: boolean;
    capacity?: number | null;
    position: number;
    anchor: TemplateShiftAnchor;
    offsetMinutes: number;
  }>;
}

interface TemplateDialogProps {
  state: Exclude<DialogState, null>;
  onClose: () => void;
  isSaving: boolean;
  onSubmit: (values: TemplateDialogValues) => Promise<void> | void;
}

function TemplateDialog({
  state,
  onClose,
  isSaving,
  onSubmit,
}: TemplateDialogProps) {
  const t = useTranslations();

  const isEdit = state.mode === "edit";
  const initial = state.mode === "edit" ? state.initial : undefined;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [defaultCapacity, setDefaultCapacity] = useState(
    initial?.defaultCapacity != null ? String(initial.defaultCapacity) : "",
  );
  const [error, setError] = useState<string | null>(null);

  // ── Shifts editor state ────────────────────────────────────────────────
  // Lazy-load existing shifts via getWithShifts when editing — keeps the
  // list query lean and avoids over-fetching for templates the user only
  // browses past in the table.
  const [shifts, setShifts] = useState<ShiftDraftFields[]>([]);
  const existingQuery = trpc.volunteer.templates.getWithShifts.useQuery(
    { templateId: state.mode === "edit" ? state.id : "" },
    { enabled: state.mode === "edit", staleTime: 5_000 },
  );

  // Seed shifts from server response on first arrival; in create mode
  // start with an empty list. Reset whenever the dialog instance flips.
  const seededRef = useRef(false);
  useEffect(() => {
    if (state.mode === "create") {
      seededRef.current = true;
      setShifts([]);
      return;
    }
    if (seededRef.current) return;
    const data = existingQuery.data;
    if (!data) return;
    seededRef.current = true;
    setShifts(
      data.shifts.map((shift) => ({
        id: shift.id,
        label: shift.label,
        startTime: minuteOfDayToTime(shift.startMinuteOfDay),
        endTime: minuteOfDayToTime(shift.endMinuteOfDay),
        dayOffset: String(shift.startDayOffset),
        capacity: shift.capacity != null ? String(shift.capacity) : "",
        // Round-trip the anchor verbatim. Dropping either field here would
        // silently flatten an anchored preset to wall clock on the next save.
        anchor: shift.anchor,
        offsetMinutes: String(shift.offsetMinutes),
      })),
    );
  }, [existingQuery.data, state.mode]);

  const handleSubmit = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(String(t("admin.volunteerTemplateFieldNameLabel")));
      return;
    }

    let parsedCapacity: number | null = null;
    if (defaultCapacity.trim()) {
      const n = Number(defaultCapacity);
      if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        setError(String(t("admin.volunteerTemplateFieldDefaultCapacityLabel")));
        return;
      }
      parsedCapacity = n;
    }

    // Validate every shift draft. Bail at the first invalid row so the
    // user can fix it instead of triggering a wall of errors at once.
    const parsedShifts: TemplateDialogValues["shifts"] = [];
    for (let i = 0; i < shifts.length; i += 1) {
      const result = parseShiftDraftFields(shifts[i]!);
      if (!result.ok) {
        setError(String(t("admin.volunteerTemplateShiftFixErrors")));
        return;
      }
      parsedShifts.push({
        label: result.value.label,
        startMinuteOfDay: result.value.startMinuteOfDay,
        endMinuteOfDay: result.value.endMinuteOfDay,
        startDayOffset: result.value.startDayOffset,
        endsNextDay: result.value.endsNextDay,
        capacity: result.value.capacity,
        position: i,
        anchor: result.value.anchor,
        offsetMinutes: result.value.offsetMinutes,
      });
    }

    setError(null);
    await onSubmit({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      defaultCapacity: parsedCapacity,
      shifts: parsedShifts,
    });
  }, [name, description, defaultCapacity, shifts, onSubmit, t]);

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={520}>
        <Modal.Header
          title={String(
            t(
              isEdit
                ? "admin.volunteerTemplateDialogEditTitle"
                : "admin.volunteerTemplateDialogCreateTitle",
            ),
          )}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerTemplateFieldNameLabel"))}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={String(
                  t("admin.volunteerTemplateFieldNamePlaceholder"),
                )}
                fullWidth
                maxLength={120}
                testId="volunteer-template-name-input"
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerTemplateFieldDescriptionLabel"))}
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder={String(
                  t("admin.volunteerTemplateFieldDescriptionPlaceholder"),
                )}
                fullWidth
                multiline
                numberOfLines={3}
                maxLength={2000}
                testId="volunteer-template-description-input"
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerTemplateFieldDefaultCapacityLabel"))}
              </Text>
              <TextInput
                value={defaultCapacity}
                onChangeText={setDefaultCapacity}
                placeholder={String(
                  t("admin.volunteerTemplateFieldDefaultCapacityPlaceholder"),
                )}
                fullWidth
                inputMode="numeric"
                testId="volunteer-template-default-capacity-input"
              />
            </YStack>

            <TemplateShiftsEditor
              shifts={shifts}
              onChange={setShifts}
              disabled={isSaving}
            />

            {error ? (
              <Text variant="caption" tone="error">
                {error}
              </Text>
            ) : null}
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            size="$3"
            onPress={onClose}
            disabled={isSaving}
          >
            {String(t("admin.cancel"))}
          </Button>
          <Button
            variant="primary"
            size="$3"
            onPress={handleSubmit}
            disabled={isSaving || !name.trim()}
          >
            {String(t("admin.volunteerTemplateSaveCta"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shifts editor (within TemplateDialog)
// ─────────────────────────────────────────────────────────────────────────────

function TemplateShiftsEditor({
  shifts,
  onChange,
  disabled,
}: {
  shifts: ShiftDraftFields[];
  onChange: (next: ShiftDraftFields[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  // Two contrasting showtimes. A preset anchored "3 hours before the show"
  // reads 5:00 PM against one and 11:00 AM against the other — which is the
  // whole point of seeing both before saving.
  const previewTargets = useSampleShowtimeTargets();

  const updateShift = (index: number, patch: Partial<ShiftDraftFields>) => {
    onChange(shifts.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const removeShift = (index: number) => {
    onChange(shifts.filter((_, i) => i !== index));
  };

  const addShift = () => {
    if (shifts.length >= MAX_TEMPLATE_SHIFTS) return;
    onChange([...shifts, emptyShiftDraftFields()]);
  };

  return (
    <YStack
      gap="$2"
      borderWidth={1}
      borderColor="$borderColor"
      padding="$3"
      backgroundColor="$surfaceMuted"
    >
      <XStack
        justifyContent="space-between"
        alignItems="center"
        gap="$2"
        flexWrap="wrap"
      >
        <Text variant="label">
          {String(t("admin.volunteerTemplateShiftsLabel"))}
        </Text>
        <Button
          variant="secondary"
          size="$2"
          onPress={addShift}
          disabled={disabled || shifts.length >= MAX_TEMPLATE_SHIFTS}
        >
          <XStack gap="$2" alignItems="center">
            <Plus size={14} />
            <Text tone="inherit">
              {String(t("admin.volunteerTemplateShiftAddCta"))}
            </Text>
          </XStack>
        </Button>
      </XStack>

      <Text variant="caption" tone="muted">
        {String(t("admin.volunteerTemplateShiftsHelp"))}
      </Text>

      {shifts.length === 0 ? (
        <Text variant="caption" tone="muted">
          {String(t("admin.volunteerTemplateShiftsEmpty"))}
        </Text>
      ) : (
        <YStack gap="$3">
          {shifts.map((shift, index) => (
            <YStack
              key={shift.id}
              gap="$2"
              borderWidth={1}
              borderColor="$borderColor"
              backgroundColor="$surface"
              padding="$3"
            >
              <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
                <YStack flex={1} minWidth={180} gap="$1">
                  <Text variant="label">
                    {String(t("admin.volunteerTemplateShiftFieldLabelLabel"))}
                  </Text>
                  <TextInput
                    value={shift.label}
                    onChangeText={(value) =>
                      updateShift(index, { label: value })
                    }
                    placeholder={String(
                      t("admin.volunteerTemplateShiftFieldLabelPlaceholder"),
                    )}
                    maxLength={120}
                    disabled={disabled}
                    fullWidth
                    testId={`volunteer-template-shift-${index}-label`}
                  />
                </YStack>
                <Tooltip
                  anchor={
                    <Button
                      variant="ghost"
                      size="$2"
                      onPress={() => removeShift(index)}
                      disabled={disabled}
                      aria-label={String(
                        t("admin.volunteerTemplateShiftRemoveCta"),
                      )}
                    >
                      <Trash2 size={14} />
                    </Button>
                  }
                  placement="top"
                >
                  {String(t("admin.volunteerTemplateShiftRemoveCta"))}
                </Tooltip>
              </XStack>

              <ShiftAnchorFields
                fields={shift}
                onChange={(patch) => updateShift(index, patch)}
                disabled={disabled}
                testIdBase={`volunteer-template-shift-${index}`}
              />

              <XStack gap="$3" flexWrap="wrap">
                {/*
                  The clock fields only mean anything on a WALL_CLOCK preset.
                  On an anchored one they carry the DURATION, which the "Lasts"
                  control above edits — showing both would be two controls
                  writing the same two columns.
                */}
                {(shift.anchor ?? "WALL_CLOCK") === "WALL_CLOCK" ? (
                  <>
                    <YStack width={140} minWidth={140} gap="$1">
                      <Text variant="label">
                        {String(t("admin.volunteerTemplateShiftStartLabel"))}
                      </Text>
                      <input
                        type="time"
                        aria-label={String(
                          t("admin.volunteerTemplateShiftStartLabel"),
                        )}
                        value={shift.startTime}
                        onChange={(e) =>
                          updateShift(index, { startTime: e.target.value })
                        }
                        disabled={disabled}
                        data-testid={`volunteer-template-shift-${index}-start`}
                        style={NATIVE_TIME_STYLE}
                      />
                    </YStack>
                    <YStack width={140} minWidth={140} gap="$1">
                      <Text variant="label">
                        {String(t("admin.volunteerTemplateShiftEndLabel"))}
                      </Text>
                      <input
                        type="time"
                        aria-label={String(
                          t("admin.volunteerTemplateShiftEndLabel"),
                        )}
                        value={shift.endTime}
                        onChange={(e) =>
                          updateShift(index, { endTime: e.target.value })
                        }
                        disabled={disabled}
                        data-testid={`volunteer-template-shift-${index}-end`}
                        style={NATIVE_TIME_STYLE}
                      />
                    </YStack>
                  </>
                ) : null}
                <YStack width={180} minWidth={180} gap="$1">
                  <Text variant="label">
                    {String(t("admin.volunteerTemplateShiftDayLabel"))}
                  </Text>
                  <select
                    value={shift.dayOffset}
                    onChange={(e) =>
                      updateShift(index, { dayOffset: e.target.value })
                    }
                    disabled={disabled}
                    data-testid={`volunteer-template-shift-${index}-day`}
                    style={NATIVE_SELECT_STYLE}
                  >
                    <option value="-2">
                      {String(t("admin.volunteerTemplateShiftDayMinus2"))}
                    </option>
                    <option value="-1">
                      {String(t("admin.volunteerTemplateShiftDayMinus1"))}
                    </option>
                    <option value="0">
                      {String(t("admin.volunteerTemplateShiftDayZero"))}
                    </option>
                    <option value="1">
                      {String(t("admin.volunteerTemplateShiftDayPlus1"))}
                    </option>
                    <option value="2">
                      {String(t("admin.volunteerTemplateShiftDayPlus2"))}
                    </option>
                  </select>
                </YStack>
                <YStack width={140} minWidth={140} gap="$1">
                  <Text variant="label">
                    {String(t("admin.volunteerTemplateShiftCapacityLabel"))}
                  </Text>
                  <TextInput
                    value={shift.capacity}
                    onChangeText={(value) =>
                      updateShift(index, { capacity: value })
                    }
                    placeholder={String(
                      t("admin.volunteerTemplateShiftCapacityPlaceholder"),
                    )}
                    inputMode="numeric"
                    disabled={disabled}
                    fullWidth
                    testId={`volunteer-template-shift-${index}-capacity`}
                  />
                </YStack>
              </XStack>

              <ShiftAnchorPreview
                fields={shift}
                previewTargets={previewTargets}
                testIdBase={`volunteer-template-shift-${index}`}
              />
            </YStack>
          ))}
        </YStack>
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Customise name-collision recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `TEMPLATE_NAME_TAKEN` escape hatch (FR-011).
 *
 * The org already has a template with the catalogue role's name that is NOT a
 * fork of it — their own hand-made "Door", or an archived fork. The server
 * refuses rather than overwrite it, and the documented recovery is to
 * re-submit with an explicit name. Without this dialog the collision is a dead
 * end: the button would just keep failing.
 */
function ForkRenameDialog({
  state,
  isSaving,
  onCancel,
  onSubmit,
}: {
  state: ForkRenameState;
  isSaving: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void> | void;
}) {
  const t = useTranslations();
  const [name, setName] = useState(
    String(
      t("admin.volunteerTemplateCustomiseRenameSuggestion", {
        name: state.originalName,
      }),
    ),
  );

  const trimmed = name.trim();
  const unchanged = trimmed.toLowerCase() === state.originalName.toLowerCase();

  return (
    <Modal open onClose={onCancel}>
      <Modal.Panel width={460}>
        <Modal.Header
          title={String(t("admin.volunteerTemplateCustomiseRenameTitle"))}
          onClose={onCancel}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="body" tone="muted">
              {String(
                t("admin.volunteerTemplateCustomiseRenameDescription", {
                  name: state.originalName,
                }),
              )}
            </Text>
            <YStack gap="$1">
              <Text variant="label">
                {String(t("admin.volunteerTemplateFieldNameLabel"))}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={120}
                fullWidth
                autoFocus
                testId="volunteer-template-fork-rename-input"
              />
              {unchanged ? (
                <Text variant="caption" tone="error">
                  {String(t("admin.volunteerTemplateCustomiseRenameUnchanged"))}
                </Text>
              ) : null}
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            size="$3"
            onPress={onCancel}
            disabled={isSaving}
          >
            {String(t("admin.cancel"))}
          </Button>
          <Button
            variant="primary"
            size="$3"
            onPress={() => void onSubmit(trimmed)}
            disabled={isSaving || trimmed.length === 0 || unchanged}
            data-testid="volunteer-template-fork-rename-submit"
          >
            {String(t("admin.volunteerTemplateCustomiseCta"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Native input styling — matches the design system's TextInput height + chrome
// ─────────────────────────────────────────────────────────────────────────────

const NATIVE_TIME_STYLE: React.CSSProperties = {
  height: 40,
  padding: "0 12px",
  border: "1px solid var(--borderColor)",
  borderRadius: 0,
  backgroundColor: "var(--surface)",
  color: "var(--color)",
  fontFamily: "inherit",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};

const NATIVE_SELECT_STYLE: React.CSSProperties = {
  height: 40,
  padding: "0 12px",
  border: "1px solid var(--borderColor)",
  borderRadius: 0,
  backgroundColor: "var(--surface)",
  color: "var(--color)",
  fontFamily: "inherit",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};
