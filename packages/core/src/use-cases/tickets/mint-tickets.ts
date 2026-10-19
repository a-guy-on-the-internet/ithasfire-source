import { generateTicketCode } from "../../lib/tickets/generate-ticket-code";
import type { EventTicketTypeSummary } from "@th/ports/repos/events";
import type { OrderItemRecord, OrderRecord } from "@th/ports/repos/orders";
import type { SeatStatus } from "@th/ports/repos/seats";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";
import { ticketOwnsSeat } from "@th/types";
import { requireTicketingEventId } from "../orders/_shared/require-ticketing-order";

export type MintTicketsForOrderParams = {
  order: OrderRecord;
  issuedAt: Date;
  actor:
    | { kind: "system"; reason: string }
    | { kind: "human"; humanId: string; reason?: string };
};

export type MintTicketsForOrderResult = {
  count: number;
  tickets: TicketRecord[];
};

const ALLOWED_SEAT_STATUSES: SeatStatus[] = ["AVAILABLE", "HELD"];

export async function mintTicketsForOrder(
  tx: TxRepos,
  params: MintTicketsForOrderParams,
): Promise<MintTicketsForOrderResult> {
  const { order, issuedAt } = params;

  const ticketItems = order.items.filter((item) => item.kind === "ticket");
  if (ticketItems.length === 0) {
    return { count: 0, tickets: [] };
  }

  const ticketTypeSummaries = await tx.events.listTicketTypes(requireTicketingEventId(order));
  const ticketTypeMap = new Map<string, EventTicketTypeSummary>(
    ticketTypeSummaries.map((summary) => [summary.id, summary]),
  );

  // ── Group items by ticketTypeId so the idempotency check uses the
  //    aggregate quantity instead of a single item's qty.  This is required
  //    because `computeOrderAmounts` creates one OrderItem per ticket
  //    (qty=1 each) — so five GA tickets produce five items sharing the
  //    same ticketTypeId. ────────────────────────────────────────────────
  const groupedByType = new Map<
    string,
    { items: typeof ticketItems; totalQty: number; allSeatIds: string[] }
  >();

  for (const item of ticketItems) {
    const ticketTypeId = item.ticketTypeId;
    if (!ticketTypeId) {
      throw fail("TICKET_ITEM_MISSING_TICKET_TYPE");
    }

    const qty = normalizeQuantity(item);
    const seatIds = extractSeatIds(item.meta);

    let group = groupedByType.get(ticketTypeId);
    if (!group) {
      group = { items: [], totalQty: 0, allSeatIds: [] };
      groupedByType.set(ticketTypeId, group);
    }
    group.items.push(item);
    group.totalQty += qty;
    group.allSeatIds.push(...seatIds);
  }

  const createdTickets: TicketRecord[] = [];
  const seatsToMarkSold: string[] = [];

  for (const [ticketTypeId, group] of groupedByType) {
    const ticketType = ticketTypeMap.get(ticketTypeId);
    if (!ticketType) {
      throw fail("TICKET_TYPE_NOT_FOUND");
    }

    if (group.totalQty === 0) {
      continue;
    }

    if (
      group.allSeatIds.length > 0 &&
      group.allSeatIds.length !== group.totalQty
    ) {
      throw fail("SEAT_ASSIGNMENT_COUNT_MISMATCH");
    }

    const alreadyIssuedForOrder = await tx.tickets.countForOrderTicketType(
      order.id,
      ticketTypeId,
    );
    const remainingQty = Math.max(group.totalQty - alreadyIssuedForOrder, 0);
    if (remainingQty === 0) {
      continue;
    }

    // Places still held (CAPACITY_CONSUMING_TICKET_STATUSES), the same
    // `issued` the pre-charge gate counted. Counting refunded rows here would
    // refuse a place a refund freed, after the card was charged for it.
    const placesTakenForType =
      await tx.tickets.countCapacityConsumingForTicketType(ticketTypeId);
    if (placesTakenForType + remainingQty > ticketType.capacity) {
      throw fail("TICKET_TYPE_SOLD_OUT");
    }

    let seatQueue: string[] = [];
    if (group.allSeatIds.length > 0) {
      const { seatIdsToAssign } = await validateAndLockSeats(tx, {
        seatIds: group.allSeatIds,
        eventId: requireTicketingEventId(order),
        ticketTypeSeatSectionId: ticketType.seatSectionId ?? null,
        orderId: order.id,
        remainingQty,
      });
      seatQueue = seatIdsToAssign;
    }

    // Distribute minted tickets back to individual order items in order,
    // skipping items that already have a ticket (idempotent re-run).
    let minted = 0;
    for (const item of group.items) {
      if (minted >= remainingQty) break;

      // Skip items that already have a ticket (partial-mint idempotent retry)
      const existingTicket = await tx.tickets.getByOrderItemId(item.id);
      if (existingTicket) continue;

      const itemQty = normalizeQuantity(item);
      for (let i = 0; i < itemQty && minted < remainingQty; i += 1) {
        const seatId =
          seatQueue.length > 0 ? (seatQueue.shift() ?? null) : null;
        const ticket = await tx.tickets.create({
          eventId: requireTicketingEventId(order),
          ticketTypeId,
          ownerHumanId: order.buyerHumanId,
          orderId: order.id,
          orderItemId: item.id,
          seatId,
          code: generateTicketCode(),
          status: "VALID",
          issuedAt,
        });

        createdTickets.push(ticket);
        if (seatId) {
          seatsToMarkSold.push(seatId);
        }
        minted += 1;
      }
    }
  }

  if (seatsToMarkSold.length > 0) {
    await tx.seats.updateStatuses({
      seatIds: seatsToMarkSold,
      status: "SOLD",
      updatedAt: params.issuedAt,
    });
  }

  return { count: createdTickets.length, tickets: createdTickets };
}

function normalizeQuantity(item: OrderItemRecord): number {
  const qty =
    typeof item.qty === "number" && Number.isFinite(item.qty)
      ? Math.trunc(item.qty)
      : 0;
  return Math.max(0, qty);
}

function extractSeatIds(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") {
    return [];
  }

  const seatIds = (meta as { seatIds?: unknown }).seatIds;
  if (seatIds === undefined) {
    return [];
  }

  if (!Array.isArray(seatIds)) {
    throw fail("SEAT_IDS_INVALID");
  }

  const filtered: string[] = [];
  for (const candidate of seatIds) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw fail("SEAT_IDS_INVALID");
    }
    filtered.push(candidate);
  }

  const unique = new Set(filtered);
  if (unique.size !== filtered.length) {
    throw fail("SEAT_IDS_DUPLICATE");
  }

  return filtered;
}

async function validateAndLockSeats(
  tx: TxRepos,
  input: {
    seatIds: string[];
    eventId: string;
    ticketTypeSeatSectionId: string | null;
    orderId: string;
    remainingQty: number;
  },
): Promise<{ seatIdsToAssign: string[] }> {
  const { seatIds, eventId, ticketTypeSeatSectionId, orderId, remainingQty } =
    input;

  const seats = await tx.seats.findByIdsForUpdate({ seatIds, eventId });
  if (seats.length !== seatIds.length) {
    throw fail("SEAT_NOT_FOUND");
  }

  // On idempotent re-runs some seats may already be SOLD for this order.
  // Look up existing tickets for these seats so we can allow SOLD seats
  // that belong to the same order.
  //
  // Read UNFILTERED here — unlike `holdSeatsForCheckout`, mint needs both
  // halves of the answer:
  //  - live occupants, which make the seat genuinely taken (below);
  //  - dead rows that still point at the seat, which cannot block a sale but
  //    WILL blow up `tickets.create` with P2002, and we are past the charge.
  const seatTickets =
    await tx.tickets.findBySeatIdsIncludingTerminal(seatIds);
  const existingSeatTickets = seatTickets.filter((ticket) =>
    ticketOwnsSeat(ticket.status),
  );
  const soldToThisOrder = new Set(
    existingSeatTickets
      .filter((t) => t.orderId === orderId && t.seatId)
      .map((t) => t.seatId!),
  );

  const unavailable = seats.find(
    (seat) =>
      !ALLOWED_SEAT_STATUSES.includes(seat.status) &&
      !(seat.status === "SOLD" && soldToThisOrder.has(seat.id)),
  );
  if (unavailable) {
    throw {
      code: "conflict",
      message: "seat_unavailable",
      seatId: unavailable.id,
    } as const;
  }

  if (ticketTypeSeatSectionId) {
    const mismatch = seats.find(
      (seat) => seat.seatSectionId !== ticketTypeSeatSectionId,
    );
    if (mismatch) {
      throw {
        code: "conflict",
        message: "seat_section_mismatch",
        seatId: mismatch.id,
      } as const;
    }
  }

  const seatIdsToAssign: string[] = [];

  for (const seatId of seatIds) {
    const ticket = existingSeatTickets.find((item) => item.seatId === seatId);
    if (!ticket) {
      seatIdsToAssign.push(seatId);
      continue;
    }

    if (ticket.orderId !== orderId) {
      throw fail("SEAT_TAKEN");
    }
  }

  if (seatIdsToAssign.length < remainingQty) {
    throw fail("SEAT_ALLOCATION_MISMATCH");
  }

  // When rerunning idempotently we may have more seats than remaining qty.
  const assigned = seatIdsToAssign.slice(0, remainingQty);

  // ── @unique pre-flight ────────────────────────────────────────────────────
  // `Ticket.seatId` is @unique. If a DEAD ticket (REFUNDED/INVALID) still
  // points at a seat we are about to assign, `tickets.create` throws P2002 —
  // and we are inside finalize, AFTER the buyer's card is charged. Refuse here
  // instead, so the failure is a deliberate `seat_taken` at the same place
  // every other seat refusal happens, with the offending ticket named.
  //
  // Today's code never creates that state: a release clears `Ticket.seatId`
  // and frees the `Seat` in one place, and a forward-only refund leaves the
  // seat SOLD, which checkout refuses BEFORE the charge. This fires for
  // pre-fix rows, hand-edited seat rows, and — the real risk — a backfill run
  // in the wrong order.
  //
  // ORDERING REQUIREMENT for any such backfill: clear `Ticket.seatId` on
  // REFUNDED/INVALID rows BEFORE (or in the same statement as) flipping their
  // seats to AVAILABLE. Seats-first opens the seat for sale while the dead row
  // still owns the link, which converts a pre-charge refusal into a
  // post-charge failure — strictly worse than the dead-inventory bug the
  // backfill is there to fix.
  const deadClaim = seatTickets.find(
    (ticket) =>
      !ticketOwnsSeat(ticket.status) &&
      ticket.seatId !== null &&
      assigned.includes(ticket.seatId),
  );
  if (deadClaim) {
    throw fail("SEAT_TAKEN", {
      message: "seat_taken_by_voided_ticket",
      meta: {
        seatId: deadClaim.seatId,
        ticketId: deadClaim.id,
        ticketStatus: deadClaim.status,
      },
    });
  }

  return { seatIdsToAssign: assigned };
}
