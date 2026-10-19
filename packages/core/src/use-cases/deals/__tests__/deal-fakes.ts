/**
 * In-memory repos for the deal use cases. They implement the PORT semantics
 * the use cases rely on — the per-order fence on `payoutTerms.listLines`, the
 * sheet's DRAFT lock, `replaceTermsDeal` keeping ids — and a transaction that
 * rolls the store back when its callback throws, so a refused write can be
 * shown to leave nothing behind. The real adapter is covered against Postgres
 * in packages/adapters/test/integration/deal-terms-and-settlement.test.ts.
 */
import { randomUUID } from "node:crypto";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type {
  DealClauseRecord,
  EventTicketLedgerRecord,
  PayoutTermsDealRecord,
  SettlementSheetRecord,
} from "@th/ports/repos/deals";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";
import type { OrgRole } from "@th/ports/repos/authz";
import type { Repos, TxRepos } from "@th/ports/repos";

import { buildAgreementRecord } from "../../booking-agreements/__tests__/helpers";
import { dealFingerprint } from "../_shared/deal-fingerprint";

export { buildAgreementRecord };

// ── Fixture ids ───────────────────────────────────────────────────────────

export const ACT_HUMAN = "11111111-1111-4111-8111-111111111111"; // Lowlight's human (the act)
export const VENUE_ORG = "22222222-2222-4222-8222-222222222222"; // Marrow Hall
export const VENUE_ADMIN = "23232323-2323-4323-8323-232323232323";
export const VENUE_EDITOR = "24242424-2424-4424-8424-242424242424";
export const VENUE_VIEWER = "25252525-2525-4525-8525-252525252525";
export const VENUE_FINANCE = "26262626-2626-4626-8626-262626262626";
export const VENUE_SCANNER = "27272727-2727-4727-8727-272727272727";
export const SUPPORT_HUMAN = "77777777-7777-4777-8777-777777777777"; // Paper Moth — a payee, not a party
export const SOUND_ORG = "78787878-7878-4878-8878-787878787878"; // fronted the sound — a payee, not a party
export const SOUND_ADMIN = "79797979-7979-4979-8979-797979797979";
export const OUTSIDER = "99999999-9999-4999-8999-999999999999";

export const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
export const TERMS_ID = "66666666-6666-4666-8666-666666666666";
export const EVENT_ID = "44444444-4444-4444-8444-444444444444";
export const REQUEST_ID = "44444444-4444-4444-8444-111111111111";

export const NOW = new Date("2026-10-03T12:00:00.000Z");
export const SHOW_STARTS = new Date("2026-10-02T20:00:00.000Z");
export const SHOW_ENDS = new Date("2026-10-02T23:00:00.000Z");

// ── The store ─────────────────────────────────────────────────────────────

export type FakeEvent = {
  id: string;
  orgId: string | null;
  humanId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  payoutTermsId: string | null;
  currency: string | null;
  status: string;
  publishedAt: Date | null;
  // freeze-the-deal (FR-001). Absent = not frozen.
  dealFrozenAt?: Date | null;
  dealFrozenByHumanId?: string | null;
  resalePayoutTermsId?: string | null;
  title?: string;
  timezone?: string | null;
};

/** A stored DealChange row (freeze-the-deal FR-005). */
export type FakeDealChange = {
  id: string;
  eventId: string;
  actorHumanId: string | null;
  createdAt: Date;
  before: unknown;
  after: unknown;
};

export type Store = {
  humans: Set<string>;
  orgs: Set<string>;
  memberships: Array<{ orgId: string; humanId: string; role: OrgRole }>;
  /** Human delegations: a delegate acting for a human principal. */
  delegations: Array<{ principalId: string; delegateId: string; role: OrgRole }>;
  /** Org status (ACTIVE when absent). */
  orgStatus: Map<string, string>;
  /** Organization.defaultPrimaryPayoutTermsId. */
  orgDefaults: Map<string, string>;
  /** Place.defaultPrimaryPayoutTermsId (placeId → terms). */
  placeDefaults: Map<string, string>;
  payees: Map<string, PayeeRecord>;
  agreements: Map<string, AgreementRecord>;
  requests: Map<string, BookingRequestRecord>;
  terms: Map<string, { isDefault: boolean; deal: PayoutTermsDealRecord }>;
  events: Map<string, FakeEvent>;
  ticketTypes: Map<string, Array<Record<string, unknown>>>;
  sheets: Map<string, SettlementSheetRecord>;
  ledger: Map<string, LedgerFixture>;
  audit: Array<{ action: string; data: unknown }>;
  /** Every lockTerms call, in order — so a test can see the lock came first. */
  locks: string[];
  /** freeze-the-deal: DealChange rows, in insertion order. */
  dealChanges: FakeDealChange[];
  /** Every events.lockRows call (ids), in order. */
  eventRowLocks: string[][];
};

export function emptyStore(): Store {
  return {
    humans: new Set(),
    orgs: new Set(),
    memberships: [],
    delegations: [],
    orgStatus: new Map(),
    orgDefaults: new Map(),
    placeDefaults: new Map(),
    payees: new Map(),
    agreements: new Map(),
    requests: new Map(),
    terms: new Map(),
    events: new Map(),
    ticketTypes: new Map(),
    sheets: new Map(),
    ledger: new Map(),
    audit: [],
    locks: [],
    dealChanges: [],
    eventRowLocks: [],
  };
}

export function addPayee(
  store: Store,
  subjectType: "HUMAN" | "ORGANIZATION",
  subjectId: string,
  id: string = randomUUID(),
): string {
  store.payees.set(id, {
    id,
    subjectType,
    subjectId,
    stripeAccountId: null,
    status: "ACTIVE",
    payoutsEnabled: true,
    chargesEnabled: true,
    defaultCurrency: "usd",
    resaleNegativeBalanceCents: 0,
    resaleNegativeBalanceOpenedAt: null,
    resaleNegativeBalanceAgingStartsAt: null,
    resalePayoutBlockReason: null,
    resalePayoutBlockedAt: null,
  });
  return id;
}

export function clauseRecord(
  overrides: Partial<DealClauseRecord> & Pick<DealClauseRecord, "payeeId">,
): DealClauseRecord {
  return {
    id: randomUUID(),
    payoutTermsId: TERMS_ID,
    amountType: "PERCENT",
    amountCents: null,
    percent: 0,
    basis: "GROSS",
    resolution: null,
    displayLabel: null,
    ticketTypeId: null,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    rounding: "FLOOR",
    requiresConfirmation: false,
    confirmationStatus: null,
    confirmedAt: null,
    counterPercentBps: null,
    counterNote: null,
    ...overrides,
  };
}

const sortLines = (lines: DealClauseRecord[]) =>
  [...lines].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Payees + parties for the standard booking: the act human, the venue org. */
export function standardStore(): Store & {
  actPayee: string;
  venuePayee: string;
  supportPayee: string;
  soundPayee: string;
} {
  const store = emptyStore();
  for (const h of [ACT_HUMAN, VENUE_ADMIN, VENUE_EDITOR, VENUE_VIEWER, VENUE_FINANCE, VENUE_SCANNER, SUPPORT_HUMAN, SOUND_ADMIN, OUTSIDER]) {
    store.humans.add(h);
  }
  store.orgs.add(VENUE_ORG);
  store.orgs.add(SOUND_ORG);
  store.memberships.push(
    { orgId: VENUE_ORG, humanId: VENUE_ADMIN, role: "ADMIN" },
    { orgId: VENUE_ORG, humanId: VENUE_EDITOR, role: "EDITOR" },
    { orgId: VENUE_ORG, humanId: VENUE_VIEWER, role: "VIEWER" },
    { orgId: VENUE_ORG, humanId: VENUE_FINANCE, role: "FINANCE" },
    { orgId: VENUE_ORG, humanId: VENUE_SCANNER, role: "SCANNER" },
    { orgId: SOUND_ORG, humanId: SOUND_ADMIN, role: "ADMIN" },
  );
  const actPayee = addPayee(store, "HUMAN", ACT_HUMAN, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const venuePayee = addPayee(store, "ORGANIZATION", VENUE_ORG, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  const supportPayee = addPayee(store, "HUMAN", SUPPORT_HUMAN, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const soundPayee = addPayee(store, "ORGANIZATION", SOUND_ORG, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");

  // TO_VENUE: proposer = the act (human), counterparty = the venue org.
  store.agreements.set(AGREEMENT_ID, buildAgreementRecord({ id: AGREEMENT_ID, payoutTermsId: TERMS_ID, counterpartyId: VENUE_ORG, proposerId: ACT_HUMAN }));
  store.requests.set(AGREEMENT_ID, {
    id: REQUEST_ID,
    agreementId: AGREEMENT_ID,
    performerOwnerType: "human",
    performerOwnerId: ACT_HUMAN,
    direction: "TO_VENUE",
  } as unknown as BookingRequestRecord);
  // Legacy terms: act 20% + venue 80%, per order, no remainder stored.
  store.terms.set(TERMS_ID, {
    isDefault: false,
    deal: {
      payoutTermsId: TERMS_ID,
      remainderPayeeId: null,
      clauses: sortLines([
        clauseRecord({ id: "a0000000-0000-4000-8000-000000000001", payeeId: actPayee, percent: 20 }),
        clauseRecord({ id: "a0000000-0000-4000-8000-000000000002", payeeId: venuePayee, percent: 80 }),
      ]),
      deductions: [],
    },
  });
  return { ...store, actPayee, venuePayee, supportPayee, soundPayee };
}

/** Link an ended event to the agreement's terms (a finalized booking). */
export function addFinalizedEvent(store: Store, overrides: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    id: EVENT_ID,
    orgId: VENUE_ORG,
    humanId: null,
    startsAt: SHOW_STARTS,
    endsAt: SHOW_ENDS,
    payoutTermsId: TERMS_ID,
    currency: "usd",
    status: "PUBLISHED",
    publishedAt: new Date("2026-09-01T12:00:00.000Z"),
    ...overrides,
  };
  store.events.set(event.id, event);
  const agreement = store.agreements.get(AGREEMENT_ID);
  if (agreement && event.payoutTermsId === agreement.payoutTermsId) {
    store.agreements.set(AGREEMENT_ID, { ...agreement, eventId: event.id, status: "ACCEPTED" });
  }
  return event;
}

// ── Repos over the store ──────────────────────────────────────────────────

type LedgerFixture = Omit<EventTicketLedgerRecord, "orders" | "disputes"> & {
  orders: Array<
    Omit<
      EventTicketLedgerRecord["orders"][number],
      "paymentChannel" | "refundedItemCents" | "feePolicySnapshot"
    > & {
      paymentChannel?: string;
      refundedItemCents?: number;
      /** Left out = an order sold before the 2026-10-11 ruling (no marker). */
      feePolicySnapshot?: unknown;
    }
  >;
  disputes?: EventTicketLedgerRecord["disputes"];
};

/** Fixtures may leave out the channel (WEB), the snapshot (null) and the disputes ([]). */
function withLedgerDefaults(ledger: LedgerFixture | undefined): EventTicketLedgerRecord {
  if (!ledger) return { orders: [], disputes: [], refundCount: 0, perPayee: [], currencies: [] };
  return {
    ...ledger,
    orders: ledger.orders.map((o) => ({
      paymentChannel: "WEB",
      refundedItemCents: 0,
      feePolicySnapshot: null,
      ...o,
    })),
    disputes: ledger.disputes ?? [],
  };
}

function sheetOf(store: Store, sheetId: string): SettlementSheetRecord | undefined {
  return [...store.sheets.values()].find((s) => s.id === sheetId);
}

export function makeRepos(store: Store): Repos {
  const txRepos = {
    humans: {
      getByIds: async (ids: string[]) =>
        ids.filter((id) => store.humans.has(id)).map((id) => ({ id, name: `Human ${id.slice(0, 4)}` })),
    },
    organizations: {
      getById: async (id: string) =>
        store.orgs.has(id)
          ? {
              id,
              name: `Org ${id.slice(0, 4)}`,
              status: store.orgStatus.get(id) ?? "ACTIVE",
              defaultPrimaryPayoutTermsId: store.orgDefaults.get(id) ?? null,
            }
          : null,
      setDefaultPrimaryPayoutTermsIdIfNull: async ({ id, payoutTermsId }: { id: string; payoutTermsId: string }) => {
        if (store.orgDefaults.has(id)) return false;
        store.orgDefaults.set(id, payoutTermsId);
        return true;
      },
      update: async ({ id, defaultPrimaryPayoutTermsId }: { id: string; defaultPrimaryPayoutTermsId?: string }) => {
        if (defaultPrimaryPayoutTermsId) store.orgDefaults.set(id, defaultPrimaryPayoutTermsId);
      },
      getByIds: async (ids: string[]) =>
        ids.filter((id) => store.orgs.has(id)).map((id) => ({ id, name: `Org ${id.slice(0, 4)}` })),
      // One page holds every member (the fixtures are small).
      listMembers: async ({ orgId }: { orgId: string; limit: number; offset: number }) => {
        const items = store.memberships
          .filter((m) => m.orgId === orgId)
          .map((m) => ({ orgId: m.orgId, humanId: m.humanId, role: m.role }));
        return { items, total: items.length };
      },
    },
    authz: {
      getOrgMembership: async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
        store.memberships.find((m) => m.orgId === orgId && m.humanId === humanId) ?? null,
      getOrgMemberships: async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        store.memberships.filter((m) => orgIds.includes(m.orgId) && m.humanId === humanId),
      getHumanDelegation: async ({ principalId, delegateId }: { principalId: string; delegateId: string }) =>
        store.delegations.find((d) => d.principalId === principalId && d.delegateId === delegateId) ?? null,
    },
    payees: {
      getById: async (id: string) => store.payees.get(id) ?? null,
      getByIds: async (ids: string[]) =>
        [...new Set(ids)].map((id) => store.payees.get(id)).filter((p): p is PayeeRecord => !!p),
      getBySubject: async ({ type, id }: { type: string; id: string }) => {
        const found = [...store.payees.values()].find((p) => p.subjectType === type && p.subjectId === id);
        return found ? { id: found.id } : null;
      },
      upsertForSubject: async ({ subjectType, subjectId }: { subjectType: "HUMAN" | "ORGANIZATION"; subjectId: string }) => {
        const found = [...store.payees.values()].find(
          (p) => p.subjectType === subjectType && p.subjectId === subjectId,
        );
        if (found) return found;
        const id = addPayee(store, subjectType, subjectId);
        return store.payees.get(id)!;
      },
    },
    agreements: {
      getById: async (id: string) => store.agreements.get(id) ?? null,
      getByEventId: async (eventId: string) =>
        [...store.agreements.values()].find((a) => a.eventId === eventId) ?? null,
      getByPayoutTermsId: async (payoutTermsId: string) =>
        [...store.agreements.values()].find((a) => a.payoutTermsId === payoutTermsId) ?? null,
      // As the port promises: the finalized link first, the draft anchor on a miss.
      findByLinkedEventId: async (eventId: string) =>
        [...store.agreements.values()].find((a) => a.eventId === eventId) ??
        [...store.agreements.values()].find((a) => a.draftEventId === eventId) ??
        null,
      findManyByLinkedEventIds: async (eventIds: readonly string[]) =>
        [...store.agreements.values()].filter(
          (a) =>
            (a.eventId !== null && eventIds.includes(a.eventId)) ||
            (a.draftEventId !== null && a.draftEventId !== undefined && eventIds.includes(a.draftEventId)),
        ),
      // The adapter's status-guarded CAS (FR-001's derived guarantee writes here).
      updateHeader: async ({ id, expectedFrom, ...fields }: { id: string; expectedFrom: readonly string[] } & Partial<AgreementRecord>) => {
        const a = store.agreements.get(id);
        if (!a || !expectedFrom.includes(a.status)) {
          throw { code: "conflict", message: "agreement_status_changed" };
        }
        const next = { ...a, ...fields, updatedAt: NOW };
        store.agreements.set(id, next);
        return next;
      },
    },
    bookingRequests: {
      findByAgreementId: async (agreementId: string) => store.requests.get(agreementId) ?? null,
    },
    events: {
      getById: async (id: string) => {
        const e = store.events.get(id);
        return e ? { ...e } : null;
      },
      lockRows: async ({ ids }: { ids: string[] }) => {
        store.eventRowLocks.push([...ids]);
      },
      listTicketTypes: async (eventId: string) => store.ticketTypes.get(eventId) ?? [],
      findByPayoutTermsId: async (payoutTermsId: string) =>
        [...store.events.values()].find((e) => e.payoutTermsId === payoutTermsId) ?? null,
      linkPayoutTerms: async ({ eventId, payoutTermsId }: { eventId: string; payoutTermsId: string }) => {
        const e = store.events.get(eventId)!;
        store.events.set(eventId, { ...e, payoutTermsId });
      },
    },
    payoutTerms: {
      getById: async (id: string) => {
        const t = store.terms.get(id);
        return t ? { id, isDefault: t.isDefault, remainderPayeeId: t.deal.remainderPayeeId } : null;
      },
      createDraft: async () => {
        const id = randomUUID();
        store.terms.set(id, {
          isDefault: false,
          deal: { payoutTermsId: id, remainderPayeeId: null, clauses: [], deductions: [] },
        });
        return { id, isDefault: false };
      },
      provisionDefaultPrimary: async ({ payeeId, isDefault }: { payeeId: string; isDefault: boolean }) => {
        const id = randomUUID();
        store.terms.set(id, {
          isDefault,
          deal: {
            payoutTermsId: id,
            remainderPayeeId: null,
            clauses: [clauseRecord({ payoutTermsId: id, payeeId, percent: 100 })],
            deductions: [],
          },
        });
        return { id, isDefault };
      },
      markNotDefault: async (id: string) => {
        const t = store.terms.get(id);
        if (t) t.isDefault = false;
      },
      // THE FR-005 FENCE, as the port promises it.
      listLines: async (id: string): Promise<PayoutTermsLineRecord[]> =>
        (store.terms.get(id)?.deal.clauses ?? [])
          .filter((c) => c.amountType === "PERCENT" && c.basis === "GROSS")
          .map((c) => ({
            id: c.id,
            payoutTermsId: c.payoutTermsId,
            payeeId: c.payeeId,
            ticketTypeId: c.ticketTypeId,
            percent: c.percent as number,
            floorCents: c.floorCents,
            capPercent: c.capPercent,
            priority: c.priority,
            rounding: c.rounding,
            requiresConfirmation: c.requiresConfirmation,
            confirmationStatus: c.confirmationStatus,
            confirmedAt: c.confirmedAt,
            counterPercentBps: c.counterPercentBps,
            counterNote: c.counterNote,
            amountType: "PERCENT" as const,
            basis: "GROSS" as const,
          })),
    },
    audit: {
      log: async (entry: { action: string; data: unknown }) => {
        store.audit.push({ action: entry.action, data: entry.data });
      },
    },
    deals: {
      lockTerms: async (id: string) => {
        store.locks.push(id);
        return store.terms.has(id);
      },
      getTermsDeal: async (id: string) => {
        const t = store.terms.get(id);
        return t ? structuredClone(t.deal) : null;
      },
      listTermsReferences: async (payoutTermsId: string) => [
        ...[...store.agreements.values()]
          .filter((a) => a.payoutTermsId === payoutTermsId)
          .map((a) => ({ kind: "AGREEMENT" as const, id: a.id })),
        ...[...store.events.values()]
          .filter((e) => e.payoutTermsId === payoutTermsId)
          .map((e) => ({ kind: "EVENT_PRIMARY" as const, id: e.id })),
        ...[...store.orgDefaults.entries()]
          .filter(([, t]) => t === payoutTermsId)
          .map(([id]) => ({ kind: "ORG_DEFAULT_PRIMARY" as const, id })),
        ...[...store.placeDefaults.entries()]
          .filter(([, t]) => t === payoutTermsId)
          .map(([id]) => ({ kind: "PLACE_DEFAULT_PRIMARY" as const, id })),
      ],
      // The adapter's guarded UPDATE: a settled-directly clause on this terms
      // row that requires confirmation and is in an expected status.
      answerDealClause: async (input: {
        payoutTermsId: string;
        clauseId: string;
        expectedFrom: ReadonlyArray<"PENDING" | null>;
        confirmationStatus: "CONFIRMED" | "DECLINED";
        confirmedAt: Date | null;
      }) => {
        const c = store.terms.get(input.payoutTermsId)?.deal.clauses.find((x) => x.id === input.clauseId);
        if (!c || !c.requiresConfirmation) return false;
        if (c.amountType === "PERCENT" && c.basis === "GROSS") return false;
        if (!input.expectedFrom.includes(c.confirmationStatus as "PENDING" | null)) return false;
        Object.assign(c, {
          confirmationStatus: input.confirmationStatus,
          confirmedAt: input.confirmedAt,
          counterPercentBps: null,
          counterNote: null,
        });
        return true;
      },
      linkEventPrimaryTermsIfUnset: async ({ eventId, payoutTermsId }: { eventId: string; payoutTermsId: string }) => {
        const e = store.events.get(eventId);
        if (!e || e.payoutTermsId !== null) return false;
        store.events.set(eventId, { ...e, payoutTermsId });
        return true;
      },
      replaceTermsDeal: async (input: {
        payoutTermsId: string;
        remainderPayeeId: string;
        clauses: Array<Omit<DealClauseRecord, "payoutTermsId">>;
        deductions: Array<Record<string, unknown> & { id: string }>;
      }) => {
        const t = store.terms.get(input.payoutTermsId)!;
        t.deal = {
          payoutTermsId: input.payoutTermsId,
          remainderPayeeId: input.remainderPayeeId,
          clauses: sortLines(input.clauses.map((c) => ({ ...c, payoutTermsId: input.payoutTermsId }))),
          deductions: input.deductions.map((d, sortOrder) => ({
            ...(d as never as Omit<PayoutTermsDealRecord["deductions"][number], "payoutTermsId" | "sortOrder">),
            payoutTermsId: input.payoutTermsId,
            sortOrder,
          })),
        };
      },
      getSheetByEventId: async (eventId: string) => {
        const s = store.sheets.get(eventId);
        return s ? structuredClone(s) : null;
      },
      ensureSheet: async (eventId: string) => {
        let s = store.sheets.get(eventId);
        if (!s) {
          s = {
            id: randomUUID(),
            eventId,
            status: "DRAFT",
            settledByHumanId: null,
            settledAt: null,
            engineVersion: null,
            snapshot: null,
            revision: 0,
            reopenedAt: null,
            reopenedByHumanId: null,
            offPlatform: [],
            deductionActuals: [],
            directPayments: [],
          };
          store.sheets.set(eventId, s);
        }
        return { id: s.id };
      },
      lockDraftSheet: async (sheetId: string) => {
        const s = sheetOf(store, sheetId);
        if (!s || s.status !== "DRAFT") return false;
        s.revision += 1;
        return true;
      },
      lockSettledSheet: async (sheetId: string) => {
        const s = sheetOf(store, sheetId);
        if (!s || s.status !== "SETTLED") return false;
        s.revision += 1;
        return true;
      },
      upsertOffPlatform: async (input: Record<string, unknown> & { sheetId: string; id?: string }) => {
        const s = sheetOf(store, input.sheetId)!;
        const { sheetId: _s, ...row } = input;
        if (input.id) {
          const i = s.offPlatform.findIndex((o) => o.id === input.id);
          if (i < 0) return null;
          s.offPlatform[i] = { ...s.offPlatform[i]!, ...(row as object) } as never;
          return s.offPlatform[i]!;
        }
        const created = { ...(row as object), id: randomUUID() } as SettlementSheetRecord["offPlatform"][number];
        s.offPlatform.push(created);
        return created;
      },
      deleteOffPlatform: async (sheetId: string, rowId: string) => {
        const s = sheetOf(store, sheetId)!;
        const before = s.offPlatform.length;
        s.offPlatform = s.offPlatform.filter((o) => o.id !== rowId);
        return s.offPlatform.length < before;
      },
      upsertDeductionActual: async (input: { sheetId: string; deductionId: string; amountCents: number; enteredByHumanId: string; enteredAt: Date }) => {
        const s = sheetOf(store, input.sheetId)!;
        const existing = s.deductionActuals.find((a) => a.deductionId === input.deductionId);
        if (existing) {
          Object.assign(existing, { amountCents: input.amountCents, enteredByHumanId: input.enteredByHumanId, enteredAt: input.enteredAt });
          return existing;
        }
        const row = { id: randomUUID(), deductionId: input.deductionId, amountCents: input.amountCents, enteredByHumanId: input.enteredByHumanId, enteredAt: input.enteredAt };
        s.deductionActuals.push(row);
        return row;
      },
      deleteDeductionActual: async (sheetId: string, deductionId: string) => {
        const s = sheetOf(store, sheetId)!;
        const before = s.deductionActuals.length;
        s.deductionActuals = s.deductionActuals.filter((a) => a.deductionId !== deductionId);
        return s.deductionActuals.length < before;
      },
      createDirectPayment: async (input: Record<string, unknown> & { sheetId: string }) => {
        const s = sheetOf(store, input.sheetId)!;
        const { sheetId: _s, ...rest } = input;
        const row = { ...(rest as object), id: randomUUID() } as SettlementSheetRecord["directPayments"][number];
        s.directPayments.push(row);
        return row;
      },
      deleteDirectPayment: async (sheetId: string, paymentId: string) => {
        const s = sheetOf(store, sheetId)!;
        const before = s.directPayments.length;
        s.directPayments = s.directPayments.filter((d) => d.id !== paymentId);
        return s.directPayments.length < before;
      },
      markSheetSettled: async (input: { sheetId: string; settledByHumanId: string; settledAt: Date; engineVersion: number; snapshot: unknown }) => {
        const s = sheetOf(store, input.sheetId);
        if (!s || s.status !== "DRAFT") return false;
        // Round-trip through JSON, as a Json column does.
        Object.assign(s, {
          status: "SETTLED",
          settledByHumanId: input.settledByHumanId,
          settledAt: input.settledAt,
          engineVersion: input.engineVersion,
          snapshot: JSON.parse(JSON.stringify(input.snapshot)),
        });
        return true;
      },
      reopenSheet: async (input: { sheetId: string; reopenedByHumanId: string; reopenedAt: Date }) => {
        const s = sheetOf(store, input.sheetId);
        if (!s || s.status !== "SETTLED") return false;
        Object.assign(s, {
          status: "DRAFT",
          settledByHumanId: null,
          settledAt: null,
          engineVersion: null,
          snapshot: null,
          reopenedAt: input.reopenedAt,
          reopenedByHumanId: input.reopenedByHumanId,
        });
        return true;
      },
      readEventTicketLedger: async (eventId: string): Promise<EventTicketLedgerRecord> =>
        withLedgerDefaults(store.ledger.get(eventId)),
      // ── freeze-the-deal ── the adapter's guarded UPDATE and the change log.
      freezeEventDealIfUnfrozen: async (input: {
        eventId: string;
        frozenAt: Date;
        frozenByHumanId: string | null;
      }) => {
        const e = store.events.get(input.eventId);
        if (!e || e.dealFrozenAt) return false;
        store.events.set(input.eventId, {
          ...e,
          dealFrozenAt: input.frozenAt,
          dealFrozenByHumanId: input.frozenByHumanId,
        });
        return true;
      },
      createDealChange: async (input: {
        eventId: string;
        actorHumanId: string;
        before: unknown;
        after: unknown;
        createdAt: Date;
      }) => {
        // Round-trip through JSON, as a Json column does.
        const row: FakeDealChange = {
          id: randomUUID(),
          eventId: input.eventId,
          actorHumanId: input.actorHumanId,
          createdAt: input.createdAt,
          before: JSON.parse(JSON.stringify(input.before)),
          after: JSON.parse(JSON.stringify(input.after)),
        };
        store.dealChanges.push(row);
        return { ...row };
      },
      listDealChanges: async ({ eventId, limit, cursor }: { eventId: string; limit: number; cursor?: string | null }) => {
        const all = store.dealChanges
          .filter((c) => c.eventId === eventId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
        const start = cursor ? all.findIndex((c) => c.id === cursor) + 1 : 0;
        const page = all.slice(start, start + limit);
        return {
          items: page.map((c) => ({ ...c })),
          nextCursor: all.length > start + limit ? (page[page.length - 1]?.id ?? null) : null,
        };
      },
      listDealChangeSnapshots: async (eventId: string) =>
        store.dealChanges
          .filter((c) => c.eventId === eventId)
          .map((c) => ({ before: c.before, after: c.after })),
    },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: async <T,>(fn: (tx: TxRepos) => Promise<T>): Promise<T> => {
      const saved = structuredClone({
        payees: store.payees,
        terms: store.terms,
        sheets: store.sheets,
        audit: store.audit,
        events: store.events,
        orgDefaults: store.orgDefaults,
        agreements: store.agreements,
        dealChanges: store.dealChanges,
      });
      try {
        return await fn(txRepos);
      } catch (err) {
        // Roll back, as Postgres would.
        store.payees = saved.payees;
        store.terms = saved.terms;
        store.sheets = saved.sheets;
        store.audit = saved.audit;
        store.events = saved.events;
        store.orgDefaults = saved.orgDefaults;
        store.agreements = saved.agreements;
        store.dealChanges = saved.dealChanges;
        throw err;
      }
    },
  } as unknown as Repos;
  return repos;
}

export const clock = { now: () => NOW };

/**
 * What an editor's `getTermsDeal` read would hand back as the deal's
 * fingerprint right now (null when the target has no terms yet): the
 * `expectedDealFingerprint` a non-stale `setTermsDeal` sends.
 */
export function currentFingerprint(store: Store, target: unknown): string | null {
  const t = target as { kind: string; agreementId?: string; eventId?: string; orgId?: string };
  const termsId =
    t.kind === "BOOKING_AGREEMENT"
      ? (store.agreements.get(t.agreementId as string)?.payoutTermsId ?? null)
      : t.kind === "EVENT"
        ? (store.events.get(t.eventId as string)?.payoutTermsId ?? null)
        : (store.orgDefaults.get(t.orgId as string) ?? null);
  const deal = termsId ? store.terms.get(termsId)?.deal : undefined;
  return deal ? dealFingerprint(deal) : null;
}

/** Thrown → its { code, message } (AppError or legacy KnownError). */
export async function caught(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message?: string };
  }
  throw new Error("expected a refusal, got success");
}
