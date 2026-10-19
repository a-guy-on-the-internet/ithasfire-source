import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import {
  SUPPORT_MESSAGE_MAX,
  supportMessageSchema,
  supportThreadSchema,
  type NotifySupportFn,
} from "./schemas";

// ── Goal ─────────────────────────────────────────────────────────────────────
// Append a USER message to the caller's active support thread (creating one if
// none exists), bump lastMessageAt, and best-effort ping support on a NEW
// thread. Sign-in only: the thread always carries the caller's humanId.

export const sendSupportMessageInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    body: plainTextMultilineRequired(SUPPORT_MESSAGE_MAX),
    eventId: z.string().uuid().optional(),
    orderId: z.string().uuid().optional(),
  })
  .strict();

export const sendSupportMessageOutputSchema = z
  .object({
    thread: supportThreadSchema,
    message: supportMessageSchema,
  })
  .strict();

export type SendSupportMessageInput = z.infer<
  typeof sendSupportMessageInputSchema
>;
export type SendSupportMessageOutput = z.infer<
  typeof sendSupportMessageOutputSchema
>;

export type SendSupportMessageDeps = {
  repos: Pick<Repos, "tx" | "supportThreads">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort support notifier (Discord). Optional; failures are swallowed. */
  notifySupport?: NotifySupportFn | null;
};

export async function sendSupportMessage(
  deps: SendSupportMessageDeps,
  rawInput: unknown,
): Promise<SendSupportMessageOutput> {
  const input = parseInput(sendSupportMessageInputSchema, rawInput);
  const now = deps.clock.now();

  // Reuse the caller's active (OPEN / AWAITING_HUMAN) thread if one exists, so
  // a human keeps a single live conversation rather than spawning a thread per
  // message. Authorization is implicit: we only ever look up the caller's own
  // threads by their authenticated humanId.
  const existing = await deps.repos.supportThreads.findActiveThreadByHuman(
    input.actorHumanId,
  );

  let thread = existing;
  let isNewThread = !existing;
  let message: SendSupportMessageOutput["message"];

  if (existing) {
    // Reuse path: a single append write, no thread row to create — no tx
    // needed (a momentary lag on lastMessageAt only affects inbox sort).
    message = await deps.repos.supportThreads.appendMessage({
      threadId: existing.id,
      authorType: "USER",
      authorHumanId: input.actorHumanId,
      body: input.body,
      lastMessageAt: now,
    });
  } else {
    // First-message path: create the thread AND its first message atomically
    // in one tx so a failed append can never leave behind an empty OPEN thread
    // (which the partial unique index would then make un-reopenable).
    try {
      const created = await deps.repos.tx(async (tx) => {
        const newThread = await tx.supportThreads.createThread({
          humanId: input.actorHumanId,
          eventId: input.eventId ?? null,
          orderId: input.orderId ?? null,
          status: "OPEN",
          source: "WIDGET",
          lastMessageAt: now,
        });
        const firstMessage = await tx.supportThreads.appendMessage({
          threadId: newThread.id,
          authorType: "USER",
          authorHumanId: input.actorHumanId,
          body: input.body,
          lastMessageAt: now,
        });
        return { thread: newThread, message: firstMessage };
      });
      thread = created.thread;
      message = created.message;
    } catch (err: unknown) {
      // P2002 = the partial unique index (one active thread per human, raw SQL
      // in 20260623130000_support_thread_one_active_per_human) rejected a
      // concurrent first message. The tx rolled back, so a racing send already
      // created the active thread — re-read it and append to that one instead
      // of failing, keeping the conversation single-threaded under concurrency.
      const isUniqueViolation =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2002";

      if (!isUniqueViolation) {
        throw err;
      }

      const winner = await deps.repos.supportThreads.findActiveThreadByHuman(
        input.actorHumanId,
      );
      if (!winner) {
        // Unique violation but no active thread on re-read — surface the
        // original error rather than silently swallowing it.
        throw err;
      }

      deps.logger?.info("support.send_message.race_reused_thread", {
        threadId: winner.id,
        humanId: input.actorHumanId,
      });

      thread = winner;
      // The winner already owns the thread, so this is no longer a "new
      // thread" send — don't double-fire the new-thread alert.
      isNewThread = false;

      message = await deps.repos.supportThreads.appendMessage({
        threadId: winner.id,
        authorType: "USER",
        authorHumanId: input.actorHumanId,
        body: input.body,
        lastMessageAt: now,
      });
    }
  }

  // `thread` is non-null here: either the reused existing thread, the freshly
  // created one, or the race winner.
  if (!thread) {
    throw fail("SUPPORT_THREAD_UNAVAILABLE");
  }

  // Reflect the bumped activity timestamp on the returned thread without an
  // extra read.
  const threadOut = { ...thread, lastMessageAt: now };

  // Best-effort alert on a NEW thread only (NFR-002: don't ping on every
  // message). Fire-and-forget so Discord delivery never sits on the user's
  // request path; the message is already committed. The `.catch` keeps any
  // rejection from surfacing (NFR-003: never throws into the request path).
  // The notifier itself is also best-effort, but we double-guard.
  if (isNewThread && deps.notifySupport) {
    void deps
      .notifySupport({
        reason: "new_thread",
        threadId: thread.id,
        humanId: input.actorHumanId,
        eventId: threadOut.eventId,
        orderId: threadOut.orderId,
      })
      .catch((error) => {
        deps.logger?.warn("support.notify_failed", {
          threadId: thread.id,
          reason: "new_thread",
          error: error instanceof Error ? error.message : String(error),
        });
        // Swallow — the message is already persisted.
      });
  }

  return sendSupportMessageOutputSchema.parse({
    thread: threadOut,
    message,
  });
}
