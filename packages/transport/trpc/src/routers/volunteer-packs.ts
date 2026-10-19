import { TRPCError } from "@trpc/server";

import {
  listVolunteerPacks,
  listVolunteerPacksInputSchema,
  listVolunteerPacksOutputSchema,
} from "@th/core/use-cases/volunteering";
import {
  getVolunteerPackAdmin,
  getVolunteerPackAdminInputSchema,
  getVolunteerPackAdminOutputSchema,
  listVolunteerPacksAdmin,
  listVolunteerPacksAdminInputSchema,
  listVolunteerPacksAdminOutputSchema,
  removeVolunteerPack,
  removeVolunteerPackInputSchema,
  removeVolunteerPackOutputSchema,
  setVolunteerPackStatus,
  setVolunteerPackStatusInputSchema,
  setVolunteerPackStatusOutputSchema,
  upsertVolunteerPack,
  upsertVolunteerPackInputSchemaBase,
  upsertVolunteerPackOutputSchema,
} from "@th/core/use-cases/platform";

import { authedProcedure, router } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Volunteer packs — organizer catalogue + staff CRUD
//
// `list` is ORG-SCOPED and LIVE-only (the repo filters on pack status), so no
// organizer-facing procedure here can surface a DRAFT pack. Everything under
// `admin` is STAFF_TECH-gated INSIDE the use case — the procedures below are
// plain `authedProcedure`, exactly like the featured-items router, because the
// staff-role check belongs with the business rule, not the transport.
// ─────────────────────────────────────────────────────────────────────────────

function requireActor(ctx: { actorHumanId: string | null }): string {
  if (!ctx.actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return ctx.actorHumanId;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

const listInput = listVolunteerPacksInputSchema.omit({ actorHumanId: true });
const adminListInput = listVolunteerPacksAdminInputSchema.omit({
  actorHumanId: true,
});
const adminGetInput = getVolunteerPackAdminInputSchema.omit({
  actorHumanId: true,
});
// From the BASE (unrefined) schema — zod refuses `.omit()` on a refined one.
// The cross-field "no duplicate role names" rule still runs: the use case
// parses with the refined schema regardless of what the transport accepted.
const adminUpsertInput = upsertVolunteerPackInputSchemaBase.omit({
  actorHumanId: true,
});
const adminSetStatusInput = setVolunteerPackStatusInputSchema.omit({
  actorHumanId: true,
});
const adminRemoveInput = removeVolunteerPackInputSchema.omit({
  actorHumanId: true,
});

const adminRouter = router({
  list: authedProcedure
    .input(adminListInput)
    .output(listVolunteerPacksAdminOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listVolunteerPacksAdmin(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),

  /** Preview-as-organizer, DRAFT included (FR-016). STAFF_TECH, never status. */
  get: authedProcedure
    .input(adminGetInput)
    .output(getVolunteerPackAdminOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getVolunteerPackAdmin(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),

  upsert: authedProcedure
    .input(adminUpsertInput)
    .output(upsertVolunteerPackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        upsertVolunteerPack(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  setStatus: authedProcedure
    .input(adminSetStatusInput)
    .output(setVolunteerPackStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        setVolunteerPackStatus(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  remove: authedProcedure
    .input(adminRemoveInput)
    .output(removeVolunteerPackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        removeVolunteerPack(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        ),
      );
    }),
});

export const volunteerPacksRouter = {
  /** Organizer picker — LIVE packs with their roles, ranked (FR-013). */
  list: authedProcedure
    .input(listInput)
    .output(listVolunteerPacksOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listVolunteerPacks(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),

  admin: adminRouter,
};
