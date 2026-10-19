// ─────────────────────────────────────────────────────────────────────────────
// The tickets of a confirmed embed order, as the server hands them over
//
// A ticket's `code` admits whoever shows it, so it is held in component state
// and nowhere else: never in sessionStorage or localStorage, never in a URL,
// never in a message to the host page, never in a log or a traced error. The
// email is the durable copy.
// ─────────────────────────────────────────────────────────────────────────────

/** One ticket of a confirmed order. The scanner reads `code` itself. */
export type EmbedTicketCode = {
  code: string;
  ticketTypeName: string | null;
  seatLabel: string | null;
};

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * The tickets in a server answer's `tickets` field, or none.
 *
 * Read from `unknown` on purpose: web and API deploy separately, so an older
 * API sends no such field, and the server sends an empty list when it
 * withholds the codes (after its window, after a refund, or when its read
 * failed). Anything that is not a ticket with a code is left out, so the
 * screen never draws a QR of nothing.
 */
export function readEmbedTickets(value: unknown): EmbedTicketCode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): EmbedTicketCode[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { code, ticketTypeName, seatLabel } = entry as Record<string, unknown>;
    if (typeof code !== "string" || code.trim() === "") return [];
    return [
      {
        code,
        ticketTypeName: textOrNull(ticketTypeName),
        seatLabel: textOrNull(seatLabel),
      },
    ];
  });
}

/**
 * The tickets a server answer carries FOR `orderId`, or none.
 *
 * Only "confirmed" carries tickets, and only an answer that names this very
 * order is believed: the widget also asks about orders the buyer left
 * behind, and one of those answers must never put its tickets on screen as
 * if they were this purchase.
 */
export function ticketsForOrder(
  orderId: string,
  answer: { outcome: string; orderId?: string; tickets?: unknown },
): EmbedTicketCode[] {
  if (answer.outcome !== "confirmed" || answer.orderId !== orderId) return [];
  return readEmbedTickets(answer.tickets);
}
