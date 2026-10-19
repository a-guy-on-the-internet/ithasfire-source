import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { SupportAuthorType } from "@th/types/repos/support";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ── Goal ─────────────────────────────────────────────────────────────────────
// The thread OWNER marks the counterparty's messages as seen: stamp `readAt` on
// every message in the thread NOT authored by the user (authorType in
// HUMAN_AGENT / AI_CLERK / SYSTEM) that is currently unread. This is what clears
// the widget's unread badge.
//
// Authorization:
//   • ONLY the thread owner may mark their own thread read. Staff do NOT use
//     this (operator read-state is out of scope) — a non-owner is forbidden.
//
// Idempotency: calling twice is a no-op — the second call finds nothing unread.
//
// Audit: intentionally NO audit row. This is a benign, high-frequency, self-only
// action (fired on every poll/open) and an audit entry per read would be pure
// noise. The lightest peer precedent (send-support-message's reuse path) writes
// a message row with no audit; we follow that. We still run the write in a
// single repos.tx() per the one-mutation-one-transaction standard.

// Messages NOT authored by the user are the ones the owner can mark read.
const NON_USER_AUTHOR_TYPES: SupportAuthorType[] = [
  "HUMAN_AGENT",
  "AI_CLERK",
  "SYSTEM",
];

export const markThreadReadInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    threadId: z.string().uuid(),
  })
  .strict();

export const markThreadReadOutputSchema = z
  .object({
    /** Number of messages newly stamped read (0 on a no-op / idempotent call). */
    updated: z.number().int().nonnegative(),
  })
  .strict();

export type MarkThreadReadInput = z.infer<typeof markThreadReadInputSchema>;
export type MarkThreadReadOutput = z.infer<typeof markThreadReadOutputSchema>;

export type MarkThreadReadDeps = {
  repos: Pick<Repos, "tx" | "supportThreads">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function markThreadRead(
  deps: MarkThreadReadDeps,
  rawInput: unknown,
): Promise<MarkThreadReadOutput> {
  const input = parseInput(markThreadReadInputSchema, rawInput);
  const now = deps.clock.now();

  const thread = await deps.repos.supportThreads.getThreadById(input.threadId);
  if (!thread) {
    throw fail("THREAD_NOT_FOUND");
  }

  // Owner-only. Staff do not mark read state (out of scope), so this is a strict
  // ownership check — not the owner-or-staff pattern used by getMessages.
  // A null humanId (owner-less / GDPR-erased thread) matches no actor, so it can
  // never be marked read — fine, there's no owner left to do so.
  if (thread.humanId !== input.actorHumanId) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "thread" } });
  }

  // One mutation = one transaction. No audit row (see header note).
  const result = await deps.repos.tx(async (tx) =>
    tx.supportThreads.markMessagesRead({
      threadId: thread.id,
      authorTypes: NON_USER_AUTHOR_TYPES,
      readAt: now,
    }),
  );

  return markThreadReadOutputSchema.parse({ updated: result.updated });
}
