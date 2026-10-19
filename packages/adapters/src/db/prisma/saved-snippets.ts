import type { $Enums, Prisma } from "@prisma/client";
import type {
  SavedSnippetKind,
  SavedSnippetOwnerType,
  SavedSnippetRecord,
  SavedSnippetsRepo,
} from "@th/ports/repos/saved-snippets";

import type { PrismaClientOrTx } from "./types";

// Compile-time parity guard (same posture as booking-holds.ts): the port's
// string unions and the Prisma enums must stay literal-for-literal identical
// in BOTH directions, so the `as` casts in the mapper are shape-preserving.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _ownerTypeParity: MutuallyAssignable<
  SavedSnippetOwnerType,
  $Enums.SavedSnippetOwnerType
> = true;
const _kindParity: MutuallyAssignable<
  SavedSnippetKind,
  $Enums.SavedSnippetKind
> = true;
void _ownerTypeParity;
void _kindParity;

export const SAVED_SNIPPET_SELECT = {
  id: true,
  ownerType: true,
  ownerId: true,
  kind: true,
  label: true,
  body: true,
  sortOrder: true,
  isStarter: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Kind first (enum declaration order), then the list order, with createdAt /
 * id as deterministic tiebreakers — `create` defaults sortOrder to 0, so
 * equal values are normal until the first reorder.
 */
const LIST_ORDER = [
  { kind: "asc" },
  { sortOrder: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.SavedSnippetOrderByWithRelationInput[];

export const mapSavedSnippetRecord = (row: {
  id: string;
  ownerType: string;
  ownerId: string;
  kind: string;
  label: string;
  body: string;
  sortOrder: number;
  isStarter: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SavedSnippetRecord => ({
  id: row.id,
  ownerType: row.ownerType as SavedSnippetOwnerType,
  ownerId: row.ownerId,
  kind: row.kind as SavedSnippetKind,
  label: row.label,
  body: row.body,
  sortOrder: row.sortOrder,
  isStarter: row.isStarter,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const ORDER_CHANGED = {
  code: "conflict",
  message: "saved_snippet_order_changed",
} as const;

const LIST_NOT_LOCKED = {
  code: "conflict",
  message: "saved_snippet_list_not_locked",
} as const;

export function makeSavedSnippetsRepo(
  p: PrismaClientOrTx,
): SavedSnippetsRepo {
  return {
    async listByOwner({ ownerType, ownerId, kind }) {
      const rows = await p.savedSnippet.findMany({
        where: { ownerType, ownerId, ...(kind ? { kind } : {}) },
        orderBy: LIST_ORDER,
        select: SAVED_SNIPPET_SELECT,
      });
      return rows.map(mapSavedSnippetRecord);
    },

    async create(input) {
      const row = await p.savedSnippet.create({
        data: {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          kind: input.kind,
          label: input.label,
          body: input.body,
          sortOrder: input.sortOrder ?? 0,
          isStarter: input.isStarter ?? false,
        },
        select: SAVED_SNIPPET_SELECT,
      });
      return mapSavedSnippetRecord(row);
    },

    async update(input) {
      const data: Prisma.SavedSnippetUncheckedUpdateManyInput = {};
      if (input.label !== undefined) data.label = input.label;
      if (input.body !== undefined) data.body = input.body;

      // The owner pair in the WHERE (not just an assert): an id from another
      // owner matches zero rows (IDOR backstop; same discipline as
      // bookingTags.update).
      const where = {
        id: input.id,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
      };
      const result = await p.savedSnippet.updateMany({ where, data });
      if (result.count === 0) return null;
      const row = await p.savedSnippet.findFirst({
        where,
        select: SAVED_SNIPPET_SELECT,
      });
      return row ? mapSavedSnippetRecord(row) : null;
    },

    async delete(input) {
      const result = await p.savedSnippet.deleteMany({
        where: {
          id: input.id,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
        },
      });
      return result.count > 0;
    },

    async reorder({ ownerType, ownerId, kind, orderedIds }) {
      // 1. Lock the list's rows in a stable (id) order, so two reorders of
      // the same list serialise here instead of deadlocking on their
      // differently-ordered writes below (port doc: call inside repos.tx()).
      // Parameterised — never string-built; the enum casts make the bound
      // text comparable to the enum columns.
      const locked = await p.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "SavedSnippet"
        WHERE "ownerType" = ${ownerType}::"SavedSnippetOwnerType"
          AND "ownerId" = ${ownerId}
          AND "kind" = ${kind}::"SavedSnippetKind"
        ORDER BY "id"
        FOR UPDATE
      `;
      // 2. The order must name exactly the list: a stale client (a row added
      // or removed since it read), a foreign id or a duplicate writes nothing.
      const current = new Set(locked.map((row) => row.id));
      const requested = new Set(orderedIds);
      const sameSet =
        requested.size === orderedIds.length &&
        requested.size === current.size &&
        [...requested].every((id) => current.has(id));
      if (!sameSet) throw ORDER_CHANGED;

      // 3. Sequential (not Promise.all): `p` may be an interactive-tx client.
      // Each write keeps the owner pair + kind in its WHERE.
      for (let i = 0; i < orderedIds.length; i += 1) {
        await p.savedSnippet.updateMany({
          where: { id: orderedIds[i]!, ownerType, ownerId, kind },
          data: { sortOrder: i },
        });
      }

      const rows = await p.savedSnippet.findMany({
        where: { ownerType, ownerId, kind },
        orderBy: LIST_ORDER,
        select: SAVED_SNIPPET_SELECT,
      });
      return rows.map(mapSavedSnippetRecord);
    },

    async lockList({ ownerType, ownerId, kind }) {
      // 1. Make sure the list row exists. ON CONFLICT DO NOTHING never raises,
      // and when another transaction has inserted the same key but not yet
      // committed, Postgres makes this INSERT WAIT for it — so even the very
      // first lock on a list serialises. Parameterised (never string-built);
      // the enum casts make the bound text comparable to the enum columns.
      await p.$executeRaw`
        INSERT INTO "SavedSnippetList" ("id", "ownerType", "ownerId", "kind", "createdAt")
        VALUES (
          gen_random_uuid()::text,
          ${ownerType}::"SavedSnippetOwnerType",
          ${ownerId},
          ${kind}::"SavedSnippetKind",
          ${new Date()}
        )
        ON CONFLICT ("ownerType", "ownerId", "kind") DO NOTHING
      `;
      // 2. The lock itself (port doc: inside repos.tx(), before the caller
      // counts or copies).
      const locked = await p.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "SavedSnippetList"
        WHERE "ownerType" = ${ownerType}::"SavedSnippetOwnerType"
          AND "ownerId" = ${ownerId}
          AND "kind" = ${kind}::"SavedSnippetKind"
        FOR UPDATE
      `;
      const lockedId = locked[0]?.id;
      // Unreachable: step 1 guarantees the row, and nothing deletes it but
      // deleteByOwner (account erasure). Fail loudly rather than lock nothing.
      if (!lockedId) throw LIST_NOT_LOCKED;
      // 3. The state, read under the lock through the typed client so the
      // timestamp maps like every other Prisma DateTime (a raw read of a
      // tz-naive column is parsed by the driver, not by Prisma).
      const row = await p.savedSnippetList.findUnique({
        where: { id: lockedId },
        select: { startersCopiedAt: true },
      });
      if (!row) throw LIST_NOT_LOCKED;
      return { startersCopiedAt: row.startersCopiedAt };
    },

    async getListState({ ownerType, ownerId, kind }) {
      // Plain read — no FOR UPDATE, no upsert (port doc: the read path's
      // fast path only; writes decide under lockList).
      const row = await p.savedSnippetList.findUnique({
        where: { ownerType_ownerId_kind: { ownerType, ownerId, kind } },
        select: { startersCopiedAt: true },
      });
      return row ? { startersCopiedAt: row.startersCopiedAt } : null;
    },

    async markStartersCopied({ ownerType, ownerId, kind }, at) {
      const result = await p.savedSnippetList.updateMany({
        where: { ownerType, ownerId, kind },
        data: { startersCopiedAt: at },
      });
      if (result.count === 0) throw LIST_NOT_LOCKED;
    },

    async deleteByOwner({ ownerType, ownerId }) {
      // Sequential (not Promise.all): `p` may be an interactive-tx client.
      // List rows FIRST: lockList + reorder lock the list row before the
      // snippet rows, so deleting in the same order cannot deadlock with them.
      await p.savedSnippetList.deleteMany({ where: { ownerType, ownerId } });
      const snippets = await p.savedSnippet.deleteMany({
        where: { ownerType, ownerId },
      });
      return { deleted: snippets.count };
    },
  } satisfies SavedSnippetsRepo;
}
