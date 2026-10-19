import { describe, expect, it, vi } from "vitest";

import { ensureEntityDefaultPrimaryTerms } from "../ensure-entity-default-primary-terms";
import type {
  PayoutTermsRecord,
  PayoutTermsLineRecord,
} from "@th/ports/repos/payout-terms";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { TxRepos } from "@th/ports/repos";

const NOW = new Date("2025-01-01T00:00:00.000Z");
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const HUMAN_ID = "00000000-0000-4000-8000-0000000000b2";
const PAYEE_ID = "00000000-0000-4000-8000-0000000000b3";
const ENTITY_DEFAULT_ID = "00000000-0000-4000-8000-0000000000b4";

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
  payee?: PayeeRecord | null;
  orgDefaultPrimary?: string | null;
  humanDefaultPrimary?: string | null;
  /** Seed rows resolvable via payoutTerms.getById. */
  termsById?: Record<string, PayoutTermsRecord>;
}

function buildTx(options: FakeOptions = {}) {
  const payee = options.payee === undefined ? buildPayee() : options.payee;
  let orgDefault = options.orgDefaultPrimary ?? null;
  let humanDefault = options.humanDefaultPrimary ?? null;
  const termsById = new Map<string, PayoutTermsRecord>(
    Object.entries(options.termsById ?? {}),
  );
  const linesByTerms = new Map<string, PayoutTermsLineRecord[]>();

  const provisionDefaultPrimary = vi.fn(
    async (input: {
      payeeId: string;
      settlementCurrency: string;
      isDefault: boolean;
      payoutSchedule?: PayoutTermsRecord["payoutSchedule"];
    }) => {
      const record: PayoutTermsRecord = {
        id: ENTITY_DEFAULT_ID,
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
      termsById.set(ENTITY_DEFAULT_ID, record);
      linesByTerms.set(ENTITY_DEFAULT_ID, [
        {
          id: "line-1",
          payoutTermsId: ENTITY_DEFAULT_ID,
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

  const linkPayoutTerms = vi.fn(async () => undefined);
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
      orgSetIfNull,
      humanSetIfNull,
      markNotDefault,
      auditLog,
    },
    getOrgDefault: () => orgDefault,
    getHumanDefault: () => humanDefault,
    setOrgDefault: (v: string | null) => {
      orgDefault = v;
    },
    seedTerms: (record: PayoutTermsRecord) => {
      termsById.set(record.id, record);
    },
  };
}

describe("ensureEntityDefaultPrimaryTerms", () => {
  it("provisions an ACTIVE PRIMARY default for an org and sets the pointer (never event-linked)", async () => {
    const f = buildTx();

    const result = await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "ORGANIZATION", id: ORG_ID },
      NOW,
    );

    expect(result?.id).toBe(ENTITY_DEFAULT_ID);
    expect(result?.isDefault).toBe(true);
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenCalledWith({
      payeeId: PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: true,
    });
    expect(f.getOrgDefault()).toBe(ENTITY_DEFAULT_ID);
    // The entity default is NEVER linked to an event.
    expect(f.mocks.linkPayoutTerms).not.toHaveBeenCalled();
    expect(f.mocks.auditLog).toHaveBeenCalledTimes(1);
  });

  it("provisions and sets the pointer for a human, using payee defaultCurrency", async () => {
    const f = buildTx({
      payee: buildPayee({
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        defaultCurrency: "cad",
      }),
    });

    await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "HUMAN", id: HUMAN_ID },
      NOW,
    );

    expect(f.mocks.provisionDefaultPrimary).toHaveBeenCalledWith({
      payeeId: PAYEE_ID,
      settlementCurrency: "cad",
      isDefault: true,
    });
    expect(f.getHumanDefault()).toBe(ENTITY_DEFAULT_ID);
  });

  it("is an idempotent no-op when the entity already has a default", async () => {
    const existing: PayoutTermsRecord = {
      id: "existing-default",
      kind: "PRIMARY",
      status: "ACTIVE",
    } as PayoutTermsRecord;
    const f = buildTx({
      orgDefaultPrimary: "existing-default",
      termsById: { "existing-default": existing },
    });

    const result = await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "ORGANIZATION", id: ORG_ID },
      NOW,
    );

    expect(result?.id).toBe("existing-default");
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
    expect(f.mocks.orgUpdate).not.toHaveBeenCalled();
    expect(f.mocks.auditLog).not.toHaveBeenCalled();
  });

  it("returns null when there is no payee", async () => {
    const f = buildTx({ payee: null });

    const result = await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "ORGANIZATION", id: ORG_ID },
      NOW,
    );

    expect(result).toBeNull();
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
    expect(f.mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it("returns null when the payee is not ACTIVE / not payoutsEnabled", async () => {
    const f = buildTx({
      payee: buildPayee({ status: "PENDING", payoutsEnabled: false }),
    });

    const result = await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "ORGANIZATION", id: ORG_ID },
      NOW,
    );

    expect(result).toBeNull();
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  it("provisions with the requested payoutSchedule when the option is passed", async () => {
    const f = buildTx();

    const result = await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "ORGANIZATION", id: ORG_ID },
      NOW,
      undefined,
      { payoutSchedule: "ASAP" },
    );

    expect(f.mocks.provisionDefaultPrimary).toHaveBeenCalledWith({
      payeeId: PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: true,
      payoutSchedule: "ASAP",
    });
    expect(result?.payoutSchedule).toBe("ASAP");
  });

  it("ignores the payoutSchedule option when a default already exists (returned unchanged)", async () => {
    const existing: PayoutTermsRecord = {
      id: "existing-default",
      kind: "PRIMARY",
      status: "ACTIVE",
      payoutSchedule: "TWO_WEEKS_AFTER",
    } as PayoutTermsRecord;
    const f = buildTx({
      orgDefaultPrimary: "existing-default",
      termsById: { "existing-default": existing },
    });

    const result = await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "ORGANIZATION", id: ORG_ID },
      NOW,
      undefined,
      { payoutSchedule: "ASAP" },
    );

    expect(result?.id).toBe("existing-default");
    expect(result?.payoutSchedule).toBe("TWO_WEEKS_AFTER");
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  it("adopts the winner and retires its own row when the guarded pointer write loses a race", async () => {
    const WINNER_ID = "00000000-0000-4000-8000-0000000000b7";
    const winner: PayoutTermsRecord = {
      id: WINNER_ID,
      kind: "PRIMARY",
      status: "ACTIVE",
      isDefault: true,
      payoutSchedule: "TWO_WEEKS_AFTER",
    } as PayoutTermsRecord;

    const f = buildTx();
    f.seedTerms(winner);
    // Simulate the TOCTOU: our read saw NULL, but a concurrent transaction
    // (e.g. publish-event auto-provision) commits its pointer before our
    // guarded write → 0-match.
    f.mocks.orgSetIfNull.mockImplementation(async () => {
      f.setOrgDefault(WINNER_ID);
      return false;
    });

    const result = await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "ORGANIZATION", id: ORG_ID },
      NOW,
      undefined,
      { payoutSchedule: "ASAP" },
    );

    // The WINNER's row is returned — not our freshly provisioned one.
    expect(result?.id).toBe(WINNER_ID);
    expect(result?.payoutSchedule).toBe("TWO_WEEKS_AFTER");
    // Our row is retired so no `isDefault: true` orphan survives.
    expect(f.mocks.markNotDefault).toHaveBeenCalledWith(ENTITY_DEFAULT_ID);
    // The pointer is never overwritten unconditionally.
    expect(f.mocks.orgUpdate).not.toHaveBeenCalled();
    expect(f.getOrgDefault()).toBe(WINNER_ID);
    // No "created entity default" audit entry for the losing row.
    expect(f.mocks.auditLog).not.toHaveBeenCalled();
  });

  it("re-provisions when the default pointer is dangling (row deleted)", async () => {
    // Pointer set but getById returns null → treat as dangling and re-provision.
    const f = buildTx({ orgDefaultPrimary: "deleted-row" });

    const result = await ensureEntityDefaultPrimaryTerms(
      f.tx,
      { type: "ORGANIZATION", id: ORG_ID },
      NOW,
    );

    expect(result?.id).toBe(ENTITY_DEFAULT_ID);
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenCalledTimes(1);
    expect(f.getOrgDefault()).toBe(ENTITY_DEFAULT_ID);
  });
});
