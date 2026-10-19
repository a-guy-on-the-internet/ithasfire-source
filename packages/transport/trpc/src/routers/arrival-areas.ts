import { TRPCError } from "@trpc/server";

import {
  ARRIVAL_AREA_PARENT_MESSAGE,
  arrivalAreaRowSchema,
  createArrivalArea,
  createArrivalAreaInputObjectSchema,
  createArrivalAreaOutputSchema,
  exactlyOneArrivalAreaParent,
  listArrivalAreasForEditor,
  listArrivalAreasForEditorInputObjectSchema,
  listArrivalAreasForEditorOutputSchema,
  listArrivalAreasForEditorParentRefinement,
  listArrivalAreasForViewer,
  listArrivalAreasForViewerInputObjectSchema,
  listArrivalAreasForViewerOutputSchema,
  removeArrivalArea,
  removeArrivalAreaInputObjectSchema,
  removeArrivalAreaOutputSchema,
  reorderArrivalAreas,
  reorderArrivalAreasInputObjectSchema,
  reorderArrivalAreasOutputSchema,
  setEventArrivalAreaHidden,
  setEventArrivalAreaHiddenInputSchema,
  updateArrivalArea,
  updateArrivalAreaInputObjectSchema,
  updateArrivalAreaOutputSchema,
  type ListArrivalAreasForViewerOutput,
} from "@th/core/use-cases/arrival-areas";
import { getFeatureGates } from "@th/core/use-cases/features";
import { AppError, fail, isAppError } from "@th/errors";

import type { Ctx } from "../context";
import { hasFullEventReadAccessByEventId } from "../event-read-access";
import { authedProcedure, optionalProcedure } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// arrivalAreas.* (arrival-areas spec, plan step 6). Thin: parse, gate, call
// the use case, map the error. Every rule about WHO sees or edits an area
// lives in core (`list-arrival-areas-for-viewer`, `manage-arrival-areas`,
// `_shared/event-area-access`).
//
// FR-017: every procedure checks the `arrivalAreas` feature gate first. Off,
// the two public reads answer with no areas and everything else is
// ARRIVAL_AREA_NOT_FOUND, the answer an area nobody may see gets. Same
// posture as the ARRIVAL_AREA report subject (entity-reports.ts).
//
// Identity (`viewerHumanId` / `actorHumanId`) and the gate pass
// (`gateAccessGranted`) are SERVER-INJECTED. Each client input is the use
// case's UNREFINED object schema with those keys `.omit()`ted (zod 4 refuses
// `.omit` on a refined object), then the parent refinement re-applied.
// `.omit` keeps `.strict()`, so a client that sends one of them is refused
// with BAD_REQUEST (unrecognized_keys), never silently ignored.
//
// NFR-002: nothing here logs a geometry or a Directions point. The use cases
// log ids only; this file logs nothing.
//
// NFR-001 (revalidation): the place and event pages are both rendered
// dynamically today (the SSR tRPC clients call `headers()`), so there is no
// Next route cache for the API to purge, and the API cannot reach it anyway.
// The mutations below run on `authedProcedure`, whose last middleware bumps
// the API's shared public-read caches. The editor (plan step 8) owns the one
// remaining seam: after a PLACE area mutation it calls the existing
// authenticated `POST /api/places/[placeId]/revalidate`, whose authorization
// (`entityPages.getMyPage`: the place's managers, or a moderator on a place
// nobody owns) is the same bar as editing a place's areas. Every mutation's
// input already names its parent, so the editor knows the place id.
// ─────────────────────────────────────────────────────────────────────────────

/** What a viewer gets when there is nothing they may see. Never cached. */
const NO_AREAS: ListArrivalAreasForViewerOutput = {
  areas: [],
  cacheablePublic: false,
};

/** The FR-017 gate, resolved the way every other gated transport check is. */
async function arrivalAreasEnabled(ctx: Ctx): Promise<boolean> {
  const gates = await getFeatureGates({
    platformSettings: ctx.repos.platformSettings,
    reportError: ctx.reportError ?? undefined,
  });
  return gates.arrivalAreas === true;
}

async function ensureArrivalAreasEnabled(ctx: Ctx): Promise<void> {
  if (!(await arrivalAreasEnabled(ctx))) fail("ARRIVAL_AREA_NOT_FOUND");
}

function requireActor(ctx: Ctx): string {
  const actorHumanId = ctx.actorHumanId;
  if (!actorHumanId) throw new TRPCError({ code: "UNAUTHORIZED" });
  return actorHumanId;
}

/**
 * NFR-004's stale-write conflict carries `meta.current`, the row as it now
 * is. Core already sends it through the editor projection
 * (`projectAreaForEditor`: an editor who may not see the event's address gets
 * no geometry, note or price text). Re-parsed here against the editor row
 * schema, so only its known keys reach the wire, and dropped outright when it
 * does not parse or claims `geometryWithheld` while still carrying location
 * data. Fail closed: the editor re-reads the list either way.
 */
function toArrivalAreaTrpcError(err: unknown): TRPCError {
  if (
    isAppError(err) &&
    err.code === "ARRIVAL_AREA_CONFLICT" &&
    err.meta &&
    "current" in err.meta
  ) {
    const { current: raw, ...rest } = err.meta;
    const parsed = arrivalAreaRowSchema.safeParse(raw);
    const current =
      parsed.success &&
      (!parsed.data.geometryWithheld ||
        (parsed.data.geometry === null &&
          parsed.data.note === null &&
          parsed.data.priceText === null))
        ? parsed.data
        : undefined;
    return toTrpcError(
      new AppError("ARRIVAL_AREA_CONFLICT", {
        meta: current ? { ...rest, current } : rest,
      }),
    );
  }
  return toTrpcError(err);
}

// ── Client inputs ───────────────────────────────────────────────────────────

const listForPlaceInput = listArrivalAreasForViewerInputObjectSchema
  .omit({ viewerHumanId: true, gateAccessGranted: true, eventId: true })
  .required();

const listForEventInput = listArrivalAreasForViewerInputObjectSchema
  .omit({ viewerHumanId: true, gateAccessGranted: true, placeId: true })
  .required();

const listForEditorInput = listArrivalAreasForEditorInputObjectSchema
  .omit({ actorHumanId: true })
  .refine(listArrivalAreasForEditorParentRefinement, ARRIVAL_AREA_PARENT_MESSAGE);

const createInput = createArrivalAreaInputObjectSchema
  .omit({ actorHumanId: true })
  .refine(exactlyOneArrivalAreaParent, ARRIVAL_AREA_PARENT_MESSAGE);

const updateInput = updateArrivalAreaInputObjectSchema
  .omit({ actorHumanId: true })
  .refine(exactlyOneArrivalAreaParent, ARRIVAL_AREA_PARENT_MESSAGE);

const reorderInput = reorderArrivalAreasInputObjectSchema
  .omit({ actorHumanId: true })
  .refine(exactlyOneArrivalAreaParent, ARRIVAL_AREA_PARENT_MESSAGE);

const removeInput = removeArrivalAreaInputObjectSchema
  .omit({ actorHumanId: true })
  .refine(exactlyOneArrivalAreaParent, ARRIVAL_AREA_PARENT_MESSAGE);

const setHiddenInput = setEventArrivalAreaHiddenInputSchema.omit({
  actorHumanId: true,
});

// ── Deps ────────────────────────────────────────────────────────────────────

const viewerDeps = (ctx: Ctx) =>
  ({
    repos: ctx.repos,
    authz: ctx.authz,
    clock: ctx.clock,
    logger: ctx.logger,
    // The projection's fail-closed branch is a deliberate swallow.
    reportError: ctx.reportError ?? undefined,
  }) satisfies Parameters<typeof listArrivalAreasForViewer>[0];

const editorDeps = (ctx: Ctx) =>
  ({
    repos: ctx.repos,
    authz: ctx.authz,
    clock: ctx.clock,
    logger: ctx.logger,
  }) satisfies Parameters<typeof createArrivalArea>[0] &
    Parameters<typeof listArrivalAreasForEditor>[0] &
    Parameters<typeof setEventArrivalAreaHidden>[0];

// ── Router ──────────────────────────────────────────────────────────────────

export const arrivalAreasRouter = {
  /**
   * A place page's areas for this viewer (FR-008): the public kinds when the
   * place publishes its exact address, plus load-in and withheld-place areas
   * for its managers. `cacheablePublic` says whether the answer is exactly
   * the anonymous one.
   */
  listForPlace: optionalProcedure
    .input(listForPlaceInput)
    .output(listArrivalAreasForViewerOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        if (!(await arrivalAreasEnabled(ctx))) return NO_AREAS;
        return await listArrivalAreasForViewer(viewerDeps(ctx), {
          placeId: input.placeId,
          ...(ctx.actorHumanId ? { viewerHumanId: ctx.actorHumanId } : {}),
        });
      } catch (err) {
        throw toArrivalAreaTrpcError(err);
      }
    }),

  /**
   * An event page's areas for this viewer (FR-004, FR-008, FR-009). Per
   * viewer and uncached. The password / application gate pass is the SAME
   * `hasFullEventReadAccessByEventId` read `entityReports.submit` uses for an
   * ARRIVAL_AREA report, so what a viewer is shown and what they may report
   * cannot disagree. An event this viewer may not read at all answers as no
   * areas, exactly like an event that does not exist: no oracle.
   */
  listForEvent: optionalProcedure
    .input(listForEventInput)
    .output(listArrivalAreasForViewerOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        if (!(await arrivalAreasEnabled(ctx))) return NO_AREAS;
        let gateAccessGranted: boolean;
        try {
          gateAccessGranted = await hasFullEventReadAccessByEventId(
            ctx,
            input.eventId,
          );
        } catch (err) {
          if (isAppError(err) && err.code === "EVENT_NOT_FOUND") return NO_AREAS;
          throw err;
        }
        return await listArrivalAreasForViewer(viewerDeps(ctx), {
          eventId: input.eventId,
          gateAccessGranted,
          ...(ctx.actorHumanId ? { viewerHumanId: ctx.actorHumanId } : {}),
        });
      } catch (err) {
        throw toArrivalAreaTrpcError(err);
      }
    }),

  /**
   * The editor's read: `{ placeId }` for the place editor (its managers;
   * moderators on a place nobody owns), `{ eventId }` for the event editor
   * (the event's own areas plus the place areas this editor may see, each
   * with `hiddenForEvent`, and the FR-004 all-hidden warning).
   */
  listForEditor: authedProcedure
    .input(listForEditorInput)
    .output(listArrivalAreasForEditorOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        await ensureArrivalAreasEnabled(ctx);
        return await listArrivalAreasForEditor(editorDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toArrivalAreaTrpcError(err);
      }
    }),

  create: authedProcedure
    .input(createInput)
    .output(createArrivalAreaOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        await ensureArrivalAreasEnabled(ctx);
        return await createArrivalArea(editorDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toArrivalAreaTrpcError(err);
      }
    }),

  /** NFR-004: carries `expectedUpdatedAt`; a stale one is ARRIVAL_AREA_CONFLICT. */
  update: authedProcedure
    .input(updateInput)
    .output(updateArrivalAreaOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        await ensureArrivalAreasEnabled(ctx);
        return await updateArrivalArea(editorDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toArrivalAreaTrpcError(err);
      }
    }),

  /** `orderedIds` must be exactly the parent's areas; anything else is a conflict. */
  reorder: authedProcedure
    .input(reorderInput)
    .output(reorderArrivalAreasOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        await ensureArrivalAreasEnabled(ctx);
        return await reorderArrivalAreas(editorDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toArrivalAreaTrpcError(err);
      }
    }),

  /** Hard delete; the audit row stays (lifecycle). NFR-004 as for update. */
  remove: authedProcedure
    .input(removeInput)
    .output(removeArrivalAreaOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        await ensureArrivalAreasEnabled(ctx);
        return await removeArrivalArea(editorDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toArrivalAreaTrpcError(err);
      }
    }),

  /** Hide or show one place area on one event; answers with the event editor list. */
  setHiddenForEvent: authedProcedure
    .input(setHiddenInput)
    .output(listArrivalAreasForEditorOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      try {
        await ensureArrivalAreasEnabled(ctx);
        return await setEventArrivalAreaHidden(editorDeps(ctx), {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toArrivalAreaTrpcError(err);
      }
    }),
};
