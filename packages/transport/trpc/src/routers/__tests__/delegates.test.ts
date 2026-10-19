import { beforeEach, describe, expect, it, vi } from "vitest";

import { router } from "../../init";
import type { Ctx } from "../../context";
import { delegatesRouter } from "../delegates";
import * as createInviteModule from "@th/core/use-cases/delegates/create-delegate-invite";
import * as acceptInviteModule from "@th/core/use-cases/delegates/accept-delegate-invite";
import * as previewInviteModule from "@th/core/use-cases/delegates/preview-delegate-invite";
import { buildBaseCtx } from "./test-helpers";

const SECRET = "s".repeat(48);
const PRINCIPAL = "11111111-1111-4111-8111-111111111111";

function callerWith(overrides: Partial<Ctx> & { delegateInviteSecret?: string | null }) {
  const ctx = { ...buildBaseCtx(overrides), ...overrides } as Ctx;
  const caller = router({ delegates: router(delegatesRouter) }).createCaller(
    ctx,
  );
  return { caller, ctx };
}

describe("delegatesRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("no longer exposes the consent-free addDelegate", () => {
    expect(Object.keys(delegatesRouter)).not.toContain("addDelegate");
    expect(Object.keys(delegatesRouter)).toEqual(
      expect.arrayContaining(["createInvite", "acceptInvite", "listDelegates"]),
    );
  });

  it("createInvite forwards the invite secret and never writes a grant", async () => {
    const addDelegate = vi.fn();
    const auditLog = vi.fn(async () => {});
    const tx = { audit: { log: auditLog }, humanDelegates: { addDelegate } };
    const { caller } = callerWith({
      delegateInviteSecret: SECRET,
      repos: {
        ...tx,
        tx: async (fn: (t: typeof tx) => unknown) => fn(tx),
      } as unknown as Ctx["repos"],
    });

    const out = await caller.delegates.createInvite({
      principalId: PRINCIPAL,
      email: "assistant@example.com",
      role: "EDITOR",
    });

    expect(out.token).toMatch(/^v1\./);
    expect(addDelegate).not.toHaveBeenCalled();
  });

  it("createInvite maps a missing secret to a tRPC error", async () => {
    const { caller } = callerWith({ delegateInviteSecret: null });
    await expect(
      caller.delegates.createInvite({
        principalId: PRINCIPAL,
        email: "assistant@example.com",
        role: "EDITOR",
      }),
    ).rejects.toBeTruthy();
  });

  it("createInvite is capped per actor before the use case runs", async () => {
    const spy = vi.spyOn(createInviteModule, "createDelegateInvite");
    const consume = vi.fn(async (key: string) => ({
      allowed: !key.startsWith("delegates:createInvite:"),
      remaining: 0,
      retryAfterSeconds: 60,
    }));
    const { caller, ctx } = callerWith({
      delegateInviteSecret: SECRET,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(
      caller.delegates.createInvite({
        principalId: PRINCIPAL,
        email: "assistant@example.com",
        role: "EDITOR",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(
      `delegates:createInvite:${ctx.actorHumanId}`,
      20,
      3600,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("acceptInvite forwards the actor, idempotency store and secret", async () => {
    const spy = vi
      .spyOn(acceptInviteModule, "acceptDelegateInvite")
      .mockResolvedValue({
        principalId: PRINCIPAL,
        principalName: "Pat",
        role: "EDITOR",
      });
    const { caller, ctx } = callerWith({ delegateInviteSecret: SECRET });

    await caller.delegates.acceptInvite({ token: "v1.x.y" });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency: ctx.idempotency,
        inviteSecret: SECRET,
      }),
      { token: "v1.x.y", actorHumanId: ctx.actorHumanId },
    );
  });
  it("previewInvite forwards actor, idempotency and secret to the read-only use case", async () => {
    const spy = vi
      .spyOn(previewInviteModule, "previewDelegateInvite")
      .mockResolvedValue({ principalName: "Pat", role: "EDITOR" });
    const { caller, ctx } = callerWith({ delegateInviteSecret: SECRET });

    await expect(
      caller.delegates.previewInvite({ token: "v1.x.y" }),
    ).resolves.toEqual({ principalName: "Pat", role: "EDITOR" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency: ctx.idempotency,
        inviteSecret: SECRET,
      }),
      { token: "v1.x.y", actorHumanId: ctx.actorHumanId },
    );
  });

  it("acceptInvite forwards reportError", async () => {
    const spy = vi
      .spyOn(acceptInviteModule, "acceptDelegateInvite")
      .mockResolvedValue({ principalId: PRINCIPAL, principalName: null, role: "EDITOR" });
    const reportError = vi.fn();
    const { caller } = callerWith({ delegateInviteSecret: SECRET, reportError } as Partial<Ctx>);
    await caller.delegates.acceptInvite({ token: "v1.x.y" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ reportError }),
      expect.anything(),
    );
  });
});
