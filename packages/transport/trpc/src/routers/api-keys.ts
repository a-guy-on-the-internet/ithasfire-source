import {
  createApiKey,
  createApiKeyInputSchema,
  createApiKeyOutputSchema,
  listApiKeys,
  listApiKeysInputSchema,
  listApiKeysOutputSchema,
  revokeApiKey,
  revokeApiKeyInputSchema,
} from "@th/core/use-cases/api-keys";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

export const apiKeysRouter = {
  create: authedProcedure
    .input(createApiKeyInputSchema.omit({ actorHumanId: true }))
    .output(createApiKeyOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createApiKey(
          {
            repos: ctx.repos,
            logger: ctx.logger,
          } satisfies Parameters<typeof createApiKey>[0],
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  list: authedProcedure
    .input(listApiKeysInputSchema.omit({ actorHumanId: true }))
    .output(listApiKeysOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listApiKeys(
          {
            repos: ctx.repos,
            logger: ctx.logger,
          } satisfies Parameters<typeof listApiKeys>[0],
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  revoke: authedProcedure
    .input(revokeApiKeyInputSchema.omit({ actorHumanId: true }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await revokeApiKey(
          {
            repos: ctx.repos,
            logger: ctx.logger,
          } satisfies Parameters<typeof revokeApiKey>[0],
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
