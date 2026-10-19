import { describe, expect, it, vi } from "vitest";

import { makeSeatsRepo } from "../seats";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// The seat-hold reaper must release ORPHANED holds only.
//
// Money audit 2026-09-08 #16: `releaseExpiredHolds` was order-state-blind —
// every HELD seat past the TTL went back on sale, including seats a kept cart
// (PENDING order, PaymentIntent succeeded, webhook lagging) still owned, so
// finalize later minted a ticket for a seat already sold to someone else.
// These are mock-Prisma tests for the QUERY SHAPE; the SQL is proven against
// real Postgres in the sibling `.integration.test.ts`.
// ---------------------------------------------------------------------------

const BEFORE = new Date("2026-09-15T11:45:00.000Z");
const RELEASED_AT = new Date("2026-09-15T12:00:00.000Z");
const SEAT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEAT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type RawCall = [TemplateStringsArray, ...unknown[]];

/** Flatten a tagged-template call into the SQL text Postgres would see, with `$n` placeholders. */
function sqlOf(call: RawCall): string {
  const [strings] = call;
  return strings.reduce((acc, part, i) => acc + (i > 0 ? `$${i}` : "") + part, "");
}

function valuesOf(call: RawCall): unknown[] {
  return call.slice(1);
}

function makePrisma(candidates: { id: string }[]) {
  return {
    $queryRaw: vi.fn(async () => candidates),
    seat: {
      findMany: vi.fn(),
      updateMany: vi.fn(async () => ({ count: candidates.length })),
    },
  };
}

describe("seats.releaseExpiredHolds — candidate query shape", () => {
  it("is ONE raw, schema-qualified, parameterised query that excludes seats on an open cart and seats with a Ticket", async () => {
    const prisma = makePrisma([{ id: SEAT_A }, { id: SEAT_B }]);
    const repo = makeSeatsRepo(prisma as unknown as PrismaClientOrTx);

    const released = await repo.releaseExpiredHolds({
      before: BEFORE,
      releasedAt: RELEASED_AT,
      limit: 100,
    });

    expect(released).toBe(2);
    // The old shape — a Prisma `findMany` — cannot express the jsonb test.
    expect(prisma.seat.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

    const call = prisma.$queryRaw.mock.calls[0] as unknown as RawCall;
    const sql = sqlOf(call);
    // Pooled-Neon-safe schema-qualified names, every table the predicate reads.
    expect(sql).toContain('public."Seat"');
    expect(sql).toContain('public."Ticket"');
    expect(sql).toContain('public."OrderItem"');
    expect(sql).toContain('public."Order"');
    // Only HELD seats, enum compared via ::text, and only past the TTL fence.
    expect(sql).toMatch(/s\.status::text\s*=\s*'HELD'/);
    expect(sql).toMatch(/s\."updatedAt"\s*<\s*\$1/);
    // Existing behaviour kept: a seat with a Ticket is never a candidate.
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1\s*FROM public\."Ticket" t\s*WHERE t\."seatId" = s\.id/);
    // The fix: a seat referenced by an OPEN order's meta.seatIds is that
    // cart's — PENDING and PROCESSING both, nothing terminal.
    expect(sql).toMatch(
      /NOT EXISTS\s*\(\s*SELECT 1\s*FROM public\."OrderItem" oi\s*INNER JOIN public\."Order" o ON o\.id = oi\."orderId"\s*WHERE o\.status::text IN \('PENDING', 'PROCESSING'\)\s*AND oi\.meta -> 'seatIds' \? s\.id/,
    );
    expect(sql).not.toMatch(/'CANCELLED'|'SUCCEEDED'|'REFUNDED'/);
    // The page fence survives, as a bound value.
    expect(sql).toMatch(/LIMIT \$2::int/);
    // Nothing interpolated: the cutoff and the limit are bound parameters.
    expect(valuesOf(call)).toEqual([BEFORE, 100]);
  });

  it("binds NULL for the limit when the caller gives none (LIMIT NULL = no limit)", async () => {
    const prisma = makePrisma([]);
    const repo = makeSeatsRepo(prisma as unknown as PrismaClientOrTx);

    await repo.releaseExpiredHolds({ before: BEFORE, releasedAt: RELEASED_AT });

    const call = prisma.$queryRaw.mock.calls[0] as unknown as RawCall;
    expect(valuesOf(call)).toEqual([BEFORE, null]);
  });

  it("flips exactly the candidate ids, still HELD-guarded, stamped with releasedAt", async () => {
    const prisma = makePrisma([{ id: SEAT_A }, { id: SEAT_B }]);
    const repo = makeSeatsRepo(prisma as unknown as PrismaClientOrTx);

    await repo.releaseExpiredHolds({ before: BEFORE, releasedAt: RELEASED_AT });

    expect(prisma.seat.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.seat.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [SEAT_A, SEAT_B] }, status: "HELD" },
      data: { status: "AVAILABLE", updatedAt: RELEASED_AT },
    });
  });

  it("returns 0 and issues no UPDATE when there are no orphaned candidates", async () => {
    const prisma = makePrisma([]);
    const repo = makeSeatsRepo(prisma as unknown as PrismaClientOrTx);

    const released = await repo.releaseExpiredHolds({
      before: BEFORE,
      releasedAt: RELEASED_AT,
    });

    expect(released).toBe(0);
    expect(prisma.seat.updateMany).not.toHaveBeenCalled();
  });

  it("reports the UPDATE's own count, not the candidate count, so a seat re-held between the two steps is not over-reported", async () => {
    const prisma = makePrisma([{ id: SEAT_A }, { id: SEAT_B }]);
    prisma.seat.updateMany.mockResolvedValue({ count: 1 });
    const repo = makeSeatsRepo(prisma as unknown as PrismaClientOrTx);

    const released = await repo.releaseExpiredHolds({
      before: BEFORE,
      releasedAt: RELEASED_AT,
    });

    expect(released).toBe(1);
  });
});
