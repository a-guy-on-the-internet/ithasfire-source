"use client";

import { useCallback, useMemo } from "react";
import { Money, useTranslations } from "@th/ui";

import { clauseWordsOf, type ClauseShape } from "./deal-model";

/**
 * The deal's copy helpers: money printed by the one formatter `<Money>` uses
 * (`Money.format`), and clauses in plain words. Printing only — no amount is
 * computed here.
 */
export function useDealWords() {
  const t = useTranslations();
  const tr = useCallback(
    (key: string, values?: Record<string, string | number>) =>
      String(t(key, values)),
    [t],
  );

  /** "$800" in a sentence; "$800.50" when there are cents; "−$850" (a true minus) below zero. */
  const money = useCallback(
    (cents: number) =>
      cents < 0
        ? `\u2212${Money.format(-cents, { showCents: "auto" })}`
        : Money.format(cents, { showCents: "auto" }),
    [],
  );

  /** "+$2,135.00" / "−$2,440.00" / "$0.00": a balance, signed. */
  const signed = useCallback((cents: number) => {
    if (cents === 0) return Money.format(0);
    const text = Money.format(Math.abs(cents));
    return cents > 0 ? `+${text}` : `−${text}`;
  }, []);

  const clauseWords = useCallback(
    (c: ClauseShape) => {
      const w = clauseWordsOf(c);
      const values = {
        amount: w.amountCents === null ? "" : money(w.amountCents),
        percent: w.percent ?? 0,
      };
      return {
        main: tr(w.mainKey, values),
        tail: w.tailKey ? tr(w.tailKey) : null,
      };
    },
    [money, tr],
  );

  return useMemo(
    () => ({ t: tr, money, signed, clauseWords }),
    [tr, money, signed, clauseWords],
  );
}
