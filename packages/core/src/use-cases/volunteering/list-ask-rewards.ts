import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { VolunteerRewardTrigger } from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES, requireOrgMembership } from "../../lib/rbac";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { listAskRewardsInputSchema } from "./schemas";

// ── Deps & output ───────────────────────────────────────────────────────────

export type ListAskRewardsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type AskRewardSummary = {
  id: string;
  /** Null = ask-level reward; set = role-specific. */
  roleId: string | null;
  ticketTypeId: string;
  /** Live target ticket-type name, null when it no longer exists. */
  ticketTypeName: string | null;
  /** TicketType.priceCents — one comp's face value (integer cents); null if gone. */
  faceValueCents: number | null;
  trigger: VolunteerRewardTrigger;
  maxGrants: number | null;
  grantsUsed: number;
  active: boolean;
  /** Remaining budget slots; null = uncapped. */
  remaining: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ListAskRewardsOutput = {
  askId: string;
  rewards: AskRewardSummary[];
};

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Owner / finance list of every reward CONFIGURED on an ask — the read behind
 * the reward config form and status view (B6). Unlike the ledger (which
 * derives its reward summary from grants and so hides a configured-but-zero-
 * grant reward), this enumerates the full config via `listRewardsByAsk`,
 * inactive rewards included, each pre-filled with its target ticket type,
 * trigger, budget cap, and grants used.
 *
 * Authz mirrors `listAskRewardLedger`: `ORG_FINANCE_ROLES` on the ask's owning
 * org — configuring a reward spends organizer revenue, so it uses the finance
 * gate, not the softer editor-level ask ownership. A non-org ask can never
 * carry a comp reward, so it falls back to ownership and returns an empty list.
 */
export async function listAskRewards(
  deps: ListAskRewardsDeps,
  rawInput: unknown,
): Promise<ListAskRewardsOutput> {
  const input = parseInput(listAskRewardsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    if (ask.orgId) {
      await requireOrgMembership({
        repos: tx,
        orgId: ask.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_FINANCE_ROLES,
      });
    } else {
      // No comp rewards possible on a non-org ask; gate on ownership so the
      // owner still gets a (necessarily empty) list.
      await resolveAskOwnership(tx, ask, input.actorHumanId);
    }

    const rewards = await tx.volunteering.listRewardsByAsk(input.askId);

    // Resolve target ticket-type name + face value once for the ask's EVENT
    // subject (rewards attach to EVENT-subject asks only). A non-EVENT ask
    // never has rewards, so the lookup is skipped.
    const ticketTypes =
      ask.subjectType === "EVENT" && rewards.length > 0
        ? await tx.events.listTicketTypes(ask.subjectId)
        : [];
    const byTicketTypeId = new Map(ticketTypes.map((tt) => [tt.id, tt]));

    // ONE instant for the whole list (FR-003).
    const now = deps.clock.now();

    return {
      askId: input.askId,
      rewards: rewards.map((reward): AskRewardSummary => {
        const ticketType = byTicketTypeId.get(reward.ticketTypeId) ?? null;
        const remaining =
          reward.maxGrants == null
            ? null
            : Math.max(reward.maxGrants - reward.grantsUsed, 0);
        return {
          id: reward.id,
          roleId: reward.roleId,
          ticketTypeId: reward.ticketTypeId,
          ticketTypeName: ticketType?.name ?? null,
          // FR-004: what the comp is worth RIGHT NOW (the reward is a live
          // configuration, not a historical grant), resolved at the request's
          // single instant. Granted comps snapshot their own value on the grant
          // row — this list never re-derives those.
          faceValueCents: ticketType
            ? resolveUnitPriceCents(ticketType, { now })
            : null,
          trigger: reward.trigger,
          maxGrants: reward.maxGrants,
          grantsUsed: reward.grantsUsed,
          active: reward.active,
          remaining,
          createdAt: reward.createdAt,
          updatedAt: reward.updatedAt,
        };
      }),
    };
  });
}
