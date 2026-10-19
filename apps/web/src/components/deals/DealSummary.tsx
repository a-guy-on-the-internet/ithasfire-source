"use client";

import { useId, type ReactNode } from "react";

import { trpc } from "@/trpc";

import { classifyDealReadError } from "./deal-errors";
import {
  clauseInputOf,
  hasNoMoneyTerms,
  nameOfPayeeId,
  refOfPayeeId,
  visibleClauses,
  type DealTarget,
} from "./deal-model";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

/**
 * The deal in plain words, read-only (board B07: "what's sent … the deal, in
 * plain words"). For surfaces that only REFER to the terms, like the booking
 * thread's terms strip: it never edits, and it shares `deals.getTermsDeal`'s
 * cache with the editor on the agreement page. A deal it cannot read (a
 * refusal, a failed read) draws nothing: the strip's own link still leads to
 * the agreement, where the full deal and its errors live.
 */
export function DealSummary({
  target,
  label,
  testIdBase,
}: {
  target: DealTarget;
  /** Drawn above the summary, and only when there is a summary to draw. */
  label?: ReactNode;
  testIdBase: string;
}) {
  const { t, clauseWords, money } = useDealWords();
  const read = trpc.deals.getTermsDeal.useQuery(
    { target },
    { retry: false, meta: { silent: true } },
  );
  const testId = `${testIdBase}-deal-summary`;
  const labelId = useId();

  if (read.isLoading) return null;
  if (read.error || !read.data) {
    const outcome = classifyDealReadError(read.error);
    if (outcome.kind !== "NO_TERMS") return null;
    return (
      <>
        {label}
        <p
          className={`${styles.summaryLine} ${styles.summaryMuted}`}
          data-testid={testId}
        >
          {t("deals.noTerms.title")}
        </p>
      </>
    );
  }

  const deal = read.data;
  const unnamed = t("deals.unnamed");
  const nameOf = (payeeId: string) =>
    nameOfPayeeId(deal.payees, [], payeeId, unnamed);

  if (hasNoMoneyTerms(deal)) {
    return (
      <>
        {label}
        <p
          className={`${styles.summaryLine} ${styles.summaryMuted}`}
          data-testid={testId}
        >
          {t("deals.summary.none")}
        </p>
      </>
    );
  }

  const costs = deal.deductions.map((d) => {
    const amount =
      d.percent !== null && d.percent !== undefined
        ? t("deals.costPercent", { percent: d.percent })
        : money(d.amountCents ?? 0);
    return t(
      d.estimated ? "deals.summary.costEstimated" : "deals.summary.cost",
      {
        label: d.label,
        amount,
      },
    );
  });

  return (
    <>
      {label ? <div id={labelId}>{label}</div> : null}
      <ul
        className={styles.summary}
        aria-labelledby={label ? labelId : undefined}
        data-testid={testId}
      >
        {visibleClauses(deal).map((c) => {
          const ref = refOfPayeeId(deal.payees, c.payeeId);
          if (!ref) return null;
          const words = clauseWords(clauseInputOf(c, ref));
          return (
            <li key={c.id} className={styles.summaryLine}>
              <span className={styles.summaryName}>{nameOf(c.payeeId)}</span>{" "}
              {words.main}
              {words.tail ?? ""}
            </li>
          );
        })}
        {deal.remainder ? (
          <li className={styles.summaryLine}>
            <span className={styles.summaryName}>
              {nameOf(deal.remainder.payeeId)}
            </span>{" "}
            {t("deals.summary.rest")}
          </li>
        ) : null}
        {costs.length > 0 ? (
          <li className={`${styles.summaryLine} ${styles.summaryMuted}`}>
            {t("deals.summary.offTheTop", {
              list: costs.join(t("deals.listJoin")),
            })}
          </li>
        ) : null}
      </ul>
    </>
  );
}
