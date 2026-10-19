import { describe, expect, it, vi } from "vitest";

import { ensureDefaultPrimaryPayoutTerms } from "../ensure-default-primary-payout-terms";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  PayoutTermsRecord,
  PayoutTermsLineRecord,
} from "@th/ports/repos/payout-terms";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { TxRepos } from "@th/ports/repos";

const NOW = new Date("2025-01-01T00:00:00.000Z");
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const HUMAN_ID = "00000000-0000-4000-8000-0000000000a2";
const EVENT_ID = "00000000-0000-4000-8000-0000000000a3";
const PAYEE_ID = "00000000-0000-4000-8000-0000000000a4";
// Provisioned ids are minted sequentially: first the entity default, then the
// event-owned row. They MUST be distinct (separate rows).
const ENTITY_DEFAULT_ID = "00000000-0000-4000-8000-0000000000a5";
const EVENT_TERMS_ID = "00000000-0000-4000-8000-0000000000a6";

function buildEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    ...overrides,
  } as unknown as EventRecord;
}

function buildPayee(overrides: Partial<PayeeRecord> = {}): PayeeRecord {
  return {
    id: PAYEE_ID,
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    stripeAccountId: "acct_test",
    status: "ACTIVE",
    chargesEnabled: true,
    payoutsEnabled: true,
    defaultCurrency: "usd",
    ...overrides,
  } satisfies PayeeRecord;
}

interface FakeOptions {
  event?: EventRecord;
  payee?: PayeeRecord | null;
  /** Agreements already linked to the event (resolved by listByEvent). */
  linkedAgreements?: PayoutTermsRecord[];
  orgDefaultPrimary?: string | null;
  humanDefaultPrimary?: string | null;
}

function buildTx(options: FakeOptions = {}) {
  const linked = (options.linkedAgreements ?? []).map((a) => ({ ...a }));
  const linesByTerms = new Map<string, PayoutTermsLineRecord[]>();
  const termsById = new Map<string, PayoutTermsRecord>();
  const payee = options.payee === undefined ? buildPayee() : options.payee;

  let orgDefault = options.orgDefaultPrimary ?? null;
  let humanDefault = options.humanDefaultPrimary ?? null;

  // Deterministic id sequence so we can distinguish the entity default row
  // (first call, isDefault:true) from the event-owned row (second call,
  // isDefault:false).
  const idQueue = [ENTITY_DEFAULT_ID, EVENT_TERMS_ID];

  const provisionDefaultPrimary = vi.fn(
    async (input: {
      payeeId: string;
      settlementCurrency: string;
      isDefault: boolean;
      payoutSchedule?: PayoutTermsRecord["payoutSchedule"];
    }) => {
      const id = idQueue.shift() ?? `provisioned-${termsById.size}`;
      const record: PayoutTermsRecord = {
        id,
        kind: "PRIMARY",
        status: "ACTIVE",
        feeMode: null,
        feePolicyId: null,
        isDefault: input.isDefault,
        settlementCurrency: input.settlementCurrency,
        payoutSchedule: input.payoutSchedule ?? "WEEK_OF_EVENT",
        resaleProcessingFeeConfigRef: null,
        resalePayoutReleaseDays: 7,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      termsById.set(id, record);
      linesByTerms.set(id, [
        {
          id: `line-${id}`,
          payoutTermsId: id,
          payeeId: input.payeeId,
          ticketTypeId: null,
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
          requiresConfirmation: false,
          confirmationStatus: null,
          confirmedAt: null,
          counterPercentBps: null,
          counterNote: null,
        },
      ]);
      return record;
    },
  );

  const linkPayoutTerms = vi.fn(
    async ({ payoutTermsId }: { payoutTermsId: string }) => {
      linked.push({
        id: payoutTermsId,
        kind: "PRIMARY",
        status: "ACTIVE",
      } as PayoutTermsRecord);
    },
  );

  const orgUpdate = vi.fn(
    async (input: {
      id: string;
      defaultPrimaryPayoutTermsId?: string | null;
    }) => {
      if (input.defaultPrimaryPayoutTermsId !== undefined) {
        orgDefault = input.defaultPrimaryPayoutTermsId;
      }
      return { id: input.id, defaultPrimaryPayoutTermsId: orgDefault } as any;
    },
  );

  const humanUpdate = vi.fn(
    async (
      _id: string,
      updates: { defaultPrimaryPayoutTermsId?: string | null },
    ) => {
      if (updates.defaultPrimaryPayoutTermsId !== undefined) {
        humanDefault = updates.defaultPrimaryPayoutTermsId;
      }
      return { id: _id, defaultPrimaryPayoutTermsId: humanDefault } as any;
    },
  );

  const auditLog = vi.fn(async () => undefined);

  const markNotDefault = vi.fn(async (id: string) => {
    const row = termsById.get(id);
    if (row) termsById.set(id, { ...row, isDefault: false });
  });

  // Guarded IS-NULL CAS pointer writes (mirror the Prisma adapter semantics).
  const orgSetIfNull = vi.fn(
    async ({ payoutTermsId }: { id: string; payoutTermsId: string }) => {
      if (orgDefault !== null) return false;
      orgDefault = payoutTermsId;
      return true;
    },
  );
  const humanSetIfNull = vi.fn(
    async ({ payoutTermsId }: { id: string; payoutTermsId: string }) => {
      if (humanDefault !== null) return false;
      humanDefault = payoutTermsId;
      return true;
    },
  );

  const tx = {
    payoutTerms: {
      listByEvent: vi.fn(async () => linked.map((a) => ({ ...a }))),
      getById: vi.fn(async (id: string) => termsById.get(id) ?? null),
      provisionDefaultPrimary,
      markNotDefault,
    },
    payees: {
      getBySubject: vi.fn(async () => (payee ? { id: payee.id } : null)),
      getById: vi.fn(async (id: string) =>
        payee && payee.id === id ? { ...payee } : null,
      ),
    },
    events: { linkPayoutTerms },
    organizations: {
      getById: vi.fn(async () => ({
        id: ORG_ID,
        defaultPrimaryPayoutTermsId: orgDefault,
      })),
      update: orgUpdate,
      setDefaultPrimaryPayoutTermsIdIfNull: orgSetIfNull,
    },
    humans: {
      getById: vi.fn(async () => ({
        id: HUMAN_ID,
        defaultPrimaryPayoutTermsId: humanDefault,
      })),
      update: humanUpdate,
      setDefaultPrimaryPayoutTermsIdIfNull: humanSetIfNull,
    },
    audit: { log: auditLog },
  } as unknown as TxRepos;

  return {
    tx,
    mocks: {
      provisionDefaultPrimary,
      linkPayoutTerms,
      orgUpdate,
      humanUpdate,
      auditLog,
    },
    getOrgDefault: () => orgDefault,
    getHumanDefault: () => humanDefault,
  };
}

describe("ensureDefaultPrimaryPayoutTerms", () => {
  it("provisions a SEPARATE event-owned row and an entity default row for an org event", async () => {
    const f = buildTx();

    const result = await ensureDefaultPrimaryPayoutTerms(
      f.tx,
      buildEvent(),
      NOW,
    );

    // Returns the EVENT-owned row (second provision), not the entity default.
    expect(result?.id).toBe(EVENT_TERMS_ID);
    expect(result?.isDefault).toBe(false);

    // Two distinct rows were provisioned: entity default (isDefault:true) and
    // the event-owned row (isDefault:false).
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenCalledTimes(2);
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenNthCalledWith(1, {
      payeeId: PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: true,
    });
    // The event-owned row inherits the entity default's payout schedule.
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenNthCalledWith(2, {
      payeeId: PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: false,
      payoutSchedule: "WEEK_OF_EVENT",
    });

    // Only the EVENT-owned row is linked to the event. The entity default is
    // NEVER event-linked.
    expect(f.mocks.linkPayoutTerms).toHaveBeenCalledTimes(1);
    expect(f.mocks.linkPayoutTerms).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      payoutTermsId: EVENT_TERMS_ID,
      kind: "PRIMARY",
    });

    // The entity default pointer is the entity default row — never the event row.
    expect(f.getOrgDefault()).toBe(ENTITY_DEFAULT_ID);
    expect(f.getOrgDefault()).not.toBe(EVENT_TERMS_ID);
  });

  it("uses the payee defaultCurrency and sets the human entity default", async () => {
    const f = buildTx({
      event: buildEvent({ orgId: null, humanId: HUMAN_ID }),
      payee: buildPayee({
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        defaultCurrency: "cad",
      }),
    });

    await ensureDefaultPrimaryPayoutTerms(
      f.tx,
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
      NOW,
    );

    expect(f.mocks.provisionDefaultPrimary).toHaveBeenNthCalledWith(1, {
      payeeId: PAYEE_ID,
      settlementCurrency: "cad",
      isDefault: true,
    });
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenNthCalledWith(2, {
      payeeId: PAYEE_ID,
      settlementCurrency: "cad",
      isDefault: false,
      payoutSchedule: "WEEK_OF_EVENT",
    });
    expect(f.getHumanDefault()).toBe(ENTITY_DEFAULT_ID);
  });

  it("returns null and does nothing when there is no payee", async () => {
    const f = buildTx({ payee: null });

    const result = await ensureDefaultPrimaryPayoutTerms(
      f.tx,
      buildEvent(),
      NOW,
    );

    expect(result).toBeNull();
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
    expect(f.mocks.linkPayoutTerms).not.toHaveBeenCalled();
  });

  it("returns null when the payee is not ACTIVE", async () => {
    const f = buildTx({
      payee: buildPayee({ status: "PENDING", payoutsEnabled: false }),
    });

    const result = await ensureDefaultPrimaryPayoutTerms(
      f.tx,
      buildEvent(),
      NOW,
    );

    expect(result).toBeNull();
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  it("is a no-op when the event already links an ACTIVE PRIMARY", async () => {
    const existing: PayoutTermsRecord = {
      id: "existing-primary",
      kind: "PRIMARY",
      status: "ACTIVE",
    } as PayoutTermsRecord;
    const f = buildTx({ linkedAgreements: [existing] });

    const result = await ensureDefaultPrimaryPayoutTerms(
      f.tx,
      buildEvent(),
      NOW,
    );

    expect(result?.id).toBe("existing-primary");
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
    expect(f.mocks.linkPayoutTerms).not.toHaveBeenCalled();
  });

  it("is a no-op when the event already links a PENDING PRIMARY (builder draft)", async () => {
    // The dynamic agreement builder authors a PENDING primary. Auto-provision
    // must NOT see "no ACTIVE primary" and clobber it.
    const builderDraft: PayoutTermsRecord = {
      id: "builder-draft",
      kind: "PRIMARY",
      status: "PENDING",
    } as PayoutTermsRecord;
    const f = buildTx({ linkedAgreements: [builderDraft] });

    const result = await ensureDefaultPrimaryPayoutTerms(
      f.tx,
      buildEvent(),
      NOW,
    );

    expect(result?.id).toBe("builder-draft");
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
    expect(f.mocks.linkPayoutTerms).not.toHaveBeenCalled();
    expect(f.mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it("does not re-provision the entity default when one already exists, but still creates the event row (inheriting its schedule)", async () => {
    const f = buildTx({ orgDefaultPrimary: "pre-existing-default" });
    // Seed the pre-existing default so getById resolves it (idempotent no-op
    // inside ensureEntityDefaultPrimaryTerms). Its schedule differs from the
    // schema default so inheritance is observable.
    (f.tx.payoutTerms.getById as any).mockImplementation(async (id: string) =>
      id === "pre-existing-default"
        ? ({
            id,
            kind: "PRIMARY",
            status: "ACTIVE",
            payoutSchedule: "ASAP",
          } as PayoutTermsRecord)
        : null,
    );

    const result = await ensureDefaultPrimaryPayoutTerms(
      f.tx,
      buildEvent(),
      NOW,
    );

    // Only ONE provision call: the event-owned row. The entity default already
    // existed so it was returned unchanged (no second provision for it) — and
    // the event row inherits ITS payout schedule.
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenCalledTimes(1);
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenCalledWith({
      payeeId: PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: false,
      payoutSchedule: "ASAP",
    });
    // Event row was minted first off the queue here (only one call).
    expect(result?.id).toBe(ENTITY_DEFAULT_ID);
    expect(result?.isDefault).toBe(false);
    // Entity default pointer untouched.
    expect(f.mocks.orgUpdate).not.toHaveBeenCalled();
    expect(f.getOrgDefault()).toBe("pre-existing-default");
    // The event-owned row IS linked.
    expect(f.mocks.linkPayoutTerms).toHaveBeenCalledTimes(1);
  });
});
