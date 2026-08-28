export interface ParsedTicketQrPayload {
  ticketCode: string;
  embeddedEventId?: string;
}

export function parseTicketQrPayload(
  data: string,
): ParsedTicketQrPayload | null {
  // Code charset: alphanumerics, hyphens, and underscores. The platform
  // mints `tk_<24 hex>` codes, but seed/dev fixtures use `TKT-E2E-…` —
  // both must round-trip through the structured form.
  const structured =
    /^hf:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9_-]{6,64})$/i.exec(
      data,
    );
  if (structured) {
    return {
      embeddedEventId: structured[1],
      ticketCode: structured[2].trim().toUpperCase(),
    };
  }

  const normalized = data.trim();
  if (normalized.length < 6) {
    return null;
  }

  return {
    ticketCode: normalized.toUpperCase(),
  };
}

export function parseVolunteerQrPayload(data: string): string | null {
  const normalized = data.trim();
  return normalized.length > 0 ? normalized : null;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}
