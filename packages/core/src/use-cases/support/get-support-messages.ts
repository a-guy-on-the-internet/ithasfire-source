import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { SUPPORT_STAFF_ROLES } from "./roles";
import { supportMessageSchema, supportThreadSchema } from "./schemas";
import { fail } from "@th/errors";

// ── Goal ─────────────────────────────────────────────────────────────────────
// Return the messages + thread status for a thread the caller OWNS, or any
// thread when the caller is platform support staff. Poll target for the widget.

export const getSupportMessagesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    threadId: z.string().uuid(),
    // Incremental cursor: the createdAt of the caller's newest already-seen
    // message. When set, only messages STRICTLY newer than `since` are returned
    // (the widget's 4s poll fetches just the delta). Absent → full history.
    since: z.coerce.date().optional(),
  })
  .strict();

export const getSupportMessagesOutputSchema = z
  .object({
    thread: supportThreadSchema,
    messages: z.array(supportMessageSchema),
  })
  .strict();

export type GetSupportMessagesInput = z.infer<
  typeof getSupportMessagesInputSchema
>;
export type GetSupportMessagesOutput = z.infer<
  typeof getSupportMessagesOutputSchema
>;

export type GetSupportMessagesDeps = {
  repos: Pick<Repos, "supportThreads">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function getSupportMessages(
  deps: GetSupportMessagesDeps,
  rawInput: unknown,
): Promise<GetSupportMessagesOutput> {
  const input = parseInput(getSupportMessagesInputSchema, rawInput);

  const thread = await deps.repos.supportThreads.getThreadById(input.threadId);
  if (!thread) {
    throw fail("THREAD_NOT_FOUND");
  }

  // Owner-or-staff. A human can only read their own thread; platform support
  // staff can read any. We check ownership first (cheap, no extra round trip)
  // and only consult staff role when the actor isn't the owner.
  // NOTE: a null humanId means an owner-less (GDPR-erased) thread — no actor
  // can match it, so this falls through to the staff-only check, which is the
  // intended behavior (owner-less ⇒ staff-only).
  if (thread.humanId !== input.actorHumanId) {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...SUPPORT_STAFF_ROLES],
    });
    if (!staff.allowed) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "thread" } });
    }
  }

  // The thread row is always returned in full (single cheap row). Only the
  // message list honours the `since` cursor — when set, the adapter returns just
  // the messages strictly newer than the caller's latest seen createdAt.
  const messages = await deps.repos.supportThreads.listMessages(
    input.threadId,
    input.since,
  );

  return getSupportMessagesOutputSchema.parse({ thread, messages });
}
