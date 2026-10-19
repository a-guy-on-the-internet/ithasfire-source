import { z } from "zod";

import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { resolveOrganizerSubmission } from "./_shared/organizer-side";
import { applicationNoteSchema, projectApplicationNote } from "./add-application-note";

/** Most notes one read returns. */
export const MAX_APPLICATION_NOTES = 500;

export const listApplicationNotesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
    submissionId: z.uuid(),
  })
  .strict();

export const listApplicationNotesOutputSchema = z
  .object({ notes: z.array(applicationNoteSchema) })
  .strict();

export type ListApplicationNotesInput = z.input<typeof listApplicationNotesInputSchema>;
export type ListApplicationNotesOutput = z.infer<typeof listApplicationNotesOutputSchema>;

export type ListApplicationNotesDeps = {
  repos: Pick<Repos, "eventApplications" | "events" | "series" | "authz">;
};

/**
 * An application's organizer-side notes, oldest first (FR-014). Organizer
 * side only; never on an applicant read. Read-only: does not stamp
 * `openedAt` (opening the card does).
 */
export async function listApplicationNotes(
  deps: ListApplicationNotesDeps,
  rawInput: unknown,
): Promise<ListApplicationNotesOutput> {
  const input = parseInput(listApplicationNotesInputSchema, rawInput);
  const { submission } = await resolveOrganizerSubmission(deps.repos, input);
  const notes = await deps.repos.eventApplications.listApplicationNotes({
    submissionId: submission.id,
    limit: MAX_APPLICATION_NOTES,
  });
  return listApplicationNotesOutputSchema.parse({ notes: notes.map(projectApplicationNote) });
}
