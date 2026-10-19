import { TRPCError } from "@trpc/server";

import {
  getTicketPackAdmin,
  getTicketPackAdminInputSchema,
  getTicketPackAdminOutputSchema,
  listTicketPacksAdmin,
  listTicketPacksAdminInputSchema,
  listTicketPacksAdminOutputSchema,
  removeTicketPack,
  removeTicketPackInputSchema,
  removeTicketPackOutputSchema,
  setTicketPackStatus,
  setTicketPackStatusInputSchema,
  setTicketPackStatusOutputSchema,
  upsertTicketPack,
  upsertTicketPackInputSchemaBase,
  upsertTicketPackOutputSchema,
} from "@th/core/use-cases/platform";

import { authedProcedure, router } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Ticket packs — staff CRUD (ticket-type-packs spec FR-012)
//
// Mounted UNDER the platform router (`platform.ticketPacks.*`) so every
// procedure here inherits the wholesale staff second-factor gate in
// guard.ts (`path.startsWith("platform.")`) — deliberately NOT the top-level
// placement `volunteerPacks.admin.*` uses, which sits outside that gate.
// Every use case additionally gates on STAFF_TECH inside core; the organizer
// -facing catalogue read is the FR-006 union in
// `ticketTypeTemplates.listTicketTypeTemplates`, not here.
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

const listInput = listTicketPacksAdminInputSchema.omit({ actorHumanId: true });
const getInput = getTicketPackAdminInputSchema.omit({ actorHumanId: true });
// From the BASE (unrefined) schema — zod refuses `.omit()` on a refined one.
// The cross-field "no duplicate template names" rule still runs: the use
// case parses with the refined schema regardless of what the transport
// accepted.
const upsertInput = upsertTicketPackInputSchemaBase.omit({
  actorHumanId: true,
});
const setStatusInput = setTicketPackStatusInputSchema.omit({
  actorHumanId: true,
});
const removeInput = removeTicketPackInputSchema.omit({ actorHumanId: true });

export const ticketPacksRouter = router({
  list: authedProcedure
    .input(listInput)
    .output(listTicketPacksAdminOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        listTicketPacksAdmin(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),

  /** Preview-as-organizer, DRAFT included. STAFF_TECH, never status. */
  get: authedProcedure
    .input(getInput)
    .output(getTicketPackAdminOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        getTicketPackAdmin(
          { repos: ctx.repos, authz: ctx.authz, logger: ctx.logger },
          { ...input, actorHumanId },
        ),
      );
    }),

  upsert: authedProcedure
    .input(upsertInput)
    .output(upsertTicketPackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        upsertTicketPack(
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
    .input(setStatusInput)
    .output(setTicketPackStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        setTicketPackStatus(
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
    .input(removeInput)
    .output(removeTicketPackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        removeTicketPack(
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
