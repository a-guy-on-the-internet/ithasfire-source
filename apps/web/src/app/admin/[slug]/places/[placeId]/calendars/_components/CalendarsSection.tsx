"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import { CalendarRange, Plus } from "lucide-react";
import {
  AmountInput,
  Badge,
  Button,
  CharCountTextarea,
  Checkbox,
  LabeledTextInput,
  Money,
  Spinner,
  StyledSelect,
  Switch,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import {
  BOOKING_CONFIG_DEFAULTS,
  bookingConfigPatch,
  bookingFormFromConfig,
  calendarHasNoActiveSpaces,
  intentSummaryParts,
  rentalRateCurrencyOptions,
  rentalRateCurrencySymbol,
  rentalRateFieldFromError,
  sanitizeRentalRateInput,
  timeInputStyle,
  type BookingConfigForm,
  type CalendarRow,
  type RentalRateField,
  type SpaceRow,
} from "./venue-calendars-helpers";

export interface CalendarsSectionProps {
  placeId: string;
}

type CalendarFormState = {
  name: string;
  description: string;
  defaultStartTime: string;
  spaceIds: string[];
  /** Booking config layer — see the helpers module header. */
  booking: BookingConfigForm;
};

const emptyForm: CalendarFormState = {
  name: "",
  description: "",
  defaultStartTime: "",
  spaceIds: [],
  booking: bookingFormFromConfig(BOOKING_CONFIG_DEFAULTS),
};

function formFromCalendar(calendar: CalendarRow): CalendarFormState {
  return {
    name: calendar.name,
    description: calendar.description ?? "",
    defaultStartTime: calendar.defaultStartTime ?? "",
    spaceIds: calendar.spaces.map((r) => r.id),
    booking: bookingFormFromConfig(calendar),
  };
}

/**
 * The three intents a calendar can accept, in spec order, with the public
 * verbs (Play here / Rent a space / Use a space). `rentalMode` is deliberately
 * absent — INSTANT is reserved for its own spec and is never UI-selectable.
 */
const INTENT_ROWS = [
  {
    key: "perform",
    field: "acceptsPerform",
    labelKey: "admin.calMgrIntentPerformLabel",
    hintKey: "admin.calMgrIntentPerformHint",
  },
  {
    key: "rent",
    field: "acceptsRent",
    labelKey: "admin.calMgrIntentRentLabel",
    hintKey: "admin.calMgrIntentRentHint",
  },
  {
    key: "use",
    field: "acceptsUse",
    labelKey: "admin.calMgrIntentUseLabel",
    hintKey: "admin.calMgrIntentUseHint",
  },
] as const;

type RateError = { field: RentalRateField; messageKey: string };

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * The place's named programming streams ("Social Club", "Live Music") —
 * list, create, edit (name / description / default start time / space
 * assignment). `slug` and `isDefault` are immutable here: the slug is the
 * public link name (shown read-only with a hint) and the default calendar is
 * minted at place creation.
 */
export function CalendarsSection({ placeId }: CalendarsSectionProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const calendarsQuery = trpc.places.listCalendars.useQuery({ placeId });
  const spacesQuery = trpc.places.listSpaces.useQuery({
    placeId,
    includeRetired: true,
  });
  const calendars: CalendarRow[] = calendarsQuery.data ?? [];
  const spaces: SpaceRow[] = spacesQuery.data ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CalendarFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  // The rental-rate pair error (client resolve or server refusal). Cleared on
  // the next edit to the booking group — validate on submit, clear on input.
  const [rateError, setRateError] = useState<RateError | null>(null);

  const refresh = () => utils.places.listCalendars.invalidate({ placeId });

  const createMutation = trpc.places.createCalendar.useMutation();
  const updateMutation = trpc.places.updateCalendar.useMutation();
  const assignSpaces = trpc.places.assignCalendarSpaces.useMutation();

  const busy =
    saving ||
    createMutation.isPending ||
    updateMutation.isPending ||
    assignSpaces.isPending;

  const closeForm = () => {
    setEditingId(null);
    setCreating(false);
    setForm(emptyForm);
    setRateError(null);
  };

  /**
   * The single way a form opens (New or Edit) — the mirror of `closeForm`.
   * Routing both through here is what keeps a rate error from an abandoned
   * create out of the edit form opened right after it.
   */
  const openForm = (next: { editingId: string | null; form: CalendarFormState }) => {
    setCreating(next.editingId === null);
    setEditingId(next.editingId);
    setForm(next.form);
    setRateError(null);
  };

  /**
   * A refused rate: render the error AND move focus to the field it is
   * about. The panel is already mounted (Rent is on whenever a rate is
   * validated), so the element exists by the next frame.
   */
  const failRate = (idPrefix: string, error: RateError) => {
    setRateError(error);
    const target =
      error.field === "amount"
        ? `${idPrefix}-rental-rate`
        : `${idPrefix}-rental-currency`;
    if (typeof document === "undefined") return;
    requestAnimationFrame(() => document.getElementById(target)?.focus());
  };

  const setBooking = (patch: Partial<BookingConfigForm>) => {
    setForm((prev) => ({ ...prev, booking: { ...prev.booking, ...patch } }));
    setRateError(null);
  };

  const toggleSpace = (spaceId: string, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      spaceIds: checked
        ? [...prev.spaceIds, spaceId]
        : prev.spaceIds.filter((id) => id !== spaceId),
    }));
  };

  // Every calendar has ≥1 ACTIVE space (owner ruling 2026-09-23) — NOT merely
  // one join. The checklist below lists retired rooms as checkable so an owner
  // can keep or un-join them, so counting ticks would arm the buttons on an
  // all-retired selection and round-trip the owner to a server refusal
  // (CALENDAR_REQUIRES_ACTIVE_SPACE), which stays the backstop for a raced
  // click. The handlers re-check so a stale click can never reach the wire.
  const ticked = spaces.filter((space) => form.spaceIds.includes(space.id));
  const spacesMissing = calendarHasNoActiveSpaces({ spaces: ticked });

  /**
   * Create is ONE write: the calendar row and its space assignment are joined
   * in the same transaction server-side, so either the calendar exists with
   * its spaces or nothing exists and the typed form stays for a retry.
   */
  const handleCreate = async () => {
    const name = form.name.trim();
    if (!name || spacesMissing) return;
    // Booking config rides the same write, and only the fields that differ
    // from the DB defaults — an untouched group adds nothing to the payload.
    const booking = bookingConfigPatch(form.booking, BOOKING_CONFIG_DEFAULTS);
    if (!booking.ok) {
      failRate("new-calendar", booking);
      return;
    }
    setSaving(true);

    try {
      await createMutation.mutateAsync({
        placeId,
        name,
        ...(form.description.trim()
          ? { description: form.description.trim() }
          : {}),
        ...(form.defaultStartTime
          ? { defaultStartTime: form.defaultStartTime }
          : {}),
        spaceIds: form.spaceIds,
        ...booking.patch,
      });
    } catch (err) {
      // Nothing was created — the create form (with the typed values) stays.
      const rateField = rentalRateFieldFromError(err);
      if (rateField) {
        failRate("new-calendar", {
          field: rateField,
          messageKey: "admin.calMgrRentalRatePairError",
        });
        setSaving(false);
        return;
      }
      toast.danger({
        id: "calendar-create-failed",
        title: String(t("admin.calMgrCreateFailed")),
        message: formatErrorMessage(err, t),
      });
      setSaving(false);
      return;
    }

    try {
      await refresh();
    } finally {
      closeForm();
      setSaving(false);
    }
  };

  /**
   * Update is TWO writes (updateCalendar, then assignCalendarSpaces), and the
   * error handling stays honest about which one failed: the calendar's own
   * fields save first; a space-assignment failure keeps the edit form open so
   * Save retries just that write.
   */
  const handleSave = async (calendar: CalendarRow) => {
    const name = form.name.trim();
    if (!name || spacesMissing) return;
    // Diff against the stored row: a calendar whose booking group was never
    // touched sends exactly the patch it sent before the layer existed.
    const booking = bookingConfigPatch(form.booking, calendar);
    if (!booking.ok) {
      failRate(`calendar-${calendar.id}`, booking);
      return;
    }
    setSaving(true);

    try {
      await updateMutation.mutateAsync({
        placeId,
        calendarId: calendar.id,
        patch: {
          name,
          description: form.description.trim() || null,
          defaultStartTime: form.defaultStartTime || null,
          ...booking.patch,
        },
      });
    } catch (err) {
      // A rate-pair refusal is a FIELD error (the server's superRefine, which
      // the client mirrors); anything else is the calendar update failing.
      const rateField = rentalRateFieldFromError(err);
      if (rateField) {
        failRate(`calendar-${calendar.id}`, {
          field: rateField,
          messageKey: "admin.calMgrRentalRatePairError",
        });
        setSaving(false);
        return;
      }
      toast.danger({
        id: "calendar-update-failed",
        title: String(t("admin.calMgrUpdateFailed")),
        message: formatErrorMessage(err, t),
      });
      setSaving(false);
      return;
    }

    try {
      const currentIds = calendar.spaces.map((r) => r.id);
      if (!sameIdSet(currentIds, form.spaceIds)) {
        await assignSpaces.mutateAsync({
          placeId,
          calendarId: calendar.id,
          spaceIds: form.spaceIds,
        });
      }
      await refresh();
      closeForm();
    } catch (err) {
      // The calendar's own fields saved; the failure is the SPACE assignment.
      // Stay in edit mode so Save can retry just that write.
      void refresh();
      toast.danger({
        id: "calendar-spaces-assign-failed",
        title: String(t("admin.calMgrSpacesAssignFailed")),
        message: formatErrorMessage(err, t),
      });
    } finally {
      setSaving(false);
    }
  };

  const spaceChecklist = (idPrefix: string) => (
    <YStack gap="$2">
      <Text
        variant="caption"
        weight="bold"
        style={{ textTransform: "uppercase" }}
      >
        {String(t("admin.calMgrSpacesAssignLabel"))}
      </Text>
      {spaces.map((space) => {
        const retired = space.status === "RETIRED";
        return (
          <Checkbox
            key={space.id}
            id={`${idPrefix}-space-${space.id}`}
            label={
              retired
                ? `${space.name} — ${String(t("admin.calMgrRetiredBadge"))}`
                : space.name
            }
            checked={form.spaceIds.includes(space.id)}
            onCheckedChange={(checked) => toggleSpace(space.id, checked === true)}
            disabled={busy}
          />
        );
      })}
      {spacesMissing && (
        <Text
          variant="caption"
          tone="error"
          testID={`${idPrefix}-spaces-required`}
        >
          {String(
            t(
              spaces.length === 0
                ? "admin.calMgrSpacesNoneYet"
                : "admin.calMgrSpacesRequired",
            ),
          )}
        </Text>
      )}
    </YStack>
  );

  /**
   * A switch with its own visible label and one-line hint. The label is a
   * real `<label for>` so it names the switch for assistive tech AND toggles
   * it on click; the hint stays visible copy beside it.
   */
  const switchRow = (args: {
    id: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    hint: string;
  }) => (
    <XStack key={args.id} gap="$2" alignItems="flex-start">
      <Switch
        id={args.id}
        checked={args.checked}
        onCheckedChange={args.onChange}
        disabled={busy}
        testId={args.id}
      />
      <YStack gap="$1" flex={1} minWidth={0}>
        <label
          htmlFor={args.id}
          style={{ display: "contents", cursor: busy ? "default" : "pointer" }}
        >
          <Text variant="body" weight="semibold">
            {args.label}
          </Text>
        </label>
        <Text variant="caption" tone="muted">
          {args.hint}
        </Text>
      </YStack>
    </XStack>
  );

  /**
   * The booking group (venue-confirmation spec — "Calendar is the config
   * layer"): which intents this calendar accepts, and — only while Rent is
   * on — the flat rate, its currency, and whether the rate is public.
   */
  const bookingGroup = (idPrefix: string) => {
    const amountId = `${idPrefix}-rental-rate`;
    const currencyId = `${idPrefix}-rental-currency`;
    const errorId = `${idPrefix}-rental-rate-error`;
    const hintId = `${idPrefix}-rental-rate-hint`;
    const currencyLabel = String(t("admin.calMgrRentalRateCurrencyLabel"));
    const amountInvalid = rateError?.field === "amount";
    const currencyInvalid = rateError?.field === "currency";

    return (
      <YStack gap="$2" testID={`${idPrefix}-booking`}>
        <Text
          variant="caption"
          weight="bold"
          style={{ textTransform: "uppercase" }}
        >
          {String(t("admin.calMgrBookingLabel"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("admin.calMgrBookingHelp"))}
        </Text>
        <YStack gap="$3">
          {INTENT_ROWS.map((row) =>
            switchRow({
              id: `${idPrefix}-intent-${row.key}`,
              checked: form.booking[row.field],
              onChange: (checked) => setBooking({ [row.field]: checked }),
              label: String(t(row.labelKey)),
              hint: String(t(row.hintKey)),
            }),
          )}
        </YStack>

        {form.booking.acceptsRent && (
          <YStack
            gap="$3"
            paddingLeft="$3"
            borderLeftWidth={2}
            borderLeftColor="$borderColorSoft"
            testID={`${idPrefix}-rental`}
          >
            <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
              <YStack
                gap="$1"
                flexGrow={1}
                flexShrink={1}
                flexBasis={180}
                minWidth={0}
                maxWidth="100%"
              >
                <label htmlFor={amountId} style={{ display: "contents" }}>
                  <Text
                    variant="caption"
                    weight="bold"
                    style={{ textTransform: "uppercase" }}
                  >
                    {String(t("admin.calMgrRentalRateLabel"))}
                  </Text>
                </label>
                <AmountInput
                  id={amountId}
                  prefix={rentalRateCurrencySymbol(
                    form.booking.rentalRateCurrency,
                  )}
                  placeholder="500.00"
                  value={form.booking.rentalRateAmount}
                  onChangeText={(value) =>
                    setBooking({
                      rentalRateAmount: sanitizeRentalRateInput(value),
                    })
                  }
                  inputMode="decimal"
                  fullWidth
                  disabled={busy}
                  status={amountInvalid ? "error" : undefined}
                  aria-invalid={amountInvalid ? true : undefined}
                  aria-describedby={
                    amountInvalid ? `${errorId} ${hintId}` : hintId
                  }
                  testID={amountId}
                />
              </YStack>
              <YStack gap="$1" flexGrow={0} flexShrink={0} flexBasis={112}>
                <label htmlFor={currencyId} style={{ display: "contents" }}>
                  <Text
                    variant="caption"
                    weight="bold"
                    style={{ textTransform: "uppercase" }}
                  >
                    {currencyLabel}
                  </Text>
                </label>
                <StyledSelect
                  value={form.booking.rentalRateCurrency}
                  options={rentalRateCurrencyOptions(
                    form.booking.rentalRateCurrency,
                  ).map((code) => ({ value: code, label: code }))}
                  onChange={(value) => setBooking({ rentalRateCurrency: value })}
                  disabled={busy}
                  fullWidth
                  selectId={currencyId}
                  ariaLabel={currencyLabel}
                  ariaDescribedBy={currencyInvalid ? errorId : undefined}
                  testId={currencyId}
                />
              </YStack>
            </XStack>
            {rateError && (
              <Text
                id={errorId}
                variant="caption"
                tone="error"
                testID={errorId}
              >
                {String(t(rateError.messageKey))}
              </Text>
            )}
            <Text id={hintId} variant="caption" tone="muted">
              {String(t("admin.calMgrRentalRateHint"))}
            </Text>
            {switchRow({
              id: `${idPrefix}-rental-visible`,
              checked: form.booking.rentalRateVisible,
              onChange: (checked) => setBooking({ rentalRateVisible: checked }),
              label: String(t("admin.calMgrRentalRateVisibleLabel")),
              hint: String(t("admin.calMgrRentalRateVisibleHint")),
            })}
          </YStack>
        )}
      </YStack>
    );
  };

  const calendarForm = (args: {
    idPrefix: string;
    slug?: string;
    onSubmit: () => void;
    submitLabel: string;
    submitTestId: string;
  }) => (
    <YStack gap="$3" paddingTop="$2">
      <XStack gap="$3" alignItems="flex-end" flexWrap="wrap">
        <LabeledTextInput
          name={`${args.idPrefix}-name`}
          label={String(t("admin.calMgrNameLabel"))}
          value={form.name}
          maxLength={140}
          onChangeText={(value) =>
            setForm((prev) => ({ ...prev, name: value }))
          }
        />
        <YStack gap="$1">
          <Text
            variant="caption"
            weight="bold"
            style={{ textTransform: "uppercase" }}
          >
            {String(t("admin.calMgrDefaultStartLabel"))}
          </Text>
          <input
            type="time"
            value={form.defaultStartTime}
            aria-label={String(t("admin.calMgrDefaultStartLabel"))}
            style={timeInputStyle(false)}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                defaultStartTime: e.target.value,
              }))
            }
          />
        </YStack>
      </XStack>

      {args.slug !== undefined && (
        <YStack gap="$1">
          <Text
            variant="caption"
            weight="bold"
            style={{ textTransform: "uppercase" }}
          >
            {String(t("admin.calMgrSlugLabel"))}
          </Text>
          <Text
            variant="bodySmall"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            /{args.slug}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.calMgrSlugHint"))}
          </Text>
        </YStack>
      )}

      <YStack gap="$1">
        <Text
          variant="caption"
          weight="bold"
          style={{ textTransform: "uppercase" }}
        >
          {String(t("admin.calMgrDescriptionLabel"))}
        </Text>
        {/* No `id` here on purpose: CharCountTextarea's `id` prop exists only
            in another session's uncommitted change, and depending on it would
            break this tree's typecheck. The visible Text above labels the
            field; re-add `id` once that lands. */}
        <CharCountTextarea
          value={form.description}
          onChange={(value) =>
            setForm((prev) => ({ ...prev, description: value }))
          }
          maxLength={1000}
          disabled={busy}
        />
      </YStack>

      {spaceChecklist(args.idPrefix)}

      {bookingGroup(args.idPrefix)}

      <XStack gap="$2" flexWrap="wrap">
        <Button
          variant="primary"
          size="$3"
          disabled={busy || !form.name.trim() || spacesMissing}
          onPress={args.onSubmit}
          testID={args.submitTestId}
        >
          {args.submitLabel}
        </Button>
        <Button variant="ghost" size="$3" disabled={busy} onPress={closeForm}>
          {String(t("common.cancel"))}
        </Button>
      </XStack>
    </YStack>
  );

  if (calendarsQuery.error) {
    return (
      <YStack gap="$3">
        <Text variant="body" tone="error">
          {formatErrorMessage(calendarsQuery.error, t)}
        </Text>
        <XStack>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => void calendarsQuery.refetch()}
          >
            {String(t("admin.placesRetry"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$3" testID="calendars-section">
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <CalendarRange size={18} color="var(--color, #211C16)" />
        <Text variant="h4" weight="bold">
          {String(t("admin.calMgrCalendarsTitle"))}
        </Text>
        <XStack marginLeft="auto">
          {!creating && editingId === null && (
            <Button
              variant="primary"
              size="$3"
              disabled={busy}
              onPress={() => openForm({ editingId: null, form: emptyForm })}
              testID="calendar-new"
            >
              <XStack gap="$1" alignItems="center">
                <Plus size={15} />
                <Text variant="bodySmall" weight="bold" color="$colorInverted">
                  {String(t("admin.calMgrNewCalendar"))}
                </Text>
              </XStack>
            </Button>
          )}
        </XStack>
      </XStack>
      <Text variant="bodySmall" tone="muted">
        {String(t("admin.calMgrCalendarsHelp"))}
      </Text>

      {creating && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderStyle="dashed"
          borderColor="$borderColor"
          testID="calendar-create-form"
        >
          <Text variant="body" weight="bold">
            {String(t("admin.calMgrNewCalendar"))}
          </Text>
          {calendarForm({
            idPrefix: "new-calendar",
            onSubmit: () => void handleCreate(),
            submitLabel: String(t("admin.calMgrCreate")),
            submitTestId: "calendar-create-submit",
          })}
        </YStack>
      )}

      {calendarsQuery.isPending ? (
        <XStack paddingVertical="$4" justifyContent="center">
          <Spinner size="sm" />
        </XStack>
      ) : (
        <YStack gap="$2">
          {calendars.map((calendar) => {
            const editing = editingId === calendar.id;
            const noActiveSpaces = calendarHasNoActiveSpaces(calendar);
            // "Play · Rent $500 · Use" — the accepted intents at a glance.
            const intentSummary = intentSummaryParts(
              calendar,
              {
                perform: String(t("admin.calMgrIntentSummaryPerform")),
                rent: String(t("admin.calMgrIntentSummaryRent")),
                rentWithRate: (rate) =>
                  String(t("admin.calMgrIntentSummaryRentRate", { rate })),
                use: String(t("admin.calMgrIntentSummaryUse")),
              },
              (cents, currency) =>
                Money.format(cents, { currency, showCents: "auto" }),
            );

            return (
              <YStack
                key={calendar.id}
                gap="$2"
                padding="$3"
                borderWidth={2}
                borderColor="$borderColor"
                testID={`calendar-card-${calendar.slug}`}
              >
                <XStack gap="$2" alignItems="center" flexWrap="wrap">
                  <Text variant="body" weight="bold">
                    {calendar.name}
                  </Text>
                  {calendar.isDefault && (
                    <Badge tone="info" size="sm">
                      {String(t("admin.calMgrDefaultBadge"))}
                    </Badge>
                  )}
                  {noActiveSpaces && (
                    <Badge tone="warning" size="sm">
                      {String(t("admin.calMgrNoActiveSpaces"))}
                    </Badge>
                  )}
                  {!editing && (
                    <XStack marginLeft="auto">
                      <Button
                        variant="ghost"
                        size="$2"
                        disabled={busy}
                        onPress={() =>
                          openForm({
                            editingId: calendar.id,
                            form: formFromCalendar(calendar),
                          })
                        }
                        aria-label={`${String(t("admin.calMgrEditCalendar"))} — ${calendar.name}`}
                        testID={`calendar-edit-${calendar.slug}`}
                      >
                        {String(t("admin.calMgrEditCalendar"))}
                      </Button>
                    </XStack>
                  )}
                </XStack>

                {!editing && (
                  <>
                    <XStack gap="$3" alignItems="center" flexWrap="wrap">
                      <Text
                        variant="caption"
                        tone="muted"
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        /{calendar.slug}
                      </Text>
                      {calendar.defaultStartTime && (
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {String(
                            t("admin.calMgrDefaultStartDisplay", {
                              time: calendar.defaultStartTime,
                            }),
                          )}
                        </Text>
                      )}
                      <Text
                        variant="overline"
                        tone="muted"
                        testID={`calendar-intents-${calendar.slug}`}
                      >
                        {intentSummary.length > 0
                          ? intentSummary.join(" · ")
                          : String(t("admin.calMgrIntentSummaryNone"))}
                      </Text>
                    </XStack>
                    {calendar.description ? (
                      <Text variant="bodySmall" tone="muted">
                        {calendar.description}
                      </Text>
                    ) : null}
                    <XStack gap="$2" flexWrap="wrap" alignItems="center">
                      {calendar.spaces.length === 0 ? (
                        <Text variant="caption" tone="muted">
                          {String(t("admin.calMgrNoSpacesAssigned"))}
                        </Text>
                      ) : (
                        calendar.spaces.map((space) => (
                          <Badge key={space.id} tone="neutral" size="sm">
                            {space.status === "RETIRED"
                              ? `${space.name} — ${String(t("admin.calMgrRetiredBadge"))}`
                              : space.name}
                          </Badge>
                        ))
                      )}
                    </XStack>
                  </>
                )}

                {editing &&
                  calendarForm({
                    idPrefix: `calendar-${calendar.id}`,
                    slug: calendar.slug,
                    onSubmit: () => void handleSave(calendar),
                    submitLabel: String(t("admin.calMgrSaveCalendar")),
                    submitTestId: `calendar-save-${calendar.slug}`,
                  })}
              </YStack>
            );
          })}
        </YStack>
      )}
    </YStack>
  );
}
