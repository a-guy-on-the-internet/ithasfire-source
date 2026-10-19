import { z } from "zod";

import { fail } from "@th/errors";
import type { PushPort } from "@th/ports/comms/push";
import { pushPlatformSchema, pushProviderSchema } from "@th/ports/comms/push";
import type { LoggerPort } from "@th/ports/logger";

import { parseInput } from "../../lib/io";

export const registerPushDeviceInputSchema = z
  .object({
    /**
     * Authenticated actor. Devices are ALWAYS registered to the actor — the
     * transport injects this from the session and the schema is `.strict()`,
     * so a client can never smuggle a different target `humanId`.
     */
    actorHumanId: z.string().uuid(),
    provider: pushProviderSchema,
    // Expo push tokens are short (`ExponentPushToken[...]`); 512 is a generous
    // upper bound that still rejects garbage blobs at the boundary.
    token: z.string().min(1).max(512),
    platform: pushPlatformSchema.optional(),
    appId: z.string().min(1).max(256).optional(),
  })
  .strict();

export const registerPushDeviceOutputSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export type RegisterPushDeviceInput = z.infer<
  typeof registerPushDeviceInputSchema
>;
export type RegisterPushDeviceOutput = z.infer<
  typeof registerPushDeviceOutputSchema
>;

export type RegisterPushDeviceDeps = {
  /** Push port (Expo adapter in both containers). Optional so unwired test
   * environments surface a typed NOT_CONFIGURED instead of a crash. */
  push?: PushPort | null;
  logger?: LoggerPort;
};

/**
 * Registers (or refreshes) a push device for the authenticated human.
 *
 * Thin by design: token-format validation and persistence live behind the
 * PushPort — the Expo adapter rejects non-`expo` providers / malformed tokens
 * (`invalid_input`) and upserts on the `(provider, token)` unique key, so
 * re-registering the same device is an idempotent refresh (re-enable +
 * `lastSeenAt` bump) and a token that changes accounts is reassigned to the
 * new owner in place.
 */
export async function registerPushDevice(
  deps: RegisterPushDeviceDeps,
  rawInput: unknown,
): Promise<RegisterPushDeviceOutput> {
  const logger = deps.logger?.child({ useCase: "registerPushDevice" });
  const input = parseInput(registerPushDeviceInputSchema, rawInput);

  if (!deps.push) {
    throw fail("NOT_CONFIGURED", { message: "push_not_configured" });
  }

  await deps.push.registerDevice({
    humanId: input.actorHumanId,
    provider: input.provider,
    token: input.token,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.appId ? { appId: input.appId } : {}),
  });

  logger?.info("comms.push_device.registered", {
    humanId: input.actorHumanId,
    provider: input.provider,
    platform: input.platform ?? "unknown",
  });

  return { ok: true } as const;
}
