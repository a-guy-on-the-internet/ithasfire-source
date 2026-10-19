/**
 * SavedSnippet — a short piece of text an owner keeps to reuse
 * (booking-the-night FR-013, decision N18). Mirrors the Prisma model as
 * string unions so core never imports `@prisma/client`.
 *
 * Today the only kind in use is DECLINE_REASON: the reasons a venue or sender
 * gives when a booking is declined, closed, cancelled or passed on. ASK is
 * reserved for the deferred ask templates.
 */

/** Mirrors Prisma `SavedSnippetOwnerType` (same members as the other owner enums). */
export type SavedSnippetOwnerType = "HUMAN" | "ORGANIZATION";

/** Mirrors Prisma `SavedSnippetKind`. ASK has no writer yet. */
export type SavedSnippetKind = "DECLINE_REASON" | "ASK";

/**
 * Limits core enforces before any write (the repo does not): at most
 * {@link SAVED_SNIPPETS_MAX_PER_KIND} rows per (owner, kind), and the plain-
 * text bounds the DB columns also carry (VarChar(60) / VarChar(500)).
 */
export const SAVED_SNIPPETS_MAX_PER_KIND = 30;
export const SAVED_SNIPPET_LABEL_MAX = 60;
export const SAVED_SNIPPET_BODY_MAX = 500;

/** The owner pair every method is scoped by. */
export interface SavedSnippetOwner {
  ownerType: SavedSnippetOwnerType;
  ownerId: string;
}

export interface SavedSnippetRecord extends SavedSnippetOwner {
  id: string;
  kind: SavedSnippetKind;
  /** Plain text, ≤ 60. The picker's title. */
  label: string;
  /** Plain text, ≤ 500. What is inserted into the reason field. */
  body: string;
  /** 0-based position in the owner's list for this kind. */
  sortOrder: number;
  /** Copied from a platform default (still editable and removable). */
  isStarter: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListSavedSnippetsInput extends SavedSnippetOwner {
  /** Omit for every kind (ordered by kind first). */
  kind?: SavedSnippetKind;
}

export interface CreateSavedSnippetInput extends SavedSnippetOwner {
  kind: SavedSnippetKind;
  label: string;
  body: string;
  /** Defaults to 0. Core passes the end of the list when appending. */
  sortOrder?: number;
  /** Defaults to false. */
  isStarter?: boolean;
}

/**
 * Partial update. The owner pair is REQUIRED and goes in the adapter's WHERE
 * clause (IDOR backstop): a snippet id from another owner matches zero rows
 * and the adapter returns `null`. Kind and owner never change.
 */
export interface UpdateSavedSnippetInput extends SavedSnippetOwner {
  id: string;
  label?: string;
  body?: string;
}

/** Same owner-scoped WHERE discipline as {@link UpdateSavedSnippetInput}. */
export interface DeleteSavedSnippetInput extends SavedSnippetOwner {
  id: string;
}

/**
 * Replace the order of an owner's list for one kind. `orderedIds` must be
 * EXACTLY the ids that list holds — no extras, none missing, no duplicates —
 * or nothing is written (see `SavedSnippetsRepo.reorder`).
 */
export interface ReorderSavedSnippetsInput extends SavedSnippetOwner {
  kind: SavedSnippetKind;
  orderedIds: readonly string[];
}

/**
 * One owner's list for one kind — the key of a `SavedSnippetList` row (the
 * starter-copy marker and the list lock; see `SavedSnippetsRepo.lockList`).
 */
export interface SavedSnippetListKey extends SavedSnippetOwner {
  kind: SavedSnippetKind;
}

/** What `lockList` returns: the list row's state, read under the lock. */
export interface SavedSnippetListState {
  /** When the platform starters were copied in; `null` until they are. */
  startersCopiedAt: Date | null;
}
