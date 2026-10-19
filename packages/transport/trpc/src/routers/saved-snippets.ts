import { TRPCError } from "@trpc/server";

import {
  createSavedSnippet,
  createSavedSnippetInputSchema,
  createSavedSnippetOutputSchema,
  deleteSavedSnippet,
  deleteSavedSnippetInputSchema,
  deleteSavedSnippetOutputSchema,
  listSavedSnippets,
  listSavedSnippetsInputSchema,
  listSavedSnippetsOutputSchema,
  reorderSavedSnippets,
  reorderSavedSnippetsInputSchema,
  reorderSavedSnippetsOutputSchema,
  updateSavedSnippet,
  updateSavedSnippetInputSchema,
  updateSavedSnippetOutputSchema,
} from "@th/core/use-cases/saved-snippets";

import { authedProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// savedSnippets.* (booking-the-night FR-013, decision N18): an owner's saved
// reasons — the reason field's picker reads `list`; booking settings ("Reasons
// you often give") manage them. Thin pass-throughs: the owner is named as
// `{ kind: "self" | "org" | "place" }` and resolved + authorized in the use
// cases; `actorHumanId` is omitted from every client input and taken from ctx.
// The four writes share ONE per-actor bucket.
// ─────────────────────────────────────────────────────────────────────────────

const listInput = listSavedSnippetsInputSchema.omit({ actorHumanId: true });
const createInput = createSavedSnippetInputSchema.omit({ actorHumanId: true });
const updateInput = updateSavedSnippetInputSchema.omit({ actorHumanId: true });
const deleteInput = deleteSavedSnippetInputSchema.omit({ actorHumanId: true });
const reorderInput = reorderSavedSnippetsInputSchema.omit({ actorHumanId: true });

function requireActor(actorHumanId: string | null | undefined): string {
  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return actorHumanId;
}

/** Settings edits, drag-reorders included: generous, but bounded per actor. */
const writeLimited = () =>
  authedProcedure.use(
    rateLimit({
      key: (ctx) => `savedSnippets:write:${ctx.actorHumanId}`,
      maxRequests: 120,
      windowSeconds: 3600,
      message: "editing saved reasons",
    }),
  );

export const savedSnippetsRouter = {
  /**
   * The list (first use copies the platform starters). `maxBodyLength`
   * narrows it to reasons that fit the field (240 for an act's pass).
   */
  list: authedProcedure
    .input(listInput)
    .output(listSavedSnippetsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof listSavedSnippets>[0];

      try {
        return await listSavedSnippets(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  create: writeLimited()
    .input(createInput)
    .output(createSavedSnippetOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof createSavedSnippet>[0];

      try {
        return await createSavedSnippet(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  update: writeLimited()
    .input(updateInput)
    .output(updateSavedSnippetOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updateSavedSnippet>[0];

      try {
        return await updateSavedSnippet(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Idempotent: a reason already gone is `deleted: false`. */
  delete: writeLimited()
    .input(deleteInput)
    .output(deleteSavedSnippetOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof deleteSavedSnippet>[0];

      try {
        return await deleteSavedSnippet(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** `orderedIds` must be exactly the list; a stale order is CONFLICT. */
  reorder: writeLimited()
    .input(reorderInput)
    .output(reorderSavedSnippetsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof reorderSavedSnippets>[0];

      try {
        return await reorderSavedSnippets(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type SavedSnippetsRouter = typeof savedSnippetsRouter;
