import type { Prisma } from "@prisma/client";
import type {
  BookingPitchExampleRecord,
  BookingStandardItemRecord,
  BookingStandardsRepo,
} from "@th/ports/repos/booking-standards";
import type { BookingIntent } from "@th/types/repos/booking-requests";
import type { BookingStandardOwnerType } from "@th/types/repos/booking-standards";

import type { PrismaClientOrTx } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Booking standards + example pitches (venue-booking-standards spec,
// docs/specs/2026-09-25). Storage only — see the port doc.
// ─────────────────────────────────────────────────────────────────────────────

const ITEM_SELECT = {
  id: true,
  ownerType: true,
  ownerId: true,
  intent: true,
  field: true,
  label: true,
  hint: true,
  requirement: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.BookingStandardItemSelect;

const EXAMPLE_SELECT = {
  id: true,
  ownerType: true,
  ownerId: true,
  intent: true,
  title: true,
  body: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.BookingPitchExampleSelect;

/**
 * The port's read order. `ownerType` and `intent` are Postgres enums, so they
 * sort by DECLARATION order (PLACE < CALENDAR; PERFORM < RENT < USE), not
 * alphabetically. `id` breaks a sortOrder tie deterministically — replace-all
 * never writes one, but a hand-edited row must still read in one stable order.
 */
const READ_ORDER = [
  { ownerType: "asc" },
  { ownerId: "asc" },
  { intent: "asc" },
  { sortOrder: "asc" },
  { id: "asc" },
] as const;

type PrismaWithTransaction = PrismaClientOrTx & {
  $transaction: <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;
};

function hasTransaction(p: PrismaClientOrTx): p is PrismaWithTransaction {
  return typeof (p as { $transaction?: unknown }).$transaction === "function";
}

/**
 * Replace-all must be atomic (port contract). Inside `repos.tx()` `p` is
 * already a transaction client and the caller's transaction provides it; on
 * the root client this opens one. Same shape as entity-pages.ts.
 */
async function inTransaction<T>(
  p: PrismaClientOrTx,
  fn: (tx: PrismaClientOrTx) => Promise<T>,
): Promise<T> {
  if (!hasTransaction(p)) return fn(p);
  // Call on `p` directly — extracting the method loses `this` and breaks the
  // driver-adapter engine.
  return (p as PrismaWithTransaction).$transaction(
    (tx: Prisma.TransactionClient) => fn(tx),
  );
}

/**
 * Serialize concurrent replace-alls of the SAME (table, owner, intent). Under
 * READ COMMITTED two racing saves would each delete the rows they can see
 * (neither sees the other's uncommitted inserts) and both insert — leaving
 * two lists interleaved. Transaction-scoped, so it is released at COMMIT /
 * ROLLBACK; the key is a bound parameter (tagged template), never
 * interpolated SQL.
 */
async function lockOwnerIntent(
  tx: PrismaClientOrTx,
  table: "items" | "examples",
  ownerType: BookingStandardOwnerType,
  ownerId: string,
  intent: BookingIntent,
): Promise<void> {
  const key = `booking_standards:${table}:${ownerType}:${ownerId}:${intent}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

const toItemRecord = (row: {
  id: string;
  ownerType: BookingStandardOwnerType;
  ownerId: string;
  intent: BookingIntent;
  field: BookingStandardItemRecord["field"];
  label: string;
  hint: string | null;
  requirement: BookingStandardItemRecord["requirement"];
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}): BookingStandardItemRecord => ({
  id: row.id,
  ownerType: row.ownerType,
  ownerId: row.ownerId,
  intent: row.intent,
  field: row.field,
  label: row.label,
  hint: row.hint,
  requirement: row.requirement,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toExampleRecord = (row: {
  id: string;
  ownerType: BookingStandardOwnerType;
  ownerId: string;
  intent: BookingIntent;
  title: string;
  body: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}): BookingPitchExampleRecord => ({
  id: row.id,
  ownerType: row.ownerType,
  ownerId: row.ownerId,
  intent: row.intent,
  title: row.title,
  body: row.body,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const bySortOrder = <T extends { sortOrder: number }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder;

export function makeBookingStandardsRepo(
  p: PrismaClientOrTx,
): BookingStandardsRepo {
  return {
    async listForOwners({ owners, intent }) {
      if (owners.length === 0) return { items: [], examples: [] };
      // One OR over the owner pairs — a place id and a calendar id can never
      // collide in practice, but the pair (not the bare id) is the key.
      const where = {
        OR: owners.map((owner) => ({
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
        })),
        ...(intent !== undefined ? { intent } : {}),
      };
      const [items, examples] = await Promise.all([
        p.bookingStandardItem.findMany({
          where,
          orderBy: [...READ_ORDER],
          select: ITEM_SELECT,
        }),
        p.bookingPitchExample.findMany({
          where,
          orderBy: [...READ_ORDER],
          select: EXAMPLE_SELECT,
        }),
      ]);
      return {
        items: items.map(toItemRecord),
        examples: examples.map(toExampleRecord),
      };
    },

    async replaceItems({ ownerType, ownerId, intent, items }) {
      return inTransaction(p, async (tx) => {
        await lockOwnerIntent(tx, "items", ownerType, ownerId, intent);
        await tx.bookingStandardItem.deleteMany({
          where: { ownerType, ownerId, intent },
        });
        if (items.length === 0) return [];
        // A CHECK violation (CUSTOM + REQUIRED, D2a) throws here and rolls
        // the delete back with it. Deliberately NOT mapped to a typed error:
        // core refuses that shape first, so reaching the CHECK is a bug and
        // should surface as one.
        const rows = await tx.bookingStandardItem.createManyAndReturn({
          data: items.map((item, index) => ({
            ownerType,
            ownerId,
            intent,
            field: item.field,
            label: item.label,
            hint: item.hint ?? null,
            requirement: item.requirement,
            sortOrder: index,
          })),
          select: ITEM_SELECT,
        });
        // RETURNING order is not a documented guarantee; sortOrder is unique
        // within this (owner, intent) after the delete, so sort on it.
        return rows.map(toItemRecord).sort(bySortOrder);
      });
    },

    async replaceExamples({ ownerType, ownerId, intent, examples }) {
      return inTransaction(p, async (tx) => {
        await lockOwnerIntent(tx, "examples", ownerType, ownerId, intent);
        await tx.bookingPitchExample.deleteMany({
          where: { ownerType, ownerId, intent },
        });
        if (examples.length === 0) return [];
        const rows = await tx.bookingPitchExample.createManyAndReturn({
          data: examples.map((example, index) => ({
            ownerType,
            ownerId,
            intent,
            title: example.title,
            body: example.body,
            sortOrder: index,
          })),
          select: EXAMPLE_SELECT,
        });
        return rows.map(toExampleRecord).sort(bySortOrder);
      });
    },
  } satisfies BookingStandardsRepo;
}
