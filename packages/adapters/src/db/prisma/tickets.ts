import {
  Prisma,
  TicketStatus as PrismaTicketStatus,
  TicketTypeStatus as PrismaTicketTypeStatus,
  TicketScanOutcome as PrismaTicketScanOutcome,
} from "@prisma/client";
import type {
  TicketsRepo,
  TicketTypeRecord,
  CreateTicketTypeInput,
  UpdateTicketTypeInput,
  TicketTypeStatus,
  CreateTicketInput,
  TicketRecord,
  TicketStatus,
  RecordTicketScanInput,
  TicketScanOutcome,
  ListAllTicketsInput,
  ListAllTicketsResult,
  ListPlatformTicketsItem,
  TicketDetailRecord,
  TicketTransferRecord,
  TicketScanRecord,
} from "@th/ports/repos/tickets";
import {
  CAPACITY_CONSUMING_TICKET_STATUSES,
  SEAT_OWNING_TICKET_STATUSES,
} from "@th/types";
import {
  ADMIT_SCAN_OUTCOMES,
  REVERTED_ADMIT_TICKET_STATUSES,
} from "@th/types/repos/tickets";

import type { PrismaClientOrTx } from "./types";

export function makeTicketsRepo(p: PrismaClientOrTx): TicketsRepo {
  return {
    create: async (input: CreateTicketInput) => {
      try {
        const created = await p.ticket.create({
          data: {
            eventId: input.eventId,
            ticketTypeId: input.ticketTypeId ?? null,
            ownerHumanId: input.ownerHumanId,
            orderId: input.orderId ?? null,
            orderItemId: input.orderItemId ?? null,
            seatId: input.seatId ?? null,
            code: input.code,
            status: mapTicketStatusToDb(input.status),
            issuedAt: input.issuedAt,
          },
          select: ticketSelect,
        });

        return mapTicket(created);
      } catch (error) {
        throw mapCreateError(error);
      }
    },

    listByOrderId: async (orderId: string) => {
      const records = await p.ticket.findMany({
        where: { orderId },
        select: ticketSelect,
        // Deterministic order is load-bearing, not cosmetic. Callers render
        // these positionally ("Ticket 1 of 3") and the mobile app caches the
        // list for offline use, so an unordered result would let Postgres
        // reshuffle the labels whenever a row is rewritten — a scan UPDATE
        // moves the tuple in the heap — and hand a buyer the wrong pass.
        // `id` is a stable tiebreaker for tickets created in the same tx.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      return records.map(mapTicket);
    },

    getByOrderItemId: async (orderItemId: string) => {
      const record = await p.ticket.findUnique({
        where: { orderItemId },
        select: ticketSelect,
      });
      return record ? mapTicket(record) : null;
    },

    listByOrderItemIds: async (orderItemIds: string[]) => {
      if (orderItemIds.length === 0) return [];
      const records = await p.ticket.findMany({
        where: { orderItemId: { in: orderItemIds } },
        select: ticketSelect,
      });
      return records.map(mapTicket);
    },

    listOrderIdsOwnedByHuman: async (humanId: string) => {
      const rows = await p.ticket.findMany({
        where: { ownerHumanId: humanId, orderId: { not: null } },
        select: { orderId: true },
        distinct: ["orderId"],
      });
      return rows
        .map((r) => r.orderId)
        .filter((id): id is string => id !== null);
    },

    // Seat OCCUPANCY, not seat history. The status filter is load-bearing:
    // matching on `seatId` alone made every refunded reserved seat permanently
    // unsellable — `holdSeatsForCheckout` read the dead row and threw
    // `seat_taken` forever. This answers "is a LIVE ticket sitting here?"; it
    // is not a history read, and a terminal row here would be a wrong answer.
    //
    // (The refund paths now CLEAR `seatId` when they void a ticket, so a
    // terminal row holding a seat is either pre-fix history or an
    // operator/backfill artefact. The filter still stands: it is the thing
    // that keeps such a row from re-locking the seat.)
    findBySeatIds: async (seatIds: string[]) => {
      if (seatIds.length === 0) {
        return [];
      }

      const records = await p.ticket.findMany({
        where: {
          seatId: { in: seatIds },
          status: { in: SEAT_OWNING_TICKET_STATUSES.map(mapTicketStatusToDb) },
        },
        select: ticketSelect,
      });

      return records.map(mapTicket);
    },

    // The unfiltered twin, for `mintTickets`'s @unique pre-flight ONLY. A dead
    // row still pointing at a seat cannot block a sale (see above) but it CAN
    // blow up `ticket.create` with P2002 after the buyer is charged, so mint
    // needs to see it and refuse first. Never use this to answer "is this seat
    // taken?" — that is `findBySeatIds`.
    findBySeatIdsIncludingTerminal: async (seatIds: string[]) => {
      if (seatIds.length === 0) {
        return [];
      }

      const records = await p.ticket.findMany({
        where: { seatId: { in: seatIds } },
        select: ticketSelect,
      });

      return records.map(mapTicket);
    },

    // Voided tickets give the seat back. One statement, no read-modify-write:
    // the caller has already decided these tickets are dead.
    clearSeatAssignments: async (ticketIds: string[]) => {
      if (ticketIds.length === 0) {
        return;
      }

      await p.ticket.updateMany({
        where: { id: { in: ticketIds } },
        data: { seatId: null },
      });
    },

    // Deliberately binary-exact — NO case-insensitive fallback. Every caller
    // passes `ticket.code` read back off a row (scan-ticket, record-cash-sale,
    // finalize-from-payment-intent), never raw operator input, so a fallback
    // would buy nothing and would weaken the conditional update below, which is
    // the atomic double-scan guard.
    markScanned: async (code: string, at: Date) => {
      const updateResult = await p.ticket.updateMany({
        where: { code, status: "VALID" },
        data: { scannedAt: at, status: "SCANNED" },
      });

      if (updateResult.count > 0) {
        const persisted = await p.ticket.findUnique({
          where: { code },
          select: { scannedAt: true },
        });
        return { ok: true as const, scannedAt: persisted?.scannedAt ?? at };
      }

      const existing = await p.ticket.findUnique({
        where: { code },
        select: { status: true, scannedAt: true },
      });
      if (!existing) {
        return { ok: false as const, reason: "not_found" as const };
      }

      return {
        ok: false as const,
        reason: "invalid_status" as const,
        scannedAt: existing.scannedAt,
      };
    },

    // Lock, THEN read: the record returned is the committed row, and no
    // other transaction can update it until this one ends. Same lock
    // strength and reasoning as `lockListingTicket` in resale-listings.ts.
    getByIdForUpdate: async (ticketId: string) => {
      const locked = await p.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "Ticket" WHERE id = ${ticketId} FOR NO KEY UPDATE`;
      if (locked.length === 0) return null;
      const record = await p.ticket.findUnique({
        where: { id: ticketId },
        select: ticketSelect,
      });
      return record ? mapTicket(record) : null;
    },

    getById: async (ticketId: string) => {
      const record = await p.ticket.findUnique({
        where: { id: ticketId },
        select: ticketSelect,
      });
      return record ? mapTicket(record) : null;
    },

    getByCode: async (code: string) => {
      // ── Fast path: binary-exact match on the `Ticket_code_key` unique index.
      // Every scanned QR takes this path — the attendee pass encodes
      // `Ticket.code` verbatim, so the scanned string is byte-identical to the
      // stored one. Semantics here are unchanged.
      const exact = await p.ticket.findUnique({
        where: { code },
        select: ticketSelect,
      });
      if (exact) return mapTicket(exact);

      // ── Slow path (miss only): an operator typed the code by hand — the
      // scanner's manual-entry field or the web paste box — and may not have
      // matched case.
      //
      // Case-folding a bearer credential needs justifying. It costs no entropy
      // and merges no two independently-issuable codes here, because the code
      // space is case-partitioned by construction: minted codes are
      // `tk_` + lowercase hex (`generateTicketCode()`), seed/POS codes are
      // uppercase. Two distinct codes therefore never differ only by case, so
      // folding cannot make one ticket's code open another's.
      //
      // It stays an exact FULL-STRING comparison — `lower(code) = lower($1)`.
      // No LIKE, no prefix, no wildcard. Note this is why we do NOT use
      // Prisma's `mode: "insensitive"`: on Postgres it compiles to
      // `code ILIKE $1` with the caller's value used verbatim as the *pattern*,
      // and our codes contain `_`, which ILIKE reads as a single-character
      // wildcard — `tk_abc…` would match `tkXabc…`. Hence raw, parameterised
      // SQL (`${code}` is bound as $1/$2 by Prisma, never interpolated).
      //
      // Deterministic if two rows ever fold together: prefer the binary-exact
      // row, then the lowest code. (Unreachable today — the findUnique above
      // already missed — but it keeps the result total-ordered instead of
      // depending on Postgres heap order.)
      //
      // INDEX: this cannot use `Ticket_code_key` — that btree is on `code`, not
      // on `lower(code)` — so it is a Seq Scan today (verified with EXPLAIN).
      //
      // Who actually lands here, measured rather than assumed:
      //   - apps/scanner CAMERA scans do NOT. `handleBarcode` forwards the
      //     decoded string verbatim to `scan.resolvePayload`
      //     (unified-scan-screen.tsx), so the stored casing survives and the
      //     `findUnique` fast path hits. (`lib/qr.ts` DOES upper-case, but it
      //     only feeds the LOCAL offline manifest lookup, which collates
      //     NOCASE — it never sources what is sent to the server.)
      //   - apps/scanner MANUAL code entry does — it upper-cases on submit.
      //     Rare by design (damaged QR), and tolerating either casing there is
      //     the whole point of this path.
      //   - apps/web's scan page does, on every camera decode:
      //     UnifiedScanView.tsx upper-cases parsed bare codes before sending.
      //     That one is worth fixing at the client (phase B) — it puts a Seq
      //     Scan in the web door's hot loop.
      //
      // So a functional index is not load-bearing for the native scanner, but
      // it IS warranted before `Ticket` grows large — and preferably UNIQUE,
      // which would turn the fold's injectivity from a convention into a
      // constraint:
      //   CREATE UNIQUE INDEX CONCURRENTLY "Ticket_code_lower_key"
      //     ON "Ticket" (lower("code"));
      // Deliberately NOT added in this pass — migrations here are handled
      // separately.
      const rows = await p.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "Ticket"
        WHERE lower("code") = lower(${code})
        ORDER BY ("code" = ${code}) DESC, "code" ASC
        LIMIT 1
      `;
      const id = rows[0]?.id;
      if (!id) return null;

      // Re-read through Prisma so all field/enum mapping stays in one place.
      const record = await p.ticket.findUnique({
        where: { id },
        select: ticketSelect,
      });
      return record ? mapTicket(record) : null;
    },

    setStatus: async (ticketId, status, options) => {
      const data = {
        status: mapTicketStatusToDb(status),
        scannedAt:
          options?.scannedAt !== undefined ? options.scannedAt : undefined,
      };
      // Compare-and-swap when the caller names the status it read. The
      // predicate is the guard, so `updateMany` is load-bearing (`update`
      // cannot carry it): a ticket refunded or revoked since the read flips
      // zero rows instead of being dragged back into a place-holding status.
      if (options?.expectedStatus) {
        const result = await p.ticket.updateMany({
          where: {
            id: ticketId,
            status: mapTicketStatusToDb(options.expectedStatus),
          },
          data,
        });
        return result.count === 1;
      }
      await p.ticket.update({ where: { id: ticketId }, data });
      return true;
    },

    countDistinctDoorScannedHolders: async (input) => {
      const cap = Math.max(0, Math.floor(input.cap));
      if (cap === 0) return 0;
      const lead = Math.max(0, Math.floor(input.doorLeadSeconds));
      // Owner scope + "the holder isn't the organiser's own side".
      const ownerSql =
        "orgId" in input.owner
          ? Prisma.sql`e."orgId" = ${input.owner.orgId}
              AND NOT EXISTS (
                SELECT 1 FROM "OrgMember" m
                WHERE m."orgId" = ${input.owner.orgId}
                  AND m."humanId" = t."ownerHumanId"
              )`
          : // Person-owned: the human owns it only while no org does.
            Prisma.sql`e."humanId" = ${input.owner.humanId}
              AND e."orgId" IS NULL
              AND t."ownerHumanId" <> ${input.owner.humanId}`;
      // DISTINCT holders, LIMIT cap inside: Postgres stops once it has `cap`
      // distinct rows, so the count is bounded by the threshold.
      const rows = await p.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT DISTINCT t."ownerHumanId"
          FROM "TicketScan" s
          JOIN "Ticket" t ON t."id" = s."ticketId"
          JOIN "Event" e ON e."id" = s."eventId"
          WHERE s."outcome" = 'ACCEPTED'
            AND (s."message" IS NULL
                 OR s."message" NOT IN ('POS_AUTO_ADMIT', 'POS_CASH_AUTO_ADMIT'))
            AND e."endsAt" < ${input.endedBefore}
            AND s."scannedAt" >= e."startsAt" - make_interval(secs => ${lead})
            AND t."ownerHumanId" <> s."actorHumanId"
            -- (b) not refunded / voided.
            AND t."status" IN ('VALID', 'SCANNED', 'LISTED')
            -- (a) a real online card payment: Stripe-charged WEB checkout,
            -- gross > 0, not a comp, not POS/cash, not refunded/disputed.
            AND EXISTS (
              SELECT 1 FROM "Order" o
              WHERE o."id" = t."orderId"
                AND o."source" <> 'COMP'
                AND o."paymentChannel" = 'WEB'
                AND o."stripePaymentIntentId" IS NOT NULL
                AND o."amountGrossCents" > 0
                AND o."status" IN ('SUCCEEDED', 'PART_REFUNDED')
            )
            -- (c) the holder is a real account with a VERIFIED email.
            AND EXISTS (
              SELECT 1 FROM "auth_user" au
              WHERE au."human_id" = t."ownerHumanId"
                AND au."email_verified" = true
            )
            AND ${ownerSql}
          LIMIT ${cap}
        ) d
      `;
      return rows[0]?.n ?? 0;
    },

    recordScan: async (input: RecordTicketScanInput) => {
      await p.ticketScan.create({
        data: {
          ticketId: input.ticketId,
          eventId: input.eventId,
          actorHumanId: input.actorHumanId,
          scannedAt: input.scannedAt,
          lat: input.locationLat,
          lng: input.locationLng,
          outcome: mapScanOutcomeToDb(input.outcome),
          message: input.message,
        },
      });
    },

    // Guarded compare-and-swap (same shape as `markScanned`'s double-scan
    // guard, and as `humans.setDefaultPrimaryPayoutTermsIfUnset`). It used to
    // be a read-then-unconditional-`update`, which under READ COMMITTED let a
    // concurrent refund and a gift BOTH succeed: the refund quoted the item as
    // active, called Stripe, and the transfer's blind write landed on top —
    // sender refunded, recipient holding a live pass (money audit #19).
    //
    // The predicates ARE the guard, so `updateMany` is load-bearing: `update`
    // targets a unique row and cannot carry them. `count === 0` means somebody
    // else moved the row first; we deliberately do not re-read to classify why
    // (unlike `markScanned`, whose caller shows the scanner a reason) — the one
    // caller-visible fact is "this transfer lost", and the callers all turn it
    // into the same refusal.
    //
    // The `TicketTransfer` row is written ONLY on a win: a transfer that did
    // not happen must not leave provenance saying it did, and the resale
    // unwind's replay detection reads exactly those rows.
    transfer: async ({
      ticketId,
      fromHumanId,
      toHumanId,
      reason,
      orderId,
      expectedStatus,
    }) => {
      const result = await p.ticket.updateMany({
        where: {
          id: ticketId,
          ownerHumanId: fromHumanId,
          ...(expectedStatus
            ? { status: mapTicketStatusToDb(expectedStatus) }
            : {}),
        },
        data: { ownerHumanId: toHumanId },
      });

      if (result.count === 0) return false;

      await p.ticketTransfer.create({
        data: {
          ticketId,
          fromHumanId,
          toHumanId,
          reason,
          orderId: orderId ?? null,
        },
      });

      return true;
    },

    // LISTED → VALID only. A ticket under a HELD listing is LISTED; one that
    // was refunded or revoked while the listing stayed open is terminal and
    // has given its capacity place back, so it must not come back to VALID
    // (refunds-restock spec 2026-10-09). Zero rows THROWS, the
    // `unwindSale` / `commit` idiom: the finalize tx rolls back, listing
    // commit included, and the paid order goes to manual review.
    reassignForResale: async ({
      ticketId,
      newOrderId,
      newOrderItemId,
      newCode,
    }) => {
      const result = await p.ticket.updateMany({
        where: { id: ticketId, status: mapTicketStatusToDb("LISTED") },
        data: {
          orderId: newOrderId,
          orderItemId: newOrderItemId,
          code: newCode,
          status: mapTicketStatusToDb("VALID"),
        },
      });
      if (result.count !== 1) {
        throw {
          code: "conflict",
          message: "resale_reassign_ticket_not_listed",
          ticketId,
          newOrderId,
        } as const;
      }
    },

    // From a place-holding status only (whatever the refunded resale buyer
    // left it in: VALID, SCANNED or LISTED). No caller marks a RESALE
    // order's tickets REFUNDED before the unwind, so a terminal ticket here
    // was voided another way and must stay voided. Zero rows THROWS.
    restoreAfterResale: async ({
      ticketId,
      restoredOrderId,
      restoredOrderItemId,
      newCode,
    }) => {
      const result = await p.ticket.updateMany({
        where: {
          id: ticketId,
          status: {
            in: CAPACITY_CONSUMING_TICKET_STATUSES.map(mapTicketStatusToDb),
          },
        },
        data: {
          orderId: restoredOrderId,
          orderItemId: restoredOrderItemId,
          code: newCode,
          status: mapTicketStatusToDb("VALID"),
          scannedAt: null,
        },
      });
      if (result.count !== 1) {
        throw {
          code: "conflict",
          message: "resale_restore_ticket_terminal",
          ticketId,
        } as const;
      }
    },

    findTicketTypeByName: async (eventId: string, name: string) => {
      const tt = await p.ticketType.findFirst({
        where: {
          eventId,
          name: { equals: name, mode: "insensitive" },
        },
      });

      return tt ? mapTicketType(tt) : null;
    },
    createTicketType: async (input: CreateTicketTypeInput) => {
      const created = await p.ticketType.create({
        data: {
          eventId: input.eventId,
          name: input.name,
          description: input.description,
          priceCents: input.priceCents,
          pricingMode: input.pricingMode ?? "FIXED",
          minimumCents: input.minimumCents ?? null,
          suggestedCents: input.suggestedCents ?? null,
          capacity: input.capacity,
          status: mapStatusToDb(input.status),
          createdAt: input.createdAt,
          seatSectionId: input.seatSectionId ?? null,
          resaleAllowed: input.resaleAllowed ?? false,
          resaleCapCents: input.resaleCapCents ?? null,
          transferAllowed: input.transferAllowed ?? true,
          scheduledPriceCents: input.scheduledPriceCents ?? null,
          scheduledPriceAt: input.scheduledPriceAt ?? null,
          salesOpenAt: input.salesOpenAt ?? null,
          salesCloseAt: input.salesCloseAt ?? null,
        },
      });

      return mapTicketType(created);
    },
    getTicketTypeById: async (id: string) => {
      const tt = await p.ticketType.findUnique({ where: { id } });
      return tt ? mapTicketType(tt) : null;
    },
    updateTicketType: async (input: UpdateTicketTypeInput) => {
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description;
      if (input.priceCents !== undefined) data.priceCents = input.priceCents;
      if (input.pricingMode !== undefined) data.pricingMode = input.pricingMode;
      if (input.minimumCents !== undefined)
        data.minimumCents = input.minimumCents;
      if (input.suggestedCents !== undefined)
        data.suggestedCents = input.suggestedCents;
      if (input.capacity !== undefined) data.capacity = input.capacity;
      if (input.seatSectionId !== undefined)
        data.seatSectionId = input.seatSectionId;
      if (input.resaleAllowed !== undefined)
        data.resaleAllowed = input.resaleAllowed;
      if (input.resaleCapCents !== undefined)
        data.resaleCapCents = input.resaleCapCents;
      // Scheduled price change — `undefined` leaves the column alone, `null`
      // clears it. The use case has already merged + validated the
      // both-or-neither invariant, so these two move together or not at all.
      if (input.scheduledPriceCents !== undefined)
        data.scheduledPriceCents = input.scheduledPriceCents;
      if (input.scheduledPriceAt !== undefined)
        data.scheduledPriceAt = input.scheduledPriceAt;
      // Sales window — same partial-update contract: `undefined` leaves the
      // bound alone, `null` clears it. The use case has already merged both
      // bounds against the stored row and validated open < close, so an
      // inverted window cannot arrive here.
      if (input.salesOpenAt !== undefined) data.salesOpenAt = input.salesOpenAt;
      if (input.salesCloseAt !== undefined)
        data.salesCloseAt = input.salesCloseAt;

      const updated = await p.ticketType.update({
        where: { id: input.id },
        data,
      });

      return mapTicketType(updated);
    },
    deleteTicketType: async (id: string) => {
      await p.ticketType.delete({ where: { id } });
    },
    // Every row, any status: a history count for the delete guard. Capacity
    // uses `countCapacityConsumingForTicketType` below.
    countIssuedForTicketType: async (ticketTypeId: string) => {
      return p.ticket.count({ where: { ticketTypeId } });
    },
    // Same `issued` filter as `lockAndCountCapacityForTicketType` and
    // `countCapacityUsageForTicketTypes`. If you change one, change all three.
    countCapacityConsumingForTicketType: async (ticketTypeId: string) => {
      return p.ticket.count({
        where: {
          ticketTypeId,
          status: {
            in: CAPACITY_CONSUMING_TICKET_STATUSES.map(mapTicketStatusToDb),
          },
        },
      });
    },
    lockAndCountCapacityForTicketType: async ({
      ticketTypeId,
      heldSince,
      excludeOrderId,
    }) => {
      // Serialise concurrent sellers on this ticket type with a
      // TRANSACTION-SCOPED ADVISORY lock, not `SELECT ... FOR UPDATE` on the
      // TicketType row.
      //
      // Why not the row lock: inserting an OrderItem or Ticket takes an
      // implicit `FOR KEY SHARE` on its parent TicketType (both carry an FK).
      // Those share locks are mutually compatible, which is why nothing
      // deadlocked before. `FOR UPDATE` conflicts with them, creating a cycle
      // with web checkout — that path locks Seats first and only touches
      // TicketType implicitly, in cart order, when it inserts its items, i.e.
      // the opposite order to ours. Postgres resolves that by aborting one
      // transaction with 40P01.
      //
      // The advisory lock gives identical serialisation among callers that opt
      // in, is likewise released on commit, and sits in its own lock space
      // where FK key-share locks cannot reach it — so checkout drops out of
      // the wait graph. Same primitive as the platform-admin guard in
      // `authz.ts`. Namespaced so it cannot collide with another feature
      // hashing the same uuid.
      //
      // This holds ONLY while callers take this lock before any Seat lock;
      // see the ordering invariant on the port.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ticket_type_capacity:${ticketTypeId}`}))`;

      // Only tickets that still hold a place: REFUNDED and INVALID gave theirs
      // back (CAPACITY_CONSUMING_TICKET_STATUSES). The batch read below and
      // `countCapacityConsumingForTicketType` use the SAME status filter; if
      // you change one, change all three.
      const issued = await p.ticket.count({
        where: {
          ticketTypeId,
          status: {
            in: CAPACITY_CONSUMING_TICKET_STATUSES.map(mapTicketStatusToDb),
          },
        },
      });

      // Reservations: ticket lines on PENDING orders young enough that their
      // PaymentIntent can still be confirmed.
      //
      // Keyed on `Order.occurredAt`, NOT on a per-line expiry stamp. The
      // caller derives `heldSince` from the same TTL the expired-cart reaper
      // uses, so a reservation and the charge it protects share one clock —
      // an independent stamp drifts against the reaper and reopens the
      // charge-without-ticket window. It also means no JSONB parsing, so a
      // malformed `meta` value cannot abort the query and take every sale of
      // this ticket type down with it.
      //
      // `status` is a Postgres enum, hence the ::text compare.
      // PRIMARY only. A RESALE order's ticket line carries the ORIGINAL
      // primary `ticketTypeId`, but it mints nothing —
      // `finalizeFromPaymentIntent` routes `source = RESALE` to
      // `finalizeResalePurchase`, and the ticket being resold is ALREADY
      // inside `issued`. Counting it would make every in-flight resale
      // phantom-consume a unit of primary inventory and refuse real buyers
      // for stock that exists.
      //
      // This deliberately KEEPS POS holds: POS orders are `source = PRIMARY`
      // with `paymentChannel = 'POS'`, which is what makes the door and the
      // web protect each other. COMP orders are marked SUCCEEDED inside their
      // own transaction, so they never sit PENDING and this filter costs
      // nothing there.
      //
      // Dropped by 68e0ec1c and restored here: without it every in-flight
      // resale phantom-consumed primary stock, and the batch read below kept
      // the filter, so the badge and the pre-charge gate disagreed.
      const rows = await p.$queryRaw<{ held: number }[]>`
        SELECT COALESCE(SUM(oi.qty), 0)::int AS held
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        WHERE oi."ticketTypeId" = ${ticketTypeId}
          AND oi.kind = 'ticket'
          AND o.status::text = 'PENDING'
          AND o.source::text = 'PRIMARY'
          AND o."occurredAt" >= ${heldSince}
          -- The caller's own order does not reserve against itself. NULL means
          -- "exclude nothing"; the IS DISTINCT FROM keeps that case total
          -- instead of collapsing the whole predicate to NULL.
          AND o.id IS DISTINCT FROM ${excludeOrderId ?? null}
      `;

      return { issued, held: Number(rows[0]?.held ?? 0) };
    },
    countCapacityUsageForTicketTypes: async ({ ticketTypeIds, heldSince }) => {
      // Deduplicate: two lines of the same tier must not double-count, and the
      // contract is one entry per DISTINCT id.
      const ids = [...new Set(ticketTypeIds)];
      // No ids ⇒ no query. An event with no active tiers (or an RSVP event)
      // must not pay a round trip, and `= ANY('{}')` would be a pointless one.
      if (ids.length === 0) return [];

      // NO ADVISORY LOCK, deliberately — see the port's doc block. This is a
      // public read path; taking the capacity lock here would serialise every
      // page view against live checkouts for the same tier.
      //
      // Two grouped queries rather than one per tier: the N+1 this replaces
      // was the reason `lockAndCountCapacityForTicketType` could not be reused
      // even setting the lock aside.
      //
      // `issued` uses the locking method's status filter
      // (CAPACITY_CONSUMING_TICKET_STATUSES): a refunded or revoked ticket
      // frees its place here exactly when it frees it at the gate.
      const issuedRows = await p.ticket.groupBy({
        by: ["ticketTypeId"],
        where: {
          ticketTypeId: { in: ids },
          status: {
            in: CAPACITY_CONSUMING_TICKET_STATUSES.map(mapTicketStatusToDb),
          },
        },
        _count: { _all: true },
      });

      // `issued` (the status filter above) and `held` are IDENTICAL in
      // definition to the locking method's — same status filter, same
      // PRIMARY-only filter, same `occurredAt >= heldSince` window. Kept
      // verbatim on purpose:
      // a public badge computed from a narrower basis than the pre-charge gate
      // would still offer tickets checkout refuses, which is the exact bug this
      // whole signal exists to close. If you change one, change both.
      //
      // The id list is a bound PARAMETER (`= ANY($1)`), never interpolated.
      const heldRows = await p.$queryRaw<
        { ticketTypeId: string; held: number }[]
      >`
        SELECT oi."ticketTypeId" AS "ticketTypeId",
               COALESCE(SUM(oi.qty), 0)::int AS held
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        WHERE oi."ticketTypeId" = ANY(${ids}::text[])
          AND oi.kind = 'ticket'
          AND o.status::text = 'PENDING'
          AND o.source::text = 'PRIMARY'
          AND o."occurredAt" >= ${heldSince}
        GROUP BY oi."ticketTypeId"
      `;

      const issuedById = new Map<string, number>();
      for (const row of issuedRows) {
        if (row.ticketTypeId == null) continue;
        issuedById.set(row.ticketTypeId, row._count._all);
      }
      const heldById = new Map<string, number>();
      for (const row of heldRows) {
        heldById.set(row.ticketTypeId, Number(row.held ?? 0));
      }

      // Zero-fill every requested id so callers never have to tell "absent"
      // from "zero" — an absent row means no tickets and no holds, which is
      // full remaining capacity, and a caller that guessed wrong there would
      // hide a tier that is entirely available.
      return ids.map((ticketTypeId) => ({
        ticketTypeId,
        issued: issuedById.get(ticketTypeId) ?? 0,
        held: heldById.get(ticketTypeId) ?? 0,
      }));
    },
    countIssuedForEvent: async (eventId: string) => {
      return p.ticket.count({ where: { eventId } });
    },
    countScannedByEvent: async (eventIds: string[]) => {
      // People through the door, not tickets sold (venue-track-record FR-009 /
      // R4), counted from the append-only `TicketScan` log (R11 re-ruled
      // 2026-09-25, FU-005): DISTINCT tickets with an admit outcome at the
      // event. The log is the basis because `Ticket.scannedAt` forgets —
      // every refund path clears it — so a post-show refund no longer erases
      // a real walk-in. A second scan of a ticket already in (REPLAY) and a
      // denial (REJECTED) are not admits; DISTINCT folds an admit → revert →
      // re-admit into one person.
      //
      // Reverted admits: `revertTicketScan` writes NOTHING to the log — it
      // flips the ticket SCANNED → VALID. So an admit is read as reverted
      // when the ticket sits in a REVERTED_ADMIT_TICKET_STATUSES status today
      // AND has had no ownership change since the scan. The transfer clause
      // is what separates a revert from the resale refund unwind
      // (`restoreAfterResale`), which hands an ADMITTED buyer's ticket back
      // to the seller as VALID/LISTED — that walk-in happened and counts.
      // Known over-count, documented on the port: a reverted admit whose
      // ticket is later refunded, invalidated or transferred without a
      // re-scan still counts.
      //
      // Events with zero admits produce no group and are ABSENT from the
      // map, never present as 0: the caller counts `map.size` as "shows with
      // a door count" and averages over those only. Empty input
      // short-circuits without a query (the caller chunks at 500 ids).
      // Driven by `TicketScan(eventId, scannedAt)`; Ticket by pkey.
      const out = new Map<string, number>();
      if (eventIds.length === 0) return out;
      // Bound parameters do not coerce to a Postgres enum; each is cast.
      const admitOutcomes = Prisma.join(
        ADMIT_SCAN_OUTCOMES.map(
          (outcome) => Prisma.sql`${outcome}::"TicketScanOutcome"`,
        ),
      );
      const revertedStatuses = Prisma.join(
        REVERTED_ADMIT_TICKET_STATUSES.map(
          (status) => Prisma.sql`${status}::"TicketStatus"`,
        ),
      );
      const rows = await p.$queryRaw<Array<{ eventId: string; count: number }>>`
        SELECT s."eventId", COUNT(DISTINCT s."ticketId")::int AS "count"
        FROM "TicketScan" s
        JOIN "Ticket" t ON t."id" = s."ticketId"
        WHERE s."eventId" = ANY(${eventIds}::text[])
          AND s."outcome" IN (${admitOutcomes})
          AND (
            t."status" NOT IN (${revertedStatuses})
            OR EXISTS (
              SELECT 1 FROM "TicketTransfer" tt
              WHERE tt."ticketId" = s."ticketId"
                AND tt."at" > s."scannedAt"
            )
          )
        GROUP BY s."eventId"
      `;
      for (const row of rows) out.set(row.eventId, row.count);
      return out;
    },
    countForOrderTicketType: async (orderId: string, ticketTypeId: string) => {
      return p.ticket.count({ where: { orderId, ticketTypeId } });
    },
    hasActiveTicketForEvent: async (eventId: string, humanId: string) => {
      const count = await p.ticket.count({
        where: {
          eventId,
          ownerHumanId: humanId,
          status: { in: ["VALID", "SCANNED", "LISTED"] },
        },
      });
      return count > 0;
    },

    viewerHoldsActiveTicketForEvent: async (
      eventId: string,
      viewerHumanId: string,
    ) => {
      // hasActiveTicketForEvent plus the owner's proven inbox, in one query
      // (B2: an unverified account may hold tickets guest checkout attached
      // to it by email).
      const count = await p.ticket.count({
        where: {
          eventId,
          ownerHumanId: viewerHumanId,
          status: { in: ["VALID", "SCANNED", "LISTED"] },
          owner: { authUser: { is: { emailVerified: true } } },
        },
      });
      return count > 0;
    },

    listEventIdsWithActiveTicket: async (
      humanId: string,
      eventIds: readonly string[],
    ) => {
      const ids = Array.from(new Set(eventIds));
      if (ids.length === 0) return [];
      // Same status set as hasActiveTicketForEvent, one query for the batch.
      const rows = await p.ticket.findMany({
        where: {
          eventId: { in: ids },
          ownerHumanId: humanId,
          status: { in: ["VALID", "SCANNED", "LISTED"] },
        },
        select: { eventId: true },
        distinct: ["eventId"],
      });
      return rows.map((row) => row.eventId);
    },

    listUpcomingHeldEvents: async ({
      humanId,
      now,
      eventStatuses,
      orderStatuses,
      limit,
    }) => {
      // The human's held tickets: same ownership (`ownerHumanId`) and the same
      // ACTIVE status set as hasActiveTicketForEvent, on an order in one of
      // the given statuses (a ticket with no order never matches).
      const heldTicket = {
        ownerHumanId: humanId,
        status: {
          in: [
            PrismaTicketStatus.VALID,
            PrismaTicketStatus.SCANNED,
            PrismaTicketStatus.LISTED,
          ],
        },
        order: { is: { status: { in: [...orderStatuses] } } },
      } satisfies Prisma.TicketWhereInput;
      // One statement-set, bounded by `limit` events: the events, the filtered
      // ticket count per event, and the newest order per event that the human
      // bought themselves (the only kind getMyOrder opens for them).
      const rows = await p.event.findMany({
        where: {
          endsAt: { gt: now },
          status: { in: [...eventStatuses] },
          tickets: { some: heldTicket },
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        take: Math.max(1, Math.min(limit, 50)),
        select: {
          id: true,
          startsAt: true,
          _count: { select: { tickets: { where: heldTicket } } },
          tickets: {
            where: {
              ...heldTicket,
              order: {
                is: {
                  status: { in: [...orderStatuses] },
                  buyerHumanId: humanId,
                },
              },
            },
            orderBy: [
              { order: { occurredAt: "desc" } },
              { orderId: "desc" },
            ],
            take: 1,
            select: { orderId: true },
          },
        },
      });
      return rows.map((row) => ({
        eventId: row.id,
        startsAt: row.startsAt,
        ticketCount: row._count.tickets,
        latestOwnOrderId: row.tickets[0]?.orderId ?? null,
      }));
    },

    activeTicketHolderHumanIds: async (eventId: string) => {
      // Fan-out audience for the address-reveal notification job: every human
      // holding at least one ACTIVE ticket. Same status set as
      // hasActiveTicketForEvent; `distinct` collapses multi-ticket buyers to
      // one notification.
      const rows = await p.ticket.findMany({
        where: {
          eventId,
          status: { in: ["VALID", "SCANNED", "LISTED"] },
        },
        select: { ownerHumanId: true },
        distinct: ["ownerHumanId"],
      });
      return rows.map((row) => row.ownerHumanId);
    },

    findByEventAndHuman: async (eventId: string, humanId: string) => {
      const rows = await p.ticket.findMany({
        where: { eventId, ownerHumanId: humanId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          code: true,
          status: true,
          scannedAt: true,
        },
      });
      return rows.map((row) => ({
        ticketId: row.id,
        ticketCode: row.code,
        status: mapTicketStatusFromDb(row.status),
        scannedAt: row.scannedAt,
      }));
    },

    listAll: async (
      input: ListAllTicketsInput,
    ): Promise<ListAllTicketsResult> => {
      const {
        searchQuery,
        status,
        statuses,
        eventId,
        orgId,
        sort = "issuedAt_desc",
        limit = 25,
        offset = 0,
      } = input;

      const trimmed = searchQuery?.trim();

      const searchConditions = trimmed
        ? {
            OR: [
              { code: { contains: trimmed, mode: "insensitive" as const } },
              {
                owner: {
                  OR: [
                    {
                      name: { contains: trimmed, mode: "insensitive" as const },
                    },
                    {
                      authUser: {
                        email: {
                          contains: trimmed,
                          mode: "insensitive" as const,
                        },
                      },
                    },
                  ],
                },
              },
            ],
          }
        : {};

      const statusFilter = statuses?.length
        ? { status: { in: statuses.map(mapTicketStatusToDb) } }
        : status
          ? { status: mapTicketStatusToDb(status) }
          : {};

      const where = {
        ...statusFilter,
        ...(eventId ? { eventId } : {}),
        ...(orgId ? { event: { orgId } } : {}),
        ...searchConditions,
      } as Prisma.TicketWhereInput;

      const [total, rows] = await Promise.all([
        p.ticket.count({ where }),
        p.ticket.findMany({
          where,
          orderBy: { issuedAt: sort === "issuedAt_asc" ? "asc" : "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            code: true,
            status: true,
            eventId: true,
            ticketTypeId: true,
            orderId: true,
            ownerHumanId: true,
            issuedAt: true,
            scannedAt: true,
            seatId: true,
            event: { select: { title: true } },
            ticketType: { select: { name: true } },
            owner: {
              select: { name: true, authUser: { select: { email: true } } },
            },
            seat: { select: { label: true } },
            _count: { select: { transfers: true, scans: true } },
          },
        }),
      ]);

      return {
        total,
        limit,
        offset,
        items: rows.map<ListPlatformTicketsItem>((row) => ({
          id: row.id,
          code: row.code,
          status: mapTicketStatusFromDb(row.status),
          eventId: row.eventId,
          eventTitle: row.event.title,
          ticketTypeId: row.ticketTypeId,
          ticketTypeName: row.ticketType?.name ?? null,
          orderId: row.orderId,
          ownerHumanId: row.ownerHumanId,
          ownerName: row.owner.name ?? null,
          ownerEmail: row.owner.authUser?.email ?? null,
          issuedAt: row.issuedAt,
          scannedAt: row.scannedAt,
          seatLabel: row.seat?.label ?? null,
          transferCount: row._count.transfers,
          scanCount: row._count.scans,
        })),
      };
    },

    getByIdWithRelations: async (
      ticketId: string,
    ): Promise<TicketDetailRecord | null> => {
      const row = await p.ticket.findUnique({
        where: { id: ticketId },
        select: {
          id: true,
          code: true,
          status: true,
          eventId: true,
          ticketTypeId: true,
          orderId: true,
          ownerHumanId: true,
          seatId: true,
          issuedAt: true,
          scannedAt: true,
          event: { select: { title: true } },
          ticketType: { select: { name: true } },
          owner: {
            select: { name: true, authUser: { select: { email: true } } },
          },
          seat: { select: { label: true } },
        },
      });

      if (!row) return null;

      return {
        id: row.id,
        code: row.code,
        status: mapTicketStatusFromDb(row.status),
        eventId: row.eventId,
        eventTitle: row.event.title,
        ticketTypeId: row.ticketTypeId,
        ticketTypeName: row.ticketType?.name ?? null,
        orderId: row.orderId,
        ownerHumanId: row.ownerHumanId,
        ownerName: row.owner.name ?? null,
        ownerEmail: row.owner.authUser?.email ?? null,
        seatId: row.seatId,
        seatLabel: row.seat?.label ?? null,
        issuedAt: row.issuedAt,
        scannedAt: row.scannedAt,
      };
    },

    listTransfers: async (
      ticketId: string,
    ): Promise<TicketTransferRecord[]> => {
      const rows = await p.ticketTransfer.findMany({
        where: { ticketId },
        orderBy: { at: "desc" },
        select: {
          id: true,
          ticketId: true,
          fromHumanId: true,
          toHumanId: true,
          reason: true,
          orderId: true,
          at: true,
          from: { select: { name: true } },
          to: { select: { name: true } },
        },
      });

      return rows.map((row) => ({
        id: row.id,
        ticketId: row.ticketId,
        fromHumanId: row.fromHumanId,
        fromName: row.from.name ?? null,
        toHumanId: row.toHumanId,
        toName: row.to.name ?? null,
        reason: row.reason as TicketTransferRecord["reason"],
        orderId: row.orderId,
        transferredAt: row.at,
      }));
    },

    listScans: async (ticketId: string): Promise<TicketScanRecord[]> => {
      const rows = await p.ticketScan.findMany({
        where: { ticketId },
        orderBy: { scannedAt: "desc" },
        select: TICKET_SCAN_SELECT,
      });
      return rows.map(mapTicketScanRow);
    },

    listScansByTicketIds: async (
      ticketIds: string[],
    ): Promise<TicketScanRecord[]> => {
      if (ticketIds.length === 0) return [];
      const rows = await p.ticketScan.findMany({
        where: { ticketId: { in: ticketIds } },
        orderBy: [{ scannedAt: "asc" }, { id: "asc" }],
        select: TICKET_SCAN_SELECT,
      });
      return rows.map(mapTicketScanRow);
    },

    activateDraftTicketTypes: async (eventId: string): Promise<number> => {
      const result = await p.ticketType.updateMany({
        where: { eventId, status: "INACTIVE" },
        data: { status: "ACTIVE" },
      });
      return result.count;
    },

    bulkMigrateToEvent: async (input) => {
      const {
        sourceEventId,
        targetEventId,
        ticketTypeMapping,
        regenerateCodes,
      } = input;

      // Find all VALID tickets for the source event.
      const tickets = await p.ticket.findMany({
        where: { eventId: sourceEventId, status: "VALID" },
        select: { id: true, ticketTypeId: true },
      });

      if (tickets.length === 0) {
        return { updatedCount: 0, migratedTicketIds: [] };
      }

      const ids = tickets.map((t) => t.id);

      // Build per-ticket updates because ticketTypeId may differ per ticket
      // and codes need to be unique. Use a transaction for atomicity.
      const { randomUUID } = await import("node:crypto");
      const updates = tickets.map((ticket) => {
        const newTypeId = ticket.ticketTypeId
          ? (ticketTypeMapping[ticket.ticketTypeId] ?? ticket.ticketTypeId)
          : ticket.ticketTypeId;
        const newCode = regenerateCodes
          ? `tk_${randomUUID().replace(/-/g, "").slice(0, 24)}`
          : undefined;

        return p.ticket.update({
          where: { id: ticket.id },
          data: {
            eventId: targetEventId,
            ticketTypeId: newTypeId,
            ...(newCode ? { code: newCode } : {}),
          },
        });
      });

      await Promise.all(updates);

      return {
        updatedCount: ids.length,
        migratedTicketIds: ids,
      };
    },
  };
}

const ticketSelect = {
  id: true,
  eventId: true,
  ticketTypeId: true,
  ownerHumanId: true,
  orderId: true,
  orderItemId: true,
  seatId: true,
  code: true,
  status: true,
  issuedAt: true,
  scannedAt: true,
} as const;

function mapStatusToDb(status: TicketTypeStatus): PrismaTicketTypeStatus {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "DRAFT":
    default:
      return "INACTIVE";
  }
}

function mapTicketStatusToDb(status: TicketStatus): PrismaTicketStatus {
  switch (status) {
    case "VALID":
      return "VALID";
    case "SCANNED":
      return "SCANNED";
    case "INVALID":
      return "INVALID";
    case "REFUNDED":
      return "REFUNDED";
    case "LISTED":
      return "LISTED";
    default:
      return "VALID";
  }
}

function mapTicketStatusFromDb(status: PrismaTicketStatus): TicketStatus {
  switch (status) {
    case "VALID":
    case "SCANNED":
    case "INVALID":
    case "REFUNDED":
    case "LISTED":
      return status;
    default:
      return "VALID";
  }
}

function mapStatusFromDb(status: PrismaTicketTypeStatus): TicketTypeStatus {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "INACTIVE":
    case "ARCHIVED":
    default:
      return "DRAFT";
  }
}

function mapTicketType(tt: {
  id: string;
  eventId: string;
  name: string;
  description: string | null;
  priceCents: number;
  pricingMode?: string;
  minimumCents?: number | null;
  suggestedCents?: number | null;
  capacity: number;
  status: PrismaTicketTypeStatus;
  createdAt: Date;
  updatedAt: Date;
  seatSectionId?: string | null;
  resaleAllowed?: boolean;
  resaleCapCents?: number | null;
  transferAllowed?: boolean;
  scheduledPriceCents?: number | null;
  scheduledPriceAt?: Date | null;
  salesOpenAt?: Date | null;
  salesCloseAt?: Date | null;
}): TicketTypeRecord {
  return {
    id: tt.id,
    eventId: tt.eventId,
    name: tt.name,
    description: tt.description,
    priceCents: tt.priceCents,
    pricingMode: (tt.pricingMode ?? "FIXED") as TicketTypeRecord["pricingMode"],
    minimumCents: tt.minimumCents ?? null,
    suggestedCents: tt.suggestedCents ?? null,
    capacity: tt.capacity,
    status: mapStatusFromDb(tt.status),
    createdAt: tt.createdAt,
    updatedAt: tt.updatedAt,
    seatSectionId: tt.seatSectionId ?? null,
    resaleAllowed: tt.resaleAllowed ?? false,
    resaleCapCents: tt.resaleCapCents ?? null,
    transferAllowed: tt.transferAllowed ?? true,
    scheduledPriceCents: tt.scheduledPriceCents ?? null,
    scheduledPriceAt: tt.scheduledPriceAt ?? null,
    salesOpenAt: tt.salesOpenAt ?? null,
    salesCloseAt: tt.salesCloseAt ?? null,
  };
}

function mapTicket(input: {
  id: string;
  eventId: string;
  ticketTypeId: string | null;
  ownerHumanId: string;
  orderId: string | null;
  orderItemId: string | null;
  seatId: string | null;
  code: string;
  status: PrismaTicketStatus;
  issuedAt: Date;
  scannedAt: Date | null;
}): TicketRecord {
  return {
    id: input.id,
    eventId: input.eventId,
    ticketTypeId: input.ticketTypeId,
    ownerHumanId: input.ownerHumanId,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    seatId: input.seatId,
    code: input.code,
    status: mapTicketStatusFromDb(input.status),
    issuedAt: input.issuedAt,
    scannedAt: input.scannedAt,
  };
}

function mapScanOutcomeToDb(
  outcome: TicketScanOutcome,
): PrismaTicketScanOutcome {
  switch (outcome) {
    case "ACCEPTED":
      return "ACCEPTED";
    case "REPLAY":
      return "REPLAY";
    case "REJECTED":
    default:
      return "REJECTED";
  }
}

const TICKET_SCAN_SELECT = {
  id: true,
  ticketId: true,
  eventId: true,
  actorHumanId: true,
  outcome: true,
  message: true,
  scannedAt: true,
  lat: true,
  lng: true,
  actor: { select: { name: true } },
} as const;

type TicketScanRow = {
  id: string;
  ticketId: string;
  eventId: string;
  actorHumanId: string;
  outcome: PrismaTicketScanOutcome;
  message: string | null;
  scannedAt: Date;
  lat: number | null;
  lng: number | null;
  actor: { name: string | null };
};

function mapTicketScanRow(row: TicketScanRow): TicketScanRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    eventId: row.eventId,
    actorHumanId: row.actorHumanId,
    actorName: row.actor.name ?? null,
    outcome: mapScanOutcomeFromDb(row.outcome),
    message: row.message,
    scannedAt: row.scannedAt,
    locationLat: row.lat ?? null,
    locationLng: row.lng ?? null,
  };
}

function mapScanOutcomeFromDb(
  outcome: PrismaTicketScanOutcome,
): TicketScanOutcome {
  switch (outcome) {
    case "ACCEPTED":
      return "ACCEPTED";
    case "REPLAY":
      return "REPLAY";
    case "REJECTED":
    default:
      return "REJECTED";
  }
}

function mapCreateError(error: unknown): Error {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    const target = Array.isArray(error.meta?.target)
      ? (error.meta?.target as string[])
      : [];
    const conflictCode = target.includes("seatId")
      ? "seat_taken"
      : target.includes("code")
        ? "duplicate_code"
        : "unique_violation";
    const mapped = new Error(conflictCode);
    (mapped as any).code = conflictCode;
    (mapped as any).cause = error;
    return mapped;
  }

  return error instanceof Error ? error : new Error("ticket_create_failed");
}
