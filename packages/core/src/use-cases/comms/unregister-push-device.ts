import { z } from "zod";

import { fail } from "@th/errors";
import type { PushPort } from "@th/ports/comms/push";
import type { LoggerPort } from "@th/ports/logger";

import { parseInput } from "../../lib/io";

export const unregisterPushDeviceInputSchema = z
  .object({
    /**
     * Authenticated actor. Unregistration is scoped to the actor's own
     * devices — the transport injects this from the session and the schema is
     * `.strict()`, so a client can never pass someone else's `humanId`.
     */
    actorHumanId: z.string().uuid(),
    token: z.string().min(1).max(512),
  })
  .strict();

export const unregisterPushDeviceOutputSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export type UnregisterPushDeviceInput = z.infer<
  typeof unregisterPushDeviceInputSchema
>;
export type UnregisterPushDeviceOutput = z.infer<
  typeof unregisterPushDeviceOutputSchema
>;

export type UnregisterPushDeviceDeps = {
  /** Push port (Expo adapter in both containers). Optional so unwired test
   * environments surface a typed NOT_CONFIGURED instead of a crash. */
  push?: PushPort | null;
  logger?: LoggerPort;
};

/**
 * Disables a push device for the authenticated human (sign-out / opt-out).
 *
 * Idempotent: disabling an already-disabled or unknown token is a no-op that
 * still returns `ok`. The Expo adapter additionally disables ANY row holding
 * the same physical token (cross-account) — a push token is bound to one
 * device install, so once the device asks to stop, nothing should keep
 * delivering to it regardless of which account originally registered it.
 */
export async function unregisterPushDevice(
  deps: UnregisterPushDeviceDeps,
  rawInput: unknown,
): Promise<UnregisterPushDeviceOutput> {
  const logger = deps.logger?.child({ useCase: "unregisterPushDevice" });
  const input = parseInput(unregisterPushDeviceInputSchema, rawInput);

  if (!deps.push) {
    throw fail("NOT_CONFIGURED", { message: "push_not_configured" });
  }

  await deps.push.unregisterDevice({
    humanId: input.actorHumanId,
    token: input.token,
  });

  logger?.info("comms.push_device.unregistered", {
    humanId: input.actorHumanId,
  });

  return { ok: true } as const;
}
