import { isZeroDecimalCurrency } from "@th/types/money";
import type { PayeeLedgerExportRow } from "@th/core/use-cases/payouts/export-payee-ledger";

import { LEDGER_ENTRY_LABEL_KEY } from "./ledger-entry-presentation";

// ─────────────────────────────────────────────────────────────────────────────
// The ledger download (spec docs/specs/2026-10-14/payouts-ledger-export.spec.yaml,
// FR-007 / FR-010). The server returns every row; this builds the file, because
// the headers and Type labels are translated and only the page has `t`.
//
// Two kinds of cell, and the difference is the point:
//
//   * TEXT cells (dates, Type, Description, Order, Event, Currency) take the
//     formula guard: a value a spreadsheet would run as a formula (leading
//     = + - @ tab CR) gets an apostrophe in front. Descriptions and event
//     names are typed by people.
//   * NUMBER cells (Amount, Change, Balance after) are ours, built from
//     integer cents here, and are never prefixed — a negative Change has to
//     stay a number a spreadsheet can sum.
//
// Any cell holding a quote, comma or line break is quoted. No BOM here:
// `downloadCsv` adds it.
// ─────────────────────────────────────────────────────────────────────────────

type Translate = (key: string) => unknown;

/** Header keys, in column order (FR-007). */
export const LEDGER_CSV_HEADER_KEYS = [
  "admin.payoutsLedgerCsvColDate",
  "admin.payoutsLedgerCsvColType",
  "admin.payoutsLedgerCsvColDescription",
  "admin.payoutsLedgerCsvColOrder",
  "admin.payoutsLedgerCsvColEvent",
  "admin.payoutsLedgerCsvColAmount",
  "admin.payoutsLedgerCsvColChange",
  "admin.payoutsLedgerCsvColBalanceAfter",
  "admin.payoutsLedgerCsvColAvailableFrom",
  "admin.payoutsLedgerCsvColCurrency",
] as const;

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A text cell: formula-guarded, then quoted if needed. */
export function textCell(value: string): string {
  return quote(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
}

/** A number cell: never prefixed (a leading "-" is a sign, not a formula). */
function numberCell(value: string): string {
  return quote(value);
}

/**
 * Integer minor units → major units as plain text: "." decimal point, no
 * thousands separator, fixed decimals (0 for a zero-decimal currency, else
 * 2), whatever the viewer's language (C8). String arithmetic on the integer,
 * so no float division can misround a large amount.
 */
export function formatLedgerMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(cents)));
  if (isZeroDecimalCurrency(currency)) return `${sign}${digits}`;
  const padded = digits.padStart(3, "0");
  return `${sign}${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function isoOrBlank(value: Date | string | null): string {
  if (value === null) return "";
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Header line, then one line per row, oldest first as given. */
export function ledgerCsv(
  rows: readonly PayeeLedgerExportRow[],
  t: Translate,
): string {
  const header = LEDGER_CSV_HEADER_KEYS.map((key) =>
    textCell(String(t(key))),
  ).join(",");
  const lines = rows.map((row) =>
    [
      textCell(isoOrBlank(row.createdAt)),
      textCell(String(t(LEDGER_ENTRY_LABEL_KEY[row.type]))),
      textCell(row.description),
      textCell(row.orderId ?? ""),
      textCell(row.eventName ?? ""),
      numberCell(formatLedgerMoney(row.amountCents, row.currency)),
      numberCell(formatLedgerMoney(row.changeCents, row.currency)),
      numberCell(formatLedgerMoney(row.balanceAfterCents, row.currency)),
      textCell(isoOrBlank(row.availableAt)),
      textCell(row.currency.toUpperCase()),
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

/**
 * `ledger-<slug>-<YYYY-MM-DD>.csv`, the viewer's LOCAL date (C7). The slug
 * is the page's; anything outside [A-Za-z0-9_-] is dropped so a person's
 * `@handle` slug cannot put odd characters into a filename.
 */
export function ledgerCsvFilename(slug: string, now: Date): string {
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // A malformed escape: keep the raw slug and let the filter below clean it.
  }
  const safe = decoded.replace(/[^A-Za-z0-9_-]/g, "") || "payouts";
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `ledger-${safe}-${date}.csv`;
}
