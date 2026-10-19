/**
 * One shared note on a hold, an event or a booking request
 * (holds-without-a-request spec 2026-09-30, H21 / FR-012). Plain text up to
 * 2000 characters, last-write-wins, with who wrote it last and when.
 *
 * The repos store and compare; they never gate. Who may read or edit a
 * note is the use case's call per subject (FR-012), made before the write.
 */
export interface NoteRecord {
  /** Null = no note. */
  note: string | null;
  /** Plain id, no FK (house style). Null until the first save. */
  noteUpdatedByHumanId: string | null;
  noteUpdatedAt: Date | null;
}

/** The longest note the columns hold (`VarChar(2000)`). */
export const NOTE_MAX_LENGTH = 2000;

/**
 * Write one note. `note` is already sanitized and length-checked by core;
 * null or "" clears it (the adapter stores null for both).
 *
 * `expectedUpdatedAt` is the edited-at conflict check (FR-012, "Changed by X
 * since you opened it"): the `noteUpdatedAt` the editor opened the note
 * with, `null` when it opened an empty, never-saved note. The write lands
 * only while the stored stamp still equals it. Omitted = no check (a
 * system write that must win).
 */
export interface SetNoteInput {
  id: string;
  note: string | null;
  updatedByHumanId: string;
  now: Date;
  expectedUpdatedAt?: Date | null;
}

/**
 * - `saved`: the write landed; `note` is what is now stored.
 * - `conflict`: someone saved since `expectedUpdatedAt`; nothing was
 *   written, `current` is what is stored now (for the conflict message).
 * - `not_found`: no row with that id.
 */
export type SetNoteResult =
  | { status: "saved"; note: NoteRecord }
  | { status: "conflict"; current: NoteRecord }
  | { status: "not_found" };
