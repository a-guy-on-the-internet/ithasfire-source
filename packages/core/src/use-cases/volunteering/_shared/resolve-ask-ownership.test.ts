import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";

import { resolveAskOwnership } from "./resolve-ask-ownership";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const PLACE_ID = "00000000-0000-4000-8000-000000000003";
const EVENT_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000005";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const humanOwnedPlace = {
  id: PLACE_ID,
  name: "The Hall",
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  humanIdsWithAccess: [ACTOR_ID],
  orgIdsWithAccess: [],
} as unknown as PlaceRecord;

const orgOwnedPlace = {
  ...humanOwnedPlace,
  humanIdsWithAccess: [],
  orgIdsWithAccess: [ORG_ID],
} as unknown as PlaceRecord;

const orgEvent = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Night Market",
  status: "PUBLISHED",
} as unknown as EventRecord;

const humanEvent = {
  ...orgEvent,
  orgId: null,
  humanId: ACTOR_ID,
} as unknown as EventRecord;

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeTx(overrides: Record<string, unknown> = {}): TxRepos {
  return {
    places: { getById: vi.fn(async () => humanOwnedPlace) },
    events: { getById: vi.fn(async () => orgEvent) },
    authz: {
      getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "EDITOR" })),
      getOrgMemberships: vi.fn(async () => [
        { orgId: ORG_ID, role: "EDITOR" },
      ]),
    },
    humanDelegates: { getDelegation: vi.fn(async () => null) },
    ...overrides,
  } as unknown as TxRepos;
}

// ══════════════════════════════════════════════════════════════════════════════

describe("resolveAskOwnership — PLACE", () => {
  it("allows a direct human owner and returns the loaded place", async () => {
    const tx = makeTx();
    const result = await resolveAskOwnership(
      tx,
      { subjectType: "PLACE", subjectId: PLACE_ID, orgId: null },
      ACTOR_ID,
    );
    expect(result.place).toEqual(humanOwnedPlace);
    expect(result.event).toBeNull();
    expect(result.placeAccess).toEqual({
      via: "human",
      orgId: null,
      orgRole: null,
    });
  });

  it("allows an EDITOR of an owning org", async () => {
    const tx = makeTx({ places: { getById: vi.fn(async () => orgOwnedPlace) } });
    const result = await resolveAskOwnership(
      tx,
      { subjectType: "PLACE", subjectId: PLACE_ID, orgId: ORG_ID },
      ACTOR_ID,
    );
    expect(result.place).toEqual(orgOwnedPlace);
    expect(result.placeAccess).toEqual({
      via: "org",
      orgId: ORG_ID,
      orgRole: "EDITOR",
    });
  });

  it("rejects a VIEWER of the owning org", async () => {
    const tx = makeTx({
      places: { getById: vi.fn(async () => orgOwnedPlace) },
      authz: {
        getOrgMemberships: vi.fn(async () => [
          { orgId: ORG_ID, role: "VIEWER" },
        ]),
      },
    });
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "PLACE", subjectId: PLACE_ID, orgId: ORG_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects a stranger with no ownership path", async () => {
    const tx = makeTx();
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "PLACE", subjectId: PLACE_ID, orgId: null },
        OTHER_HUMAN_ID,
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects when the place is gone", async () => {
    const tx = makeTx({ places: { getById: vi.fn(async () => null) } });
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "PLACE", subjectId: PLACE_ID, orgId: null },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });
});

describe("resolveAskOwnership — ORG", () => {
  it("allows an org EDITOR", async () => {
    const tx = makeTx();
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "ORG", subjectId: ORG_ID, orgId: ORG_ID },
        ACTOR_ID,
      ),
    ).resolves.toEqual({ place: null, placeAccess: null, event: null });
  });

  it("rejects a VIEWER", async () => {
    const tx = makeTx({
      authz: {
        getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "VIEWER" })),
      },
    });
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "ORG", subjectId: ORG_ID, orgId: ORG_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects a non-member", async () => {
    const tx = makeTx({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "ORG", subjectId: ORG_ID, orgId: ORG_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

describe("resolveAskOwnership — HUMAN", () => {
  it("allows the subject human themselves", async () => {
    const tx = makeTx();
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "HUMAN", subjectId: ACTOR_ID, orgId: null },
        ACTOR_ID,
      ),
    ).resolves.toEqual({ place: null, placeAccess: null, event: null });
  });

  it("allows an edit-capable delegate of the subject", async () => {
    const getDelegation = vi.fn(async () => ({
      id: "d1",
      principalId: OTHER_HUMAN_ID,
      delegateId: ACTOR_ID,
      role: "EDITOR",
      createdAt: new Date(),
    }));
    const tx = makeTx({ humanDelegates: { getDelegation } });
    await resolveAskOwnership(
      tx,
      { subjectType: "HUMAN", subjectId: OTHER_HUMAN_ID, orgId: null },
      ACTOR_ID,
    );
    expect(getDelegation).toHaveBeenCalledWith({
      principalId: OTHER_HUMAN_ID,
      delegateId: ACTOR_ID,
    });
  });

  it("rejects a view-only delegate", async () => {
    const tx = makeTx({
      humanDelegates: {
        getDelegation: vi.fn(async () => ({
          id: "d1",
          principalId: OTHER_HUMAN_ID,
          delegateId: ACTOR_ID,
          role: "VIEWER",
          createdAt: new Date(),
        })),
      },
    });
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "HUMAN", subjectId: OTHER_HUMAN_ID, orgId: null },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects acting for another human without any delegation", async () => {
    const tx = makeTx();
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "HUMAN", subjectId: OTHER_HUMAN_ID, orgId: null },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

describe("resolveAskOwnership — EVENT", () => {
  it("allows an EDITOR of the event's org and returns the event", async () => {
    const tx = makeTx();
    const result = await resolveAskOwnership(
      tx,
      { subjectType: "EVENT", subjectId: EVENT_ID, orgId: ORG_ID },
      ACTOR_ID,
    );
    expect(result.event).toEqual(orgEvent);
  });

  it("rejects when the event is gone", async () => {
    const tx = makeTx({ events: { getById: vi.fn(async () => null) } });
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "EVENT", subjectId: EVENT_ID, orgId: null },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects human-owned events (mirrors the event volunteering gate)", async () => {
    const tx = makeTx({ events: { getById: vi.fn(async () => humanEvent) } });
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "EVENT", subjectId: EVENT_ID, orgId: null },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ORG_OWNED" });
  });

  it("rejects a VIEWER of the event's org", async () => {
    const tx = makeTx({
      authz: {
        getOrgMembership: vi.fn(async () => ({ orgId: ORG_ID, role: "VIEWER" })),
      },
    });
    await expect(
      resolveAskOwnership(
        tx,
        { subjectType: "EVENT", subjectId: EVENT_ID, orgId: ORG_ID },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
