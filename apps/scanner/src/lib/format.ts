import type { RouterOutputs } from "../trpc";

type TicketScanResult = RouterOutputs["tickets"]["scanTicket"];

/**
 * Format an ISO/epoch input as a locale time string, returning null when
 * the input is missing or malformed. `new Date(garbage).toLocaleTimeString()`
 * returns "Invalid Date" silently — fine to display but easy to forget.
 * `null` lets callers decide whether to omit the surrounding string or
 * fall back to "—".
 */
export const safeTimeString = (
  input: string | number | Date | null | undefined,
): string | null => {
  if (input === null || input === undefined || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleTimeString();
  } catch {
    return null;
  }
};

/** Convert the tRPC ticket scan outcome into a single user-facing line. */
export const formatTicketOutcome = (
  result: TicketScanResult | null,
): string => {
  if (!result) {
    return "";
  }

  if (result.outcome === "ACCEPTED") {
    return `Accepted ticket ${result.ticketId.slice(-8)}`;
  }

  if (result.outcome === "REPLAY") {
    const t = safeTimeString(result.previousScannedAt);
    return t ? `Already scanned at ${t}` : "Already scanned";
  }

  return result.reason.replace(/_/g, " ");
};

/**
 * Map a volunteer-lookup error into a human-readable message.
 *
 * The server surfaces typed error codes as Error messages (via tRPC default
 * error formatting); we substring-match on the well-known codes so operators
 * get actionable copy instead of raw slugs.
 */
export const formatVolunteerError = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : "Volunteer lookup failed";

  if (
    message.includes("volunteer_qr_wrong_event") ||
    message.includes("token_event_mismatch")
  ) {
    return "This volunteer QR belongs to a different event.";
  }

  if (message.includes("volunteer_qr_expired")) {
    return "This volunteer QR expired. Ask the volunteer to refresh it.";
  }

  if (message.includes("volunteer_qr_invalid")) {
    return "This volunteer QR could not be verified.";
  }

  return message;
};
