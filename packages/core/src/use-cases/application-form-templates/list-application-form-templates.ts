import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";
import { toApplicationFormTemplateDto } from "./_shared/to-dto";
import {
  listApplicationFormTemplatesInputSchema,
  listApplicationFormTemplatesResultSchema,
  type ListApplicationFormTemplatesResult,
} from "./schemas";

export type ListApplicationFormTemplatesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/**
 * The caller's own library PLUS the platform starter catalogue (spec Phase 4).
 *
 * Two separate arrays rather than one union: the picker groups them under
 * different headings ("From Ithas Fire" vs "Your templates") and the platform
 * rows are read-only, so collapsing them would make the UI re-derive the split
 * from `isPlatform` on every render — and get it wrong once.
 *
 * Archived rows are excluded on BOTH sides by the repo reads. There is no
 * `includeArchived` option: archiving here is "retire from the picker", and a
 * fork-on-use model means no live form depends on the row afterwards.
 */
export async function listApplicationFormTemplates(
  deps: ListApplicationFormTemplatesDeps,
  rawInput: unknown,
): Promise<ListApplicationFormTemplatesResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "listApplicationFormTemplates",
  });

  const input = parseInput(listApplicationFormTemplatesInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    // View access to the OWNER decides whether the caller sees the owner's
    // library. The platform catalogue is public to any authenticated
    // organizer, but it is still fetched behind this check so an unauthorized
    // caller learns nothing at all about the scope they named.
    await ensureTemplateOwnerAccess(
      tx,
      input.ownerScope,
      input.ownerId,
      input.actorHumanId,
      { purpose: "view" },
      scopedLogger,
    );

    // This list feeds the attendee form builder. It still includes PERFORM
    // templates (the seeded "Performer / artist application") so step 2 of
    // open calls stays behaviour-neutral: organizers keep using it here
    // until the open-call builder has its own picker.
    // TODO(open-calls step 11): narrow to ATTEND once the open-call builder has its own picker
    const purposes = ["ATTEND", "PERFORM"] as const;
    const [owned, platform] = await Promise.all([
      tx.applicationFormTemplates.list(
        input.ownerScope,
        input.ownerId,
        purposes,
      ),
      tx.applicationFormTemplates.listPlatformTemplates(purposes),
    ]);

    return listApplicationFormTemplatesResultSchema.parse({
      items: owned.map(toApplicationFormTemplateDto),
      platform: platform.map(toApplicationFormTemplateDto),
    });
  });
}
