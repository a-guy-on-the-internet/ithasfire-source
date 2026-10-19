import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const recordVerifiedEventPasswordUnlockInputSchema = z
  .object({
    eventId: z.uuid(),
    humanId: z.uuid(),
  })
  .strict();

export const recordVerifiedEventPasswordUnlockOutputSchema = z
  .object({
    eventId: z.uuid(),
    humanId: z.uuid(),
    persisted: z.literal(true),
  })
  .strict();

export type RecordVerifiedEventPasswordUnlockInput = z.infer<
  typeof recordVerifiedEventPasswordUnlockInputSchema
>;
export type RecordVerifiedEventPasswordUnlockOutput = z.infer<
  typeof recordVerifiedEventPasswordUnlockOutputSchema
>;

export type RecordVerifiedEventPasswordUnlockDeps = {
  repos: Pick<Repos, "events" | "eventUnlocks">;
  logger?: LoggerPort;
};

export async function recordVerifiedEventPasswordUnlock(
  deps: RecordVerifiedEventPasswordUnlockDeps,
  rawInput: unknown,
): Promise<RecordVerifiedEventPasswordUnlockOutput> {
  const input = parseInput(recordVerifiedEventPasswordUnlockInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (event.gateType !== "PASSWORD") {
    throw fail("EVENT_NOT_PASSWORD_GATED");
  }

  await deps.repos.eventUnlocks.upsert({
    eventId: input.eventId,
    humanId: input.humanId,
    source: "PASSWORD",
    metadata: { proof: "signed_cookie" },
  });

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: input.eventId,
    action: "password_unlock_persisted",
    result: "success",
    viewerHumanId: input.humanId,
    source: "signed_cookie",
  });

  return recordVerifiedEventPasswordUnlockOutputSchema.parse({
    eventId: input.eventId,
    humanId: input.humanId,
    persisted: true,
  });
}
