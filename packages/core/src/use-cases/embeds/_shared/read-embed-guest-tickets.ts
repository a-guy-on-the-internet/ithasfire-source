import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TicketRecord } from "@th/types";

import { isActiveHolderOrderStatus } from "../../../lib/location/holder-eligibility";
import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";

/**
 * How long after an order's tickets were issued the embed confirmation may
 * still be handed their codes. A paid order's codes take two proofs: the
 * PaymentIntent client secret, and the receipt secret `createGuestCheckout`
 * returned beside it (`_shared/guest-client-secret.ts`). The client secret
 * also appears in a redirect payment's return URL, and from there in browser
 * history and request logs, so alone it confirms the order and gets no
 * codes; the receipt secret stays in the tab that started the payment
 * (memory and sessionStorage, never a URL). A free checkout's proof is its
 * `clientKey` + email, sent in a request body only. The window caps what
 * either is worth if it does leak, and matches how long the widget keeps
 * the receipt secret. After it the tickets are in the buyer's email and
 * account.
 */
export const EMBED_GUEST_TICKET_WINDOW_MS = 2 * 60 * 60 * 1000;

/** A bound, not a feature: checkout caps keep real orders far below it. */
export const EMBED_GUEST_TICKET_MAX = 50;

/**
 * One ticket as the embed confirmation shows it. `code` is `Ticket.code`,
 * which is also the QR payload the scanner reads: holding it IS admission.
 */
export const embedGuestTicketSchema = z
  .object({
    code: z.string().min(1).max(256),
    /** The ticket type's name; null when the type could not be read. */
    ticketTypeName: z.string().nullable(),
    /** `Section name · Seat label` for a seated ticket; null for GA. */
    seatLabel: z.string().nullable(),
  })
  .strict();

export const embedGuestTicketsSchema = z
  .array(embedGuestTicketSchema)
  .max(EMBED_GUEST_TICKET_MAX);

export type EmbedGuestTicket = z.infer<typeof embedGuestTicketSchema>;

type ReadDeps = {
  repos: Pick<Repos, "orders" | "tickets" | "seats" | "events">;
  clock: ClockPort;
};

/**
 * The tickets of `orderId` that its payer may be shown RIGHT NOW. The caller
 * must already have proven the order is the asker's; this function decides
 * only which codes, from the rows as they stand (never from a stored answer):
 *
 * - the order is in an active-holder status (SUCCEEDED, PART_REFUNDED,
 *   DISPUTED), so a refunded or cancelled order yields none;
 * - the ticket is on this order and this order's event, is VALID (not
 *   SCANNED, LISTED for resale, REFUNDED or INVALID), and is still owned by
 *   the order's buyer (one transferred or resold since is not theirs to show);
 * - the newest of those tickets was issued within
 *   `EMBED_GUEST_TICKET_WINDOW_MS`; outside it, none;
 * - at most `EMBED_GUEST_TICKET_MAX`, seated first by seat label, then by
 *   issue time, then by id.
 *
 * Throws what the repos throw; `readEmbedGuestTicketsOrEmpty` is the form a
 * confirmation calls.
 *
 * Ticket codes and stack locals: Sentry attaches a frame's locals one level
 * deep, so a local that IS one ticket row, or a string holding a code, would
 * ship the code with any error raised under it. Every read below is done
 * with ids only, and single rows are touched only in callbacks that cannot
 * throw. Keep it that way: no `const code = …`, no row passed to an awaited
 * call.
 */
export async function readEmbedGuestTickets(
  deps: ReadDeps,
  params: { orderId: string },
): Promise<EmbedGuestTicket[]> {
  const order = await deps.repos.orders.getById(params.orderId);
  if (!order || !order.eventId || !isActiveHolderOrderStatus(order.status)) {
    return [];
  }
  const eventId = order.eventId;
  const buyerHumanId = order.buyerHumanId;

  const orderTickets = await deps.repos.tickets.listByOrderId(order.id);
  const shown = orderTickets.filter(
    (ticket) =>
      ticket.orderId === order.id &&
      ticket.eventId === eventId &&
      ticket.status === "VALID" &&
      ticket.ownerHumanId === buyerHumanId,
  );
  if (shown.length === 0) return [];

  const newestIssuedAt = Math.max(
    ...shown.map((ticket) => new Date(ticket.issuedAt).getTime()),
  );
  const ageMs = deps.clock.now().getTime() - newestIssuedAt;
  // NaN (an unreadable issue time) fails closed.
  if (!(ageMs <= EMBED_GUEST_TICKET_WINDOW_MS)) return [];

  const seatIds = shown
    .map((ticket) => ticket.seatId)
    .filter((seatId): seatId is string => seatId !== null);
  const [ticketTypes, seats] = await Promise.all([
    deps.repos.events.listTicketTypes(eventId),
    seatIds.length > 0
      ? deps.repos.seats.findLabelsByIds({ seatIds, eventId })
      : Promise.resolve([]),
  ]);

  const typeNameById = new Map(ticketTypes.map((tt) => [tt.id, tt.name]));
  const seatLabelById = new Map(
    seats.map((seat) => [
      seat.id,
      seat.sectionName ? `${seat.sectionName} · ${seat.label}` : seat.label,
    ]),
  );
  return toGuestTickets(shown, typeNameById, seatLabelById);
}

/** Pure and non-throwing: the only place single ticket rows are handled. */
function toGuestTickets(
  shown: TicketRecord[],
  typeNameById: Map<string, string>,
  seatLabelById: Map<string, string>,
): EmbedGuestTicket[] {
  const seatLabelOf = (ticket: TicketRecord): string | null =>
    (ticket.seatId ? seatLabelById.get(ticket.seatId) : undefined) ?? null;

  return [...shown]
    .sort((a, b) => {
      const seatA = seatLabelOf(a);
      const seatB = seatLabelOf(b);
      if (seatA !== seatB) {
        if (seatA === null) return 1;
        if (seatB === null) return -1;
        const bySeat = compareLabels(seatA, seatB);
        if (bySeat !== 0) return bySeat;
      }
      const byIssued =
        new Date(a.issuedAt).getTime() - new Date(b.issuedAt).getTime();
      if (byIssued !== 0) return byIssued;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, EMBED_GUEST_TICKET_MAX)
    .map((ticket) => ({
      code: ticket.code,
      ticketTypeName:
        (ticket.ticketTypeId
          ? typeNameById.get(ticket.ticketTypeId)
          : undefined) ?? null,
      seatLabel: seatLabelOf(ticket),
    }));
}

/**
 * "Row A · 2" before "Row A · 10": runs of digits compare as numbers,
 * everything else by code unit. Hand-rolled so the order does not depend on
 * the runtime's locale data.
 */
function compareLabels(a: string, b: string): number {
  const partsA = a.split(/(\d+)/);
  const partsB = b.split(/(\d+)/);
  const length = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const partA = partsA[i] ?? "";
    const partB = partsB[i] ?? "";
    if (partA === partB) continue;
    // Odd indexes are the captured digit runs.
    if (i % 2 === 1) {
      const diff = Number(partA) - Number(partB);
      if (diff !== 0) return diff;
    }
    return partA < partB ? -1 : 1;
  }
  return partsA.length - partsB.length;
}

/**
 * `readEmbedGuestTickets` for a confirmation screen: it never throws. The
 * buyer has paid (or claimed), and saying so matters more than the codes, so
 * a failed read answers `[]` (the widget falls back to "Tickets sent to
 * <email>"), keeps an error log line and reports through `reportError`,
 * because a swallowed failure rides no backstop. Neither the log line nor the
 * report carries a ticket code.
 */
export async function readEmbedGuestTicketsOrEmpty(
  deps: ReadDeps & { reportError?: ReporterPort },
  params: {
    orderId: string;
    useCase: string;
    logger: LoggerPort | undefined;
  },
): Promise<EmbedGuestTicket[]> {
  try {
    return await readEmbedGuestTickets(deps, { orderId: params.orderId });
  } catch (err) {
    // Guarded like the reporter: a throwing logger must not fail the confirm.
    try {
      params.logger?.error(`${params.useCase}.ticketsReadFailed`, {
        orderId: params.orderId,
        err,
      });
    } catch {
      // Intentionally empty.
    }
    reportBestEffort(deps.reportError, err, {
      tags: { useCase: params.useCase, stage: "readEmbedGuestTickets" },
      extra: { orderId: params.orderId },
    });
    return [];
  }
}
