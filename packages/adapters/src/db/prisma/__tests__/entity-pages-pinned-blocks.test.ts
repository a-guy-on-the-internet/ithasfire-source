/**
 * Unit tests for the entity-pages repo's PINNED-block contract
 * (venue-track-record-and-review-switch R6 / FR-012).
 *
 * The mocked client EMULATES the partial unique index
 * "PageBlock_pinned_kind_per_page_key" (migration 20260924140000): an insert
 * of `track_record` for a page that already has one in ANY section throws
 * P2002. The index is section-blind by ruling; only the main-only presence
 * rule in `applyTemplateSeed` is section-aware, and its job is to make sure a
 * stray non-main copy is never SILENTLY accepted as present — the insert is
 * then attempted and refused, typed.
 *
 *  - `createBlock` and the seed's in-tx create both map that P2002 to the
 *    SAME typed BLOCK_PINNED / add_duplicate error core raises from its own
 *    check-then-create, so a loser gets a 412 (or a typed Sentry entry from
 *    the seed path), never a raw Prisma error.
 *
 * The real index is proven by `\d "PageBlock"` on a migrated database.
 */
import { describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import { makeEntityPagesRepo } from "../entity-pages";
import type { PrismaClientOrTx } from "../types";

const knownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError("unique violation", {
    code,
    clientVersion: "test",
  });

type Row = {
  kind: string;
  orderIndex: number;
  section: string;
};

/** Emulates the partial unique index: pinned kinds only, any section. */
const PINNED_KINDS = new Set(["track_record"]);

function makeHarness(opts?: {
  existing?: Row[];
  createImpl?: (args: { data: Record<string, unknown> }) => Promise<unknown>;
}) {
  const rows: Row[] = [...(opts?.existing ?? [])];
  let seq = 0;
  const findFirst = vi.fn(async () => null);
  const findMany = vi.fn(async () => [...rows]);
  const create = vi.fn(
    opts?.createImpl ??
      (async ({ data }: { data: Record<string, unknown> }) => {
        const kind = data.kind as string;
        if (PINNED_KINDS.has(kind) && rows.some((r) => r.kind === kind)) {
          throw knownError("P2002");
        }
        rows.push({
          kind,
          orderIndex: data.orderIndex as number,
          section: (data.section as string | undefined) ?? "main",
        });
        return {
          id: `b-${seq++}`,
          pageId: data.pageId,
          kind,
          orderIndex: data.orderIndex,
          data: data.data,
          visible: data.visible,
        };
      }),
  );
  const $executeRaw = vi.fn(async () => 1);
  // No `$transaction` on purpose: withEntityPagesTransaction then runs the
  // seed body against this client directly.
  const prisma = {
    pageBlock: { findFirst, findMany, create },
    $executeRaw,
  } as unknown as PrismaClientOrTx;
  return { repo: makeEntityPagesRepo(prisma), findMany, create };
}

const SEED = { pageId: "page-1", category: "venue", appliedMarker: "venue@4" };

describe("entity-pages repo — pinned blocks", () => {
  describe("createBlock", () => {
    it("a recovery add against a stray non-main copy hits the index and is mapped to BLOCK_PINNED / add_duplicate", async () => {
      const { repo, create } = makeHarness({
        existing: [{ kind: "track_record", orderIndex: 0, section: "memberships" }],
      });

      await expect(
        repo.createBlock({ pageId: "page-1", kind: "track_record", data: {} }),
      ).rejects.toMatchObject({
        code: "BLOCK_PINNED",
        meta: { kind: "track_record", attempted: "add_duplicate" },
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("leaves every other known error alone", async () => {
      const { repo } = makeHarness({
        createImpl: async () => {
          throw knownError("P2003");
        },
      });

      await expect(
        repo.createBlock({ pageId: "page-1", kind: "about", data: {} }),
      ).rejects.toMatchObject({ code: "P2003" });
    });
  });

  describe("applyTemplateSeed", () => {
    it("a stray non-main pinned copy is NOT counted as present: the insert is attempted, the index refuses it, and the error is the typed BLOCK_PINNED (not raw P2002)", async () => {
      const { repo, findMany, create } = makeHarness({
        existing: [{ kind: "track_record", orderIndex: 0, section: "memberships" }],
      });

      await expect(
        repo.applyTemplateSeed({
          ...SEED,
          blocks: [{ kind: "track_record", pinned: true }],
        }),
      ).rejects.toMatchObject({
        code: "BLOCK_PINNED",
        meta: { kind: "track_record", attempted: "add_duplicate" },
      });
      // The in-tx re-read must see `section` to apply the main-only rule.
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ section: true }),
        }),
      );
      // Attempted, not skipped.
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("non-pinned candidates stay section-blind; a pinned one with no copy anywhere is created in main", async () => {
      const { repo, create } = makeHarness({
        existing: [{ kind: "photos", orderIndex: 0, section: "memberships" }],
      });

      const created = await repo.applyTemplateSeed({
        ...SEED,
        blocks: [
          { kind: "track_record", pinned: true },
          { kind: "photos" },
          { kind: "about" },
        ],
      });

      expect(created.map((b) => b.kind)).toEqual(["track_record", "about"]);
      expect(created[0]).toMatchObject({ section: "main", orderIndex: 1 });
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("a pinned candidate already in main is skipped (never a second copy)", async () => {
      const { repo, create } = makeHarness({
        existing: [{ kind: "track_record", orderIndex: 0, section: "main" }],
      });

      const created = await repo.applyTemplateSeed({
        ...SEED,
        blocks: [{ kind: "track_record", pinned: true }],
      });

      expect(created).toEqual([]);
      expect(create).not.toHaveBeenCalled();
    });

    it("an out-of-vocabulary section counts as main, exactly as core's normaliser reads it", async () => {
      const { repo, create } = makeHarness({
        existing: [{ kind: "track_record", orderIndex: 0, section: "future_surface" }],
      });

      const created = await repo.applyTemplateSeed({
        ...SEED,
        blocks: [{ kind: "track_record", pinned: true }],
      });

      expect(created).toEqual([]);
      expect(create).not.toHaveBeenCalled();
    });
  });
});
