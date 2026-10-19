/**
 * Freeze the deal (docs/specs/2026-10-14/freeze-the-deal.spec.yaml).
 *
 * An event's WHOLE deal (PRIMARY and RESALE terms: lines, payees, costs off
 * the top, payout schedule, the resale clause) freezes on first publish or
 * when its organiser freezes it (`Event.dealFrozenAt`). While frozen, every
 * deal write is refused (DEAL_FROZEN) unless the caller says it is changing
 * frozen terms (`frozenChange: true`); that save applies, the freeze stays,
 * one DealChange records the deal before and after, and after the commit
 * every payee on either side is told (F3, F7).
 *
 * One fence for every write path (FR-004), so no path carries its own copy:
 *
 *   await lockDealEvent(tx, scope, "share");   // the event row FIRST
 *   await tx.deals.lockTerms(termsId);          // then the terms row
 *   const fence = await assertDealWritable(tx, { scope, frozenChange });
 *   …the write…
 *   const change = await recordDealChange(tx, fence, { actorHumanId, at });
 *   // after the transaction commits:
 *   if (change) await notifyDealChange(deps, change);
 *
 * LOCKS (NFR-001). The order is ALWAYS event row → terms row(s):
 *   - A deal write whose scope resolves to an event takes that event's row
 *     lock (`lockDealEvent`) BEFORE any `lockTerms`, then calls
 *     `assertDealWritable` under both. Mode "share" when the write never
 *     UPDATEs the Event row; "update" when it may (a path that mints and
 *     links the event's terms), since two share holders that both upgrade
 *     would deadlock each other.
 *   - Freezing and publishing hold the event row FOR UPDATE and then lock
 *     every terms row the deal covers (`lockEventDealTerms`).
 * The event row lock is what serializes a freeze and a deal write: the write
 * either commits before the freeze takes the row or reads the committed
 * freeze and is refused. Taking it first matters for a second reason:
 * `recordDealChange` INSERTs a DealChange, whose FK takes FOR KEY SHARE on
 * the Event row. A write that held a terms lock and only then touched the
 * event would wait on publish (event FOR UPDATE, then terms), while publish
 * waits on its terms lock: a deadlock. With the event row first, the second
 * transaction queues at the event row and never holds a terms lock.
 */
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { OrgRole } from "@th/types/repos/authz";
import { fail } from "@th/errors";

import { describeError } from "../../../lib/io";
import { resaleClauseOfTerms } from "../../../lib/resale-clause";
import { resolveNotificationLocale, type NotificationLocale } from "../../comms/locale";
import {
  DEAL_CHANGE_MAX_LINES,
  DEAL_FROZEN_CHANGE_VARIANT,
  type DealChangeLine,
  type DealChangeNoticePayload,
  type DealChangeValue,
} from "../../comms/deal-change-renderers";
import type { NotifyInput, NotifyOutput } from "../../comms/notify";
import { normaliseDeal, type NormalisedDeal } from "./deal-fingerprint";

// ─────────────────────────────────────────────────────────────────────────────
// The snapshot: what DealChange stores as before / after
// ─────────────────────────────────────────────────────────────────────────────

/** One terms row: what `dealFingerprint` hashes, plus schedule and clause. */
export type TermsSnapshot = NormalisedDeal & {
  payoutTermsId: string;
  /**
   * ISO 4217, lowercase, as the terms row stores it. Optional: rows recorded
   * before it was captured lack it (readers fall back to the event's).
   */
  settlementCurrency?: string | null;
  payoutSchedule: string | null;
  resaleShare: {
    type: "PERCENT" | "FLAT";
    bps: number | null;
    cents: number | null;
    payer: "SELLER" | "BUYER";
  } | null;
};

export type EventDealSnapshot = {
  version: 1;
  /** The PRIMARY terms the write targets (the event's, or the booking's). */
  primary: TermsSnapshot | null;
  /** The event's RESALE terms. */
  resale: TermsSnapshot | null;
  /** Set when the write goes through a booking agreement: its guarantee. */
  booking: { agreementId: string; guaranteeCents: number | null } | null;
};

/**
 * Whose deal a write changes.
 *   EVENT             — the event's own terms (`payoutTermsId`,
 *                       `resalePayoutTermsId`).
 *   BOOKING_AGREEMENT — a booking agreement's terms (its PRIMARY) on the
 *                       agreement's event (the event's RESALE).
 */
export type DealScope =
  | { kind: "EVENT"; eventId: string }
  | { kind: "BOOKING_AGREEMENT"; eventId: string; agreementId: string };

/**
 * The scope of a booking agreement's deal: its finalized event, else the
 * draft event it anchors. Null when it has no event yet: nothing to freeze,
 * the write goes ahead as before (F4).
 */
export function bookingDealScope(
  agreement: Pick<AgreementRecord, "id" | "eventId" | "draftEventId">,
): DealScope | null {
  const eventId = agreement.eventId ?? agreement.draftEventId ?? null;
  return eventId ? { kind: "BOOKING_AGREEMENT", eventId, agreementId: agreement.id } : null;
}

type SnapshotTx = Pick<TxRepos, "events" | "agreements" | "deals" | "payoutTerms">;

async function snapshotTerms(
  tx: Pick<TxRepos, "deals" | "payoutTerms">,
  termsId: string | null | undefined,
): Promise<TermsSnapshot | null> {
  if (!termsId) return null;
  const deal = await tx.deals.getTermsDeal(termsId);
  if (!deal) return null;
  const terms = await tx.payoutTerms.getById(termsId);
  const clause = terms ? resaleClauseOfTerms(terms) : null;
  return {
    payoutTermsId: termsId,
    settlementCurrency: terms?.settlementCurrency ?? null,
    payoutSchedule: terms?.payoutSchedule ?? null,
    resaleShare: clause
      ? {
          type: clause.type,
          bps: clause.type === "PERCENT" ? clause.bps : null,
          cents: clause.type === "FLAT" ? clause.cents : null,
          payer: clause.payer,
        }
      : null,
    ...normaliseDeal(deal),
  };
}

/** The deal in `scope` as it stands in this transaction. */
export async function snapshotEventDeal(
  tx: SnapshotTx,
  scope: DealScope,
): Promise<EventDealSnapshot> {
  const event = await tx.events.getById(scope.eventId);
  let primaryTermsId = event?.payoutTermsId ?? null;
  let booking: EventDealSnapshot["booking"] = null;
  if (scope.kind === "BOOKING_AGREEMENT") {
    const agreement = await tx.agreements.getById(scope.agreementId);
    primaryTermsId = agreement?.payoutTermsId ?? null;
    booking = { agreementId: scope.agreementId, guaranteeCents: agreement?.guaranteeCents ?? null };
  }
  return {
    version: 1,
    primary: await snapshotTerms(tx, primaryTermsId),
    resale: await snapshotTerms(tx, event?.resalePayoutTermsId ?? null),
    booking,
  };
}

/**
 * Same deal? Compared by what the deal SAYS, not by row ids: a re-save of an
 * unchanged deal can mint fresh clause / deduction ids (the deal write
 * rebuilds non-per-order clauses), and that is not a change anyone is told
 * about. Clauses are compared as a multiset (their id order moves with the
 * ids); deductions keep their order, which the settlement sheet shows.
 */
export function sameDealSnapshot(a: EventDealSnapshot, b: EventDealSnapshot): boolean {
  return JSON.stringify(dealContent(a)) === JSON.stringify(dealContent(b));
}

function termsContent(t: TermsSnapshot | null) {
  if (!t) return null;
  return {
    payoutTermsId: t.payoutTermsId,
    payoutSchedule: t.payoutSchedule,
    resaleShare: t.resaleShare,
    remainderPayeeId: t.remainderPayeeId,
    clauses: t.clauses
      .map(({ id: _id, ...rest }) => JSON.stringify(rest))
      .sort(),
    deductions: t.deductions.map(({ id: _id, ...rest }) => rest),
  };
}

function dealContent(s: EventDealSnapshot) {
  return {
    version: s.version,
    primary: termsContent(s.primary),
    resale: termsContent(s.resale),
    booking: s.booking,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Locks (see the header: event row → terms rows, always)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deal write's FIRST lock: the row of the event its scope resolves to,
 * taken before any `lockTerms`. A null scope (a default, a booking with no
 * event yet) has no event and takes nothing. "update" for a write that may
 * UPDATE the Event row itself (linking minted terms); "share" otherwise.
 */
export async function lockDealEvent(
  tx: Pick<TxRepos, "events">,
  scope: DealScope | null,
  mode: "share" | "update" = "share",
): Promise<void> {
  if (!scope) return;
  await tx.events.lockRows({ ids: [scope.eventId], mode });
}

/**
 * A booking write resolves its scope from the agreement read BEFORE the
 * locks (it needs the event id to lock it). Re-read under the locks, the
 * agreement must still resolve to the same event (or still to none);
 * otherwise the event row this write holds is the wrong one, and the write
 * is refused as a conflict (a retry re-reads and locks the right one).
 */
export function assertDealScopeUnchanged(
  locked: DealScope | null,
  fresh: DealScope | null,
): void {
  if ((locked?.eventId ?? null) !== (fresh?.eventId ?? null)) {
    throw { code: "conflict", message: "deal_scope_changed" } as const;
  }
}

/**
 * Every terms row an event's deal covers, locked in id order: the event's
 * PRIMARY and RESALE terms, and the terms of any booking agreement whose
 * deal scope is this event (`bookingDealScope`: its finalized event, else
 * its draft event), DRAFT agreements included, since their writes are fenced
 * on this event's freeze (F4). The CALLER already holds the event row FOR
 * UPDATE. Returns false when the event does not exist.
 */
export async function lockEventDealTerms(
  tx: Pick<TxRepos, "events" | "deals" | "agreements">,
  eventId: string,
): Promise<boolean> {
  const event = await tx.events.getById(eventId);
  if (!event) return false;
  const ids = new Set<string>();
  for (const id of [event.payoutTermsId, event.resalePayoutTermsId]) {
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  const bookings = await tx.agreements.findManyByLinkedEventIds([eventId]);
  for (const agreement of bookings) {
    if (bookingDealScope(agreement)?.eventId !== eventId) continue;
    if (agreement.payoutTermsId) ids.add(agreement.payoutTermsId);
  }
  for (const id of [...ids].sort()) await tx.deals.lockTerms(id);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The fence
// ─────────────────────────────────────────────────────────────────────────────

export type DealFence =
  | { frozen: false }
  | { frozen: true; scope: DealScope; before: EventDealSnapshot };

const NOT_FROZEN: DealFence = { frozen: false };

/**
 * FR-004. Call inside the write's transaction, AFTER the event row lock and
 * the terms row lock (see the header). Reads the event's freeze; a frozen deal is refused with
 * DEAL_FROZEN unless `frozenChange === true`, in which case the deal as it
 * stands is snapshotted for {@link recordDealChange}. A null scope (an org /
 * place / human default, an agreement with no event yet) is never frozen.
 */
export async function assertDealWritable(
  tx: SnapshotTx,
  args: { scope: DealScope | null; frozenChange?: boolean | undefined },
): Promise<DealFence> {
  const { scope } = args;
  if (!scope) return NOT_FROZEN;
  const event = await tx.events.getById(scope.eventId);
  const frozenAt = event?.dealFrozenAt ?? null;
  if (!event || frozenAt === null) return NOT_FROZEN;
  if (args.frozenChange !== true) {
    throw fail("DEAL_FROZEN", {
      meta: { eventId: event.id, dealFrozenAt: frozenAt.toISOString() },
    });
  }
  return { frozen: true, scope, before: await snapshotEventDeal(tx, scope) };
}

/** A recorded frozen change, handed to {@link notifyDealChange} after commit. */
export type RecordedDealChange = {
  id: string;
  eventId: string;
  actorHumanId: string;
  createdAt: Date;
  before: EventDealSnapshot;
  after: EventDealSnapshot;
};

/**
 * FR-005. Call inside the write's transaction, after the write. On a frozen
 * deal, appends one DealChange with the deal before and after, and the
 * `event.deal_frozen_change` audit row (NFR-002). Appends nothing (null) when
 * the deal was not frozen or the save changed nothing.
 */
export async function recordDealChange(
  tx: SnapshotTx & Pick<TxRepos, "audit">,
  fence: DealFence,
  args: { actorHumanId: string; at: Date },
): Promise<RecordedDealChange | null> {
  if (!fence.frozen) return null;
  const after = await snapshotEventDeal(tx, fence.scope);
  if (sameDealSnapshot(fence.before, after)) return null;
  const row = await tx.deals.createDealChange({
    eventId: fence.scope.eventId,
    actorHumanId: args.actorHumanId,
    before: fence.before,
    after,
    createdAt: args.at,
  });
  await tx.audit.log({
    entity: "event",
    entityId: fence.scope.eventId,
    action: "event.deal_frozen_change",
    data: {
      dealChangeId: row.id,
      actorHumanId: args.actorHumanId,
      via: fence.scope.kind,
      ...(fence.scope.kind === "BOOKING_AGREEMENT"
        ? { agreementId: fence.scope.agreementId }
        : {}),
    },
    at: args.at,
  });
  return {
    id: row.id,
    eventId: fence.scope.eventId,
    actorHumanId: args.actorHumanId,
    createdAt: row.createdAt,
    before: fence.before,
    after,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Freezing
// ─────────────────────────────────────────────────────────────────────────────

export type DealFreezeSource = "MANUAL" | "PUBLISH" | "BACKFILL";

export type DealFreezeState = {
  dealFrozenAt: Date | null;
  dealFrozenByHumanId: string | null;
  /** True when this call set the freeze. */
  changed: boolean;
};

/**
 * Set the freeze, only when it is not set (an existing freeze is never
 * overwritten or cleared). The CALLER holds the event row lock
 * (`tx.events.lockRows`, mode update): publish already does; a manual freeze
 * takes it first. Under it, this takes the lock of every terms row the deal
 * covers (`lockEventDealTerms`: the event's own and its booking agreements'),
 * so no deal write can be mid-flight on any of them (see the header). Writes
 * `event.deal_frozen` (NFR-002) when it sets the freeze. Null when the event
 * does not exist.
 */
export async function freezeEventDealOnLockedRow(
  tx: Pick<TxRepos, "events" | "deals" | "audit" | "agreements">,
  args: {
    eventId: string;
    at: Date;
    /** Null = frozen automatically (publish, backfill). */
    frozenByHumanId: string | null;
    source: DealFreezeSource;
    actorHumanId: string | null;
  },
): Promise<DealFreezeState | null> {
  const event = await tx.events.getById(args.eventId);
  if (!event) return null;
  if (event.dealFrozenAt) {
    return {
      dealFrozenAt: event.dealFrozenAt,
      dealFrozenByHumanId: event.dealFrozenByHumanId ?? null,
      changed: false,
    };
  }
  await lockEventDealTerms(tx, args.eventId);

  const changed = await tx.deals.freezeEventDealIfUnfrozen({
    eventId: args.eventId,
    frozenAt: args.at,
    frozenByHumanId: args.frozenByHumanId,
  });
  if (!changed) {
    const current = await tx.events.getById(args.eventId);
    return {
      dealFrozenAt: current?.dealFrozenAt ?? null,
      dealFrozenByHumanId: current?.dealFrozenByHumanId ?? null,
      changed: false,
    };
  }
  await tx.audit.log({
    entity: "event",
    entityId: args.eventId,
    action: "event.deal_frozen",
    data: {
      source: args.source,
      actorHumanId: args.actorHumanId,
      frozenByHumanId: args.frozenByHumanId,
    },
    at: args.at,
  });
  return { dealFrozenAt: args.at, dealFrozenByHumanId: args.frozenByHumanId, changed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Who is on the deal
// ─────────────────────────────────────────────────────────────────────────────

/** Every payee a snapshot names: lines, costs' credited payees, remainder. */
export function snapshotPayeeIds(snapshot: unknown): string[] {
  const ids = new Set<string>();
  const s = snapshot as Partial<EventDealSnapshot> | null;
  for (const terms of [s?.primary, s?.resale]) {
    if (!terms || typeof terms !== "object") continue;
    if (typeof terms.remainderPayeeId === "string") ids.add(terms.remainderPayeeId);
    for (const c of Array.isArray(terms.clauses) ? terms.clauses : []) {
      if (typeof c?.payeeId === "string") ids.add(c.payeeId);
    }
    for (const d of Array.isArray(terms.deductions) ? terms.deductions : []) {
      if (typeof d?.creditedPayeeId === "string") ids.add(d.creditedPayeeId);
    }
  }
  return [...ids];
}

/**
 * The org roles told about a deal change on an ORGANIZATION payee: the same
 * set `notify-payout-completed.ts` tells about a payout.
 */
const DEAL_NOTICE_ORG_ROLES = new Set<OrgRole>(["OWNER", "ADMIN", "FINANCE"]);

/**
 * The humans behind a set of payees: a HUMAN payee is that human; an
 * ORGANIZATION payee is its OWNER / ADMIN / FINANCE members (paged, as
 * `notify-payout-completed.ts` resolves them).
 */
export async function resolvePayeeHumanIds(
  repos: Pick<Repos, "payees" | "organizations">,
  payeeIds: readonly string[],
): Promise<string[]> {
  if (payeeIds.length === 0) return [];
  const payees = await repos.payees.getByIds([...new Set(payeeIds)]);
  const humanIds = new Set<string>();
  for (const payee of payees) {
    if (payee.subjectType === "HUMAN") {
      humanIds.add(payee.subjectId);
      continue;
    }
    const limit = 100;
    let offset = 0;
    let total = 0;
    do {
      const page = await repos.organizations.listMembers({ orgId: payee.subjectId, limit, offset });
      total = page.total;
      for (const member of page.items) {
        if (DEAL_NOTICE_ORG_ROLES.has(member.role)) humanIds.add(member.humanId);
      }
      offset += page.items.length;
      if (page.items.length === 0) break;
    } while (offset < total);
  }
  return [...humanIds];
}

// ─────────────────────────────────────────────────────────────────────────────
// The lines that changed
// ─────────────────────────────────────────────────────────────────────────────

type LineItem = {
  key: string;
  section: DealChangeLine["section"];
  payeeId: string | null;
  label: string | null;
  value: DealChangeValue;
};

function termsItems(section: "TICKETS" | "RESALE", terms: TermsSnapshot | null): LineItem[] {
  if (!terms) return [];
  const items: LineItem[] = [];
  for (const c of terms.clauses) {
    items.push({
      key: `${section}:SHARE:${c.id}`,
      section,
      payeeId: c.payeeId,
      label: c.displayLabel,
      value: {
        kind: "SHARE",
        amountType: c.amountType as "FIXED" | "PERCENT" | "FIXED_AND_PERCENT",
        amountCents: c.amountCents,
        percent: c.percent,
        basis: c.basis as "GROSS" | "NET_POOL",
        resolution: c.resolution as "SUM" | "GREATER_OF" | null,
        capPercent: c.capPercent,
      },
    });
  }
  for (const d of terms.deductions) {
    items.push({
      key: `${section}:COST:${d.id}`,
      section,
      payeeId: d.creditedPayeeId,
      label: d.label,
      value: { kind: "COST", amountCents: d.amountCents, percent: d.percent },
    });
  }
  if (terms.payoutSchedule) {
    items.push({
      key: `${section}:SCHEDULE`,
      section,
      payeeId: null,
      label: null,
      value: {
        kind: "SCHEDULE",
        schedule: terms.payoutSchedule as Extract<DealChangeValue, { kind: "SCHEDULE" }>["schedule"],
      },
    });
  }
  if (terms.resaleShare) {
    items.push({
      key: `${section}:RESALE_SHARE`,
      section,
      payeeId: null,
      label: null,
      value: { kind: "RESALE_SHARE", ...terms.resaleShare },
    });
  }
  return items;
}

function snapshotItems(s: EventDealSnapshot): LineItem[] {
  const items = [...termsItems("TICKETS", s.primary), ...termsItems("RESALE", s.resale)];
  if (s.booking && s.booking.guaranteeCents !== null) {
    items.push({
      key: "BOOKING:GUARANTEE",
      section: "BOOKING",
      payeeId: null,
      label: null,
      value: { kind: "GUARANTEE", cents: s.booking.guaranteeCents },
    });
  }
  return items;
}

const kindOf = (i: LineItem) => i.value.kind;
const sameValue = (a: LineItem, b: LineItem) =>
  a.payeeId === b.payeeId &&
  a.label === b.label &&
  JSON.stringify(a.value) === JSON.stringify(b.value);
const groupKey = (i: LineItem) => `${i.section}:${kindOf(i)}:${i.payeeId ?? ""}`;

export type DealChangeLineDraft = {
  section: DealChangeLine["section"];
  payeeId: string | null;
  label: string | null;
  before: DealChangeValue | null;
  after: DealChangeValue | null;
};

/**
 * Before → after, one entry per thing that changed. Lines match by id; a
 * line whose id changed but whose payee and terms did not (a preset re-save
 * mints fresh clause ids) is not a change; a payee's line that moved to a
 * new id with different terms is one change, not a removal plus an addition.
 */
export function describeDealChange(
  before: EventDealSnapshot,
  after: EventDealSnapshot,
): DealChangeLineDraft[] {
  const b = snapshotItems(before);
  const a = snapshotItems(after);
  const aByKey = new Map(a.map((i) => [i.key, i]));
  const out: DealChangeLineDraft[] = [];
  const unmatchedBefore: LineItem[] = [];
  const matchedAfter = new Set<string>();

  for (const item of b) {
    const other = aByKey.get(item.key);
    if (!other) {
      unmatchedBefore.push(item);
      continue;
    }
    matchedAfter.add(other.key);
    if (!sameValue(item, other)) out.push(draft(item, other));
  }
  let unmatchedAfter = a.filter((i) => !matchedAfter.has(i.key));

  // Id churn: the same payee, label and terms on both sides is no change.
  const remainingBefore: LineItem[] = [];
  for (const item of unmatchedBefore) {
    const twin = unmatchedAfter.findIndex((o) => sameValue(item, o) && o.section === item.section);
    if (twin >= 0) unmatchedAfter = unmatchedAfter.filter((_, i) => i !== twin);
    else remainingBefore.push(item);
  }
  // The same payee's line under a new id: one change.
  for (const item of remainingBefore) {
    const pair = unmatchedAfter.findIndex((o) => groupKey(o) === groupKey(item));
    if (pair >= 0) {
      out.push(draft(item, unmatchedAfter[pair]!));
      unmatchedAfter = unmatchedAfter.filter((_, i) => i !== pair);
    } else {
      out.push(draft(item, null));
    }
  }
  for (const item of unmatchedAfter) out.push(draft(null, item));
  return out;
}

function draft(before: LineItem | null, after: LineItem | null): DealChangeLineDraft {
  const ref = (after ?? before) as LineItem;
  return {
    section: ref.section,
    payeeId: ref.payeeId,
    label: ref.label,
    before: before?.value ?? null,
    after: after?.value ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The notice (FR-006)
// ─────────────────────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

/** What every fenced use case adds to its deps for the notice. */
export type DealChangeNoticeDeps = {
  /** Absent = the composition root has not wired the notice (reported). */
  notify?: NotifyFn;
  /** Wired to Sentry by the composition roots (CLAUDE.md, Sentry). */
  reportError?: ReporterPort;
  logger?: LoggerPort;
  /**
   * Builds the notice's link to the deal: given the event id, the absolute
   * URL a payee opens. Absent = the notice carries no link.
   */
  dealUrlFor?: (eventId: string) => string | null;
};

type NoticeRepos = Pick<Repos, "payees" | "organizations" | "humans" | "events">;

function safeReport(
  reportError: ReporterPort | undefined,
  error: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  try {
    reportError?.(error, context);
  } catch {
    // A throwing reporter must never change what the save returns.
  }
}

/**
 * FR-006. After the change COMMITS: one notice (email + in-app) to every
 * human behind a payee on the deal before OR after the change, the actor
 * excepted. Keyed `deal-change:${dealChangeId}:${humanId}`, so a retry never
 * double-sends.
 *
 * Best effort, and never throws: the change is already saved, and a notice
 * that fails must not turn a saved change into an error. Every failure is a
 * deliberate swallow, so it is logged AND reported (CLAUDE.md, Sentry).
 */
export async function notifyDealChange(
  deps: DealChangeNoticeDeps & { repos: NoticeRepos },
  change: RecordedDealChange,
): Promise<void> {
  const context = { dealChangeId: change.id, eventId: change.eventId };
  if (!deps.notify) {
    const err = new Error("deal_change_notice_not_wired: no notify in the use case deps");
    deps.logger?.error("deal_change.notice_not_wired", context);
    safeReport(deps.reportError, err, {
      tags: { useCase: "notifyDealChange", step: "not_wired" },
      extra: context,
    });
    return;
  }

  let payload: DealChangeNoticePayload;
  let recipients: Array<{ humanId: string; removed: boolean; locale: NotificationLocale }>;
  try {
    const afterPayeeIds = snapshotPayeeIds(change.after);
    const payeeIds = [...new Set([...snapshotPayeeIds(change.before), ...afterPayeeIds])];
    const everyone = (await resolvePayeeHumanIds(deps.repos, payeeIds)).filter(
      (humanId) => humanId !== change.actorHumanId,
    );
    if (everyone.length === 0) return;
    // Who is still on the deal after the change: everyone else was removed
    // by it, and their email says they WERE on it.
    const stillOn = new Set(await resolvePayeeHumanIds(deps.repos, afterPayeeIds));
    const people = await deps.repos.humans.getByIds(everyone);
    const localeOf = new Map(people.map((h) => [h.id, resolveNotificationLocale(h.locale)]));
    recipients = everyone.map((humanId) => ({
      humanId,
      removed: !stillOn.has(humanId),
      locale: localeOf.get(humanId) ?? "en",
    }));
    payload = await buildNoticePayload(deps, change, payeeIds);
  } catch (error) {
    deps.logger?.error("deal_change.notice_prepare_failed", {
      ...context,
      error: describeError(error),
    });
    safeReport(deps.reportError, error, {
      tags: { useCase: "notifyDealChange", step: "prepare" },
      extra: context,
    });
    return;
  }

  for (const { humanId, removed, locale } of recipients) {
    try {
      await deps.notify({
        humanId,
        variant: DEAL_FROZEN_CHANGE_VARIANT,
        idempotencyKey: `deal-change:${change.id}:${humanId}`,
        // The email renders in the recipient's stored language (the in-app
        // row re-renders in the reader's language on its own).
        payload: { ...payload, emailLocale: locale, recipientRemoved: removed },
        actor: { type: "human", humanId: change.actorHumanId },
      });
    } catch (error) {
      deps.logger?.error("deal_change.notice_failed", {
        ...context,
        humanId,
        error: describeError(error),
      });
      // The other recipients must still be told.
      safeReport(deps.reportError, error, {
        tags: { useCase: "notifyDealChange", step: "recipient_notify" },
        extra: { ...context, humanId },
      });
    }
  }
}

async function buildNoticePayload(
  deps: DealChangeNoticeDeps & { repos: NoticeRepos },
  change: RecordedDealChange,
  payeeIds: readonly string[],
): Promise<DealChangeNoticePayload> {
  const event = await deps.repos.events.getById(change.eventId);
  const names = await resolvePayeeNames(deps.repos, payeeIds);
  const actor = (await deps.repos.humans.getByIds([change.actorHumanId]))[0];
  const drafts = describeDealChange(change.before, change.after);
  const lines: DealChangeLine[] = drafts.slice(0, DEAL_CHANGE_MAX_LINES).map((d) => ({
    section: d.section,
    payeeName: d.payeeId ? (names.get(d.payeeId) ?? null) : null,
    label: d.label ? d.label.slice(0, 300) : null,
    before: d.before,
    after: d.after,
  }));
  return {
    dealChangeId: change.id,
    eventId: change.eventId,
    eventTitle: (event?.title ?? "").trim().slice(0, 500) || "Your event",
    currency: dealCurrency(change, event?.currency ?? null),
    actorName: actor?.name?.trim() ? actor.name.trim().slice(0, 300) : null,
    changedAtIso: change.createdAt.toISOString(),
    timezone: event?.timezone ?? null,
    dealUrl: deps.dealUrlFor?.(change.eventId) ?? null,
    lines,
    moreLines: Math.max(0, drafts.length - lines.length),
  };
}

/**
 * The currency the deal's amounts are in: the terms' settlement currency
 * (after the change, else before), else the event's, else USD.
 */
export function dealCurrency(
  change: Pick<RecordedDealChange, "before" | "after">,
  eventCurrency: string | null,
): string {
  const candidates = [
    change.after.primary?.settlementCurrency,
    change.after.resale?.settlementCurrency,
    change.before.primary?.settlementCurrency,
    change.before.resale?.settlementCurrency,
    eventCurrency,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^[a-z]{3}$/iu.test(c.trim())) return c.trim().toLowerCase();
  }
  return "usd";
}

/** payeeId → the name of the human or organisation behind it. */
export async function resolvePayeeNames(
  repos: Pick<Repos, "payees" | "organizations" | "humans">,
  payeeIds: readonly string[],
): Promise<Map<string, string>> {
  if (payeeIds.length === 0) return new Map();
  const payees = await repos.payees.getByIds([...payeeIds]);
  const humanIds = payees.filter((p) => p.subjectType === "HUMAN").map((p) => p.subjectId);
  const orgIds = payees.filter((p) => p.subjectType === "ORGANIZATION").map((p) => p.subjectId);
  const [humans, orgs] = await Promise.all([
    humanIds.length ? repos.humans.getByIds(humanIds) : Promise.resolve([]),
    orgIds.length ? repos.organizations.getByIds(orgIds) : Promise.resolve([]),
  ]);
  const subjectName = new Map<string, string>();
  for (const h of humans) if (h.name?.trim()) subjectName.set(h.id, h.name.trim());
  for (const o of orgs) if (o.name?.trim()) subjectName.set(o.id, o.name.trim());
  const out = new Map<string, string>();
  for (const p of payees) {
    const name = subjectName.get(p.subjectId);
    if (name) out.set(p.id, name.slice(0, 300));
  }
  return out;
}
