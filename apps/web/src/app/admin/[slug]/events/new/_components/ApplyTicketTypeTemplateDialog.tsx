"use client";

/**
 * ApplyTicketTypeTemplateDialog — picks a saved owner-scoped ticket-type
 * template OR a platform catalogue template ("From Ithas Fire",
 * ticket-type-packs spec FR-011) and applies it to the current event
 * (`ticketTypeTemplates.applyTicketTypeTemplate`).
 *
 * The list response carries the FR-006 union: the owner's rows plus LIVE
 * platform templates (fork-shadowed server-side), with pack metadata for
 * grouping. Owned rows keep their archive affordance; platform rows carry
 * the "From Ithas Fire" tag and offer Apply + Customise instead — the server
 * refuses archive on one anyway (FR-005). Customise shows only with
 * `canCustomise` (the fork's OWNER/ADMIN bar). Catalogue entry previews show face
 * price, capacity and pricing mode.
 *
 * The server copies each entry onto the event, skipping names that already
 * exist there; the result toast reports both counts. Rows behave as a
 * radiogroup (keyboard-selectable).
 */

import { useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { XStack, YStack, useTheme } from "tamagui";
import { Archive, Copy, Info } from "lucide-react";

import {
  Button,
  Modal,
  Text,
  TextInput,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { fmtCurrency } from "@/lib/format";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { PlatformTemplateTag } from "@/components/volunteering/PlatformTemplateTag";
import { EventEditorSheet } from "./EventEditorSheet";
import {
  buildCatalogueEntryPreview,
  buildTemplateEntryPreview,
} from "./ticket-type-template-helpers";
import type { TemplateOwnerRef } from "./TicketTypeTemplateControls";

/** The template entry an apply was refused for (`template_entry_invalid`). */
export function templateEntryInvalidName(error: unknown): string | null {
  const e = error as { message?: unknown; data?: { meta?: unknown } } | null;
  if (e?.message !== "template_entry_invalid") return null;
  const meta = e.data?.meta as { entryName?: unknown } | undefined;
  return typeof meta?.entryName === "string" && meta.entryName
    ? meta.entryName
    : null;
}

export type ApplyTicketTypeTemplateDialogProps = {
  owner: TemplateOwnerRef;
  eventId: string;
  /** When true, a note explains that applied types arrive unseated. */
  hasSeatingLayout?: boolean;
  /**
   * Offer "Customise" (fork a catalogue template into the owner's library).
   * The fork asks org OWNER/ADMIN, or the owner / an OWNER/ADMIN delegate on
   * a personal library — narrower than apply — so it is withheld unless the
   * caller says the viewer clears that bar. Apply is unaffected.
   */
  canCustomise?: boolean;
  onClose: () => void;
};

type ArchiveTarget = { id: string; name: string };

/** A Customise that came back TEMPLATE_NAME_TAKEN — re-submit with a name. */
type ForkRenameState = { templateId: string; originalName: string };

export function ApplyTicketTypeTemplateDialog({
  owner,
  eventId,
  hasSeatingLayout = false,
  canCustomise = false,
  onClose,
}: ApplyTicketTypeTemplateDialogProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const theme = useTheme();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(
    null,
  );
  const [forkRename, setForkRename] = useState<ForkRenameState | null>(null);
  const [forkingTemplateId, setForkingTemplateId] = useState<string | null>(
    null,
  );

  const templatesQuery =
    trpc.ticketTypeTemplates.listTicketTypeTemplates.useQuery(
      { ownerScope: owner.ownerScope, ownerId: owner.ownerId },
      { staleTime: 30_000 },
    );

  const applyMutation =
    trpc.ticketTypeTemplates.applyTicketTypeTemplate.useMutation({
      retry: false,
      meta: { silent: true },
    });

  const archiveMutation =
    trpc.ticketTypeTemplates.archiveTicketTypeTemplate.useMutation({
      retry: false,
      meta: { silent: true },
    });

  const forkMutation =
    trpc.ticketTypeTemplates.forkPlatformTemplate.useMutation({
      retry: false,
      meta: { silent: true },
    });

  const formatPrice = (cents: number) =>
    cents === 0 ? (t("admin.ttFree") as string) : fmtCurrency(fmt, cents, "usd");

  const items = useMemo(
    () => templatesQuery.data?.items ?? [],
    [templatesQuery.data?.items],
  );
  const ownTemplates = useMemo(
    () => items.filter((item) => !item.isPlatform),
    [items],
  );
  const packs = templatesQuery.data?.packs ?? [];
  const platformByPack = useMemo(() => {
    const map = new Map<string, typeof items>();
    for (const item of items) {
      if (!item.isPlatform || !item.packId) continue;
      const bucket = map.get(item.packId);
      if (bucket) bucket.push(item);
      else map.set(item.packId, [item]);
    }
    return map;
  }, [items]);

  const invalidateList = () =>
    utils.ticketTypeTemplates.listTicketTypeTemplates.invalidate({
      ownerScope: owner.ownerScope,
      ownerId: owner.ownerId,
    });

  const handleApply = async () => {
    if (!selectedId || applyMutation.isPending) return;
    try {
      const result = await applyMutation.mutateAsync({
        eventId,
        templateId: selectedId,
        clientKey: nanoid(12),
      });
      // Same reconciliation pair the editor's own upsert/delete flows use.
      void utils.events.listTicketTypesForEdit.invalidate({ eventId });
      void utils.events.getEventFeePreview.invalidate({ eventId });

      const skippedNote =
        result.skipped.length > 0
          ? (t("admin.ttTplAppliedSkipped", {
              count: result.skipped.length,
              names: result.skipped.join(", "),
            }) as string)
          : null;

      /**
       * FR-016 per-entry drops. A relative window or price flip that could not
       * be materialized against THIS event's date was dropped — the tier
       * exists, it just has no window. Named rather than counted because the
       * organizer is right here and can fix the tier now, which is the whole
       * reason this apply path warns per entry where
       * generate-events-from-series only counts.
       *
       * GROUPED BY `reason`, not flattened. Core makes the reason
       * machine-readable precisely so the copy can be true: telling an
       * organizer their window "had already passed" when it was actually
       * inverted sends them to look at the wrong thing. Names are deduped
       * WITHIN a group — a tier that lost both its window and its flip for the
       * same reason produces two warnings, and "Early bird, Early bird" helps
       * nobody — and the groups render in a fixed order so the message is
       * stable across replays.
       */
      const reasonCopy = {
        already_elapsed: "admin.ttTplAppliedTimingElapsed",
        inverted: "admin.ttTplAppliedTimingInverted",
        unresolvable: "admin.ttTplAppliedTimingUnreadable",
      } as const;
      const warningNote =
        (
          Object.keys(reasonCopy) as (keyof typeof reasonCopy)[]
        )
          .map((reason) => {
            const names = [
              ...new Set(
                (result.warnings ?? [])
                  .filter((w) => w.reason === reason)
                  .map((w) => w.entryName),
              ),
            ];
            if (names.length === 0) return null;
            return t(reasonCopy[reason], {
              count: names.length,
              names: names.join(", "),
            }) as string;
          })
          .filter(Boolean)
          .join(" ") || null;

      if (result.created.length > 0) {
        // A drop downgrades the toast from success to a warning: the types were
        // created, but something the organizer configured did not survive
        // contact with this event's date, and a green tick would bury it.
        const notify = warningNote ? toast.warning : toast.success;
        notify({
          id: "ticket-type-template-applied",
          title: t("admin.ttTplAppliedTitle") as string,
          message: [
            t("admin.ttTplAppliedMessage", {
              count: result.created.length,
            }) as string,
            skippedNote,
            warningNote,
          ]
            .filter(Boolean)
            .join(" "),
        });
      } else {
        toast.info({
          id: "ticket-type-template-applied",
          title: t("admin.ttTplAppliedTitle") as string,
          message: t("admin.ttTplAppliedNoneMessage") as string,
        });
      }
      onClose();
    } catch (error) {
      // A template entry the ticket-type write boundary refuses (e.g. a PWYW
      // minimum stored before today's cap) refuses the WHOLE apply, naming
      // the entry in `data.meta.entryName` — say which one, and that nothing
      // was added.
      const entryName = templateEntryInvalidName(error);
      toast.danger({
        id: "ticket-type-template-apply-failed",
        title: t("admin.ttTplApplyFailed") as string,
        message: entryName
          ? String(t("admin.ttTplEntryInvalid", { name: entryName }))
          : formatErrorMessage(error, t),
      });
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget || archiveMutation.isPending) return;
    try {
      await archiveMutation.mutateAsync({
        templateId: archiveTarget.id,
        clientKey: nanoid(12),
      });
      if (selectedId === archiveTarget.id) setSelectedId(null);
      void invalidateList();
      toast.success({
        id: "ticket-type-template-archived",
        title: t("admin.ttTplArchivedTitle") as string,
      });
      setArchiveTarget(null);
    } catch (error) {
      toast.danger({
        id: "ticket-type-template-archive-failed",
        title: t("admin.ttTplArchiveFailed") as string,
        message: formatErrorMessage(error, t),
      });
    }
  };

  const handleFork = async (
    template: { id: string; name: string },
    name?: string,
  ) => {
    if (forkMutation.isPending) return;
    setForkingTemplateId(template.id);
    try {
      const result = await forkMutation.mutateAsync({
        ownerScope: owner.ownerScope,
        ownerId: owner.ownerId,
        templateId: template.id,
        ...(name ? { name } : {}),
      });
      toast.success({
        id: "ticket-type-template-customised",
        title: String(t("admin.ttTplCustomisedTitle")),
        message: String(
          t("admin.ttTplCustomisedMessage", { name: result.template.name }),
        ),
      });
      setForkRename(null);
      // The fork now shadows its catalogue source; refetch so the owned copy
      // replaces the platform row in place.
      void invalidateList();
      if (selectedId === template.id) setSelectedId(result.template.id);
    } catch (error) {
      if (getAppErrorCode(error) === "TEMPLATE_NAME_TAKEN") {
        // The documented escape hatch (FR-009) — ask for a different name
        // and re-submit. Never silently overwrite the owner's own template.
        setForkRename({
          templateId: template.id,
          originalName: name ?? template.name,
        });
        return;
      }
      toast.danger({
        id: "ticket-type-template-customise-failed",
        title: String(t("admin.ttTplCustomiseFailed")),
        message: formatErrorMessage(error, t),
      });
    } finally {
      setForkingTemplateId(null);
    }
  };

  const isApplying = applyMutation.isPending;
  const hasCatalogue = packs.length > 0;
  const isEmpty = ownTemplates.length === 0 && !hasCatalogue;

  const rowInteractionProps = (templateId: string) =>
    ({
      role: "radio",
      "aria-checked": selectedId === templateId,
      tabIndex: 0,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setSelectedId(templateId);
        }
      },
    }) as Record<string, unknown>;

  const rowFrameProps = (templateId: string) => {
    const isSelected = selectedId === templateId;
    return {
      paddingVertical: 10,
      paddingHorizontal: 12,
      gap: 12,
      alignItems: "center",
      borderWidth: 1,
      borderColor: isSelected ? "$borderColorStrong" : "$borderColor",
      borderLeftWidth: 4,
      borderLeftColor: isSelected ? "$accent" : "$borderColorSoft",
      backgroundColor: isSelected ? "$surfaceMuted" : "transparent",
      cursor: "pointer",
      hoverStyle: {
        backgroundColor: "$surfaceMuted",
        borderColor: "$borderColorStrong",
      },
      focusStyle: {
        borderColor: "$borderColorStrong",
        backgroundColor: "$surfaceMuted",
      },
      onPress: () => setSelectedId(templateId),
    } as const;
  };

  const catalogueLabels = {
    adjustable: (suggested: string) =>
      String(t("admin.ttTplPreviewAdjustable", { suggested })),
    capacity: (capacity: number) =>
      String(t("admin.ttTplPreviewCapacity", { capacity })),
  };

  const footer = (
    <>
      <Button
        variant="ghost"
        size="$3"
        onPress={onClose}
        disabled={isApplying}
        data-testid="ticket-type-template-apply-cancel"
      >
        {String(t("admin.ttCancel"))}
      </Button>
      <Button
        variant="primary"
        size="$3"
        onPress={() => {
          void handleApply();
        }}
        disabled={!selectedId || isApplying}
        data-testid="ticket-type-template-apply-submit"
      >
        {isApplying
          ? String(t("admin.ttTplApplying"))
          : String(t("admin.ttTplApplyCta"))}
      </Button>
    </>
  );

  return (
    <>
      <EventEditorSheet
        open
        onClose={onClose}
        title={String(t("admin.ttTplApplyDialogTitle"))}
        subtitle={String(t("admin.ttTplApplyDialogSubtitle"))}
        footer={footer}
      >
        <YStack gap={12} data-testid="ticket-type-template-apply-dialog">
          {templatesQuery.isLoading ? (
            <Text variant="caption" tone="muted">
              {String(t("common.loading"))}
            </Text>
          ) : templatesQuery.error ? (
            <YStack gap={8} alignItems="flex-start">
              <Text variant="caption" tone="error">
                {String(t("admin.ttTplListLoadFailed"))}
              </Text>
              <Button
                variant="secondary"
                size="$2"
                onPress={() => {
                  void templatesQuery.refetch();
                }}
              >
                {String(t("admin.retry"))}
              </Button>
            </YStack>
          ) : isEmpty ? (
            <YStack
              padding={24}
              alignItems="center"
              gap={8}
              borderWidth={2}
              borderColor="$borderColor"
              borderStyle="dashed"
              data-testid="ticket-type-template-empty-state"
            >
              <Text variant="body" tone="muted">
                {String(t("admin.ttTplEmptyTitle"))}
              </Text>
              <Text
                variant="caption"
                tone="muted"
                style={{ textAlign: "center" }}
              >
                {String(t("admin.ttTplEmptyMessage"))}
              </Text>
            </YStack>
          ) : (
            <YStack
              gap={16}
              {...({
                role: "radiogroup",
                "aria-label": String(t("admin.ttTplApplyDialogTitle")),
              } as Record<string, unknown>)}
            >
              {/* ── The owner's saved templates ─────────────────────────── */}
              {ownTemplates.length > 0 ? (
                <YStack gap={8}>
                  {hasCatalogue ? (
                    <Text variant="overline" tone="muted">
                      {String(t("admin.ttTplYourSectionTitle"))}
                    </Text>
                  ) : null}
                  {ownTemplates.map((template) => (
                    <XStack
                      key={template.id}
                      {...rowFrameProps(template.id)}
                      data-testid="ticket-type-template-row"
                      // Web-only ARIA/keyboard props — same escape hatch the
                      // EditorCard / EventEditorSheet primitives use.
                      {...rowInteractionProps(template.id)}
                    >
                      <YStack gap={2} flex={1} minWidth={0}>
                        <Text variant="bodySmall" weight="bold" color="$color">
                          {template.name}
                        </Text>
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {String(
                            t("admin.ttTplEntryCount", {
                              count: template.ticketTypes.length,
                            }),
                          )}
                          {" · "}
                          {buildTemplateEntryPreview(
                            template.ticketTypes,
                            formatPrice,
                          )}
                        </Text>
                      </YStack>
                      <Button
                        variant="ghost"
                        size="$2"
                        icon
                        onPress={(e) => {
                          e.stopPropagation();
                          setArchiveTarget({
                            id: template.id,
                            name: template.name,
                          });
                        }}
                        aria-label={String(t("admin.ttTplArchiveLabel"))}
                        data-testid="ticket-type-template-archive-btn"
                      >
                        <Archive size={14} aria-hidden />
                      </Button>
                    </XStack>
                  ))}
                </YStack>
              ) : null}

              {/* ── "From Ithas Fire" — pack catalogue (FR-011) ─────────── */}
              {packs.map((pack) => {
                const packTemplates = platformByPack.get(pack.id) ?? [];
                if (packTemplates.length === 0) return null;
                return (
                  <YStack
                    key={pack.id}
                    gap={8}
                    data-testid={`ticket-pack-section-${pack.key}`}
                  >
                    <YStack gap={2}>
                      <XStack gap={8} alignItems="center" flexWrap="wrap">
                        <Text variant="overline" tone="muted">
                          {pack.name}
                        </Text>
                        <PlatformTemplateTag
                          testId={`ticket-pack-tag-${pack.key}`}
                        />
                      </XStack>
                      {pack.blurb ? (
                        <Text variant="caption" tone="muted">
                          {pack.blurb}
                        </Text>
                      ) : null}
                    </YStack>
                    {packTemplates.map((template) => (
                      <XStack
                        key={template.id}
                        {...rowFrameProps(template.id)}
                        alignItems="flex-start"
                        data-testid="ticket-type-template-platform-row"
                        {...rowInteractionProps(template.id)}
                      >
                        <YStack gap={2} flex={1} minWidth={0}>
                          <Text
                            variant="bodySmall"
                            weight="bold"
                            color="$color"
                          >
                            {template.name}
                          </Text>
                          {template.ticketTypes.map((entry) => (
                            <Text
                              key={entry.name}
                              variant="caption"
                              tone="muted"
                            >
                              {buildCatalogueEntryPreview(
                                entry,
                                formatPrice,
                                catalogueLabels,
                              )}
                            </Text>
                          ))}
                        </YStack>
                        {canCustomise ? (
                          <Button
                            variant="secondary"
                            size="$2"
                            onPress={(e) => {
                              e.stopPropagation();
                              void handleFork(template);
                            }}
                            disabled={forkingTemplateId === template.id}
                            data-testid={`ticket-type-template-customise-${template.id}`}
                          >
                            <Copy size={14} aria-hidden />
                            {String(t("admin.ttTplCustomiseCta"))}
                          </Button>
                        ) : null}
                      </XStack>
                    ))}
                  </YStack>
                );
              })}
            </YStack>
          )}

          {/* Seated events: templates never carry seat sections. */}
          {hasSeatingLayout && !isEmpty ? (
            <XStack gap={6} alignItems="flex-start">
              <Info
                size={12}
                color={theme.colorMuted?.val}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <Text
                variant="caption"
                tone="muted"
                style={{ fontSize: 11 }}
                data-testid="ticket-type-template-seating-note"
              >
                {String(t("admin.ttTplSeatingNote"))}
              </Text>
            </XStack>
          ) : null}
        </YStack>
      </EventEditorSheet>

      <ConfirmDialog
        open={!!archiveTarget}
        onCancel={() => setArchiveTarget(null)}
        onConfirm={() => {
          void handleArchive();
        }}
        title={String(t("admin.ttTplArchiveConfirmTitle"))}
        description={
          t("admin.ttTplArchiveConfirmDescription", {
            name: archiveTarget?.name ?? "",
          }) as string
        }
        confirmLabel={String(t("admin.ttTplArchiveConfirmCta"))}
        cancelLabel={String(t("admin.ttCancel"))}
        loading={archiveMutation.isPending}
      />

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
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Customise name-collision recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The TEMPLATE_NAME_TAKEN escape hatch (spec FR-009): the owner already has
 * a template with the catalogue row's name that is NOT its fork. The server
 * refuses rather than overwrite, and the documented recovery is to re-submit
 * with an explicit name. Mirrors VolunteerTemplatesView's ForkRenameDialog.
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
      t("admin.ttTplCustomiseRenameSuggestion", { name: state.originalName }),
    ),
  );

  const trimmed = name.trim();
  const unchanged = trimmed.toLowerCase() === state.originalName.toLowerCase();

  return (
    <Modal open onClose={onCancel}>
      <Modal.Panel width={460}>
        <Modal.Header
          title={String(t("admin.ttTplCustomiseRenameTitle"))}
          onClose={onCancel}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="body" tone="muted">
              {String(
                t("admin.ttTplCustomiseRenameDescription", {
                  name: state.originalName,
                }),
              )}
            </Text>
            <YStack gap="$1">
              <Text variant="label">{String(t("admin.ttTplNameLabel"))}</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={80}
                fullWidth
                autoFocus
                testId="ticket-type-template-fork-rename-input"
              />
              {unchanged ? (
                <Text variant="caption" tone="error">
                  {String(t("admin.ttTplCustomiseRenameUnchanged"))}
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
            {String(t("admin.ttCancel"))}
          </Button>
          <Button
            variant="primary"
            size="$3"
            onPress={() => void onSubmit(trimmed)}
            disabled={isSaving || trimmed.length === 0 || unchanged}
            data-testid="ticket-type-template-fork-rename-submit"
          >
            {String(t("admin.ttTplCustomiseCta"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
