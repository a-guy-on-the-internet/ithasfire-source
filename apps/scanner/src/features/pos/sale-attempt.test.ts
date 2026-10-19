import { describe, expect, it, vi } from "vitest";

import {
  NEW_ATTEMPT,
  PROCESSING_PRESSES_BEFORE_CHECK,
  attemptAnswered,
  attemptFailed,
  closeOpenCardSale,
  cardClearedCopy,
  cardClearedAfterCancel,
  closeOutcomeView,
  isUnresolved,
  keyForPress,
  saleLeaveRisk,
  stageAfterClose,
  tenderOpen,
  unresolvedNotice,
  type CompletedSale,
  type SaleAttempt,
} from "./sale-attempt";

const serverError = (appCode: string) =>
  Object.assign(new Error(appCode), { data: { appCode, httpStatus: 409 } });
/** No response at all: what a dropped connection looks like to the client. */
const lostResponse = () => new TypeError("Network request failed");
/** A bare 500 with no app code: the server answered. */
const bare500 = () =>
  Object.assign(new Error("Internal server error"), {
    data: { httpStatus: 500 },
  });

const minter = () => {
  let n = 0;
  return vi.fn(() => `key-${++n}`);
};

const pressed = (mint: () => string): SaleAttempt =>
  keyForPress(NEW_ATTEMPT, mint).attempt;

describe("the sale's key", () => {
  it("mints once per sale and reuses it on the next press", () => {
    const mint = minter();
    const first = keyForPress(NEW_ATTEMPT, mint);
    const second = keyForPress(first.attempt, mint);
    expect(first.key).toBe("key-1");
    expect(second.key).toBe("key-1");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("KEEPS the key on a lost response and locks the other tenders", () => {
    const mint = minter();
    const { attempt, handled } = attemptFailed(pressed(mint), lostResponse(), "cash", mint);
    expect(handled).toBe(true);
    expect(attempt.key).toBe("key-1");
    expect(attempt.lock).toEqual({ tender: "cash", reason: "no-answer" });
    expect(isUnresolved(attempt)).toBe(true);
    // The replay goes out under the SAME key, so a recorded sale comes back
    // instead of a second one being sold.
    expect(keyForPress(attempt, mint).key).toBe("key-1");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("KEEPS the key on IDEMPOTENCY_LOCK_IN_PROGRESS, and the same tender stays pressable", () => {
    const mint = minter();
    const { attempt, handled } = attemptFailed(
      pressed(mint),
      serverError("IDEMPOTENCY_LOCK_IN_PROGRESS"),
      "card",
      mint,
    );
    expect(handled).toBe(true);
    expect(attempt.key).toBe("key-1");
    expect(attempt.lock).toEqual({ tender: "card", reason: "processing" });
    expect(attempt.mayAlreadyBeRecorded).toBe(false);
    expect(unresolvedNotice(attempt)).toBe(
      "Still being processed. Wait a moment, then press Tap to Pay again.",
    );
    const gate = {
      quoteReady: true,
      hasCardTotal: true,
      attempt,
      emailInvalid: false,
      busy: false,
    };
    expect(tenderOpen("card", gate)).toBe(true);
    expect(tenderOpen("cash", gate)).toBe(false);
    expect(tenderOpen("comp", gate)).toBe(false);
  });

  it("escalates to 'may already be recorded' when LOCK_IN_PROGRESS doesn't clear", () => {
    const mint = minter();
    let attempt = pressed(mint);
    for (let i = 0; i < PROCESSING_PRESSES_BEFORE_CHECK; i++) {
      attempt = attemptFailed(
        attempt,
        serverError("IDEMPOTENCY_LOCK_IN_PROGRESS"),
        "cash",
        mint,
      ).attempt;
    }
    expect(attempt.mayAlreadyBeRecorded).toBe(true);
    expect(attempt.key).toBe("key-1");
  });

  it("IDEMPOTENCY_KEY_CONFLICT → 'may already be recorded', key kept, every tender shut", () => {
    const mint = minter();
    const { attempt, handled } = attemptFailed(
      pressed(mint),
      serverError("IDEMPOTENCY_KEY_CONFLICT"),
      "cash",
      mint,
    );
    expect(handled).toBe(true);
    expect(attempt.key).toBe("key-1");
    expect(attempt.mayAlreadyBeRecorded).toBe(true);
    expect(unresolvedNotice(attempt)).toMatch(/^This sale may already be recorded\./);
    const gate = {
      quoteReady: true,
      hasCardTotal: true,
      attempt,
      emailInvalid: false,
      busy: false,
    };
    expect(tenderOpen("card", gate)).toBe(false);
    expect(tenderOpen("cash", gate)).toBe(false);
    expect(tenderOpen("comp", gate)).toBe(false);
  });

  it("ROTATES the key on a refusal the server decided (its key is spent for 15 minutes)", () => {
    const mint = minter();
    const refused = attemptFailed(
      pressed(mint),
      serverError("TICKET_TYPE_SOLD_OUT"),
      "cash",
      mint,
    );
    expect(refused.handled).toBe(false);
    expect(refused.attempt.key).toBe("key-2");
    expect(refused.attempt.lock).toBeNull();

    // A bare 500 is an answer too: keeping its key locked a till out once.
    const crashed = attemptFailed(refused.attempt, bare500(), "cash", mint);
    expect(crashed.attempt.key).toBe("key-3");
    expect(crashed.handled).toBe(false);
  });

  it("rotates on CASH_AMOUNT_SHORT: the next press is a new attempt at the new total", () => {
    const mint = minter();
    const { attempt, handled } = attemptFailed(
      pressed(mint),
      serverError("CASH_AMOUNT_SHORT"),
      "cash",
      mint,
    );
    expect(handled).toBe(false);
    expect(attempt.key).toBe("key-2");
  });

  it("an answer clears the lock but keeps the key until the sale closes", () => {
    const mint = minter();
    const locked = attemptFailed(pressed(mint), lostResponse(), "card", mint).attempt;
    const answered = attemptAnswered(locked);
    expect(answered.lock).toBeNull();
    expect(answered.key).toBe("key-1");
  });
});

describe("tenderOpen — the quote gates Charge", () => {
  const base = {
    quoteReady: true,
    hasCardTotal: true,
    attempt: NEW_ATTEMPT,
    emailInvalid: false,
    busy: false,
  };

  it("opens card and cash on a ready quote", () => {
    expect(tenderOpen("card", base)).toBe(true);
    expect(tenderOpen("cash", base)).toBe(true);
  });

  it("shuts card and cash while the quote is loading or refetching", () => {
    expect(tenderOpen("card", { ...base, quoteReady: false })).toBe(false);
    expect(tenderOpen("cash", { ...base, quoteReady: false })).toBe(false);
  });

  it("shuts the card for a cart with no card total ($0 with a code), not cash", () => {
    expect(tenderOpen("card", { ...base, hasCardTotal: false })).toBe(false);
    expect(tenderOpen("cash", { ...base, hasCardTotal: false })).toBe(true);
  });

  it("keeps comp open with no quote: a comp charges no tax", () => {
    expect(tenderOpen("comp", { ...base, quoteReady: false })).toBe(true);
  });

  it("shuts everything while busy or while the email is an obvious typo", () => {
    for (const tender of ["card", "cash", "comp"] as const) {
      expect(tenderOpen(tender, { ...base, busy: true })).toBe(false);
      expect(tenderOpen(tender, { ...base, emailInvalid: true })).toBe(false);
    }
  });
});

describe("closing an open card sale", () => {
  const order = (status: CompletedSale["status"]): CompletedSale => ({
    orderId: "55555555-5555-5555-5555-555555555555",
    status,
    paymentChannel: "POS",
    amountCents: 4_772,
    discountCents: 0,
    promoCodes: [],
    isComp: false,
    ticketCount: 2,
    tickets: [],
  });

  it("is closed when the cancel goes through, and only then returns to the cart", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => ({ cancelled: true }),
      check: async () => order("PENDING"),
    });
    expect(outcome).toEqual({ kind: "closed" });
    expect(stageAfterClose(outcome)).toBe("cart");
  });

  it("a cancel finding SUCCEEDED is a paid card sale: done screen, NEVER the cart's Cash", async () => {
    const check = vi.fn(async () => order("SUCCEEDED"));
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw serverError("ORDER_NOT_PENDING");
      },
      check,
    });
    expect(check).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("paid");
    expect(stageAfterClose(outcome)).toBe("done");
    expect(stageAfterClose(outcome)).not.toBe("cart");
  });

  it("ORDER_NOT_PROCESSABLE (paid, webhook pending) asks the server and stays put", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw serverError("ORDER_NOT_PROCESSABLE");
      },
      check: async () => order("PROCESSING"),
    });
    expect(outcome).toMatchObject({ kind: "unknown", paidNotFinalised: true });
    expect(stageAfterClose(outcome)).toBe("checking");
    const view = closeOutcomeView(outcome);
    expect(view?.label).toBe("Confirming card");
    expect(view?.settling).toBe(true);
    // "may have", never a claim the till can't back.
    expect(view?.explanation).toContain("may have gone through");
  });

  it("ORDER_NOT_PENDING on an order that turns out CANCELLED is closed", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw serverError("ORDER_NOT_PENDING");
      },
      check: async () => order("CANCELLED"),
    });
    expect(stageAfterClose(outcome)).toBe("cart");
  });

  it("a failed check after ORDER_NOT_PENDING is unknown, never closed", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw serverError("ORDER_NOT_PENDING");
      },
      check: async () => {
        throw lostResponse();
      },
    });
    expect(outcome.kind).toBe("unknown");
    expect(stageAfterClose(outcome)).toBe("checking");
  });

  it("a cancel whose answer was LOST asks the server before deciding anything", async () => {
    const check = vi.fn(async () => order("CANCELLED"));
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw lostResponse();
      },
      check,
    });
    // The lost cancel went through: back to the cart.
    expect(check).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ kind: "closed" });
  });

  it("a lost cancel on an order that turns out PAID is the card sale, never the cart", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw lostResponse();
      },
      check: async () => order("SUCCEEDED"),
    });
    expect(stageAfterClose(outcome)).toBe("done");
  });

  // The double-charge path: tap succeeds → Cancel → the server's
  // ORDER_NOT_PROCESSABLE is lost → the order still reads PENDING because the
  // webhook hasn't landed. PENDING proves nothing here.
  it("a LOST cancel on a PENDING order is unknown: no Clear, no cash", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw lostResponse();
      },
      check: async () => order("PENDING"),
    });
    expect(outcome).toMatchObject({ kind: "unknown", cancelAnswered: false });
    expect(stageAfterClose(outcome)).toBe("checking");
    const copy = closeOutcomeView(outcome)?.explanation ?? "";
    expect(copy).toContain("may have gone through");
    expect(copy).not.toMatch(/unpaid/i);
    // The reader screen is gone; the copy must not send them to it.
    expect(copy).not.toMatch(/reader/i);
  });

  it("a cancel that failed with no app code (a Stripe error as a bare 500) is unknown", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw bare500();
      },
      check: async () => order("PENDING"),
    });
    expect(outcome).toMatchObject({ kind: "unknown", cancelAnswered: false });
  });

  it("a lost cancel whose check ALSO fails is unknown", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw lostResponse();
      },
      check: async () => {
        throw lostResponse();
      },
    });
    expect(outcome).toMatchObject({ kind: "unknown", status: null });
    expect(closeOutcomeView(outcome)?.label).toBe("Card sale not closed");
  });

  // The server can't produce a "refused, payment untouched" answer the till
  // could act on: completeSale runs the same role / event checks, so the
  // check refuses too. Every refusal is unknown; there is no in-screen Clear.
  it("a cancel REFUSAL (role, event) is unknown, whatever the check says", async () => {
    for (const code of ["INSUFFICIENT_ROLE", "NOT_A_POS_ORDER", "EVENT_NOT_FOUND"]) {
      const pending = await closeOpenCardSale({
        cancel: async () => {
          throw serverError(code);
        },
        check: async () => order("PENDING"),
      });
      expect(pending).toMatchObject({ kind: "unknown", cancelAnswered: true });
      const refusedToo = await closeOpenCardSale({
        cancel: async () => {
          throw serverError(code);
        },
        check: async () => {
          throw serverError(code);
        },
      });
      expect(refusedToo).toMatchObject({ kind: "unknown", status: null });
    }
  });

  it("a refusal on an order that turns out PAID is still the card sale", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw serverError("INSUFFICIENT_ROLE");
      },
      check: async () => order("SUCCEEDED"),
    });
    expect(outcome.kind).toBe("paid");
  });

  it("PENDING after ORDER_NOT_PROCESSABLE is unknown: the payment went through", async () => {
    const outcome = await closeOpenCardSale({
      cancel: async () => {
        throw serverError("ORDER_NOT_PROCESSABLE");
      },
      check: async () => order("PENDING"),
    });
    expect(outcome).toMatchObject({ kind: "unknown", paidNotFinalised: true });
  });

  it("closed and paid leave the checking screen, so they have no view", () => {
    expect(closeOutcomeView({ kind: "closed" })).toBeNull();
  });

  it("says each status as a sentence ('was refunded', not 'is part_refunded')", () => {
    const view = (status: string) =>
      closeOutcomeView({
        kind: "unknown",
        paidNotFinalised: false,
        cancelAnswered: true,
        status,
        error: null,
      });
    expect(view("PENDING")?.explanation).toContain("still has this card sale open");
    expect(view("PROCESSING")?.explanation).toContain("still processing");
    expect(view("PROCESSING")?.settling).toBe(true);
    expect(view("PART_REFUNDED")?.explanation).toContain("has been refunded");
    expect(view("DISPUTED")?.explanation).toContain("is disputed");
    expect(view("PROCESSING")?.label).toBe("Confirming card");
    // A re-check can't move a refunded, disputed or unknown status: those
    // offer a new sale; pending / processing keep waiting.
    for (const s of ["REFUNDED", "PART_REFUNDED", "DISPUTED", "ODD"]) {
      expect(view(s)?.deadEnd).toBe(true);
    }
    for (const s of ["PENDING", "PROCESSING"]) {
      expect(view(s)?.deadEnd).toBeUndefined();
    }
    for (const s of ["PENDING", "PROCESSING", "PART_REFUNDED", "REFUNDED", "DISPUTED", "ODD"]) {
      expect(view(s)?.explanation).not.toMatch(/_|is (pending|part)/i);
    }
  });
});

describe("the card-cleared notice follows the best-effort cancel", () => {
  it("a cancel that went through (or found no order): cancelled, the card wasn't charged", () => {
    expect(cardClearedAfterCancel(null)).toBe("cancelled");
    expect(cardClearedAfterCancel(serverError("ORDER_NOT_FOUND"))).toBe("cancelled");
    expect(cardClearedCopy("cancelled", "$47.72")).toEqual({
      title: "Card sale cancelled",
      body: "The card wasn't charged. You can ring those tickets up again.",
    });
  });

  it("ORDER_NOT_PROCESSABLE: the card may have gone through, don't take cash", () => {
    expect(cardClearedAfterCancel(serverError("ORDER_NOT_PROCESSABLE"))).toBe("maybe-paid");
    expect(cardClearedCopy("maybe-paid", "$47.72")).toEqual({
      title: "Don't take cash for the $47.72 card sale you cleared",
      body: "That card may have gone through. If it did, the sale stands.",
    });
  });

  it("anything else (ORDER_NOT_PENDING, a refusal, no answer) keeps 'don't take cash'", () => {
    for (const err of [serverError("ORDER_NOT_PENDING"), serverError("INSUFFICIENT_ROLE"), lostResponse(), bare500()]) {
      expect(cardClearedAfterCancel(err)).toBe("unconfirmed");
    }
    expect(cardClearedCopy("unconfirmed", "$47.72")).toEqual({
      title: "Don't take cash for the $47.72 card sale you cleared",
      body: "If that card went through, the sale stands. Its tickets may stay held for a few minutes.",
    });
    // No amount known: the title still points at the old sale.
    expect(cardClearedCopy("unconfirmed", null).title).toBe(
      "Don't take cash for the card sale you cleared",
    );
  });

  it("a card no-answer lock says not to take cash; a cash one doesn't need to", () => {
    const mint = minter();
    const card = attemptFailed(pressed(mint), lostResponse(), "card", mint).attempt;
    expect(unresolvedNotice(card)).toContain("Don't take cash for these tickets.");
    const cash = attemptFailed(pressed(mint), lostResponse(), "cash", mint).attempt;
    expect(unresolvedNotice(cash)).not.toContain("Don't take cash");
  });
});

describe("saleLeaveRisk: what leaving the Sell tab would drop", () => {
  it("guards an open or closing card sale", () => {
    for (const stage of ["tap-to-pay", "card-closing"] as const) {
      expect(saleLeaveRisk({ stage, attempt: NEW_ATTEMPT, busy: false })).toBe("card");
    }
  });

  it("guards a press still waiting on the server", () => {
    expect(saleLeaveRisk({ stage: "cash", attempt: NEW_ATTEMPT, busy: true })).toBe(
      "sending",
    );
  });

  it("guards a key that may hold a sale", () => {
    const mint = minter();
    const lost = attemptFailed(pressed(mint), lostResponse(), "cash", mint).attempt;
    expect(saleLeaveRisk({ stage: "cash", attempt: lost, busy: false })).toBe(
      "unresolved",
    );
    const conflict = attemptFailed(
      pressed(mint),
      serverError("IDEMPOTENCY_KEY_CONFLICT"),
      "cash",
      mint,
    ).attempt;
    expect(saleLeaveRisk({ stage: "browse", attempt: conflict, busy: false })).toBe(
      "unresolved",
    );
  });

  it("lets a cart, a cash sheet with nothing sent, or a done screen go", () => {
    for (const stage of ["browse", "cash", "result"] as const) {
      expect(saleLeaveRisk({ stage, attempt: NEW_ATTEMPT, busy: false })).toBeNull();
    }
    // A refusal rotated the key: nothing is pending under it.
    const mint = minter();
    const refused = attemptFailed(
      pressed(mint),
      serverError("CASH_AMOUNT_SHORT"),
      "cash",
      mint,
    ).attempt;
    expect(saleLeaveRisk({ stage: "cash", attempt: refused, busy: false })).toBeNull();
  });
});
