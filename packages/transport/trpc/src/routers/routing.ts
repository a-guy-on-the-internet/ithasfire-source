import {
  getTravelTime,
  getTravelTimeInputSchema,
  getTravelTimeOutputSchema,
} from "@th/core/use-cases/events";

import { optionalProcedure } from "../init";

export const routingRouter = {
  getTravelTime: optionalProcedure
    .input(getTravelTimeInputSchema)
    .output(getTravelTimeOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        routing: ctx.routing ?? undefined,
        logger: ctx.logger,
      } satisfies Parameters<typeof getTravelTime>[0];

      return getTravelTime(deps, input);
    }),
};
