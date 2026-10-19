"use client";

import {
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type CSSProperties,
} from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Modal,
  StyledSelect,
  Switch,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import {
  DateTimeLocalInput,
  isDateTimeFieldIncomplete,
  useIncompleteField,
} from "@/components/forms/DateTimeLocalInput";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  browserTimeZone,
  canonicalTimeZone,
  isKnownTimeZone,
  timeZoneOptions,
  toDateTimeLocalValue,
  toIsoInTimeZone,
} from "@/lib/zoned-datetime-local";

import {
  ASK_CADENCE_LABEL_KEY,
  volunteerConflictMessageKey,
  type AskCadence,
} from "./volunteering-helpers";

// Native datetime inputs styled to match the strict-Swiss filter controls
// (same rationale as the org hours view's date inputs: Tamagui's TextInput
// ignores type="datetime-local" on web).
const DATETIME_INPUT_STYLE: CSSProperties = {
  minHeight: 44,
  padding: "8px 12px",
  fontSize: 16,
  borderRadius: 0,
  border: "1px solid var(--borderColor, #211C16)",
  background: "var(--surface, #FDFAF3)",
  color: "var(--color, #211C16)",
};

export type AskSubject = {
  subjectType: "PLACE" | "ORG" | "HUMAN";
  subjectId: string;
};

export type VolunteerAskFormInitial = {
  title: string;
  description: string | null;
  cadence: AskCadence;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  capacity: number | null;
  autoApprove: boolean;
  waiverRequired: boolean;
  smsOptInEnabled: boolean;
  /** IANA zone the window is stated in; null on asks made before zones. */
  timezone: string | null;
};

export type VolunteerAskFormProps = (
  | { mode: "create"; subject: AskSubject }
  | { mode: "edit"; askId: string; initial: VolunteerAskFormInitial }
) & {
  onClose: () => void;
  /**
   * The zone of the PLACE the ask is for, when it has one (null: it has none;
   * undefined: not a place, or still loading). Used when the ask itself
   * states no zone; until it arrives the form starts on the browser's zone.
   */
  defaultTimezone?: string | null;
  /** Create: receives the new askId. Edit: called after save. */
  onSuccess: (askId?: string) => void;
};

const CADENCES: AskCadence[] = ["ONE_TIME", "ONGOING", "RECURRING"];

const usableZone = (zone: string | null | undefined): zone is string =>
  Boolean(zone && isKnownTimeZone(zone));

/** Where the zone in the select came from; only "place" shows a note. */
type ZoneSource = "ask" | "place" | "browser" | "user";

/** The ask's own zone, else the place's, else the browser's. */
function initialZone(
  askZone: string | null | undefined,
  placeZone: string | null | undefined,
): { zone: string; source: ZoneSource } {
  if (usableZone(askZone)) return { zone: askZone, source: "ask" };
  if (usableZone(placeZone)) return { zone: placeZone, source: "place" };
  return { zone: browserTimeZone(), source: "browser" };
}

/**
 * A `datetime-local` wall clock read in `zone`. Switching the zone keeps the
 * typed clock and changes the instant it names, as the community form does.
 */
function wallClockToInstant(value: string, zone: string): Date | null {
  if (!value) return null;
  try {
    const d = new Date(toIsoInTimeZone(value, zone));
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Create / edit a generic volunteer ask (FR-001). New asks start as DRAFT —
 * publishing (OPEN) is an explicit status action on the manage page, so the
 * public link never goes live before roles exist.
 *
 * The application-form questions (`formSchema`) have no editor yet — the
 * public page renders whatever `{ questions: [...] }` shape an ask already
 * carries, and this form leaves the stored value untouched.
 */
export function VolunteerAskForm(props: VolunteerAskFormProps) {
  const { onClose, onSuccess, defaultTimezone } = props;
  const t = useTranslations();
  const notify = useNotify();

  const initial = props.mode === "edit" ? props.initial : null;
  const [zoneStart] = useState(() =>
    initialZone(initial?.timezone, defaultTimezone),
  );
  const [timezone, setTimezone] = useState(zoneStart.zone);
  const [zoneSource, setZoneSource] = useState<ZoneSource>(zoneStart.source);
  const [seenPlaceZone, setSeenPlaceZone] = useState(defaultTimezone);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [titleMissing, setTitleMissing] = useState(false);
  const titleRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [cadence, setCadence] = useState<AskCadence>(
    initial?.cadence ?? "ONE_TIME",
  );
  // Prefilled as the wall clock in the ask's zone, the zone it was typed in.
  const [startsAt, setStartsAt] = useState(() =>
    toDateTimeLocalValue(initial?.startsAt ?? null, timezone),
  );
  const [endsAt, setEndsAt] = useState(() =>
    toDateTimeLocalValue(initial?.endsAt ?? null, timezone),
  );
  const zoneSelect = useMemo(() => timeZoneOptions(timezone), [timezone]);

  // The place's zone can arrive after the form opens. Adopt it while the
  // select still holds the browser's default (never over the ask's own zone
  // or the user's pick). An edit whose times are untouched is re-read in the
  // new zone, so the stored instants do not move.
  if (defaultTimezone !== seenPlaceZone) {
    setSeenPlaceZone(defaultTimezone);
    if (zoneSource === "browser" && usableZone(defaultTimezone)) {
      if (initial) {
        const startsUntouched =
          startsAt === toDateTimeLocalValue(initial.startsAt, timezone);
        const endsUntouched =
          endsAt === toDateTimeLocalValue(initial.endsAt, timezone);
        if (startsUntouched) {
          setStartsAt(toDateTimeLocalValue(initial.startsAt, defaultTimezone));
        }
        if (endsUntouched) {
          setEndsAt(toDateTimeLocalValue(initial.endsAt, defaultTimezone));
        }
      }
      setTimezone(defaultTimezone);
      setZoneSource("place");
    }
  }
  const [capacity, setCapacity] = useState(
    initial?.capacity != null ? String(initial.capacity) : "",
  );
  const [autoApprove, setAutoApprove] = useState(
    initial?.autoApprove ?? false,
  );
  const [waiverRequired, setWaiverRequired] = useState(
    initial?.waiverRequired ?? false,
  );
  // No "Offer SMS reminders" switch: the volunteer chooses texts on a
  // one-time ask with a start (volunteer-ask-reminders R5), so this column
  // gates nothing. The stored value is sent back unchanged on save (false
  // for a new ask).
  const smsOptInEnabled = initial?.smsOptInEnabled ?? false;
  const [windowError, setWindowError] = useState(false);
  // A half-typed date reads as "" (Chrome fires no input event until every
  // segment is filled), so without these the ask would save with no start.
  const startsField = useIncompleteField();
  const endsField = useIncompleteField();
  const startsIncomplete = startsField.incomplete;
  const endsIncomplete = endsField.incomplete;
  const startsRef = useRef<HTMLInputElement>(null);
  const endsRef = useRef<HTMLInputElement>(null);
  const [capacityError, setCapacityError] = useState(false);

  const onError = (err: unknown) => {
    const conflictKey = volunteerConflictMessageKey(err);
    notify.toast.danger({
      id: "volunteer-ask-save-failed",
      title: String(t("volunteering.askSaveFailed")),
      message: conflictKey
        ? String(t(conflictKey))
        : formatErrorMessage(err, t),
    });
  };

  const createMutation = trpc.volunteer.asks.create.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: (result) => {
      notify.toast.success({
        id: "volunteer-ask-created",
        title: String(t("volunteering.askCreated")),
      });
      onSuccess(result.askId);
    },
    onError,
  });

  const updateMutation = trpc.volunteer.asks.update.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-ask-updated",
        title: String(t("volunteering.askUpdated")),
      });
      onSuccess();
    },
    onError,
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setTitleMissing(true);
      titleRef.current?.focus();
      return;
    }

    // Re-read the fields: a half-typed date must never save as "no date".
    const startsHalfTyped = startsRef.current
      ? isDateTimeFieldIncomplete(startsRef.current)
      : false;
    const endsHalfTyped = endsRef.current
      ? isDateTimeFieldIncomplete(endsRef.current)
      : false;
    if (startsHalfTyped || endsHalfTyped) {
      startsField.refuse(startsHalfTyped);
      endsField.refuse(endsHalfTyped);
      return;
    }

    // Both ends are instants in the chosen zone, so the order check below
    // compares what the volunteer will see, not two browser-zone readings.
    const starts = wallClockToInstant(startsAt, timezone);
    const ends = wallClockToInstant(endsAt, timezone);
    const windowInvalid = Boolean(starts && ends && ends <= starts);
    setWindowError(windowInvalid);

    // An out-of-range or non-numeric capacity blocks submit — silently
    // coercing it to "no cap" would save something the organizer never asked
    // for (mirrors the askWindowError pattern above).
    const parsedCapacity = capacity.trim() === "" ? null : Number(capacity);
    const capacityInvalid =
      parsedCapacity !== null &&
      (!Number.isFinite(parsedCapacity) || parsedCapacity < 1);
    setCapacityError(capacityInvalid);

    if (windowInvalid || capacityInvalid) return;

    const capacityValue =
      parsedCapacity === null ? null : Math.floor(parsedCapacity);
    const trimmedDescription = description.trim();

    // The select may show this runtime's alias of the stored zone
    // ("Asia/Calcutta" for "Asia/Kolkata"); an unchanged zone keeps its
    // stored spelling.
    const zoneToSend =
      initial?.timezone &&
      canonicalTimeZone(initial.timezone) === canonicalTimeZone(timezone)
        ? initial.timezone
        : timezone;

    const shared = {
      title: trimmedTitle,
      description: trimmedDescription || null,
      cadence,
      startsAt: starts,
      endsAt: ends,
      capacity: capacityValue,
      autoApprove,
      waiverRequired,
      smsOptInEnabled,
      timezone: zoneToSend,
    };

    if (props.mode === "create") {
      createMutation.mutate({
        subjectType: props.subject.subjectType,
        subjectId: props.subject.subjectId,
        ...shared,
      });
    } else {
      updateMutation.mutate({ askId: props.askId, ...shared });
    }
  };

  const startsInputId = "volunteer-ask-starts-at";
  const endsInputId = "volunteer-ask-ends-at";
  const zoneInputId = "volunteer-ask-timezone";
  const titleErrorId = "volunteer-ask-title-missing";

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={560}>
        <Modal.Header
          title={String(
            t(
              props.mode === "create"
                ? "volunteering.askFormCreateTitle"
                : "volunteering.askFormEditTitle",
            ),
          )}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.askFieldTitle"))}
              </Text>
              <TextInput
                ref={titleRef}
                value={title}
                onChangeText={(value: string) => {
                  setTitle(value);
                  if (value.trim()) setTitleMissing(false);
                }}
                maxLength={200}
                fullWidth
                minHeight={44}
                required
                status={titleMissing ? "error" : undefined}
                aria-invalid={titleMissing ? true : undefined}
                aria-describedby={titleMissing ? titleErrorId : undefined}
                placeholder={String(
                  t("volunteering.askFieldTitlePlaceholder"),
                )}
                testId="volunteer-ask-title"
                aria-label={String(t("volunteering.askFieldTitle"))}
              />
              {titleMissing ? (
                <Text
                  id={titleErrorId}
                  variant="caption"
                  color="$danger"
                  role="alert"
                >
                  {String(t("volunteering.askTitleRequired"))}
                </Text>
              ) : null}
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.askFieldDescription"))}
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={4}
                maxLength={5000}
                fullWidth
                testId="volunteer-ask-description"
                aria-label={String(t("volunteering.askFieldDescription"))}
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.askFieldCadence"))}
              </Text>
              <StyledSelect
                value={cadence}
                options={CADENCES.map((c) => ({
                  value: c,
                  label: String(t(ASK_CADENCE_LABEL_KEY[c])),
                }))}
                onChange={setCadence}
                fullWidth
                testId="volunteer-ask-cadence"
                aria-label={String(t("volunteering.askFieldCadence"))}
              />
            </YStack>

            <XStack gap="$3" flexWrap="wrap">
              <YStack gap="$1" flex={1} minWidth={200}>
                <label htmlFor={startsInputId}>
                  <Text variant="label">
                    {String(t("volunteering.askFieldStartsAt"))}
                  </Text>
                </label>
                <DateTimeLocalInput
                  ref={startsRef}
                  id={startsInputId}
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  onIncompleteChange={startsField.onIncompleteChange}
                  aria-invalid={startsField.shown ? true : undefined}
                  aria-describedby={
                    startsField.shown ? `${startsInputId}-incomplete` : undefined
                  }
                  style={DATETIME_INPUT_STYLE}
                  data-testid="volunteer-ask-starts-at"
                />
                {startsField.shown ? (
                  <Text
                    id={`${startsInputId}-incomplete`}
                    variant="caption"
                    color="$danger"
                    role="alert"
                  >
                    {String(t("volunteering.askStartsIncomplete"))}
                  </Text>
                ) : null}
              </YStack>
              <YStack gap="$1" flex={1} minWidth={200}>
                <label htmlFor={endsInputId}>
                  <Text variant="label">
                    {String(t("volunteering.askFieldEndsAt"))}
                  </Text>
                </label>
                <DateTimeLocalInput
                  ref={endsRef}
                  id={endsInputId}
                  type="datetime-local"
                  value={endsAt}
                  min={startsAt || undefined}
                  onChange={(e) => setEndsAt(e.target.value)}
                  onIncompleteChange={endsField.onIncompleteChange}
                  aria-invalid={endsField.shown ? true : undefined}
                  aria-describedby={
                    endsField.shown ? `${endsInputId}-incomplete` : undefined
                  }
                  style={DATETIME_INPUT_STYLE}
                  data-testid="volunteer-ask-ends-at"
                />
                {endsField.shown ? (
                  <Text
                    id={`${endsInputId}-incomplete`}
                    variant="caption"
                    color="$danger"
                    role="alert"
                  >
                    {String(t("volunteering.askEndsIncomplete"))}
                  </Text>
                ) : null}
              </YStack>
            </XStack>
            <YStack gap="$1">
              <label htmlFor={zoneInputId}>
                <Text variant="label">
                  {String(t("volunteering.askFieldTimezone"))}
                </Text>
              </label>
              <StyledSelect
                value={zoneSelect.value}
                options={zoneSelect.options.map((zone) => ({
                  value: zone,
                  label: zone,
                }))}
                onChange={(zone: string) => {
                  setTimezone(zone);
                  setZoneSource("user");
                }}
                fullWidth
                selectId={zoneInputId}
                ariaDescribedBy={`${zoneInputId}-help`}
                testId="volunteer-ask-timezone"
              />
              {zoneSource === "place" ? (
                <Text
                  variant="caption"
                  color="$colorMuted"
                  data-testid="volunteer-ask-timezone-from-place"
                >
                  {String(
                    t("communityCreate.pfTimezoneFromPlace", { timezone }),
                  )}
                </Text>
              ) : null}
              <Text
                id={`${zoneInputId}-help`}
                variant="caption"
                color="$colorMuted"
              >
                {String(t("volunteering.askFieldTimezoneHelp"))}
              </Text>
            </YStack>
            {windowError ? (
              <Text variant="caption" color="$danger" role="alert">
                {String(t("volunteering.askWindowError"))}
              </Text>
            ) : null}

            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.askFieldCapacity"))}
              </Text>
              <TextInput
                value={capacity}
                onChangeText={setCapacity}
                inputMode="numeric"
                fullWidth
                minHeight={44}
                placeholder={String(
                  t("volunteering.askFieldCapacityPlaceholder"),
                )}
                testId="volunteer-ask-capacity"
                aria-label={String(t("volunteering.askFieldCapacity"))}
              />
              {capacityError ? (
                <Text variant="caption" color="$danger" role="alert">
                  {String(t("volunteering.capacityInvalid"))}
                </Text>
              ) : null}
            </YStack>

            <XStack gap="$3" alignItems="center">
              <Switch
                checked={autoApprove}
                onCheckedChange={setAutoApprove}
                size="small"
              />
              <YStack flex={1} gap="$1">
                <Text variant="label">
                  {String(t("volunteering.askFieldAutoApprove"))}
                </Text>
                <Text variant="caption" color="$colorMuted">
                  {String(t("volunteering.askFieldAutoApproveHelp"))}
                </Text>
              </YStack>
            </XStack>

            <XStack gap="$3" alignItems="center">
              <Switch
                checked={waiverRequired}
                onCheckedChange={setWaiverRequired}
                size="small"
              />
              <YStack flex={1} gap="$1">
                <Text variant="label">
                  {String(t("volunteering.askFieldWaiverRequired"))}
                </Text>
                <Text variant="caption" color="$colorMuted">
                  {String(t("volunteering.askFieldWaiverRequiredHelp"))}
                </Text>
              </YStack>
            </XStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <XStack gap="$2" justifyContent="flex-end">
            <Button variant="ghost" onPress={onClose} disabled={isPending}>
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={isPending || startsIncomplete || endsIncomplete}
              data-testid="volunteer-ask-submit"
            >
              {String(
                props.mode === "create"
                  ? t("common.create")
                  : t("common.save"),
              )}
            </Button>
          </XStack>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
