import type { EditorArrivalArea } from "@th/core/use-cases/arrival-areas";
import {
  ARRIVAL_AREA_LABEL_MAX,
  ARRIVAL_AREA_NOTE_MAX,
  ARRIVAL_AREA_PRICE_TEXT_MAX,
  MAX_ARRIVAL_AREA_DISTANCE_METERS,
} from "@th/core/lib/arrival-areas/limits";

import { getAppErrorCode } from "@/lib/app-error";

import type { VisibleArrivalArea } from "./arrival-areas";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for the arrival-areas editor (arrival-areas FR-001, FR-002,
// FR-005, FR-014, FR-016, NFR-004). No React, no map: what the editor
// decides, kept testable on its own.
//
// Core owns every rule. These helpers only mirror the limits for messages
// and shape the inputs; a save the server refuses is reported with the
// server's reason.
//
// NFR-002: nothing here logs a geometry or a point.
// ─────────────────────────────────────────────────────────────────────────────

export type { EditorArrivalArea };

export type ArrivalAreaKind = EditorArrivalArea["kind"];
export type ArrivalAreaCost = EditorArrivalArea["cost"];
export type ArrivalAreaShape = NonNullable<EditorArrivalArea["geometry"]>;

/**
 * Whose areas the editor edits. The place editor passes `{ placeId }`; the
 * event editor (plan step 8b) passes `{ eventId }` for event-only areas.
 */
export type ArrivalAreasEditorParent =
  | { placeId: string; eventId?: never }
  | { eventId: string; placeId?: never };

export const KIND_ORDER: readonly ArrivalAreaKind[] = [
  "PARKING",
  "ACCESSIBLE_DROP_OFF",
  "LOAD_IN",
];

export const COST_ORDER: readonly ArrivalAreaCost[] = ["FREE", "PAID", "UNKNOWN"];

export {
  ARRIVAL_AREA_LABEL_MAX,
  ARRIVAL_AREA_NOTE_MAX,
  ARRIVAL_AREA_PRICE_TEXT_MAX,
};

// ── Form ────────────────────────────────────────────────────────────────────

export type AreaFormFields = {
  kind: ArrivalAreaKind;
  label: string;
  cost: ArrivalAreaCost;
  priceText: string;
  note: string;
  accessibleSpots: boolean;
};

export function emptyFormFields(): AreaFormFields {
  return {
    kind: "PARKING",
    label: "",
    cost: "UNKNOWN",
    priceText: "",
    note: "",
    accessibleSpots: false,
  };
}

export function formFieldsFromArea(area: EditorArrivalArea): AreaFormFields {
  return {
    kind: area.kind,
    label: area.label,
    cost: area.cost,
    priceText: area.priceText ?? "",
    note: area.note ?? "",
    accessibleSpots: area.accessibleSpots,
  };
}

export type AreaFormErrors = {
  label?: "required" | "tooLong";
  priceText?: "tooLong";
  note?: "tooLong";
};

/**
 * The client half of FR-001, for the inline messages. The browser's
 * `maxLength` already stops typing past a limit; this catches a pasted or
 * blank label. Core re-checks everything on save.
 */
export function validateAreaForm(fields: AreaFormFields): AreaFormErrors {
  const errors: AreaFormErrors = {};
  const label = fields.label.trim();
  if (label.length === 0) errors.label = "required";
  else if (label.length > ARRIVAL_AREA_LABEL_MAX) errors.label = "tooLong";
  if (fields.priceText.trim().length > ARRIVAL_AREA_PRICE_TEXT_MAX) {
    errors.priceText = "tooLong";
  }
  if (fields.note.trim().length > ARRIVAL_AREA_NOTE_MAX) errors.note = "tooLong";
  return errors;
}

export function hasFormErrors(errors: AreaFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Price text only means something for a paid area; otherwise it is cleared. */
function cleanPriceText(fields: AreaFormFields): string | null {
  if (fields.cost !== "PAID") return null;
  const value = fields.priceText.trim();
  return value.length > 0 ? value : null;
}

function cleanNote(fields: AreaFormFields): string | null {
  const value = fields.note.trim();
  return value.length > 0 ? value : null;
}

// ── Draft (what the form is editing) ────────────────────────────────────────

export type AreaDraft = {
  /** Null while the area is new (not saved yet). */
  areaId: string | null;
  /** The row as last loaded: the dirty baseline and the NFR-004 token. */
  base: EditorArrivalArea | null;
  fields: AreaFormFields;
  geometry: ArrivalAreaShape | null;
  geometryDirty: boolean;
};

export function draftFromArea(area: EditorArrivalArea): AreaDraft {
  return {
    areaId: area.id,
    base: area,
    fields: formFieldsFromArea(area),
    geometry: area.geometry,
    geometryDirty: false,
  };
}

export function newDraft(geometry: ArrivalAreaShape): AreaDraft {
  return {
    areaId: null,
    base: null,
    fields: emptyFormFields(),
    geometry,
    geometryDirty: true,
  };
}

function sameFields(a: AreaFormFields, b: AreaFormFields): boolean {
  return (
    a.kind === b.kind &&
    a.label.trim() === b.label.trim() &&
    a.cost === b.cost &&
    // Price text is cleared for anything but PAID, so compare what is sent.
    (a.cost === "PAID" ? a.priceText.trim() : "") ===
      (b.cost === "PAID" ? b.priceText.trim() : "") &&
    a.note.trim() === b.note.trim() &&
    a.accessibleSpots === b.accessibleSpots
  );
}

/** A new area is always dirty; a loaded one when a field or its shape moved. */
export function isDraftDirty(draft: AreaDraft | null): boolean {
  if (!draft) return false;
  if (!draft.base) return true;
  if (draft.geometryDirty) return true;
  return !sameFields(draft.fields, formFieldsFromArea(draft.base));
}

// ── Mutation inputs ─────────────────────────────────────────────────────────

export type CreateAreaInput = ArrivalAreasEditorParent & {
  kind: ArrivalAreaKind;
  label: string;
  cost: ArrivalAreaCost;
  priceText: string | null;
  note: string | null;
  accessibleSpots: boolean;
  geometry: ArrivalAreaShape;
};

export function buildCreateInput(
  parent: ArrivalAreasEditorParent,
  fields: AreaFormFields,
  geometry: ArrivalAreaShape,
): CreateAreaInput {
  return {
    ...parent,
    kind: fields.kind,
    label: fields.label.trim(),
    cost: fields.cost,
    priceText: cleanPriceText(fields),
    note: cleanNote(fields),
    accessibleSpots: fields.accessibleSpots,
    geometry: roundGeometry(geometry),
  };
}

export type AreaPatch = {
  kind?: ArrivalAreaKind;
  label?: string;
  cost?: ArrivalAreaCost;
  priceText?: string | null;
  note?: string | null;
  accessibleSpots?: boolean;
  geometry?: ArrivalAreaShape;
};

/**
 * Only what changed (core's patch is partial: an omitted key is untouched,
 * `null` clears price text or note). Empty when nothing changed.
 */
export function buildUpdatePatch(draft: AreaDraft): AreaPatch {
  const patch: AreaPatch = {};
  const base = draft.base;
  const fields = draft.fields;
  const before = base ? formFieldsFromArea(base) : null;
  if (!before || fields.kind !== before.kind) patch.kind = fields.kind;
  if (!before || fields.label.trim() !== before.label.trim()) {
    patch.label = fields.label.trim();
  }
  if (!before || fields.cost !== before.cost) patch.cost = fields.cost;
  // A withheld row's price text and note came back null because this editor
  // may not read them: sending either would overwrite text they cannot see.
  if (!base?.geometryWithheld) {
    const priceText = cleanPriceText(fields);
    if (!base || priceText !== (base.priceText ?? null)) patch.priceText = priceText;
    const note = cleanNote(fields);
    if (!base || note !== (base.note ?? null)) patch.note = note;
  }
  if (!before || fields.accessibleSpots !== before.accessibleSpots) {
    patch.accessibleSpots = fields.accessibleSpots;
  }
  if (draft.geometryDirty && draft.geometry) {
    patch.geometry = roundGeometry(draft.geometry);
  }
  return patch;
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** ~1 cm. Terra Draw reports up to 9 decimals; nobody parks in a nanometre. */
const COORD_DECIMALS = 7;

function round(n: number): number {
  const f = 10 ** COORD_DECIMALS;
  return Math.round(n * f) / f;
}

export function roundGeometry(geometry: ArrivalAreaShape): ArrivalAreaShape {
  if (geometry.type === "LineString") {
    return {
      type: "LineString",
      coordinates: geometry.coordinates.map(
        ([lng, lat]) => [round(lng), round(lat)] as [number, number],
      ),
    };
  }
  return {
    type: "Polygon",
    coordinates: geometry.coordinates.map((ring) =>
      ring.map(([lng, lat]) => [round(lng), round(lat)] as [number, number]),
    ),
  };
}

/**
 * A Terra Draw geometry as an arrival-area shape, or null when it is not one
 * (a point, a polygon with holes, a malformed ring). Positions are trimmed to
 * `[lng, lat]`.
 */
export function shapeFromDrawGeometry(geometry: unknown): ArrivalAreaShape | null {
  if (!geometry || typeof geometry !== "object") return null;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  const toPosition = (p: unknown): [number, number] | null =>
    Array.isArray(p) &&
    typeof p[0] === "number" &&
    typeof p[1] === "number" &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1])
      ? [p[0], p[1]]
      : null;
  if (g.type === "LineString" && Array.isArray(g.coordinates)) {
    const coords = g.coordinates.map(toPosition);
    if (coords.length < 2 || coords.some((c) => c === null)) return null;
    return { type: "LineString", coordinates: coords as [number, number][] };
  }
  if (
    g.type === "Polygon" &&
    Array.isArray(g.coordinates) &&
    g.coordinates.length === 1 &&
    Array.isArray(g.coordinates[0])
  ) {
    const ring = (g.coordinates[0] as unknown[]).map(toPosition);
    if (ring.length < 4 || ring.some((c) => c === null)) return null;
    return { type: "Polygon", coordinates: [ring as [number, number][]] };
  }
  return null;
}

/** The step-7 display shape, so the editor draws saved areas the same way. */
export function toDisplayArea(area: EditorArrivalArea): VisibleArrivalArea {
  return {
    id: area.id,
    source: area.source,
    kind: area.kind,
    label: area.label,
    cost: area.cost,
    priceText: area.priceText,
    note: area.note,
    accessibleSpots: area.accessibleSpots,
    geometry: area.geometryWithheld ? null : area.geometry,
    directions: null,
  };
}

export type MapPin = { lat: number; lng: number };

export function usablePin(
  lat: number | null | undefined,
  lng: number | null | undefined,
): MapPin | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Whether the basemap's tiles cover the pin (`[west, south, east, north]`). */
export function pinInBounds(
  pin: MapPin,
  bounds: readonly number[] | null | undefined,
): boolean {
  if (!bounds || bounds.length !== 4) return true;
  const [west, south, east, north] = bounds as [number, number, number, number];
  if (![west, south, east, north].every(Number.isFinite)) return true;
  return (
    pin.lng >= west && pin.lng <= east && pin.lat >= south && pin.lat <= north
  );
}

// ── Reorder ─────────────────────────────────────────────────────────────────

/**
 * The ids with the one at `index` moved by `delta`, or null when the move
 * would leave the list. `reorder` takes EXACTLY the parent's areas, so the
 * whole list goes every time.
 */
export function moveId(
  ids: readonly string[],
  index: number,
  delta: -1 | 1,
): string[] | null {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) {
    return null;
  }
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as string);
  return next;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type ArrivalAreaErrorKind =
  | "conflict"
  | "notFound"
  | "limit"
  | "geometry"
  | "other";

export type DescribedAreaError = {
  kind: ArrivalAreaErrorKind;
  /** The message key to show, with its values. */
  key: string;
  values?: Record<string, string | number>;
  /** ARRIVAL_AREA_CONFLICT on update/remove: the row as it now is, if sent. */
  current?: EditorArrivalArea | null;
};

/** `data.meta` of a tRPC error, when it is an object. */
export function readErrorMeta(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const meta = (error as { data?: { meta?: unknown } }).data?.meta;
  return meta && typeof meta === "object"
    ? (meta as Record<string, unknown>)
    : null;
}

/** Copy key per `meta.reason` of ARRIVAL_AREA_INVALID_GEOMETRY. */
export const GEOMETRY_REASON_KEY: Record<string, string> = {
  INVALID_SHAPE: "arrivalAreasEditor.geomInvalidShape",
  NON_FINITE: "arrivalAreasEditor.geomOffTheMap",
  OUT_OF_RANGE: "arrivalAreasEditor.geomOffTheMap",
  TOO_MANY_POINTS: "arrivalAreasEditor.geomTooManyPoints",
  TOO_FEW_POINTS: "arrivalAreasEditor.geomTooFewPoints",
  NOT_CLOSED: "arrivalAreasEditor.geomNotClosed",
  SELF_INTERSECTING: "arrivalAreasEditor.geomSelfIntersecting",
  TOO_THIN: "arrivalAreasEditor.geomTooThin",
  CROSSES_ANTIMERIDIAN: "arrivalAreasEditor.geomCrossesAntimeridian",
  ZERO_LENGTH: "arrivalAreasEditor.geomZeroLength",
  OUTSIDE_ENVELOPE: "arrivalAreasEditor.geomOutsideEnvelope",
  NO_PIN: "arrivalAreasEditor.noPin",
};

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function geometryError(
  meta: Record<string, unknown> | null,
  context: ArrivalAreaErrorContext,
): DescribedAreaError {
  const reason = typeof meta?.reason === "string" ? meta.reason : "";
  const key = GEOMETRY_REASON_KEY[reason];
  if (!key) {
    return { kind: "geometry", key: "errors.arrivalAreaInvalidGeometry" };
  }
  switch (reason) {
    case "NO_PIN":
      // A withheld address is not fixed by setting one.
      return {
        kind: "geometry",
        key: context.addressWithheld ? "arrivalAreasEditor.noPinWithheld" : key,
      };
    case "TOO_MANY_POINTS":
      return {
        kind: "geometry",
        key,
        values: { count: num(meta?.count, 0), limit: num(meta?.limit, 200) },
      };
    case "TOO_FEW_POINTS":
      return { kind: "geometry", key, values: { minimum: num(meta?.minimum, 2) } };
    case "OUTSIDE_ENVELOPE": {
      const meters = num(meta?.limitMeters, MAX_ARRIVAL_AREA_DISTANCE_METERS);
      return {
        kind: "geometry",
        key,
        values: { km: Math.round((meters / 1000) * 10) / 10 },
      };
    }
    default:
      return { kind: "geometry", key };
  }
}

/** Parses `meta.current` defensively: a malformed one reads as absent. */
function readCurrent(meta: Record<string, unknown> | null): EditorArrivalArea | null {
  const raw = meta?.current;
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<EditorArrivalArea> & { updatedAt?: unknown };
  if (typeof row.id !== "string" || typeof row.label !== "string") return null;
  const updatedAt =
    row.updatedAt instanceof Date
      ? row.updatedAt
      : typeof row.updatedAt === "string"
        ? new Date(row.updatedAt)
        : null;
  if (!updatedAt || Number.isNaN(updatedAt.getTime())) return null;
  return { ...(row as EditorArrivalArea), updatedAt };
}

/**
 * One failed arrival-area mutation, as the editor reports it. Every
 * geometry reason gets its own copy; the generic geometry line is only the
 * fallback for a reason this build does not know.
 */
/** What the editor's list says that changes an error's copy. */
export type ArrivalAreaErrorContext = { addressWithheld?: boolean };

export function describeArrivalAreaError(
  error: unknown,
  context: ArrivalAreaErrorContext = {},
): DescribedAreaError {
  const code = getAppErrorCode(error);
  const meta = readErrorMeta(error);
  switch (code) {
    case "ARRIVAL_AREA_CONFLICT":
      return {
        kind: "conflict",
        key: "arrivalAreasEditor.conflictBody",
        current: readCurrent(meta),
      };
    case "ARRIVAL_AREA_NOT_FOUND":
      return { kind: "notFound", key: "errors.arrivalAreaNotFound" };
    case "ARRIVAL_AREA_LIMIT_REACHED":
      return {
        kind: "limit",
        key: "arrivalAreasEditor.limitReached",
        values: { limit: num(meta?.limit, 10) },
      };
    case "ARRIVAL_AREA_INVALID_GEOMETRY":
      return geometryError(meta, context);
    default:
      return { kind: "other", key: "" };
  }
}

// ── The editor list cache, after a mutation ─────────────────────────────────
//
// Each mutation's result is written into the `listForEditor` cache BEFORE the
// refetch, so nothing reads the pre-mutation list in between: not the clean
// draft's baseline (it would revert the form and arm a false conflict), not
// a row's Remove (a stale token), not a reorder (a list missing the new id).

/** What every arrival-area mutation returns (core `arrivalAreaRowSchema`). */
export type ArrivalAreaMutationRow = Pick<
  EditorArrivalArea,
  | "id"
  | "kind"
  | "label"
  | "cost"
  | "priceText"
  | "note"
  | "accessibleSpots"
  | "sortOrder"
  | "geometry"
  | "geometryWithheld"
  | "disabledAt"
  | "updatedAt"
> & { placeId: string | null };

/**
 * A mutation row as an editor row. The editor-only fields (`outsideEnvelope`,
 * `hiddenForEvent`) come from the row as it was listed; a new row has none
 * yet, and the refetch that follows fills them in.
 */
export function editorAreaFromRow(
  row: ArrivalAreaMutationRow,
  prev?: EditorArrivalArea | null,
): EditorArrivalArea {
  return {
    id: row.id,
    source: prev?.source ?? (row.placeId ? "PLACE" : "EVENT"),
    kind: row.kind,
    label: row.label,
    cost: row.cost,
    priceText: row.priceText,
    note: row.note,
    accessibleSpots: row.accessibleSpots,
    sortOrder: row.sortOrder,
    geometry: row.geometry,
    geometryWithheld: row.geometryWithheld,
    disabledAt: row.disabledAt,
    updatedAt: row.updatedAt,
    outsideEnvelope: prev?.outsideEnvelope ?? false,
    hiddenForEvent: prev?.hiddenForEvent ?? null,
  };
}

/** The list with one row created (appended) or updated (in place). */
export function upsertListedArea(
  areas: readonly EditorArrivalArea[],
  row: ArrivalAreaMutationRow,
): EditorArrivalArea[] {
  const index = areas.findIndex((a) => a.id === row.id);
  if (index === -1) return [...areas, editorAreaFromRow(row)];
  const next = [...areas];
  next[index] = editorAreaFromRow(row, areas[index]);
  return next;
}

/** The list without one row. */
export function removeListedArea(
  areas: readonly EditorArrivalArea[],
  id: string,
): EditorArrivalArea[] {
  return areas.filter((a) => a.id !== id);
}

/** The list in the order `reorder` returned, with each row's new token. */
export function reorderListedAreas(
  areas: readonly EditorArrivalArea[],
  rows: readonly ArrivalAreaMutationRow[],
): EditorArrivalArea[] {
  const byId = new Map(areas.map((a) => [a.id, a]));
  return [...rows]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => editorAreaFromRow(row, byId.get(row.id)));
}

/**
 * Whether a listed row should replace a CLEAN draft's baseline: only when it
 * is newer (a fresher token), or the same token with a re-measured
 * `outsideEnvelope`. An OLDER row is the pre-save list still in flight.
 */
export function listedRowSupersedes(
  row: EditorArrivalArea,
  base: EditorArrivalArea,
): "replace" | "envelope" | null {
  const listed = row.updatedAt.getTime();
  const held = base.updatedAt.getTime();
  if (listed > held) return "replace";
  if (listed === held && row.outsideEnvelope !== base.outsideEnvelope) {
    return "envelope";
  }
  return null;
}

/**
 * The Terra Draw mode for a tool. Not interactive (a save in flight, among
 * others) is Terra Draw's built-in render-only `static` mode: select mode
 * would still let a vertex be dragged, and the saved row would then replace
 * that reshape without a word.
 */
export function terraDrawModeFor<T extends string>(
  tool: T,
  interactive: boolean,
): T | "static" {
  return interactive ? tool : "static";
}

// ── Revalidation (NFR-001) ──────────────────────────────────────────────────

/**
 * Purges the place's public page after a PLACE-area change. Best effort and
 * fire-and-forget: the area is already saved, so a failure here must never
 * read as a failed edit. Same endpoint and posture as the booking toggle's
 * `purgePublicPage` (read `app/api/places/[placeId]/revalidate/route.ts`).
 */
export function revalidatePlacePage(placeId: string): void {
  try {
    void fetch(`/api/places/${encodeURIComponent(placeId)}/revalidate`, {
      method: "POST",
    }).catch(() => undefined);
  } catch {
    // fetch itself threw (no network stack): nothing to purge.
  }
}
