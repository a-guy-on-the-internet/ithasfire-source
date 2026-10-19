"use client";

import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Button, Money, Spinner } from "@th/ui";
import { AlertTriangle } from "lucide-react";

import { centsToDollarsInput } from "@/lib/booking-agreements";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";
import { trpc } from "@/trpc";

import {
  needsTiersReasonOf,
  settleSummaryOf,
  tiersFromDrafts,
  type DealProjected,
  type DealProjection,
  type DealTarget,
  type NeedsTiersReason,
  type TierDraft,
} from "./deal-model";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

type FullResult = Extract<
  DealProjected["projection"],
  { visibility: "FULL" }
>["result"];
type ClauseResult = FullResult["clauses"][number];
type How = ClauseResult["how"];

const parsePrice = (raw: string): number | null => {
  const r = parseMoneyInputToCents(raw);
  return r.ok ? r.cents : null;
};

/** How long typing settles before the calculator asks the server again. */
const DEBOUNCE_MS = 400;

/**
 * The calculator (FR-003d): "if we sell N tickets at $P", who gets what, the
 * way from ticket money to the pool, and per payee what Ithas Fire pays as
 * tickets sell and what is settled directly. Every figure is the server's
 * projection (`deals.projectTermsDeal`); this component only prints it and
 * asks again, debounced, when the inputs change.
 */
export function DealCalculator({
  target,
  nameOf,
  restLineIds,
  testIdBase,
}: {
  target: DealTarget;
  /**
   * The rest holder's derived per-order line(s). Its numbers are a cap the
   * server applies, not a share anyone agreed, so the table folds it into
   * "rest of the pool" instead of describing it as 100% of ticket money.
   */
  restLineIds: ReadonlySet<string>;
  /** Payee id → display name (from the deal read and the projection). */
  nameOf: (
    payeeId: string,
    projectionPayees?: DealProjection["payees"],
  ) => string;
  testIdBase: string;
}) {
  const { t, money, signed } = useDealWords();
  const testId = `${testIdBase}-calc`;
  const headingId = useId();

  // null = "from the event's ticket types" (the server's default); typed rows
  // otherwise. An org default has no event, so it starts typed.
  const [drafts, setDrafts] = useState<TierDraft[] | null>(
    target.kind === "ORG_DEFAULT" ? [{ tickets: "", price: "" }] : null,
  );
  // Set once the server says there are no ticket types to start from (no
  // event yet, or none ACTIVE): the calculator then asks for numbers, says
  // why, and offers no way back to the event's types.
  const [needsTiers, setNeedsTiers] = useState<NeedsTiersReason | null>(null);
  const typedTiers = useMemo(
    () => (drafts ? tiersFromDrafts(drafts, parsePrice) : null),
    [drafts],
  );
  const [tiers, setTiers] = useState(typedTiers);
  useEffect(() => {
    const handle = setTimeout(() => setTiers(typedTiers), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [typedTiers]);

  const query = trpc.deals.projectTermsDeal.useQuery(
    { target, ...(drafts && tiers ? { tiers } : {}) },
    {
      enabled: drafts === null || tiers !== null,
      placeholderData: keepPreviousData,
      retry: false,
      meta: { silent: true },
    },
  );

  // No event (or no ticket types yet): the default can't run; ask for numbers.
  const answeredNeedsTiers =
    drafts === null ? needsTiersReasonOf(query.data) : null;
  useEffect(() => {
    if (answeredNeedsTiers) {
      setNeedsTiers(answeredNeedsTiers);
      setDrafts([{ tickets: "", price: "" }]);
    }
  }, [answeredNeedsTiers]);

  // Only a projection that ran has figures to print (a kept-previous
  // "needs tiers" answer has none).
  const data: DealProjected | undefined =
    query.data && !query.data.needsTiers ? query.data : undefined;
  const shownRows: TierDraft[] =
    drafts ??
    (data?.tiers ?? []).map((tier) => ({
      tickets: String(tier.tickets),
      price: centsToDollarsInput(tier.unitBasisCents),
    }));

  const editRow = (index: number, patch: Partial<TierDraft>) => {
    const base = drafts ?? shownRows;
    setDrafts(base.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const fromEvent =
    drafts === null && data?.tiersSource === "EVENT_TICKET_TYPES";
  const typedButBlank = drafts !== null && typedTiers === null;
  const name = (payeeId: string) => nameOf(payeeId, data?.payees);

  return (
    <section
      className={styles.calc}
      aria-labelledby={headingId}
      aria-busy={query.isFetching}
      data-testid={testId}
    >
      <div className={`${styles.sectionHead} ${styles.sectionHeadFlush}`}>
        <h4 id={headingId} className={styles.sectionTitle}>
          {t("deals.calculator")}
        </h4>
        <span className={styles.calcSource}>
          {/* Working: a small spinner, never a fade (faded muted text drops under 4.5:1). */}
          {query.isFetching && data ? <Spinner size="sm" /> : null}
          <span className={styles.hint}>
            {fromEvent
              ? t("deals.calcFromEvent")
              : drafts !== null
                ? t("deals.calcTyped")
                : ""}
          </span>
        </span>
      </div>

      {shownRows.map((row, i) => (
        <TierRow
          key={i}
          row={row}
          index={i}
          numbered={shownRows.length > 1}
          testId={testId}
          onChange={(patch) => editRow(i, patch)}
        />
      ))}

      {drafts !== null &&
      target.kind !== "ORG_DEFAULT" &&
      needsTiers === null &&
      data?.tiersSource === "INPUT" ? (
        <div>
          <Button
            variant="ghost"
            size="$2"
            onPress={() => setDrafts(null)}
            testID={`${testId}-reset`}
          >
            {t("deals.calcReset")}
          </Button>
        </div>
      ) : null}

      {query.error && !data ? (
        <p className={`${styles.blockBody} ${styles.dangerText}`} role="status">
          {t("deals.calcFailed")}
        </p>
      ) : null}

      {!data ? (
        typedButBlank ? (
          <p className={styles.hint} data-testid={`${testId}-prompt`}>
            {needsTiers
              ? t(`deals.calcNeedsTiers.${needsTiers}`)
              : t("deals.calcPrompt")}
          </p>
        ) : query.isLoading ? (
          <Spinner size="sm" />
        ) : null
      ) : data.projection.visibility === "FULL" ? (
        <FullProjection
          result={data.projection.result}
          name={name}
          money={money}
          signed={signed}
          restLineIds={restLineIds}
          restTotalCents={data.remainder?.restTotalCents ?? null}
          testId={testId}
        />
      ) : (
        <OwnLine
          projection={data.projection}
          name={name}
          signed={signed}
          testId={testId}
        />
      )}
    </section>
  );
}

function TierRow({
  row,
  index,
  numbered,
  testId,
  onChange,
}: {
  row: TierDraft;
  index: number;
  /** Several rows: each input's name says which row, so no two read alike. */
  numbered: boolean;
  testId: string;
  onChange: (patch: Partial<TierDraft>) => void;
}) {
  const { t } = useDealWords();
  const ticketsId = useId();
  const priceId = useId();
  const ticketsBad =
    row.tickets.trim() !== "" && !/^\d{1,8}$/.test(row.tickets.trim());
  const priceBad = row.price.trim() !== "" && parsePrice(row.price) === null;
  const rowName = numbered ? (
    <span
      className={styles.srOnly}
    >{` (${t("deals.calcRow", { n: index + 1 })})`}</span>
  ) : null;
  return (
    <div className={styles.tierRow} data-testid={`${testId}-tier-${index}`}>
      <label htmlFor={ticketsId}>
        {t("deals.calcIfWeSell")}
        {rowName}
      </label>
      <input
        id={ticketsId}
        inputMode="numeric"
        value={row.tickets}
        placeholder="0"
        aria-invalid={ticketsBad ? true : undefined}
        onChange={(e) => onChange({ tickets: e.target.value })}
        data-testid={`${testId}-tickets-${index}`}
      />
      <label htmlFor={priceId}>
        {t("deals.calcTicketsAt")}
        {rowName}
      </label>
      <input
        id={priceId}
        inputMode="decimal"
        value={row.price}
        placeholder="$0"
        aria-invalid={priceBad ? true : undefined}
        onChange={(e) => onChange({ price: e.target.value })}
        data-testid={`${testId}-price-${index}`}
      />
    </div>
  );
}

function useHowWords(money: (cents: number) => string) {
  const { t } = useDealWords();
  return (how: How): string => {
    if (how.kind === "FIXED")
      return t("deals.how.fixed", { amount: money(how.fixedCents) });
    const pool = how.percentOf.basis === "NET_POOL";
    const of = {
      percent: how.percent,
      basis: money(how.percentOf.basisCents),
      amount: money(how.percentCents),
    };
    if (how.kind === "PERCENT")
      return t(pool ? "deals.how.percentPool" : "deals.how.percentTickets", of);
    const fixed = money(how.fixedCents);
    if (how.kind === "SUM") {
      return t(pool ? "deals.how.sumPool" : "deals.how.sumTickets", {
        ...of,
        fixed,
      });
    }
    const pickedKey =
      how.picked === "FIXED"
        ? "deals.how.pickedGuarantee"
        : how.picked === "PERCENT"
          ? "deals.how.pickedPercent"
          : "deals.how.pickedTie";
    return `${t(pool ? "deals.how.versusPool" : "deals.how.versusTickets", { ...of, fixed })} → ${t(pickedKey)}`;
  };
}

function FullProjection({
  result,
  name,
  money,
  signed,
  restLineIds,
  restTotalCents,
  testId,
}: {
  result: FullResult;
  name: (payeeId: string) => string;
  money: (cents: number) => string;
  signed: (cents: number) => string;
  restLineIds: ReadonlySet<string>;
  /**
   * "The rest", summed by the server (`remainder.restTotalCents`: the pool's
   * remainder plus the holder's own per-order lines), so no money is added
   * in the browser (NFR-002). Null when the projection names no remainder.
   */
  restTotalCents: number | null;
  testId: string;
}) {
  const { t } = useDealWords();
  const howWords = useHowWords(money);
  const clauseById = new Map(result.clauses.map((c) => [c.clauseId, c]));

  const howOf = (p: FullResult["payees"][number]): string => {
    const parts: string[] = [];
    for (const id of p.clauseIds) {
      const c = clauseById.get(id);
      if (!c) continue;
      // The holder's derived per-order line is part of "the rest", which the
      // server already summed into restTotalCents.
      if (p.isRemainder && restLineIds.has(id)) continue;
      let line = howWords(c.how);
      if (c.uncoveredCents > 0)
        line += ` (${t("deals.how.uncovered", { amount: money(c.uncoveredCents) })})`;
      parts.push(line);
    }
    if (p.isRemainder) {
      parts.push(
        t("deals.how.rest", {
          amount: money(restTotalCents ?? p.remainderShareCents ?? 0),
        }),
      );
    }
    if (p.creditedDeductionsCents > 0) {
      parts.push(
        t("deals.how.credited", { amount: money(p.creditedDeductionsCents) }),
      );
    }
    if (p.notRecoveredCents > 0) {
      parts.push(
        t("deals.how.notRecovered", { amount: money(p.notRecoveredCents) }),
      );
    }
    const words = parts.join(" + ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  };

  const summary = settleSummaryOf(
    result.payees.map((p) => ({
      payeeId: p.payeeId,
      cents: p.projectedSettleDirectlyCents ?? 0,
    })),
  );
  const shortfall =
    result.shortfall && result.shortfall.externalShortfallCents > 0
      ? result.shortfall
      : null;
  const w = result.waterfall;

  return (
    <>
      <div
        className={styles.table}
        role="table"
        aria-label={t("deals.whoGetsWhat")}
      >
        <div className={styles.tableHead} role="row">
          <span className={styles.kicker} role="columnheader">
            {t("deals.col.payee")}
          </span>
          <span className={styles.kicker} role="columnheader">
            {t("deals.col.entitled")}
          </span>
          <span className={styles.kicker} role="columnheader">
            {t("deals.col.how")}
          </span>
          <span
            className={`${styles.kicker} ${styles.headRight}`}
            role="columnheader"
          >
            {t("deals.paidThrough")}
          </span>
          <span
            className={`${styles.kicker} ${styles.headRight}`}
            role="columnheader"
          >
            {t("deals.settleDirectly")}
          </span>
        </div>
        {result.payees.map((p) => {
          const paid = p.projectedPaidPerOrderCents ?? 0;
          const settle = p.projectedSettleDirectlyCents ?? 0;
          return (
            <div
              key={p.payeeId}
              className={styles.tableRow}
              role="row"
              data-testid={`${testId}-row-${p.payeeId}`}
            >
              <span className={styles.cellName} role="rowheader">
                {name(p.payeeId)}
              </span>
              <span className={styles.cellEntitled} role="cell">
                <Money cents={p.entitlementCents} weight="bold" />
              </span>
              <span className={styles.cellHow} role="cell">
                {howOf(p)}
              </span>
              <span className={styles.cellPaid} role="cell">
                <Money cents={paid} />
              </span>
              <span
                className={styles.cellSettle}
                role="cell"
                data-testid={`${testId}-settle-${p.payeeId}`}
              >
                {signed(settle)}
              </span>
              <span className={styles.cellPair} role="cell">
                <span className={styles.cellPairItem}>
                  <span className={styles.stamp}>{t("deals.paidThrough")}</span>
                  {Money.format(paid)}
                </span>
                <span className={styles.cellPairItem}>
                  <span className={styles.stamp}>
                    {t("deals.settleDirectly")}
                  </span>
                  <strong>{signed(settle)}</strong>
                </span>
              </span>
            </div>
          );
        })}
        <div className={styles.totalRow} role="row">
          <span role="rowheader">{t("deals.total")}</span>
          <span role="cell" data-testid={`${testId}-total`}>
            {t("deals.totalChecked", { amount: Money.format(w.grossCents) })}
          </span>
        </div>
      </div>

      <div className={styles.calcFoot}>
        <div className={styles.waterfall} data-testid={`${testId}-waterfall`}>
          <p className={styles.kicker}>{t("deals.toThePool")}</p>
          <div className={styles.waterRow}>
            <span>{t("deals.ticketRevenue")}</span>
            <span className={styles.waterAmount}>
              {Money.format(w.grossCents)}
            </span>
          </div>
          {w.perOrderPaidFirstCents > 0 ? (
            <div className={styles.waterRow}>
              <span>{t("deals.paidFirst")}</span>
              <span className={styles.waterAmount}>
                {signed(-w.perOrderPaidFirstCents)}
              </span>
            </div>
          ) : null}
          {w.steps.map((s) => (
            <Fragment key={s.deductionId}>
              <div className={styles.waterRow}>
                <span>
                  {s.estimated
                    ? t("deals.stepEstimated", { label: s.label })
                    : s.label}
                </span>
                <span className={styles.waterAmount}>
                  {signed(-s.recoupedCents)}
                </span>
              </div>
              {s.notRecoveredCents > 0 ? (
                <div className={styles.waterRow}>
                  <span className={styles.hint}>
                    {t("deals.stepNotRecovered", {
                      amount: money(s.notRecoveredCents),
                      name: name(s.creditedPayeeId),
                    })}
                  </span>
                </div>
              ) : null}
            </Fragment>
          ))}
          <div className={`${styles.waterRow} ${styles.waterPool}`}>
            <span>{t("deals.pool")}</span>
            <span className={styles.waterAmount}>
              {Money.format(w.netPoolCents)}
            </span>
          </div>
        </div>

        <div className={styles.presets}>
          <p className={styles.summary} data-testid={`${testId}-summary`}>
            {summary.kind === "ONE_PAYER" ? (
              <strong>
                {t("deals.summaryOnePayer", {
                  payer: name(summary.payerId),
                  list: summary.payees
                    .map((l) =>
                      t("deals.summaryItem", {
                        name: name(l.payeeId),
                        amount: money(l.cents),
                      }),
                    )
                    .join(t("deals.listJoin")),
                })}
              </strong>
            ) : summary.kind === "EACH" ? (
              <strong>
                {[
                  ...summary.owes.map((l) =>
                    t("deals.summaryOwes", {
                      name: name(l.payeeId),
                      amount: money(-l.cents),
                    }),
                  ),
                  ...summary.owed.map((l) =>
                    t("deals.summaryOwed", {
                      name: name(l.payeeId),
                      amount: money(l.cents),
                    }),
                  ),
                ].join(" ")}
              </strong>
            ) : (
              <strong>{t("deals.summaryNone")}</strong>
            )}{" "}
            {t("deals.poolExplained")}
          </p>

          {shortfall ? (
            <div
              className={styles.shortfall}
              role="status"
              data-testid={`${testId}-shortfall`}
            >
              <AlertTriangle size={18} strokeWidth={2} aria-hidden />
              <div className={styles.presets}>
                <p className={styles.shortfallKicker}>{t("deals.shortfall")}</p>
                <p className={styles.blockBody}>
                  {t("deals.shortfallBody", {
                    payer: name(shortfall.owedByPayeeId),
                    amount: money(shortfall.externalShortfallCents),
                    list: shortfall.owedTo
                      .map((o) =>
                        t("deals.summaryItem", {
                          name: name(o.payeeId),
                          amount: money(o.cents),
                        }),
                      )
                      .join(t("deals.listJoin")),
                  })}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function OwnLine({
  projection,
  name,
  signed,
  testId,
}: {
  projection: Extract<DealProjected["projection"], { visibility: "OWN_LINE" }>;
  name: (payeeId: string) => string;
  signed: (cents: number) => string;
  testId: string;
}) {
  const { t, money } = useDealWords();
  const howWords = useHowWords(money);
  return (
    <div className={styles.table} data-testid={`${testId}-own`}>
      <p className={styles.hint}>{t("deals.ownLineHint")}</p>
      {projection.positions.map((p) => (
        <div key={p.payeeId} className={styles.tableRow}>
          <span className={styles.cellName}>{name(p.payeeId)}</span>
          <span className={styles.cellEntitled}>
            <Money cents={p.entitlementCents} weight="bold" />
          </span>
          <span className={styles.cellHow}>
            {projection.clauses
              .filter((c) => c.payeeId === p.payeeId)
              .map((c) => howWords(c.how))
              .join(" + ")}
          </span>
          <span className={styles.cellPaid}>
            <Money cents={p.projectedPaidPerOrderCents ?? 0} />
          </span>
          <span className={styles.cellSettle}>
            {signed(p.projectedSettleDirectlyCents ?? 0)}
          </span>
          <span className={styles.cellPair} role="cell">
            <span className={styles.cellPairItem}>
              <span className={styles.stamp}>{t("deals.paidThrough")}</span>
              {Money.format(p.projectedPaidPerOrderCents ?? 0)}
            </span>
            <span className={styles.cellPairItem}>
              <span className={styles.stamp}>{t("deals.settleDirectly")}</span>
              <strong>{signed(p.projectedSettleDirectlyCents ?? 0)}</strong>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
