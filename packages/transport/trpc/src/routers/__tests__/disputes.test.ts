import { describe, expect, it, vi } from "vitest";

import { createCaller } from "./test-helpers";
import { disputesRouter } from "../disputes";
import { platformRouter } from "../platform";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const DISPUTE_ID = "dispute_1";

const nonStaffAuthz = () =>
  ({
    hasOrgRole: vi.fn(),
    requireOrgRole: vi.fn(),
    canEditEvent: vi.fn(),
    canManagePlace: vi.fn(),
    canFinanceOrg: vi.fn(),
    hasStaffRole: vi.fn(async () => ({ allowed: false })),
  }) as any;

// Every repo the desk could touch is a throwing spy: the staff gate must
// reject BEFORE any of them is reached, so a call here is a test failure.
const untouchedRepos = () => {
  const boom = vi.fn(async () => {
    throw new Error("repo reached past the staff gate");
  });
  return {
    disputes: { getById: boom, listForDesk: boom, updateEvidenceDetails: boom },
    disputeEvidence: { getByDisputeId: boom, upsertDraft: boom, update: boom },
    orders: { getById: boom },
    audit: { log: boom },
    tx: boom,
  } as any;
};

describe("platform.disputes router", () => {
  it("is mounted under platform.* so it inherits the second-factor gate", () => {
    // The nested router object exposes the same procedures as the module.
    expect(Object.keys(platformRouter.disputes)).toEqual(
      expect.arrayContaining(["list", "get", "assemble", "updateDraft", "approve", "submit"]),
    );
    expect(platformRouter.disputes).toBe(disputesRouter);
  });

  const procedures: Array<{
    name: keyof typeof disputesRouter;
    input: unknown;
    kind: "query" | "mutation";
  }> = [
    { name: "list", input: {}, kind: "query" },
    { name: "get", input: { disputeId: DISPUTE_ID }, kind: "query" },
    { name: "assemble", input: { disputeId: DISPUTE_ID }, kind: "mutation" },
    {
      name: "updateDraft",
      input: { disputeId: DISPUTE_ID, fields: { customerName: "x" } },
      kind: "mutation",
    },
    { name: "approve", input: { disputeId: DISPUTE_ID }, kind: "mutation" },
    { name: "submit", input: { disputeId: DISPUTE_ID }, kind: "mutation" },
  ];

  for (const { name, input } of procedures) {
    it(`${String(name)} rejects a non-staff actor with FORBIDDEN before touching repos`, async () => {
      const repos = untouchedRepos();
      const { caller } = createCaller(
        { [name]: disputesRouter[name] } as any,
        { actorHumanId: ACTOR_ID, authz: nonStaffAuthz(), repos },
      );

      await expect((caller as any)[name](input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      for (const repo of Object.values(repos) as any[]) {
        if (typeof repo === "function") {
          expect(repo).not.toHaveBeenCalled();
          continue;
        }
        for (const fn of Object.values(repo) as any[]) {
          expect(fn).not.toHaveBeenCalled();
        }
      }
    });

    it(`${String(name)} rejects an anonymous caller with UNAUTHORIZED`, async () => {
      const { caller } = createCaller(
        { [name]: disputesRouter[name] } as any,
        { actorHumanId: null, repos: untouchedRepos() },
      );
      await expect((caller as any)[name](input)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  }

  it("submit does not accept a client-supplied idempotency key", async () => {
    const { caller } = createCaller(
      { submit: disputesRouter.submit },
      { actorHumanId: ACTOR_ID, authz: nonStaffAuthz(), repos: untouchedRepos() },
    );
    await expect(
      caller.submit({ disputeId: DISPUTE_ID, idempotencyKey: "attacker-key" } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("updateDraft rejects file-id fields at the transport boundary", async () => {
    const { caller } = createCaller(
      { updateDraft: disputesRouter.updateDraft },
      { actorHumanId: ACTOR_ID, authz: nonStaffAuthz(), repos: untouchedRepos() },
    );
    await expect(
      caller.updateDraft({ disputeId: DISPUTE_ID, fields: { receipt: "file_1" } } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("list passes the actor through to the use case for a staff caller", async () => {
    const listForDesk = vi.fn(async () => ({ items: [], nextCursor: null }));
    const { caller } = createCaller(
      { list: disputesRouter.list },
      {
        actorHumanId: ACTOR_ID,
        authz: {
          ...nonStaffAuthz(),
          hasStaffRole: vi.fn(async () => ({ allowed: true })),
        },
        repos: { disputes: { listForDesk } } as any,
      },
    );
    const result = await caller.list({ status: "closed", limit: 5 });
    expect(result).toEqual({ items: [], nextCursor: null });
    expect(listForDesk).toHaveBeenCalledWith({ status: "closed", cursor: null, limit: 5 });
  });
});
