import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type { EventRecord } from "@th/ports/repos/events";

import {
  canViewerBypassEventGate,
  ensureActorCanEditEvent,
} from "../ensure-actor-can-edit-event";
import { ensureOwnerOrCommunityModerator } from "../ensure-owner-or-community-moderator";

// Owner ruling 2026-09-28: an OWNER/ADMIN/EDITOR delegate of a human owner
// gets the full editing surface of the principal's personal events — the
// builder's write guards AND the password/application gate bypass. VIEWER /
// FINANCE / SCANNER delegates stay out. Org and community behaviour does not
// move.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const DELEGATE_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: PRINCIPAL_ID,
    stewardship: "OWNED",
    status: "DRAFT",
    ...overrides,
  } as EventRecord;
}

type Membership = { orgId: string; humanId: string; role: OrgRole };

function authz(
  opts: { delegateRole?: OrgRole | null; orgRole?: OrgRole } = {},
) {
  return {
    getOrgMembership: vi.fn(
      async (): Promise<Membership | null> =>
        opts.orgRole
          ? { orgId: ORG_ID, humanId: DELEGATE_ID, role: opts.orgRole }
          : null,
    ),
    getHumanDelegation: vi.fn(
      async (): Promise<Membership | null> =>
        opts.delegateRole
          ? {
              orgId: PRINCIPAL_ID,
              humanId: DELEGATE_ID,
              role: opts.delegateRole,
            }
          : null,
    ),
  };
}

function tx(row: EventRecord, a: ReturnType<typeof authz>): TxRepos {
  return {
    events: { getById: vi.fn(async () => row) },
    authz: a,
  } as unknown as TxRepos;
}

const EDIT = ["OWNER", "ADMIN", "EDITOR"] as const;
const NON_EDIT = [["VIEWER"], ["FINANCE"], ["SCANNER"], [null]] as const;

describe("ensureActorCanEditEvent (settings, access controls, forms, provenance…)", () => {
  it.each(EDIT)("admits a %s delegate of the human owner", async (role) => {
    const a = authz({ delegateRole: role });
    await expect(
      ensureActorCanEditEvent(tx(event(), a), EVENT_ID, DELEGATE_ID),
    ).resolves.toMatchObject({ id: EVENT_ID, humanId: PRINCIPAL_ID });
    expect(a.getHumanDelegation).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      delegateId: DELEGATE_ID,
    });
  });

  it.each(NON_EDIT)(
    "refuses a %s delegate (or a stranger) with INSUFFICIENT_ROLE",
    async (role) => {
      await expect(
        ensureActorCanEditEvent(
          tx(event(), authz({ delegateRole: role })),
          EVENT_ID,
          DELEGATE_ID,
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    },
  );

  it("a COMMUNITY listing stays shut, even to a would-be delegate", async () => {
    await expect(
      ensureActorCanEditEvent(
        tx(
          event({ stewardship: "COMMUNITY", humanId: null }),
          authz({ delegateRole: "OWNER" }),
        ),
        EVENT_ID,
        DELEGATE_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("an org event never consults a delegation", async () => {
    const a = authz({ delegateRole: "OWNER" });
    await expect(
      ensureActorCanEditEvent(
        tx(event({ orgId: ORG_ID }), a),
        EVENT_ID,
        DELEGATE_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(a.getHumanDelegation).not.toHaveBeenCalled();
  });
});

describe("canViewerBypassEventGate (password / application gate bypass)", () => {
  it.each(EDIT)("a %s delegate bypasses the principal's gate", async (role) => {
    await expect(
      canViewerBypassEventGate(
        authz({ delegateRole: role }),
        event({ gateType: "PASSWORD" }),
        DELEGATE_ID,
      ),
    ).resolves.toBe(true);
  });

  it.each(NON_EDIT)("a %s delegate (or a stranger) meets it", async (role) => {
    await expect(
      canViewerBypassEventGate(
        authz({ delegateRole: role }),
        event({ gateType: "PASSWORD" }),
        DELEGATE_ID,
      ),
    ).resolves.toBe(false);
  });

  it("an anonymous viewer meets it without a lookup", async () => {
    const a = authz({ delegateRole: "OWNER" });
    await expect(canViewerBypassEventGate(a, event(), null)).resolves.toBe(
      false,
    );
    expect(a.getHumanDelegation).not.toHaveBeenCalled();
  });
});

describe("ensureOwnerOrCommunityModerator (lineup, tags)", () => {
  const deps = (a: ReturnType<typeof authz>, moderator = false) => ({
    repos: { authz: a },
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: moderator })) },
  });

  it.each(EDIT)("admits a %s delegate of the human owner", async (role) => {
    await expect(
      ensureOwnerOrCommunityModerator(
        deps(authz({ delegateRole: role })) as never,
        event(),
        DELEGATE_ID,
      ),
    ).resolves.toBeUndefined();
  });

  it.each(NON_EDIT)(
    "refuses a %s delegate (or a stranger) with NOT_RESOURCE_OWNER",
    async (role) => {
      await expect(
        ensureOwnerOrCommunityModerator(
          deps(authz({ delegateRole: role })) as never,
          event(),
          DELEGATE_ID,
        ),
      ).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "event" },
      });
    },
  );

  it("a COMMUNITY listing still asks for a moderator, not a delegation", async () => {
    const a = authz({ delegateRole: "OWNER" });
    await expect(
      ensureOwnerOrCommunityModerator(
        deps(a) as never,
        event({ stewardship: "COMMUNITY", humanId: null }),
        DELEGATE_ID,
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(a.getHumanDelegation).not.toHaveBeenCalled();
  });
});
