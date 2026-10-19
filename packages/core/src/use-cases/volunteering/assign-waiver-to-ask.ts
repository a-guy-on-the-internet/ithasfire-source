import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type {
  VolunteerAskRecord,
} from "@th/ports/repos/volunteering";
import type { WaiverTemplateRecord } from "@th/ports/repos/waivers";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * Base object schema (no refinement, no .strict()) — safe to `.omit()` in
 * transport layers. Zod v4 treats `.strict()` as a refinement, so the base
 * stays free of it (mirrors assignWaiverToEventInputBaseSchema).
 */
export const assignWaiverToAskInputBaseSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  /** Set to a template id, or null to clear the ask's waiver template. */
  waiverTemplateId: z.string().uuid().nullable(),
});

/** Full input schema (strict) — used by the use case. */
export const assignWaiverToAskInputSchema =
  assignWaiverToAskInputBaseSchema.strict();

export const assignWaiverToAskOutputSchema = z.object({
  ask: z.object({
    id: z.string().uuid(),
    waiverTemplateId: z.string().uuid().nullable(),
  }),
});

export type AssignWaiverToAskInput = z.infer<
  typeof assignWaiverToAskInputSchema
>;
export type AssignWaiverToAskOutput = z.infer<
  typeof assignWaiverToAskOutputSchema
>;

// ── Deps ────────────────────────────────────────────────────────────────────

export type AssignWaiverToAskDeps = {
  repos: Repos;
  clock: ClockPort;
};

// ── Ownership rule ──────────────────────────────────────────────────────────

/**
 * THE template-accessibility rule (ask-level-volunteer-waivers FR-002):
 * the template's owner must BE the ask's owner, or the template must be
 * platform-provided. Derived from what `resolveAskOwnership` establishes
 * per subject type — never from the actor's own memberships, so an actor
 * who happens to belong to two orgs can never point org A's ask at org
 * B's legal text:
 *
 * - Platform template (orgId AND humanId both null): allowed everywhere.
 * - ORG subject: an org-owned template whose `orgId` IS the subject org.
 * - PLACE subject: the place's owner set is exactly
 *   `humanIdsWithAccess ∪ orgIdsWithAccess` (the same rows
 *   `requirePlaceOwnership` gates on), so an org-owned template must
 *   belong to one of the place's owning orgs, or a human-owned template
 *   to one of its direct human owners.
 * - HUMAN subject: a human-owned template whose `humanId` IS the subject
 *   human — a delegate's own template is deliberately NOT accessible.
 *
 * Template owner precedence mirrors the WaiverTemplate schema convention
 * (orgId and humanId are mutually exclusive): a non-null `orgId` makes it
 * org-owned, else a non-null `humanId` makes it human-owned.
 */
function isTemplateAccessibleToAsk(
  template: WaiverTemplateRecord,
  ask: VolunteerAskRecord,
  place: PlaceRecord | null,
): boolean {
  // Platform template — usable by every owner (FR-010's default path).
  if (template.orgId === null && template.humanId === null) {
    return true;
  }

  switch (ask.subjectType) {
    case "ORG":
      return template.orgId !== null && template.orgId === ask.subjectId;
    case "PLACE": {
      if (!place) return false;
      if (template.orgId !== null) {
        return place.orgIdsWithAccess.includes(template.orgId);
      }
      return (
        template.humanId !== null &&
        place.humanIdsWithAccess.includes(template.humanId)
      );
    }
    case "HUMAN":
      return template.humanId !== null && template.humanId === ask.subjectId;
    case "EVENT":
      // Unreachable — EVENT subjects are rejected before template checks.
      return false;
  }
}

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Assign / replace / clear the waiver template on a standing volunteer ask
 * (ask-level-volunteer-waivers FR-002). Mirrors `assignWaiverToEvent`, with
 * ask-subject ownership semantics:
 *
 * - Authz: `resolveAskOwnership` on the LOADED ask, inside the same tx as
 *   the write — the exact gate every other ask-management mutation uses
 *   (RBAC before any state inspection, same anti-oracle discipline).
 * - EVENT-subject asks are rejected (`invalid_input` /
 *   `event_asks_use_event_waiver`): the event stays the single source of
 *   truth there — assign via `waivers.assignToEvent` instead.
 * - ARCHIVED asks are terminal history (`conflict` / `ask_archived`),
 *   mirroring `updateVolunteerAsk`.
 * - Assigning validates the template exists AND is owned by the ask's
 *   owner or is platform-provided (see {@link isTemplateAccessibleToAsk});
 *   clearing (null) is always allowed.
 * - The write goes through the dedicated `setAskWaiverTemplate` port —
 *   never `updateAsk` — so this validation is the single path to the
 *   column.
 */
export async function assignWaiverToAsk(
  deps: AssignWaiverToAskDeps,
  rawInput: unknown,
): Promise<AssignWaiverToAskOutput> {
  const input = parseInput(assignWaiverToAskInputSchema, rawInput);

  const updated = await deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    // Authz BEFORE any subject/state inspection (mirrors
    // reviewVolunteerSignup's RBAC-first rule): a non-owner probing ask
    // ids uniformly hits the ownership gate and never learns the ask's
    // subject type or lifecycle state. Returns the loaded place for
    // PLACE subjects — the owner set the accessibility rule needs.
    const ownership = await resolveAskOwnership(tx, ask, input.actorHumanId);

    // EVENT-subject asks carry their waiver on the event itself
    // (Event.volunteerWaiverRequired + Event.waiverTemplateId) — one
    // source of truth, one assignment surface (waivers.assignToEvent).
    if (ask.subjectType === "EVENT") {
      throw fail("INVALID_INPUT", {
        message: "event_asks_use_event_waiver",
      });
    }

    // ARCHIVED is terminal (mirrors updateVolunteerAsk) — history rows
    // never get their liability gate re-pointed.
    if (ask.status === "ARCHIVED") {
      throw fail("CONFLICT", {
        message: "ask_archived",
        meta: { reason: "ask_archived" },
      });
    }

    // Assigning validates existence + ownership; clearing never needs to
    // — a null assignment can't show anyone the wrong legal document.
    if (input.waiverTemplateId !== null) {
      const template = await tx.waiverTemplates.getById(
        input.waiverTemplateId,
      );
      if (!template) {
        throw fail("WAIVER_TEMPLATE_NOT_FOUND");
      }
      if (!isTemplateAccessibleToAsk(template, ask, ownership.place)) {
        throw fail("WAIVER_TEMPLATE_NOT_ACCESSIBLE");
      }
    }

    const updated = await tx.volunteering.setAskWaiverTemplate({
      askId: ask.id,
      waiverTemplateId: input.waiverTemplateId,
    });

    await tx.audit.log({
      entity: "volunteer_ask",
      entityId: ask.id,
      action: "waiver_assigned",
      data: {
        actorHumanId: input.actorHumanId,
        subjectType: ask.subjectType,
        subjectId: ask.subjectId,
        waiverTemplateId: input.waiverTemplateId,
        previousWaiverTemplateId: ask.waiverTemplateId ?? null,
      },
      at: deps.clock.now(),
    });

    return updated;
  });

  return assignWaiverToAskOutputSchema.parse({
    ask: {
      id: updated.id,
      waiverTemplateId: updated.waiverTemplateId ?? null,
    },
  });
}
