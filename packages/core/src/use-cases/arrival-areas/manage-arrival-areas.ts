import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  ArrivalAreaGeometry,
  ArrivalAreaParent,
  ArrivalAreaRow,
  UpdateArrivalAreaPatch,
} from "@th/types/repos/arrival-areas";
import { fail } from "@th/errors";

import {
  arrivalAreaCostSchema,
  arrivalAreaFieldsSchema,
  arrivalAreaGeometrySchema,
  arrivalAreaKindSchema,
  validateArrivalAreaGeometry,
  type ArrivalAreaGeometryError,
  type ArrivalAreaPin,
} from "../../lib/arrival-areas/geometry";
import {
  ARRIVAL_AREA_LABEL_MAX,
  ARRIVAL_AREA_NOTE_MAX,
  ARRIVAL_AREA_PRICE_TEXT_MAX,
  MAX_ARRIVAL_AREAS_PER_EVENT,
  MAX_ARRIVAL_AREAS_PER_PLACE,
} from "../../lib/arrival-areas/limits";
import { parseInput } from "../../lib/io";
import {
  plainTextMultilineOptional,
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import type { EntityPageEditor } from "../entity-pages/entity-page-access";
import { ensureActorCanEditEvent } from "../events/_shared/ensure-actor-can-edit-event";
import {
  ARRIVAL_AREA_AUDIT_ACTIONS,
  ARRIVAL_AREA_AUDIT_ENTITY,
  arrivalAreaAuditPayload,
} from "./_shared/arrival-area-audit";
import {
  eventAreaPin,
  probeEventAreaStaff,
  projectAreaForEditor,
  resolveEventAreaAccess,
  type EditorAreaRow,
  type PrecomputedEventAreaStaff,
} from "./_shared/event-area-access";
import {
  placeAreaEditorView,
  recheckPlaceAreaEditor,
  resolvePlaceAreaEditor,
} from "./_shared/place-area-editor";

// ─────────────────────────────────────────────────────────────────────────────
// Arrival-area CRUD (arrival-areas FR-001..FR-005, FR-013, FR-014, NFR-004),
// mirroring use-cases/places/manage-spaces.ts.
//
// WHO (checked here, never trusted from the client):
//   · a PLACE's areas — its managing org / verified owner, or, for a place
//     nobody owns, a community moderator (./_shared/place-area-editor.ts);
//   · an EVENT's own areas — whoever may edit the event
//     (`ensureActorCanEditEvent`: org editors, the human owner and their
//     edit-role delegates; never a community listing). Works for events at
//     a place, at a saved location and at a freeform address.
//
// THE PIN (FR-005's 3 km envelope). A place area is measured from the
// place's true pin for its managers, and for a moderator only at a place
// that publishes its address; a moderator at a WITHHELD place gets NO_PIN
// and withheld rows (`placeAreaEditorView`, the event editors' option A). An
// event area is measured from the pin THIS actor may see (`eventAreaPin`):
// the true pin when they may see the exact address; NO_PIN at a withheld
// place whose address they cannot see. So OUTSIDE_ENVELOPE can never answer
// "within 3 km of the withheld house" for an organiser who cannot see it.
//
// OUTPUTS go through `projectAreaForEditor`: an editor who may not see the
// parent's address gets an area without its geometry
// (`geometryWithheld`), in results and in conflict meta alike.
//
// AUTHZ PROBES run before the transaction (`probeEventAreaStaff`); inside
// it only `tx` is read, so no root-pool connection is held under the lock.
//
// CONCURRENCY. Every mutation runs in ONE `repos.tx`, and takes
// `arrivalAreas.lockParent` (FOR NO KEY UPDATE on the Place / Event row)
// before it reads anything it decides on: the count before an insert (no
// two creates race past the limit), the row before a CAS update / delete,
// the set before a reorder. A moderator takes the place's claim lock first.
// Update and remove carry the row's `updatedAt` (NFR-004): a stale one is
// ARRIVAL_AREA_CONFLICT with the current row, never an overwrite.
//
// ISOLATION. The input names the parent; a row whose parent is not that one
// is ARRIVAL_AREA_NOT_FOUND, indistinguishable from a missing id.
//
// NFR-002: no logger line carries a geometry or a point; ids only.
// ─────────────────────────────────────────────────────────────────────────────

export type ManageArrivalAreasDeps = {
  repos: Repos;
  authz: Pick<
    AuthZPort,
    "requireOrgRole" | "canManagePlace" | "hasStaffRole" | "canEditEvent"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Schemas ─────────────────────────────────────────────────────────────────

export const arrivalAreaRowSchema = z.object({
  id: z.string(),
  placeId: z.string().nullable(),
  eventId: z.string().nullable(),
  kind: arrivalAreaKindSchema,
  /** Null when withheld from this editor (`geometryWithheld`). */
  geometry: arrivalAreaGeometrySchema.nullable(),
  /**
   * TRUE when this editor may not see the parent's exact address (an event
   * editor at a withheld place, a moderator at a withheld place): the row is
   * theirs to read and remove, its shape is not (security F1, option A).
   */
  geometryWithheld: z.boolean(),
  label: z.string(),
  cost: arrivalAreaCostSchema,
  priceText: z.string().nullable(),
  note: z.string().nullable(),
  accessibleSpots: z.boolean(),
  sortOrder: z.number().int(),
  disabledAt: z.date().nullable(),
  createdByHumanId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * The parent, `placeId` XOR `eventId`, and the actor.
 * `actorHumanId` is SERVER-INJECTED (ctx): the transport must `.omit()` it
 * from its client-facing input.
 */
const parentShape = {
  actorHumanId: z.string().uuid(),
  placeId: z.string().uuid().optional(),
  eventId: z.string().uuid().optional(),
};

/**
 * The parent refinement, exported with each unrefined `*InputObjectSchema`
 * so the transport can `.omit({ actorHumanId: true }).refine(...)` (zod 4
 * refuses `.omit` on a refined object).
 */
export const exactlyOneArrivalAreaParent = <
  T extends { placeId?: string; eventId?: string },
>(
  v: T,
) => (v.placeId === undefined) !== (v.eventId === undefined);

export const ARRIVAL_AREA_PARENT_MESSAGE = {
  message: "exactly one of placeId or eventId",
};

const exactlyOneParent = exactlyOneArrivalAreaParent;
const PARENT_MESSAGE = ARRIVAL_AREA_PARENT_MESSAGE;

/** Raw GeoJSON: validated by `validateArrivalAreaGeometry`, which needs the pin. */
const rawGeometry = z.unknown();

/** The concurrency token (NFR-004). A Date (superjson) or an ISO string. */
const updatedAtToken = z.coerce.date();

export const createArrivalAreaInputObjectSchema = z
  .object({
    ...parentShape,
    ...arrivalAreaFieldsSchema.shape,
    geometry: rawGeometry,
    /** Defaults to the end of the parent's list. */
    sortOrder: z.number().int().min(0).max(1_000).optional(),
  })
  .strict();

export const createArrivalAreaInputSchema = createArrivalAreaInputObjectSchema.refine(
  exactlyOneParent,
  PARENT_MESSAGE,
);

export type CreateArrivalAreaUseCaseInput = z.infer<
  typeof createArrivalAreaInputSchema
>;
export const createArrivalAreaOutputSchema = arrivalAreaRowSchema;

/**
 * A partial patch: omitted keys are untouched, `null` clears priceText /
 * note. Written out rather than `.partial()` of the field schema, whose
 * defaults (cost UNKNOWN, accessibleSpots false) and empty-to-null transform
 * would turn an omitted key into a write.
 */
export const arrivalAreaPatchSchema = z
  .object({
    kind: arrivalAreaKindSchema.optional(),
    label: plainTextRequired(ARRIVAL_AREA_LABEL_MAX).optional(),
    cost: arrivalAreaCostSchema.optional(),
    priceText: plainTextOptional(ARRIVAL_AREA_PRICE_TEXT_MAX)
      .nullable()
      .optional(),
    note: plainTextMultilineOptional(ARRIVAL_AREA_NOTE_MAX)
      .nullable()
      .optional(),
    accessibleSpots: z.boolean().optional(),
    geometry: rawGeometry.optional(),
  })
  .strict();

export const updateArrivalAreaInputObjectSchema = z
  .object({
    ...parentShape,
    arrivalAreaId: z.string().uuid(),
    expectedUpdatedAt: updatedAtToken,
    patch: arrivalAreaPatchSchema,
  })
  .strict();

export const updateArrivalAreaInputSchema = updateArrivalAreaInputObjectSchema.refine(
  exactlyOneParent,
  PARENT_MESSAGE,
);

export type UpdateArrivalAreaUseCaseInput = z.infer<
  typeof updateArrivalAreaInputSchema
>;
export const updateArrivalAreaOutputSchema = arrivalAreaRowSchema;

export const reorderArrivalAreasInputObjectSchema = z
  .object({
    ...parentShape,
    /** EXACTLY the parent's areas, each once, in the new order. */
    orderedIds: z.array(z.string().uuid()).max(50),
  })
  .strict();

export const reorderArrivalAreasInputSchema = reorderArrivalAreasInputObjectSchema.refine(
  exactlyOneParent,
  PARENT_MESSAGE,
);

export type ReorderArrivalAreasUseCaseInput = z.infer<
  typeof reorderArrivalAreasInputSchema
>;
export const reorderArrivalAreasOutputSchema = z.array(arrivalAreaRowSchema);

export const removeArrivalAreaInputObjectSchema = z
  .object({
    ...parentShape,
    arrivalAreaId: z.string().uuid(),
    expectedUpdatedAt: updatedAtToken,
  })
  .strict();

export const removeArrivalAreaInputSchema = removeArrivalAreaInputObjectSchema.refine(
  exactlyOneParent,
  PARENT_MESSAGE,
);

export type RemoveArrivalAreaUseCaseInput = z.infer<
  typeof removeArrivalAreaInputSchema
>;
export const removeArrivalAreaOutputSchema = z
  .object({ id: z.string(), removed: z.literal(true) })
  .strict();
export type RemoveArrivalAreaOutput = z.infer<
  typeof removeArrivalAreaOutputSchema
>;

// ── Shared steps ────────────────────────────────────────────────────────────

type ParentInput = { placeId?: string; eventId?: string };

function parentOf(input: ParentInput): ArrivalAreaParent {
  return input.placeId !== undefined
    ? { placeId: input.placeId }
    : { eventId: input.eventId as string };
}

function parentLabel(parent: ArrivalAreaParent): "place" | "event" {
  return parent.placeId !== undefined ? "place" : "event";
}

function parentIds(parent: ArrivalAreaParent): {
  placeId: string | null;
  eventId: string | null;
} {
  return {
    placeId: parent.placeId ?? null,
    eventId: parent.eventId ?? null,
  };
}

/** Whether `row` hangs off `parent`. A foreign row is "not found". */
function belongsTo(row: ArrivalAreaRow, parent: ArrivalAreaParent): boolean {
  return parent.placeId !== undefined
    ? row.placeId === parent.placeId
    : row.eventId === parent.eventId;
}

/** The advisory, pre-transaction authorization (fails fast, takes no lock). */
type Authorized =
  | { parent: "place"; editor: EntityPageEditor }
  | { parent: "event"; staff: PrecomputedEventAreaStaff };

async function authorize(
  deps: ManageArrivalAreasDeps,
  parent: ArrivalAreaParent,
  actorHumanId: string,
): Promise<Authorized> {
  if (parent.placeId !== undefined) {
    return {
      parent: "place",
      editor: await resolvePlaceAreaEditor(deps, parent.placeId, actorHumanId),
    };
  }
  const event = await ensureActorCanEditEvent(
    deps.repos,
    parent.eventId,
    actorHumanId,
  );
  // The root-pool authz probes run HERE, before the transaction: inside it
  // they would hold a second connection while this one holds the Event row
  // lock (pool starvation; see venue-manager-stamp.ts).
  return {
    parent: "event",
    staff: await probeEventAreaStaff(deps.authz, {
      actorHumanId,
      eventId: parent.eventId,
      placeId: event.placeId ?? null,
    }),
  };
}

type LockedParent = {
  /** The pin this actor's shapes are measured against; null = NO_PIN. */
  pin: ArrivalAreaPin | null;
  editorKind: EntityPageEditor["kind"] | "event_editor";
  /** Whether this actor may see the parent's exact address (shapes in outputs). */
  addressVisible: boolean;
};

/**
 * Inside the transaction: the moderator recheck (claim lock first), then
 * `lockParent`, then the AUTHORITATIVE reads every decision uses: the place
 * row (pin) or the event row (editor check + pin).
 */
async function lockParentAndRecheck(
  tx: TxRepos,
  parent: ArrivalAreaParent,
  authorized: Authorized,
  actorHumanId: string,
  now: Date,
): Promise<LockedParent> {
  if (parent.placeId !== undefined) {
    if (authorized.parent !== "place") throw fail("NOT_RESOURCE_OWNER");
    await recheckPlaceAreaEditor(tx, authorized.editor, now);
    if (!(await tx.arrivalAreas.lockParent(parent))) {
      throw fail("PLACE_NOT_FOUND", { meta: { placeId: parent.placeId } });
    }
    const place = await tx.places.getById(parent.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND", { meta: { placeId: parent.placeId } });
    }
    // Decided on the row read under the parent lock: the true pin for an
    // owner; for a moderator only when the place publishes its address.
    const view = placeAreaEditorView(authorized.editor, place);
    return {
      pin: view.pin,
      editorKind: authorized.editor.kind,
      addressVisible: view.addressVisible,
    };
  }

  if (authorized.parent !== "event") throw fail("INSUFFICIENT_ROLE");
  if (!(await tx.arrivalAreas.lockParent(parent))) {
    throw fail("EVENT_NOT_FOUND");
  }
  // Re-checked on the locked row (through `tx`, no root-pool read): an owner
  // change that committed after the advisory check is seen here.
  const event = await ensureActorCanEditEvent(tx, parent.eventId, actorHumanId);
  // The Place row is read, not locked. A place switching to withheld in the
  // window between this read and commit is a tiny race, accepted: the next
  // read (editor list, viewer projection) applies the new mode.
  const place = event.placeId ? await tx.places.getById(event.placeId) : null;
  const access = await resolveEventAreaAccess(
    { repos: tx },
    {
      event,
      place,
      viewerHumanId: actorHumanId,
      // An event editor is past the event's own gate.
      gateAccessGranted: true,
      now,
      // Probed before the transaction. `placeStaff` counts only if the
      // locked row still names the probed place; editing was just
      // re-verified on the locked row above.
      precomputedStaff: { ...authorized.staff, eventStaff: true },
    },
  );
  return {
    pin: eventAreaPin(event, place, access.addressVisible),
    editorKind: "event_editor",
    addressVisible: access.addressVisible,
  };
}

/**
 * FR-005 at save time. The refusal names the rule and its limit
 * (`meta.reason` + the error's own limit fields) and never a coordinate.
 */
function validatedGeometryOrThrow(
  raw: unknown,
  pin: ArrivalAreaPin | null,
): ArrivalAreaGeometry {
  const result = validateArrivalAreaGeometry(raw, pin);
  if (result.ok) return result.geometry;
  const { code, ...limits } = result.error as ArrivalAreaGeometryError &
    Record<string, unknown>;
  throw fail("ARRIVAL_AREA_INVALID_GEOMETRY", {
    meta: { reason: code, ...limits },
  });
}

/** The current row goes back through the editor projection (F1). */
function conflict(current: ArrivalAreaRow, addressVisible: boolean): never {
  throw fail("ARRIVAL_AREA_CONFLICT", {
    meta: { current: projectAreaForEditor(current, addressVisible) },
  });
}

function notFound(arrivalAreaId: string): never {
  throw fail("ARRIVAL_AREA_NOT_FOUND", { meta: { arrivalAreaId } });
}

/** Two stored shapes are the same shape (canonical JSON of the validated form). */
function sameGeometry(a: unknown, b: ArrivalAreaGeometry): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

const emptyToNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value.length === 0 ? null : value;

// ── Create ──────────────────────────────────────────────────────────────────

export async function createArrivalArea(
  deps: ManageArrivalAreasDeps,
  rawInput: unknown,
): Promise<EditorAreaRow> {
  const input = parseInput(createArrivalAreaInputSchema, rawInput);
  const parent = parentOf(input);
  const authorized = await authorize(deps, parent, input.actorHumanId);
  const now = deps.clock.now();

  const created = await deps.repos.tx(async (tx) => {
    const locked = await lockParentAndRecheck(
      tx,
      parent,
      authorized,
      input.actorHumanId,
      now,
    );
    const geometry = validatedGeometryOrThrow(input.geometry, locked.pin);

    // FR-005: counted UNDER the parent lock, so two creates cannot both see 9.
    const isPlace = parent.placeId !== undefined;
    const limit = isPlace
      ? MAX_ARRIVAL_AREAS_PER_PLACE
      : MAX_ARRIVAL_AREAS_PER_EVENT;
    const count = isPlace
      ? await tx.arrivalAreas.countForPlace(parent.placeId as string)
      : await tx.arrivalAreas.countForEvent(parent.eventId as string);
    if (count >= limit) {
      throw fail("ARRIVAL_AREA_LIMIT_REACHED", {
        meta: { limit, parent: parentLabel(parent) },
      });
    }

    const row = await tx.arrivalAreas.create({
      ...parent,
      kind: input.kind,
      geometry,
      label: input.label,
      cost: input.cost,
      priceText: input.priceText,
      note: input.note,
      accessibleSpots: input.accessibleSpots,
      sortOrder: input.sortOrder ?? count,
      createdByHumanId: input.actorHumanId,
    });
    await tx.audit.log({
      entity: ARRIVAL_AREA_AUDIT_ENTITY,
      entityId: row.id,
      action: ARRIVAL_AREA_AUDIT_ACTIONS.created,
      data: {
        actorHumanId: input.actorHumanId,
        editorKind: locked.editorKind,
        ...parentIds(parent),
        before: null,
        after: arrivalAreaAuditPayload(row),
      },
      at: now,
    });
    return projectAreaForEditor(row, locked.addressVisible);
  });

  deps.logger?.info("arrival_area_created", {
    arrivalAreaId: created.id,
    ...parentIds(parent),
  });
  return created;
}

// ── Update ──────────────────────────────────────────────────────────────────

/**
 * Edits fields and/or the shape. A NEW shape is validated against the
 * actor's pin (as on create) and, when it differs from the stored one,
 * switches a disabled event area back on (`disabledAt: null`): FR-014 keeps
 * an area off after its event changed place or address "until the organiser
 * repositions or removes" it, and moving it is the repositioning. Re-sending
 * the identical shape does not re-enable it; editing only the label or note
 * never does.
 */
export async function updateArrivalArea(
  deps: ManageArrivalAreasDeps,
  rawInput: unknown,
): Promise<EditorAreaRow> {
  const input = parseInput(updateArrivalAreaInputSchema, rawInput);
  const parent = parentOf(input);
  const authorized = await authorize(deps, parent, input.actorHumanId);
  const now = deps.clock.now();

  const updated = await deps.repos.tx(async (tx) => {
    const locked = await lockParentAndRecheck(
      tx,
      parent,
      authorized,
      input.actorHumanId,
      now,
    );
    const existing = await tx.arrivalAreas.getById(input.arrivalAreaId);
    if (!existing || !belongsTo(existing, parent)) {
      notFound(input.arrivalAreaId);
    }

    const { geometry: rawGeom, priceText, note, ...fields } = input.patch;
    const patch: UpdateArrivalAreaPatch = { ...fields };
    const cleanedPriceText = emptyToNull(priceText);
    if (cleanedPriceText !== undefined) patch.priceText = cleanedPriceText;
    const cleanedNote = emptyToNull(note);
    if (cleanedNote !== undefined) patch.note = cleanedNote;
    if (rawGeom !== undefined) {
      const geometry = validatedGeometryOrThrow(rawGeom, locked.pin);
      patch.geometry = geometry;
      if (existing.disabledAt !== null && !sameGeometry(existing.geometry, geometry)) {
        patch.disabledAt = null;
      }
    }

    const result = await tx.arrivalAreas.update(input.arrivalAreaId, patch, {
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    if (result.status === "not_found") notFound(input.arrivalAreaId);
    if (result.status === "conflict") {
      // The CAS refused; the row stays as it is. Never a foreign row: the
      // parent was asserted above, under the parent lock.
      conflict(result.current, locked.addressVisible);
    }

    await tx.audit.log({
      entity: ARRIVAL_AREA_AUDIT_ENTITY,
      entityId: input.arrivalAreaId,
      action: ARRIVAL_AREA_AUDIT_ACTIONS.updated,
      data: {
        actorHumanId: input.actorHumanId,
        editorKind: locked.editorKind,
        ...parentIds(parent),
        fields: Object.keys(patch).sort(),
        before: arrivalAreaAuditPayload(existing),
        after: arrivalAreaAuditPayload(result.row),
      },
      at: now,
    });
    return projectAreaForEditor(result.row, locked.addressVisible);
  });

  deps.logger?.info("arrival_area_updated", {
    arrivalAreaId: updated.id,
    ...parentIds(parent),
  });
  return updated;
}

// ── Reorder ─────────────────────────────────────────────────────────────────

export async function reorderArrivalAreas(
  deps: ManageArrivalAreasDeps,
  rawInput: unknown,
): Promise<EditorAreaRow[]> {
  const input = parseInput(reorderArrivalAreasInputSchema, rawInput);
  const parent = parentOf(input);
  const authorized = await authorize(deps, parent, input.actorHumanId);
  const now = deps.clock.now();

  const rows = await deps.repos.tx(async (tx) => {
    const locked = await lockParentAndRecheck(
      tx,
      parent,
      authorized,
      input.actorHumanId,
      now,
    );
    const before = (
      parent.placeId !== undefined
        ? await tx.arrivalAreas.listForPlace(parent.placeId)
        : await tx.arrivalAreas.listForEvent(parent.eventId as string)
    ).map((row) => row.id);

    const result = await tx.arrivalAreas.reorder(parent, input.orderedIds);
    if (result.status === "mismatch") {
      throw fail("ARRIVAL_AREA_CONFLICT", {
        meta: { currentIds: result.currentIds },
      });
    }

    await tx.audit.log({
      entity: parentLabel(parent),
      entityId: parent.placeId ?? parent.eventId,
      action: ARRIVAL_AREA_AUDIT_ACTIONS.reordered,
      data: {
        actorHumanId: input.actorHumanId,
        editorKind: locked.editorKind,
        ...parentIds(parent),
        before,
        after: result.rows.map((row) => row.id),
      },
      at: now,
    });
    return result.rows.map((row) =>
      projectAreaForEditor(row, locked.addressVisible),
    );
  });

  deps.logger?.info("arrival_areas_reordered", {
    ...parentIds(parent),
    count: rows.length,
  });
  return rows;
}

// ── Remove ──────────────────────────────────────────────────────────────────

/**
 * Hard delete (lifecycle: hard delete, audit row kept). The event hides that
 * pointed at a place area go with it (FK CASCADE).
 */
export async function removeArrivalArea(
  deps: ManageArrivalAreasDeps,
  rawInput: unknown,
): Promise<RemoveArrivalAreaOutput> {
  const input = parseInput(removeArrivalAreaInputSchema, rawInput);
  const parent = parentOf(input);
  const authorized = await authorize(deps, parent, input.actorHumanId);
  const now = deps.clock.now();

  await deps.repos.tx(async (tx) => {
    const locked = await lockParentAndRecheck(
      tx,
      parent,
      authorized,
      input.actorHumanId,
      now,
    );
    const existing = await tx.arrivalAreas.getById(input.arrivalAreaId);
    if (!existing || !belongsTo(existing, parent)) {
      notFound(input.arrivalAreaId);
    }

    const result = await tx.arrivalAreas.delete(input.arrivalAreaId, {
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    if (result.status === "not_found") notFound(input.arrivalAreaId);
    if (result.status === "conflict") {
      conflict(result.current, locked.addressVisible);
    }

    await tx.audit.log({
      entity: ARRIVAL_AREA_AUDIT_ENTITY,
      entityId: input.arrivalAreaId,
      action: ARRIVAL_AREA_AUDIT_ACTIONS.removed,
      data: {
        actorHumanId: input.actorHumanId,
        editorKind: locked.editorKind,
        ...parentIds(parent),
        before: arrivalAreaAuditPayload(result.row),
        after: null,
      },
      at: now,
    });
  });

  deps.logger?.info("arrival_area_removed", {
    arrivalAreaId: input.arrivalAreaId,
    ...parentIds(parent),
  });
  return { id: input.arrivalAreaId, removed: true };
}
