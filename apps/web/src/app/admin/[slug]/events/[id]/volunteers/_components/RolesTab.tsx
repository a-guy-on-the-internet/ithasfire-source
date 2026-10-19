"use client";

import { useState } from "react";
import { YStack, XStack, styled } from "tamagui";
import {
  Button,
  Text,
  Badge,
  useTranslations,
  useFormatters,
  useNotify,
} from "@th/ui";
import { Pencil, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";

import { RoleDialog, type RoleDialogInitial } from "./RoleDialog";
import { ShiftDialog, type ShiftDialogInitial } from "./ShiftDialog";
import {
  FromTemplatesDialog,
  type SeededTemplateShifts,
} from "./FromTemplatesDialog";
import { InlineShiftComposer } from "./InlineShiftComposer";

type RoleDialogState =
  | null
  | { mode: "create" }
  | { mode: "edit"; id: string; initial: RoleDialogInitial };

type ShiftDialogState =
  | null
  | { mode: "create"; roleId: string }
  | { mode: "edit"; id: string; roleId: string; initial: ShiftDialogInitial };

const RoleCard = styled(YStack, {
  name: "VolunteerRoleCard",
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  padding: "$4",
  gap: "$3",
});

function capacityTone(
  filled: number,
  cap: number | null,
): "info" | "success" | "warning" | "danger" {
  if (cap === null) return "info";
  if (cap <= 0) return "info";
  const pct = filled / cap;
  if (pct >= 1) return "danger";
  if (pct >= 0.9) return "warning";
  return "success";
}

interface RolesTabProps {
  eventId: string;
  orgId: string | null;
}

export function RolesTab({ eventId, orgId }: RolesTabProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const notify = useNotify();
  const utils = trpc.useUtils();

  const [roleDialog, setRoleDialog] = useState<RoleDialogState>(null);
  const [shiftDialog, setShiftDialog] = useState<ShiftDialogState>(null);
  const [fromTemplatesOpen, setFromTemplatesOpen] = useState(false);
  const [expandedRoleIds, setExpandedRoleIds] = useState<Set<string>>(
    new Set(),
  );
  const [deleteRoleTarget, setDeleteRoleTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteShiftTarget, setDeleteShiftTarget] = useState<{
    id: string;
  } | null>(null);
  /**
   * Per-role seed shifts handed back from the apply-template flow. The
   * `InlineShiftComposer` reads its slot once on mount, populating the
   * draft rows so the organizer can review + save (or discard).
   */
  const [seededTemplateShifts, setSeededTemplateShifts] = useState<
    SeededTemplateShifts["byRoleId"]
  >({});

  const rolesQuery = trpc.volunteer.roles.list.useQuery({ eventId });
  const countsQuery = trpc.volunteer.signups.counts.useQuery({ eventId });
  const eventQuery = trpc.events.getEventForEdit.useQuery(
    { eventId },
    { staleTime: 10_000, retry: 1, enabled: Boolean(eventId) },
  );

  const invalidate = () =>
    Promise.all([
      utils.volunteer.roles.list.invalidate(),
      utils.volunteer.signups.counts.invalidate(),
    ]);

  const deleteRoleMutation = trpc.volunteer.roles.delete.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-role-deleted",
        title: String(t("admin.volunteerRoleDeleted")),
      });
      void invalidate();
      setDeleteRoleTarget(null);
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-role-delete-failed",
        title: String(t("admin.volunteerRoleDeleteFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const deleteShiftMutation = trpc.volunteer.shifts.delete.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-shift-deleted",
        title: String(t("admin.volunteerShiftDeleted")),
      });
      void invalidate();
      setDeleteShiftTarget(null);
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-shift-delete-failed",
        title: String(t("admin.volunteerShiftDeleteFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const roles = rolesQuery.data ?? [];
  const counts = countsQuery.data;

  /**
   * Capacity badge copy: accepted-vs-capacity is the primary figure
   * (capacity governs accepted signups only), with a pending suffix when
   * applicants are still awaiting review — e.g. "4 of 4 filled · 1 pending".
   */
  const capacityLabel = (
    accepted: number,
    pending: number,
    cap: number | null,
  ) => {
    const base =
      cap !== null
        ? String(
            t("admin.volunteerRoleCapacitySummary", { filled: accepted, cap }),
          )
        : String(t("admin.volunteerRoleCapacityOpen", { filled: accepted }));
    if (pending <= 0) return base;
    return `${base} · ${String(
      t("admin.volunteerRoleCapacityPendingSuffix", { pending }),
    )}`;
  };
  const eventStartsAt = eventQuery.data?.startsAt ?? null;
  const eventEndsAt = eventQuery.data?.endsAt ?? null;
  /**
   * IANA zone the event runs in — template shift presets resolve against it.
   *
   * `Event.timezone` is a non-nullable column, so null here means one thing
   * only: `eventQuery` hasn't succeeded (still in flight, or exhausted its
   * `retry: 1`). It therefore doubles as the "event loaded" flag that gates the
   * apply-from-templates flow below, which is what lets `FromTemplatesDialog`
   * take a non-nullable zone with no browser-zone fallback. The same coupling
   * is what makes its `fellBackToToday` warning trustworthy: `eventStartsAt`
   * can only be null for an event that really has no start date once we know
   * the query answered.
   */
  const eventTimezone = eventQuery.data?.timezone ?? null;

  const toggleExpanded = (roleId: string) => {
    setExpandedRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const isLoading = rolesQuery.isLoading;

  return (
    <YStack gap="$4">
      {/* Add role toolbar */}
      <XStack gap="$2" flexWrap="wrap" justifyContent="flex-end">
        {orgId ? (
          <Button
            variant="secondary"
            onPress={() => setFromTemplatesOpen(true)}
            // Applying a template resolves its shift presets in the event's
            // timezone, so the flow can't start before `getEventForEdit` has
            // answered. Disabled rather than fallback-resolved: guessing a zone
            // is what FR-006 removed.
            disabled={eventTimezone == null}
            data-testid="volunteer-roles-from-template-cta"
          >
            <Plus size={16} aria-hidden />
            {String(t("admin.volunteerRolesFromTemplateCta"))}
          </Button>
        ) : null}
        <Button
          variant="primary"
          onPress={() => setRoleDialog({ mode: "create" })}
          data-testid="volunteer-roles-custom-cta"
        >
          <Plus size={16} aria-hidden />
          {String(t("admin.volunteerRolesCustomCta"))}
        </Button>
      </XStack>

      {isLoading ? (
        <YStack paddingVertical="$6" alignItems="center">
          <Text tone="muted">{String(t("admin.loading"))}</Text>
        </YStack>
      ) : roles.length === 0 ? (
        <YStack
          alignItems="center"
          gap="$3"
          paddingVertical="$8"
          borderWidth={1}
          borderColor="$borderColor"
          borderStyle="dashed"
          padding="$6"
        >
          <Text
            variant="h4"
            style={{ textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            {String(t("admin.volunteerRolesEmptyTitle"))}
          </Text>
          <Text tone="muted" style={{ textAlign: "center" }}>
            {String(t("admin.volunteerRolesEmptyDescription"))}
          </Text>
          <Button
            variant="primary"
            onPress={() => setRoleDialog({ mode: "create" })}
          >
            <Plus size={16} aria-hidden />
            {String(t("admin.volunteerRolesCustomCta"))}
          </Button>
        </YStack>
      ) : (
        <YStack gap="$3">
          {roles.map((role) => {
            // `byRole` is pending-inclusive; `acceptedByRole` is
            // APPROVED + CHECKED_IN only (zero entries omitted).
            const accepted = counts?.acceptedByRole?.[role.id] ?? 0;
            const pending = Math.max(
              0,
              (counts?.byRole[role.id] ?? 0) - accepted,
            );
            const tone = capacityTone(accepted, role.capacity);
            const isExpanded = expandedRoleIds.has(role.id);
            return (
              <RoleCard key={role.id}>
                <XStack
                  gap="$3"
                  alignItems="flex-start"
                  justifyContent="space-between"
                  flexWrap="wrap"
                >
                  <YStack flex={1} minWidth={240} gap="$2">
                    <XStack gap="$2" alignItems="center" flexWrap="wrap">
                      <Text variant="h4" style={{ textTransform: "uppercase" }}>
                        {role.name}
                      </Text>
                      {role.autoApprove === true ? (
                        <Badge tone="info" size="sm">
                          {String(t("admin.volunteerRoleAutoApproveOn"))}
                        </Badge>
                      ) : role.autoApprove === false ? (
                        <Badge tone="neutral" size="sm">
                          {String(t("admin.volunteerRoleAutoApproveOff"))}
                        </Badge>
                      ) : null}
                    </XStack>
                    {role.description ? (
                      <Text variant="body" tone="muted">
                        {role.description}
                      </Text>
                    ) : null}
                    <XStack gap="$2" alignItems="center">
                      <Badge tone={tone} size="sm">
                        {capacityLabel(accepted, pending, role.capacity)}
                      </Badge>
                    </XStack>
                  </YStack>
                  <XStack gap="$2" flexWrap="wrap">
                    <Button
                      variant="ghost"
                      size="$2"
                      onPress={() =>
                        setRoleDialog({
                          mode: "edit",
                          id: role.id,
                          initial: {
                            name: role.name,
                            description: role.description,
                            capacity: role.capacity,
                            autoApprove: role.autoApprove,
                          },
                        })
                      }
                      aria-label={String(t("common.edit"))}
                    >
                      <Pencil size={16} aria-hidden />
                      {String(t("common.edit"))}
                    </Button>
                    <Button
                      variant="ghost"
                      size="$2"
                      onPress={() =>
                        setDeleteRoleTarget({ id: role.id, name: role.name })
                      }
                      aria-label={String(t("common.delete"))}
                    >
                      <Trash2 size={16} aria-hidden />
                      {String(t("common.delete"))}
                    </Button>
                  </XStack>
                </XStack>

                {/* Shifts section */}
                <YStack
                  gap="$2"
                  borderTopWidth={1}
                  borderTopColor="$borderColor"
                  paddingTop="$3"
                >
                  <XStack justifyContent="space-between" alignItems="center">
                    <Button
                      variant="ghost"
                      size="$2"
                      onPress={() => toggleExpanded(role.id)}
                    >
                      {isExpanded ? (
                        <ChevronDown size={16} aria-hidden />
                      ) : (
                        <ChevronRight size={16} aria-hidden />
                      )}
                      {role.shifts.length > 0
                        ? String(
                            t("admin.volunteerShiftCount", {
                              count: role.shifts.length,
                            }),
                          )
                        : String(t("admin.volunteerShiftEmpty"))}
                    </Button>
                  </XStack>

                  <InlineShiftComposer
                    roleId={role.id}
                    eventStartsAt={eventStartsAt}
                    eventEndsAt={eventEndsAt}
                    eventTimezone={eventTimezone}
                    seedDrafts={seededTemplateShifts[role.id]}
                    onSeedConsumed={() =>
                      setSeededTemplateShifts((prev) => {
                        if (!(role.id in prev)) return prev;
                        const next = { ...prev };
                        delete next[role.id];
                        return next;
                      })
                    }
                    onCreated={() => {
                      void invalidate();
                    }}
                  />

                  {isExpanded && role.shifts.length > 0 ? (
                    <YStack gap="$2" paddingTop="$2">
                      {role.shifts.map((shift) => {
                        // `byShift` is pending-inclusive and nested by role;
                        // `acceptedByShift` is flat by shiftId, accepted only.
                        const shiftAccepted =
                          counts?.acceptedByShift?.[shift.id] ?? 0;
                        const shiftPending = Math.max(
                          0,
                          (counts?.byShift[role.id]?.[shift.id] ?? 0) -
                            shiftAccepted,
                        );
                        const shiftTone = capacityTone(
                          shiftAccepted,
                          shift.capacity,
                        );
                        const shiftDateRange = `${fmt.dateTime(shift.startsAt)} → ${fmt.dateTime(
                          shift.endsAt,
                        )}`;
                        return (
                          <XStack
                            key={shift.id}
                            gap="$3"
                            alignItems="center"
                            justifyContent="space-between"
                            borderWidth={1}
                            borderColor="$borderColor"
                            padding="$3"
                            flexWrap="wrap"
                          >
                            <YStack gap="$1" flex={1} minWidth={200}>
                              <Text variant="body" style={{ fontWeight: 600 }}>
                                {shift.label ?? shiftDateRange}
                              </Text>
                              {shift.label ? (
                                <Text variant="caption" tone="muted">
                                  {shiftDateRange}
                                </Text>
                              ) : null}
                            </YStack>
                            <Badge tone={shiftTone} size="sm">
                              {capacityLabel(
                                shiftAccepted,
                                shiftPending,
                                shift.capacity,
                              )}
                            </Badge>
                            <XStack gap="$2">
                              <Button
                                variant="ghost"
                                size="$2"
                                onPress={() =>
                                  setShiftDialog({
                                    mode: "edit",
                                    id: shift.id,
                                    roleId: role.id,
                                    initial: {
                                      label: shift.label,
                                      startsAt: shift.startsAt,
                                      endsAt: shift.endsAt,
                                      capacity: shift.capacity,
                                      notes: shift.notes,
                                    },
                                  })
                                }
                                icon
                                aria-label={String(t("common.edit"))}
                              >
                                <Pencil size={14} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="$2"
                                onPress={() =>
                                  setDeleteShiftTarget({ id: shift.id })
                                }
                                icon
                                aria-label={String(t("common.delete"))}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </XStack>
                          </XStack>
                        );
                      })}
                    </YStack>
                  ) : null}
                </YStack>
              </RoleCard>
            );
          })}
        </YStack>
      )}

      {/* Dialogs */}
      {roleDialog ? (
        <RoleDialog
          key={roleDialog.mode === "edit" ? `edit-${roleDialog.id}` : "create"}
          mode={roleDialog.mode}
          eventId={eventId}
          roleId={roleDialog.mode === "edit" ? roleDialog.id : undefined}
          initial={roleDialog.mode === "edit" ? roleDialog.initial : undefined}
          onClose={() => setRoleDialog(null)}
          onSuccess={() => {
            void invalidate();
            setRoleDialog(null);
          }}
        />
      ) : null}

      {shiftDialog ? (
        <ShiftDialog
          key={
            shiftDialog.mode === "edit"
              ? `edit-${shiftDialog.id}`
              : `create-${shiftDialog.roleId}`
          }
          mode={shiftDialog.mode}
          roleId={shiftDialog.roleId}
          shiftId={shiftDialog.mode === "edit" ? shiftDialog.id : undefined}
          initial={
            shiftDialog.mode === "edit" ? shiftDialog.initial : undefined
          }
          onClose={() => setShiftDialog(null)}
          onSuccess={() => {
            void invalidate();
            setShiftDialog(null);
          }}
        />
      ) : null}

      {/*
        `eventTimezone != null` is the "event query succeeded" gate — see the
        comment on its declaration. Without it the dialog would need a
        browser-zone fallback, which is the FR-006 bug wearing a hat.
      */}
      {orgId && eventTimezone != null ? (
        <FromTemplatesDialog
          open={fromTemplatesOpen}
          orgId={orgId}
          eventId={eventId}
          eventStartsAt={eventStartsAt ?? null}
          // Nullable and NOT substituted: a recurring occurrence may have no
          // end time, and an EVENT_END-anchored preset then has nothing to
          // resolve against. The dialog disables that row with a reason.
          eventEndsAt={eventEndsAt ?? null}
          eventTimezone={eventTimezone}
          onClose={() => setFromTemplatesOpen(false)}
          onSuccess={(seeded) => {
            setSeededTemplateShifts((prev) => ({
              ...prev,
              ...seeded.byRoleId,
            }));
            // Auto-expand any newly-seeded roles so the composer
            // is visible right after apply — otherwise the seeded
            // drafts are out of sight inside collapsed sections.
            setExpandedRoleIds((prev) => {
              const next = new Set(prev);
              for (const roleId of Object.keys(seeded.byRoleId)) {
                next.add(roleId);
              }
              return next;
            });
            if (seeded.fellBackToToday) {
              notify.toast.warning({
                id: "volunteer-template-shifts-fell-back-to-today",
                title: String(
                  t("admin.volunteerTemplateShiftsFellBackToTodayTitle"),
                ),
                message: String(
                  t("admin.volunteerTemplateShiftsFellBackToTodayMessage"),
                ),
              });
            }
            // Presets that couldn't be anchored against this event were NOT
            // written. Say so by name — silently dropping a shift is the
            // failure mode the anchor work exists to remove.
            if (seeded.skipped.length > 0) {
              notify.toast.warning({
                id: "volunteer-template-shifts-skipped",
                title: String(
                  t("admin.volunteerTemplateShiftsSkippedTitle", {
                    count: seeded.skipped.length,
                  }),
                ),
                message: seeded.skipped.map((entry) => entry.label).join(", "),
              });
            }
            void invalidate();
            setFromTemplatesOpen(false);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleteRoleTarget !== null}
        tone="danger"
        title={String(t("admin.volunteerRoleDeleteConfirmTitle"))}
        description={String(t("admin.volunteerRoleDeleteConfirmDescription"))}
        confirmLabel={String(t("admin.volunteerRoleDeleteConfirmCta"))}
        loading={deleteRoleMutation.isPending}
        onConfirm={() => {
          if (!deleteRoleTarget) return;
          deleteRoleMutation.mutate({ id: deleteRoleTarget.id });
        }}
        onCancel={() => setDeleteRoleTarget(null)}
      />

      <ConfirmDialog
        open={deleteShiftTarget !== null}
        tone="danger"
        title={String(t("admin.volunteerShiftDeleteConfirmTitle"))}
        description={String(t("admin.volunteerShiftDeleteConfirmDescription"))}
        confirmLabel={String(t("common.delete"))}
        loading={deleteShiftMutation.isPending}
        onConfirm={() => {
          if (!deleteShiftTarget) return;
          deleteShiftMutation.mutate({ id: deleteShiftTarget.id });
        }}
        onCancel={() => setDeleteShiftTarget(null)}
      />
    </YStack>
  );
}
