import { describe, expect, it, vi } from "vitest";

import {
  actorHoldsEventEditRole,
  canonicalEmail,
  ensureActorHoldsHumanEventRole,
  ensurePayoutRoutingActor,
  guardPayoutTermsDraftWrite,
  isEditDelegateOfHumanOwner,
} from "../event-edit-rights";
import { ORG_ADMIN_ROLES } from "../rbac";

const ORG = "org-1";
const OWNER = "owner-1";
const ACTOR = "actor-1";

function authz(opts: { orgRole?: string; delegateRole?: string } = {}) {
  return {
    getOrgMembership: vi.fn(async () =>
      opts.orgRole ? { orgId: ORG, humanId: ACTOR, role: opts.orgRole } : null,
    ),
    getHumanDelegation: vi.fn(async () =>
      opts.delegateRole
        ? { orgId: OWNER, humanId: ACTOR, role: opts.delegateRole }
        : null,
    ),
  } as never as Parameters<typeof actorHoldsEventEditRole>[0];
}

describe("actorHoldsEventEditRole", () => {
  it("nobody anonymous", async () => {
    const a = authz({ orgRole: "OWNER" });
    await expect(
      actorHoldsEventEditRole(a, { orgId: ORG, humanId: null }, null),
    ).resolves.toBe(false);
    expect(a.getOrgMembership).not.toHaveBeenCalled();
  });

  describe("org-owned", () => {
    it.each(["OWNER", "ADMIN", "EDITOR"])("admits an org %s", async (role) => {
      await expect(
        actorHoldsEventEditRole(
          authz({ orgRole: role }),
          { orgId: ORG, humanId: null },
          ACTOR,
        ),
      ).resolves.toBe(true);
    });

    it.each(["VIEWER", "FINANCE", "SCANNER"])(
      "refuses an org %s",
      async (role) => {
        await expect(
          actorHoldsEventEditRole(
            authz({ orgRole: role }),
            { orgId: ORG, humanId: null },
            ACTOR,
          ),
        ).resolves.toBe(false);
      },
    );

    it("never consults the human owner's delegations", async () => {
      const a = authz({ delegateRole: "OWNER" });
      await expect(
        actorHoldsEventEditRole(a, { orgId: ORG, humanId: OWNER }, ACTOR),
      ).resolves.toBe(false);
      expect(a.getHumanDelegation).not.toHaveBeenCalled();
    });
  });

  describe("human-owned", () => {
    it("admits the owner without a delegation lookup", async () => {
      const a = authz();
      await expect(
        actorHoldsEventEditRole(a, { orgId: null, humanId: OWNER }, OWNER),
      ).resolves.toBe(true);
      expect(a.getHumanDelegation).not.toHaveBeenCalled();
    });

    it.each(["OWNER", "ADMIN", "EDITOR"])(
      "admits a %s delegate of the owner",
      async (role) => {
        const a = authz({ delegateRole: role });
        await expect(
          actorHoldsEventEditRole(a, { orgId: null, humanId: OWNER }, ACTOR),
        ).resolves.toBe(true);
        expect(a.getHumanDelegation).toHaveBeenCalledWith({
          principalId: OWNER,
          delegateId: ACTOR,
        });
      },
    );

    it.each(["VIEWER", "FINANCE", "SCANNER"])(
      "refuses a %s delegate of the owner",
      async (role) => {
        await expect(
          actorHoldsEventEditRole(
            authz({ delegateRole: role }),
            { orgId: null, humanId: OWNER },
            ACTOR,
          ),
        ).resolves.toBe(false);
      },
    );

    it("refuses a stranger", async () => {
      await expect(
        actorHoldsEventEditRole(authz(), { orgId: null, humanId: OWNER }, ACTOR),
      ).resolves.toBe(false);
    });
  });

  it("refuses everyone on an ownerless row", async () => {
    await expect(
      actorHoldsEventEditRole(
        authz({ orgRole: "OWNER", delegateRole: "OWNER" }),
        { orgId: null, humanId: null },
        ACTOR,
      ),
    ).resolves.toBe(false);
  });
});

describe("actorHoldsEventEditRole — a narrower role set", () => {
  // Unpublish / delete / archive / complete ask ORG_ADMIN_ROLES of an org
  // member; the delegate arm asks the same set, so an EDITOR delegate can
  // publish but not unpublish, exactly like an org EDITOR.
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["EDITOR", false],
    ["VIEWER", false],
  ] as const)("a %s delegate under ORG_ADMIN_ROLES → %s", async (role, ok) => {
    await expect(
      actorHoldsEventEditRole(
        authz({ delegateRole: role }),
        { orgId: null, humanId: OWNER },
        ACTOR,
        ORG_ADMIN_ROLES,
      ),
    ).resolves.toBe(ok);
  });

  it("applies the same set to the org arm", async () => {
    await expect(
      actorHoldsEventEditRole(
        authz({ orgRole: "EDITOR" }),
        { orgId: ORG, humanId: null },
        ACTOR,
        ORG_ADMIN_ROLES,
      ),
    ).resolves.toBe(false);
  });

  it("the owner is admitted whatever the set", async () => {
    await expect(
      actorHoldsEventEditRole(
        authz(),
        { orgId: null, humanId: OWNER },
        OWNER,
        ORG_ADMIN_ROLES,
      ),
    ).resolves.toBe(true);
  });
});

describe("ensureActorHoldsHumanEventRole", () => {
  it.each(["OWNER", "ADMIN", "EDITOR"])(
    "passes a %s delegate",
    async (role) => {
      await expect(
        ensureActorHoldsHumanEventRole(
          authz({ delegateRole: role }),
          OWNER,
          ACTOR,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each([["VIEWER"], ["FINANCE"], ["SCANNER"], [undefined]])(
    "refuses a %s delegate (or stranger) with the owner-only refusal, byte for byte",
    async (role) => {
      await expect(
        ensureActorHoldsHumanEventRole(
          authz(role ? { delegateRole: role } : {}),
          OWNER,
          ACTOR,
        ),
      ).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "event" },
      });
    },
  );

  it("refuses an ownerless row without a lookup", async () => {
    const a = authz({ delegateRole: "OWNER" });
    await expect(
      ensureActorHoldsHumanEventRole(a, null, ACTOR),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(a.getHumanDelegation).not.toHaveBeenCalled();
  });
});

describe("ensurePayoutRoutingActor (owner ruling 2026-09-28)", () => {
  it("passes the human owner", () => {
    expect(() =>
      ensurePayoutRoutingActor({ orgId: null, humanId: OWNER }, OWNER),
    ).not.toThrow();
  });

  it("refuses anyone else on a human-owned event — delegates included", () => {
    expect(() =>
      ensurePayoutRoutingActor({ orgId: null, humanId: OWNER }, ACTOR),
    ).toThrow(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
    expect(() =>
      ensurePayoutRoutingActor(
        { orgId: null, humanId: OWNER },
        ACTOR,
        "INSUFFICIENT_ROLE",
      ),
    ).toThrow(expect.objectContaining({ code: "INSUFFICIENT_ROLE" }));
  });

  it("refuses everyone on an ownerless row", () => {
    expect(() =>
      ensurePayoutRoutingActor({ orgId: null, humanId: null }, ACTOR),
    ).toThrow(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
  });

  it("leaves an org event to the caller's org arm", () => {
    expect(() =>
      ensurePayoutRoutingActor({ orgId: ORG, humanId: OWNER }, ACTOR),
    ).not.toThrow();
  });
});

describe("isEditDelegateOfHumanOwner", () => {
  it("is true only for an edit-role delegate of a HUMAN owner", async () => {
    await expect(
      isEditDelegateOfHumanOwner(
        authz({ delegateRole: "EDITOR" }),
        { ownerType: "HUMAN", ownerId: OWNER },
        ACTOR,
      ),
    ).resolves.toBe(true);
    await expect(
      isEditDelegateOfHumanOwner(
        authz({ delegateRole: "VIEWER" }),
        { ownerType: "HUMAN", ownerId: OWNER },
        ACTOR,
      ),
    ).resolves.toBe(false);
  });

  it("is false for the owner themself and for an org, without a lookup", async () => {
    const a = authz({ delegateRole: "OWNER" });
    await expect(
      isEditDelegateOfHumanOwner(a, { ownerType: "HUMAN", ownerId: OWNER }, OWNER),
    ).resolves.toBe(false);
    await expect(
      isEditDelegateOfHumanOwner(
        a,
        { ownerType: "ORGANIZATION", ownerId: ORG },
        ACTOR,
      ),
    ).resolves.toBe(false);
    expect(a.getHumanDelegation).not.toHaveBeenCalled();
  });
});

describe("guardPayoutTermsDraftWrite (template / series defaults)", () => {
  const draft = { lines: [{ payeeId: "p", percent: 100, floorCents: 0 }] };
  const other = { lines: [{ payeeId: "x", percent: 100, floorCents: 0 }] };

  it("refuses a delegate's non-null draft on a HUMAN scope (create or update)", () => {
    expect(() =>
      guardPayoutTermsDraftWrite({
        ownerScope: "HUMAN",
        ownerId: OWNER,
        actorHumanId: ACTOR,
        incoming: { payoutTermsDraft: other },
        stored: null,
      }),
    ).toThrow(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
    expect(() =>
      guardPayoutTermsDraftWrite({
        ownerScope: "HUMAN",
        ownerId: OWNER,
        actorHumanId: ACTOR,
        incoming: { agreementDraft: other },
        stored: null,
      }),
    ).toThrow(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
  });

  it("carries the stored draft over a delegate's save — even one that clears defaults", () => {
    expect(
      guardPayoutTermsDraftWrite({
        ownerScope: "HUMAN",
        ownerId: OWNER,
        actorHumanId: ACTOR,
        incoming: { title: "t" } as { title: string; payoutTermsDraft?: unknown },
        stored: { payoutTermsDraft: draft },
      }),
    ).toEqual({ title: "t", payoutTermsDraft: draft });
    expect(
      guardPayoutTermsDraftWrite({
        ownerScope: "HUMAN",
        ownerId: OWNER,
        actorHumanId: ACTOR,
        incoming: null,
        stored: { payoutTermsDraft: draft },
      }),
    ).toEqual({ payoutTermsDraft: draft });
  });

  it("leaves the owner and every org write untouched", () => {
    const incoming = { payoutTermsDraft: other };
    expect(
      guardPayoutTermsDraftWrite({
        ownerScope: "HUMAN",
        ownerId: OWNER,
        actorHumanId: OWNER,
        incoming,
        stored: { payoutTermsDraft: draft },
      }),
    ).toBe(incoming);
    expect(
      guardPayoutTermsDraftWrite({
        ownerScope: "ORGANIZATION",
        ownerId: ORG,
        actorHumanId: ACTOR,
        incoming,
        stored: { payoutTermsDraft: draft },
      }),
    ).toBe(incoming);
  });
});

describe("canonicalEmail", () => {
  it.each([
    ["dele+x@gmail.com", "dele@gmail.com"],
    ["d.e.l.e@gmail.com", "dele@gmail.com"],
    ["DELE@googlemail.com", "dele@gmail.com"],
    ["  Dele+a.b@Example.com ", "dele@example.com"],
    ["d.ele@example.com", "d.ele@example.com"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalEmail(input)).toBe(expected);
  });

  it("returns null for empty input", () => {
    expect(canonicalEmail("  ")).toBeNull();
    expect(canonicalEmail(null)).toBeNull();
  });
});
