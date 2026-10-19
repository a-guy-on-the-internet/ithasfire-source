import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { supportThreadSchema } from "./schemas";

// ── Goal ─────────────────────────────────────────────────────────────────────
// Return the caller's current active (OPEN / AWAITING_HUMAN) support thread, or
// null when they have none. This is the widget's authoritative way to discover
// its thread, so localStorage stops being the source of truth (a stale/foreign
// stored threadId can otherwise be polled forever).
//
// Authorization is implicit: we only ever look up the caller's own threads by
// their authenticated humanId — never another human's. Read-only.

export const getMyActiveThreadInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
  })
  .strict();

export const getMyActiveThreadOutputSchema = z
  .object({
    thread: supportThreadSchema.nullable(),
  })
  .strict();

export type GetMyActiveThreadInput = z.infer<
  typeof getMyActiveThreadInputSchema
>;
export type GetMyActiveThreadOutput = z.infer<
  typeof getMyActiveThreadOutputSchema
>;

export type GetMyActiveThreadDeps = {
  repos: Pick<Repos, "supportThreads">;
  logger?: LoggerPort;
};

export async function getMyActiveThread(
  deps: GetMyActiveThreadDeps,
  rawInput: unknown,
): Promise<GetMyActiveThreadOutput> {
  const input = parseInput(getMyActiveThreadInputSchema, rawInput);

  const thread = await deps.repos.supportThreads.findActiveThreadByHuman(
    input.actorHumanId,
  );

  return getMyActiveThreadOutputSchema.parse({ thread: thread ?? null });
}
