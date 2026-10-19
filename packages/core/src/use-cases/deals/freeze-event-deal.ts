import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail as failApp } from "@th/errors";

import { fail } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { freezeEventDealOnLockedRow } from "./_shared/deal-freeze";
import { mayRouteEventPayouts } from "./_shared/deal-target";

// ─────────────────────────────────────────────────────────────────────────────
// freezeEventDeal (freeze-the-deal FR-003)
//
// The organiser freezes an unfrozen event's deal at any time, DRAFT included
// (ruling R2). Who may: the same gate EVENT deal writes use
// (`mayRouteEventPayouts`, ruling F6). Freezing a frozen deal is a no-op that
// returns the current state, so a double-click or a retry is harmless.
//
// There is no unfreeze (F3): a change to a frozen deal is one edit that keeps
// the freeze (`frozenChange: true` on the write paths).
// ─────────────────────────────────────────────────────────────────────────────

export const freezeEventDealInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const freezeEventDealOutputSchema = z
  .object({
    eventId: z.uuid(),
    dealFrozenAt: z.date(),
    /** Null = frozen automatically (first publish or the backfill). */
    dealFrozenByHumanId: z.uuid().nullable(),
    /** False when the deal was already frozen (nothing written). */
    changed: z.boolean(),
  })
  .strict();

export type FreezeEventDealInput = z.input<typeof freezeEventDealInputSchema>;
export type FreezeEventDealOutput = z.infer<typeof freezeEventDealOutputSchema>;

export type FreezeEventDealDeps = {
  repos: Pick<Repos, "tx" | "events" | "authz">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function freezeEventDeal(
  deps: FreezeEventDealDeps,
  rawInput: unknown,
): Promise<FreezeEventDealOutput> {
  const input = parseInput(freezeEventDealInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) throw failApp("EVENT_NOT_FOUND");
  const owner = { orgId: event.orgId ?? null, humanId: event.humanId ?? null };
  if (!(await mayRouteEventPayouts(deps.repos.authz, owner, input.actorHumanId))) {
    throw failApp("INSUFFICIENT_ROLE");
  }

  const now = deps.clock.now();
  const state = await deps.repos.tx(async (tx) => {
    // The event row first, then (inside the helper) its terms rows: the one
    // lock order publish also uses, so a freeze and a publish cannot
    // deadlock, and a deal write holding a terms lock finishes first.
    await tx.events.lockRows({ ids: [input.eventId], mode: "update" });
    const locked = await tx.events.getById(input.eventId);
    if (!locked) throw failApp("EVENT_NOT_FOUND");
    // The gate ran against THAT owner; an owner change since is a conflict.
    if ((locked.orgId ?? null) !== owner.orgId || (locked.humanId ?? null) !== owner.humanId) {
      fail("conflict", "deal_event_owner_changed");
    }
    const frozen = await freezeEventDealOnLockedRow(tx, {
      eventId: input.eventId,
      at: now,
      frozenByHumanId: input.actorHumanId,
      source: "MANUAL",
      actorHumanId: input.actorHumanId,
    });
    if (!frozen || !frozen.dealFrozenAt) throw failApp("EVENT_NOT_FOUND");
    return frozen;
  });

  deps.logger?.info("deals.event_deal_frozen", {
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
    changed: state.changed,
  });

  return freezeEventDealOutputSchema.parse({
    eventId: input.eventId,
    dealFrozenAt: state.dealFrozenAt,
    dealFrozenByHumanId: state.dealFrozenByHumanId,
    changed: state.changed,
  });
}
