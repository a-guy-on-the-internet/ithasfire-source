import { describe, expect, it, vi } from "vitest";

import { createDelegateInvite } from "../create-delegate-invite";
import {
  acceptDelegateInvite,
  delegateInviteNonceKey,
  USED_NONCE_GRACE_SEC,
} from "../accept-delegate-invite";
import { previewDelegateInvite } from "../preview-delegate-invite";
import {
  signDelegateInviteToken,
  verifyDelegateInviteToken,
} from "../../../lib/delegate-invite-token";

const SECRET = "s".repeat(48);
const principalId = "a1111111-1111-4111-a111-111111111111";
const delegateId = "b2222222-2222-4222-b222-222222222222";
const strangerId = "c3333333-3333-4333-a333-333333333333";
const INVITED = "assistant@example.com";
const NOW = new Date("2026-09-29T12:00:00.000Z");

/** In-memory idempotency store with the real begin/commit/release semantics. */
function makeIdempotency() {
  const store = new Map<string, { status: string; owner?: string }>();
  return {
    store,
    begin: vi.fn(async (key: string, _ttl?: number, owner?: string) => {
      if (store.has(key)) return false;
      store.set(key, { status: "in_progress", owner });
      return true;
    }),
    commit: vi.fn(async (key: string) => {
      store.set(key, { status: "succeeded" });
    }),
    release: vi.fn(async (key: string, owner: string) => {
      const rec = store.get(key);
      if (rec?.status === "in_progress" && rec.owner === owner) {
        store.delete(key);
        return true;
      }
      return false;
    }),
    fail: vi.fn(),
    status: vi.fn(async (key: string) => {
      const st = store.get(key)?.status;
      return st === "in_progress" || st === "succeeded" ? st : null;
    }),
    get: vi.fn(async (key: string) =>
      store.get(key)?.status === "succeeded" ? { acceptedBy: "x" } : null,
    ),
    run: vi.fn(),
    purgeExpired: vi.fn(),
  };
}

function makeDeps(
  opts: {
    actorEmail?: string;
    emailVerified?: boolean;
    existingRole?: string | null;
    secret?: string | null;
  } = {},
) {
  const txRepos = {
    humans: {
      getById: vi.fn(async (id: string) =>
        id === principalId ? { id: principalId, name: "Pat Principal" } : null,
      ),
    },
    humanDelegates: {
      addDelegate: vi.fn(async () => ({})),
      getDelegation: vi.fn(async () =>
        opts.existingRole
          ? {
              id: "hd-1",
              principalId,
              delegateId,
              role: opts.existingRole,
              createdAt: NOW,
            }
          : null,
      ),
    },
    audit: { log: vi.fn(async () => {}) },
  };
  const repos = {
    ...txRepos,
    humans: {
      ...txRepos.humans,
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Ada Assistant" },
        identity: {
          email: opts.actorEmail ?? INVITED,
          emailVerified: opts.emailVerified ?? true,
        },
      })),
    },
    tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
      fn(txRepos),
    ),
  };
  const idempotency = makeIdempotency();
  const deps = {
    repos,
    clock: { now: () => NOW },
    idempotency,
    inviteSecret: opts.secret === undefined ? SECRET : opts.secret,
  };
  return {
    deps: deps as unknown as Parameters<typeof acceptDelegateInvite>[0] &
      Parameters<typeof createDelegateInvite>[0],
    txRepos,
    idempotency,
  };
}

async function mint(
  deps: Parameters<typeof createDelegateInvite>[0],
  role = "EDITOR",
) {
  return createDelegateInvite(deps, {
    actorHumanId: principalId,
    principalId,
    email: "Assistant@Example.com",
    role,
  });
}

describe("createDelegateInvite", () => {
  it("mints a signed, email-bound token and writes NO delegation", async () => {
    const { deps, txRepos } = makeDeps();
    const out = await mint(deps);

    expect(out.expiresAt.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
    const payload = verifyDelegateInviteToken(SECRET, out.token);
    expect(payload).toMatchObject({
      principalId,
      email: INVITED, // lower-cased
      role: "EDITOR",
      exp: out.expiresAt.getTime(),
    });
    expect(txRepos.humanDelegates.addDelegate).not.toHaveBeenCalled();
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "human.delegate_invite_created" }),
    );
  });

  it("never looks the email up (no existence oracle)", async () => {
    const { deps } = makeDeps();
    await mint(deps);
    expect(
      (deps.repos.humans as unknown as { getByIdWithIdentity: unknown })
        .getByIdWithIdentity,
    ).not.toHaveBeenCalled();
  });

  it("rejects when the actor is not the principal", async () => {
    const { deps } = makeDeps();
    await expect(
      createDelegateInvite(deps, {
        actorHumanId: strangerId,
        principalId,
        email: INVITED,
        role: "EDITOR",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects OWNER role", async () => {
    const { deps } = makeDeps();
    await expect(mint(deps, "OWNER")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("fails NOT_CONFIGURED without a usable secret", async () => {
    const { deps } = makeDeps({ secret: "short" });
    await expect(mint(deps)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("acceptDelegateInvite", () => {
  it("creates the delegation with the ACTOR as delegate, on the invited email", async () => {
    const { deps, txRepos } = makeDeps();
    const { token } = await mint(deps);

    const out = await acceptDelegateInvite(deps, {
      actorHumanId: delegateId,
      token,
    });

    expect(out).toEqual({
      principalId,
      principalName: "Pat Principal",
      role: "EDITOR",
    });
    expect(txRepos.humanDelegates.addDelegate).toHaveBeenCalledWith({
      principalId,
      delegateId,
      role: "EDITOR",
    });
    expect(txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "human.delegate_added",
        data: expect.objectContaining({ method: "invite_accepted" }),
      }),
    );
  });

  it("is single-use: a replayed link (e.g. after the principal removed the delegate) is rejected", async () => {
    const { deps, txRepos } = makeDeps();
    const { token } = await mint(deps);

    await acceptDelegateInvite(deps, { actorHumanId: delegateId, token });
    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
    expect(txRepos.humanDelegates.addDelegate).toHaveBeenCalledTimes(1);
  });

  it("rejects an account whose email differs from the invited one (forwarded link)", async () => {
    const { deps, txRepos } = makeDeps({ actorEmail: "someone-else@example.com" });
    const { token } = await mint(deps);

    await expect(
      acceptDelegateInvite(deps, { actorHumanId: strangerId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
    expect(txRepos.humanDelegates.addDelegate).not.toHaveBeenCalled();
  });

  it("requires a verified email", async () => {
    const { deps } = makeDeps({ emailVerified: false });
    const { token } = await mint(deps);
    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("rejects a tampered token (role escalation attempt)", async () => {
    const { deps } = makeDeps();
    const { token } = await mint(deps, "VIEWER");
    const [v, body, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString());
    decoded.r = "ADMIN";
    const forged = `${v}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${sig}`;

    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token: forged }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  });

  it("rejects a token signed with a different secret", async () => {
    const { deps } = makeDeps();
    const token = signDelegateInviteToken("x".repeat(48), {
      principalId,
      email: INVITED,
      role: "ADMIN",
      exp: NOW.getTime() + 60_000,
      nonce: "n",
    });
    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  });

  it("rejects an expired token", async () => {
    const { deps } = makeDeps();
    const token = signDelegateInviteToken(SECRET, {
      principalId,
      email: INVITED,
      role: "EDITOR",
      exp: NOW.getTime() - 1,
      nonce: "n",
    });
    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
  });

  it("rejects the principal accepting their own invite", async () => {
    const { deps } = makeDeps();
    const { token } = await mint(deps);
    await expect(
      acceptDelegateInvite(deps, { actorHumanId: principalId, token }),
    ).rejects.toMatchObject({ code: "CANNOT_DELEGATE_TO_SELF" });
  });

  it("leaves an existing delegation's role unchanged (a link can't re-escalate)", async () => {
    const { deps, txRepos } = makeDeps({ existingRole: "VIEWER" });
    const { token } = await mint(deps, "ADMIN");

    const out = await acceptDelegateInvite(deps, {
      actorHumanId: delegateId,
      token,
    });
    expect(out.role).toBe("VIEWER");
    expect(txRepos.humanDelegates.addDelegate).not.toHaveBeenCalled();
  });

  it("releases the nonce claim when the grant write fails, so the link can be retried", async () => {
    const { deps, txRepos, idempotency } = makeDeps();
    const { token } = await mint(deps);
    txRepos.humanDelegates.addDelegate.mockRejectedValueOnce(
      new Error("db down"),
    );

    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toThrow("db down");
    const nonce = verifyDelegateInviteToken(SECRET, token)!.nonce;
    expect(idempotency.store.has(delegateInviteNonceKey(nonce))).toBe(false);

    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).resolves.toMatchObject({ role: "EDITOR" });
  });
});

describe("acceptDelegateInvite — nonce durability", () => {
  it("claims the nonce for the token's remaining life + grace, not a short in-progress TTL", async () => {
    const { deps, idempotency } = makeDeps();
    const { token, expiresAt } = await mint(deps);
    await acceptDelegateInvite(deps, { actorHumanId: delegateId, token });

    const remaining = Math.ceil((expiresAt.getTime() - NOW.getTime()) / 1000);
    expect(idempotency.begin).toHaveBeenCalledWith(
      expect.stringMatching(/^delegate-invite:nonce:/),
      remaining + USED_NONCE_GRACE_SEC,
      expect.any(String),
    );
  });

  it("a failed commit AFTER the grant still returns success, reports, and keeps the link single-use", async () => {
    const { deps, idempotency, txRepos } = makeDeps();
    const reportError = vi.fn();
    (deps as { reportError?: unknown }).reportError = reportError;
    idempotency.commit.mockRejectedValueOnce(new Error("idempotency db down"));
    const { token } = await mint(deps);

    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).resolves.toMatchObject({ role: "EDITOR" });
    expect(txRepos.humanDelegates.addDelegate).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ area: "nonce_commit" }),
      }),
    );
    // The long-lived claim still holds the nonce: a replay is refused.
    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
  });
});

describe("previewDelegateInvite", () => {
  it("names the inviter and role for the invited account, and claims nothing", async () => {
    const { deps, idempotency, txRepos } = makeDeps();
    const { token } = await mint(deps, "FINANCE");

    await expect(
      previewDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).resolves.toEqual({ principalName: "Pat Principal", role: "FINANCE" });
    expect(idempotency.begin).not.toHaveBeenCalled();
    expect(txRepos.humanDelegates.addDelegate).not.toHaveBeenCalled();
  });

  it("reveals nothing to a different account", async () => {
    const { deps } = makeDeps({ actorEmail: "someone-else@example.com" });
    const { token } = await mint(deps);
    const err = await previewDelegateInvite(deps, {
      actorHumanId: strangerId,
      token,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INVITATION_NOT_FOUND" });
    expect(JSON.stringify(err)).not.toContain("Pat Principal");
  });

  it("reports an already-used link", async () => {
    const { deps } = makeDeps();
    const { token } = await mint(deps);
    await acceptDelegateInvite(deps, { actorHumanId: delegateId, token });
    await expect(
      previewDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
  });
});

describe("previewDelegateInvite — agrees with accept on in-progress claims", () => {
  it("reports an in-progress claim (grant landed, commit failed) as already used", async () => {
    const { deps, idempotency } = makeDeps();
    idempotency.commit.mockRejectedValueOnce(new Error("commit lost"));
    const { token } = await mint(deps);
    await acceptDelegateInvite(deps, { actorHumanId: delegateId, token });
    const nonce = verifyDelegateInviteToken(SECRET, token)!.nonce;
    expect(idempotency.store.get(delegateInviteNonceKey(nonce))?.status).toBe(
      "in_progress",
    );

    await expect(
      previewDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
    await expect(
      acceptDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
  });

  it("falls back to get() when the adapter has no status()", async () => {
    const { deps, idempotency } = makeDeps();
    const { token } = await mint(deps);
    await acceptDelegateInvite(deps, { actorHumanId: delegateId, token });
    (idempotency as { status?: unknown }).status = undefined;
    await expect(
      previewDelegateInvite(deps, { actorHumanId: delegateId, token }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
  });
});
