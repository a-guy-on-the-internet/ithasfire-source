import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The live promo preview must discount a pay-what-you-want line at the
 * buyer's amount. It used to send only `{ticketTypeId, qty}`, so the server
 * priced the line at the tier's stored $0 and every promo previewed as $0 off.
 */

const { previewInputs, previewOptions, previewResult } = vi.hoisted(() => ({
  previewInputs: [] as Array<{
    ticketSelections: Array<Record<string, unknown>>;
  }>,
  previewOptions: [] as Array<{
    enabled?: boolean;
    meta?: Record<string, unknown>;
    placeholderData?: unknown;
  }>,
  previewResult: {
    current: { data: undefined, isError: false, error: null } as {
      data: unknown;
      isError: boolean;
      error: { message: string; data?: { meta?: unknown } } | null;
      isPlaceholderData?: boolean;
    },
  },
}));

const { toastWarning } = vi.hoisted(() => ({ toastWarning: vi.fn() }));

vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: { warning: toastWarning, danger: vi.fn() } }),
  // Echo the key, so assertions can tell catalog copy from a literal.
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/trpc", () => ({
  trpc: {
    promos: {
      preview: {
        useQuery: (
          input: (typeof previewInputs)[number],
          options: (typeof previewOptions)[number],
        ) => {
          previewInputs.push(input);
          previewOptions.push(options);
          return previewResult.current;
        },
      },
    },
  },
}));

import {
  isPromoRejectionError,
  useCheckoutPromoPreview,
} from "./useCheckoutPromoPreview";

describe("useCheckoutPromoPreview — PWYW lines", () => {
  it("regression: sends the chosen amount as donationAmountCents", () => {
    previewInputs.length = 0;
    renderHook(() =>
      useCheckoutPromoPreview({
        eventId: "11111111-1111-4111-8111-111111111111",
        initialUrlPromoCodes: [],
        quantities: { "tt-pwyw": 2, "tt-fixed": 1, "tt-none": 0 },
        donationAmounts: { "tt-pwyw": 3000 },
        promoCodes: ["HALF"],
        isSignedIn: false,
        pendingOrderId: null,
        onApplyPromoCode: () => null,
        onRemovePromoCode: () => {},
      }),
    );
    const live = previewInputs.at(-1)!;
    expect(live.ticketSelections).toEqual([
      { ticketTypeId: "tt-pwyw", qty: 2, donationAmountCents: 3000 },
      { ticketTypeId: "tt-fixed", qty: 1 },
    ]);
  });
});

type PreviewError = { message: string; data?: { meta?: unknown } };

/** Render the hook against a preview result; returns its spies and result. */
const renderPreview = ({
  error = null,
  paused = false,
  promoCodes = ["EARLYBIRD", "STUDENT"],
  donationAmounts = { "tt-pwyw": 1500 } as Record<string, number>,
}: {
  error?: PreviewError | null;
  paused?: boolean;
  promoCodes?: string[];
  donationAmounts?: Record<string, number>;
}) => {
  previewOptions.length = 0;
  previewResult.current = { data: undefined, isError: error !== null, error };
  const onRemovePromoCode = vi.fn();
  const hook = renderHook(() =>
    useCheckoutPromoPreview({
      eventId: "11111111-1111-4111-8111-111111111111",
      initialUrlPromoCodes: [],
      quantities: { "tt-pwyw": 1 },
      donationAmounts,
      paused,
      promoCodes,
      isSignedIn: false,
      pendingOrderId: null,
      onApplyPromoCode: () => null,
      onRemovePromoCode,
    }),
  );
  previewResult.current = { data: undefined, isError: false, error: null };
  return { onRemovePromoCode, result: hook.result };
};

const named = (message: string, promoCode: string): PreviewError => ({
  message,
  data: { meta: { promoCode } },
});

describe("useCheckoutPromoPreview — what prunes a code", () => {
  it("a validation error (over-cap PWYW amount) prunes nothing", () => {
    expect(
      renderPreview({ error: { message: "invalid_input" } }).onRemovePromoCode,
    ).not.toHaveBeenCalled();
    expect(
      renderPreview({
        error: {
          message:
            '[{"code":"too_big","path":["ticketSelections",0,"donationAmountCents"]}]',
        },
      }).onRemovePromoCode,
    ).not.toHaveBeenCalled();
  });

  it("an unknown / used-up code prunes the code the server NAMES (even the older one)", () => {
    const { onRemovePromoCode } = renderPreview({
      promoCodes: ["earlybird", "STUDENT"],
      error: named("promo_max_redeemed", "EARLYBIRD"),
    });
    expect(onRemovePromoCode).toHaveBeenCalledTimes(1);
    expect(onRemovePromoCode).toHaveBeenCalledWith("earlybird");
  });

  it("no named code, or one not in the cart → the newest", () => {
    expect(
      renderPreview({ error: { message: "promo_not_found" } }).onRemovePromoCode,
    ).toHaveBeenCalledWith("STUDENT");
    expect(
      renderPreview({ error: named("promo_not_found", "ELSEWHERE") })
        .onRemovePromoCode,
    ).toHaveBeenCalledWith("STUDENT");
  });
});

describe("useCheckoutPromoPreview — a stacking conflict evicts the code just added", () => {
  it("regression: non-stackable SOLO held first, STUDENT added → STUDENT goes, SOLO stays", () => {
    // The server names the stored non-stackable code (SOLO) — the older,
    // bigger discount. Removing it would punish the buyer for trying to add.
    const { onRemovePromoCode } = renderPreview({
      promoCodes: ["SOLO", "STUDENT"],
      error: named("promo_not_stackable", "SOLO"),
    });
    expect(onRemovePromoCode).toHaveBeenCalledTimes(1);
    expect(onRemovePromoCode).toHaveBeenCalledWith("STUDENT");
  });

  it("…and the other order: STUDENT held, non-stackable SOLO added → SOLO goes", () => {
    const { onRemovePromoCode } = renderPreview({
      promoCodes: ["STUDENT", "SOLO"],
      error: named("promo_not_stackable", "SOLO"),
    });
    expect(onRemovePromoCode).toHaveBeenCalledWith("SOLO");
  });
});

describe("useCheckoutPromoPreview — eligibility rejections KEEP the code", () => {
  it("regression: minimum order not met → kept, reason shown beside it, $0 discount", () => {
    const { onRemovePromoCode, result } = renderPreview({
      error: named("promo_min_order_not_met", "EARLYBIRD"),
    });
    expect(onRemovePromoCode).not.toHaveBeenCalled();
    expect(result.current.promoCodeRejections).toEqual({
      EARLYBIRD: "errors.promoMinOrderNotMet",
    });
    expect(result.current.livePromoDiscountCents).toBe(0);
  });

  it("regression: clearing a $0-floor PWYW field (amount 0) → not applicable → NOTHING is pruned", () => {
    const { onRemovePromoCode, result } = renderPreview({
      donationAmounts: { "tt-pwyw": 0 },
      error: named("promo_not_applicable", "STUDENT"),
    });
    expect(onRemovePromoCode).not.toHaveBeenCalled();
    expect(result.current.promoCodeRejections).toEqual({
      STUDENT: "errors.promoNotApplicable",
    });
  });

  it("no rejection → no reasons shown", () => {
    expect(renderPreview({}).result.current.promoCodeRejections).toEqual({});
  });
});

describe("useCheckoutPromoPreview — a paused preview", () => {
  it("$0 floor + two codes + over-cap amount → prunes NOTHING, whatever the error", () => {
    for (const message of [
      "promo_not_applicable",
      "promo_min_order_not_met",
      "promo_not_found",
    ]) {
      expect(
        renderPreview({ paused: true, donationAmounts: {}, error: { message } })
          .onRemovePromoCode,
      ).not.toHaveBeenCalled();
    }
  });

  it("does not run the live preview while paused", () => {
    renderPreview({ paused: true });
    expect(previewOptions.at(-1)?.enabled).toBe(false);
    renderPreview({ paused: false });
    expect(previewOptions.at(-1)?.enabled).toBe(true);
  });
});

describe("useCheckoutPromoPreview — a re-added code can be pruned again", () => {
  it("regression: pruned, re-applied, rejected again → pruned again", () => {
    const onRemovePromoCode = vi.fn();
    const error = named("promo_not_found", "STUDENT");
    const { rerender } = renderHook(
      ({ codes, err }: { codes: string[]; err: PreviewError | null }) => {
        previewResult.current = {
          data: undefined,
          isError: err !== null,
          error: err,
        };
        return useCheckoutPromoPreview({
          eventId: "11111111-1111-4111-8111-111111111111",
          initialUrlPromoCodes: [],
          quantities: { "tt-pwyw": 1 },
          donationAmounts: { "tt-pwyw": 1500 },
          promoCodes: codes,
          isSignedIn: false,
          pendingOrderId: null,
          onApplyPromoCode: () => null,
          onRemovePromoCode,
        });
      },
      {
        initialProps: {
          codes: ["EARLYBIRD", "STUDENT"],
          err: error as PreviewError | null,
        },
      },
    );
    expect(onRemovePromoCode).toHaveBeenCalledTimes(1);

    // Pruned: the cart now holds only EARLYBIRD, and the preview succeeds.
    rerender({ codes: ["EARLYBIRD"], err: null });
    // The buyer applies STUDENT again, and it is rejected again.
    rerender({ codes: ["EARLYBIRD", "STUDENT"], err: error });
    expect(onRemovePromoCode).toHaveBeenCalledTimes(2);
    expect(onRemovePromoCode).toHaveBeenLastCalledWith("STUDENT");
    previewResult.current = { data: undefined, isError: false, error: null };
  });
});

describe("useCheckoutPromoPreview — hard prunes are announced; a lone bad code explains itself", () => {
  it("a pruned code raises a toast naming it, with the existing promo copy", () => {
    toastWarning.mockClear();
    const { onRemovePromoCode } = renderPreview({
      error: named("promo_not_found", "STUDENT"),
    });
    expect(onRemovePromoCode).toHaveBeenCalledWith("STUDENT");
    expect(toastWarning).toHaveBeenCalledWith("STUDENT: errors.promoNotFound", {
      title: "checkout.promoCodeRemovedTitle",
    });
  });

  it.each([
    ["promo_not_found", "errors.promoNotFound"],
    ["promo_max_redeemed", "errors.promoMaxRedeemed"],
    ["promo_redeemed_by_human", "errors.promoRedeemedByHuman"],
  ])(
    "regression: a LONE code rejected as %s stays, with its reason shown",
    (message, key) => {
      toastWarning.mockClear();
      const { onRemovePromoCode, result } = renderPreview({
        promoCodes: ["TYPO"],
        error: named(message, "TYPO"),
      });
      expect(onRemovePromoCode).not.toHaveBeenCalled();
      expect(toastWarning).not.toHaveBeenCalled();
      expect(result.current.promoCodeRejections).toEqual({ TYPO: key });
    },
  );

  it("with several codes, a pruned code is removed, not listed as a kept reason", () => {
    const { result } = renderPreview({
      error: named("promo_max_redeemed", "EARLYBIRD"),
    });
    expect(result.current.promoCodeRejections).toEqual({});
  });
});

describe("useCheckoutPromoPreview — query options", () => {
  it("regression: promo rejections are SILENT to the global logger; outages still reach Sentry, never a toast", () => {
    renderPreview({});
    // [url preview, live preview] for this render.
    const [urlOptions, liveOptions] = previewOptions.slice(-2);
    for (const options of [urlOptions, liveOptions]) {
      const meta = options?.meta as {
        silent?: boolean;
        silentWhen?: (error: unknown) => boolean;
        noToast?: boolean;
      };
      // Not the blanket `silent` — that also skipped client Sentry.
      expect(meta.silent).toBeUndefined();
      expect(meta.noToast).toBe(true);
      expect(meta.silentWhen?.({ message: "promo_min_order_not_met" })).toBe(true);
      expect(meta.silentWhen?.({ message: "promo_not_found" })).toBe(true);
      expect(meta.silentWhen?.({ message: "Internal server error" })).toBe(false);
      expect(meta.silentWhen?.(new TypeError("Failed to fetch"))).toBe(false);
    }
  });

  it("the live preview bridges ONLY the hold re-key: same cart and codes → previous result; anything else → none", () => {
    renderPreview({});
    const placeholder = previewOptions.at(-1)?.placeholderData as (
      previous: unknown,
      previousQuery: { queryKey: unknown } | undefined,
    ) => unknown;
    expect(typeof placeholder).toBe("function");
    const previous = { totalDiscountCents: 550, applications: [] };
    const keyFor = (input: Record<string, unknown>) => [
      ["promos", "preview"],
      { input, type: "query" },
    ];
    const current = previewInputs.at(-1) as {
      eventId: string;
      codes: string[];
      ticketSelections: unknown[];
    };
    // Same cart and codes (only excludeOrderId differs) → bridged.
    expect(
      placeholder(previous, {
        queryKey: keyFor({ ...current, excludeOrderId: undefined }),
      }),
    ).toBe(previous);
    // A different code list → never the old discount.
    expect(
      placeholder(previous, {
        queryKey: keyFor({ ...current, codes: [...current.codes, "OLD"] }),
      }),
    ).toBeUndefined();
    // A different cart → never the old discount.
    expect(
      placeholder(previous, {
        queryKey: keyFor({ ...current, ticketSelections: [] }),
      }),
    ).toBeUndefined();
    expect(placeholder(previous, undefined)).toBeUndefined();
  });
});

describe("useCheckoutPromoPreview — placeholder data is never read as a rejection", () => {
  const renderSoft = (isPlaceholderData: boolean) => {
    previewResult.current = {
      data: {
        totalDiscountCents: 500,
        applications: [{ normalizedCode: "EARLYBIRD", discountCents: 500 }],
      },
      isError: false,
      error: null,
      isPlaceholderData,
    };
    const onRemovePromoCode = vi.fn();
    renderHook(() =>
      useCheckoutPromoPreview({
        eventId: "11111111-1111-4111-8111-111111111111",
        initialUrlPromoCodes: [],
        quantities: { "tt-pwyw": 1 },
        donationAmounts: { "tt-pwyw": 1500 },
        promoCodes: ["EARLYBIRD", "STUDENT"],
        isSignedIn: false,
        pendingOrderId: null,
        onApplyPromoCode: () => null,
        onRemovePromoCode,
      }),
    );
    previewResult.current = { data: undefined, isError: false, error: null };
    return onRemovePromoCode;
  };

  it("regression: a just-added code absent from the PREVIOUS result is not pruned", () => {
    expect(renderSoft(true)).not.toHaveBeenCalled();
  });

  it("…but a real (non-placeholder) result that omits it still is", () => {
    expect(renderSoft(false)).toHaveBeenCalledWith("STUDENT");
  });
});

describe("isPromoRejectionError — own keys only", () => {
  it("claims the promo rejection codes", () => {
    expect(isPromoRejectionError(new Error("promo_not_found"))).toBe(true);
    expect(isPromoRejectionError(new Error("promo_min_order_not_met"))).toBe(true);
  });

  it("regression: an inherited Object key ('constructor', 'toString') is NOT a promo rejection — `in` said it was, silencing a real error", () => {
    expect(isPromoRejectionError(new Error("constructor"))).toBe(false);
    expect(isPromoRejectionError(new Error("toString"))).toBe(false);
    expect(isPromoRejectionError(new Error("Internal server error"))).toBe(false);
  });
});

