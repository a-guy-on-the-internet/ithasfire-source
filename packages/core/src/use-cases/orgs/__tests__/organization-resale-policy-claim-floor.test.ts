/**
 * The resale payout release can never be shorter than the claim window
 * (RESALE_CLAIM_WINDOW_DAYS after the event ends). A shorter release pays the
 * seller before the buyer can file a claim.
 *
 * The setter keeps ACCEPTING 0–365 (the settings form pre-fills the stored
 * value and always sends it, so an org whose stored value predates the floor
 * must still be able to save) but persists at least the window. Both the
 * setter and the getter report the EFFECTIVE window.
 */
import { describe, expect, it, vi } from "vitest";

import { RESALE_CLAIM_WINDOW_DAYS } from "../../../lib/resale-claim-window";
import { getOrganizationResalePolicy } from "../get-organization-resale-policy";
import { setDefaultAgreement } from "../set-default-agreement";
import { setOrganizationResalePolicy } from "../set-organization-resale-policy";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TERMS_ID = "33333333-3333-4333-8333-333333333333";

function makeDeps(opts: {
  existingTermsId?: string | null;
  storedDays?: number;
  /** A concurrent first save that pinned its own template first (W3). */
  linkLoses?: boolean;
  /** The pointer moved between the lock and the re-read. */
  pointerAfterLock?: string | null;
}) {
  let stored = {
    resalePayoutReleaseDays: opts.storedDays ?? 7,
  };
  const updateDraft = vi.fn(
    async (input: {
      resalePayoutReleaseDays?: number;
    }) => {
      stored = { ...stored, ...input };
      return { id: TERMS_ID, ...stored };
    },
  );
  const createDraft = vi.fn(
    async (input: { resalePayoutReleaseDays?: number }) => {
      stored = {
        // Column default when omitted.
        resalePayoutReleaseDays: input.resalePayoutReleaseDays ?? 7,
      };
      return { id: TERMS_ID, ...stored };
    },
  );
  const payoutTerms = {
    updateDraft,
    createDraft,
    getById: vi.fn(async () => ({ id: TERMS_ID, ...stored })),
  };
  let pointer: string | null =
    opts.existingTermsId === undefined ? TERMS_ID : opts.existingTermsId;
  const calls: string[] = [];
  const organizations = {
    getById: vi.fn(async () => {
      calls.push("org.getById");
      return { id: ORG_ID, defaultResalePayoutTermsId: pointer };
    }),
    update: vi.fn(async () => ({})),
  };
  const deals = {
    lockTerms: vi.fn(async () => {
      calls.push("lockTerms");
      if (opts.pointerAfterLock !== undefined) pointer = opts.pointerAfterLock;
      return true;
    }),
    linkOrgDefaultResaleTermsIfUnset: vi.fn(
      async ({ payoutTermsId }: { orgId: string; payoutTermsId: string }) => {
        if (opts.linkLoses || pointer) return false;
        pointer = payoutTermsId;
        return true;
      },
    ),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => ({ role: "OWNER" })),
  };
  const audit = { log: vi.fn(async () => {}) };
  const repos = {
    organizations,
    payoutTerms,
    authz,
    audit,
    deals,
    tx: async (fn: (t: unknown) => Promise<unknown>) =>
      fn({ organizations, payoutTerms, audit, deals }),
  };
  return {
    deps: {
      repos: repos as never,
      clock: { now: () => new Date("2026-09-30T00:00:00Z") },
    },
    updateDraft,
    createDraft,
    deals,
    calls,
    audit,
    pointer: () => pointer,
  };
}

describe("resale policy: release window floored at the claim window", () => {
  it("pins the claim window at 3 days (the create-claim deadline)", () => {
    expect(RESALE_CLAIM_WINDOW_DAYS).toBe(3);
  });

  it.each([0, 1, 2])(
    "persists %i days AS the claim window on an existing template",
    async (days) => {
      const h = makeDeps({});
      const out = await setDefaultAgreement(h.deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        payoutReleaseDays: days,
      });

      expect(h.updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ resalePayoutReleaseDays: 3 }),
      );
      expect(out.payoutReleaseDays).toBe(3);
    },
  );

  it("persists a value below the window AS the window when minting a new template", async () => {
    const h = makeDeps({ existingTermsId: null });
    const out = await setDefaultAgreement(h.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      payoutReleaseDays: 0,
    });

    expect(h.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ resalePayoutReleaseDays: 3 }),
    );
    expect(out.payoutReleaseDays).toBe(3);
  });

  it("leaves a value at or above the window untouched", async () => {
    const h = makeDeps({});
    const out = await setDefaultAgreement(h.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      payoutReleaseDays: 10,
    });

    expect(h.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ resalePayoutReleaseDays: 10 }),
    );
    expect(out.payoutReleaseDays).toBe(10);
  });

  it("does not rewrite a stored sub-window value when the save omits the window, but reports the effective one", async () => {
    const h = makeDeps({ storedDays: 1 });
    const out = await setDefaultAgreement(h.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(h.updateDraft).toHaveBeenCalledWith(
      expect.not.objectContaining({ resalePayoutReleaseDays: expect.anything() }),
    );
    expect(out.payoutReleaseDays).toBe(3);
  });

  it("reads a stored sub-window value back as the effective window", async () => {
    const h = makeDeps({ storedDays: 0 });
    const out = await getOrganizationResalePolicy(h.deps as never, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(out.payoutReleaseDays).toBe(3);
  });

  it("refuses the removed markup share field (FR-014; the input is strict)", async () => {
    const h = makeDeps({});
    await expect(
      setDefaultAgreement(h.deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        sellerMarkupShareBps: 5000,
        payoutReleaseDays: 7,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.updateDraft).not.toHaveBeenCalled();
  });

  it("still rejects values outside 0–365 (validation unchanged)", async () => {
    const h = makeDeps({});
    await expect(
      setDefaultAgreement(h.deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        payoutReleaseDays: -1,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("getOrganizationResalePolicy — a dangling template pointer", () => {
  function dangling() {
    const h = makeDeps({});
    (h.deps.repos as unknown as {
      payoutTerms: { getById: ReturnType<typeof vi.fn> };
    }).payoutTerms.getById.mockResolvedValue(null);
    const reportError = vi.fn();
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { deps: { ...h.deps, reportError, logger }, reportError, logger };
  }
  const read = (deps: unknown) =>
    getOrganizationResalePolicy(deps as never, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

  it("falls back to the platform default, logs, and reports it", async () => {
    const d = dangling();

    await expect(read(d.deps)).resolves.toMatchObject({
      payoutTermsId: null,
      isPlatformDefault: true,
    });
    expect(d.logger.warn).toHaveBeenCalledWith(
      "orgs.resale_policy_dangling_fk",
      { orgId: ORG_ID, payoutTermsId: TERMS_ID },
    );
    expect(d.reportError).toHaveBeenCalledTimes(1);
    expect(d.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "org_resale_policy_dangling_fk" }),
      {
        tags: { useCase: "getOrganizationResalePolicy", reason: "dangling_fk" },
        extra: { orgId: ORG_ID, payoutTermsId: TERMS_ID },
      },
    );
  });

  it("a throwing reporter changes nothing", async () => {
    const d = dangling();
    d.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await expect(read(d.deps)).resolves.toMatchObject({ isPlatformDefault: true });
  });

  it("a template that exists is not reported", async () => {
    const h = makeDeps({});
    const reportError = vi.fn();
    await read({ ...h.deps, reportError });
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("setOrganizationResalePolicy (deprecated alias)", () => {
  it("is setDefaultAgreement under its old name (FR-012 rename)", () => {
    expect(setOrganizationResalePolicy).toBe(setDefaultAgreement);
  });
});

describe("setDefaultAgreement — the template pointer under concurrency (review W3)", () => {
  const save = (h: ReturnType<typeof makeDeps>) =>
    setDefaultAgreement(h.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

  it("the first save mints through the guarded link, not a plain org update", async () => {
    const h = makeDeps({ existingTermsId: null });
    await save(h);
    expect(h.deals.linkOrgDefaultResaleTermsIfUnset).toHaveBeenCalledWith({
      orgId: ORG_ID,
      payoutTermsId: TERMS_ID,
    });
    expect(h.pointer()).toBe(TERMS_ID);
  });

  it("a concurrent first save linked first → CONFLICT, nothing audited", async () => {
    const h = makeDeps({ existingTermsId: null, linkLoses: true });
    await expect(save(h)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it("an existing template is written under its lock, re-read after the lock", async () => {
    const h = makeDeps({});
    await save(h);
    const lockAt = h.calls.indexOf("lockTerms");
    expect(lockAt).toBeGreaterThan(-1);
    expect(h.calls.slice(lockAt + 1)).toContain("org.getById");
    expect(h.updateDraft).toHaveBeenCalledTimes(1);
  });

  it("the pointer moved while the save waited for the lock → CONFLICT, nothing written", async () => {
    const h = makeDeps({ pointerAfterLock: "44444444-4444-4444-8444-444444444444" });
    await expect(save(h)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.updateDraft).not.toHaveBeenCalled();
  });
});
