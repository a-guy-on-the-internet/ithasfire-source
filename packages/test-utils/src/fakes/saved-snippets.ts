import type {
  SavedSnippetListKey,
  SavedSnippetOwner,
  SavedSnippetRecord,
  SavedSnippetsRepo,
} from "@th/ports/repos/saved-snippets";

/** A stored `SavedSnippetList` row (the adapter's starter marker + lock). */
export interface FakeSavedSnippetList extends SavedSnippetListKey {
  startersCopiedAt: Date | null;
  createdAt: Date;
}

export type FakeSavedSnippets = SavedSnippetsRepo & {
  /** Stored objects, keyed by id — the methods hand out copies. */
  rows: Map<string, SavedSnippetRecord>;
  /** Stored list rows, keyed by `${ownerType}|${ownerId}|${kind}`. */
  lists: Map<string, FakeSavedSnippetList>;
  /** How many times `lockList` was called, per list key — for "took the lock" assertions. */
  lockCalls: Map<string, number>;
};

/** The `lists` / `lockCalls` key for one (owner, kind) list. */
export const savedSnippetListKey = (key: SavedSnippetListKey): string =>
  `${key.ownerType}|${key.ownerId}|${key.kind}`;

/** Postgres enum DECLARATION order — what the adapter's ORDER BY sorts by. */
const KIND_ORDER = { DECLINE_REASON: 0, ASK: 1 } as const;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function listOrder(a: SavedSnippetRecord, b: SavedSnippetRecord): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.sortOrder - b.sortOrder ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    cmpStr(a.id, b.id)
  );
}

const sameOwner = (row: SavedSnippetOwner, owner: SavedSnippetOwner) =>
  row.ownerType === owner.ownerType && row.ownerId === owner.ownerId;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `5a5a5a5a-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

/**
 * Map-backed SavedSnippetsRepo with the adapter's real semantics (house
 * style: real behaviour, not vi.fn stubs — spy with `vi.spyOn` when call
 * assertions are needed):
 *   - every method is scoped by the owner pair; another owner's id reads as
 *     absent (`update` → null, `delete` → false, `reorder` → conflict);
 *   - `listByOwner` orders (kind, sortOrder, createdAt, id), kind in enum
 *     declaration order, like Postgres;
 *   - `create` defaults sortOrder 0 / isStarter false, and throws for an
 *     empty label or body (the SQL CHECK's stand-in);
 *   - `reorder` requires EXACTLY the (owner, kind) list's ids, else throws
 *     `{ code: "conflict", message: "saved_snippet_order_changed" }` and
 *     writes nothing; otherwise stamps sortOrder 0..n-1;
 *   - `lockList` creates the list row once and returns its real
 *     `startersCopiedAt`; `markStartersCopied` on a list never locked throws
 *     `saved_snippet_list_not_locked`, like the adapter. The LOCK itself is
 *     not modelled (JS is single-threaded; the serialisation is proven on
 *     Postgres in the adapter's integration test). `lockCalls` counts calls
 *     so a use-case test can assert the lock was taken; `getListState` is
 *     the non-locking read (null until a list row exists) and is NOT counted;
 *   - `deleteByOwner` removes the owner's snippets and list rows, every kind.
 * The fake does NOT enforce the VarChar bounds or the 30-per-kind cap; core
 * does, first. Every method returns COPIES.
 */
export function createFakeSavedSnippets(
  opts: { now?: () => Date } = {},
): FakeSavedSnippets {
  const rows = new Map<string, SavedSnippetRecord>();
  const lists = new Map<string, FakeSavedSnippetList>();
  const lockCalls = new Map<string, number>();
  const now = opts.now ?? (() => new Date());
  const copy = (row: SavedSnippetRecord) => structuredClone(row);

  return {
    rows,
    lists,
    lockCalls,

    async listByOwner({ ownerType, ownerId, kind }) {
      return [...rows.values()]
        .filter(
          (row) =>
            sameOwner(row, { ownerType, ownerId }) &&
            (kind === undefined || row.kind === kind),
        )
        .sort(listOrder)
        .map(copy);
    },

    async create(input) {
      if (input.label.length === 0 || input.body.length === 0) {
        // Stand-in for the SQL CHECK "SavedSnippet_nonempty_check".
        throw new Error("SavedSnippet_nonempty_check");
      }
      const at = now();
      const row: SavedSnippetRecord = {
        id: nextId(),
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        kind: input.kind,
        label: input.label,
        body: input.body,
        sortOrder: input.sortOrder ?? 0,
        isStarter: input.isStarter ?? false,
        createdAt: at,
        updatedAt: at,
      };
      rows.set(row.id, row);
      return copy(row);
    },

    async update(input) {
      const current = rows.get(input.id);
      if (!current || !sameOwner(current, input)) return null;
      const next: SavedSnippetRecord = {
        ...current,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        updatedAt: now(),
      };
      rows.set(next.id, next);
      return copy(next);
    },

    async delete(input) {
      const current = rows.get(input.id);
      if (!current || !sameOwner(current, input)) return false;
      rows.delete(input.id);
      return true;
    },

    async reorder({ ownerType, ownerId, kind, orderedIds }) {
      const list = [...rows.values()].filter(
        (row) => sameOwner(row, { ownerType, ownerId }) && row.kind === kind,
      );
      const current = new Set(list.map((row) => row.id));
      const requested = new Set(orderedIds);
      const sameSet =
        requested.size === orderedIds.length &&
        requested.size === current.size &&
        [...requested].every((id) => current.has(id));
      if (!sameSet) {
        throw {
          code: "conflict",
          message: "saved_snippet_order_changed",
        } as const;
      }
      orderedIds.forEach((id, index) => {
        const row = rows.get(id)!;
        // The adapter's updateMany bumps @updatedAt on every row it touches.
        rows.set(id, { ...row, sortOrder: index, updatedAt: now() });
      });
      return [...rows.values()]
        .filter(
          (row) => sameOwner(row, { ownerType, ownerId }) && row.kind === kind,
        )
        .sort(listOrder)
        .map(copy);
    },

    async lockList({ ownerType, ownerId, kind }) {
      const key = savedSnippetListKey({ ownerType, ownerId, kind });
      lockCalls.set(key, (lockCalls.get(key) ?? 0) + 1);
      let list = lists.get(key);
      if (!list) {
        list = {
          ownerType,
          ownerId,
          kind,
          startersCopiedAt: null,
          createdAt: now(),
        };
        lists.set(key, list);
      }
      return {
        startersCopiedAt: list.startersCopiedAt
          ? new Date(list.startersCopiedAt.getTime())
          : null,
      };
    },

    async getListState(input) {
      // No lockCalls bump: this is the read path's NON-locking read.
      const list = lists.get(savedSnippetListKey(input));
      if (!list) return null;
      return {
        startersCopiedAt: list.startersCopiedAt
          ? new Date(list.startersCopiedAt.getTime())
          : null,
      };
    },

    async markStartersCopied(input, at) {
      const key = savedSnippetListKey(input);
      const list = lists.get(key);
      if (!list) {
        throw {
          code: "conflict",
          message: "saved_snippet_list_not_locked",
        } as const;
      }
      lists.set(key, { ...list, startersCopiedAt: new Date(at.getTime()) });
    },

    async deleteByOwner(owner) {
      let deleted = 0;
      for (const [id, row] of rows) {
        if (sameOwner(row, owner)) {
          rows.delete(id);
          deleted += 1;
        }
      }
      for (const [key, list] of lists) {
        if (sameOwner(list, owner)) lists.delete(key);
      }
      return { deleted };
    },
  };
}
