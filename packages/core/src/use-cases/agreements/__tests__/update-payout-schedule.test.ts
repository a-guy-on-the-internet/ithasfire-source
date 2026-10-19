import { describe, expect, it, vi } from "vitest";

import { updatePayoutSchedule } from "../update-payout-schedule";
import type { UpdatePayoutScheduleDeps } from "../update-payout-schedule";
import type { TxRepos } from "@th/ports/repos";
import type { OrganizationRecord } from "@th/types/repos/organizations";
import type { PayoutTermsRecord } from "@th/ports/repos/payout-terms";

const ACTOR_ID = "aaaa0000-0000-4000-8000-000000000001";
const ORG_ID = "bbbb0000-0000-4000-8000-000000000002";
const OLD_PT_ID = "cccc0000-0000-4000-8000-000000000003";
const NEW_PT_ID = "dddd0000-0000-4000-8000-000000000004";
const PROVISIONED_PT_ID = "eeee0000-0000-4000-8000-000000000005";
const PAYEE_ID = "ffff0000-0000-4000-8000-000000000006";

const ORG: OrganizationRecord = {
  id: ORG_ID,
  name: "Test Org",
  slug: "test-org",
  status: "ACTIVE",
  defaultLocale: null,
  defaultPrimaryPayoutTermsId: OLD_PT_ID,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW",
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date(),
};

const OLD_PT: PayoutTermsRecord = {
  id: OLD_PT_ID,
  kind: "PRIMARY",
  status: "ACTIVE",
  feeMode: null,
  feePolicyId: null,
  isDefault: true,
  settlementCurrency: "usd",
  payoutSchedule: "WEEK_OF_EVENT",
  resaleProcessingFeeConfigRef: null,
  resalePayoutReleaseDays: 7,
  version: 1,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

type FakePayee = {
  id: string;
  status: string;
  payoutsEnabled: boolean;
  defaultCurrency: string | null;
};

function makeDeps(overrides?: {
  org?: OrganizationRecord | null;
  existing?: PayoutTermsRecord | null;
  cloneResult?: PayoutTermsRecord | null;
  membership?: { role: string } | null;
  human?: {
    id: string;
    defaultPrimaryPayoutTermsId: string | null;
  } | null;
  /** Payee resolved by the on-demand provisioning path. `null` = no payee. */
  payee?: FakePayee | null;
}) {
  const org = overrides?.org === undefined ? ORG : overrides.org;
  const existing =
    overrides?.existing === undefined ? OLD_PT : overrides.existing;
  const cloneResult =
    overrides?.cloneResult === undefined
      ? ({ ...OLD_PT, id: NEW_PT_ID, version: 2 } as PayoutTermsRecord)
      : overrides.cloneResult;
  const membership =
    overrides?.membership === undefined
      ? { role: "OWNER" }
      : overrides.membership;
  const human =
    overrides?.human === undefined
      ? { id: ACTOR_ID, defaultPrimaryPayoutTermsId: OLD_PT_ID }
      : overrides.human;
  const payee =
    overrides?.payee === undefined
      ? {
          id: PAYEE_ID,
          status: "ACTIVE",
          payoutsEnabled: true,
          defaultCurrency: "usd",
        }
      : overrides.payee;

  // Rows minted by the on-demand provisioning path, resolvable via getById.
  let provisioned: PayoutTermsRecord | null = null;

  // Stateful pointers: the guarded IS-NULL writes below land in these, so a
  // re-read under the terms lock sees what the provisioning path committed.
  let currentOrg = org ? { ...org } : null;
  let currentHuman = human ? { ...human } : null;

  const txRepos = {
    deals: {
      // The terms row lock a deal write also takes (always succeeds here).
      lockTerms: vi.fn().mockResolvedValue(true),
    },
    organizations: {
      getById: vi.fn().mockImplementation(() => Promise.resolve(currentOrg)),
      update: vi
        .fn()
        .mockImplementation((input) => Promise.resolve({ ...ORG, ...input })),
      // Guarded IS-NULL CAS pointer write (mirrors the Prisma adapter): only
      // lands when the org currently has no default pointer.
      setDefaultPrimaryPayoutTermsIdIfNull: vi
        .fn()
        .mockImplementation(({ payoutTermsId }: { payoutTermsId: string }) => {
          if (!currentOrg || currentOrg.defaultPrimaryPayoutTermsId != null) {
            return Promise.resolve(false);
          }
          currentOrg = { ...currentOrg, defaultPrimaryPayoutTermsId: payoutTermsId };
          return Promise.resolve(true);
        }),
    },
    humans: {
      getById: vi.fn().mockImplementation(() => Promise.resolve(currentHuman)),
      update: vi
        .fn()
        .mockImplementation((id, patch) => Promise.resolve({ id, ...patch })),
      setDefaultPrimaryPayoutTermsIdIfNull: vi
        .fn()
        .mockImplementation(({ payoutTermsId }: { payoutTermsId: string }) => {
          if (!currentHuman || currentHuman.defaultPrimaryPayoutTermsId != null) {
            return Promise.resolve(false);
          }
          currentHuman = { ...currentHuman, defaultPrimaryPayoutTermsId: payoutTermsId };
          return Promise.resolve(true);
        }),
    },
    payoutTerms: {
      getById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(
            provisioned && provisioned.id === id ? provisioned : existing,
          ),
        ),
      provisionDefaultPrimary: vi
        .fn()
        .mockImplementation(
          (input: { payoutSchedule?: string; isDefault: boolean }) => {
            provisioned = {
              ...OLD_PT,
              id: PROVISIONED_PT_ID,
              isDefault: input.isDefault,
              payoutSchedule: (input.payoutSchedule ??
                "TWO_WEEKS_AFTER") as PayoutTermsRecord["payoutSchedule"],
            };
            return Promise.resolve(provisioned);
          },
        ),
      clone: vi
        .fn()
        .mockImplementation(({ payoutScheduleOverride }) =>
          Promise.resolve(
            cloneResult
              ? { ...cloneResult, payoutSchedule: payoutScheduleOverride }
              : null,
          ),
        ),
      markNotDefault: vi.fn().mockResolvedValue(undefined),
    },
    payees: {
      getBySubject: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(payee ? { id: payee.id } : null),
        ),
      getById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(payee && payee.id === id ? { ...payee } : null),
        ),
    },
    audit: {
      log: vi.fn().mockResolvedValue(undefined),
    },
    authz: {
      getOrgMembership: vi.fn().mockResolvedValue(membership),
    },
  };

  const repos = {
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as unknown as TxRepos),
    ),
    ...txRepos,
  };

  const deps: UpdatePayoutScheduleDeps = {
    repos: repos as unknown as UpdatePayoutScheduleDeps["repos"],
  };
  return { deps, repos, txRepos };
}

describe("updatePayoutSchedule", () => {
  it("runs inside a single transaction", async () => {
    const { deps, repos } = makeDeps();

    await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "org", orgId: ORG_ID },
      payoutSchedule: "TWO_WEEKS_AFTER",
    });

    expect(repos.tx).toHaveBeenCalledOnce();
  });

  it("clones with schedule override, resets confirmations, bumps version, marks source not-default, then re-points org", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "org", orgId: ORG_ID },
      payoutSchedule: "TWO_WEEKS_AFTER",
    });

    expect(txRepos.payoutTerms.clone).toHaveBeenCalledWith({
      sourcePayoutTermsId: OLD_PT_ID,
      payoutScheduleOverride: "TWO_WEEKS_AFTER",
      isDefault: true,
      resetConfirmations: true,
      bumpVersion: true,
      // The new default is a snapshot: it never carries ABSORB forward.
      resetFeeMode: true,
    });
    expect(txRepos.payoutTerms.markNotDefault).toHaveBeenCalledWith(OLD_PT_ID);
    expect(txRepos.organizations.update).toHaveBeenCalledWith({
      id: ORG_ID,
      defaultPrimaryPayoutTermsId: NEW_PT_ID,
    });

    // Source row is never mutated in place (no updatePayoutSchedule method
    // exists on the repo anymore).
    const ptMethods = txRepos.payoutTerms as Record<string, unknown>;
    expect(ptMethods.updatePayoutSchedule).toBeUndefined();

    expect(result).toEqual({
      payoutTermsId: NEW_PT_ID,
      payoutSchedule: "TWO_WEEKS_AFTER",
    });
  });

  it("calls clone before markNotDefault before organizations.update (ordering matters for FK)", async () => {
    const { deps, txRepos } = makeDeps();
    const callOrder: string[] = [];
    (txRepos.payoutTerms.clone as ReturnType<typeof vi.fn>).mockImplementation(
      ({ payoutScheduleOverride }) => {
        callOrder.push("clone");
        return Promise.resolve({
          ...OLD_PT,
          id: NEW_PT_ID,
          payoutSchedule: payoutScheduleOverride,
        });
      },
    );
    (
      txRepos.payoutTerms.markNotDefault as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      callOrder.push("markNotDefault");
      return Promise.resolve();
    });
    (
      txRepos.organizations.update as ReturnType<typeof vi.fn>
    ).mockImplementation((i) => {
      callOrder.push("org.update");
      return Promise.resolve({ ...ORG, ...i });
    });

    await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "org", orgId: ORG_ID },
      payoutSchedule: "ASAP",
    });

    expect(callOrder).toEqual(["clone", "markNotDefault", "org.update"]);
  });

  it("locks the source terms row BEFORE cloning it (a concurrent deal write holds the same lock)", async () => {
    const { deps, txRepos } = makeDeps();

    await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "org", orgId: ORG_ID },
      payoutSchedule: "TWO_WEEKS_AFTER",
    });

    expect(txRepos.deals.lockTerms).toHaveBeenCalledWith(OLD_PT_ID);
    const lockOrder = txRepos.deals.lockTerms.mock.invocationCallOrder[0]!;
    const cloneOrder = txRepos.payoutTerms.clone.mock.invocationCallOrder[0]!;
    const readOrder = txRepos.payoutTerms.getById.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(readOrder);
    expect(lockOrder).toBeLessThan(cloneOrder);
  });

  it("refuses with CONFLICT when the default was re-pointed while it waited for the lock (no clone, no re-point)", async () => {
    const { deps, txRepos } = makeDeps();
    // The interleaving: another schedule change committed D → D' while this
    // transaction queued on D's lock. Under the lock the pointer has moved.
    txRepos.deals.lockTerms.mockImplementation(async () => {
      txRepos.organizations.getById.mockResolvedValue({
        ...ORG,
        defaultPrimaryPayoutTermsId: NEW_PT_ID,
      });
      return true;
    });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
        payoutSchedule: "TWO_WEEKS_AFTER",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(txRepos.payoutTerms.clone).not.toHaveBeenCalled();
    expect(txRepos.payoutTerms.markNotDefault).not.toHaveBeenCalled();
    expect(txRepos.organizations.update).not.toHaveBeenCalled();
  });

  it("refuses with CONFLICT on the human path too when the pointer moved under the lock", async () => {
    const { deps, txRepos } = makeDeps();
    txRepos.deals.lockTerms.mockImplementation(async () => {
      txRepos.humans.getById.mockResolvedValue({
        id: ACTOR_ID,
        defaultPrimaryPayoutTermsId: NEW_PT_ID,
      });
      return true;
    });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "human", humanId: ACTOR_ID },
        payoutSchedule: "TWO_WEEKS_AFTER",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(txRepos.payoutTerms.clone).not.toHaveBeenCalled();
    expect(txRepos.humans.update).not.toHaveBeenCalled();
  });

  it("is a no-op when the schedule already matches (no clone, no markNotDefault, no org update)", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "org", orgId: ORG_ID },
      payoutSchedule: "WEEK_OF_EVENT",
    });

    expect(txRepos.payoutTerms.clone).not.toHaveBeenCalled();
    expect(txRepos.payoutTerms.markNotDefault).not.toHaveBeenCalled();
    expect(txRepos.organizations.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      payoutTermsId: OLD_PT_ID,
      payoutSchedule: "WEEK_OF_EVENT",
    });
  });

  it("provisions the org default on demand (born with the requested schedule, no clone) when none exists", async () => {
    const { deps, txRepos } = makeDeps({
      org: { ...ORG, defaultPrimaryPayoutTermsId: null },
    });

    const result = await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "org", orgId: ORG_ID },
      payoutSchedule: "ASAP",
    });

    // Provisioned with the REQUESTED schedule so the fast path returns it
    // without a pointless clone.
    expect(txRepos.payoutTerms.provisionDefaultPrimary).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeId: PAYEE_ID,
        isDefault: true,
        payoutSchedule: "ASAP",
      }),
    );
    expect(txRepos.payoutTerms.clone).not.toHaveBeenCalled();
    expect(txRepos.payoutTerms.markNotDefault).not.toHaveBeenCalled();
    // The helper repoints the org at the provisioned row via the IS-NULL CAS.
    expect(
      txRepos.organizations.setDefaultPrimaryPayoutTermsIdIfNull,
    ).toHaveBeenCalledWith({
      id: ORG_ID,
      payoutTermsId: PROVISIONED_PT_ID,
    });
    expect(result).toEqual({
      payoutTermsId: PROVISIONED_PT_ID,
      payoutSchedule: "ASAP",
    });
  });

  it("rejects with PAYEE_NOT_READY when the org has no default terms AND no usable payee", async () => {
    const { deps, txRepos } = makeDeps({
      org: { ...ORG, defaultPrimaryPayoutTermsId: null },
      payee: null,
    });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "PAYEE_NOT_READY" });

    expect(txRepos.payoutTerms.provisionDefaultPrimary).not.toHaveBeenCalled();
    expect(txRepos.organizations.update).not.toHaveBeenCalled();
  });

  it("falls through to the clone path when the on-demand provision loses the pointer race", async () => {
    const WINNER_PT_ID = "abab0000-0000-4000-8000-000000000007";
    const WINNER: PayoutTermsRecord = {
      ...OLD_PT,
      id: WINNER_PT_ID,
      payoutSchedule: "TWO_WEEKS_AFTER",
    };
    const { deps, txRepos } = makeDeps({
      org: { ...ORG, defaultPrimaryPayoutTermsId: null },
    });

    // Simulate the TOCTOU: a concurrent first-publish auto-provision commits
    // its pointer between our NULL read and the guarded pointer write, so the
    // CAS 0-matches and the re-read resolves the winner's row.
    txRepos.organizations.setDefaultPrimaryPayoutTermsIdIfNull.mockImplementation(
      async () => {
        txRepos.organizations.getById.mockResolvedValue({
          ...ORG,
          defaultPrimaryPayoutTermsId: WINNER_PT_ID,
        });
        return false;
      },
    );
    txRepos.payoutTerms.getById.mockImplementation((id: string) =>
      Promise.resolve(id === WINNER_PT_ID ? WINNER : null),
    );

    const result = await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "org", orgId: ORG_ID },
      payoutSchedule: "ASAP",
    });

    // The helper retired OUR freshly provisioned row (no isDefault orphan)…
    expect(txRepos.payoutTerms.markNotDefault).toHaveBeenCalledWith(
      PROVISIONED_PT_ID,
    );
    // …and returned the WINNER's row; its schedule (TWO_WEEKS_AFTER) doesn't
    // match the requested ASAP, so the existing copy-on-write clone path
    // fires against the winner instead of the fast path returning stale terms.
    expect(txRepos.payoutTerms.clone).toHaveBeenCalledWith({
      sourcePayoutTermsId: WINNER_PT_ID,
      payoutScheduleOverride: "ASAP",
      isDefault: true,
      resetConfirmations: true,
      bumpVersion: true,
      // The new default is a snapshot: it never carries ABSORB forward.
      resetFeeMode: true,
    });
    expect(txRepos.payoutTerms.markNotDefault).toHaveBeenCalledWith(
      WINNER_PT_ID,
    );
    expect(txRepos.organizations.update).toHaveBeenCalledWith({
      id: ORG_ID,
      defaultPrimaryPayoutTermsId: NEW_PT_ID,
    });
    expect(result).toEqual({
      payoutTermsId: NEW_PT_ID,
      payoutSchedule: "ASAP",
    });
  });

  it("rejects with PAYEE_NOT_READY when the payee exists but payouts are not enabled", async () => {
    const { deps, txRepos } = makeDeps({
      org: { ...ORG, defaultPrimaryPayoutTermsId: null },
      payee: {
        id: PAYEE_ID,
        status: "ACTIVE",
        payoutsEnabled: false,
        defaultCurrency: "usd",
      },
    });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "PAYEE_NOT_READY" });

    expect(txRepos.payoutTerms.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  it("rejects when org is not found", async () => {
    const { deps } = makeDeps({ org: null });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });

  it("rejects when org is inactive", async () => {
    const { deps } = makeDeps({ org: { ...ORG, status: "SUSPENDED" } });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_INACTIVE" });
  });

  it("rejects when actor lacks finance role", async () => {
    const { deps } = makeDeps({ membership: { role: "MEMBER" } });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects when source PayoutTerms vanishes mid-transaction (clone returns null)", async () => {
    const { deps } = makeDeps({ cloneResult: null });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "org", orgId: ORG_ID },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "PAYOUT_TERMS_NOT_FOUND" });
  });

  it("clones and re-points the human default when acting on self", async () => {
    const { deps, txRepos } = makeDeps();

    const result = await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "human", humanId: ACTOR_ID },
      payoutSchedule: "TWO_WEEKS_AFTER",
    });

    expect(txRepos.payoutTerms.clone).toHaveBeenCalledWith({
      sourcePayoutTermsId: OLD_PT_ID,
      payoutScheduleOverride: "TWO_WEEKS_AFTER",
      isDefault: true,
      resetConfirmations: true,
      bumpVersion: true,
      // The new default is a snapshot: it never carries ABSORB forward.
      resetFeeMode: true,
    });
    expect(txRepos.payoutTerms.markNotDefault).toHaveBeenCalledWith(OLD_PT_ID);
    expect(txRepos.humans.update).toHaveBeenCalledWith(ACTOR_ID, {
      defaultPrimaryPayoutTermsId: NEW_PT_ID,
    });
    expect(txRepos.organizations.update).not.toHaveBeenCalled();

    expect(result).toEqual({
      payoutTermsId: NEW_PT_ID,
      payoutSchedule: "TWO_WEEKS_AFTER",
    });
  });

  it("rejects when a human tries to update another human's schedule", async () => {
    const { deps } = makeDeps();

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: {
          kind: "human",
          humanId: "ffff0000-0000-4000-8000-000000000099",
        },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28): even an OWNER-role
  // delegate of the human cannot change the schedule they are paid on.
  it("refuses a delegate of the human (payout routing), without consulting the delegation", async () => {
    const PRINCIPAL = "ffff0000-0000-4000-8000-000000000099";
    const { deps } = makeDeps();
    const getHumanDelegation = vi.fn(async () => ({
      orgId: PRINCIPAL,
      humanId: ACTOR_ID,
      role: "OWNER",
    }));
    for (const holder of [deps.repos as unknown as Record<string, any>]) {
      if (holder.authz) holder.authz.getHumanDelegation = getHumanDelegation;
    }

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "human", humanId: PRINCIPAL },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(getHumanDelegation).not.toHaveBeenCalled();
  });

  it("provisions the human default on demand when none exists (born with the requested schedule)", async () => {
    const { deps, txRepos } = makeDeps({
      human: { id: ACTOR_ID, defaultPrimaryPayoutTermsId: null },
    });

    const result = await updatePayoutSchedule(deps, {
      actorHumanId: ACTOR_ID,
      entity: { kind: "human", humanId: ACTOR_ID },
      payoutSchedule: "FOUR_WEEKS_AFTER",
    });

    expect(txRepos.payoutTerms.provisionDefaultPrimary).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeId: PAYEE_ID,
        isDefault: true,
        payoutSchedule: "FOUR_WEEKS_AFTER",
      }),
    );
    expect(txRepos.payoutTerms.clone).not.toHaveBeenCalled();
    // The helper repoints the human at the provisioned row via the IS-NULL CAS.
    expect(
      txRepos.humans.setDefaultPrimaryPayoutTermsIdIfNull,
    ).toHaveBeenCalledWith({
      id: ACTOR_ID,
      payoutTermsId: PROVISIONED_PT_ID,
    });
    expect(result).toEqual({
      payoutTermsId: PROVISIONED_PT_ID,
      payoutSchedule: "FOUR_WEEKS_AFTER",
    });
  });

  it("rejects with PAYEE_NOT_READY when the human has no default terms AND no usable payee", async () => {
    const { deps } = makeDeps({
      human: { id: ACTOR_ID, defaultPrimaryPayoutTermsId: null },
      payee: null,
    });

    await expect(
      updatePayoutSchedule(deps, {
        actorHumanId: ACTOR_ID,
        entity: { kind: "human", humanId: ACTOR_ID },
        payoutSchedule: "ASAP",
      }),
    ).rejects.toMatchObject({ code: "PAYEE_NOT_READY" });
  });
});
