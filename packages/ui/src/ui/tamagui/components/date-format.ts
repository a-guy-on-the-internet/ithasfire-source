export type DateDisplayFormat = "mdy" | "dmy";

const SEGMENT_ORDER: Record<
  DateDisplayFormat,
  readonly ["month" | "day", "month" | "day", "year"]
> = {
  mdy: ["month", "day", "year"],
  dmy: ["day", "month", "year"],
} as const;

export const DEFAULT_PLACEHOLDERS: Record<DateDisplayFormat, string> = {
  mdy: "MM/DD/YYYY",
  dmy: "DD/MM/YYYY",
} as const;

const stripNonDigits = (value: string) => value.replace(/\D+/g, "");

const clampDigits = (value: string) => stripNonDigits(value).slice(0, 8);

const padNumber = (value: number, length = 2) =>
  String(value).padStart(length, "0");

const isValidDate = (year: number, month: number, day: number) => {
  if (year < 100 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
};

export const formatDigitsForDisplay = (value: string): string => {
  const digits = clampDigits(value);
  if (digits.length === 0) {
    return "";
  }

  const segments = [] as string[];
  let offset = 0;
  for (const length of [2, 2, 4]) {
    const slice = digits.slice(offset, offset + length);
    if (slice.length > 0) {
      segments.push(slice);
    }
    offset += length;
  }

  return segments.join("/");
};

export const formatIsoToDisplay = (
  iso?: string,
  format: DateDisplayFormat = "mdy",
) => {
  if (!iso) return "";
  const [yearStr, monthStr, dayStr] = iso.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!isValidDate(year, month, day)) {
    return "";
  }

  const segments = SEGMENT_ORDER[format];
  const mapped = segments.map((segment) => {
    if (segment === "year") return padNumber(year, 4);
    if (segment === "month") return padNumber(month);
    return padNumber(day);
  });

  return `${mapped[0]}/${mapped[1]}/${mapped[2]}`;
};

export const parseDisplayToIso = (
  value: string,
  format: DateDisplayFormat,
): string | undefined => {
  const digits = clampDigits(value);
  if (digits.length !== 8) {
    return undefined;
  }

  const first = Number(digits.slice(0, 2));
  const second = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4, 8));
  const order = SEGMENT_ORDER[format];

  const day = order[0] === "day" ? first : second;
  const month = order[0] === "month" ? first : second;

  if (!isValidDate(year, month, day)) {
    return undefined;
  }

  return `${padNumber(year, 4)}-${padNumber(month)}-${padNumber(day)}`;
};

export const isIsoWithinBounds = (iso: string, min?: string, max?: string) => {
  if (min && iso < min) {
    return false;
  }
  if (max && iso > max) {
    return false;
  }
  return true;
};
