import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";

import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES, requireOrgMembership } from "../../lib/rbac";
import { setVolunteerRewardInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type SetVolunteerRewardDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type SetVolunteerRewardOutput = {
  ok: true;
  rewardId: string;
};

/** Re-throw the adapter's raw `duplicate_reward` conflict as a typed AppError. */
function isDuplicateRewardError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "duplicate_reward"
  );
}

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Attach (create-or-update) a comp-ticket reward to an ask, optionally scoped
 * to a role. Money policy — spends organizer revenue as a forgone seat — so:
 *
 * - COMP-only (2026-07-01 resolutions): the reward is always a $0 comp ticket
 *   to `ticketTypeId`; there is no discount variant.
 * - EVENT-subject asks only: non-EVENT asks have no ticket type to target, so
 *   attaching a reward is a `reward_requires_event_ask` conflict.
 * - Authz: `ORG_FINANCE_ROLES` on the ask's owning org — the SAME gate
 *   `createPromo` enforces, NOT mere ask ownership (`resolveAskOwnership`,
 *   which honors EDITOR). Configuring a reward is a finance action.
 * - `ticketTypeId` must belong to the ask's EVENT subject; a role-scoped
 *   reward's `roleId` must belong to the ask.
 *
 * Idempotent at the (askId, roleId) grain via `upsertReward`; the DB's partial
 * unique indexes surface a concurrent create race as `duplicate_reward`.
 */
export async function setVolunteerReward(
  deps: SetVolunteerRewardDeps,
  rawInput: unknown,
): Promise<SetVolunteerRewardOutput> {
  const input = parseInput(setVolunteerRewardInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    // COMP-only rewards target a ticket type; only EVENT-subject asks have one.
    if (ask.subjectType !== "EVENT") {
      throw fail("CONFLICT", {
        message: "reward_requires_event_ask",
        meta: {
          reason: "reward_requires_event_ask",
          subjectType: ask.subjectType,
        },
      });
    }

    // EVENT asks are always org-owned (the org that owns the event). A null
    // orgId here is a data-integrity problem, not a permissible personal-event
    // reward — fail closed rather than skip the finance gate.
    if (!ask.orgId) {
      throw fail("EVENT_NOT_ORG_OWNED");
    }

    // Finance gate — spends organizer revenue (NFR-003). Deliberately stricter
    // than `resolveAskOwnership` (which admits EDITOR): a coordinator or editor
    // must NOT be able to hand out comps.
    await requireOrgMembership({
      repos: tx,
      orgId: ask.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_FINANCE_ROLES,
    });

    // The reward's target ticket type must belong to the ask's event.
    const ticketTypes = await tx.events.listTicketTypes(ask.subjectId);
    const ticketType = ticketTypes.find((tt) => tt.id === input.ticketTypeId);
    if (!ticketType) {
      throw fail("TICKET_TYPE_NOT_FOUND");
    }

    // A role-scoped reward must target a role that belongs to this ask.
    if (input.roleId) {
      const role = await tx.volunteering.getEventRole(input.roleId);
      if (!role || role.askId !== ask.id) {
        throw fail("ROLE_NOT_FOUND");
      }
    }

    let reward;
    try {
      reward = await tx.volunteering.upsertReward({
        askId: input.askId,
        roleId: input.roleId ?? null,
        ticketTypeId: input.ticketTypeId,
        ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
        ...(input.maxGrants !== undefined
          ? { maxGrants: input.maxGrants }
          : {}),
      });
    } catch (error) {
      if (isDuplicateRewardError(error)) {
        throw fail("CONFLICT", {
          message: "duplicate_reward",
          meta: { reason: "duplicate_reward", askId: input.askId },
          cause: error,
        });
      }
      throw error;
    }

    await tx.audit.log({
      entity: "volunteer_reward",
      entityId: reward.id,
      action: "volunteer_reward_set",
      data: {
        actorHumanId: input.actorHumanId,
        askId: input.askId,
        roleId: input.roleId ?? null,
        ticketTypeId: input.ticketTypeId,
        trigger: reward.trigger,
        maxGrants: reward.maxGrants,
        // FR-004: the comp's face value at the moment the reward was
        // configured, resolved (not the raw list price) so a reward set after a
        // scheduled flip audits at what the ticket is actually worth.
        faceValueCents: resolveUnitPriceCents(ticketType, {
          now: deps.clock.now(),
        }),
      },
      at: deps.clock.now(),
    });

    return { ok: true, rewardId: reward.id };
  });
}
