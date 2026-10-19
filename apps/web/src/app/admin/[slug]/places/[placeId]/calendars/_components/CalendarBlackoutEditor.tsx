"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import { Lock, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  LabeledTextInput,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import { AvailabilityScopeLine } from "./AvailabilityScopeLine";
import {
  MAX_BLACKOUT_RANGE_DAYS,
  blackoutCreateFields,
  blackoutRowsForScope,
  expandDateRange,
  parseDateInput,
  type AvailabilityRow,
  type AvailabilityScope,
} from "./venue-calendars-helpers";

export interface CalendarBlackoutEditorProps {
  placeId: string;
  /** `null` = the place-wide "All calendars" scope. */
  scope: AvailabilityScope;
  /** Visible name of the selected scope, for accessible labels. */
  scopeLabel: string;
}

const BLACKOUT_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
};

/**
 * One-off closures — holidays, maintenance, a private hire — for one
 * availability scope. A blackout added under "All calendars" is ONE
 * place-wide row (`calendarId: null`) that closes every calendar; it also
 * shows chip-marked when a specific calendar is selected, because hiding it
 * there would make that calendar look open on a dark night.
 *
 * The `note` is the venue's own record and never reaches a public read, so
 * the UI says so plainly — an owner who thinks the note is published will
 * stop writing useful ones.
 */
export function CalendarBlackoutEditor({
  placeId,
  scope,
  scopeLabel,
}: CalendarBlackoutEditorProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // App-locale date rendering (never Intl with an undefined locale — the
  // server and the browser may disagree, and es users would see en dates).
  const formatDate = (date: Date) => fmt.dateTime(date, BLACKOUT_DATE_FORMAT);

  const query = trpc.places.listCalendarAvailability.useQuery({ placeId });
  const rows = blackoutRowsForScope<AvailabilityRow>(query.data ?? [], scope);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A blackout is a CalendarAvailability row too, so it counts for the
  // availability-onboarding detector — keep both reads moving together.
  const refresh = () =>
    Promise.all([
      utils.places.listCalendarAvailability.invalidate({ placeId }),
      utils.places.getAvailabilitySetupState.invalidate({ placeId }),
    ]);

  const onError = (err: unknown) => {
    toast.danger({
      id: "calendar-blackout-failed",
      title: String(t("admin.peBlackoutUpdateFailed")),
      message: formatErrorMessage(err, t),
    });
  };

  const upsert = trpc.places.upsertCalendarAvailability.useMutation({
    // The form clears on SUCCESS only — a failed add keeps the owner's typed
    // dates/note in place for a retry instead of silently discarding them.
    onSuccess: () => {
      void refresh();
      setFrom("");
      setTo("");
      setNote("");
    },
    onError,
  });
  const remove = trpc.places.deleteCalendarAvailability.useMutation({
    onSuccess: () => void refresh(),
    onError,
  });

  const busy = upsert.isPending || remove.isPending;

  const handleAdd = () => {
    const start = parseDateInput(from);
    if (!start) {
      setError(String(t("admin.peBlackoutErrorNoDate")));
      return;
    }

    // A single date is just a range of one; expanding keeps one code path.
    const dates = to ? expandDateRange(from, to) : [start];
    if (dates.length === 0) {
      setError(
        String(
          t("admin.peBlackoutErrorRange", { max: MAX_BLACKOUT_RANGE_DAYS }),
        ),
      );
      return;
    }

    setError(null);
    dates.forEach((date) =>
      upsert.mutate({
        placeId,
        ...blackoutCreateFields({
          scope,
          date,
          note: note.trim() ? note.trim() : null,
        }),
      }),
    );
  };

  return (
    <YStack gap="$3">
      <YStack gap="$1">
        <Text variant="body" weight="bold">
          {String(t("admin.peBlackoutTitle"))}
        </Text>
        {/* The list below (with its live Remove buttons) is a write surface
            too, so the scope has to be stated above it — not only inside the
            add form further down. */}
        <AvailabilityScopeLine scope={scope} scopeLabel={scopeLabel} />
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.peBlackoutHelp"))}
        </Text>
      </YStack>

      {query.isPending ? (
        <XStack paddingVertical="$4" justifyContent="center">
          <Spinner size="sm" />
        </XStack>
      ) : query.error ? (
        /* A failed read must NOT render as "no blackouts" with a live add
           form — an owner who re-adds a closure over a transient error ends
           up with duplicate rows once it clears. */
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
      ) : rows.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.peBlackoutEmpty"))}
        </Text>
      ) : (
        <YStack gap="$2">
          {rows.map((row) => (
            <XStack
              key={row.id}
              gap="$3"
              padding="$3"
              alignItems="center"
              flexWrap="wrap"
              borderWidth={2}
              borderColor="$borderColor"
            >
              <Text variant="bodySmall" weight="bold">
                {row.date ? formatDate(row.date) : ""}
              </Text>
              {/* A place-wide row viewed from a calendar scope: mark where it
                  comes from, so its reach (every calendar) stays visible. */}
              {row.calendarId === null && scope !== null && (
                <Badge tone="neutral" size="sm">
                  {String(t("admin.calMgrScopeAll"))}
                </Badge>
              )}
              {row.note && (
                <>
                  {/* flexBasis 120 (NOT flex:1 + minWidth): a 0% basis never
                      triggers flexWrap, so at 320px the min-width would force
                      a long note past the row border. With a real basis the
                      note wraps onto its own full-width line instead. */}
                  <Text
                    variant="bodySmall"
                    tone="muted"
                    flexGrow={1}
                    flexShrink={1}
                    flexBasis={120}
                  >
                    {row.note}
                  </Text>
                  <XStack gap="$1" alignItems="center">
                    <Lock size={12} color="var(--colorMuted, #5C544A)" />
                    <Text
                      variant="caption"
                      tone="muted"
                      style={{ textTransform: "uppercase" }}
                    >
                      {String(t("admin.peBlackoutPrivateNote"))}
                    </Text>
                  </XStack>
                </>
              )}
              <Button
                variant="ghost"
                size="$2"
                disabled={busy}
                marginLeft="auto"
                onPress={() => remove.mutate({ placeId, id: row.id })}
                aria-label={`${String(t("admin.peBlackoutRemove"))} — ${
                  row.date ? formatDate(row.date) : ""
                }`}
              >
                <Trash2 size={15} />
              </Button>
            </XStack>
          ))}
        </YStack>
      )}

      {/* No add form while the list read is failing: adding against an
          unknown current state is how duplicates happen. */}
      {!query.error && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderStyle="dashed"
          borderColor="$borderColor"
        >
          <AvailabilityScopeLine scope={scope} scopeLabel={scopeLabel} />
          <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
            <LabeledTextInput
              type="date"
              name="blackout-from"
              label={String(t("admin.peBlackoutFrom"))}
              value={from}
              onChangeText={setFrom}
            />
            <LabeledTextInput
              type="date"
              name="blackout-to"
              label={String(t("admin.peBlackoutTo"))}
              value={to}
              onChangeText={setTo}
            />
            <LabeledTextInput
              name="blackout-note"
              label={String(t("admin.peBlackoutNoteLabel"))}
              placeholder={String(t("admin.peBlackoutNotePlaceholder"))}
              value={note}
              // `containerWidth` is an AmountInput prop — LabeledTextInput
              // ignores it, so the field kept its default width and spilled
              // ~48px past this form's border at 320px. containerProps is the
              // real seam; flexBasis (not flex:1's 0% basis) lets it wrap.
              containerProps={{
                flexGrow: 1,
                flexShrink: 1,
                flexBasis: 240,
                minWidth: 0,
                maxWidth: "100%",
              }}
              maxLength={500}
              onChangeText={setNote}
            />
            {/* Secondary on purpose: the page's one primary action is
              "Create calendar" (one primary per viewport). */}
            <Button
              variant="secondary"
              size="$3"
              disabled={busy || !from}
              onPress={handleAdd}
              // Several "Add" buttons share this page (spaces, calendars) —
              // keep the visible label short but the announced one unambiguous.
              aria-label={`${String(t("admin.peBlackoutAddAria"))} — ${scopeLabel}`}
              testID="blackout-add"
            >
              <XStack gap="$1" alignItems="center">
                <Plus size={15} />
                <Text variant="bodySmall" weight="bold" tone="inherit">
                  {String(t("admin.peBlackoutAdd"))}
                </Text>
              </XStack>
            </Button>
          </XStack>
          {error && (
            <Text variant="caption" tone="error">
              {error}
            </Text>
          )}
          <Text variant="caption" tone="muted">
            {String(t("admin.peBlackoutFooter"))}
          </Text>
        </YStack>
      )}
    </YStack>
  );
}
