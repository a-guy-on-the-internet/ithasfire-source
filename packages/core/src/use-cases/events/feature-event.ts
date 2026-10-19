import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";

export const featureEventInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    curatedUntil: z.coerce.date().optional(),
    notes: plainTextMultilineOptional(1024).optional(),
  })
  .strict();

export const featureEventOutputSchema = z
  .object({
    eventId: z.uuid(),
    curatedUntil: z.date(),
    featuredAt: z.date(),
  })
  .strict();

export type FeatureEventInput = z.infer<typeof featureEventInputSchema>;
export type FeatureEventOutput = z.infer<typeof featureEventOutputSchema>;

export type FeatureEventDeps = {
  repos: Repos;
  /** The staff probe: featuring an event is a platform-ADMIN action. */
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function featureEvent(
  deps: FeatureEventDeps,
  rawInput: unknown,
): Promise<FeatureEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "featureEvent" });

  const execute = async () => {
    const input = parseInput(featureEventInputSchema, rawInput);

    // Asked of the authz port, which counts the ADMIN role only with a second
    // factor enrolled (`SECOND_FACTOR_REQUIRED` otherwise).
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN"],
      errorCode: "INSUFFICIENT_ROLE",
    });

    const now = deps.clock.now();

    const { curatedUntil } = await deps.repos.tx(async (tx) => {
      const event = await tx.events.getById(input.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }
      if (event.status !== "PUBLISHED") {
        throw fail("EVENT_NOT_PUBLISHED");
      }

      const derivedCuratedUntil =
        input.curatedUntil ?? event.endsAt ?? event.startsAt;
      if (!derivedCuratedUntil) {
        throw fail("CURATED_UNTIL_UNAVAILABLE");
      }
      if (derivedCuratedUntil < event.startsAt) {
        throw fail("CURATED_UNTIL_BEFORE_EVENT");
      }

      const placement = await tx.featuredEvents.upsertPlacement({
        eventId: event.id,
        curatedByHumanId: input.actorHumanId,
        curatedAt: now,
        curatedUntil: derivedCuratedUntil,
        notes: input.notes ?? null,
      });

      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "event_featured",
        data: {
          actorHumanId: input.actorHumanId,
          curatedUntil: placement.curatedUntil ?? derivedCuratedUntil,
          notes: placement.notes,
        },
        at: now,
      });

      return { curatedUntil: placement.curatedUntil ?? derivedCuratedUntil };
    });

    return featureEventOutputSchema.parse({
      eventId: input.eventId,
      curatedUntil,
      featuredAt: now,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("featureEvent", execute);
  }

  return execute();
}
