import { z } from "zod";

import {
  setEventTags,
  searchTags,
  getEventTags,
} from "@th/core/use-cases/tags";

import { publicProcedure, authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const tagSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const tagsRouter = {
  /** Set (replace) all tags on an event. Authed. */
  setEventTags: authedProcedure
    .input(
      z.object({
        eventId: z.string().uuid(),
        tags: z
          .array(
            z.object({
              slug: z.string().min(2).max(48),
              name: z.string().min(1).max(64),
            }),
          )
          .max(10),
      }),
    )
    .output(z.object({ eventId: z.string(), tags: z.array(tagSchema) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await setEventTags(
          {
            repos: ctx.repos,
            // Community moderators author ownerless listings in the SAME
            // EventBuilder; the use case branches on stewardship to admit
            // them.
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Search tags by prefix. Public. */
  search: publicProcedure
    .input(
      z.object({
        query: z.string().min(1).max(64),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .output(z.object({ tags: z.array(tagSchema) }))
    .query(async ({ ctx, input }) => {
      return searchTags({ repos: ctx.repos, logger: ctx.logger }, input);
    }),

  /** Get all tags for an event. Public. */
  getEventTags: publicProcedure
    .input(z.object({ eventId: z.string().uuid() }))
    .output(z.object({ tags: z.array(tagSchema) }))
    .query(async ({ ctx, input }) => {
      return getEventTags({ repos: ctx.repos, logger: ctx.logger }, input);
    }),
};
