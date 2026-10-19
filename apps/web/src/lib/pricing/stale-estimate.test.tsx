import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { getListedBuyerAllInDisplayCents } from "./buyer-display";
import { withBuyerUnitTotals } from "./order-estimate";
import {
  getListedAllInDisplayCents,
  isListedEstimateStale,
  staleEstimateKey,
  type ListedEstimateTicket,
} from "./stale-estimate";
import { useRefetchStaleEstimates } from "./useRefetchStaleEstimates";
import { serverRowAt } from "./__fixtures__/pwyw-floor";

const GA = { id: "tt-ga", priceCents: 3000 };
const PWYW = {
  id: "tt-pwyw",
  priceCents: 0,
  pricingMode: "ADJUSTABLE" as const,
  minimumCents: 500,
  suggestedCents: 1500,
};
const ROWS = [serverRowAt("tt-ga", 3000), serverRowAt("tt-pwyw", 500)];

describe("isListedEstimateStale — the row's face against the tier's", () => {
  it("fresh rows: a fixed tier at its price, a PWYW tier at its floor", () => {
    const [ga, pwyw] = withBuyerUnitTotals([GA, PWYW], ROWS);
    expect(isListedEstimateStale(ga!)).toBe(false);
    expect(isListedEstimateStale(pwyw!)).toBe(false);
  });

  it("a repriced tier or a moved minimum is stale", () => {
    const [ga, pwyw] = withBuyerUnitTotals(
      [{ ...GA, priceCents: 3500 }, { ...PWYW, minimumCents: 700 }],
      ROWS,
    );
    expect(isListedEstimateStale(ga!)).toBe(true);
    expect(isListedEstimateStale(pwyw!)).toBe(true);
  });

  it("no row at all is not stale (just not loaded)", () => {
    const [ga] = withBuyerUnitTotals([GA], undefined);
    expect(isListedEstimateStale(ga!)).toBe(false);
  });
});

describe("the $0 face is guarded too", () => {
  it("a cached 'Free' beside a row priced at $20 after a flip is unknown, not Free", () => {
    expect(
      getListedBuyerAllInDisplayCents({
        priceCents: 0,
        buyerUnitTotalCents: 2300,
        buyerUnitPriceCents: 2000,
      }),
    ).toBeNull();
  });

  it("a genuinely free tier with a $0 row stays Free", () => {
    expect(
      getListedBuyerAllInDisplayCents({
        priceCents: 0,
        buyerUnitTotalCents: 0,
        buyerUnitPriceCents: 0,
      }),
    ).toBe(0);
  });
});

describe("getListedAllInDisplayCents — one guarded figure for any tier (the seat map's)", () => {
  it("a PWYW tier quotes its floor all-in, a fixed tier its price all-in", () => {
    const [ga, pwyw] = withBuyerUnitTotals([GA, PWYW], ROWS);
    expect(getListedAllInDisplayCents(pwyw!)).toBe(609);
    expect(getListedAllInDisplayCents(ga!)).toBe(ROWS[0]!.buyerUnitTotalCents);
  });

  it("stale rows read unknown on both", () => {
    const [ga, pwyw] = withBuyerUnitTotals(
      [{ ...GA, priceCents: 3500 }, { ...PWYW, minimumCents: 700 }],
      ROWS,
    );
    expect(getListedAllInDisplayCents(pwyw!)).toBeNull();
    expect(getListedAllInDisplayCents(ga!)).toBeNull();
  });
});

describe("useRefetchStaleEstimates — refetch once per mismatch, never loop", () => {
  const listed = (tickets: ListedEstimateTicket[]) =>
    withBuyerUnitTotals(tickets, ROWS);

  it("fresh rows: no refetch", () => {
    const refetch = vi.fn();
    renderHook(() => useRefetchStaleEstimates(listed([GA, PWYW]), refetch));
    expect(refetch).not.toHaveBeenCalled();
  });

  it("a stale row refetches once; re-renders with the same mismatch do not refetch again", () => {
    const refetch = vi.fn();
    const stale = [{ ...PWYW, minimumCents: 700 }];
    const { rerender } = renderHook(
      ({ tickets }) => useRefetchStaleEstimates(listed(tickets), refetch),
      { initialProps: { tickets: stale } },
    );
    expect(refetch).toHaveBeenCalledTimes(1);
    // The refetch came back with the SAME row (the ticket list is the stale
    // side): same key, no second refetch.
    rerender({ tickets: [...stale] });
    rerender({ tickets: [...stale] });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a different mismatch gets its own single refetch", () => {
    const refetch = vi.fn();
    const { rerender } = renderHook(
      ({ tickets }) => useRefetchStaleEstimates(listed(tickets), refetch),
      { initialProps: { tickets: [{ ...PWYW, minimumCents: 700 }] } },
    );
    rerender({ tickets: [{ ...PWYW, minimumCents: 900 }] });
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("a mismatch that clears and then recurs refetches again", () => {
    const refetch = vi.fn();
    const stale = [{ ...PWYW, minimumCents: 700 }];
    const { rerender } = renderHook(
      ({ tickets }) => useRefetchStaleEstimates(listed(tickets), refetch),
      { initialProps: { tickets: stale } },
    );
    expect(refetch).toHaveBeenCalledTimes(1);
    rerender({ tickets: [PWYW] }); // fresh again: key goes back to ""
    expect(refetch).toHaveBeenCalledTimes(1);
    rerender({ tickets: stale }); // the identical mismatch recurs
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("the key names the tier and both faces, and is order-independent", () => {
    const a = listed([{ ...GA, priceCents: 3500 }, { ...PWYW, minimumCents: 700 }]);
    const b = listed([{ ...PWYW, minimumCents: 700 }, { ...GA, priceCents: 3500 }]);
    expect(staleEstimateKey(a)).toBe(staleEstimateKey(b));
    expect(staleEstimateKey(a)).toContain("tt-pwyw:700:500");
    expect(staleEstimateKey(listed([GA]))).toBe("");
  });
});
