import { describe, expect, it } from "vitest";
import type { PayeeLedgerExportRow } from "@th/core/use-cases/payouts/export-payee-ledger";

import {
  formatLedgerMoney,
  ledgerCsv,
  ledgerCsvFilename,
  LEDGER_CSV_HEADER_KEYS,
} from "../ledger-csv";

// `t` echoes the key's last segment, so headers and Type labels are visible
// without a catalog.
const t = (key: string) => key.split(".").pop() ?? key;

const HEADER = LEDGER_CSV_HEADER_KEYS.map((key) => t(key)).join(",");

const row = (over: Partial<PayeeLedgerExportRow> = {}): PayeeLedgerExportRow => ({
  id: "entry-1",
  type: "SETTLEMENT_CREDIT",
  description: "Sales for Friday",
  orderId: "order-1",
  eventName: "Open Mic",
  createdAt: new Date("2026-10-01T03:04:05.000Z"),
  availableAt: new Date("2026-10-08T00:00:00.000Z"),
  currency: "usd",
  amountCents: 1250,
  changeCents: 1250,
  balanceAfterCents: 1250,
  ...over,
});

/** The cells of the first data line, split on commas (no quoted cells). */
const cells = (csv: string) => csv.split("\n")[1]!.split(",");

describe("ledgerCsv", () => {
  it("an empty ledger is the header line only", () => {
    expect(ledgerCsv([], t)).toBe(HEADER);
  });

  it("writes the columns in order, translated header and Type", () => {
    const csv = ledgerCsv([row()], t);
    expect(csv.split("\n")[0]).toBe(
      "payoutsLedgerCsvColDate,payoutsLedgerCsvColType,payoutsLedgerCsvColDescription," +
        "payoutsLedgerCsvColOrder,payoutsLedgerCsvColEvent,payoutsLedgerCsvColAmount," +
        "payoutsLedgerCsvColChange,payoutsLedgerCsvColBalanceAfter," +
        "payoutsLedgerCsvColAvailableFrom,payoutsLedgerCsvColCurrency",
    );
    expect(cells(csv)).toEqual([
      "2026-10-01T03:04:05.000Z",
      "payoutsEntrySalesCredit",
      "Sales for Friday",
      "order-1",
      "Open Mic",
      "12.50",
      "12.50",
      "12.50",
      "2026-10-08T00:00:00.000Z",
      "USD",
    ]);
  });

  it("guards descriptions a spreadsheet would run as a formula", () => {
    for (const description of ["=SUM(A1:A9)", "+1", "-1", "@cmd", "\tx"]) {
      const line = ledgerCsv([row({ description })], t).split("\n")[1]!;
      expect(cells(`h\n${line}`)[2]).toBe(`'${description}`);
    }
  });

  it("guards event names and order ids too", () => {
    const c = cells(ledgerCsv([row({ eventName: "=HYPERLINK(x)", orderId: "@o" })], t));
    expect(c[3]).toBe("'@o");
    expect(c[4]).toBe("'=HYPERLINK(x)");
  });

  it("never prefixes a negative number cell", () => {
    const c = cells(
      ledgerCsv(
        [row({ type: "REFUND_DEBIT", amountCents: 1250, changeCents: -1250, balanceAfterCents: -50 })],
        t,
      ),
    );
    expect(c[5]).toBe("12.50");
    expect(c[6]).toBe("-12.50");
    expect(c[7]).toBe("-0.50");
  });

  it("quotes a comma, doubles a quote, and quotes a line break", () => {
    const csv = ledgerCsv(
      [row({ description: 'Refund, "late"', eventName: "Line\nbreak" })],
      t,
    );
    expect(csv).toContain(`,"Refund, ""late""",`);
    expect(csv).toContain(`,"Line\nbreak",`);
  });

  it.each([
    // A leading CR is guarded, and the line break then forces quoting.
    ["\rinjected", `,"'\rinjected",`],
    ["\r=1+1", `,"'\r=1+1",`],
  ])("guards and quotes a description starting with CR (%j)", (description, expected) => {
    expect(ledgerCsv([row({ description })], t)).toContain(expected);
  });

  it("a leading '-' description is guarded while the same row's negative Change is not", () => {
    const c = cells(
      ledgerCsv(
        [row({ type: "REFUND_DEBIT", description: "-refund", changeCents: -1250, balanceAfterCents: 0 })],
        t,
      ),
    );
    expect(c[2]).toBe("'-refund");
    expect(c[6]).toBe("-12.50");
    expect(c[7]).toBe("0.00");
  });

  it("a guarded cell that also needs quoting gets both", () => {
    const csv = ledgerCsv([row({ description: '=A1,"x"' })], t);
    expect(csv).toContain(`,"'=A1,""x""",`);
  });

  it("blank cells for a missing order, event and available date", () => {
    const c = cells(ledgerCsv([row({ orderId: null, eventName: null, availableAt: null })], t));
    expect(c[3]).toBe("");
    expect(c[4]).toBe("");
    expect(c[8]).toBe("");
  });

  it("a zero-decimal currency has no decimals", () => {
    const c = cells(
      ledgerCsv([row({ currency: "jpy", amountCents: 1050, changeCents: -1050, balanceAfterCents: 0 })], t),
    );
    expect(c.slice(5, 8)).toEqual(["1050", "-1050", "0"]);
    expect(c[9]).toBe("JPY");
  });

  it("one line per row, oldest first as given", () => {
    const csv = ledgerCsv([row({ id: "a" }), row({ id: "b", description: "Second" })], t);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(",Second,");
  });
});

describe("formatLedgerMoney", () => {
  it.each([
    [5, "usd", "0.05"],
    [-5, "usd", "-0.05"],
    [0, "usd", "0.00"],
    [-0, "usd", "0.00"],
    [-123400, "usd", "-1234.00"],
    [123456789, "usd", "1234567.89"],
    // Past float division's exact range for /100 then toFixed.
    [900719925474099, "usd", "9007199254740.99"],
    [1050, "jpy", "1050"],
    [-7, "krw", "-7"],
  ])("%d %s → %s", (cents, currency, expected) => {
    expect(formatLedgerMoney(cents, currency)).toBe(expected);
  });
});

describe("ledgerCsvFilename", () => {
  // Local-time constructor, so the date is the viewer's own.
  const now = new Date(2026, 0, 5, 23, 30);

  it("ledger-<slug>-<local date>.csv", () => {
    expect(ledgerCsvFilename("demo-org", now)).toBe("ledger-demo-org-2026-01-05.csv");
  });

  it("drops characters a filename should not carry", () => {
    expect(ledgerCsvFilename("@admin", now)).toBe("ledger-admin-2026-01-05.csv");
    expect(ledgerCsvFilename("%40admin", now)).toBe("ledger-admin-2026-01-05.csv");
  });
});
