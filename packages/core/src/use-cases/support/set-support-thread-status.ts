import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { supportThreadStatusSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import { SUPPORT_STAFF_ROLES } from "./roles";
import { supportThreadSchema, type NotifySupportFn } from "./schemas";
import { fail } from "@th/errors";

// ── Goal ─────────────────────────────────────────────────────────────────────
// Move a thread between OPEN / AWAITING_HUMAN / RESOLVED.
//
// Authorization:
//   • Platform support staff may set ANY status on ANY thread.
//   • The thread OWNER may escalate their OWN thread to AWAITING_HUMAN
//     ("talk to a human"). They may not RESOLVE (operator action) or reopen.
//
// Side effects:
//   • → AWAITING_HUMAN fires a best-effort support alert (escalation ping).
//   • → RESOLVED stamps resolvedAt; any other status clears it.

export const setSupportThreadStatusInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    threadId: z.string().uuid(),
    status: supportThreadStatusSchema,
  })
  .strict();

export const setSupportThreadStatusOutputSchema = z
  .object({
    thread: supportThreadSchema,
  })
  .strict();

export type SetSupportThreadStatusInput = z.infer<
  typeof setSupportThreadStatusInputSchema
>;
export type SetSupportThreadStatusOutput = z.infer<
  typeof setSupportThreadStatusOutputSchema
>;

export type SetSupportThreadStatusDeps = {
  repos: Pick<Repos, "tx" | "supportThreads" | "audit">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Best-effort support notifier (Discord). Optional; failures swallowed. */
  notifySupport?: NotifySupportFn | null;
};

export async function setSupportThreadStatus(
  deps: SetSupportThreadStatusDeps,
  rawInput: unknown,
): Promise<SetSupportThreadStatusOutput> {
  const input = parseInput(setSupportThreadStatusInputSchema, rawInput);
  const now = deps.clock.now();

  const thread = await deps.repos.supportThreads.getThreadById(input.threadId);
  if (!thread) {
    throw fail("THREAD_NOT_FOUND");
  }

  const staff = await deps.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: [...SUPPORT_STAFF_ROLES],
  });
  const isStaff = staff.allowed;
  const isOwner = thread.humanId === input.actorHumanId;

  // Non-staff: only the owner, and only to escalate to AWAITING_HUMAN.
  if (!isStaff) {
    if (!isOwner) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "thread" } });
    }
    if (input.status !== "AWAITING_HUMAN") {
      throw fail("OWNER_CAN_ONLY_ESCALATE");
    }
  }

  const resolvedAt = input.status === "RESOLVED" ? now : null;

  // One mutation = one transaction: persist the status change AND its audit
  // row atomically (engineering-standards.md). The best-effort Discord alert
  // stays OUTSIDE the tx (fired after commit below) so a slow/failed alert
  // never holds open or rolls back the DB write.
  const updated = await deps.repos.tx(async (tx) => {
    const row = await tx.supportThreads.updateThreadStatus({
      threadId: thread.id,
      status: input.status,
      resolvedAt,
    });

    await tx.audit.log({
      entity: "support_thread",
      entityId: thread.id,
      action: "support_thread.status_changed",
      data: {
        from: thread.status,
        to: input.status,
        changedBy: input.actorHumanId,
        via: isStaff ? "staff" : "owner",
      },
      at: now,
    });

    return row;
  });

  // Best-effort escalation alert. Only when transitioning INTO AWAITING_HUMAN
  // (not a no-op re-set). Fire-and-forget so Discord delivery never sits on the
  // status-change request path; the transition is already committed. The
  // `.catch` keeps any rejection from surfacing (NFR-003).
  if (
    input.status === "AWAITING_HUMAN" &&
    thread.status !== "AWAITING_HUMAN" &&
    deps.notifySupport
  ) {
    void deps
      .notifySupport({
        reason: "awaiting_human",
        threadId: thread.id,
        humanId: thread.humanId,
        eventId: thread.eventId,
        orderId: thread.orderId,
      })
      .catch((error) => {
        deps.logger?.warn("support.notify_failed", {
          threadId: thread.id,
          reason: "awaiting_human",
          error: error instanceof Error ? error.message : String(error),
        });
        // Swallow — the status change is already persisted.
      });
  }

  return setSupportThreadStatusOutputSchema.parse({ thread: updated });
}
