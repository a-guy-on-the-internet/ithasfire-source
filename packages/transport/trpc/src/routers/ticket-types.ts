import { TRPCError } from "@trpc/server";
import {
  upsertTicketType,
  upsertTicketTypeInputSchema,
  upsertTicketTypeOutputSchema,
} from "@th/core/use-cases/ticket-types/upsert-ticket-type";
import {
  updateTicketType,
  updateTicketTypeInputSchema,
  updateTicketTypeOutputSchema,
} from "@th/core/use-cases/ticket-types/update-ticket-type";
import {
  deleteTicketType,
  deleteTicketTypeInputSchema,
  deleteTicketTypeOutputSchema,
} from "@th/core/use-cases/ticket-types/delete-ticket-type";

import { getFeatureGates } from "@th/core/use-cases/features";

import { authedProcedure } from "../init";
import type { Ctx } from "../context";
import { toTrpcError } from "../utils";

/**
 * Resolve the `resale` feature gate exactly like `ensureResaleEnabled` in the
 * resale router (DB override ?? env `ENABLE_RESALE` ?? false, fail-closed on a
 * settings-read failure). Unlike the resale money paths this does NOT throw —
 * ticket-type edits are perfectly legitimate while resale is dark. Instead the
 * mutations below CLAMP the resale fields so a direct tRPC call can't
 * configure resale while the gate is off (the client editor already hides the
 * controls; this is the server-side belt-and-braces):
 *
 * - CREATE: force `resaleAllowed: false`, `resaleCapCents: null`.
 * - UPDATE: DROP the incoming resale fields so the STORED values are
 *   preserved. Forcing false here would be data-destructive — an unrelated
 *   capacity/price edit would silently flip an existing `true` to `false`.
 *   The client editor deliberately preserves stored resale state on edit, and
 *   the server matches.
 */
async function isResaleEnabled(ctx: Ctx): Promise<boolean> {
  const gates = await getFeatureGates({
    enableResale: ctx.enableResale,
    platformSettings: ctx.repos.platformSettings,
    reportError: ctx.reportError ?? undefined,
  });
  return gates.resale;
}

const upsertTicketTypeInput = upsertTicketTypeInputSchema.omit({
  actorHumanId: true,
});
const updateTicketTypeInput = updateTicketTypeInputSchema.omit({
  actorHumanId: true,
});
const deleteTicketTypeInput = deleteTicketTypeInputSchema.omit({
  actorHumanId: true,
});

export const ticketTypesRouter = {
  upsertTicketType: authedProcedure
    .input(upsertTicketTypeInput)
    .output(upsertTicketTypeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // Surfaces a swallowed per-scope failure in the fee-policy walk.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof upsertTicketType>[0];

      // Gate-off clamp (create): resale can never be configured on a new
      // ticket type while the `resale` gate is off — see isResaleEnabled.
      const effectiveInput = (await isResaleEnabled(ctx))
        ? input
        : { ...input, resaleAllowed: false, resaleCapCents: null };

      try {
        return await upsertTicketType(deps, {
          ...effectiveInput,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  updateTicketType: authedProcedure
    .input(updateTicketTypeInput)
    .output(updateTicketTypeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Best-effort reindex so the card badge reflects the new price/total.
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof updateTicketType>[0];

      // Gate-off clamp (update): drop the incoming resale fields so the
      // stored values are preserved (never force-false) — see isResaleEnabled.
      let effectiveInput: typeof input = input;
      if (!(await isResaleEnabled(ctx))) {
        const {
          resaleAllowed: _resaleAllowed,
          resaleCapCents: _resaleCapCents,
          ...rest
        } = input;
        effectiveInput = rest;
      }

      try {
        return await updateTicketType(deps, {
          ...effectiveInput,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  deleteTicketType: authedProcedure
    .input(deleteTicketTypeInput)
    .output(deleteTicketTypeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        clock: ctx.clock,
      } satisfies Parameters<typeof deleteTicketType>[0];

      try {
        return await deleteTicketType(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type TicketTypesRouter = typeof ticketTypesRouter;
