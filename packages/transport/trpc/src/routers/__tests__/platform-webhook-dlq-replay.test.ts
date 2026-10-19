import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { platformRouter } from "../platform";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

function setup(opts: { replayOk: boolean; removeError?: Error; reportThrows?: boolean }) {
  const remove = vi.fn(async () => {
    if (opts.removeError) throw opts.removeError;
  });
  const reportError = vi.fn(() => {
    if (opts.reportThrows) throw new Error("reporter down");
  });
  const { caller, ctx } = createCaller(
    { replayWebhookDlqItem: platformRouter.replayWebhookDlqItem },
    {
      actorHumanId: ACTOR_ID,
      authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) } as any,
      reportError,
    } as any,
  );
  // buildBaseCtx does not forward these two deps, so set them on the live ctx.
  Object.assign(ctx, {
    webhookDlq: { get: vi.fn(async () => ({ payload: "{}" })), remove },
    replayStripeEvent: vi.fn(async () =>
      opts.replayOk ? { ok: true } : { ok: false, error: "still broken" },
    ),
  });
  return { caller, remove, reportError };
}

describe("platform.replayWebhookDlqItem", () => {
  it("removes the row and returns ok when the replay applied", async () => {
    const { caller, remove, reportError } = setup({ replayOk: true });
    await expect(caller.replayWebhookDlqItem({ stripeEventId: "evt_1" })).resolves.toEqual({
      ok: true,
      error: null,
    });
    expect(remove).toHaveBeenCalledWith("evt_1");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("replay ok but remove fails: returns success with a note and reports", async () => {
    const removeError = new Error("redis webhook dlq remove aborted (keyHash=abc)");
    const { caller, reportError } = setup({ replayOk: true, removeError });
    await expect(caller.replayWebhookDlqItem({ stripeEventId: "evt_1" })).resolves.toEqual({
      ok: true,
      error: "applied; DLQ row not cleared",
    });
    expect(reportError).toHaveBeenCalledWith(
      removeError,
      expect.objectContaining({ tags: { area: "webhook_dlq", step: "replay_remove" } }),
    );
  });

  it("a throwing reporter does not change the result", async () => {
    const { caller } = setup({
      replayOk: true,
      removeError: new Error("x"),
      reportThrows: true,
    });
    await expect(caller.replayWebhookDlqItem({ stripeEventId: "evt_1" })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("a failed replay keeps the row and does not call remove", async () => {
    const { caller, remove } = setup({ replayOk: false });
    await expect(caller.replayWebhookDlqItem({ stripeEventId: "evt_1" })).resolves.toEqual({
      ok: false,
      error: "still broken",
    });
    expect(remove).not.toHaveBeenCalled();
  });
});
