import { describe, expect, it } from "vitest";

import en from "@/i18n/messages/en";

import {
  classifyResaleReadError,
  classifyResaleWriteError,
} from "../deal-errors";
import {
  RESALE_NOT_EDITABLE_KEYS,
  formOfClause,
  parseResaleForm,
  recipientPortions,
  resaleExample,
  resaleSentenceOf,
  sameResaleClause,
  type ResaleRecipient,
} from "../resale-clause-model";

/**
 * The resale clause block (organiser-resale-share, board RC1): the form's
 * parse into what `deals.setResaleClause` takes, the worked example (priced by
 * the server's own functions), and every write refusal mapped to copy that
 * exists in the catalog.
 */

const recipient = (
  lineId: string,
  percent: number,
  overrides: Partial<ResaleRecipient> = {},
): ResaleRecipient => ({
  lineId,
  payeeId: `payee-${lineId}`,
  kind: "org",
  name: `Name ${lineId}`,
  percent,
  capPercent: null,
  priority: 0,
  rounding: "FLOOR",
  ticketTypeId: null,
  ...overrides,
});

/** Does a dotted key resolve to a string in the English catalog? */
function inCatalog(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

describe("parseResaleForm", () => {
  const percent = (amountText: string) =>
    parseResaleForm({ type: "PERCENT", amountText, payer: "SELLER" });
  const flat = (amountText: string) =>
    parseResaleForm({ type: "FLAT", amountText, payer: "BUYER" });

  it.each([
    ["10", 1000],
    ["0", 0],
    ["7.5", 750],
    ["0.25", 25],
    [" 5 ", 500],
    ["7,5", 750],
    ["0,25", 25],
  ])("a percentage %j is %i basis points", (text, bps) => {
    expect(percent(text)).toEqual({
      ok: true,
      clause: { type: "PERCENT", bps, payer: "SELLER" },
    });
  });

  it("refuses more than 10%, at the boundary", () => {
    expect(percent("10.01")).toEqual({ ok: false, error: "overLimit" });
    expect(percent("11")).toEqual({ ok: false, error: "overLimit" });
  });

  it.each(["", "abc", "-1", "5%", "1.234", "1e1"])(
    "refuses %j as a percentage",
    (text) => {
      expect(percent(text)).toEqual({ ok: false, error: "percentInvalid" });
    },
  );

  it("a flat amount is dollars above zero, kept with its payer", () => {
    expect(flat("2.50")).toEqual({
      ok: true,
      clause: { type: "FLAT", cents: 250, payer: "BUYER" },
    });
    expect(flat("8")).toMatchObject({ ok: true, clause: { cents: 800 } });
    expect(flat("0")).toEqual({ ok: false, error: "flatInvalid" });
    expect(flat("")).toEqual({ ok: false, error: "flatInvalid" });
    expect(flat("-2")).toEqual({ ok: false, error: "flatInvalid" });
  });
});

describe("formOfClause and sameResaleClause", () => {
  it("not set starts as a blank percentage the seller pays", () => {
    expect(formOfClause(null)).toEqual({
      type: "PERCENT",
      amountText: "",
      payer: "SELLER",
    });
  });

  it("round-trips a stored clause through the form", () => {
    for (const view of [
      { type: "PERCENT" as const, bps: 750, cents: null, payer: "BUYER" as const },
      { type: "FLAT" as const, bps: null, cents: 250, payer: "SELLER" as const },
      { type: "FLAT" as const, bps: null, cents: 800, payer: "SELLER" as const },
    ]) {
      const parsed = parseResaleForm(formOfClause(view));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(sameResaleClause(view, parsed.clause)).toBe(true);
    }
  });

  it("the payer alone is a change; not set equals only not set", () => {
    const view = { type: "PERCENT" as const, bps: 1000, cents: null, payer: "SELLER" as const };
    expect(sameResaleClause(view, { type: "PERCENT", bps: 1000, payer: "BUYER" })).toBe(false);
    expect(sameResaleClause(null, null)).toBe(true);
    expect(sameResaleClause(view, null)).toBe(false);
    expect(sameResaleClause(null, { type: "PERCENT", bps: 0, payer: "SELLER" })).toBe(false);
  });
});

describe("resaleExample (spec acceptance numbers)", () => {
  it("10% SELLER on a $50 resale: buyer pays $50, seller gets $45, $5 split 60/40", () => {
    const ex = resaleExample({ type: "PERCENT", bps: 1000, payer: "SELLER" }, [
      recipient("a", 60),
      recipient("b", 40),
    ]);
    expect(ex).toMatchObject({
      originalCents: 4000,
      askCents: 5000,
      buyerPaysCents: 5000,
      sellerReceivesCents: 4500,
      shareCents: 500,
      held: false,
    });
    expect(ex.parts).toEqual([
      { lineId: "a", name: "Name a", cents: 300 },
      { lineId: "b", name: "Name b", cents: 200 },
    ]);
  });

  it("BUYER payer: the buyer pays the ask plus the share, the seller gets the ask", () => {
    expect(
      resaleExample({ type: "PERCENT", bps: 1000, payer: "BUYER" }, null),
    ).toMatchObject({ buyerPaysCents: 5500, sellerReceivesCents: 5000, shareCents: 500 });
  });

  it("a flat $8 on a $50 resale is held to $5 (the 10% limit)", () => {
    expect(
      resaleExample({ type: "FLAT", cents: 800, payer: "SELLER" }, null),
    ).toMatchObject({ shareCents: 500, held: true, sellerReceivesCents: 4500 });
  });

  it("parts are left out when a line is limited to one ticket type, or nobody receives it yet", () => {
    const clause = { type: "PERCENT" as const, bps: 1000, payer: "SELLER" as const };
    expect(
      resaleExample(clause, [recipient("a", 100, { ticketTypeId: "tt-1" })]).parts,
    ).toBeNull();
    expect(resaleExample(clause, []).parts).toBeNull();
  });

  it("the parts add up to the share, rounding included", () => {
    const ex = resaleExample({ type: "PERCENT", bps: 333, payer: "SELLER" }, [
      recipient("a", 33),
      recipient("b", 33),
      recipient("c", 34),
    ]);
    expect(ex.parts!.reduce((sum, p) => sum + p.cents, 0)).toBe(ex.shareCents);
  });
});

describe("recipientPortions: what each line is really paid of the share", () => {
  it("a lone 0% line gets all of it (the remainder goes round the lines)", () => {
    expect(recipientPortions([recipient("a", 0)])).toEqual(new Map([["a", "all"]]));
  });

  it("60/40 lines are 60% and 40% of the share", () => {
    expect(recipientPortions([recipient("a", 60), recipient("b", 40)])).toEqual(
      new Map([
        ["a", 60],
        ["b", 40],
      ]),
    );
  });

  it("what the percentages leave over is shared equally, as finalize does", () => {
    // 30 + 10 leaves 60, handed round both lines a cent at a time.
    expect(recipientPortions([recipient("a", 30), recipient("b", 10)])).toEqual(
      new Map([
        ["a", 60],
        ["b", 40],
      ]),
    );
  });

  it("a capped line keeps to its cap; the rest goes to the others", () => {
    expect(
      recipientPortions([
        recipient("a", 50, { capPercent: 20 }),
        recipient("b", 0),
      ]),
    ).toEqual(
      new Map([
        ["a", 20],
        ["b", 80],
      ]),
    );
  });

  it("one payee on two lines: each line keeps its own part (zipped in the split's order)", () => {
    // computeOrderSplits sorts by priority, then payee; matching back by
    // payee alone would hand both parts to whichever line came first.
    const portions = recipientPortions([
      recipient("low", 25, { payeeId: "same", priority: 0 }),
      recipient("high", 75, { payeeId: "same", priority: 5 }),
    ]);
    expect(portions).toEqual(
      new Map([
        ["high", 75],
        ["low", 25],
      ]),
    );
  });

  it("unknown when a line is limited to one ticket type, or nobody receives it", () => {
    expect(recipientPortions([recipient("a", 100, { ticketTypeId: "tt" })])).toBeNull();
    expect(recipientPortions([])).toBeNull();
    expect(recipientPortions(null)).toBeNull();
  });
});

describe("the copy exists for every key the block can show", () => {
  it("not-editable reasons", () => {
    for (const key of Object.values(RESALE_NOT_EDITABLE_KEYS)) {
      expect(inCatalog(key), key).toBe(true);
    }
  });

  it("sentences and field errors", () => {
    for (const clause of [
      { type: "PERCENT" as const, bps: 500, payer: "SELLER" as const },
      { type: "FLAT" as const, cents: 300, payer: "BUYER" as const },
    ]) {
      const s = resaleSentenceOf(clause);
      expect(inCatalog(s.mainKey), s.mainKey).toBe(true);
      expect(inCatalog(s.payerKey), s.payerKey).toBe(true);
    }
    for (const k of ["portionAll", "portionVaries", "percentOfShare", "tag"]) {
      expect(inCatalog(`deals.resale.${k}`), k).toBe(true);
    }
    for (const e of ["percentInvalid", "overLimit", "flatInvalid"]) {
      expect(inCatalog(`deals.resale.errors.${e}`), e).toBe(true);
    }
  });
});

describe("classifyResaleWriteError: every setResaleClause refusal has copy", () => {
  const appError = (appCode: string, meta?: Record<string, unknown>) => ({
    message: appCode,
    data: { appCode, ...(meta ? { meta } : {}) },
  });
  const conflict = (message: string) => ({
    message,
    data: { appCode: "CONFLICT" },
  });

  it.each([
    "resale_clause_changed",
    "deal_terms_changed",
    "deal_event_owner_changed",
  ])("a %s conflict reloads", (message) => {
    expect(classifyResaleWriteError(conflict(message))).toEqual({
      kind: "CONFLICT",
      key: "deals.resale.errors.changed",
    });
  });

  it.each([
    [appError("AGREEMENT_NOT_EDITABLE", { reason: "event_resale_owned_by_booking", agreementId: "x" }), "deals.resale.notEditable.ownedByBooking"],
    [appError("AGREEMENT_NOT_EDITABLE", { reason: "agreement_has_no_event_yet" }), "deals.resale.notEditable.noEventYet"],
    [appError("AGREEMENT_NOT_EDITABLE", { reason: "event_terms_shared" }), "deals.resale.notEditable.termsShared"],
    [appError("AGREEMENT_NOT_EDITABLE", { reason: "default_terms_shared" }), "deals.resale.notEditable.termsShared"],
    [appError("AGREEMENT_NOT_EDITABLE", { reason: "terms_archived" }), "deals.resale.notEditable.termsLocked"],
    [appError("AGREEMENT_NOT_EDITABLE", { reason: "not_resale_terms" }), "deals.resale.notEditable.termsLocked"],
    [appError("AGREEMENT_NOT_EDITABLE"), "deals.resale.notEditable.termsLocked"],
    [appError("AGREEMENT_MISSING_LINES", { reason: "resale_lines_missing" }), "deals.resale.errors.missingLines"],
    [appError("AGREEMENT_MISSING_LINES", { reason: "resale_terms_missing" }), "deals.resale.errors.missingLines"],
    [appError("RESALE_SHARE_IN_USE", { reason: "resale_on_for_ticket_types" }), "deals.resale.errors.inUse"],
    [appError("INSUFFICIENT_ROLE"), "deals.resale.notEditable.notPayoutEditor"],
    [appError("EVENT_ARCHIVED"), "deals.resale.notEditable.eventArchived"],
    [appError("EVENT_CANCELLED"), "deals.resale.notEditable.eventCancelled"],
    [appError("ORGANIZATION_INACTIVE"), "deals.notEditable.orgInactive"],
    [appError("AGREEMENT_NOT_DRAFT"), "deals.resale.notEditable.bookingNotEditable"],
    [appError("TERMS_EDITOR_ONLY"), "deals.resale.notEditable.bookingNotEditable"],
    [appError("NOT_AGREEMENT_PARTY"), "deals.resale.notEditable.bookingNotEditable"],
    [appError("INVALID_INPUT"), "deals.resale.errors.invalid"],
  ])("%j → %s", (error, key) => {
    const out = classifyResaleWriteError(error);
    expect(out).toEqual({ kind: "KNOWN", key });
    expect(inCatalog(key), key).toBe(true);
  });

  it("terms gone under the form reload like a conflict", () => {
    expect(classifyResaleWriteError(appError("PAYOUT_TERMS_NOT_FOUND"))).toEqual({
      kind: "CONFLICT",
      key: "deals.resale.errors.changed",
    });
  });

  it("anything else falls to the generic message", () => {
    expect(classifyResaleWriteError(appError("EVENT_NOT_FOUND"))).toEqual({ kind: "OTHER" });
  });

  it("a read the viewer may not make hides the block; anything else is an error", () => {
    expect(classifyResaleReadError(appError("INSUFFICIENT_ROLE"))).toBe("NOT_ALLOWED");
    expect(classifyResaleReadError(appError("NOT_AGREEMENT_PARTY"))).toBe("NOT_ALLOWED");
    expect(classifyResaleReadError(appError("EVENT_NOT_FOUND"))).toBe("ERROR");
  });
});
