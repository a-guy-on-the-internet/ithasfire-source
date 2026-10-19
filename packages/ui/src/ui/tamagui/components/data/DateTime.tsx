import { memo } from "react";
import {
  formatDateTimeAs,
  type DateTimeFormat,
  type DateTimeInput,
  type FormatDateTimeOptions,
} from "@th/types";

import { Text, type TextProps } from "../typography/Text";

/**
 * The date primitive. Every date and time the product renders goes through this.
 *
 * **Times are always venue-local.** `timeZone` is required, and there is no
 * option to convert to the viewer's zone. An event happens where it happens: a
 * show at Riverfront Park starts at 8pm Central whether it is being read in
 * Nashville or Lisbon, and "helpfully" converting produces a time that is
 * correct and useless. The required prop means a call site missing the venue's
 * zone fails to compile rather than rendering a plausible wrong answer.
 *
 * On web it renders a `<time datetime="...">` carrying the machine-readable
 * instant, so the correct value survives copy-paste, calendar detection and
 * scrapers even though the visible text is venue-local.
 *
 * `DateTime.format()` returns the same string without rendering, for CSV,
 * email and print.
 */
export interface DateTimeProps extends Omit<TextProps, "children"> {
  value: DateTimeInput;
  /** IANA zone for the VENUE, e.g. "America/Chicago". Required by design. */
  timeZone: string;
  /** Default `"datetime"`. */
  format?: DateTimeFormat;
  /** BCP-47. Default "en-US". */
  locale?: string;
  /**
   * Append the zone abbreviation (`8:00 PM CDT`). Turn it on wherever someone
   * might be reading from another zone — a confirmation email, a ticket, a
   * shared link. Leave it off inside a venue's own dashboard, where it is noise.
   */
  showTimeZone?: boolean;
}

const toIso = (value: DateTimeInput): string | undefined => {
  const date =
    value instanceof Date
      ? value
      : new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const DateTimeComponent = memo<DateTimeProps>(function DateTime({
  value,
  timeZone,
  format = "datetime",
  locale,
  showTimeZone = false,
  ...textProps
}) {
  const text = formatDateTimeAs(value, format, {
    timeZone,
    locale,
    showTimeZone,
  });

  return (
    <Text
      tag="time"
      // The visible string is venue-local; this attribute is the instant. Both
      // are true, and a machine reading the page should get the unambiguous one.
      {...({ dateTime: toIso(value) } as Record<string, unknown>)}
      {...textProps}
    >
      {text}
    </Text>
  );
});

/** The string form — CSV, email, `aria-label`, print. */
const format = (
  value: DateTimeInput,
  fmt: DateTimeFormat,
  options: FormatDateTimeOptions,
): string => formatDateTimeAs(value, fmt, options);

export const DateTime = Object.assign(DateTimeComponent, { format });
