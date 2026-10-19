"use client";

import { useEffect, useMemo, useState } from "react";
import { YStack, XStack } from "tamagui";
import {
  Modal,
  Button,
  Text,
  useFormatters,
  useTranslations,
  useNotify,
} from "@th/ui";
import { Check } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { PlatformTemplateTag } from "@/components/volunteering/PlatformTemplateTag";
import { shiftAnchorUnavailableMessage } from "@/components/volunteering/ShiftAnchorFields";
import {
  activateKeyProps,
  PICKER_FOCUS_VISIBLE_STYLE,
} from "@/lib/dropdown-keyboard";
import {
  resolveTemplateShift,
  zonedNoonToday,
  type ResolvedTemplateShift,
  type ShiftResolutionTarget,
  type TemplateShiftUnavailableReason,
} from "@/lib/template-shift-offset";

/** Per-role shift drafts handed off from the apply flow to the roles tab. */
export interface SeededTemplateShifts {
  /** When materialized against an event without `startsAt`, the UI used today. */
  fellBackToToday: boolean;
  byRoleId: Record<
    string,
    Array<{
      label: string;
      startsAtIso: string;
      endsAtIso: string;
      capacity: number | null;
    }>
  >;
  /**
   * Presets that could NOT be resolved against this event and were therefore
   * not written — an EVENT_END-anchored preset on an occurrence with no end
   * time, say. They are reported, never guessed at: falling back to another
   * time would invent a shift from a different date and save it as if it were
   * real.
   */
  skipped: Array<{
    roleId: string;
    label: string;
    reason: TemplateShiftUnavailableReason;
  }>;
}

interface FromTemplatesDialogProps {
  open: boolean;
  orgId: string;
  eventId: string;
  /**
   * Event's startsAt — the EVENT_START anchor, and the calendar reference for
   * wall-clock presets.
   *
   * Null means the event genuinely has no start date (the apply flow then falls
   * back to "today" and flags it), never "the event query hasn't answered yet":
   * `RolesTab` only mounts this dialog once `getEventForEdit` has succeeded.
   */
  eventStartsAt: Date | null;
  /**
   * Event's endsAt — the EVENT_END anchor.
   *
   * Nullable on purpose and NOT substitutable: a recurring occurrence may have
   * no end time, and an EVENT_END-anchored preset then has nothing to resolve
   * against. The resolver says so and the row is disabled with the reason
   * rather than borrowing another night's finish time.
   */
  eventEndsAt: Date | null;
  /**
   * Event's IANA timezone (`Event.timezone`) — the zone shift presets resolve
   * in, so an organizer in another timezone still schedules against the venue's
   * wall clock.
   *
   * Non-nullable on purpose. `Event.timezone` is a non-nullable column, so the
   * only way to see a missing zone is an unresolved or failed `getEventForEdit`
   * (`retry: 1`), and `RolesTab` gates both the CTA and this dialog on the query
   * having succeeded. That keeps the browser-zone fallback — which would quietly
   * reintroduce the exact FR-006 bug — from existing at all.
   */
  eventTimezone: string;
  onClose: () => void;
  /** Called after roles + materialized shift drafts are returned. */
  onSuccess: (seededShifts: SeededTemplateShifts) => void;
}

export function FromTemplatesDialog({
  open,
  orgId,
  eventId,
  eventStartsAt,
  eventEndsAt,
  eventTimezone,
  onClose,
  onSuccess,
}: FromTemplatesDialogProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const notify = useNotify();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) setSelected(new Set());
  }, [open]);

  const templatesQuery = trpc.volunteer.templates.list.useQuery(
    { orgId },
    { enabled: open },
  );

  /**
   * The catalogue, purely so this dialog can PREVIEW a platform row's shift
   * presets before the organizer commits.
   *
   * `templates.list` returns rows without their shifts and `getWithShifts`
   * returns null for a platform row, so this is the only read that carries a
   * catalogue role's presets. Org-owned templates have no equivalent batch
   * read; their presets are checked after apply instead (see the mutation's
   * success handler), which is a backstop, not a preview.
   */
  const packsQuery = trpc.volunteerPacks.list.useQuery(
    { orgId },
    { enabled: open, staleTime: 60_000 },
  );

  /**
   * Resolution target for THIS event. `reference` only matters for wall-clock
   * presets; the anchored ones read `startsAt` / `endsAt` directly.
   */
  const target = useMemo<ShiftResolutionTarget>(
    () => ({
      timeZone: eventTimezone,
      reference: eventStartsAt ?? zonedNoonToday(eventTimezone),
      startsAt: eventStartsAt,
      endsAt: eventEndsAt,
    }),
    [eventTimezone, eventStartsAt, eventEndsAt],
  );

  /** Catalogue presets keyed by template id, for the pre-confirm preview. */
  const platformShiftsByTemplateId = useMemo(() => {
    const byId = new Map<
      string,
      Array<{
        label: string;
        startMinuteOfDay: number;
        endMinuteOfDay: number;
        startDayOffset: number;
        endsNextDay: boolean;
        anchor: "WALL_CLOCK" | "EVENT_START" | "EVENT_END";
        offsetMinutes: number;
      }>
    >();
    for (const pack of packsQuery.data ?? []) {
      for (const role of pack.roles) {
        byId.set(role.id, role.shifts);
      }
    }
    return byId;
  }, [packsQuery.data]);

  const createFromTemplates =
    trpc.volunteer.roles.createFromTemplates.useMutation({
      meta: { silent: true },
      onSuccess: (data) => {
        notify.toast.success({
          id: "volunteer-roles-from-templates",
          title: String(t("admin.volunteerRolesCreatedFromTemplates")),
        });
        // Resolve template shift presets into concrete ISO instants, HONOURING
        // THE ANCHOR (FR-017). This must not call `materializeTemplateShift`
        // directly: on an anchored preset `startMinuteOfDay`/`endMinuteOfDay`
        // carry only the DURATION, so wall-clock materialization would read an
        // EVENT_START −180 preset stored as (16:00, 18:30) as "16:00 on the
        // event day" — wrong times, silently, with no error.
        const fellBack = !eventStartsAt;
        const byRoleId: SeededTemplateShifts["byRoleId"] = {};
        const skipped: SeededTemplateShifts["skipped"] = [];
        for (const [roleId, presets] of Object.entries(
          data.templateShiftsByRoleId,
        )) {
          const drafts: SeededTemplateShifts["byRoleId"][string] = [];
          for (const preset of presets) {
            const resolved = resolveTemplateShift(preset, target);
            if (!resolved.ok) {
              // Represented, not guessed. The composer is seeded with the
              // shifts that DO resolve; this one is reported instead.
              skipped.push({
                roleId,
                label: preset.label,
                reason: resolved.reason,
              });
              continue;
            }
            drafts.push({
              label: preset.label,
              startsAtIso: resolved.startsAt,
              endsAtIso: resolved.endsAt,
              capacity: preset.capacity,
            });
          }
          byRoleId[roleId] = drafts;
        }
        onSuccess({ fellBackToToday: fellBack, byRoleId, skipped });
      },
      onError: (err) => {
        notify.toast.danger({
          id: "volunteer-role-save-failed",
          title: String(t("admin.volunteerRoleSaveFailed")),
          message: formatErrorMessage(err, t),
        });
      },
    });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const templates = useMemo(
    () => (templatesQuery.data ?? []).filter((tpl) => !tpl.archived),
    [templatesQuery.data],
  );

  /**
   * Every catalogue preset resolved against THIS event, once per template.
   *
   * Both the per-row preview lines and the blocked-row check read this: the two
   * must agree by construction, and resolving the same presets twice per render
   * is how they would drift.
   */
  const resolutionsByTemplateId = useMemo(() => {
    const byId = new Map<
      string,
      Array<{ label: string; result: ResolvedTemplateShift }>
    >();
    for (const tpl of templates) {
      const presets = platformShiftsByTemplateId.get(tpl.id);
      if (!presets) continue;
      byId.set(
        tpl.id,
        presets.map((preset) => ({
          label: preset.label,
          result: resolveTemplateShift(preset, target),
        })),
      );
    }
    return byId;
  }, [templates, platformShiftsByTemplateId, target]);

  /**
   * Catalogue templates carrying at least one preset that cannot be resolved
   * against THIS event — an EVENT_END-anchored shift on an occurrence with no
   * end time. Applying one would create a role whose schedule silently went
   * missing, so the row is disabled with the reason instead.
   */
  const blockedTemplateIds = useMemo(() => {
    const blocked = new Map<string, TemplateShiftUnavailableReason>();
    for (const [templateId, resolutions] of resolutionsByTemplateId) {
      const failed = resolutions.find((entry) => !entry.result.ok);
      if (failed && !failed.result.ok)
        blocked.set(templateId, failed.result.reason);
    }
    return blocked;
  }, [resolutionsByTemplateId]);

  /**
   * A blocked row can never be checked, but it can become blocked AFTER being
   * checked (the event's end time is cleared in another tab). Filtering at
   * submit is the guarantee — the disabled styling is only the signal.
   */
  const applicableIds = Array.from(selected).filter(
    (id) => !blockedTemplateIds.has(id),
  );

  const handleSubmit = () => {
    if (applicableIds.length === 0) return;
    createFromTemplates.mutate({ eventId, templateIds: applicableIds });
  };

  const formatInstant = (iso: string): string => {
    try {
      return fmt.dateTime(new Date(iso), {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: eventTimezone,
      });
    } catch {
      // Unknown zone id — Intl throws RangeError. Drop the preview line rather
      // than taking the dialog down over a decoration.
      return "";
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={540}>
        <Modal.Header
          title={String(t("admin.volunteerRoleDialogFromTemplatesTitle"))}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="body" tone="muted">
              {String(t("admin.volunteerRoleDialogFromTemplatesDescription"))}
            </Text>

            {templatesQuery.isLoading ? (
              <Text tone="muted">{String(t("admin.loading"))}</Text>
            ) : templatesQuery.isError ? (
              <YStack
                padding="$4"
                borderWidth={1}
                borderColor="$borderColor"
                borderStyle="dashed"
              >
                <Text tone="muted">
                  {String(t("admin.volunteerRoleDialogTemplatesLoadFailed"))}
                </Text>
              </YStack>
            ) : templates.length === 0 ? (
              <YStack
                padding="$4"
                borderWidth={1}
                borderColor="$borderColor"
                borderStyle="dashed"
              >
                <Text tone="muted">
                  {String(t("admin.volunteerRoleDialogNoTemplates"))}
                </Text>
              </YStack>
            ) : (
              <YStack gap="$2" maxHeight={360} overflow="scroll">
                {templates.map((tpl) => {
                  const resolutions = resolutionsByTemplateId.get(tpl.id) ?? [];
                  const blockedReason = blockedTemplateIds.get(tpl.id) ?? null;
                  const isSelected = selected.has(tpl.id) && !blockedReason;

                  return (
                    <XStack
                      key={tpl.id}
                      gap="$3"
                      padding="$3"
                      borderWidth={1}
                      borderColor={
                        blockedReason
                          ? "$borderColorSoft"
                          : isSelected
                            ? "$brandSecondary"
                            : "$borderColor"
                      }
                      alignItems="flex-start"
                      cursor={blockedReason ? "not-allowed" : "pointer"}
                      opacity={blockedReason ? 0.6 : 1}
                      onPress={blockedReason ? undefined : () => toggle(tpl.id)}
                      // A tabIndex with no focus ring is an invisible focus
                      // trap (see `dropdown-keyboard.ts`).
                      focusVisibleStyle={PICKER_FOCUS_VISIBLE_STYLE}
                      data-testid={`volunteer-template-option-${tpl.id}`}
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-disabled={blockedReason ? true : undefined}
                      // Blocked rows stay REACHABLE: `tabIndex={-1}` hides the
                      // row — and with it the stated reason it can't be used —
                      // from anyone navigating by keyboard. "Disabled but
                      // discoverable" is `aria-disabled` plus an inert handler.
                      tabIndex={0}
                      {...(activateKeyProps(() => {
                        if (blockedReason) return;
                        toggle(tpl.id);
                      }) as object)}
                    >
                      <YStack
                        width={24}
                        height={24}
                        borderWidth={2}
                        borderColor={
                          isSelected ? "$brandSecondary" : "$borderColor"
                        }
                        backgroundColor={
                          isSelected ? "$brandSecondary" : "transparent"
                        }
                        alignItems="center"
                        justifyContent="center"
                        flexShrink={0}
                      >
                        {isSelected ? (
                          <Check
                            size={14}
                            color="var(--onBrandSecondary, #FFFFFF)"
                          />
                        ) : null}
                      </YStack>
                      <YStack flex={1} gap="$1">
                        <XStack gap="$2" alignItems="center" flexWrap="wrap">
                          <Text
                            variant="body"
                            style={{
                              fontWeight: 600,
                              textTransform: "uppercase",
                            }}
                          >
                            {tpl.name}
                          </Text>
                          {tpl.isPlatform ? <PlatformTemplateTag /> : null}
                        </XStack>
                        {tpl.description ? (
                          <Text variant="caption" tone="muted">
                            {tpl.description}
                          </Text>
                        ) : null}

                        {/* Concrete resolved times, so a wrong anchor is
                            visible BEFORE the roles are created. */}
                        {resolutions.map((entry, index) =>
                          entry.result.ok ? (
                            <Text
                              key={`${tpl.id}-${index}`}
                              variant="caption"
                              tone="muted"
                              style={{ fontVariantNumeric: "tabular-nums" }}
                              data-testid={`volunteer-template-option-${tpl.id}-shift-${index}`}
                            >
                              {`${entry.label} · ${formatInstant(
                                entry.result.startsAt,
                              )} → ${formatInstant(entry.result.endsAt)}`}
                            </Text>
                          ) : null,
                        )}

                        {blockedReason ? (
                          <Text
                            variant="caption"
                            tone="error"
                            data-testid={`volunteer-template-option-${tpl.id}-blocked`}
                          >
                            {shiftAnchorUnavailableMessage(t, blockedReason)}
                          </Text>
                        ) : null}
                      </YStack>
                      {tpl.defaultCapacity != null ? (
                        <Text variant="caption" tone="muted">
                          {tpl.defaultCapacity}
                        </Text>
                      ) : null}
                    </XStack>
                  );
                })}
              </YStack>
            )}
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <XStack gap="$2" justifyContent="flex-end">
            <Button
              variant="ghost"
              onPress={onClose}
              disabled={createFromTemplates.isPending}
            >
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={
                applicableIds.length === 0 || createFromTemplates.isPending
              }
            >
              {String(t("admin.volunteerRoleDialogFromTemplatesCta"))}
            </Button>
          </XStack>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
