import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ApplicationNoteRecord } from "@th/ports/repos/events";

import { parseInput } from "../../../lib/io";
import { plainTextMultilineRequired } from "../../../lib/sanitize-plain-text";
import { stampFirstOpen } from "./_shared/first-open";
import { anchorOfForm } from "./_shared/open-call-anchor";
import { resolveOrganizerSubmission } from "./_shared/organizer-side";

/** Note body bound: the thread's (booking messages) 4000, sanitized first. */
export const APPLICATION_NOTE_MAX = 4000;

/** An organizer-side note on the wire. Organizer side only (NFR-002). */
export const applicationNoteSchema = z
  .object({
    id: z.uuid(),
    authorHumanId: z.uuid().nullable(),
    authorName: z.string().nullable(),
    body: z.string(),
    createdAt: z.date(),
  })
  .strict();

export type ApplicationNote = z.infer<typeof applicationNoteSchema>;

export function projectApplicationNote(row: ApplicationNoteRecord): ApplicationNote {
  return {
    id: row.id,
    authorHumanId: row.authorHumanId,
    authorName: row.authorName,
    body: row.body,
    createdAt: row.createdAt,
  };
}

export const addApplicationNoteInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
    submissionId: z.uuid(),
    body: plainTextMultilineRequired(APPLICATION_NOTE_MAX),
  })
  .strict();

export const addApplicationNoteOutputSchema = z
  .object({ note: applicationNoteSchema })
  .strict();

export type AddApplicationNoteInput = z.input<typeof addApplicationNoteInputSchema>;
export type AddApplicationNoteOutput = z.infer<typeof addApplicationNoteOutputSchema>;

export type AddApplicationNoteDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Add an organizer-side note to an application (FR-014). Anyone on the
 * organizer side; any status (notes are the side's own record, and FR-023
 * keeps past calls reviewable).
 *
 * A note is a judgement on the answers, so it stamps `openedAt` in the same
 * transaction when nobody has opened the card yet (FR-010 edit lock,
 * `stampFirstOpen`), exactly like opening it.
 *
 * Notes are append-only in v1: no edit, no delete (the minimal surface the
 * spec asks for; a wrong note is answered by another note). The author is
 * detached, not the note deleted, when an account goes (schema SetNull).
 *
 * Audit: metadata only, never the note text.
 */
export async function addApplicationNote(
  deps: AddApplicationNoteDeps,
  rawInput: unknown,
): Promise<AddApplicationNoteOutput> {
  const input = parseInput(addApplicationNoteInputSchema, rawInput);
  const now = deps.clock.now();

  const note = await deps.repos.tx(async (tx) => {
    const { form, submission } = await resolveOrganizerSubmission(tx, input);
    await stampFirstOpen(tx, {
      form,
      submission,
      actorHumanId: input.actorHumanId,
      now,
      via: "note",
    });
    const created = await tx.eventApplications.createApplicationNote({
      submissionId: submission.id,
      authorHumanId: input.actorHumanId,
      body: input.body,
      createdAt: now,
    });
    const ref = anchorOfForm(form);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_application_note_added",
      data: {
        actorHumanId: input.actorHumanId,
        formId: form.id,
        submissionId: submission.id,
        noteId: created.id,
        bodyLength: created.body.length,
      },
      at: now,
    });
    return created;
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "note_added",
    formId: input.formId,
    submissionId: input.submissionId,
    actorHumanId: input.actorHumanId,
  });

  return addApplicationNoteOutputSchema.parse({ note: projectApplicationNote(note) });
}
