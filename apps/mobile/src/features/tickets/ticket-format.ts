export type TicketOrderTone = "neutral" | "success" | "warning" | "danger";

export type TicketOrderStatusDisplay = {
  label: string;
  tone: TicketOrderTone;
};

export type TicketStatusDisplay = {
  label: string;
  tone: TicketOrderTone;
};

const ORDER_STATUS_DISPLAY: Record<string, TicketOrderStatusDisplay> = {
  SUCCEEDED: { label: "Confirmed", tone: "success" },
  PENDING: { label: "Pending", tone: "warning" },
  PART_REFUNDED: { label: "Partial refund", tone: "warning" },
  REFUNDED: { label: "Refunded", tone: "neutral" },
  DISPUTED: { label: "Disputed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

const TICKET_STATUS_DISPLAY: Record<string, TicketStatusDisplay> = {
  VALID: { label: "Ready", tone: "success" },
  SCANNED: { label: "Used", tone: "neutral" },
  INVALID: { label: "Invalid", tone: "danger" },
  REFUNDED: { label: "Refunded", tone: "warning" },
  LISTED: { label: "Listed", tone: "warning" },
};

const normalizeSpaces = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const titleCaseStatus = (status: string): string =>
  status
    .trim()
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase());

export const getTicketOrderStatusDisplay = (
  status: string,
): TicketOrderStatusDisplay => {
  const normalized = status.trim().toUpperCase();
  return (
    ORDER_STATUS_DISPLAY[normalized] ?? {
      label: titleCaseStatus(status),
      tone: "neutral",
    }
  );
};

export const getTicketStatusDisplay = (status: string): TicketStatusDisplay => {
  const normalized = status.trim().toUpperCase();
  return (
    TICKET_STATUS_DISPLAY[normalized] ?? {
      label: titleCaseStatus(status),
      tone: "neutral",
    }
  );
};

export const formatTicketCode = (code: string): string => code.trim();

export const formatTicketOrderDateTime = (
  value: Date | string | null | undefined,
  options: { locale?: string; timeZone?: string } = {},
): string => {
  const date = toDate(value);
  if (!date) return "Date TBA";

  const dateLabel = new Intl.DateTimeFormat(options.locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: options.timeZone,
  }).format(date);

  const timeLabel = new Intl.DateTimeFormat(options.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: options.timeZone,
  }).format(date);

  return normalizeSpaces(`${dateLabel} at ${timeLabel}`);
};

export const formatTicketOrderCurrency = (
  cents: number,
  currency: string,
  options: { locale?: string } = {},
): string => {
  const normalizedCurrency = currency.trim().toUpperCase() || "USD";
  const amount = cents / 100;

  try {
    return new Intl.NumberFormat(options.locale, {
      style: "currency",
      currency: normalizedCurrency,
    }).format(amount);
  } catch {
    return `${normalizedCurrency} ${amount.toFixed(2)}`;
  }
};

export const formatTicketCount = (count: number): string =>
  `${count} ${count === 1 ? "ticket" : "tickets"}`;

export const isPastTicketOrder = (
  value: Date | string | null | undefined,
  now: Date = new Date(),
): boolean => {
  const date = toDate(value);
  return date ? date.getTime() < now.getTime() : false;
};
