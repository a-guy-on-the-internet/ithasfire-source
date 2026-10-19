import { describe, expect, it, vi } from "vitest";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos";

import { withGuardedRepos } from "../with-dependency-guard";

/**
 * `withGuardedRepos` re-wraps `repos.tx` so the callback sees guarded
 * repos. It must forward the per-call `TxOptions` (booking-accept spec
 * 2026-09-05, P-3) to the inner `tx` untouched — otherwise a caller's
 * deliberate timeout would silently evaporate behind the guard in every
 * composition root (api + jobs both wrap repos in it).
 */

function makeRepos() {
  const events = { findById: vi.fn(async () => null) };
  const txRepos = { events } as unknown as TxRepos;
  const tx = vi.fn(
    async <T>(fn: (tx: TxRepos) => Promise<T>, _options?: TxOptions) =>
      fn(txRepos),
  );
  const repos = { ...txRepos, tx } as unknown as Repos;
  return { repos, tx, events };
}

describe("withGuardedRepos().tx", () => {
  it("forwards per-call TxOptions to the inner tx", async () => {
    const { repos, tx } = makeRepos();
    const guarded = withGuardedRepos(repos);

    await guarded.tx(async () => "ok", { timeout: 45_000, maxWait: 2_000 });

    expect(tx).toHaveBeenCalledTimes(1);
    expect(tx.mock.calls[0]?.[1]).toEqual({ timeout: 45_000, maxWait: 2_000 });
  });

  it("passes undefined options through when the caller gives none", async () => {
    const { repos, tx } = makeRepos();
    const guarded = withGuardedRepos(repos);

    const result = await guarded.tx(async () => "ok");

    expect(result).toBe("ok");
    expect(tx).toHaveBeenCalledTimes(1);
    expect(tx.mock.calls[0]).toHaveLength(2);
    expect(tx.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("still hands the callback guarded tx repos", async () => {
    const { repos, events } = makeRepos();
    const guarded = withGuardedRepos(repos);

    await guarded.tx(async (tx) => {
      await tx.events.findById("evt-1");
      return undefined;
    });

    expect(events.findById).toHaveBeenCalledWith("evt-1");
  });
});
