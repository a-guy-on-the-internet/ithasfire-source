import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";

import { onAccountDeauthorized } from "../handlers/account-deauthorized";
import type { AccountDeauthorized } from "../guards";

const ACCT = { id: "acct_dead_123" } as AccountDeauthorized;

function makeDeps(payee: { id: string } | null) {
  const markDeauthorized = vi.fn(async () => payee);
  // NO settlements repo at all: the pre-ledger handler cancelled pending
  // settlements (`cancelForPayee`); post-cutover a deauthorized payee's
  // ledger credits STAY (money owed doesn't vanish with Stripe access — the
  // payout batch's payoutsEnabled guard blocks transfers). Leaving the repo
  // absent makes any resurrected settlement write crash, not pass a spy.
  const repos = { payees: { markDeauthorized } } as unknown as Repos;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  return { repos, logger: logger as never, markDeauthorized, logs: logger };
}

describe("onAccountDeauthorized", () => {
  it("restricts the payee and touches NOTHING else — credits stay on the ledger", async () => {
    const { repos, logger, markDeauthorized } = makeDeps({ id: "payee-1" });

    const result = await onAccountDeauthorized({ repos, logger }, ACCT);

    expect(markDeauthorized).toHaveBeenCalledWith("acct_dead_123");
    expect(result).toEqual({ payeeId: "payee-1" });
  });

  it("returns a null payeeId (and warns) when no payee matches the account", async () => {
    const { repos, logger, logs } = makeDeps(null);

    const result = await onAccountDeauthorized({ repos, logger }, ACCT);

    expect(result).toEqual({ payeeId: null });
    expect(logs.warn).toHaveBeenCalledWith(
      "onAccountDeauthorized.payee_not_found",
      { stripeAccountId: "acct_dead_123" },
    );
  });
});
