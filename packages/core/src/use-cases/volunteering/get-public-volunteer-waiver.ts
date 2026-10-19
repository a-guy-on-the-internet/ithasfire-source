import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getPublicVolunteerWaiverInputSchema = z
  .object({
    eventId: z.string().uuid(),
    /**
     * Optional viewer — when present, `alreadyAccepted` reflects whether
     * this Human has a current acceptance on file. Injected from ctx by
     * the transport (optional auth); guests always get `false`.
     */
    actorHumanId: z.string().uuid().nullish(),
  })
  .strict();

export type GetPublicVolunteerWaiverInput = z.infer<
  typeof getPublicVolunteerWaiverInputSchema
>;

export type PublicVolunteerWaiver = {
  templateId: string;
  version: number;
  title: string;
  body: string;
};

export type GetPublicVolunteerWaiverOutput = {
  /**
   * Effective gate: true only when the event flag is on AND a waiver
   * template is assigned and resolvable. A flag with no (or a deleted)
   * template imposes no gate — same semantics as `submitVolunteerSignup`.
   */
  waiverRequired: boolean;
  waiver: PublicVolunteerWaiver | null;
  /**
   * True when the signed-in viewer already has an acceptance on file for
   * the current template + version (returning volunteer — the form can
   * show "already on file" instead of the checkbox). Always false for
   * guests; only meaningful when `waiverRequired` is true.
   */
  alreadyAccepted: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPublicVolunteerWaiverDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public, unauthenticated use case powering the waiver section of the
 * volunteer signup form (Gap 3).
 *
 * Visibility gate mirrors `listPublicEventVolunteerRoles`: the event must
 * exist, be PUBLISHED, and have volunteering enabled — every failure
 * collapses to `not_found` so the endpoint never leaks which condition
 * failed (or that the event exists at all).
 */
export async function getPublicVolunteerWaiver(
  deps: GetPublicVolunteerWaiverDeps,
  rawInput: unknown,
): Promise<GetPublicVolunteerWaiverOutput> {
  const input = parseInput(getPublicVolunteerWaiverInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const event = await tx.events.getById(input.eventId);

    // Conservative gate: collapse every "not visible" branch into the same
    // `not_found` shape (mirrors listPublicEventVolunteerRoles).
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }
    if (event.status !== "PUBLISHED") {
      throw fail("EVENT_NOT_FOUND");
    }
    if (!event.volunteeringEnabled) {
      throw fail("EVENT_NOT_FOUND");
    }

    const noGate: GetPublicVolunteerWaiverOutput = {
      waiverRequired: false,
      waiver: null,
      alreadyAccepted: false,
    };

    if (!event.volunteerWaiverRequired || !event.waiverTemplateId) {
      return noGate;
    }

    const template = await tx.waiverTemplates.getById(event.waiverTemplateId);
    if (!template) {
      // Template deleted after assignment — no gate (same degradation as
      // get-event-waiver and the submit path).
      return noGate;
    }

    const alreadyAccepted = input.actorHumanId
      ? (await tx.volunteerWaiverAcceptances.findCurrentForHuman(
          input.actorHumanId,
          template.id,
          template.version,
        )) !== null
      : false;

    deps.logger?.info("volunteering.get_public_waiver", {
      eventId: event.id,
      waiverTemplateId: template.id,
      waiverVersion: template.version,
      alreadyAccepted,
    });

    return {
      waiverRequired: true,
      waiver: {
        templateId: template.id,
        version: template.version,
        title: template.name,
        body: template.body,
      },
      alreadyAccepted,
    };
  });
}
