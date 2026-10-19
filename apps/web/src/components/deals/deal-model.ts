import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// THE DEAL — the pure half of the deal builder (deal-terms-and-settlement
// FR-003). Everything here is a decision the components draw; nothing here
// does money math. Amounts are only ever moved from the server's read into
// the server's write, or printed: the calculator's numbers come from
// `deals.projectTermsDeal`, never from this file.
// ─────────────────────────────────────────────────────────────────────────────

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RouterInputs = inferRouterInputs<AppRouter>;

export type DealRead = RouterOutputs["deals"]["getTermsDeal"];
export type DealProjection = RouterOutputs["deals"]["projectTermsDeal"];
/** A projection that ran: the server had ticket numbers to work from. */
export type DealProjected = Extract<DealProjection, { needsTiers: false }>;
/** Why the server had none: no event yet, or an event with no ACTIVE ticket types. */
export type NeedsTiersReason = Extract<
  DealProjection,
  { needsTiers: true }
>["reason"];

/**
 * The calculator's answer to "from the event's ticket types": the reason it
 * must ask for typed numbers instead, or null when the projection ran.
 */
export function needsTiersReasonOf(
  data: DealProjection | undefined,
): NeedsTiersReason | null {
  return data?.needsTiers ? data.reason : null;
}
export type DealTarget = RouterInputs["deals"]["getTermsDeal"]["target"];
export type DealWrite = RouterInputs["deals"]["setTermsDeal"]["deal"];
export type DealTiers = NonNullable<
  RouterInputs["deals"]["projectTermsDeal"]["tiers"]
>;

export type DealClauseRead = DealRead["clauses"][number];
export type DealDeductionRead = DealRead["deductions"][number];
export type DealPayeeRead = DealRead["payees"][number];
export type DealNotEditableReason = NonNullable<DealRead["notEditableReason"]>;

type CustomClauses = Extract<DealWrite, { source: "CLAUSES" }>;
export type DealClauseInput = CustomClauses["clauses"][number];
export type DealDeductionInput = CustomClauses["deductions"][number];
export type DealPayeeRef = CustomClauses["remainder"];

export type DealAmountType = DealClauseInput["amountType"];
export type DealBasis = DealClauseInput["basis"];
export type DealResolution = NonNullable<DealClauseInput["resolution"]>;
export type DealDeductionKind = DealDeductionInput["kind"];

/** Someone the editor can name: a party to the terms or a suggested payee. */
export type DealPerson = {
  ref: DealPayeeRef;
  name: string;
  /** Where a suggestion came from, for its caption ("From the bill"). */
  source?: "party" | "bill" | "lineup";
};

export const DEAL_PRESETS = [
  "GUARANTEE",
  "DOOR_SPLIT",
  "GUARANTEE_PLUS_PERCENT",
  "VERSUS",
  "STRAIGHT_PERCENT",
  "ROOM_RENTAL",
] as const;
export type DealPresetKey = (typeof DEAL_PRESETS)[number];

/** Which preset fields a preset asks for. */
export const PRESET_FIELDS: Record<
  DealPresetKey,
  { guarantee: boolean; percent: boolean; basis: boolean; rental: boolean }
> = {
  GUARANTEE: { guarantee: true, percent: false, basis: false, rental: false },
  DOOR_SPLIT: { guarantee: false, percent: true, basis: false, rental: false },
  GUARANTEE_PLUS_PERCENT: {
    guarantee: true,
    percent: true,
    basis: true,
    rental: false,
  },
  VERSUS: { guarantee: true, percent: true, basis: true, rental: false },
  STRAIGHT_PERCENT: {
    guarantee: false,
    percent: true,
    basis: false,
    rental: false,
  },
  ROOM_RENTAL: { guarantee: false, percent: false, basis: false, rental: true },
};

/** The default basis a preset writes when none is chosen (core deal-presets.ts). */
export const PRESET_DEFAULT_BASIS: Record<
  "GUARANTEE_PLUS_PERCENT" | "VERSUS",
  DealBasis
> = {
  GUARANTEE_PLUS_PERCENT: "GROSS",
  VERSUS: "NET_POOL",
};

// ─────────────────────────────────────────────────────────────────────────────
// Refs and names
// ─────────────────────────────────────────────────────────────────────────────

export const refKey = (ref: DealPayeeRef): string => `${ref.kind}:${ref.id}`;

export const sameRef = (
  a: DealPayeeRef | null | undefined,
  b: DealPayeeRef | null | undefined,
) => !!a && !!b && a.kind === b.kind && a.id === b.id;

/** A payee row from the read → the ref a write names it by. */
export function refOfPayee(
  payee: Pick<DealPayeeRead, "subjectType" | "subjectId">,
): DealPayeeRef {
  return {
    kind: payee.subjectType === "organization" ? "org" : "human",
    id: payee.subjectId,
  };
}

export function payeeById(
  payees: readonly DealPayeeRead[],
  payeeId: string,
): DealPayeeRead | undefined {
  return payees.find((p) => p.payeeId === payeeId);
}

export function refOfPayeeId(
  payees: readonly DealPayeeRead[],
  payeeId: string,
): DealPayeeRef | null {
  const payee = payeeById(payees, payeeId);
  return payee ? refOfPayee(payee) : null;
}

/**
 * The name to print for a payee. Falls back to the party / suggestion list
 * (which the host names), then to `fallback` — never to an id.
 */
export function nameOfPayeeId(
  payees: readonly DealPayeeRead[],
  people: readonly DealPerson[],
  payeeId: string,
  fallback: string,
): string {
  const payee = payeeById(payees, payeeId);
  if (payee?.displayName) return payee.displayName;
  if (payee) {
    const ref = refOfPayee(payee);
    const person = people.find((p) => sameRef(p.ref, ref));
    if (person) return person.name;
  }
  return fallback;
}

export function nameOfRef(
  payees: readonly DealPayeeRead[],
  people: readonly DealPerson[],
  ref: DealPayeeRef,
  fallback: string,
): string {
  const person = people.find((p) => sameRef(p.ref, ref));
  if (person) return person.name;
  const payee = payees.find((p) => sameRef(refOfPayee(p), ref));
  return payee?.displayName ?? fallback;
}

export function isPartyRef(
  parties: readonly DealPerson[],
  ref: DealPayeeRef,
): boolean {
  return parties.some((p) => sameRef(p.ref, ref));
}

// ─────────────────────────────────────────────────────────────────────────────
// Read → write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who takes the rest (and owes any shortfall). The stored remainder when the
 * read names one; else the first party the host passed.
 */
export function remainderRefOf(
  read: DealRead | null,
  parties: readonly DealPerson[],
): DealPayeeRef | null {
  if (read?.remainder) {
    const ref = refOfPayeeId(read.payees, read.remainder.payeeId);
    if (ref) return ref;
  }
  return parties[0]?.ref ?? null;
}

/**
 * The clauses a write keeps, as typed terms. The remainder holder's derived
 * per-order line ("the rest" of each order) is left out: every deal write
 * derives it, and the server refuses it typed.
 */
export function clauseInputsOf(read: DealRead): DealClauseInput[] {
  const out: DealClauseInput[] = [];
  for (const c of read.clauses) {
    if (c.role === "REMAINDER_PER_ORDER") continue;
    const payee = refOfPayeeId(read.payees, c.payeeId);
    if (!payee) continue;
    out.push(clauseInputOf(c, payee));
  }
  return out;
}

export function clauseInputOf(
  c: DealClauseRead,
  payee: DealPayeeRef,
): DealClauseInput {
  return {
    id: c.id,
    payee,
    amountType: c.amountType,
    amountCents: c.amountType === "PERCENT" ? null : c.amountCents,
    percent: c.amountType === "FIXED" ? null : c.percent,
    basis: c.basis,
    resolution: c.amountType === "FIXED_AND_PERCENT" ? c.resolution : null,
    displayLabel: c.displayLabel,
  };
}

export function deductionInputsOf(read: DealRead): DealDeductionInput[] {
  const out: DealDeductionInput[] = [];
  for (const d of read.deductions) {
    const creditedPayee = refOfPayeeId(read.payees, d.creditedPayeeId);
    if (!creditedPayee) continue;
    out.push({
      id: d.id,
      kind: d.kind,
      label: d.label,
      amountCents: d.amountCents,
      percent: d.percent,
      creditedPayee,
      estimated: d.estimated,
    });
  }
  return out;
}

/** The whole deal, typed clause by clause: what every row edit sends. */
export function clausesWrite(args: {
  clauses: DealClauseInput[];
  deductions: DealDeductionInput[];
  remainder: DealPayeeRef;
}): DealWrite {
  return {
    source: "CLAUSES",
    clauses: args.clauses,
    deductions: args.deductions,
    remainder: args.remainder,
  };
}

/** The values a preset form collects. Amounts are integer cents. */
export type PresetValues = {
  preset: DealPresetKey;
  /** The act (every preset but ROOM_RENTAL); the place for ROOM_RENTAL. */
  payee: DealPayeeRef;
  remainder: DealPayeeRef;
  guaranteeCents?: number;
  percent?: number;
  basis?: DealBasis;
  rentalCents?: number;
  rentalMode?: "FIXED_FEE" | "RECOUPED_FROM_DOOR";
};

/**
 * A preset write. The preset replaces the act's clause; everything else on
 * the deal is carried over so nothing disappears without being seen:
 *   - other payees' clauses ride along as `extraClauses` (a support act's
 *     10% survives switching the headliner from a guarantee to a versus);
 *   - costs off the top stay, except that ROOM_RENTAL brings its own rental,
 *     so an earlier rental cost is dropped rather than counted twice.
 */
export function presetWrite(
  values: PresetValues,
  read: DealRead | null,
): DealWrite {
  const carriedClauses = read
    ? clauseInputsOf(read).filter(
        (c) =>
          !sameRef(c.payee, values.payee) &&
          !sameRef(c.payee, values.remainder),
      )
    : [];
  const carriedDeductions = read
    ? deductionInputsOf(read).filter(
        (d) => !(values.preset === "ROOM_RENTAL" && d.kind === "RENTAL"),
      )
    : [];

  if (values.preset === "ROOM_RENTAL") {
    return {
      source: "PRESET",
      preset: {
        preset: "ROOM_RENTAL",
        venue: values.payee,
        renter: values.remainder,
        rentalCents: values.rentalCents ?? 0,
        mode: values.rentalMode ?? "RECOUPED_FROM_DOOR",
      },
      extraClauses: carriedClauses,
      deductions: carriedDeductions,
    };
  }

  const act = values.payee;
  let preset: Extract<DealWrite, { source: "PRESET" }>["preset"];
  switch (values.preset) {
    case "GUARANTEE":
      preset = {
        preset: "GUARANTEE",
        act,
        guaranteeCents: values.guaranteeCents ?? 0,
      };
      break;
    case "DOOR_SPLIT":
      preset = { preset: "DOOR_SPLIT", act, percent: values.percent ?? 0 };
      break;
    case "STRAIGHT_PERCENT":
      preset = {
        preset: "STRAIGHT_PERCENT",
        act,
        percent: values.percent ?? 0,
      };
      break;
    case "GUARANTEE_PLUS_PERCENT":
    case "VERSUS":
      preset = {
        preset: values.preset,
        act,
        guaranteeCents: values.guaranteeCents ?? 0,
        percent: values.percent ?? 0,
        basis: values.basis ?? PRESET_DEFAULT_BASIS[values.preset],
      };
      break;
  }
  return {
    source: "PRESET",
    preset,
    remainder: values.remainder,
    extraClauses: carriedClauses,
    deductions: carriedDeductions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What the deal looks like now
// ─────────────────────────────────────────────────────────────────────────────

/** The clauses a person reads as "the deal": everything but the derived rest. */
export function visibleClauses(read: DealRead): DealClauseRead[] {
  return read.clauses.filter((c) => c.role !== "REMAINDER_PER_ORDER");
}

/**
 * The rest is paid as tickets sell: the remainder holder has a derived
 * per-order line (role REMAINDER_PER_ORDER) that the server classifies as
 * paid through Ithas Fire. Without one, the rest waits for settlement.
 */
export function restPaidPerOrder(read: DealRead): boolean {
  return read.clauses.some(
    (c) => c.role === "REMAINDER_PER_ORDER" && c.stage1 === "PAID_PER_ORDER",
  );
}

/**
 * The deal says nothing about money yet: no clause and no cost, so all of it
 * goes to whoever takes the rest. The terms strip calls this "no money terms"
 * (board B07) instead of listing a lone "the rest".
 */
export function hasNoMoneyTerms(read: DealRead): boolean {
  return visibleClauses(read).length === 0 && read.deductions.length === 0;
}

/**
 * Whether the "Settled directly" note belongs under the clauses: only when a
 * row on screen carries that stamp, i.e. a clause the server classifies as
 * SETTLED_DIRECTLY, or the rest (when it is shown) without a paid-per-order
 * line. Costs off the top are not a reason on their own: a deal whose every
 * line is paid as tickets sell settles nothing directly, which is what the
 * calculator says too. Read off the server's per-clause classification; no
 * money is worked out here.
 */
export function showsSettledDirectlyNote(
  read: DealRead,
  restShown: boolean,
): boolean {
  return (
    visibleClauses(read).some((c) => c.stage1 === "SETTLED_DIRECTLY") ||
    (restShown && !restPaidPerOrder(read))
  );
}

/**
 * The preset the deal currently has the shape of, for the picker's
 * highlight. Read from the first clause that isn't the remainder holder's —
 * the act's — or from a rental cost when there is no such clause. Null when
 * the deal matches no preset (nothing highlighted; the clauses still say
 * exactly what it is).
 */
export function currentPresetOf(read: DealRead | null): DealPresetKey | null {
  if (!read) return null;
  const remainderId = read.remainder?.payeeId ?? null;
  const own = visibleClauses(read).filter((c) => c.payeeId !== remainderId);
  if (own.length === 0) {
    return read.deductions.some((d) => d.kind === "RENTAL")
      ? "ROOM_RENTAL"
      : null;
  }
  const c = own[0]!;
  if (c.amountType === "FIXED") return "GUARANTEE";
  if (c.amountType === "PERCENT")
    return c.basis === "NET_POOL" ? "DOOR_SPLIT" : "STRAIGHT_PERCENT";
  return c.resolution === "GREATER_OF" ? "VERSUS" : "GUARANTEE_PLUS_PERCENT";
}

/**
 * Who a preset may name as the act, in order: people already on the deal,
 * the bill's suggestions, then the parties. The parties close the list so a
 * deal holding only the rest holder, with an empty bill, still offers the
 * other party instead of opening on "Choose…".
 */
export function presetCandidates(
  dealPeople: readonly DealPerson[],
  suggestions: readonly DealPerson[],
  parties: readonly DealPerson[],
): DealPerson[] {
  return [...dealPeople, ...suggestions, ...parties];
}

/** The presets with a fixed amount for the act: a guarantee to start from. */
const PRESETS_WITH_GUARANTEE: readonly DealPresetKey[] = [
  "GUARANTEE",
  "GUARANTEE_PLUS_PERCENT",
  "VERSUS",
];

/**
 * The preset form's starting values, taken from the deal as it stands.
 * `fallbackGuaranteeCents` is a guarantee already on file elsewhere (the
 * agreement header, before any deal sets it): it fills a guaranteed preset
 * only while the deal has no clause for the act yet.
 */
export function presetDefaults(
  preset: DealPresetKey,
  read: DealRead | null,
  parties: readonly DealPerson[],
  candidates: readonly DealPerson[],
  fallbackGuaranteeCents: number | null = null,
): Partial<PresetValues> {
  const remainder = remainderRefOf(read, parties) ?? undefined;
  const remainderId = read?.remainder?.payeeId ?? null;
  const first = read
    ? visibleClauses(read).find((c) => c.payeeId !== remainderId)
    : undefined;
  const actFromDeal =
    read && first ? refOfPayeeId(read.payees, first.payeeId) : null;
  const actFromList =
    candidates.find((p) => !sameRef(p.ref, remainder))?.ref ?? null;
  const payee = actFromDeal ?? actFromList ?? undefined;
  const basis =
    preset === "VERSUS" || preset === "GUARANTEE_PLUS_PERCENT"
      ? first?.amountType === "FIXED_AND_PERCENT"
        ? first.basis
        : PRESET_DEFAULT_BASIS[preset]
      : undefined;
  return {
    preset,
    payee,
    remainder,
    guaranteeCents: first
      ? first.amountType !== "PERCENT"
        ? (first.amountCents ?? undefined)
        : undefined
      : PRESETS_WITH_GUARANTEE.includes(preset)
        ? (fallbackGuaranteeCents ?? undefined)
        : undefined,
    percent:
      first && first.amountType !== "FIXED"
        ? (first.percent ?? undefined)
        : undefined,
    basis,
    rentalCents:
      read?.deductions.find((d) => d.kind === "RENTAL")?.amountCents ??
      undefined,
    rentalMode: "RECOUPED_FROM_DOOR",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agreement state per clause
// ─────────────────────────────────────────────────────────────────────────────

export type ClauseAgreement =
  | { kind: "WITH_THE_TERMS" }
  | { kind: "WAITING" }
  | { kind: "AGREED" }
  | { kind: "COUNTERED" }
  | { kind: "DECLINED" };

/**
 * Where a clause's payee stands. A party's clause comes with the terms
 * themselves; a third party agrees their own line (PENDING until they do).
 */
export function clauseAgreementOf(
  c: Pick<DealClauseRead, "requiresConfirmation" | "confirmationStatus">,
): ClauseAgreement {
  if (!c.requiresConfirmation) return { kind: "WITH_THE_TERMS" };
  switch (c.confirmationStatus) {
    case "CONFIRMED":
      return { kind: "AGREED" };
    case "DECLINED":
      return { kind: "DECLINED" };
    case "COUNTERED":
      return { kind: "COUNTERED" };
    default:
      return { kind: "WAITING" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain words (NFR-003: every percent says what it is of)
// ─────────────────────────────────────────────────────────────────────────────

export type ClauseShape = Pick<
  DealClauseInput,
  "amountType" | "amountCents" | "percent" | "basis" | "resolution"
>;

/**
 * The catalog keys and values that put a clause in plain words: `main` is
 * the bold part ("$800 guarantee vs 70% of the pool"), `tail` the rest
 * (", whichever is greater"). Amounts are cents; the renderer formats them.
 */
export type ClauseWords = {
  mainKey: string;
  tailKey: string | null;
  amountCents: number | null;
  percent: number | null;
};

export function clauseWordsOf(c: ClauseShape): ClauseWords {
  const pool = c.basis === "NET_POOL";
  if (c.amountType === "FIXED") {
    return {
      mainKey: "deals.clauseFixed",
      tailKey: null,
      amountCents: c.amountCents ?? 0,
      percent: null,
    };
  }
  if (c.amountType === "PERCENT") {
    return {
      mainKey: pool ? "deals.clausePercentPool" : "deals.clausePercentTickets",
      tailKey: null,
      amountCents: null,
      percent: c.percent ?? 0,
    };
  }
  const greater = c.resolution === "GREATER_OF";
  return {
    mainKey: greater
      ? pool
        ? "deals.clauseVersusPool"
        : "deals.clauseVersusTickets"
      : pool
        ? "deals.clausePlusPool"
        : "deals.clausePlusTickets",
    tailKey: greater ? "deals.clauseVersusTail" : null,
    amountCents: c.amountCents ?? 0,
    percent: c.percent ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calculator inputs
// ─────────────────────────────────────────────────────────────────────────────

/** One "if we sell N at $P" row as typed. */
export type TierDraft = { tickets: string; price: string };

export const MAX_PROJECTED_TICKETS = 10_000_000;

/**
 * Typed rows → the projection's tiers. Null while any row is blank or
 * unreadable: the calculator then keeps showing the last answer it had
 * instead of guessing a number nobody typed.
 */
export function tiersFromDrafts(
  drafts: readonly TierDraft[],
  parsePrice: (raw: string) => number | null,
): DealTiers | null {
  if (drafts.length === 0) return null;
  const tiers: DealTiers = [];
  for (const d of drafts) {
    const ticketsText = d.tickets.trim();
    if (!/^\d{1,8}$/.test(ticketsText)) return null;
    const tickets = Number(ticketsText);
    if (tickets > MAX_PROJECTED_TICKETS) return null;
    const unitBasisCents = parsePrice(d.price);
    if (unitBasisCents === null) return null;
    tiers.push({ tickets, unitBasisCents });
  }
  return tiers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settling up, in words
// ─────────────────────────────────────────────────────────────────────────────

export type SettleLine = { payeeId: string; cents: number };

/**
 * Who pays whom directly, from the server's per-payee "settle directly"
 * figures (+ is owed TO the payee, − they owe). When exactly one payee owes,
 * the sentence is "X pays A $… and B $… directly"; otherwise each payee gets
 * their own line, because pairing several payers to several payees is a
 * choice the parties make, not one this screen should invent.
 */
export function settleSummaryOf(
  lines: readonly SettleLine[],
):
  | { kind: "NONE" }
  | { kind: "ONE_PAYER"; payerId: string; payees: SettleLine[] }
  | { kind: "EACH"; owes: SettleLine[]; owed: SettleLine[] } {
  const owed = lines.filter((l) => l.cents > 0);
  const owes = lines.filter((l) => l.cents < 0);
  if (owed.length === 0 && owes.length === 0) return { kind: "NONE" };
  if (owes.length === 1 && owed.length > 0) {
    return { kind: "ONE_PAYER", payerId: owes[0]!.payeeId, payees: owed };
  }
  return { kind: "EACH", owes, owed };
}
