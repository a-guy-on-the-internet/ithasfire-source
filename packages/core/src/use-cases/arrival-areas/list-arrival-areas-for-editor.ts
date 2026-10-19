import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { ArrivalAreaRow } from "@th/types/repos/arrival-areas";
import { fail } from "@th/errors";

import {
  areaOutsideEnvelope,
  arrivalAreaCostSchema,
  arrivalAreaGeometrySchema,
  arrivalAreaKindSchema,
  validateArrivalAreaShape,
  type ArrivalAreaPin,
} from "../../lib/arrival-areas/geometry";
import {
  MAX_ARRIVAL_AREAS_PER_EVENT,
  MAX_ARRIVAL_AREAS_PER_PLACE,
} from "../../lib/arrival-areas/limits";
import { parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "../events/_shared/ensure-actor-can-edit-event";
import {
  eventAreaPin,
  finitePin,
  kindAllowedBy,
  projectAreaForEditor,
  resolveEventAreaAccess,
} from "./_shared/event-area-access";
import {
  placeAreaEditorView,
  resolvePlaceAreaEditor,
} from "./_shared/place-area-editor";

// ─────────────────────────────────────────────────────────────────────────────
// The editor's read (arrival-areas FR-002..FR-004, FR-014). Uncached and
// per-actor; authorization is the mutation's own:
//
//   · PLACE (its managers; moderators on an unowned place): every area of
//     the place, switched-off included, each with `outsideEnvelope` — TRUE
//     when any point lies beyond 3 km of the place's CURRENT pin (FR-014:
//     the place moved, the manager checks the flagged areas). A moderator
//     at a place that WITHHOLDS its address gets the rows with geometry,
//     note and price text withheld, nothing measured and no pin
//     (`placeAreaEditorView`: the event editors' option A).
//   · EVENT (its editors): the event's own areas, switched-off included
//     (FR-014), each with `outsideEnvelope` against the pin THIS editor's
//     shapes are measured from (`eventAreaPin`, the save-time rule). Plus the
//     place's areas with `hiddenForEvent`, ONLY when this editor may see the
//     place's exact address (`resolveEventAreaAccess`, the projection's own
//     rule): an editor at a withheld place they do not manage sees none of
//     the place's shapes. The place's LOAD_IN follows the same rule as the
//     public read (for an editor: its managers, or any editor of a show the
//     place vouched for, owner ruling Q3). `allPublicHidden` is
//     the FR-004 warning: the event has public place areas, the organiser
//     hid all of them, and none of its own public areas is switched on.
//
// NFR-002: nothing here logs a geometry.
// ─────────────────────────────────────────────────────────────────────────────

export const listArrivalAreasForEditorInputObjectSchema = z
  .object({
    /** Server-injected (ctx); the transport must `.omit()` it from client input. */
    actorHumanId: z.string().uuid(),
    placeId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
  })
  .strict();

/** Exactly one of placeId / eventId (exported for `.omit(...).refine(...)` at the transport). */
export const listArrivalAreasForEditorParentRefinement = (v: { placeId?: string; eventId?: string }) =>
  (v.placeId === undefined) !== (v.eventId === undefined);

export const listArrivalAreasForEditorInputSchema = listArrivalAreasForEditorInputObjectSchema.refine(
  listArrivalAreasForEditorParentRefinement,
  { message: "exactly one of placeId or eventId" },
);

export type ListArrivalAreasForEditorInput = z.infer<
  typeof listArrivalAreasForEditorInputSchema
>;

export const editorArrivalAreaSchema = z
  .object({
    id: z.string(),
    source: z.enum(["PLACE", "EVENT"]),
    kind: arrivalAreaKindSchema,
    label: z.string(),
    cost: arrivalAreaCostSchema,
    priceText: z.string().nullable(),
    note: z.string().nullable(),
    accessibleSpots: z.boolean(),
    sortOrder: z.number().int(),
    /**
     * Null when the stored shape is malformed (flagged `outsideEnvelope`), or
     * withheld from this editor (`geometryWithheld`).
     */
    geometry: arrivalAreaGeometrySchema.nullable(),
    /**
     * TRUE for an area whose address this editor may not see: an event area
     * after its place became withheld, or a place area for a moderator at a
     * withheld place. Listed so it can be removed, never drawn (security
     * F1, option A).
     */
    geometryWithheld: z.boolean(),
    /** FR-014: switched off after the event changed place or address. */
    disabledAt: z.date().nullable(),
    /** The concurrency token update / remove carry (NFR-004). */
    updatedAt: z.date(),
    /** FR-014: some point is beyond 3 km of the pin (or the shape is unreadable). */
    outsideEnvelope: z.boolean(),
    /** Event editor, place areas only: hidden on this event. Else null. */
    hiddenForEvent: z.boolean().nullable(),
  })
  .strict();

export type EditorArrivalArea = z.infer<typeof editorArrivalAreaSchema>;

/** A measuring pin (`finitePin`; zod 4 numbers are finite). */
const editorPinSchema = z
  .object({ lat: z.number(), lng: z.number() })
  .strict();

export const listArrivalAreasForEditorOutputSchema = z.discriminatedUnion(
  "parent",
  [
    z
      .object({
        parent: z.literal("place"),
        placeId: z.string(),
        editorKind: z.enum(["owner", "community_moderator"]),
        /**
         * The pin this editor's shapes are measured against (FR-005): the
         * place's true pin for an owner, and for a moderator at a place that
         * publishes its address. Null when the place has no pin, or for a
         * moderator at a withheld place (they draw nothing: NO_PIN).
         */
        pin: editorPinSchema.nullable(),
        /**
         * TRUE only when the place withholds its address from THIS editor (a
         * moderator at a non-EXACT place). False for a place that simply has
         * no coordinates, so the editor can tell "set the address first"
         * from "this place hides its address".
         */
        addressWithheld: z.boolean(),
        areas: z.array(editorArrivalAreaSchema),
        limit: z.number().int(),
      })
      .strict(),
    z
      .object({
        parent: z.literal("event"),
        eventId: z.string(),
        /**
         * The pin this editor's event-only areas are measured against
         * (`eventAreaPin`, the save-time rule): the true pin when they may
         * see the exact address, the event's public pin otherwise, null where
         * they draw nothing (a withheld place they cannot see: NO_PIN).
         */
        pin: editorPinSchema.nullable(),
        /**
         * TRUE when this editor may not see the event's exact address
         * (`resolveEventAreaAccess`'s `addressVisible` is false): its own
         * areas come withheld and `pin` is null or the public pin.
         */
        addressWithheld: z.boolean(),
        /** The event's own areas. */
        areas: z.array(editorArrivalAreaSchema),
        /** The place's areas this editor may see, each with `hiddenForEvent`. */
        placeAreas: z.array(editorArrivalAreaSchema),
        /** FR-004 editor warning (saving is still allowed). */
        allPublicHidden: z.boolean(),
        limit: z.number().int(),
      })
      .strict(),
  ],
);

export type ListArrivalAreasForEditorOutput = z.infer<
  typeof listArrivalAreasForEditorOutputSchema
>;

export type ListArrivalAreasForEditorDeps = {
  repos: Repos;
  authz: Pick<
    AuthZPort,
    "requireOrgRole" | "canManagePlace" | "hasStaffRole" | "canEditEvent"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

function toEditorArea(
  row: ArrivalAreaRow,
  source: "PLACE" | "EVENT",
  pin: ArrivalAreaPin | null,
  hiddenForEvent: boolean | null,
  addressVisible = true,
): EditorArrivalArea {
  const projected = projectAreaForEditor(row, addressVisible);
  const shape = projected.geometryWithheld
    ? null
    : validateArrivalAreaShape(row.geometry);
  return {
    id: row.id,
    source,
    kind: row.kind,
    label: row.label,
    cost: row.cost,
    priceText: projected.priceText ?? null,
    note: projected.note ?? null,
    accessibleSpots: row.accessibleSpots === true,
    sortOrder: row.sortOrder,
    geometry: shape?.ok ? shape.geometry : null,
    geometryWithheld: projected.geometryWithheld,
    disabledAt: row.disabledAt ?? null,
    updatedAt: row.updatedAt,
    // A withheld shape is not measured: the answer would describe it.
    outsideEnvelope: projected.geometryWithheld
      ? false
      : areaOutsideEnvelope(row, pin),
    hiddenForEvent,
  };
}

const isPublicKind = (kind: string) =>
  kind === "PARKING" || kind === "ACCESSIBLE_DROP_OFF";

/**
 * The event editor's view of one event. Exported for
 * set-event-arrival-area-hidden, which answers with it after its write
 * (the caller has already authorized the actor as the event's editor).
 */
export async function buildEventEditorList(
  deps: {
    repos: Repos;
    authz: Pick<AuthZPort, "canManagePlace" | "canEditEvent">;
    clock: ClockPort;
  },
  eventId: string,
  actorHumanId: string,
): Promise<Extract<ListArrivalAreasForEditorOutput, { parent: "event" }>> {
  const event = await ensureActorCanEditEvent(deps.repos, eventId, actorHumanId);
  const place: PlaceRecord | null = event.placeId
    ? await deps.repos.places.getById(event.placeId)
    : null;
  const access = await resolveEventAreaAccess(deps, {
    event,
    place,
    viewerHumanId: actorHumanId,
    gateAccessGranted: true,
    now: deps.clock.now(),
  });
  const pin = eventAreaPin(event, place, access.addressVisible);

  const eventRows = (await deps.repos.arrivalAreas.listForEvent(event.id)).filter(
    (row) => row.eventId === event.id,
  );
  const areas = eventRows.map((row) =>
    toEditorArea(row, "EVENT", pin, null, access.addressVisible),
  );

  let placeAreas: EditorArrivalArea[] = [];
  if (place && place.id === event.placeId && access.addressVisible) {
    const [placeRows, hides] = await Promise.all([
      deps.repos.arrivalAreas.listForPlace(place.id),
      deps.repos.arrivalAreas.listHidesForEvent(event.id),
    ]);
    const hidden = new Set(hides);
    const placePin = finitePin(place.lat, place.lng);
    placeAreas = placeRows
      .filter(
        (row) =>
          row.placeId === place.id &&
          kindAllowedBy({ ...row, source: "PLACE" }, access.grants),
      )
      .map((row) => toEditorArea(row, "PLACE", placePin, hidden.has(row.id)));
  }

  const publicPlaceAreas = placeAreas.filter((a) => isPublicKind(a.kind));
  const ownPublicOn = areas.some(
    (a) => isPublicKind(a.kind) && a.disabledAt === null,
  );
  const allPublicHidden =
    publicPlaceAreas.length > 0 &&
    publicPlaceAreas.every((a) => a.hiddenForEvent === true) &&
    !ownPublicOn;

  return {
    parent: "event",
    eventId: event.id,
    pin,
    addressWithheld: !access.addressVisible,
    areas,
    placeAreas,
    allPublicHidden,
    limit: MAX_ARRIVAL_AREAS_PER_EVENT,
  };
}

export async function listArrivalAreasForEditor(
  deps: ListArrivalAreasForEditorDeps,
  rawInput: unknown,
): Promise<ListArrivalAreasForEditorOutput> {
  const input = parseInput(listArrivalAreasForEditorInputSchema, rawInput);

  if (input.eventId !== undefined) {
    return listArrivalAreasForEditorOutputSchema.parse(
      await buildEventEditorList(deps, input.eventId, input.actorHumanId),
    );
  }

  const placeId = input.placeId as string;
  const editor = await resolvePlaceAreaEditor(deps, placeId, input.actorHumanId);
  const place = await deps.repos.places.getById(placeId);
  if (!place) throw fail("PLACE_NOT_FOUND", { meta: { placeId } });
  // The mutation's own rule (manage-arrival-areas reads it on the locked row).
  const view = placeAreaEditorView(editor, place);
  const rows = (await deps.repos.arrivalAreas.listForPlace(place.id)).filter(
    (row) => row.placeId === place.id,
  );
  return listArrivalAreasForEditorOutputSchema.parse({
    parent: "place",
    placeId: place.id,
    editorKind: editor.kind,
    pin: view.pin,
    addressWithheld: !view.addressVisible,
    areas: rows.map((row) =>
      toEditorArea(row, "PLACE", view.pin, null, view.addressVisible),
    ),
    limit: MAX_ARRIVAL_AREAS_PER_PLACE,
  });
}
