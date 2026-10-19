"use client";

// Temporary local stand-ins for @th/ui Money/DateTime, which are not in main
// yet; swap back when they land. Mirrors `DateTime`'s props (`value`,
// required `timeZone`, `format`) and its `<time dateTime>` output.

import { memo } from "react";
import { Text, useLocale, type TextProps } from "@th/ui";

export type DateTimeTextFormat = "date" | "datetime" | "time";

export interface DateTimeTextProps extends Omit<TextProps, "children"> {
  value: Date | string | number;
  /** IANA zone for the VENUE, e.g. "America/Chicago". Required by design. */
  timeZone: string;
  /** Default `"datetime"`. */
  format?: DateTimeTextFormat;
  /** BCP-47. Defaults to the app locale. */
  locale?: string;
}

// Same option sets as `@th/types/datetime` PARTS for the formats used here.
const PARTS: Record<DateTimeTextFormat, Intl.DateTimeFormatOptions> = {
  date: { month: "short", day: "numeric", year: "numeric" },
  datetime: {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  time: { hour: "numeric", minute: "2-digit" },
};

function toDate(value: DateTimeTextProps["value"]): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatIn(
  date: Date,
  format: DateTimeTextFormat,
  locale: string,
  timeZone: string,
): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...PARTS[format], timeZone }).format(
      date,
    );
  } catch {
    // An unknown zone must not blank the row; fall back to the runtime zone.
    return new Intl.DateTimeFormat(locale, PARTS[format]).format(date);
  }
}

const DateTimeTextComponent = memo<DateTimeTextProps>(function DateTimeText({
  value,
  timeZone,
  format = "datetime",
  locale,
  ...textProps
}) {
  const appLocale = useLocale();
  const date = toDate(value);
  const text = date
    ? formatIn(date, format, locale ?? appLocale ?? "en-US", timeZone)
    : "—";
  return (
    <Text
      tag="time"
      // The visible string is venue-local; this attribute is the instant.
      {...({ dateTime: date?.toISOString() } as Record<string, unknown>)}
      {...textProps}
    >
      {text}
    </Text>
  );
});

export const DateTimeText = DateTimeTextComponent;
