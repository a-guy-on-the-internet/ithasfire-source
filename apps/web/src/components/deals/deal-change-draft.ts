import {
  sameRef,
  type DealClauseInput,
  type DealDeductionInput,
  type DealPayeeRef,
} from "./deal-model";

// ─────────────────────────────────────────────────────────────────────────────
// Changing a frozen deal (freeze-the-deal FR-010, board option A).
//
// While the organiser changes the frozen terms, row edits collect here instead
// of saving one by one; "Save and tell them" sends them as ONE write with
// `frozenChange: true`, so payees get one notice for the whole change.
//
// The draft holds EDITS, not a copy of the deal: each saved clause or cost by
// id (null = taken off), what was added, and the rest's new holder. What the
// page shows is always the live read with the edits laid over it, so a change
// someone else saves meanwhile shows through every row this draft does not
// touch, and what the user typed is kept.
// ─────────────────────────────────────────────────────────────────────────────

export type ChangeDraft = {
  /** The deal fingerprint the save is checked against (`expectedDealFingerprint`). */
  base: string | null;
  clauses: Readonly<Record<string, DealClauseInput | null>>;
  addedClauses: readonly DealClauseInput[];
  deductions: Readonly<Record<string, DealDeductionInput | null>>;
  addedDeductions: readonly DealDeductionInput[];
  /** Null = the rest stays with whoever holds it now. */
  remainder: DealPayeeRef | null;
};

export function emptyDraft(base: string | null): ChangeDraft {
  return {
    base,
    clauses: {},
    addedClauses: [],
    deductions: {},
    addedDeductions: [],
    remainder: null,
  };
}

export function sameClause(a: DealClauseInput, b: DealClauseInput): boolean {
  return (
    sameRef(a.payee, b.payee) &&
    a.amountType === b.amountType &&
    (a.amountCents ?? null) === (b.amountCents ?? null) &&
    (a.percent ?? null) === (b.percent ?? null) &&
    a.basis === b.basis &&
    (a.resolution ?? null) === (b.resolution ?? null)
  );
}

export function sameDeduction(
  a: DealDeductionInput,
  b: DealDeductionInput,
): boolean {
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    (a.amountCents ?? null) === (b.amountCents ?? null) &&
    (a.percent ?? null) === (b.percent ?? null) &&
    sameRef(a.creditedPayee, b.creditedPayee) &&
    !!a.estimated === !!b.estimated
  );
}

type Keyed = { id?: string | null };

/** The live list with the edits laid over it, then what was added. */
function overlay<T extends Keyed>(
  live: readonly T[],
  edits: Readonly<Record<string, T | null>>,
  added: readonly T[],
): T[] {
  const out: T[] = [];
  for (const item of live) {
    const edit = item.id ? edits[item.id] : undefined;
    if (edit === null) continue;
    out.push(edit ?? item);
  }
  return [...out, ...added];
}

/**
 * The edits that turn `live` into `next`: an id missing from `next` was taken
 * off, an id whose value moved was edited, an item with no id (or an id the
 * live deal no longer has) was added. An edit back to the live value is no
 * edit at all.
 */
function editsOf<T extends Keyed>(
  live: readonly T[],
  next: readonly T[],
  same: (a: T, b: T) => boolean,
): { edits: Record<string, T | null>; added: T[] } {
  const liveById = new Map<string, T>();
  for (const item of live) if (item.id) liveById.set(item.id, item);
  const edits: Record<string, T | null> = {};
  const added: T[] = [];
  const seen = new Set<string>();
  for (const item of next) {
    const was = item.id ? liveById.get(item.id) : undefined;
    if (!was || !item.id) {
      added.push(item);
      continue;
    }
    seen.add(item.id);
    if (!same(was, item)) edits[item.id] = item;
  }
  for (const id of liveById.keys()) if (!seen.has(id)) edits[id] = null;
  return { edits, added };
}

export function draftClauses(
  live: readonly DealClauseInput[],
  draft: ChangeDraft,
): DealClauseInput[] {
  return overlay(live, draft.clauses, draft.addedClauses);
}

export function draftDeductions(
  live: readonly DealDeductionInput[],
  draft: ChangeDraft,
): DealDeductionInput[] {
  return overlay(live, draft.deductions, draft.addedDeductions);
}

export function withClauses(
  draft: ChangeDraft,
  live: readonly DealClauseInput[],
  next: readonly DealClauseInput[],
): ChangeDraft {
  const { edits, added } = editsOf(live, next, sameClause);
  return { ...draft, clauses: edits, addedClauses: added };
}

export function withDeductions(
  draft: ChangeDraft,
  live: readonly DealDeductionInput[],
  next: readonly DealDeductionInput[],
): ChangeDraft {
  const { edits, added } = editsOf(live, next, sameDeduction);
  return { ...draft, deductions: edits, addedDeductions: added };
}

export function withRemainder(
  draft: ChangeDraft,
  live: DealPayeeRef | null,
  next: DealPayeeRef,
): ChangeDraft {
  return {
    ...draft,
    remainder: live && sameRef(live, next) ? null : next,
  };
}

/**
 * How many lines the save would change: each clause or cost edited, taken off
 * or added, and the rest moving to someone else. Edits to ids the live deal
 * no longer has (someone else took the line off) are not counted.
 */
export function draftChangeCount(
  draft: ChangeDraft,
  live: {
    clauses: readonly DealClauseInput[];
    deductions: readonly DealDeductionInput[];
    remainder: DealPayeeRef | null;
  },
): number {
  const liveClauseIds = new Set(live.clauses.flatMap((c) => (c.id ? [c.id] : [])));
  const liveCostIds = new Set(live.deductions.flatMap((d) => (d.id ? [d.id] : [])));
  let n = draft.addedClauses.length + draft.addedDeductions.length;
  n += Object.keys(draft.clauses).filter((id) => liveClauseIds.has(id)).length;
  n += Object.keys(draft.deductions).filter((id) => liveCostIds.has(id)).length;
  if (
    draft.remainder &&
    !(live.remainder && sameRef(live.remainder, draft.remainder))
  ) {
    n += 1;
  }
  return n;
}

// A cost added during the change has no id yet; it gets a client one, so its
// edit form opens on it (the form is keyed by id) instead of a blank "Add".
// Never sent: the write strips it, and the server mints the real id.
const DRAFT_ID_PREFIX = "draft:";
let draftIdSeq = 0;

export function isDraftId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(DRAFT_ID_PREFIX);
}

/** Gives every cost without an id a client one. */
export function withDraftIds(
  list: readonly DealDeductionInput[],
): DealDeductionInput[] {
  return list.map((d) =>
    d.id ? d : { ...d, id: `${DRAFT_ID_PREFIX}${++draftIdSeq}` },
  );
}

/** The list as the server takes it: client ids dropped. */
export function stripDraftIds(
  list: readonly DealDeductionInput[],
): DealDeductionInput[] {
  return list.map((d) => {
    if (!isDraftId(d.id)) return d;
    const sent = { ...d };
    delete sent.id;
    return sent;
  });
}
