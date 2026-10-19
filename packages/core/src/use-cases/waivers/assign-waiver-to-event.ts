import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";

// ── Schema ────────────────────────────────────────────────────────────────

/**
 * Base object schema (no refinement, no .strict()) — safe to .omit() in
 * transport layers. Zod v4 treats .strict() as a refinement, so we keep
 * the base free of it.
 */
export const assignWaiverToEventInputBaseSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid().optional(),
  humanId: z.string().uuid().optional(),
  eventId: z.string().uuid(),
  /** Set to a template id, or null to remove the waiver requirement. */
  waiverTemplateId: z.string().uuid().nullable(),
});

/** Full input schema with strict + cross-field refinement (used by the use case). */
export const assignWaiverToEventInputSchema = assignWaiverToEventInputBaseSchema
  .strict()
  .refine((v) => (v.orgId != null) !== (v.humanId != null), {
    message: "Exactly one of orgId or humanId must be provided",
  });

export const assignWaiverToEventOutputSchema = z.object({
  event: z.object({
    id: z.string().uuid(),
    waiverTemplateId: z.string().uuid().nullable(),
  }),
});

export type AssignWaiverToEventInput = z.infer<
  typeof assignWaiverToEventInputSchema
>;
export type AssignWaiverToEventOutput = z.infer<
  typeof assignWaiverToEventOutputSchema
>;

export type AssignWaiverToEventDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ──────────────────────────────────────────────────────────────

export async function assignWaiverToEvent(
  deps: AssignWaiverToEventDeps,
  rawInput: unknown,
): Promise<AssignWaiverToEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "assignWaiverToEvent" });

  const execute = async (): Promise<AssignWaiverToEventOutput> => {
    const input = parseInput(assignWaiverToEventInputSchema, rawInput);

    // Events always belong to an org — orgId is mandatory for this flow.
    if (!input.orgId) {
      throw {
        code: "invalid_input",
        message: "orgId is required for event waiver assignment",
      } as const;
    }
    const orgId: string = input.orgId;

    const result = await deps.repos.tx(async (tx) => {
      // 1. Auth: OWNER, ADMIN, or EDITOR
      await requireOrgMembership({
        repos: tx,
        orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_EDIT_ROLES,
      });

      // 2. Load the event
      const event = await tx.events.getById(input.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }

      // 3. Event must belong to the specified org
      if (event.orgId !== orgId) {
        throw fail("EVENT_NOT_IN_ORG");
      }

      // 4. If assigning a template, validate it exists and is accessible
      if (input.waiverTemplateId !== null) {
        const template = await tx.waiverTemplates.getById(
          input.waiverTemplateId,
        );
        if (!template) {
          throw fail("WAIVER_TEMPLATE_NOT_FOUND");
        }

        // Template must belong to the org or be a platform-provided template (orgId=null)
        if (template.orgId !== null && template.orgId !== orgId) {
          throw fail("WAIVER_TEMPLATE_NOT_ACCESSIBLE");
        }
      }

      // 5. Set the waiver template
      const updated = await tx.events.setWaiverTemplate({
        eventId: input.eventId,
        waiverTemplateId: input.waiverTemplateId,
      });

      // 6. Audit
      const now = deps.clock.now();
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "waiver_assigned",
        data: {
          actorHumanId: input.actorHumanId,
          orgId,
          waiverTemplateId: input.waiverTemplateId,
          previousWaiverTemplateId: event.waiverTemplateId ?? null,
        },
        at: now,
      });

      return updated;
    });

    return assignWaiverToEventOutputSchema.parse({
      event: {
        id: result.id,
        waiverTemplateId: result.waiverTemplateId ?? null,
      },
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("assignWaiverToEvent", execute);
  }

  return execute();
}
