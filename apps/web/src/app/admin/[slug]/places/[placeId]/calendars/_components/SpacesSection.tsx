"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import { DoorOpen, Plus } from "lucide-react";
import {
  Badge,
  Button,
  LabeledTextInput,
  Spinner,
  Text,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  getBlockingCalendars,
  joinCalendarNames,
} from "@/lib/calendar-space-error";

import { isLastActiveSpace, type SpaceRow } from "./venue-calendars-helpers";

export interface SpacesSectionProps {
  placeId: string;
}

/**
 * The place's physical spaces — the unit of availability conflicts (never a
 * public surface). List + add + rename + retire/reactivate. Retiring the last
 * ACTIVE space is disabled with an inline reason; the server enforces the same
 * invariant (CANNOT_RETIRE_LAST_ACTIVE_SPACE), so a raced click still surfaces
 * a real error instead of silently breaking the place.
 *
 * The second invariant — no CALENDAR of this place may be left with zero
 * active spaces (owner ruling 2026-09-23) — cannot be pre-disabled from this
 * section: it depends on the calendar/space joins, which live in
 * CalendarsSection's query. So the Retire button stays live and the server
 * refusal carries the answer: `CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR`
 * names the blocking calendars in its `meta`, and the toast prints them
 * instead of a generic failure.
 */
export function SpacesSection({ placeId }: SpacesSectionProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const query = trpc.places.listSpaces.useQuery({
    placeId,
    includeRetired: true,
  });
  const spaces: SpaceRow[] = query.data ?? [];

  const [newName, setNewName] = useState("");
  const [newCapacity, setNewCapacity] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCapacity, setEditCapacity] = useState("");

  const refresh = () => {
    void utils.places.listSpaces.invalidate({ placeId });
    // Space status feeds the calendars' "no active spaces" chip.
    void utils.places.listCalendars.invalidate({ placeId });
  };

  const onError = (err: unknown) => {
    // Named-calendar refusal first; everything else falls back to the
    // catalog sentence for the code.
    const blocking = getBlockingCalendars(err);
    toast.danger({
      id: "spaces-update-failed",
      title: String(t("admin.calMgrSpaceUpdateFailed")),
      message: blocking
        ? String(
            t("admin.calMgrRetireBlockedByCalendars", {
              count: blocking.length,
              names: joinCalendarNames(
                blocking.map((calendar) => calendar.name),
                locale,
              ),
            }),
          )
        : formatErrorMessage(err, t),
    });
  };

  const create = trpc.places.createSpace.useMutation({
    onSuccess: () => {
      refresh();
      setNewName("");
      setNewCapacity("");
    },
    onError,
  });
  const update = trpc.places.updateSpace.useMutation({
    onSuccess: () => {
      refresh();
      setEditingId(null);
    },
    onError,
  });
  const setStatus = trpc.places.setSpaceStatus.useMutation({
    onSuccess: () => refresh(),
    onError,
  });

  const busy = create.isPending || update.isPending || setStatus.isPending;

  /** "1200" → 1200, "" → null, junk → undefined (blocks the save). */
  const parseCapacity = (value: string): number | null | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    return n > 0 && n <= 200_000 ? n : undefined;
  };

  const startEdit = (space: SpaceRow) => {
    setEditingId(space.id);
    setEditName(space.name);
    setEditCapacity(space.capacity == null ? "" : String(space.capacity));
  };

  const saveEdit = (space: SpaceRow) => {
    const name = editName.trim();
    const capacity = parseCapacity(editCapacity);
    if (!name || capacity === undefined) return;
    update.mutate({
      placeId,
      spaceId: space.id,
      patch: { name, capacity },
    });
  };

  const handleAdd = () => {
    const name = newName.trim();
    const capacity = parseCapacity(newCapacity);
    if (!name || capacity === undefined) return;
    create.mutate({
      placeId,
      name,
      ...(capacity === null ? {} : { capacity }),
    });
  };

  return (
    <YStack gap="$3" testID="spaces-section">
      <XStack gap="$2" alignItems="center">
        <DoorOpen size={18} color="var(--color, #211C16)" />
        <Text variant="h4" weight="bold">
          {String(t("admin.calMgrSpacesTitle"))}
        </Text>
      </XStack>
      <Text variant="bodySmall" tone="muted">
        {String(t("admin.calMgrSpacesHelp"))}
      </Text>

      {query.isPending ? (
        <XStack paddingVertical="$4" justifyContent="center">
          <Spinner size="sm" />
        </XStack>
      ) : query.error ? (
        /* A failed read must NOT render as "no spaces" with a live add form —
           an owner who re-adds a space over a transient error ends up with a
           duplicate once it clears. */
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {formatErrorMessage(query.error, t)}
          </Text>
          <XStack>
            <Button
              variant="secondary"
              size="$2"
              onPress={() => void query.refetch()}
            >
              {String(t("admin.placesRetry"))}
            </Button>
          </XStack>
        </YStack>
      ) : (
        <YStack borderWidth={2} borderColor="$borderColor">
          {spaces.map((space, index) => {
            const retired = space.status === "RETIRED";
            const lastActive = isLastActiveSpace(spaces, space.id);
            const editing = editingId === space.id;

            return (
              <YStack
                key={space.id}
                gap="$2"
                padding="$3"
                borderTopWidth={index === 0 ? 0 : 1}
                borderTopColor="$borderColor"
                opacity={retired ? 0.55 : 1}
                testID={`space-row-${space.id}`}
              >
                <XStack gap="$3" alignItems="center" flexWrap="wrap">
                  {editing ? (
                    <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
                      <LabeledTextInput
                        name={`space-name-${space.id}`}
                        label={String(t("admin.calMgrSpaceNameLabel"))}
                        value={editName}
                        maxLength={140}
                        onChangeText={setEditName}
                      />
                      <LabeledTextInput
                        name={`space-capacity-${space.id}`}
                        label={String(t("admin.calMgrSpaceCapacityLabel"))}
                        value={editCapacity}
                        inputMode="numeric"
                        onChangeText={setEditCapacity}
                      />
                      <Button
                        variant="primary"
                        size="$2"
                        disabled={busy || !editName.trim()}
                        onPress={() => saveEdit(space)}
                        aria-label={`${String(t("admin.calMgrSpaceSave"))} — ${space.name}`}
                      >
                        {String(t("admin.calMgrSpaceSave"))}
                      </Button>
                      <Button
                        variant="ghost"
                        size="$2"
                        disabled={busy}
                        onPress={() => setEditingId(null)}
                        aria-label={`${String(t("common.cancel"))} — ${space.name}`}
                      >
                        {String(t("common.cancel"))}
                      </Button>
                    </XStack>
                  ) : (
                    <>
                      <Text variant="body" weight="bold">
                        {space.name}
                      </Text>
                      {space.capacity != null && (
                        <Text variant="bodySmall" tone="muted">
                          {String(
                            t("admin.calMgrCapacityDisplay", {
                              count: space.capacity,
                            }),
                          )}
                        </Text>
                      )}
                      {retired && (
                        <Badge tone="neutral" size="sm">
                          {String(t("admin.calMgrRetiredBadge"))}
                        </Badge>
                      )}
                      <XStack
                        gap="$2"
                        alignItems="center"
                        marginLeft="auto"
                        flexWrap="wrap"
                      >
                        {!retired && (
                          <Button
                            variant="ghost"
                            size="$2"
                            disabled={busy}
                            onPress={() => startEdit(space)}
                            aria-label={`${String(t("admin.calMgrSpaceRename"))} — ${space.name}`}
                          >
                            {String(t("admin.calMgrSpaceRename"))}
                          </Button>
                        )}
                        {retired ? (
                          <Button
                            variant="secondary"
                            size="$2"
                            disabled={busy}
                            onPress={() =>
                              setStatus.mutate({
                                placeId,
                                spaceId: space.id,
                                status: "ACTIVE",
                              })
                            }
                            aria-label={`${String(t("admin.calMgrReactivate"))} — ${space.name}`}
                          >
                            {String(t("admin.calMgrReactivate"))}
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="$2"
                            disabled={busy || lastActive}
                            onPress={() =>
                              setStatus.mutate({
                                placeId,
                                spaceId: space.id,
                                status: "RETIRED",
                              })
                            }
                            aria-label={`${String(t("admin.calMgrRetire"))} — ${space.name}`}
                            testID={`space-retire-${space.id}`}
                          >
                            {String(t("admin.calMgrRetire"))}
                          </Button>
                        )}
                      </XStack>
                    </>
                  )}
                </XStack>
                {lastActive && !editing && (
                  <Text variant="caption" tone="muted">
                    {String(t("admin.calMgrLastActiveSpaceHint"))}
                  </Text>
                )}
              </YStack>
            );
          })}
        </YStack>
      )}

      {/* No add form while the list read is failing: adding against an
          unknown current state is how duplicate spaces happen. */}
      {!query.error && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderStyle="dashed"
          borderColor="$borderColor"
        >
          <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
            <LabeledTextInput
              name="new-space-name"
              label={String(t("admin.calMgrSpaceNameLabel"))}
              value={newName}
              maxLength={140}
              onChangeText={setNewName}
            />
            <LabeledTextInput
              name="new-space-capacity"
              label={String(t("admin.calMgrSpaceCapacityLabel"))}
              value={newCapacity}
              inputMode="numeric"
              onChangeText={setNewCapacity}
            />
            {/* Secondary on purpose: the page's one primary action is
              "Create calendar" (one primary per viewport). */}
            <Button
              variant="secondary"
              size="$3"
              disabled={busy || !newName.trim()}
              onPress={handleAdd}
              aria-label={String(t("admin.calMgrAddSpace"))}
              testID="space-add"
            >
              <XStack gap="$1" alignItems="center">
                <Plus size={15} />
                <Text variant="bodySmall" weight="bold" tone="inherit">
                  {String(t("admin.calMgrAddSpace"))}
                </Text>
              </XStack>
            </Button>
          </XStack>
        </YStack>
      )}
    </YStack>
  );
}
