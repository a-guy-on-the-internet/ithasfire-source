import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerAskStatus,
} from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { updateVolunteerAskInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type UpdateVolunteerAskDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Status transitions ──────────────────────────────────────────────────────

/**
 * Explicit lifecycle map: DRAFT→OPEN, OPEN↔PAUSED, any active state →
 * CLOSED, anything → ARCHIVED. ARCHIVED is terminal (no reopen — the row
 * is history, not a paused ask). CLOSED can only be archived: reopening a
 * closed ask is deliberately not supported; post a fresh ask instead.
 */
const ALLOWED_STATUS_TRANSITIONS: Record<
  VolunteerAskStatus,
  readonly VolunteerAskStatus[]
> = {
  DRAFT: ["OPEN", "CLOSED", "ARCHIVED"],
  OPEN: ["PAUSED", "CLOSED", "ARCHIVED"],
  PAUSED: ["OPEN", "CLOSED", "ARCHIVED"],
  CLOSED: ["ARCHIVED"],
  ARCHIVED: [],
};

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Patch a volunteer ask's fields and/or transition its status.
 *
 * - Subject (type/id) and denormalized orgId are immutable — the input
 *   schema simply doesn't carry them.
 * - Authz: `resolveAskOwnership` on the LOADED ask, inside the same tx as
 *   the write.
 * - ARCHIVED is terminal: any patch against an archived ask (including a
 *   reopen attempt) is a conflict.
 * - The effective scheduling window (patch merged over the stored ask) must
 *   satisfy endsAt > startsAt when both are set.
 */
export async function updateVolunteerAsk(
  deps: UpdateVolunteerAskDeps,
  rawInput: unknown,
): Promise<VolunteerAskRecord> {
  const input = parseInput(updateVolunteerAskInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    await resolveAskOwnership(tx, ask, input.actorHumanId);

    if (ask.status === "ARCHIVED") {
      throw fail("CONFLICT", {
        message: "ask_archived",
        meta: { reason: "ask_archived" },
      });
    }

    if (input.status !== undefined && input.status !== ask.status) {
      if (!ALLOWED_STATUS_TRANSITIONS[ask.status].includes(input.status)) {
        throw fail("CONFLICT", {
          message: "invalid_status_transition",
          meta: {
            reason: "invalid_status_transition",
            from: ask.status,
            to: input.status,
          },
        });
      }
    }

    // Effective window: `undefined` = keep stored, `null` = clear.
    const startsAt =
      input.startsAt !== undefined ? input.startsAt : ask.startsAt;
    const endsAt = input.endsAt !== undefined ? input.endsAt : ask.endsAt;
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw fail("INVALID_INPUT", {
        message: "ends_before_starts",
        meta: { reason: "ends_before_starts" },
      });
    }

    const updated = await tx.volunteering.updateAsk(input.askId, {
      title: input.title,
      description: input.description,
      status: input.status,
      cadence: input.cadence,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      capacity: input.capacity,
      autoApprove: input.autoApprove,
      waiverRequired: input.waiverRequired,
      smsOptInEnabled: input.smsOptInEnabled,
      formSchema: input.formSchema,
    });

    await tx.audit.log({
      entity: "volunteer_ask",
      entityId: input.askId,
      action:
        input.status !== undefined && input.status !== ask.status
          ? "status_changed"
          : "updated",
      data: {
        actorHumanId: input.actorHumanId,
        ...(input.timezone !== undefined && input.timezone !== ask.timezone
          ? { timezone: { from: ask.timezone, to: input.timezone } }
          : {}),
        ...(input.status !== undefined && input.status !== ask.status
          ? { from: ask.status, to: input.status }
          : {}),
      },
      at: deps.clock.now(),
    });

    return updated;
  });
}
