import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { UpdateHumanInput } from "@th/ports/repos/humans";
import { fail } from "@th/errors";

export const updateHumanProfileInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    phone: z.string().trim().optional(),
    billingAddress: z
      .object({
        line1: z.string().trim().min(1),
        line2: z.string().trim().optional(),
        city: z.string().trim().min(1),
        state: z.string().trim().min(1),
        postalCode: z.string().trim().min(1),
        country: z.string().trim().min(1),
      })
      .optional(),
  })
  .strict();

export const updateHumanProfileOutputSchema = z
  .object({
    success: z.boolean(),
  })
  .strict();

export type UpdateHumanProfileInput = z.infer<
  typeof updateHumanProfileInputSchema
>;
export type UpdateHumanProfileOutput = z.infer<
  typeof updateHumanProfileOutputSchema
>;

export type UpdateHumanProfileDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function updateHumanProfile(
  deps: UpdateHumanProfileDeps,
  rawInput: unknown,
): Promise<UpdateHumanProfileOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "updateHumanProfile" });

  const execute = async () => {
    const input = parseInput(updateHumanProfileInputSchema, rawInput);

    // Verify the human exists
    const existing = await deps.repos.humans.getById(input.actorHumanId);
    if (!existing) {
      throw fail("HUMAN_NOT_FOUND");
    }

    const updateData: UpdateHumanInput = {};

    if (input.phone !== undefined) {
      updateData.phone = input.phone || null;
    }

    if (input.billingAddress) {
      updateData.billingAddressLine1 = input.billingAddress.line1;
      updateData.billingAddressLine2 = input.billingAddress.line2 ?? null;
      updateData.billingCity = input.billingAddress.city;
      updateData.billingState = input.billingAddress.state;
      updateData.billingPostalCode = input.billingAddress.postalCode;
      updateData.billingCountry = input.billingAddress.country;
    }

    await deps.repos.humans.update(input.actorHumanId, updateData);

    return { success: true };
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateHumanProfile", execute);
  }

  return execute();
}
