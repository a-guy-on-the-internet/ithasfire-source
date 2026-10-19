"use client";

import { useMemo } from "react";

import { trpc } from "@/trpc";

import type { PayoutOwnerRef } from "./PayoutOwner";

// ─────────────────────────────────────────────────────────────────────────────
// One read of `platform.listUpcomingPayouts`, two consumers.
//
// "Upcoming payouts" renders the tranche table; "Payouts owed" renders the
// per-payee "Expected next" cell from `nextByPayee`. Both mount on the same
// page, so this exists to keep them on ONE query key — react-query dedupes it
// to a single request — and, more importantly, to keep them from disagreeing.
// Two independent reads taken moments apart could straddle a maturity boundary
// and show a date in one section that the other had already matured.
//
// `nextByPayee` is deliberately NOT truncated by the server, so the "Expected
// next" lookup is total over payees even when the tranche table is capped.
// Blanking that cell would read as "nothing upcoming", which is the one thing
// it must never say by accident.
//
// NULL SEMANTICS, mirrored from the use case: `debtAppliedCents`,
// `expectedCents` and `nextTrancheCents` are null exactly when the server's
// `debtResolved` is false — it could not read the payable, so it could not
// net carried-forward debt and refuses to hand back a gross figure as a net
// one. The rows carry that null themselves, so no separate flag is needed
// here. `creditCents` and `heldCents` are always numbers.
//
// `heldCents` is an ANNOTATION ("this much is under an open dispute"), never
// an operand: the hold is already inside today's payable and reaches the
// forecast as debt. Nothing in this module — or its consumers — subtracts it.
// ─────────────────────────────────────────────────────────────────────────────

/** The netting a forecast row carries: gross, what comes off it. */
export interface TrancheNetting {
  /** GROSS unblocked credit maturing on the date. */
  creditCents: number;
  /** Carried-forward debt this tranche is consumed by. Null = unknown. */
  debtAppliedCents: number | null;
}

export interface UpcomingRow extends PayoutOwnerRef, TrancheNetting {
  currency: string;
  maturesAt: Date;
  /** Under open dispute — informational, already counted in today's payable. */
  heldCents: number;
  /** max(0, credit − debt). Null = debt unknown. */
  expectedCents: number | null;
  creditCount: number;
  identityResolved: boolean;
}

export interface NextTranche extends TrancheNetting {
  maturesAt: Date;
  /** The FIRST tranche's expected figure. Null = debt unknown. */
  nextTrancheCents: number | null;
  /** The first tranche's dispute annotation. */
  heldCents: number;
}

const toDate = (v: Date | string): Date =>
  v instanceof Date ? v : new Date(v);

/** Key for the per-payee lookup. Currency is part of it: one payee can be
 *  owed in two currencies, and those are two separate positions.
 *  Currency is normalised HERE, not by the callers: the map is filled from
 *  `listUpcomingPayouts` and probed with `listPayablePositions` rows, whose
 *  currency may be raw-cased, and a `USD`/`usd` mismatch would blank the
 *  "Expected next" cell — which reads as "nothing upcoming". */
export const nextTrancheKey = (payeeId: string, currency: string) =>
  `${payeeId}:${currency.trim().toLowerCase()}`;

export function useUpcomingPayouts() {
  const query = trpc.platform.listUpcomingPayouts.useQuery(undefined, {
    staleTime: 30_000,
  });

  const rows = useMemo<UpcomingRow[]>(
    () =>
      (query.data?.items ?? []).map((item) => ({
        ...item,
        maturesAt: toDate(item.maturesAt),
      })),
    [query.data],
  );

  /** (payeeId, currency) → that payee's EARLIEST upcoming tranche. */
  const nextByPayee = useMemo(() => {
    const map = new Map<string, NextTranche>();
    for (const entry of query.data?.nextByPayee ?? []) {
      map.set(nextTrancheKey(entry.payeeId, entry.currency), {
        maturesAt: toDate(entry.maturesAt),
        nextTrancheCents: entry.nextTrancheCents,
        creditCents: entry.creditCents,
        heldCents: entry.heldCents,
        debtAppliedCents: entry.debtAppliedCents,
      });
    }
    return map;
  }, [query.data]);

  return {
    rows,
    nextByPayee,
    byDate: query.data?.byDate ?? [],
    currencyTotals: query.data?.currencyTotals ?? [],
    total: query.data?.total ?? null,
    truncated: query.data?.truncated ?? false,
    rowLimit: query.data?.rowLimit ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    /** False when the read failed — the caller must render "could not check"
     *  rather than an empty cell, which would read as "nothing upcoming". */
    resolved: !query.isError && !query.isLoading,
  };
}
