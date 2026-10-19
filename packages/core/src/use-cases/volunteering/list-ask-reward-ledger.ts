import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  VolunteerRewardGrantStatus,
  VolunteerRewardTrigger,
} from "@th/ports/repos/volunteering";
import type { TicketStatus } from "@th/ports/repos/tickets";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES, requireOrgMembership } from "../../lib/rbac";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { listAskRewardLedgerInputSchema } from "./schemas";

// ── Deps & output ───────────────────────────────────────────────────────────

export type ListAskRewardLedgerDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type RewardLedgerGrant = {
  id: string;
  signupId: string;
  humanId: string | null;
  contactEmail: string;
  status: VolunteerRewardGrantStatus;
  /** Live comp-ticket status, null when unlinked. */
  ticketStatus: TicketStatus | null;
  /** True when the comp is spent (ticket SCANNED or grant REDEEMED). */
  redeemed: boolean;
  roleId: string | null;
  ticketTypeId: string;
  faceValueCents: number;
  compOrderId: string | null;
  ticketId: string | null;
  grantedAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
};

export type RewardLedgerRewardSummary = {
  id: string;
  roleId: string | null;
  ticketTypeId: string;
  trigger: VolunteerRewardTrigger;
  maxGrants: number | null;
  grantsUsed: number;
  active: boolean;
  /** null = uncapped. */
  remaining: number | null;
};

export type ListAskRewardLedgerOutput = {
  askId: string;
  rewards: RewardLedgerRewardSummary[];
  grants: RewardLedgerGrant[];
  counts: {
    granted: number;
    redeemed: number;
    revoked: number;
    total: number;
  };
  /** Sum of remaining slots across rewards; null when any reward is uncapped. */
  remainingBudget: number | null;
  /** Total face value comped (integer cents) across non-revoked grants. */
  faceValueCents: number;
};

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Owner / finance reward ledger for an ask (FR-006): every grant on the ask's
 * rewards with its live redemption state, plus granted / redeemed / revoked
 * counts, remaining budget, and total face value comped in cents.
 *
 * Authz: `ORG_FINANCE_ROLES` on the ask's owning org — the ledger surfaces
 * money data (face value comped, budget), so it uses the finance gate rather
 * than the softer editor-level ask ownership. Coordinators see grant STATUS on
 * their roster elsewhere; they do not get the money ledger. Non-org asks
 * (PLACE / HUMAN / ORG-less) can never carry a comp reward, so they fall back
 * to ask ownership and return an empty ledger.
 *
 * `redeemed` is derived from `ticketStatus === "SCANNED"` (or an explicit
 * REDEEMED status) so redemption reconciles straight off the ticket even
 * before `redeemedAt` is stamped.
 *
 * The `rewards` summary enumerates the ask's FULL config via
 * `listRewardsByAsk` (ask-level + every role-level, inactive included), so a
 * configured-but-zero-grant reward still appears with its budget — the counts
 * (granted / redeemed / revoked) stay grant-derived and unaffected.
 */
export async function listAskRewardLedger(
  deps: ListAskRewardLedgerDeps,
  rawInput: unknown,
): Promise<ListAskRewardLedgerOutput> {
  const input = parseInput(listAskRewardLedgerInputSchema, rawInput);

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
      // owner still gets a (necessarily empty) ledger.
      await resolveAskOwnership(tx, ask, input.actorHumanId);
    }

    const ledgerRows = await tx.volunteering.listGrantsByAsk(input.askId);

    const grants: RewardLedgerGrant[] = ledgerRows.map((row) => {
      const redeemed =
        row.status === "REDEEMED" || row.ticketStatus === "SCANNED";
      return {
        id: row.id,
        signupId: row.signupId,
        humanId: row.humanId,
        contactEmail: row.contactEmail,
        status: row.status,
        ticketStatus: row.ticketStatus,
        redeemed,
        roleId: row.rewardRoleId,
        ticketTypeId: row.rewardTicketTypeId,
        faceValueCents: row.faceValueCents,
        compOrderId: row.compOrderId,
        ticketId: row.ticketId,
        grantedAt: row.grantedAt,
        redeemedAt: row.redeemedAt,
        revokedAt: row.revokedAt,
        revokeReason: row.revokeReason,
      };
    });

    let granted = 0;
    let redeemed = 0;
    let revoked = 0;
    let faceValueCents = 0;
    for (const grant of grants) {
      if (grant.status === "REVOKED") {
        revoked += 1;
        continue;
      }
      // Non-revoked comps count toward face value comped.
      faceValueCents += grant.faceValueCents;
      if (grant.redeemed) {
        redeemed += 1;
      } else {
        granted += 1;
      }
    }

    // Reward summaries — the ask's FULL config (ask-level + role-level,
    // inactive included), so a configured-but-zero-grant reward is still
    // surfaced with its remaining budget.
    const rewardRows = await tx.volunteering.listRewardsByAsk(input.askId);
    const rewards: RewardLedgerRewardSummary[] = [];
    let remainingBudget: number | null = 0;
    for (const reward of rewardRows) {
      const remaining =
        reward.maxGrants == null
          ? null
          : Math.max(reward.maxGrants - reward.grantsUsed, 0);
      rewards.push({
        id: reward.id,
        roleId: reward.roleId,
        ticketTypeId: reward.ticketTypeId,
        trigger: reward.trigger,
        maxGrants: reward.maxGrants,
        grantsUsed: reward.grantsUsed,
        active: reward.active,
        remaining,
      });
      if (remaining == null) {
        remainingBudget = null;
      } else if (remainingBudget != null) {
        remainingBudget += remaining;
      }
    }

    return {
      askId: input.askId,
      rewards,
      grants,
      counts: {
        granted,
        redeemed,
        revoked,
        total: grants.length,
      },
      remainingBudget,
      faceValueCents,
    };
  });
}
