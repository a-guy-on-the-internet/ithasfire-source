import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

/**
 * Self-scoped: the caller may only set their OWN preference. The transport
 * supplies the authenticated caller's `actingUserId` (the Human id); there is
 * no cross-user write path. `mode` is the narrowed web light/dark appearance.
 */
export const setThemePreferenceInputSchema = z
  .object({
    actingUserId: z.uuid(),
    mode: z.enum(["light", "dark"]),
  })
  .strict();

export const setThemePreferenceOutputSchema = z
  .object({
    mode: z.enum(["light", "dark"]),
  })
  .strict();

export type SetThemePreferenceInput = z.infer<
  typeof setThemePreferenceInputSchema
>;
export type SetThemePreferenceOutput = z.infer<
  typeof setThemePreferenceOutputSchema
>;

export type SetThemePreferenceDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/**
 * Persist the authenticated user's web light/dark mode preference so it syncs
 * across their devices. Idempotent (writing the same mode twice is a no-op
 * observably) and money-free. Mirrors the `update-human-profile` self-scoped
 * pattern: verify the human exists, then write for `actingUserId` only.
 */
export async function setThemePreference(
  deps: SetThemePreferenceDeps,
  rawInput: unknown,
): Promise<SetThemePreferenceOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "setThemePreference" });

  const execute = async () => {
    const input = parseInput(setThemePreferenceInputSchema, rawInput);

    const existing = await deps.repos.humans.getById(input.actingUserId);
    if (!existing) {
      throw fail("HUMAN_NOT_FOUND");
    }

    await deps.repos.humans.setThemeMode(input.actingUserId, input.mode);

    return { mode: input.mode };
  };

  if (scopedLogger) {
    return scopedLogger.withTime("setThemePreference", execute);
  }

  return execute();
}
