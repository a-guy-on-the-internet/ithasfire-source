import { describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";
import { AppError } from "@th/errors";

import { makeSeatsRepo, SEAT_BATCH_SIZE } from "../seats";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// materializeSections must issue O(1) statements per section, never one per
// seat. The stub below deliberately has NO `seat.create`, `seat.upsert` or
// `seatSection.upsert` — any per-row call path blows up with a TypeError
// instead of quietly passing.
// ---------------------------------------------------------------------------

const EVENT_ID = "evt-1";
const LAYOUT_ID = "layout-1";

type ExistingSection = {
  id: string;
  layoutSectionId: string;
  name: string;
  type: "GA" | "RESERVED";
  capacity: number | null;
};

type ExistingSeat = {
  id: string;
  seatSectionId: string;
  label: string;
  row: string | null;
  number: number | null;
};

function makePrisma(
  opts: {
    existingSections?: ExistingSection[];
    existingSeats?: ExistingSeat[];
    /** layoutSectionIds that createManyAndReturn should silently skip (ON CONFLICT DO NOTHING). */
    skipOnCreate?: string[];
    /** layoutSectionIds that the post-create re-read should find (a concurrent tx's rows). */
    foundOnReread?: ExistingSection[];
    /** Make seatSection.update raise a unique-violation (rename collision). */
    updateThrowsP2002?: boolean;
  } = {},
) {
  const existingSections = opts.existingSections ?? [];
  const existingSeats = opts.existingSeats ?? [];
  const skipOnCreate = new Set(opts.skipOnCreate ?? []);
  let sectionFindManyCalls = 0;

  const seatSection = {
    findMany: vi.fn(async () => {
      sectionFindManyCalls += 1;
      return sectionFindManyCalls === 1
        ? existingSections
        : (opts.foundOnReread ?? []);
    }),
    createManyAndReturn: vi.fn(async (args: any) =>
      (args.data as Array<{ layoutSectionId: string }>)
        .filter((row) => !skipOnCreate.has(row.layoutSectionId))
        .map((row) => ({
          id: `db-${row.layoutSectionId}`,
          layoutSectionId: row.layoutSectionId,
        })),
    ),
    update: vi.fn(async (args: any) => {
      if (opts.updateThrowsP2002) {
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      return { id: args.where.id };
    }),
  };

  const seat = {
    findMany: vi.fn(async () => existingSeats),
    createMany: vi.fn(async (args: any) => ({ count: args.data.length })),
  };

  const $executeRaw = vi.fn(async () => 1);

  const prisma = { seatSection, seat, $executeRaw };
  return {
    prisma: prisma as unknown as PrismaClientOrTx,
    seatSection,
    seat,
    $executeRaw,
  };
}

function seatIdsFor(sectionId: string, rows: string[], perRow: number) {
  const out: string[] = [];
  for (const row of rows) {
    for (let n = 1; n <= perRow; n++) out.push(`${sectionId}-${row}-${n}`);
  }
  return out;
}

const SECTION_A = {
  sectionId: "orch",
  label: "Orchestra",
  capacity: 2000,
  kind: "seat" as const,
};
const SECTION_B = {
  sectionId: "balc",
  label: "Balcony",
  capacity: 500,
  kind: "seat" as const,
};

describe("makeSeatsRepo.materializeSections — batching", () => {
  it("keeps the batch under the Postgres bind-parameter ceiling", () => {
    // 8 values per Seat row (id, seatSectionId, label, row, number, status,
    // createdAt, updatedAt); 32767 is the conservative Int16 driver cap.
    expect(SEAT_BATCH_SIZE * 8).toBeLessThanOrEqual(32767);
    expect(SEAT_BATCH_SIZE).toBeGreaterThan(0);
  });

  it("fresh event: ceil(N / batch) createMany calls with skipDuplicates and no per-seat statements", async () => {
    const { prisma, seatSection, seat, $executeRaw } = makePrisma();
    const repo = makeSeatsRepo(prisma);

    // 2000 + 500 = 2500 seats → 3 batches of ≤ 1000.
    const seatIds = [
      ...seatIdsFor("orch", ["A", "B", "C", "D"], 500),
      ...seatIdsFor("balc", ["AA"], 500),
    ];

    const result = await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [SECTION_A, SECTION_B],
      seatIds,
    });

    expect(result.sectionsCreated).toBe(2);
    expect(result.seatsCreated).toBe(2500);
    expect(result.sectionIdMap).toEqual({ orch: "db-orch", balc: "db-balc" });

    // Sections: one read, one batched insert, no updates.
    expect(seatSection.findMany).toHaveBeenCalledTimes(1);
    expect(seatSection.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(seatSection.createManyAndReturn.mock.calls[0]![0]).toMatchObject({
      skipDuplicates: true,
    });
    expect(seatSection.update).not.toHaveBeenCalled();

    // Seats: one read, ceil(2500 / SEAT_BATCH_SIZE) inserts, no updates.
    expect(seat.findMany).toHaveBeenCalledTimes(1);
    const expectedBatches = Math.ceil(2500 / SEAT_BATCH_SIZE);
    expect(seat.createMany).toHaveBeenCalledTimes(expectedBatches);
    let rowsSeen = 0;
    for (const call of seat.createMany.mock.calls) {
      const args = call[0] as { data: any[]; skipDuplicates: boolean };
      expect(args.skipDuplicates).toBe(true);
      expect(args.data.length).toBeLessThanOrEqual(SEAT_BATCH_SIZE);
      rowsSeen += args.data.length;
      for (const row of args.data) {
        expect(row.status).toBe("AVAILABLE");
        expect(["db-orch", "db-balc"]).toContain(row.seatSectionId);
      }
    }
    expect(rowsSeen).toBe(2500);
    expect($executeRaw).not.toHaveBeenCalled();

    // Spot-check the row/number/label derivation survived the rewrite.
    const first = (seat.createMany.mock.calls[0]![0] as any).data[0];
    expect(first).toMatchObject({
      seatSectionId: "db-orch",
      label: "A1",
      row: "A",
      number: 1,
      status: "AVAILABLE",
    });
  });

  it("re-materialisation: existing seats are not re-inserted; changed row/number goes through one batched UPDATE", async () => {
    const existingSeats: ExistingSeat[] = [
      { id: "s-1", seatSectionId: "db-orch", label: "A1", row: "A", number: 1 },
      // Same label as what "orch-A1-1" would derive, but stored with a
      // different row/number → the old per-seat upsert would have rewritten it.
      {
        id: "s-2",
        seatSectionId: "db-orch",
        label: "A11",
        row: "A",
        number: 11,
      },
    ];
    const { prisma, seat, $executeRaw } = makePrisma({
      existingSections: [
        {
          id: "db-orch",
          layoutSectionId: "orch",
          name: "Orchestra",
          type: "RESERVED",
          capacity: 2000,
        },
      ],
      existingSeats,
    });
    const repo = makeSeatsRepo(prisma);

    const result = await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [SECTION_A],
      seatIds: ["orch-A-1", "orch-A1-1", "orch-A-2"],
    });

    // Only A2 is new.
    expect(seat.createMany).toHaveBeenCalledTimes(1);
    expect((seat.createMany.mock.calls[0]![0] as any).data).toEqual([
      {
        seatSectionId: "db-orch",
        label: "A2",
        row: "A",
        number: 2,
        status: "AVAILABLE",
      },
    ]);
    expect(result.seatsCreated).toBe(1);
    expect(result.sectionsCreated).toBe(0);

    // A11 changed (row A/11 → A1/1); A1 unchanged → exactly one UPDATE batch.
    expect($executeRaw).toHaveBeenCalledTimes(1);
    const sql = $executeRaw.mock.calls[0]![0] as {
      strings: string[];
      values: unknown[];
    };
    expect(sql.strings.join("?")).toMatch(/UPDATE "Seat"/);
    expect(sql.values).toEqual(["s-2", "A1", 1]);
  });

  it("dedupes colliding labels last-wins within one call, mirroring the old upsert order", async () => {
    const { prisma, seat } = makePrisma();
    const repo = makeSeatsRepo(prisma);

    // "orch-A-11" and "orch-A1-1" both derive label "A11"; the old loop
    // created the first then upserted the second over it.
    await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [SECTION_A],
      seatIds: ["orch-A-11", "orch-A1-1"],
    });

    expect(seat.createMany).toHaveBeenCalledTimes(1);
    expect((seat.createMany.mock.calls[0]![0] as any).data).toEqual([
      {
        seatSectionId: "db-orch",
        label: "A11",
        row: "A1",
        number: 1,
        status: "AVAILABLE",
      },
    ]);
  });

  it("falls back to the raw seat id as label when the id has no row/number, or the number is not an integer", async () => {
    const { prisma, seat } = makePrisma();
    const repo = makeSeatsRepo(prisma);

    await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [{ ...SECTION_A, sectionId: "ga", label: "GA", kind: "ga" }],
      seatIds: ["ga-standing", "ga-A-x"],
    });

    expect((seat.createMany.mock.calls[0]![0] as any).data).toEqual([
      {
        seatSectionId: "db-ga",
        label: "ga-standing",
        row: null,
        number: null,
        status: "AVAILABLE",
      },
      {
        seatSectionId: "db-ga",
        label: "ga-A-x",
        row: "A",
        number: null,
        status: "AVAILABLE",
      },
    ]);
  });

  it("updates only the existing sections whose name/type/capacity changed", async () => {
    const { prisma, seatSection } = makePrisma({
      existingSections: [
        {
          id: "db-orch",
          layoutSectionId: "orch",
          name: "Orchestra",
          type: "RESERVED",
          capacity: 2000,
        },
        {
          id: "db-balc",
          layoutSectionId: "balc",
          name: "Old Balcony",
          type: "RESERVED",
          capacity: 400,
        },
      ],
    });
    const repo = makeSeatsRepo(prisma);

    const result = await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [SECTION_A, SECTION_B],
      seatIds: [],
    });

    expect(seatSection.createManyAndReturn).not.toHaveBeenCalled();
    expect(seatSection.update).toHaveBeenCalledTimes(1);
    expect(seatSection.update.mock.calls[0]![0]).toEqual({
      where: { id: "db-balc" },
      data: { name: "Balcony", type: "RESERVED", capacity: 500 },
    });
    expect(result.sectionIdMap).toEqual({ orch: "db-orch", balc: "db-balc" });
    expect(result.sectionsCreated).toBe(0);
    expect(result.seatsCreated).toBe(0);
  });

  it("maps kind → type, with the label fallback when kind is absent", async () => {
    const { prisma, seatSection } = makePrisma();
    const repo = makeSeatsRepo(prisma);

    await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [
        { sectionId: "a", label: "Floor", capacity: 10, kind: "ga" },
        { sectionId: "b", label: "Front", capacity: 10, kind: "seat" },
        { sectionId: "c", label: "General Admission", capacity: 10 },
        { sectionId: "d", label: "ga", capacity: 10 },
        { sectionId: "e", label: "Mezzanine", capacity: 10 },
      ],
      seatIds: [],
    });

    const data = (seatSection.createManyAndReturn.mock.calls[0]![0] as any)
      .data as Array<{ layoutSectionId: string; type: string }>;
    expect(data.map((d) => [d.layoutSectionId, d.type])).toEqual([
      ["a", "GA"],
      ["b", "RESERVED"],
      ["c", "GA"],
      ["d", "GA"],
      ["e", "RESERVED"],
    ]);
  });

  it("recovers a section a concurrent transaction inserted (skipped by ON CONFLICT DO NOTHING) via re-read", async () => {
    const { prisma, seatSection } = makePrisma({
      skipOnCreate: ["balc"],
      foundOnReread: [
        {
          id: "db-balc-theirs",
          layoutSectionId: "balc",
          name: "Balcony",
          type: "RESERVED",
          capacity: 500,
        },
      ],
    });
    const repo = makeSeatsRepo(prisma);

    const result = await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [SECTION_A, SECTION_B],
      seatIds: ["balc-AA-1"],
    });

    expect(seatSection.findMany).toHaveBeenCalledTimes(2);
    expect(result.sectionIdMap).toEqual({
      orch: "db-orch",
      balc: "db-balc-theirs",
    });
    expect(result.sectionsCreated).toBe(1);
  });

  it("throws when a section is skipped on insert and still absent on re-read (eventId+name collision)", async () => {
    const { prisma } = makePrisma({ skipOnCreate: ["balc"] });
    const repo = makeSeatsRepo(prisma);

    const err = await repo
      .materializeSections({
        eventId: EVENT_ID,
        placeLayoutId: LAYOUT_ID,
        sections: [SECTION_A, SECTION_B],
        seatIds: [],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: "SLUG_TAKEN",
      message: "seat_section_name_taken",
      meta: { eventId: EVENT_ID, layoutSectionIds: ["balc"] },
    });
  });

  it("renames existing sections BEFORE inserting new ones, so a new section can take a renamed section's old name", async () => {
    const { prisma, seatSection } = makePrisma({
      existingSections: [
        {
          id: "db-balc",
          layoutSectionId: "balc",
          name: "Balcony",
          type: "RESERVED",
          capacity: 500,
        },
      ],
    });
    const repo = makeSeatsRepo(prisma);

    const result = await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [
        { ...SECTION_B, label: "Mezzanine" },
        { sectionId: "balc2", label: "Balcony", capacity: 100, kind: "seat" },
      ],
      seatIds: [],
    });

    expect(seatSection.update).toHaveBeenCalledTimes(1);
    expect(seatSection.createManyAndReturn).toHaveBeenCalledTimes(1);
    const updateOrder = seatSection.update.mock.invocationCallOrder[0]!;
    const createOrder =
      seatSection.createManyAndReturn.mock.invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(createOrder);
    expect(result.sectionsCreated).toBe(1);
    expect(result.sectionIdMap).toEqual({ balc: "db-balc", balc2: "db-balc2" });
  });

  it("wraps a rename collision on the drift update as the same typed error", async () => {
    const { prisma } = makePrisma({
      existingSections: [
        {
          id: "db-balc",
          layoutSectionId: "balc",
          name: "Balcony",
          type: "RESERVED",
          capacity: 500,
        },
      ],
      updateThrowsP2002: true,
    });
    const repo = makeSeatsRepo(prisma);

    const err = await repo
      .materializeSections({
        eventId: EVENT_ID,
        placeLayoutId: LAYOUT_ID,
        sections: [{ ...SECTION_B, label: "Orchestra" }],
        seatIds: [],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: "SLUG_TAKEN",
      message: "seat_section_name_taken",
      meta: {
        eventId: EVENT_ID,
        layoutSectionIds: ["balc"],
        name: "Orchestra",
      },
    });
    expect((err as AppError).cause).toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("no sections → no statements at all", async () => {
    const { prisma, seatSection, seat } = makePrisma();
    const repo = makeSeatsRepo(prisma);

    const result = await repo.materializeSections({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sections: [],
      seatIds: ["orch-A-1"],
    });

    expect(result).toEqual({
      sectionsCreated: 0,
      seatsCreated: 0,
      sectionIdMap: {},
    });
    expect(seatSection.findMany).not.toHaveBeenCalled();
    expect(seat.findMany).not.toHaveBeenCalled();
  });
});
