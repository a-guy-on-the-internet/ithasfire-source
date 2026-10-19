import { describe, expect, it } from "vitest";

import {
  draftChangeCount,
  draftClauses,
  draftDeductions,
  emptyDraft,
  withClauses,
  withDeductions,
  withRemainder,
} from "../deal-change-draft";
import type {
  DealClauseInput,
  DealDeductionInput,
  DealPayeeRef,
} from "../deal-model";

const act = { kind: "org" as const, id: "act" };
const moth = { kind: "human" as const, id: "moth" };
const place = { kind: "org" as const, id: "place" };

const clause = (id: string | undefined, payee: DealPayeeRef, percent: number): DealClauseInput => ({
  id,
  payee,
  amountType: "PERCENT",
  amountCents: null,
  percent,
  basis: "NET_POOL",
  resolution: null,
});
const cost = (id: string | undefined, cents: number): DealDeductionInput => ({
  id,
  kind: "EXPENSE",
  label: "Sound",
  amountCents: cents,
  percent: null,
  creditedPayee: place,
  estimated: false,
});

const live = [clause("c1", act, 30), clause("c2", moth, 10)];
const liveCosts = [cost("d1", 5000)];
const counts = (d: ReturnType<typeof emptyDraft>) =>
  draftChangeCount(d, { clauses: live, deductions: liveCosts, remainder: place });

describe("the frozen-change draft", () => {
  it("holds edits by id, an added line, and a removal; counts each once", () => {
    let d = emptyDraft("fp");
    d = withClauses(d, live, [clause("c1", act, 25), clause(undefined, moth, 5)]);
    // c1 edited, c2 taken off, one added.
    expect(d.clauses).toEqual({ c1: clause("c1", act, 25), c2: null });
    expect(d.addedClauses).toHaveLength(1);
    expect(counts(d)).toBe(3);
    expect(draftClauses(live, d).map((c) => [c.id, c.percent])).toEqual([
      ["c1", 25],
      [undefined, 5],
    ]);
  });

  it("an edit back to the saved value is no edit", () => {
    let d = withClauses(emptyDraft("fp"), live, [clause("c1", act, 25), live[1]!]);
    d = withClauses(d, live, [clause("c1", act, 30), live[1]!]);
    expect(d.clauses).toEqual({});
    expect(counts(d)).toBe(0);
  });

  it("someone else's change shows through every line the draft does not touch", () => {
    const d = withClauses(emptyDraft("fp"), live, [clause("c1", act, 25), live[1]!]);
    const theirs = [clause("c1", act, 30), clause("c2", moth, 12)];
    expect(draftClauses(theirs, d).map((c) => c.percent)).toEqual([25, 12]);
  });

  it("an edit to a line someone else took off is not counted", () => {
    const d = withClauses(emptyDraft("fp"), live, [clause("c1", act, 25), live[1]!]);
    expect(
      draftChangeCount(d, { clauses: [live[1]!], deductions: liveCosts, remainder: place }),
    ).toBe(0);
  });

  it("costs and the rest count as changes too", () => {
    let d = withDeductions(emptyDraft("fp"), liveCosts, [cost("d1", 6000)]);
    d = withRemainder(d, place, act);
    expect(draftDeductions(liveCosts, d)[0]!.amountCents).toBe(6000);
    expect(counts(d)).toBe(2);
    expect(withRemainder(d, place, place).remainder).toBeNull();
  });
});
