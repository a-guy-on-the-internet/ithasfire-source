import type {
  NoteRecord,
  SetNoteInput,
  SetNoteResult,
} from "@th/types/repos/notes";

/**
 * The shared-note write (holds-without-a-request FR-012), one body for the
 * three tables that carry the note trio (BookingHold, BookingRequest,
 * Event). Each repo passes its own model's conditional update and read;
 * this decides the WHERE and the result.
 *
 * The edited-at check rides the UPDATE's WHERE (`noteUpdatedAt = expected`,
 * or `IS NULL` for a never-saved note), so two editors who opened the same
 * stamp cannot both land: the second UPDATE re-evaluates its WHERE after the
 * first commits and matches zero rows. Zero rows is then either a missing
 * row or a conflict, told apart by one read.
 */
export async function writeNote(
  ops: {
    /** `updateMany` on `{ id, ...where }` with `data`; returns the count. */
    update(
      where: { noteUpdatedAt?: Date | null },
      data: NoteRecord,
    ): Promise<number>;
    /** The row's note columns, or null when the row does not exist. */
    read(): Promise<NoteRecord | null>;
  },
  input: SetNoteInput,
): Promise<SetNoteResult> {
  const data: NoteRecord = {
    note: input.note === null || input.note === "" ? null : input.note,
    noteUpdatedByHumanId: input.updatedByHumanId,
    noteUpdatedAt: input.now,
  };
  const where =
    input.expectedUpdatedAt === undefined
      ? {}
      : { noteUpdatedAt: input.expectedUpdatedAt };
  const count = await ops.update(where, data);
  if (count > 0) return { status: "saved", note: data };
  const current = await ops.read();
  if (!current) return { status: "not_found" };
  return { status: "conflict", current };
}

/** Prisma `select` for the note trio. */
export const NOTE_SELECT = {
  note: true,
  noteUpdatedByHumanId: true,
  noteUpdatedAt: true,
} as const;
