import { beforeEach, describe, expect, it } from "vitest";

import type {
  SavedSnippetOwner,
  SavedSnippetsRepo,
} from "@th/ports/repos/saved-snippets";

/**
 * The SavedSnippetsRepo contract (booking-the-night FR-013), run against BOTH
 * the in-memory fake (fakes/__tests__/saved-snippets.test.ts) and the Prisma
 * adapter on real Postgres (adapters/.../booking-the-night.integration.test.ts),
 * so the fake cannot drift from the adapter the use cases will run on.
 *
 * `setup` must also leave the LIST rows empty. `lockList` is called outside a
 * transaction here, which is fine for its state (the row and
 * `startersCopiedAt`); the lock itself is proven by the integration test's
 * two-transaction case.
 *
 * `setup` returns a FRESH, EMPTY repo per test (the integration side
 * truncates the table first).
 *
 * Deliberately not asserted here: the order of rows with EQUAL sortOrder
 * (both sides tiebreak on createdAt then id, but the ids differ in kind —
 * uuid v4 vs a counter), and adapter-only SQL facts (VarChar bounds, the
 * enum casts) — those live in the integration test.
 */
export function runSavedSnippetsContract(
  name: string,
  setup: () => Promise<SavedSnippetsRepo> | SavedSnippetsRepo,
): void {
  const ORG: SavedSnippetOwner = {
    ownerType: "ORGANIZATION",
    ownerId: "0c0c0c0c-0000-4000-8000-000000000001",
  };
  const OTHER_ORG: SavedSnippetOwner = {
    ownerType: "ORGANIZATION",
    ownerId: "0c0c0c0c-0000-4000-8000-000000000002",
  };
  // Same id string as ORG, other owner type: must be a different list.
  const HUMAN_SAME_ID: SavedSnippetOwner = {
    ownerType: "HUMAN",
    ownerId: ORG.ownerId,
  };

  describe(`SavedSnippetsRepo contract — ${name}`, () => {
    let repo: SavedSnippetsRepo;
    beforeEach(async () => {
      repo = await setup();
    });

    const reason = (
      owner: SavedSnippetOwner,
      label: string,
      sortOrder: number,
      extra: { isStarter?: boolean } = {},
    ) =>
      repo.create({
        ...owner,
        kind: "DECLINE_REASON",
        label,
        body: `${label} — body`,
        sortOrder,
        ...extra,
      });

    it("create stamps defaults and returns the stored row", async () => {
      const row = await repo.create({
        ...ORG,
        kind: "DECLINE_REASON",
        label: "Booked that week",
        body: "We're already booked that week, sorry.",
      });
      expect(row).toMatchObject({
        ...ORG,
        kind: "DECLINE_REASON",
        label: "Booked that week",
        body: "We're already booked that week, sorry.",
        sortOrder: 0,
        isStarter: false,
      });
      expect(row.id).toEqual(expect.any(String));
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);

      const starter = await reason(ORG, "Not a fit", 1, { isStarter: true });
      expect(starter.isStarter).toBe(true);
    });

    it("refuses an empty label or body", async () => {
      await expect(
        repo.create({ ...ORG, kind: "DECLINE_REASON", label: "", body: "x" }),
      ).rejects.toBeDefined();
      await expect(
        repo.create({ ...ORG, kind: "DECLINE_REASON", label: "x", body: "" }),
      ).rejects.toBeDefined();
      expect(await repo.listByOwner(ORG)).toEqual([]);
    });

    it("listByOwner is scoped to the owner PAIR and ordered kind → sortOrder", async () => {
      await reason(ORG, "second", 1);
      await repo.create({
        ...ORG,
        kind: "ASK",
        label: "ask",
        body: "Send a poster",
        sortOrder: 0,
      });
      await reason(ORG, "first", 0);
      await reason(OTHER_ORG, "other org", 0);
      await reason(HUMAN_SAME_ID, "human, same id", 0);

      const all = await repo.listByOwner(ORG);
      // DECLINE_REASON before ASK (enum declaration order), then sortOrder.
      expect(all.map((r) => r.label)).toEqual(["first", "second", "ask"]);

      const reasons = await repo.listByOwner({ ...ORG, kind: "DECLINE_REASON" });
      expect(reasons.map((r) => r.label)).toEqual(["first", "second"]);

      expect(
        (await repo.listByOwner(HUMAN_SAME_ID)).map((r) => r.label),
      ).toEqual(["human, same id"]);
      expect(
        await repo.listByOwner({ ownerType: "HUMAN", ownerId: "nobody" }),
      ).toEqual([]);
    });

    it("update is owner-scoped and partial", async () => {
      const row = await reason(ORG, "Old label", 0, { isStarter: true });

      // Another owner's id reads as absent and changes nothing.
      expect(
        await repo.update({ ...OTHER_ORG, id: row.id, label: "hijack" }),
      ).toBeNull();
      expect(
        await repo.update({ ...HUMAN_SAME_ID, id: row.id, label: "hijack" }),
      ).toBeNull();
      expect(
        await repo.update({ ...ORG, id: "5a5a5a5a-ffff-4fff-8fff-ffffffffffff", label: "x" }),
      ).toBeNull();

      const next = await repo.update({ ...ORG, id: row.id, label: "New label" });
      expect(next).toMatchObject({
        id: row.id,
        label: "New label",
        body: row.body,
        isStarter: true,
        sortOrder: 0,
      });
      const [stored] = await repo.listByOwner(ORG);
      expect(stored!.label).toBe("New label");
    });

    it("delete is owner-scoped", async () => {
      const row = await reason(ORG, "Gone soon", 0);
      expect(await repo.delete({ ...OTHER_ORG, id: row.id })).toBe(false);
      expect(await repo.delete({ ...HUMAN_SAME_ID, id: row.id })).toBe(false);
      expect(await repo.listByOwner(ORG)).toHaveLength(1);
      expect(await repo.delete({ ...ORG, id: row.id })).toBe(true);
      expect(await repo.delete({ ...ORG, id: row.id })).toBe(false);
      expect(await repo.listByOwner(ORG)).toEqual([]);
    });

    it("reorder rewrites 0..n-1 for one (owner, kind) list and leaves the rest", async () => {
      const a = await reason(ORG, "a", 0);
      const b = await reason(ORG, "b", 1);
      const c = await reason(ORG, "c", 2);
      const ask = await repo.create({
        ...ORG,
        kind: "ASK",
        label: "ask",
        body: "Send a poster",
        sortOrder: 7,
      });
      const foreign = await reason(OTHER_ORG, "foreign", 5);

      const out = await repo.reorder({
        ...ORG,
        kind: "DECLINE_REASON",
        orderedIds: [c.id, a.id, b.id],
      });
      expect(out.map((r) => [r.label, r.sortOrder])).toEqual([
        ["c", 0],
        ["a", 1],
        ["b", 2],
      ]);
      const after = await repo.listByOwner(ORG);
      expect(after.find((r) => r.id === ask.id)!.sortOrder).toBe(7);
      const other = await repo.listByOwner(OTHER_ORG);
      expect(other.find((r) => r.id === foreign.id)!.sortOrder).toBe(5);
    });

    it("reorder writes NOTHING unless the ids are exactly the list", async () => {
      const a = await reason(ORG, "a", 0);
      const b = await reason(ORG, "b", 1);
      const foreign = await reason(OTHER_ORG, "foreign", 0);
      const conflict = {
        code: "conflict",
        message: "saved_snippet_order_changed",
      };

      for (const orderedIds of [
        [b.id], // one missing (a stale client)
        [b.id, a.id, foreign.id], // another owner's id
        [b.id, a.id, a.id], // a duplicate
        [b.id, foreign.id], // swapped for a foreign id
      ]) {
        await expect(
          repo.reorder({ ...ORG, kind: "DECLINE_REASON", orderedIds }),
          JSON.stringify(orderedIds),
        ).rejects.toMatchObject(conflict);
      }
      // The ASK list is empty, so a DECLINE_REASON id is foreign to it.
      await expect(
        repo.reorder({ ...ORG, kind: "ASK", orderedIds: [a.id] }),
      ).rejects.toMatchObject(conflict);

      expect(
        (await repo.listByOwner(ORG)).map((r) => [r.label, r.sortOrder]),
      ).toEqual([
        ["a", 0],
        ["b", 1],
      ]);
      // An empty list reorders to empty.
      await expect(
        repo.reorder({ ...ORG, kind: "ASK", orderedIds: [] }),
      ).resolves.toEqual([]);
    });

    it("lockList creates the list row once and reads its state (idempotent)", async () => {
      const list = { ...ORG, kind: "DECLINE_REASON" } as const;
      await expect(repo.lockList(list)).resolves.toEqual({
        startersCopiedAt: null,
      });
      // Again: same row, same state — no duplicate, no error.
      await expect(repo.lockList(list)).resolves.toEqual({
        startersCopiedAt: null,
      });
      // A list holds no snippets of its own.
      expect(await repo.listByOwner(ORG)).toEqual([]);
    });

    it("startersCopiedAt round-trips through markStartersCopied, per (owner, kind) list", async () => {
      const list = { ...ORG, kind: "DECLINE_REASON" } as const;
      const at = new Date("2026-10-01T12:34:56.789Z");
      await repo.lockList(list);
      await repo.markStartersCopied(list, at);

      const state = await repo.lockList(list);
      expect(state.startersCopiedAt).toBeInstanceOf(Date);
      expect(state.startersCopiedAt!.toISOString()).toBe(at.toISOString());

      // The marker survives deleting every snippet in the list.
      const row = await reason(ORG, "only one", 0, { isStarter: true });
      await repo.delete({ ...ORG, id: row.id });
      expect(
        (await repo.lockList(list)).startersCopiedAt!.toISOString(),
      ).toBe(at.toISOString());

      // Other lists are their own: another kind, another owner, and the
      // same id string under another owner type.
      for (const other of [
        { ...ORG, kind: "ASK" },
        { ...OTHER_ORG, kind: "DECLINE_REASON" },
        { ...HUMAN_SAME_ID, kind: "DECLINE_REASON" },
      ] as const) {
        expect(await repo.lockList(other), JSON.stringify(other)).toEqual({
          startersCopiedAt: null,
        });
      }
    });

    it("getListState reads the list row without creating one", async () => {
      const list = { ...ORG, kind: "DECLINE_REASON" } as const;
      // No row yet: null, and the read did not create one.
      await expect(repo.getListState(list)).resolves.toBeNull();
      await expect(repo.getListState(list)).resolves.toBeNull();

      await repo.lockList(list);
      await expect(repo.getListState(list)).resolves.toEqual({
        startersCopiedAt: null,
      });

      const at = new Date("2026-10-02T08:00:00.000Z");
      await repo.markStartersCopied(list, at);
      const state = await repo.getListState(list);
      expect(state!.startersCopiedAt!.toISOString()).toBe(at.toISOString());

      // Scoped to the exact (owner, kind) list, owner TYPE included.
      for (const other of [
        { ...ORG, kind: "ASK" },
        { ...OTHER_ORG, kind: "DECLINE_REASON" },
        { ...HUMAN_SAME_ID, kind: "DECLINE_REASON" },
      ] as const) {
        expect(await repo.getListState(other), JSON.stringify(other)).toBeNull();
      }
    });

    it("markStartersCopied refuses a list that was never locked", async () => {
      await expect(
        repo.markStartersCopied(
          { ...OTHER_ORG, kind: "ASK" },
          new Date("2026-10-01T00:00:00.000Z"),
        ),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "saved_snippet_list_not_locked",
      });
    });

    it("deleteByOwner removes the owner's snippets and list rows, and only theirs", async () => {
      const at = new Date("2026-10-01T00:00:00.000Z");
      await reason(ORG, "a", 0);
      await reason(ORG, "b", 1);
      await repo.create({
        ...ORG,
        kind: "ASK",
        label: "ask",
        body: "Send a poster",
      });
      await repo.lockList({ ...ORG, kind: "DECLINE_REASON" });
      await repo.markStartersCopied({ ...ORG, kind: "DECLINE_REASON" }, at);
      await repo.lockList({ ...ORG, kind: "ASK" });

      await reason(OTHER_ORG, "keep other org", 0);
      await repo.lockList({ ...OTHER_ORG, kind: "DECLINE_REASON" });
      await repo.markStartersCopied({ ...OTHER_ORG, kind: "DECLINE_REASON" }, at);
      await reason(HUMAN_SAME_ID, "keep human", 0);
      await repo.lockList({ ...HUMAN_SAME_ID, kind: "DECLINE_REASON" });
      await repo.markStartersCopied(
        { ...HUMAN_SAME_ID, kind: "DECLINE_REASON" },
        at,
      );

      await expect(repo.deleteByOwner(ORG)).resolves.toEqual({ deleted: 3 });

      expect(await repo.listByOwner(ORG)).toEqual([]);
      // The list rows went too: a fresh lock starts a fresh, unmarked list.
      expect(
        await repo.lockList({ ...ORG, kind: "DECLINE_REASON" }),
      ).toEqual({ startersCopiedAt: null });

      // Everyone else is untouched, rows and markers alike.
      expect(
        (await repo.listByOwner(OTHER_ORG)).map((r) => r.label),
      ).toEqual(["keep other org"]);
      expect(
        (await repo.listByOwner(HUMAN_SAME_ID)).map((r) => r.label),
      ).toEqual(["keep human"]);
      for (const owner of [OTHER_ORG, HUMAN_SAME_ID]) {
        expect(
          (await repo.lockList({ ...owner, kind: "DECLINE_REASON" }))
            .startersCopiedAt!.toISOString(),
        ).toBe(at.toISOString());
      }

      // Idempotent.
      await expect(repo.deleteByOwner(ORG)).resolves.toEqual({ deleted: 0 });
    });
  });
}
