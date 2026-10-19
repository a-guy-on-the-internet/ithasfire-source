import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { isAskOwnerWithheld } from "./_shared/ask-owner-withheld";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getPublicAskWaiverInputSchema = z
  .object({
    askId: z.string().uuid(),
    /**
     * Optional viewer — when present, `alreadyOnFile` reflects whether
     * this Human has a current acceptance on file. Injected from ctx by
     * the transport (optional auth); guests always get `false`.
     */
    actorHumanId: z.string().uuid().nullish(),
  })
  .strict();

export type GetPublicAskWaiverInput = z.infer<
  typeof getPublicAskWaiverInputSchema
>;

export type PublicAskWaiver = {
  id: string;
  name: string;
  body: string;
  version: number;
};

export type GetPublicAskWaiverOutput = {
  /**
   * Effective gate: true only when the ask flag is on AND a waiver
   * template is assigned and resolvable. A flag with no (or a deleted)
   * template imposes no gate — same semantics as the submit path
   * (`resolveWaiverGate`) and the event twin (getPublicVolunteerWaiver).
   */
  waiverRequired: boolean;
  waiver: PublicAskWaiver | null;
  /**
   * True when the signed-in viewer already has an acceptance on file for
   * the current template + version (returning volunteer — the form shows
   * "already on file" instead of the checkbox). Always false for guests;
   * only meaningful when `waiverRequired` is true.
   */
  alreadyOnFile: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPublicAskWaiverDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public, unauthenticated read powering the waiver section of the generic
 * ask signup page `/v/[askId]` (ask-level-volunteer-waivers FR-005).
 * Ask-side sibling of `getPublicVolunteerWaiver`.
 *
 * Visibility gate mirrors `getPublicVolunteerAsk` EXACTLY (NFR-003):
 * missing, DRAFT, and ARCHIVED asks all collapse into the same
 * `ask_not_found` shape — no existence oracle. PAUSED and CLOSED stay
 * readable so an already-shared signup link can render its friendly
 * closed state with the waiver context intact; the submit use case
 * independently refuses non-OPEN asks, so exposing the waiver here can
 * never open a signup path.
 *
 * The on-file lookup only runs for signed-in viewers — a guest read must
 * never become a probe for whether some email's human accepted this
 * waiver (same anti-oracle rule as the submit gate).
 */
export async function getPublicAskWaiver(
  deps: GetPublicAskWaiverDeps,
  rawInput: unknown,
): Promise<GetPublicAskWaiverOutput> {
  const input = parseInput(getPublicAskWaiverInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);

    // Conservative gate: missing, DRAFT, and ARCHIVED all collapse into
    // the same `not_found` shape (exact parity with getPublicVolunteerAsk),
    // including a withheld owner's ask (ban that sticks).
    if (
      !ask ||
      ask.status === "DRAFT" ||
      ask.status === "ARCHIVED" ||
      (await isAskOwnerWithheld(tx, ask))
    ) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    const noGate: GetPublicAskWaiverOutput = {
      waiverRequired: false,
      waiver: null,
      alreadyOnFile: false,
    };

    if (!ask.waiverRequired || !ask.waiverTemplateId) {
      return noGate;
    }

    const template = await tx.waiverTemplates.getById(ask.waiverTemplateId);
    if (!template) {
      // Template unresolvable after assignment — no gate (same
      // degradation as the submit path). The Restrict FK makes this
      // near-impossible for asks, but the read must never 500 on it.
      return noGate;
    }

    const alreadyOnFile = input.actorHumanId
      ? (await tx.volunteerWaiverAcceptances.findCurrentForHuman(
          input.actorHumanId,
          template.id,
          template.version,
        )) !== null
      : false;

    deps.logger?.info("volunteering.get_public_ask_waiver", {
      askId: ask.id,
      waiverTemplateId: template.id,
      waiverVersion: template.version,
      alreadyOnFile,
    });

    return {
      waiverRequired: true,
      waiver: {
        id: template.id,
        name: template.name,
        body: template.body,
        version: template.version,
      },
      alreadyOnFile,
    };
  });
}
