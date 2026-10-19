import { describe, expect, it, vi } from "vitest";

import { csvCell, exportEventSettlementCsv } from "../export-event-settlement-csv";
import { getEventSettlement } from "../get-event-settlement";
import { upsertSheetOffPlatform } from "../settlement-sheet-entries";
import {
  EVENT_ID,
  TERMS_ID,
  VENUE_ADMIN,
  addFinalizedEvent,
  clauseRecord,
  clock,
  makeRepos,
  standardStore,
} from "./deal-fakes";

/** Legacy 20/80 terms after the show: $1,000 of tickets, paid out per order. */
function legacyNight() {
  const s = standardStore();
  addFinalizedEvent(s);
  s.ledger.set(EVENT_ID, {
    orders: [{ orderId: "o1", status: "SUCCEEDED", amountGrossCents: 105_000, feesPlatformCents: 5_000, credited: true }],
    refundCount: 0,
    perPayee: [
      { payeeId: s.actPayee, creditCents: 20_000, refundDebitCents: 0 },
      { payeeId: s.venuePayee, creditCents: 80_000, refundDebitCents: 0 },
    ],
    currencies: ["usd"],
  });
  return s;
}

describe("the CSV export (NFR-002)", () => {
  it("formats cents with the money formatter and writes 'Not entered' for a blank, never $0.00", async () => {
    const s = legacyNight();
    await upsertSheetOffPlatform(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, kind: "DOOR_CASH", label: "Door cash", amountCents: null, heldByPayeeId: s.venuePayee },
    );
    const { csv, contentType, filename } = await exportEventSettlementCsv(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID },
    );
    expect(contentType).toBe("text/csv");
    expect(filename).toBe(`settlement-${EVENT_ID}.csv`);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Section,Item,Party,Amount,Details");
    expect(lines).toContain('Ticket money,Gross: ticket money net of refunds,,"$1,000.00","1 order, 0 refunds"');
    const door = lines.find((l) => l.startsWith("Off-platform money,Door cash"))!;
    expect(door).toContain(",Not entered,");
    expect(door).toContain("excluded from every total");
    expect(door).not.toContain("$0.00");
    // Legacy terms paid entirely per order settle at $0.00 for everyone.
    const settle = lines.filter((l) => l.startsWith("Position,Settle directly"));
    expect(settle.length).toBe(2);
    for (const l of settle) expect(l).toContain("$0.00");
  });

  it("W2: states every exclusion — rows it can't place, orders with no credit, cash sales, disputes — and that it is incomplete", async () => {
    const s = legacyNight();
    const ledger = s.ledger.get(EVENT_ID)!;
    ledger.orders.push(
      { orderId: "u1", status: "SUCCEEDED", amountGrossCents: 2_000, feesPlatformCents: 100, credited: false },
      { orderId: "c1", status: "SUCCEEDED", paymentChannel: "CASH", amountGrossCents: 3_000, feesPlatformCents: 0, credited: false },
    );
    ledger.disputes = [
      { orderId: "o1", status: "LOST", amountCents: 4_000 },
      { orderId: "o1", status: "OPEN", amountCents: 1_000 },
    ];
    // The support act is on the deal (a fee settled directly) when its bar
    // row is typed in…
    s.terms.get(TERMS_ID)!.deal.clauses.push(
      clauseRecord({ payeeId: s.supportPayee, amountType: "FIXED", percent: null, amountCents: 1_000 }),
    );
    await upsertSheetOffPlatform(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, kind: "BAR_SHARE", label: "Bar", amountCents: 5_000, heldByPayeeId: s.supportPayee },
    );
    // …then the deal drops the support act (never paid per order: its row can
    // no longer be placed) and the act (paid $200 per order: a ledger-only row).
    s.terms.get(TERMS_ID)!.deal.clauses = [clauseRecord({ payeeId: s.venuePayee, percent: 100 })];
    const { csv } = await exportEventSettlementCsv({ repos: makeRepos(s), clock }, { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID });
    const lines = csv.trimEnd().split("\r\n");
    const has = (prefix: string) => expect(lines.some((l) => l.startsWith(prefix)), prefix).toBe(true);
    has("Status,Incomplete,,,");
    has("Ticket money,\"Paid per order, no longer in the deal\"");
    has("Left out,Entries the deal can no longer place,,,1 entry");
    has('Left out,Card orders with no per-order payout on record,,$19.00,1 order');
    has('Left out,"Cash sales on record (money taken at the door, never held by Ithas Fire)",,$30.00');
    has('Left out,Disputed orders: undecided,,$10.00');
    has('Left out,Disputed orders: lost,,$40.00');
  });

  it("csvCell quotes separators and defuses formulas in TEXT cells only", () => {
    expect(csvCell("Bar, upstairs")).toBe('"Bar, upstairs"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-$305.00", "money")).toBe("-$305.00");
    expect(csvCell("-$305.00")).toBe("'-$305.00");
  });
});

describe("typed-in rows the deal can no longer place", () => {
  it("are left out of the sheet, named, and reported — never silently dropped", async () => {
    const s = legacyNight();
    await upsertSheetOffPlatform(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, kind: "BAR_SHARE", label: "Bar", amountCents: 5_000, heldByPayeeId: s.actPayee },
    );
    const rowId = s.sheets.get(EVENT_ID)!.offPlatform[0]!.id;
    // A legacy line edit later drops the act from the terms entirely (and
    // its ledger figure with it).
    s.terms.get(TERMS_ID)!.deal.clauses = [clauseRecord({ payeeId: s.venuePayee, percent: 100 })];
    s.ledger.get(EVENT_ID)!.perPayee = [{ payeeId: s.venuePayee, creditCents: 100_000, refundDebitCents: 0 }];

    const reportError = vi.fn();
    const out = await getEventSettlement(
      { repos: makeRepos(s), clock, reportError },
      { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID },
    );
    expect(out.staleEntryIds).toEqual([rowId]);
    expect(out.entries.offPlatform).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "settlement_sheet_stale_entries" }),
      expect.objectContaining({ extra: expect.objectContaining({ staleEntryIds: [rowId] }) }),
    );
  });

  it("a throwing reporter never changes the sheet", async () => {
    const s = legacyNight();
    await upsertSheetOffPlatform(
      { repos: makeRepos(s), clock },
      { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID, kind: "BAR_SHARE", label: "Bar", amountCents: 5_000, heldByPayeeId: s.actPayee },
    );
    s.terms.get(TERMS_ID)!.deal.clauses = [clauseRecord({ payeeId: s.venuePayee, percent: 100 })];
    s.ledger.get(EVENT_ID)!.perPayee = [{ payeeId: s.venuePayee, creditCents: 100_000, refundDebitCents: 0 }];
    const out = await getEventSettlement(
      {
        repos: makeRepos(s),
        clock,
        reportError: () => {
          throw new Error("sentry down");
        },
      },
      { actorHumanId: VENUE_ADMIN, eventId: EVENT_ID },
    );
    expect(out.staleEntryIds.length).toBe(1);
  });
});
