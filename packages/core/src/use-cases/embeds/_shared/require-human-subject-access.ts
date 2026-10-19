import type { HumansRepo } from "@th/ports/repos/humans";
import { fail } from "@th/errors";

/**
 * Authorization gate for the `human` embed subject — the personal (non-org)
 * admin context.
 *
 * Rule: an actor may manage embeds ONLY for their OWN human subject. There is
 * deliberately no delegation model for personal contexts (unlike `organization`
 * subjects, which fan out through `requireOrgMembership`, or `place` subjects,
 * which fan out through owning-org membership). If personal-context delegation
 * ever lands, this is the single place to widen — every embed use case routes
 * its `human` branch through here.
 *
 * Mirrors `ensureSeriesOwnerAccess`'s HUMAN scope
 * (`packages/core/src/use-cases/series/permissions.ts`): existence check first
 * so a bad subjectId reports `HUMAN_NOT_FOUND` rather than being masked as an
 * authorization failure, then the identity check.
 *
 * @throws `HUMAN_NOT_FOUND` when the subject human does not exist.
 * @throws `NOT_RESOURCE_OWNER` when the actor is not the subject.
 */
export async function requireHumanSubjectAccess(
  repos: { humans: Pick<HumansRepo, "getById"> },
  subjectHumanId: string,
  actorHumanId: string,
): Promise<void> {
  const human = await repos.humans.getById(subjectHumanId);
  if (!human) {
    throw fail("HUMAN_NOT_FOUND");
  }
  if (subjectHumanId !== actorHumanId) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "human" } });
  }
}
