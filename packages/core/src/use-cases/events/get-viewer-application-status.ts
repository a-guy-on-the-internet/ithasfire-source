import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import { applicationSubmissionStatusSchema } from "@th/schema";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getViewerApplicationStatusInputSchema = z
  .object({
    eventId: z.string().uuid(),
    /**
     * The SIGNED-IN viewer, from the session — never client input. `null` for
     * an anonymous caller, who always gets "no submission": there is
     * deliberately no guest equivalent, because any read that answered "has
     * <email> applied?" would be an enumeration oracle.
     */
    viewerHumanId: z.string().uuid().nullable(),
  })
  .strict();

export const getViewerApplicationStatusOutputSchema = z.object({
  hasSubmission: z.boolean(),
  submission: z
    .object({
      id: z.string().uuid(),
      status: applicationSubmissionStatusSchema,
      createdAt: z.date(),
      reviewedAt: z.date().nullable(),
      /**
       * The organizer's note to THIS applicant on a rejection. Populated ONLY
       * while the submission is REJECTED — a rescinded or otherwise re-decided
       * row never carries a stale note to the viewer, whatever the column
       * still holds.
       */
      decisionReason: z.string().nullable(),
    })
    .nullable(),
});

export type GetViewerApplicationStatusInput = z.infer<
  typeof getViewerApplicationStatusInputSchema
>;
export type GetViewerApplicationStatusOutput = z.infer<
  typeof getViewerApplicationStatusOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetViewerApplicationStatusDeps = {
  repos: Pick<Repos, "eventApplications">;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

const NO_SUBMISSION: GetViewerApplicationStatusOutput = {
  hasSubmission: false,
  submission: null,
};

/**
 * The viewer's OWN latest application to an event, for the application gate.
 *
 * Scoped by construction: the only read is keyed on `(eventId,
 * viewerHumanId)`, and `viewerHumanId` comes from the session, so this can
 * never return another applicant's row.
 */
export async function getViewerApplicationStatus(
  deps: GetViewerApplicationStatusDeps,
  rawInput: unknown,
): Promise<GetViewerApplicationStatusOutput> {
  const input = parseInput(getViewerApplicationStatusInputSchema, rawInput);
  if (!input.viewerHumanId) {
    return NO_SUBMISSION;
  }

  const submission =
    await deps.repos.eventApplications.getSubmissionByEventAndHuman(
      input.eventId,
      "ATTEND",
      input.viewerHumanId,
    );
  if (!submission) {
    return NO_SUBMISSION;
  }

  return getViewerApplicationStatusOutputSchema.parse({
    hasSubmission: true,
    submission: {
      id: submission.id,
      status: submission.status,
      createdAt: submission.createdAt,
      reviewedAt: submission.reviewedAt,
      decisionReason:
        submission.status === "REJECTED"
          ? (submission.decisionReason ?? null)
          : null,
    },
  });
}
