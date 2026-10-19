import { Prisma } from "@prisma/client";
import { fail } from "@th/errors";
import type {
  SeatsRepo,
  SeatRecord,
  LockedSeatRecord,
  SeatDisplayRecord,
  SeatSectionSummary,
  SeatStatus,
  SeatPriceOverride,
  SeatPriceOverrideEditRecord,
  SeatPriceOverrideLock,
  ReadSeatPriceOverride,
  MaterializeSectionsResult,
} from "@th/ports/repos/seats";

// The layout seat id → (row, number, label) derivation is shared with the
// readers that map a Seat back to its glyph, so the two cannot drift.
import {
  layoutSeatIdPrefix,
  parseLayoutSeatId,
} from "@th/core/lib/seating/layout-seat-id";

import { pickContiguousCluster } from "./pick-contiguous-cluster";
import type { PrismaClientOrTx } from "./types";

type SeatRow = {
  id: string;
  seatSectionId: string;
  label: string;
  row: string | null;
  number: number | null;
  status: string;
  eventId: string;
};

type SeatDisplayRow = {
  id: string;
  seatSectionId: string;
  label: string;
  row: string | null;
  number: number | null;
  status: string;
  geometry: unknown | null;
};

/**
 * Safely parse a JSONB value into SeatPriceOverride or null.
 * Returns null if the value is null/undefined or does not match the expected shape.
 */
function parsePriceOverride(raw: unknown): SeatPriceOverride | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.priceCents !== "number") return null;
  return {
    priceCents: obj.priceCents,
    reason: typeof obj.reason === "string" ? obj.reason : null,
  };
}

/**
 * The parse for the reads checkout prices from (`findByIdsForUpdate`,
 * `findPriceOverridesByIds`). SQL NULL and JSON `null` are "no override", as
 * in `parsePriceOverride`. Anything else that is not `{ priceCents: number }`
 * comes back as `{ invalid: true }`, never as "no override": read as none,
 * it would be charged the tier price while `reserveForHold` /
 * `pickContiguousAvailable` (whose SQL skips every non-null value) treat it
 * as overridden. It is NOT thrown here: mint (after the charge), the ticket
 * email and the resale listing lock seats through `findByIdsForUpdate` and
 * must not fail on a field they never read. Checkout refuses the marker in
 * core (`seatOverrideCents`), which also refuses negative and fractional
 * amounts. Display reads keep `parsePriceOverride`.
 */
function parseReadPriceOverride(raw: unknown): ReadSeatPriceOverride {
  if (raw == null) return null;
  return parsePriceOverride(raw) ?? { invalid: true };
}

/**
 * Rows per `createMany` / batched UPDATE in `materializeSections`.
 *
 * Postgres caps one statement at 65535 bind parameters (Int16 on the wire;
 * treat 32767 as the ceiling to stay clear of drivers that use the signed
 * range). A Seat insert carries 8 values per row (id, seatSectionId, label,
 * row, number, status, createdAt, updatedAt), so 1000 rows ≈ 8000 parameters —
 * a quarter of the conservative cap, and small enough that no single
 * statement balloons for a stadium-sized layout.
 */
export const SEAT_BATCH_SIZE = 1000;

type DesiredSeat = {
  seatSectionId: string;
  label: string;
  row: string | null;
  number: number | null;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function seatKey(seatSectionId: string, label: string): string {
  return `${seatSectionId}\u0000${label}`;
}

/**
 * SeatSectionType from the layout's `kind`. Falls back to label matching only
 * when kind is not provided — remove once all layouts carry kind.
 */
function resolveSectionType(def: {
  kind?: "seat" | "ga" | "helper";
  label: string;
}): "GA" | "RESERVED" {
  if (def.kind === "ga") return "GA";
  if (def.kind === "seat") return "RESERVED";
  const lower = def.label.toLowerCase();
  return lower.includes("general admission") || lower === "ga"
    ? "GA"
    : "RESERVED";
}

export function makeSeatsRepo(p: PrismaClientOrTx): SeatsRepo {
  return {
    async findByIdsForUpdate({ seatIds, eventId }) {
      const distinctIds = Array.from(new Set(seatIds));
      if (distinctIds.length === 0) {
        return [];
      }

      // `price_override` rides the same locked read: checkout compares it to
      // the override the cart was priced with and refuses on a difference
      // (seat-price-overrides spec FR-003), so this IS the binding price read.
      const rows = await p.$queryRaw<
        (SeatRow & { price_override: unknown })[]
      >(Prisma.sql`
        SELECT s.id, s."seatSectionId" as "seatSectionId", s.label, s.row, s.number, s.status::text as status, ss."eventId" as "eventId", s.price_override
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE s.id IN (${Prisma.join(distinctIds)}) AND ss."eventId" = ${eventId}
        FOR UPDATE
      `);

      return rows.map(
        (row) =>
          ({
            id: row.id,
            seatSectionId: row.seatSectionId,
            label: row.label,
            row: row.row,
            number: row.number,
            status: row.status as SeatStatus,
            eventId: row.eventId,
            priceOverride: parseReadPriceOverride(row.price_override),
          }) satisfies LockedSeatRecord,
      );
    },

    async findPriceOverridesByIds({ seatIds, eventId }) {
      const distinctIds = Array.from(new Set(seatIds));
      if (distinctIds.length === 0) {
        return [];
      }

      // No lock, deliberately: checkout prices the cart from this BEFORE it
      // takes the capacity lock, which must precede every Seat lock. The
      // FOR UPDATE re-read in `findByIdsForUpdate` is what binds the price.
      const rows = await p.$queryRaw<
        { id: string; seatSectionId: string; price_override: unknown }[]
      >(Prisma.sql`
        SELECT s.id, s."seatSectionId" as "seatSectionId", s.price_override
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE s.id IN (${Prisma.join(distinctIds)}) AND ss."eventId" = ${eventId}
      `);

      return rows.map((row) => ({
        id: row.id,
        seatSectionId: row.seatSectionId,
        priceOverride: parseReadPriceOverride(row.price_override),
      }));
    },

    async findLabelsByIds({ seatIds, eventId }) {
      const distinctIds = Array.from(new Set(seatIds));
      if (distinctIds.length === 0) {
        return [];
      }

      // A plain read: no FOR UPDATE, so printing a seat label never waits on
      // (or blocks) checkout, the door or mint.
      const rows = await p.$queryRaw<
        {
          id: string;
          label: string;
          row: string | null;
          number: number | null;
          seatSectionId: string;
          sectionName: string;
        }[]
      >(Prisma.sql`
        SELECT s.id, s.label, s."row", s."number", s."seatSectionId",
          ss.name as "sectionName"
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE s.id IN (${Prisma.join(distinctIds)}) AND ss."eventId" = ${eventId}
      `);

      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        row: row.row,
        number: row.number,
        seatSectionId: row.seatSectionId,
        sectionName: row.sectionName,
      }));
    },

    async updateStatuses({ seatIds, status, updatedAt }) {
      if (seatIds.length === 0) {
        return;
      }

      await p.seat.updateMany({
        where: { id: { in: seatIds } },
        data: { status, updatedAt },
      });
    },

    async reserveForHold({ seatSectionId, eventId, qty, heldAt }) {
      if (qty <= 0) {
        return [];
      }

      const section = await p.seatSection.findUnique({
        where: { id: seatSectionId },
        select: { id: true, eventId: true, type: true, capacity: true },
      });

      if (!section || section.eventId !== eventId) {
        return [];
      }

      // Seats with a price override are never auto-assigned. The buyer named
      // no seat, so they never saw that seat's price, and this line is
      // charged the tier price: an overridden seat sells only by explicit
      // pick (seat-price-overrides build ruling, 2026-10-08). JSON `null` is
      // treated as no override, matching `parsePriceOverride`. A GA section
      // whose remaining stock is all overridden tops up new seats below if it
      // has capacity, otherwise the hold comes back short (`seat_unavailable`).
      const fetchAvailableSeats = async (limit: number) => {
        if (limit <= 0) {
          return [] as SeatRow[];
        }

        return p.$queryRaw<SeatRow[]>(Prisma.sql`
          SELECT s.id, s."seatSectionId" as "seatSectionId", s.label, s.row, s.number, s.status::text as status, ss."eventId" as "eventId"
          FROM "Seat" s
          INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
          WHERE s."seatSectionId" = ${seatSectionId} AND s.status = 'AVAILABLE'
            AND (s.price_override IS NULL OR s.price_override = 'null'::jsonb)
          ORDER BY s."createdAt" ASC
          LIMIT ${limit}
          FOR UPDATE
        `);
      };

      let available = await fetchAvailableSeats(qty);

      if (available.length < qty && section.type === "GA") {
        const capacity = section.capacity ?? 0;
        const totalSeats = await p.seat.count({ where: { seatSectionId } });
        const remainingCapacity = Math.max(capacity - totalSeats, 0);
        const missing = Math.max(qty - available.length, 0);
        const seatsToCreate = Math.min(remainingCapacity, missing);

        if (seatsToCreate > 0) {
          const existingCount = totalSeats;
          const rows = Array.from({ length: seatsToCreate }, (_, index) => {
            const number = existingCount + index + 1;
            return {
              seatSectionId,
              label: `GA-${number}`,
              row: null,
              number,
              status: "AVAILABLE" as const,
            };
          });

          await p.seat.createMany({ data: rows });
          available = await fetchAvailableSeats(qty);
        }
      }

      if (available.length < qty) {
        return [];
      }

      const seatIds = available.map((row) => row.id);
      await p.seat.updateMany({
        where: { id: { in: seatIds }, status: "AVAILABLE" },
        data: { status: "HELD", updatedAt: heldAt },
      });

      return available.map(
        (row) =>
          ({
            id: row.id,
            seatSectionId: row.seatSectionId,
            label: row.label,
            row: row.row,
            number: row.number,
            status: "HELD" as SeatStatus,
            eventId: row.eventId,
          }) satisfies SeatRecord,
      );
    },

    async pickContiguousAvailable({ seatSectionId, eventId, qty }) {
      if (qty <= 0) return [];

      const section = await p.seatSection.findUnique({
        where: { id: seatSectionId },
        select: { id: true, eventId: true },
      });
      if (!section || section.eventId !== eventId) return [];

      // FOR UPDATE locks every pickable AVAILABLE row in the section for the
      // surrounding transaction so concurrent door sales serialise.
      //
      // Seats with a price override are not pickable: the door prices every
      // line at the tier price and the operator never sees the seat, so an
      // overridden seat sells only by explicit pick online (same rule and
      // predicate as `reserveForHold`). Too few pickable seats returns [] as
      // before, which the door paths refuse as `seat_unavailable`.
      //
      // ORDER BY here only fixes the row-lock order — the picker
      // re-sorts row keys in JS via `localeCompare({numeric:true})` so
      // multi-digit row labels like A10/A2 cluster correctly even though
      // Postgres text sorting alone would mis-order them.
      const available = await p.$queryRaw<SeatRow[]>(Prisma.sql`
        SELECT s.id, s."seatSectionId" as "seatSectionId", s.label, s.row, s.number, s.status::text as status, ss."eventId" as "eventId"
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE s."seatSectionId" = ${seatSectionId} AND s.status = 'AVAILABLE'
          AND (s.price_override IS NULL OR s.price_override = 'null'::jsonb)
        ORDER BY s.row NULLS LAST, s.number ASC, s."createdAt" ASC
        FOR UPDATE
      `);

      if (available.length < qty) return [];

      const picked = pickContiguousCluster(available, qty);
      if (picked.length !== qty) return [];

      return picked.map(
        (row) =>
          ({
            id: row.id,
            seatSectionId: row.seatSectionId,
            label: row.label,
            row: row.row,
            number: row.number,
            status: "AVAILABLE" as SeatStatus,
            eventId: row.eventId,
          }) satisfies SeatRecord,
      );
    },

    async releaseSeats({ seatIds, releasedAt, heldBefore }) {
      if (seatIds.length === 0) {
        return;
      }

      // `status: "HELD"` proves SOMEBODY holds the seat, not that the caller
      // does — `Seat` carries no holder column. `heldBefore` is the optional
      // ownership fence: with it, a row re-held by a different, fresher
      // checkout (stamped after the caller's own hold) is left alone. See
      // `ReleaseSeatsInput.heldBefore` and the expired-cart reaper.
      await p.seat.updateMany({
        where: {
          id: { in: seatIds },
          status: "HELD",
          ...(heldBefore ? { updatedAt: { lte: heldBefore } } : {}),
        },
        data: { status: "AVAILABLE", updatedAt: releasedAt },
      });
    },

    async releaseExpiredHolds({ before, releasedAt, limit }) {
      // ORPHANED holds only. `Seat` carries no holder column, so "who holds
      // this" is answered by the cart: a checkout stamps its seat ids into
      // `OrderItem.meta.seatIds` (see `collectSeatIds` in core). A HELD seat
      // that an OPEN order still references is that cart's, and its fate is
      // decided by the PI-aware cart reaper (`releaseExpiredCarts`) — which
      // KEEPS a cart whose PaymentIntent succeeded while the webhook lags.
      // Releasing such a seat here handed it to the next buyer and let
      // finalize mint a second ticket for it (money audit 2026-09-08 #16).
      //
      // So a seat an open order references has NO time bound here. Its only
      // exits are the cart reaper's cancel, finalize's mint, or an operator
      // cancelling the order; a paid cart whose finalize is DLQ'd keeps its
      // seats until someone replays it. That is the intended trade — a paid
      // seat must not go back on sale — and `quarantinedCount` on
      // `releaseExpiredCarts` is the number to watch for seats wedged this way.
      //
      // Open means PENDING or PROCESSING: PROCESSING is the delayed-
      // notification flow (ACH), days between authorisation and settlement,
      // tickets not yet minted, and the cart reaper does not scan it. A seat
      // referenced only by a terminal order (CANCELLED / REFUNDED / …) is an
      // orphan and MUST still go back on sale — that is this reaper's job.
      //
      // Raw so the jsonb `?` existence test can run in the database; every
      // value is bound, `LIMIT NULL` is Postgres for "no limit".
      const candidates = await p.$queryRaw<{ id: string }[]>`
        SELECT s.id
        FROM public."Seat" s
        WHERE s.status::text = 'HELD'
          AND s."updatedAt" < ${before}
          AND NOT EXISTS (
            SELECT 1
            FROM public."Ticket" t
            WHERE t."seatId" = s.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public."OrderItem" oi
            INNER JOIN public."Order" o ON o.id = oi."orderId"
            WHERE o.status::text IN ('PENDING', 'PROCESSING')
              AND oi.meta -> 'seatIds' ? s.id
          )
        ORDER BY s."updatedAt" ASC
        LIMIT ${limit ?? null}::int
      `;

      if (candidates.length === 0) {
        return 0;
      }

      const seatIds = candidates.map((row) => row.id);
      const result = await p.seat.updateMany({
        where: { id: { in: seatIds }, status: "HELD" },
        data: { status: "AVAILABLE", updatedAt: releasedAt },
      });

      return result.count;
    },

    async listByEvent({ eventId }) {
      const rows = await p.$queryRaw<
        (SeatRow & { price_override: unknown })[]
      >(Prisma.sql`
        SELECT s.id, s."seatSectionId" as "seatSectionId", s.label, s.row, s.number, s.status::text as status, ss."eventId" as "eventId", s.price_override
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE ss."eventId" = ${eventId}
        ORDER BY s."seatSectionId", s.row NULLS LAST, s.number ASC, s."createdAt" ASC
      `);

      return rows.map(
        (row) =>
          ({
            id: row.id,
            seatSectionId: row.seatSectionId,
            label: row.label,
            row: row.row,
            number: row.number,
            status: row.status as SeatStatus,
            eventId: row.eventId,
            priceOverride: parsePriceOverride(row.price_override),
          }) satisfies SeatRecord,
      );
    },

    async listPriceOverridesByEvent({ eventId }) {
      // `listByEvent`'s query; only the override parse differs (the
      // checkout reads' lenient one, which keeps `{ invalid: true }`).
      const rows = await p.$queryRaw<
        (Omit<SeatRow, "eventId"> & { price_override: unknown })[]
      >(Prisma.sql`
        SELECT s.id, s."seatSectionId" as "seatSectionId", s.label, s.row, s.number, s.status::text as status, s.price_override
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE ss."eventId" = ${eventId}
        ORDER BY s."seatSectionId", s.row NULLS LAST, s.number ASC, s."createdAt" ASC
      `);

      return rows.map(
        (row) =>
          ({
            id: row.id,
            seatSectionId: row.seatSectionId,
            status: row.status as SeatStatus,
            label: row.label,
            row: row.row,
            number: row.number,
            priceOverride: parseReadPriceOverride(row.price_override),
          }) satisfies SeatPriceOverrideEditRecord,
      );
    },

    async listDistinctPriceOverridesByEvent({ eventId }) {
      // DISTINCT: a section priced as a block is one row, not one per seat.
      // The filter is the complement of the "no override" predicate
      // `reserveForHold` and `pickContiguousAvailable` use.
      const rows = await p.$queryRaw<
        { seatSectionId: string; price_override: unknown }[]
      >(Prisma.sql`
        SELECT DISTINCT s."seatSectionId" as "seatSectionId", s.price_override
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE ss."eventId" = ${eventId}
          AND s.price_override IS NOT NULL
          AND s.price_override <> 'null'::jsonb
        ORDER BY s."seatSectionId"
      `);

      return rows.map((row) => ({
        seatSectionId: row.seatSectionId,
        priceOverride: parsePriceOverride(row.price_override) ?? {
          invalid: true,
        },
      }));
    },

    async listAvailableBySection({ seatSectionId, eventId }) {
      const rows = await p.$queryRaw<
        (SeatDisplayRow & { price_override: unknown })[]
      >(Prisma.sql`
        SELECT
          s.id,
          s."seatSectionId" as "seatSectionId",
          s.label,
          s.row,
          s.number,
          s.status::text as status,
          s.geometry,
          s.price_override
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE s."seatSectionId" = ${seatSectionId}
          AND ss."eventId" = ${eventId}
          AND s.status IN ('AVAILABLE', 'HELD', 'SOLD', 'BLOCKED')
        ORDER BY s.row NULLS LAST, s.number ASC, s."createdAt" ASC
      `);

      return rows.map(
        (row) =>
          ({
            id: row.id,
            seatSectionId: row.seatSectionId,
            label: row.label,
            row: row.row,
            number: row.number,
            status: row.status as SeatStatus,
            geometry: row.geometry,
            priceOverride: parsePriceOverride(row.price_override),
          }) satisfies SeatDisplayRecord,
      );
    },

    async listSectionsByEvent(eventId) {
      const rows = await p.seatSection.findMany({
        where: { eventId },
        select: {
          id: true,
          name: true,
          type: true,
          capacity: true,
          layoutSectionId: true,
          placeLayoutId: true,
        },
        orderBy: { createdAt: "asc" },
      });

      return rows.map(
        (row) =>
          ({
            id: row.id,
            name: row.name,
            type: row.type as "GA" | "RESERVED",
            capacity: row.capacity,
            layoutSectionId: row.layoutSectionId ?? null,
            placeLayoutId: row.placeLayoutId ?? null,
          }) satisfies SeatSectionSummary,
      );
    },

    async materializeSections({ eventId, placeLayoutId, sections, seatIds }) {
      if (sections.length === 0) {
        return {
          sectionsCreated: 0,
          seatsCreated: 0,
          sectionIdMap: {},
        } satisfies MaterializeSectionsResult;
      }

      // ── Sections: one read, one batched insert, updates only for drift ──
      const defs = sections.map((def) => ({
        def,
        type: resolveSectionType(def),
      }));
      const layoutSectionIds = defs.map((d) => d.def.sectionId);

      const existingSections = await p.seatSection.findMany({
        where: {
          eventId,
          placeLayoutId,
          layoutSectionId: { in: layoutSectionIds },
        },
        select: {
          id: true,
          layoutSectionId: true,
          name: true,
          type: true,
          capacity: true,
        },
      });

      const sectionIdMap: Record<string, string> = {};
      const existingByLayoutId = new Map<
        string,
        (typeof existingSections)[number]
      >();
      for (const row of existingSections) {
        if (!row.layoutSectionId) continue;
        existingByLayoutId.set(row.layoutSectionId, row);
        sectionIdMap[row.layoutSectionId] = row.id;
      }

      // Existing sections whose label/type/capacity drifted from the layout.
      // Runs BEFORE the inserts: a new section may take a renamed section's
      // old name (X "Balcony"→"Mezzanine", new Y "Balcony"), and the
      // (eventId, name) unique only allows that once X has moved off it. The
      // old per-section upsert got this for free by walking layout order.
      // A↔B swap-renames (A→"B", B→"A" in one save) fail in old and new alike.
      // Sections number in the tens at most and drift is the rare edit path,
      // so a targeted update per changed section stays O(sections), not O(seats).
      for (const d of defs) {
        const existing = existingByLayoutId.get(d.def.sectionId);
        if (!existing) continue;
        const capacity = d.def.capacity ?? null;
        if (
          existing.name === d.def.label &&
          existing.type === d.type &&
          (existing.capacity ?? null) === capacity
        ) {
          continue;
        }
        try {
          await p.seatSection.update({
            where: { id: existing.id },
            data: { name: d.def.label, type: d.type, capacity },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            throw fail("SLUG_TAKEN", {
              message: "seat_section_name_taken",
              meta: {
                eventId,
                layoutSectionIds: [d.def.sectionId],
                name: d.def.label,
              },
              cause: error,
            });
          }
          throw error;
        }
      }

      let sectionsCreated = 0;
      const missing = defs.filter((d) => !(d.def.sectionId in sectionIdMap));
      if (missing.length > 0) {
        const created = await p.seatSection.createManyAndReturn({
          data: missing.map((d) => ({
            eventId,
            placeLayoutId,
            layoutSectionId: d.def.sectionId,
            name: d.def.label,
            type: d.type,
            capacity: d.def.capacity,
          })),
          skipDuplicates: true,
          select: { id: true, layoutSectionId: true },
        });
        sectionsCreated = created.length;
        for (const row of created) {
          if (row.layoutSectionId) sectionIdMap[row.layoutSectionId] = row.id;
        }

        // `skipDuplicates` is ON CONFLICT DO NOTHING: a row can be skipped
        // because a concurrent transaction inserted the same section (its
        // commit unblocked us, so a re-read sees it) or because another
        // section on this event already owns the name (eventId+name unique).
        // The old per-section upsert threw on the latter; keep that visible.
        const stillMissing = missing.filter(
          (d) => !(d.def.sectionId in sectionIdMap),
        );
        if (stillMissing.length > 0) {
          const reread = await p.seatSection.findMany({
            where: {
              eventId,
              placeLayoutId,
              layoutSectionId: { in: stillMissing.map((d) => d.def.sectionId) },
            },
            select: { id: true, layoutSectionId: true },
          });
          for (const row of reread) {
            if (row.layoutSectionId) sectionIdMap[row.layoutSectionId] = row.id;
          }
          const unresolved = stillMissing
            .filter((d) => !(d.def.sectionId in sectionIdMap))
            .map((d) => d.def.sectionId);
          if (unresolved.length > 0) {
            // SLUG_TAKEN is the existing "unique name on a scope is already in
            // use" conflict (→ CONFLICT at the transport). A dedicated code is
            // a follow-up; the machine message + meta carry the specifics.
            throw fail("SLUG_TAKEN", {
              message: "seat_section_name_taken",
              meta: { eventId, layoutSectionIds: unresolved },
            });
          }
        }
      }

      // ── Seats: one read, chunked inserts, chunked updates for drift ──────
      // Desired rows per section, last-wins on label — the old per-seat
      // upsert processed seatIds in order, so a later id deriving the same
      // label overwrote the earlier one's row/number.
      const desired: DesiredSeat[] = [];
      for (const d of defs) {
        const seatSectionId = sectionIdMap[d.def.sectionId];
        if (!seatSectionId) continue;
        const prefix = layoutSeatIdPrefix(d.def.sectionId);
        const byLabel = new Map<string, DesiredSeat>();
        for (const seatId of seatIds) {
          if (!seatId.startsWith(prefix)) continue;
          const parsed = parseLayoutSeatId(seatId, prefix);
          byLabel.set(parsed.label, { seatSectionId, ...parsed });
        }
        for (const row of byLabel.values()) desired.push(row);
      }

      let seatsCreated = 0;
      if (desired.length > 0) {
        const sectionDbIds = Array.from(
          new Set(desired.map((d) => d.seatSectionId)),
        );
        const existingSeats = await p.seat.findMany({
          where: { seatSectionId: { in: sectionDbIds } },
          select: {
            id: true,
            seatSectionId: true,
            label: true,
            row: true,
            number: true,
          },
        });
        const existingByKey = new Map(
          existingSeats.map((s) => [seatKey(s.seatSectionId, s.label), s]),
        );

        const toInsert: DesiredSeat[] = [];
        const toUpdate: Array<{
          id: string;
          row: string | null;
          number: number | null;
        }> = [];
        for (const d of desired) {
          const existing = existingByKey.get(seatKey(d.seatSectionId, d.label));
          if (!existing) {
            toInsert.push(d);
          } else if (existing.row !== d.row || existing.number !== d.number) {
            toUpdate.push({ id: existing.id, row: d.row, number: d.number });
          }
        }

        // skipDuplicates keeps the old loop's tolerance of a concurrent
        // materialisation racing us on (seatSectionId, label).
        for (const batch of chunk(toInsert, SEAT_BATCH_SIZE)) {
          const result = await p.seat.createMany({
            data: batch.map((d) => ({
              seatSectionId: d.seatSectionId,
              label: d.label,
              row: d.row,
              number: d.number,
              status: "AVAILABLE" as const,
            })),
            skipDuplicates: true,
          });
          seatsCreated += result.count;
        }

        for (const batch of chunk(toUpdate, SEAT_BATCH_SIZE)) {
          await p.$executeRaw(Prisma.sql`
            UPDATE "Seat" AS s
            SET row = v.row,
                number = v.number,
                "updatedAt" = NOW()
            FROM (VALUES ${Prisma.join(
              batch.map(
                (u) => Prisma.sql`(${u.id}, ${u.row}::text, ${u.number}::int)`,
              ),
            )}) AS v(id, row, number)
            WHERE s.id = v.id
          `);
        }
      }

      return {
        sectionsCreated,
        seatsCreated,
        sectionIdMap,
      } satisfies MaterializeSectionsResult;
    },

    async getSectionById(seatSectionId) {
      const section = await p.seatSection.findUnique({
        where: { id: seatSectionId },
        select: {
          id: true,
          name: true,
          type: true,
          capacity: true,
          layoutSectionId: true,
          placeLayoutId: true,
        },
      });

      if (!section) return null;

      return {
        id: section.id,
        name: section.name,
        type: section.type as "GA" | "RESERVED",
        capacity: section.capacity,
        layoutSectionId: section.layoutSectionId ?? null,
        placeLayoutId: section.placeLayoutId ?? null,
      } satisfies SeatSectionSummary;
    },

    async lockSeatsForPriceOverrideWrite({ seatIds, eventId }) {
      const distinctIds = Array.from(new Set(seatIds));
      if (distinctIds.length === 0) {
        return [];
      }

      // Never waits (SeatsRepo contract). `OF s` locks the Seat rows only,
      // not the joined SeatSection row checkout's `findByIdsForUpdate` also
      // takes; `NO KEY UPDATE` is the lock the UPDATE itself needs, so it
      // does not block mint's Ticket insert (FK key-share on Seat); `SKIP
      // LOCKED` passes over a row another transaction holds; `ORDER BY s.id`
      // keeps the lock order fixed.
      type LockRow = { id: string; seatSectionId: string; status: string };
      const locked = await p.$queryRaw<LockRow[]>(Prisma.sql`
        SELECT s.id, s."seatSectionId" as "seatSectionId", s.status::text as status
        FROM "Seat" s
        INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
        WHERE ss."eventId" = ${eventId} AND s.id IN (${Prisma.join(distinctIds)})
        ORDER BY s.id
        FOR NO KEY UPDATE OF s SKIP LOCKED
      `);
      const lockedIds = new Set(locked.map((row) => row.id));

      // A skipped row is BUSY, not missing: tell them apart with a plain read,
      // which never waits on a row lock.
      const unlockedIds = distinctIds.filter((id) => !lockedIds.has(id));
      const busy =
        unlockedIds.length === 0
          ? []
          : await p.$queryRaw<LockRow[]>(Prisma.sql`
              SELECT s.id, s."seatSectionId" as "seatSectionId", s.status::text as status
              FROM "Seat" s
              INNER JOIN "SeatSection" ss ON ss.id = s."seatSectionId"
              WHERE ss."eventId" = ${eventId} AND s.id IN (${Prisma.join(unlockedIds)})
            `);

      const toRecord =
        (isBusy: boolean) =>
        (row: LockRow): SeatPriceOverrideLock => ({
          id: row.id,
          seatSectionId: row.seatSectionId,
          status: row.status as SeatStatus,
          busy: isBusy,
        });
      return [...locked.map(toRecord(false)), ...busy.map(toRecord(true))];
    },

    async updatePriceOverrides({ seatIds, eventId, priceOverride }) {
      if (seatIds.length === 0) return 0;

      const distinctIds = Array.from(new Set(seatIds));

      // Both statements carry the status predicate (SeatsRepo contract): a
      // SOLD seat keeps the price it was charged and a HELD seat belongs to a
      // live checkout priced with the current override, so neither is
      // re-priced or cleared. Postgres re-checks the predicate on the locked
      // row, so a seat that went HELD mid-statement is skipped, not written.
      if (priceOverride) {
        const jsonStr = JSON.stringify({
          priceCents: priceOverride.priceCents,
          reason: priceOverride.reason ?? null,
        });

        const result = await p.$executeRaw(Prisma.sql`
          UPDATE "Seat" s
          SET price_override = ${jsonStr}::jsonb,
              "updatedAt"   = NOW()
          FROM "SeatSection" ss
          WHERE s."seatSectionId" = ss.id
            AND ss."eventId" = ${eventId}
            AND s.id IN (${Prisma.join(distinctIds)})
            AND s.status IN ('AVAILABLE', 'BLOCKED')
        `);

        return result;
      }

      const result = await p.$executeRaw(Prisma.sql`
        UPDATE "Seat" s
        SET price_override = NULL,
            "updatedAt"   = NOW()
        FROM "SeatSection" ss
        WHERE s."seatSectionId" = ss.id
          AND ss."eventId" = ${eventId}
          AND s.id IN (${Prisma.join(distinctIds)})
          AND s.status IN ('AVAILABLE', 'BLOCKED')
      `);

      return result;
    },
  };
}
