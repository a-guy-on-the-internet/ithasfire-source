import { describe, expect, it } from "vitest";

import {
  GATE_REFUND_WINDOW_MS,
  classifyReaderFailure,
  isTerminalSaleStatus,
  keyMayHoldASale,
  refundProcedureFor,
  refundWindowLeftMs,
  saleStillProcessing,
  serverAnsweredRequest,
  shouldRotateSaleKey,
  type LastSale,
} from "../sell-stage";

/** A tRPC-shaped error, the way the client actually receives one. */
const trpcError = (appCode: string) =>
  Object.assign(new Error(appCode), { data: { appCode } });

describe("classifyReaderFailure", () => {
  it("renders an offline reader as recoverable, and says nothing was charged", () => {
    const result = classifyReaderFailure(
      trpcError("POS_READER_OFFLINE"),
      "Front door",
      "$70.00",
    );

    expect(result).not.toBeNull();
    expect(result!.headline).toBe("Front door isn't responding");
    // The operator's first thought on a payment error is "did it take the
    // money twice?". Answer it before offering buttons.
    expect(result!.detail).toContain("Nothing was charged");
    expect(result!.detail).toContain("$70.00");
  });

  it("distinguishes a busy reader from an offline one", () => {
    const result = classifyReaderFailure(
      trpcError("POS_READER_BUSY"),
      "Bar",
      "$25.00",
    );

    expect(result).not.toBeNull();
    expect(result!.headline).toBe("Bar is already taking a payment");
    expect(result!.detail).toContain("Nothing was charged");
  });

  it("REFUSES to flatten an unrecognised failure into friendly copy", () => {
    // Telling an operator to retry through a declined card or a
    // misconfigured Connect account would be friendly and wrong — and it
    // would bury a real defect behind reassuring words.
    expect(
      classifyReaderFailure(trpcError("PAYEE_CHARGES_DISABLED"), "Bar", "$1.00"),
    ).toBeNull();
    expect(
      classifyReaderFailure(trpcError("ORDER_NOT_PENDING"), "Bar", "$1.00"),
    ).toBeNull();
    expect(
      classifyReaderFailure(trpcError("POS_READER_NOT_FOUND"), "Bar", "$1.00"),
    ).toBeNull();
  });

  it("returns null for a shapeless error", () => {
    expect(classifyReaderFailure(new Error("kaboom"), "Bar", "$1.00")).toBeNull();
    expect(classifyReaderFailure(null, "Bar", "$1.00")).toBeNull();
    expect(classifyReaderFailure(undefined, "Bar", "$1.00")).toBeNull();
  });

  it("reads the code off the message when there is no structured data", () => {
    // Older builds surface the app code as the message.
    const result = classifyReaderFailure(
      new Error("POS_READER_OFFLINE"),
      "Merch table",
      "$12.00",
    );
    expect(result?.headline).toBe("Merch table isn't responding");
  });
});

describe("isTerminalSaleStatus", () => {
  it("keeps polling while the webhook is in flight", () => {
    expect(isTerminalSaleStatus("PENDING")).toBe(false);
    expect(isTerminalSaleStatus("PROCESSING")).toBe(false);
  });

  it("stops on success", () => {
    expect(isTerminalSaleStatus("SUCCEEDED")).toBe(true);
  });

  it("stops on the outcomes that are NOT good news", () => {
    // A till that polls forever on a CANCELLED order is indistinguishable
    // from one waiting on a slow tap.
    for (const status of [
      "CANCELLED",
      "REFUNDED",
      "PART_REFUNDED",
      "DISPUTED",
    ]) {
      expect(isTerminalSaleStatus(status)).toBe(true);
    }
  });
});

describe("serverAnsweredRequest", () => {
  it("is true for a structured app-code failure", () => {
    expect(serverAnsweredRequest(trpcError("TICKET_TYPE_SALES_ENDED"))).toBe(
      true,
    );
  });

  it("is true for a bare 500 with no app code", () => {
    // The case that actually bit: a Prisma transaction timeout surfaces as a
    // plain INTERNAL_SERVER_ERROR. The server still poisoned the idempotency
    // key on its way out, so reusing it would lock the till for 15 minutes.
    const err = Object.assign(new Error("Transaction API error: expired"), {
      data: { httpStatus: 500 },
    });
    expect(serverAnsweredRequest(err)).toBe(true);
  });

  it("is true for a 4xx", () => {
    const err = Object.assign(new Error("nope"), { data: { httpStatus: 409 } });
    expect(serverAnsweredRequest(err)).toBe(true);
  });

  it("is FALSE when there was no response at all", () => {
    // The only case where reusing the key is protective: the sale may have
    // committed, so a replay must return it rather than sell again.
    expect(serverAnsweredRequest(new TypeError("Failed to fetch"))).toBe(false);
    expect(serverAnsweredRequest(Object.assign(new Error("abort"), { data: null }))).toBe(
      false,
    );
  });

  it("is false for junk", () => {
    expect(serverAnsweredRequest(null)).toBe(false);
    expect(serverAnsweredRequest(undefined)).toBe(false);
    expect(serverAnsweredRequest("boom")).toBe(false);
  });
});

describe("shouldRotateSaleKey", () => {
  it("rotates after an ordinary refusal", () => {
    expect(shouldRotateSaleKey(trpcError("TICKET_TYPE_SALES_ENDED"))).toBe(true);
  });

  it("keeps the key when no answer came back", () => {
    expect(shouldRotateSaleKey(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("keeps the key when the server says it may already hold a sale", () => {
    // Rotating here is the double sale: the next press would record a second
    // sale beside one that may have gone through when the response was lost.
    for (const code of ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_LOCK_IN_PROGRESS"]) {
      expect(shouldRotateSaleKey(trpcError(code))).toBe(false);
    }
  });

  it("tells a stored sale apart from one still being worked on", () => {
    // A conflict means a sale IS stored: go and check. Lock-in-progress
    // usually means the first press is still running: wait, press again.
    expect(keyMayHoldASale(trpcError("IDEMPOTENCY_KEY_CONFLICT"))).toBe(true);
    expect(keyMayHoldASale(trpcError("IDEMPOTENCY_LOCK_IN_PROGRESS"))).toBe(false);
    expect(saleStillProcessing(trpcError("IDEMPOTENCY_LOCK_IN_PROGRESS"))).toBe(true);
    expect(saleStillProcessing(trpcError("IDEMPOTENCY_KEY_CONFLICT"))).toBe(false);
    expect(keyMayHoldASale(trpcError("CASH_AMOUNT_SHORT"))).toBe(false);
    expect(saleStillProcessing(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("refundProcedureFor", () => {
  it("sends card sales down the money path", () => {
    expect(refundProcedureFor("card")).toBe("card");
  });

  it("sends cash AND comp down the cash path", () => {
    // A comp is a cash sale with nothing collected — same procedure. Routing
    // it to the card path would come back NOT_A_POS_CARD_ORDER.
    expect(refundProcedureFor("cash")).toBe("cash");
    expect(refundProcedureFor("comp")).toBe("cash");
  });
});

describe("refundWindowLeftMs", () => {
  const sale = (soldAt: number): LastSale => ({
    orderId: "o1",
    amountCents: 4500,
    ticketCount: 1,
    tender: "cash",
    soldAt,
  });

  it("gives the full window at the moment of sale", () => {
    expect(refundWindowLeftMs(sale(1_000), 1_000)).toBe(GATE_REFUND_WINDOW_MS);
  });

  it("counts down", () => {
    const t0 = 1_000_000;
    expect(refundWindowLeftMs(sale(t0), t0 + 60_000)).toBe(
      GATE_REFUND_WINDOW_MS - 60_000,
    );
  });

  it("hits zero at the boundary and stays there", () => {
    const t0 = 1_000_000;
    expect(refundWindowLeftMs(sale(t0), t0 + GATE_REFUND_WINDOW_MS)).toBe(0);
    expect(refundWindowLeftMs(sale(t0), t0 + GATE_REFUND_WINDOW_MS + 60_000)).toBe(0);
  });

  it("never returns a negative, so callers can treat >0 as 'still offerable'", () => {
    expect(refundWindowLeftMs(sale(0), 10 * GATE_REFUND_WINDOW_MS)).toBe(0);
  });

  it("stays permissive when the client clock runs BEHIND the sale", () => {
    // Skew must not hide a refund the server would allow: the operator is
    // left with no route at all, whereas offering one costs a toast.
    const t0 = 1_000_000;
    expect(refundWindowLeftMs(sale(t0), t0 - 60_000)).toBeGreaterThan(
      GATE_REFUND_WINDOW_MS,
    );
  });
});
