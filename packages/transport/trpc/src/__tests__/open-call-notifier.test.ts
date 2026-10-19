import { describe, expect, it, vi } from "vitest";

// makeOpenCallNotifier is deps assembly only; pin what it binds, so a guest's
// status link (owner ruling 2026-10-07) cannot silently go unbound.
const captured = vi.hoisted(() => ({ deps: null as Record<string, unknown> | null }));

vi.mock("@th/core/use-cases/events/open-calls/notify-open-call-notices", () => ({
  makeOpenCallNotices: vi.fn((deps: Record<string, unknown>) => {
    captured.deps = deps;
    return {};
  }),
}));

import { makeOpenCallNotifier } from "../open-call-notifier";

const baseCtx = () =>
  ({
    repos: {},
    idempotency: {},
    notify: vi.fn(),
    notifyWithEmail: vi.fn(),
    mailer: { send: vi.fn() },
    publicAppUrl: "https://ithasfire.com",
    logger: undefined,
    reportError: undefined,
  }) as unknown as Parameters<typeof makeOpenCallNotifier>[0];

describe("makeOpenCallNotifier", () => {
  it("binds the status-token secret, the mailer and notify WITH email", () => {
    const ctx = { ...baseCtx(), openCallStatusTokenSecret: "s".repeat(40) };
    makeOpenCallNotifier(ctx);
    expect(captured.deps).toMatchObject({
      statusTokenSecret: "s".repeat(40),
      publicAppUrl: "https://ithasfire.com",
      mailer: ctx.mailer,
      notify: ctx.notifyWithEmail,
    });
  });

  it("an unset secret is passed as null (guest emails then fail and are reported in core)", () => {
    makeOpenCallNotifier(baseCtx());
    expect(captured.deps!.statusTokenSecret).toBeNull();
  });
});
