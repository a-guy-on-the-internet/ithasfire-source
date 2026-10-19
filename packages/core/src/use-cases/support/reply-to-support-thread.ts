import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { SUPPORT_STAFF_ROLES } from "./roles";
import { fail } from "@th/errors";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import {
  SUPPORT_MESSAGE_MAX,
  supportMessageSchema,
  supportThreadSchema,
} from "./schemas";

// ── Goal ─────────────────────────────────────────────────────────────────────
// A platform support operator posts a HUMAN_AGENT reply to a thread and bumps
// lastMessageAt. Staff only. Does not change thread status (operators resolve
// explicitly via set-support-thread-status).

export const replyToSupportThreadInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    threadId: z.string().uuid(),
    body: plainTextMultilineRequired(SUPPORT_MESSAGE_MAX),
  })
  .strict();

export const replyToSupportThreadOutputSchema = z
  .object({
    thread: supportThreadSchema,
    message: supportMessageSchema,
  })
  .strict();

export type ReplyToSupportThreadInput = z.infer<
  typeof replyToSupportThreadInputSchema
>;
export type ReplyToSupportThreadOutput = z.infer<
  typeof replyToSupportThreadOutputSchema
>;

export type ReplyToSupportThreadDeps = {
  repos: Pick<Repos, "tx" | "supportThreads" | "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function replyToSupportThread(
  deps: ReplyToSupportThreadDeps,
  rawInput: unknown,
): Promise<ReplyToSupportThreadOutput> {
  const input = parseInput(replyToSupportThreadInputSchema, rawInput);
  const now = deps.clock.now();

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: SUPPORT_STAFF_ROLES,
    errorCode: "STAFF_ONLY",
  });

  const thread = await deps.repos.supportThreads.getThreadById(input.threadId);
  if (!thread) {
    throw fail("THREAD_NOT_FOUND");
  }

  // One mutation = one transaction: persist the reply AND its audit row
  // atomically (engineering-standards.md — "log audit entries inside that
  // transaction before commit"). Without the tx, a crash between the message
  // write and the audit write would mutate the thread with no audit trail.
  const message = await deps.repos.tx(async (tx) => {
    const created = await tx.supportThreads.appendMessage({
      threadId: thread.id,
      authorType: "HUMAN_AGENT",
      authorHumanId: input.actorHumanId,
      body: input.body,
      lastMessageAt: now,
    });

    await tx.audit.log({
      entity: "support_thread",
      entityId: thread.id,
      action: "support_thread.replied",
      data: {
        messageId: created.id,
        operatorHumanId: input.actorHumanId,
      },
      at: now,
    });

    return created;
  });

  return replyToSupportThreadOutputSchema.parse({
    thread: { ...thread, lastMessageAt: now },
    message,
  });
}
