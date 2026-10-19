import { describe, expect, it, vi } from "vitest";

import { isLoginableBuyer, notifyBuyer } from "../notify-buyer";

/**
 * B2, account squatting through guest checkout (owner ruling 2026-10-16).
 * An account that signed up with a password under someone else's address and
 * never verified is NOT loginable for buyer notifications: guest checkout
 * attaches the real person's order to it by email, and an in-app or push
 * entry would reach whoever signed it up. The ticket email (to the inbox)
 * keeps its claim link instead.
 */
const HUMAN_ID = "11111111-1111-4111-8111-111111111111";

function repos(opts: {
  accounts: number;
  emailVerified: boolean | null;
  failIdentity?: boolean;
}) {
  return {
    humans: {
      listAuthAccounts: vi.fn(async () =>
        Array.from({ length: opts.accounts }, (_, i) => ({
          providerId: "credential",
          accountId: `acct-${i}`,
          createdAt: new Date("2026-10-01T00:00:00.000Z"),
        })),
      ),
      getByIdWithIdentity: vi.fn(async () => {
        if (opts.failIdentity) throw new Error("db down");
        return opts.emailVerified === null
          ? null
          : { human: { id: HUMAN_ID }, identity: { emailVerified: opts.emailVerified } };
      }),
    },
  } as any;
}

describe("isLoginableBuyer", () => {
  it("is false for an unverified password account (the squatter)", async () => {
    await expect(
      isLoginableBuyer({ repos: repos({ accounts: 1, emailVerified: false }) }, HUMAN_ID),
    ).resolves.toBe(false);
  });

  it("is true for a verified account", async () => {
    await expect(
      isLoginableBuyer({ repos: repos({ accounts: 1, emailVerified: true }) }, HUMAN_ID),
    ).resolves.toBe(true);
  });

  it("is false for a shadow guest (no AuthAccount) even once verified", async () => {
    const r = repos({ accounts: 0, emailVerified: true });
    await expect(isLoginableBuyer({ repos: r }, HUMAN_ID)).resolves.toBe(false);
    expect(r.humans.getByIdWithIdentity).not.toHaveBeenCalled();
  });

  it("is false when the identity is missing or the lookup fails", async () => {
    await expect(
      isLoginableBuyer({ repos: repos({ accounts: 1, emailVerified: null }) }, HUMAN_ID),
    ).resolves.toBe(false);
    await expect(
      isLoginableBuyer(
        { repos: repos({ accounts: 1, emailVerified: true, failIdentity: true }) },
        HUMAN_ID,
      ),
    ).resolves.toBe(false);
  });
});

describe("isLoginableBuyer reports its swallow", () => {
  it("reports a failed lookup and still answers false", async () => {
    const reportError = vi.fn();
    await expect(
      isLoginableBuyer(
        {
          repos: repos({ accounts: 1, emailVerified: true, failIdentity: true }),
          reportError,
        },
        HUMAN_ID,
      ),
    ).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db down" }),
      expect.objectContaining({
        tags: { useCase: "isLoginableBuyer", branch: "lookup_failed" },
        extra: { humanId: HUMAN_ID },
      }),
    );
  });

  it("a throwing reporter does not change the answer", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      isLoginableBuyer(
        {
          repos: repos({ accounts: 1, emailVerified: true, failIdentity: true }),
          reportError,
        },
        HUMAN_ID,
      ),
    ).resolves.toBe(false);
  });

  it("does not report a clean false (unverified)", async () => {
    const reportError = vi.fn();
    await isLoginableBuyer(
      { repos: repos({ accounts: 1, emailVerified: false }), reportError },
      HUMAN_ID,
    );
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("notifyBuyer", () => {
  const input = {
    buyerHumanId: HUMAN_ID,
    variant: "order.confirmed" as any,
    payload: {} as any,
    idempotencyKey: "k",
  };

  it("sends nothing in-app to an unverified password account", async () => {
    const notify = vi.fn();
    await notifyBuyer(
      { repos: repos({ accounts: 1, emailVerified: false }), notify },
      input,
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a failed notify without throwing", async () => {
    const reportError = vi.fn();
    const notify = vi.fn(async () => {
      throw new Error("notify down");
    });
    await expect(
      notifyBuyer(
        { repos: repos({ accounts: 1, emailVerified: true }), notify, reportError },
        input,
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "notify down" }),
      expect.objectContaining({
        tags: { useCase: "notifyBuyer", branch: "notify_failed" },
      }),
    );
  });

  it("notifies a verified account", async () => {
    const notify = vi.fn(async () => ({}) as any);
    await notifyBuyer(
      { repos: repos({ accounts: 1, emailVerified: true }), notify },
      input,
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
