import { describe, expect, it, vi } from "vitest";

import { ensureEntityDefaultPayoutTermsForAccount } from "../ensure-entity-default-payout-terms-for-account";
import type { EnsureEntityDefaultPayoutTermsForAccountDeps } from "../ensure-entity-default-payout-terms-for-account";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { PayoutTermsRecord } from "@th/ports/repos/payout-terms";
import type { TxRepos } from "@th/ports/repos";

const NOW = new Date("2025-01-01T00:00:00.000Z");
const STRIPE_ACCT = "acct_eager_123";
const ORG_ID = "00000000-0000-4000-8000-0000000000c1";
const PAYEE_ID = "00000000-0000-4000-8000-0000000000c2";
const ENTITY_DEFAULT_ID = "00000000-0000-4000-8000-0000000000c3";

function buildPayee(overrides: Partial<PayeeRecord> = {}): PayeeRecord {
  return {
    id: PAYEE_ID,
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    stripeAccountId: STRIPE_ACCT,
    status: "ACTIVE",
    chargesEnabled: true,
    payoutsEnabled: true,
    defaultCurrency: "usd",
    ...overrides,
  } satisfies PayeeRecord;
}

interface FakeOptions {
  payee?: PayeeRecord | null;
  /** Pre-existing entity default pointer (idempotency). */
  orgDefaultPrimary?: string | null;
  /** Seed rows resolvable via payoutTerms.getById. */
  termsById?: Record<string, PayoutTermsRecord>;
  /** Force the tx to throw, to exercise defensive non-throwing behaviour. */
  txThrows?: boolean;
}

function buildDeps(options: FakeOptions = {}) {
  const payee = options.payee === undefined ? buildPayee() : options.payee;
  let orgDefault = options.orgDefaultPrimary ?? null;
  const termsById = new Map<string, PayoutTermsRecord>(
    Object.entries(options.termsById ?? {}),
  );

  const provisionDefaultPrimary = vi.fn(
    async (input: { isDefault: boolean; settlementCurrency: string }) => {
      const record: PayoutTermsRecord = {
        id: ENTITY_DEFAULT_ID,
        kind: "PRIMARY",
        status: "ACTIVE",
        feeMode: null,
        feePolicyId: null,
        isDefault: input.isDefault,
        settlementCurrency: input.settlementCurrency,
        payoutSchedule: "WEEK_OF_EVENT",
        resaleProcessingFeeConfigRef: null,
        resalePayoutReleaseDays: 7,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      termsById.set(ENTITY_DEFAULT_ID, record);
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

  const getByStripeAccountId = vi.fn(async () => payee);

  const tx = {
    payoutTerms: {
      getById: vi.fn(async (id: string) => termsById.get(id) ?? null),
      provisionDefaultPrimary,
    },
    payees: {
      getBySubject: vi.fn(async () => (payee ? { id: payee.id } : null)),
      getById: vi.fn(async (id: string) =>
        payee && payee.id === id ? { ...payee } : null,
      ),
    },
    organizations: {
      getById: vi.fn(async () => ({
        id: ORG_ID,
        defaultPrimaryPayoutTermsId: orgDefault,
      })),
      update: orgUpdate,
      // Guarded IS-NULL CAS pointer write (mirrors the Prisma adapter).
      setDefaultPrimaryPayoutTermsIdIfNull: vi.fn(
        async ({ payoutTermsId }: { id: string; payoutTermsId: string }) => {
          if (orgDefault !== null) return false;
          orgDefault = payoutTermsId;
          return true;
        },
      ),
    },
    humans: {
      getById: vi.fn(async () => null),
      update: vi.fn(async () => ({}) as any),
      setDefaultPrimaryPayoutTermsIdIfNull: vi.fn(async () => true),
    },
    audit: { log: vi.fn(async () => undefined) },
  } as unknown as TxRepos;

  const txRunner = vi.fn(async <T,>(fn: (t: TxRepos) => Promise<T>) => {
    if (options.txThrows) {
      throw new Error("boom");
    }
    return fn(tx);
  });

  const deps: EnsureEntityDefaultPayoutTermsForAccountDeps = {
    repos: {
      tx: txRunner as unknown as TxRepos["tx"] & {
        <T>(fn: (t: TxRepos) => Promise<T>): Promise<T>;
      },
      payees: { getByStripeAccountId } as any,
      organizations: tx.organizations as any,
      humans: tx.humans as any,
      payoutTerms: tx.payoutTerms as any,
      audit: tx.audit as any,
    } as any,
    clock: { now: () => NOW } as any,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      withTime: vi.fn(),
    } as any,
  };

  return {
    deps,
    mocks: { getByStripeAccountId, provisionDefaultPrimary, orgUpdate, txRunner },
    getOrgDefault: () => orgDefault,
  };
}

describe("ensureEntityDefaultPayoutTermsForAccount", () => {
  it("resolves the payee by stripeAccountId and provisions the entity default when ACTIVE", async () => {
    const f = buildDeps();

    const result = await ensureEntityDefaultPayoutTermsForAccount(f.deps, {
      stripeAccountId: STRIPE_ACCT,
    });

    expect(f.mocks.getByStripeAccountId).toHaveBeenCalledWith(STRIPE_ACCT);
    expect(result).toEqual({
      payeeUsable: true,
      payoutTermsId: ENTITY_DEFAULT_ID,
    });
    expect(f.mocks.provisionDefaultPrimary).toHaveBeenCalledWith({
      payeeId: PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: true,
    });
    expect(f.getOrgDefault()).toBe(ENTITY_DEFAULT_ID);
  });

  it("is a no-op when the entity already has a default", async () => {
    const existing: PayoutTermsRecord = {
      id: "existing-default",
      kind: "PRIMARY",
      status: "ACTIVE",
    } as PayoutTermsRecord;
    const f = buildDeps({
      orgDefaultPrimary: "existing-default",
      termsById: { "existing-default": existing },
    });

    const result = await ensureEntityDefaultPayoutTermsForAccount(f.deps, {
      stripeAccountId: STRIPE_ACCT,
    });

    expect(result).toEqual({
      payeeUsable: true,
      payoutTermsId: "existing-default",
    });
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
    expect(f.mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it("no-ops (does not open a tx) when the payee is not ACTIVE", async () => {
    const f = buildDeps({
      payee: buildPayee({ status: "PENDING", payoutsEnabled: false }),
    });

    const result = await ensureEntityDefaultPayoutTermsForAccount(f.deps, {
      stripeAccountId: STRIPE_ACCT,
    });

    expect(result).toEqual({ payeeUsable: false, payoutTermsId: null });
    expect(f.mocks.txRunner).not.toHaveBeenCalled();
    expect(f.mocks.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  it("no-ops when no payee matches the stripe account", async () => {
    const f = buildDeps({ payee: null });

    const result = await ensureEntityDefaultPayoutTermsForAccount(f.deps, {
      stripeAccountId: STRIPE_ACCT,
    });

    expect(result).toEqual({ payeeUsable: false, payoutTermsId: null });
    expect(f.mocks.txRunner).not.toHaveBeenCalled();
  });

  it("never throws — swallows errors and returns a benign result", async () => {
    const f = buildDeps({ txThrows: true });

    const result = await ensureEntityDefaultPayoutTermsForAccount(f.deps, {
      stripeAccountId: STRIPE_ACCT,
    });

    expect(result).toEqual({ payeeUsable: false, payoutTermsId: null });
  });
});
