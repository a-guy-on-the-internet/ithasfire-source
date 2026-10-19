import type {
  CreateSavedSnippetInput,
  DeleteSavedSnippetInput,
  ListSavedSnippetsInput,
  ReorderSavedSnippetsInput,
  SavedSnippetListKey,
  SavedSnippetListState,
  SavedSnippetOwner,
  SavedSnippetRecord,
  UpdateSavedSnippetInput,
} from "@th/types/repos/saved-snippets";

/**
 * An owner's saved snippets (booking-the-night FR-013): reusable reasons
 * today, ask templates later. Storage only — the per-(owner, kind) cap of
 * {@link SAVED_SNIPPETS_MAX_PER_KIND}, plain-text sanitizing, and copying the
 * platform starters on first use are core's.
 *
 * OWNER SCOPE: every method takes the owner pair and puts it in the WHERE
 * clause, so an id from another owner reads as absent (`null` / `false` /
 * a reorder conflict). The CALLER still decides who may act for an owner
 * (org edit role, or the human themself) before calling.
 *
 * THE LIST LOCK. Each (owner, kind) list has one `SavedSnippetList` row: the
 * starter-copy marker and the lock. Every write that changes a list's
 * membership or order — create, copying the starters, reorder — runs inside
 * `repos.tx()` and calls {@link SavedSnippetsRepo.lockList} FIRST, before it
 * counts the list (the 30-per-list cap) or reads `startersCopiedAt`, so the
 * list it counts is the list it writes. Same posture as
 * `BookingHoldsRepo.lockLine`.
 */
export interface SavedSnippetsRepo {
  /**
   * The owner's snippets, ordered (kind, sortOrder, createdAt, id) with kind
   * in enum declaration order (DECLINE_REASON before ASK). `kind` narrows the
   * read to one list.
   */
  listByOwner(input: ListSavedSnippetsInput): Promise<SavedSnippetRecord[]>;
  /**
   * Insert one snippet. The DB refuses an empty label or body (CHECK
   * "SavedSnippet_nonempty_check") and over-long text (VarChar bounds) with a
   * raw Prisma error — core validates first, so neither is reachable from a
   * use case.
   */
  create(input: CreateSavedSnippetInput): Promise<SavedSnippetRecord>;
  /** Partial update scoped by (id, owner); `null` when no row matched. */
  update(input: UpdateSavedSnippetInput): Promise<SavedSnippetRecord | null>;
  /** Delete scoped by (id, owner). Resolves `true` iff a row was removed. */
  delete(input: DeleteSavedSnippetInput): Promise<boolean>;
  /**
   * Rewrite `sortOrder` 0..n-1 for one (owner, kind) list in the order
   * given and return the list. `orderedIds` must be exactly that list's ids;
   * otherwise nothing is written and the adapter throws
   * `{ code: "conflict", message: "saved_snippet_order_changed" }` (a stale
   * client, a foreign id, or a duplicate).
   *
   * Call it inside `repos.tx()`: the read-compare-write is several
   * statements, and only a transaction makes them one step.
   */
  reorder(input: ReorderSavedSnippetsInput): Promise<SavedSnippetRecord[]>;
  /**
   * Take the (owner, kind) list's lock and read its state. Upserts the
   * `SavedSnippetList` row (`INSERT … ON CONFLICT DO NOTHING`), then
   * `SELECT … FOR UPDATE` on it, so a second caller on the same list blocks
   * until the first transaction ends — including the very first call, when
   * the row does not exist yet (the second INSERT waits on the first's
   * uncommitted row).
   *
   * MUST be called inside `repos.tx()`: the row lock is released at commit,
   * so outside a transaction it locks nothing. create, copy-starters and
   * reorder call it before anything else (see the port doc). Idempotent: the
   * list row is created once, ever.
   */
  lockList(input: SavedSnippetListKey): Promise<SavedSnippetListState>;
  /**
   * The (owner, kind) list row's state WITHOUT the lock: a plain read, `null`
   * when the list has never been locked (no row yet). For the read path's
   * lock-free fast path only — "starters already copied, nothing to do". A
   * decision that WRITES (copy the starters, count against the cap) is never
   * made on this; it is made under {@link lockList}, which re-reads the state.
   */
  getListState(
    input: SavedSnippetListKey,
  ): Promise<SavedSnippetListState | null>;
  /**
   * Record that the platform starters were copied into this list, so they
   * are never copied again (even after every snippet is deleted). Call under
   * {@link lockList} in the same transaction, which guarantees the row exists;
   * a missing row throws `{ code: "conflict", message:
   * "saved_snippet_list_not_locked" }`.
   */
  markStartersCopied(input: SavedSnippetListKey, at: Date): Promise<void>;
  /**
   * Erasure: delete every snippet AND every list row the owner has, of every
   * kind (account deletion — `executeHumanDeletionTx`). Owner-pair scoped like
   * every other method; another owner's rows, including a different owner
   * TYPE with the same id, are untouched. Resolves the number of snippets
   * removed. Idempotent.
   */
  deleteByOwner(owner: SavedSnippetOwner): Promise<{ deleted: number }>;
}

export type {
  CreateSavedSnippetInput,
  DeleteSavedSnippetInput,
  ListSavedSnippetsInput,
  ReorderSavedSnippetsInput,
  SavedSnippetKind,
  SavedSnippetListKey,
  SavedSnippetListState,
  SavedSnippetOwner,
  SavedSnippetOwnerType,
  SavedSnippetRecord,
  UpdateSavedSnippetInput,
} from "@th/types/repos/saved-snippets";
export {
  SAVED_SNIPPET_BODY_MAX,
  SAVED_SNIPPET_LABEL_MAX,
  SAVED_SNIPPETS_MAX_PER_KIND,
} from "@th/types/repos/saved-snippets";
