/**
 * May the current actor edit this PLACE's page, and as whom (moderator place
 * page spec docs/specs/2026-10-14/moderator-place-page.spec.yaml, FR-005,
 * D8). Asked BEFORE the editor opens, so the place page and the
 * /platform/places panel show "Edit page" only when the editor would load.
 *
 * ADVISORY, the way `getCommunityPlaceEditability` is: it runs the same
 * check every page use case runs first (`resolveEntityPageEditor`) without
 * the claim lock and writes nothing (no template seed either). A moderator's
 * write re-checks under the lock, so a claim landing between this answer and
 * a save still refuses the save.
 *
 * The answer:
 *   - owner (`canManagePlace`)            canEditPage true, editorKind "owner"
 *   - moderator / ADMIN, place unowned,   canEditPage true,
 *     ACTIVE                              editorKind "community_moderator"
 *   - moderator / ADMIN, refused          canEditPage false, editorKind null,
 *                                         reason from the refusal:
 *       "OWNED" | "CLAIM_PENDING"   PLACE_HAS_OWNER's meta.reason
 *       "ARCHIVED"                  PLACE_ARCHIVED
 *       "NOT_ACTIVE"                PLACE_NOT_ACTIVE (SUSPENDED)
 *       "SECOND_FACTOR_REQUIRED"    the role holder has no second factor
 *   - anyone else                         canEditPage false, editorKind null,
 *                                         reason "NOT_ALLOWED", and nothing
 *                                         about who owns the place.
 *
 * Unlike `getCommunityPlaceEditability` it does not refuse a non-moderator:
 * any signed-in visitor of a place page asks it. Refused (thrown):
 * PLACE_NOT_FOUND for an unknown place, but only to a moderator (an
 * outsider's answer is NOT_ALLOWED whether or not the place exists, as
 * `canManagePlace` answers for a missing place).
 */

import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveEntityPageEditor } from "./entity-page-access";

export const getPlacePageEditAccessInputSchema = z
  .object({
    actorHumanId: z.string().min(1).max(200),
    placeId: z.string().uuid(),
  })
  .strict();

export const PLACE_PAGE_EDIT_REFUSAL_REASONS = [
  "OWNED",
  "CLAIM_PENDING",
  "ARCHIVED",
  "NOT_ACTIVE",
  "SECOND_FACTOR_REQUIRED",
  "NOT_ALLOWED",
] as const;

export const getPlacePageEditAccessOutputSchema = z
  .object({
    placeId: z.string(),
    canEditPage: z.boolean(),
    editorKind: z.enum(["owner", "community_moderator"]).nullable(),
    reason: z.enum(PLACE_PAGE_EDIT_REFUSAL_REASONS).nullable(),
  })
  .strict();

export type GetPlacePageEditAccessInput = z.infer<
  typeof getPlacePageEditAccessInputSchema
>;
export type GetPlacePageEditAccessOutput = z.infer<
  typeof getPlacePageEditAccessOutputSchema
>;
export type PlacePageEditRefusalReason =
  (typeof PLACE_PAGE_EDIT_REFUSAL_REASONS)[number];

export type GetPlacePageEditAccessDeps = {
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  repos: Pick<Repos, "places" | "events">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/** The refusal a page use case would throw, as the probe's reason. */
function refusalReason(err: unknown): PlacePageEditRefusalReason | null {
  if (!isAppError(err)) return null;
  switch (err.code) {
    case "NOT_RESOURCE_OWNER":
      return "NOT_ALLOWED";
    case "SECOND_FACTOR_REQUIRED":
      return "SECOND_FACTOR_REQUIRED";
    case "PLACE_ARCHIVED":
      return "ARCHIVED";
    case "PLACE_NOT_ACTIVE":
      return "NOT_ACTIVE";
    case "PLACE_HAS_OWNER":
      return err.meta?.reason === "CLAIM_PENDING" ? "CLAIM_PENDING" : "OWNED";
    default:
      // PLACE_NOT_FOUND and anything unexpected propagate.
      return null;
  }
}

export async function getPlacePageEditAccess(
  deps: GetPlacePageEditAccessDeps,
  rawInput: unknown,
): Promise<GetPlacePageEditAccessOutput> {
  const logger = deps.logger?.child({ useCase: "getPlacePageEditAccess" });

  const execute = async (): Promise<GetPlacePageEditAccessOutput> => {
    const input = parseInput(getPlacePageEditAccessInputSchema, rawInput);
    try {
      const editor = await resolveEntityPageEditor(deps, {
        actorHumanId: input.actorHumanId,
        ownerType: "PLACE",
        ownerId: input.placeId,
      });
      return getPlacePageEditAccessOutputSchema.parse({
        placeId: input.placeId,
        canEditPage: true,
        editorKind: editor.kind,
        reason: null,
      });
    } catch (err) {
      // Not a swallow: each mapped code IS the answer (a refusal the editor
      // would give); anything else is rethrown.
      const reason = refusalReason(err);
      if (reason === null) throw err;
      return getPlacePageEditAccessOutputSchema.parse({
        placeId: input.placeId,
        canEditPage: false,
        editorKind: null,
        reason,
      });
    }
  };

  if (logger) return logger.withTime("getPlacePageEditAccess", execute);
  return execute();
}
