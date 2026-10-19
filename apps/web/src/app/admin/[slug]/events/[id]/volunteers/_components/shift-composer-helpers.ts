export type ShiftComposerFieldErrorCode =
  | "required"
  | "ends_before_start"
  | "invalid_capacity";

export interface ShiftComposerDraftRow {
  id: string;
  startsAt?: string;
  endsAt?: string;
  label: string;
  capacity: string;
}

export interface ShiftComposerDraftRowErrors {
  startsAt?: ShiftComposerFieldErrorCode;
  endsAt?: ShiftComposerFieldErrorCode;
  capacity?: ShiftComposerFieldErrorCode;
}

export type ShiftComposerPresetKey = "setup" | "doors" | "main" | "cleanup";

export interface ShiftComposerCreateRowOptions {
  eventStartsAt?: string;
  previousRow?: Pick<ShiftComposerDraftRow, "endsAt">;
  createId?: () => string;
}

export interface ShiftComposerPresetRowOptions {
  preset: ShiftComposerPresetKey;
  eventStartsAt?: string;
  eventEndsAt?: string;
  label?: string;
  createId?: () => string;
}

const DEFAULT_SHIFT_MINUTES = 120;
const SETUP_START_OFFSET_MINUTES = -120;
const SETUP_END_OFFSET_MINUTES = -30;
const DOORS_START_OFFSET_MINUTES = -45;
const DOORS_END_OFFSET_MINUTES = 60;
const MAIN_END_OFFSET_MINUTES = 180;
const CLEANUP_END_OFFSET_MINUTES = 90;

function createDraftId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `draft-${Math.random().toString(36).slice(2, 10)}`
  );
}

function isValidDate(value?: string) {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function addMinutes(iso: string, minutes: number) {
  const next = new Date(iso);
  next.setMinutes(next.getMinutes() + minutes);
  return next.toISOString();
}

function getDefaultPresetLabel(preset: ShiftComposerPresetKey) {
  if (preset === "setup") return "Setup";
  if (preset === "doors") return "Doors";
  if (preset === "main") return "Main shift";
  return "Cleanup";
}

function hasFieldErrors(errors: ShiftComposerDraftRowErrors) {
  return Boolean(errors.startsAt || errors.endsAt || errors.capacity);
}

export const shiftComposerPresetOrder: ShiftComposerPresetKey[] = [
  "setup",
  "doors",
  "main",
  "cleanup",
];

export function createEmptyShiftComposerRow({
  eventStartsAt,
  previousRow,
  createId = createDraftId,
}: ShiftComposerCreateRowOptions = {}): ShiftComposerDraftRow {
  const seedStart =
    (previousRow?.endsAt &&
      isValidDate(previousRow.endsAt) &&
      previousRow.endsAt) ||
    (eventStartsAt && isValidDate(eventStartsAt) && eventStartsAt) ||
    undefined;

  return {
    id: createId(),
    startsAt: seedStart,
    endsAt: seedStart
      ? addMinutes(seedStart, DEFAULT_SHIFT_MINUTES)
      : undefined,
    label: "",
    capacity: "",
  };
}

export function duplicateShiftComposerRow(
  row: ShiftComposerDraftRow,
  createId: () => string = createDraftId,
): ShiftComposerDraftRow {
  return {
    ...row,
    id: createId(),
  };
}

function shiftIsoByDays(
  iso: string | undefined,
  dayOffset: number,
): string | undefined {
  if (!iso || !isValidDate(iso) || dayOffset === 0) return iso;
  const d = new Date(iso);
  d.setDate(d.getDate() + dayOffset);
  return d.toISOString();
}

/**
 * Build N copies of a draft row, each shifted by 1..N days from the
 * source. Used by the multi-day picker so an organizer can lay out the
 * same shift across consecutive days of a multi-day event in one click.
 *
 * Returns an empty array when `daysCount <= 0` or the source row has no
 * valid start/end (in which case duplication makes no sense — the user
 * should fix the source row first).
 */
export function repeatShiftComposerRowAcrossDays(
  row: ShiftComposerDraftRow,
  daysCount: number,
  createId: () => string = createDraftId,
): ShiftComposerDraftRow[] {
  if (daysCount <= 0) return [];
  if (!row.startsAt || !isValidDate(row.startsAt)) return [];

  const copies: ShiftComposerDraftRow[] = [];
  for (let offset = 1; offset <= daysCount; offset += 1) {
    copies.push({
      ...row,
      id: createId(),
      startsAt: shiftIsoByDays(row.startsAt, offset),
      endsAt: shiftIsoByDays(row.endsAt, offset),
    });
  }
  return copies;
}

export function createPresetShiftComposerRow({
  preset,
  eventStartsAt,
  eventEndsAt,
  label = getDefaultPresetLabel(preset),
  createId = createDraftId,
}: ShiftComposerPresetRowOptions): ShiftComposerDraftRow | null {
  if (!eventStartsAt || !isValidDate(eventStartsAt)) return null;

  const eventEndIsValid = isValidDate(eventEndsAt);

  if (preset === "setup") {
    return {
      id: createId(),
      label,
      capacity: "",
      startsAt: addMinutes(eventStartsAt, SETUP_START_OFFSET_MINUTES),
      endsAt: addMinutes(eventStartsAt, SETUP_END_OFFSET_MINUTES),
    };
  }

  if (preset === "doors") {
    return {
      id: createId(),
      label,
      capacity: "",
      startsAt: addMinutes(eventStartsAt, DOORS_START_OFFSET_MINUTES),
      endsAt: addMinutes(eventStartsAt, DOORS_END_OFFSET_MINUTES),
    };
  }

  if (preset === "main") {
    return {
      id: createId(),
      label,
      capacity: "",
      startsAt: eventStartsAt,
      endsAt: eventEndIsValid
        ? eventEndsAt
        : addMinutes(eventStartsAt, MAIN_END_OFFSET_MINUTES),
    };
  }

  const cleanupStart = eventEndIsValid
    ? eventEndsAt!
    : addMinutes(eventStartsAt, MAIN_END_OFFSET_MINUTES);

  return {
    id: createId(),
    label,
    capacity: "",
    startsAt: cleanupStart,
    endsAt: addMinutes(cleanupStart, CLEANUP_END_OFFSET_MINUTES),
  };
}

export function validateShiftComposerRow(
  row: ShiftComposerDraftRow,
): ShiftComposerDraftRowErrors {
  const errors: ShiftComposerDraftRowErrors = {};

  if (!row.startsAt || !isValidDate(row.startsAt)) {
    errors.startsAt = "required";
  }

  if (!row.endsAt || !isValidDate(row.endsAt)) {
    errors.endsAt = "required";
  }

  if (
    !errors.startsAt &&
    !errors.endsAt &&
    row.startsAt &&
    row.endsAt &&
    new Date(row.endsAt) <= new Date(row.startsAt)
  ) {
    errors.endsAt = "ends_before_start";
  }

  const trimmedCapacity = row.capacity.trim();
  if (trimmedCapacity !== "") {
    const parsedCapacity = Number(trimmedCapacity);
    if (
      !Number.isFinite(parsedCapacity) ||
      !Number.isInteger(parsedCapacity) ||
      parsedCapacity < 1
    ) {
      errors.capacity = "invalid_capacity";
    }
  }

  return errors;
}

export function rowHasErrors(errors: ShiftComposerDraftRowErrors) {
  return hasFieldErrors(errors);
}

export function toCreateShiftBatchItem(row: ShiftComposerDraftRow) {
  const trimmedLabel = row.label.trim();
  const trimmedCapacity = row.capacity.trim();

  return {
    label: trimmedLabel || null,
    startsAt: new Date(row.startsAt ?? ""),
    endsAt: new Date(row.endsAt ?? ""),
    capacity: trimmedCapacity === "" ? null : Number(trimmedCapacity),
  };
}
