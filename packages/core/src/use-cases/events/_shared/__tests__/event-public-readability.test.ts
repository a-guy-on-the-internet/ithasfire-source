import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import {
  canViewerReadEvent,
  canViewerReadUnpublishedEvent,
} from "../event-public-readability";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const communityDraft = {
  id: "33333333-3333-4333-8333-333333333333",
  status: "DRAFT",
  publishedAt: null,
  orgId: null,
  humanId: null,
  stewardship: "COMMUNITY",
} as unknown as EventRecord;

const ownedDraft = {
  ...communityDraft,
  orgId: ORG_ID,
  stewardship: "OWNED",
} as unknown as EventRecord;

function makeAuthzRepo(orgRole: string | null = null) {
  return {
    getOrgMembership: vi.fn(async () =>
      orgRole ? { orgId: ORG_ID, humanId: VIEWER, role: orgRole } : null,
    ),
    getHumanDelegation: vi.fn(async () => null),
    // The raw role read. A hidden read must never be decided from it.
    getStaffRolesForHumanId: vi.fn(async () => ["COMMUNITY_MODERATOR", "ADMIN"]),
  } as never;
}

/** The authz port's staff probe, as the adapter answers it. */
function makeStaffProbe(answer: {
  allowed: boolean;
  secondFactorRequired?: true;
}) {
  return { hasStaffRole: vi.fn(async () => answer) };
}

describe("canViewerReadUnpublishedEvent — the community-moderator read", () => {
  it("lets a moderator with a second factor enrolled read a hidden COMMUNITY listing", async () => {
    const staff = makeStaffProbe({ allowed: true });

    await expect(
      canViewerReadUnpublishedEvent(
        makeAuthzRepo(),
        communityDraft,
        VIEWER,
        staff,
      ),
    ).resolves.toBe(true);
    // The default probe: no opt-out, so the port applies the second-factor rule.
    expect(staff.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: VIEWER,
      requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
    });
  });

  it("refuses a moderator with no second factor enrolled", async () => {
    const staff = makeStaffProbe({
      allowed: false,
      secondFactorRequired: true,
    });

    await expect(
      canViewerReadUnpublishedEvent(
        makeAuthzRepo(),
        communityDraft,
        VIEWER,
        staff,
      ),
    ).resolves.toBe(false);
  });

  it("refuses a viewer with no moderation role", async () => {
    await expect(
      canViewerReadUnpublishedEvent(
        makeAuthzRepo(),
        communityDraft,
        VIEWER,
        makeStaffProbe({ allowed: false }),
      ),
    ).resolves.toBe(false);
  });

  it("decides from the probe alone, whatever roles the repo holds", async () => {
    const authz = makeAuthzRepo();

    await expect(
      canViewerReadUnpublishedEvent(
        authz,
        communityDraft,
        VIEWER,
        makeStaffProbe({ allowed: false }),
      ),
    ).resolves.toBe(false);
    expect(
      (authz as { getStaffRolesForHumanId: ReturnType<typeof vi.fn> })
        .getStaffRolesForHumanId,
    ).not.toHaveBeenCalled();
  });

  it("never asks about an anonymous viewer", async () => {
    const staff = makeStaffProbe({ allowed: true });

    await expect(
      canViewerReadUnpublishedEvent(
        makeAuthzRepo(),
        communityDraft,
        null,
        staff,
      ),
    ).resolves.toBe(false);
    expect(staff.hasStaffRole).not.toHaveBeenCalled();
  });
});

describe("canViewerReadUnpublishedEvent — an owned event", () => {
  // Ownership is not a staff grant. An org editor who also holds a staff role
  // with no second factor keeps the read their membership gives, and the staff
  // probe is not consulted.
  it("lets an org EDITOR who is also un-enrolled staff read through the edit-rights branch", async () => {
    const staff = makeStaffProbe({
      allowed: false,
      secondFactorRequired: true,
    });

    await expect(
      canViewerReadUnpublishedEvent(
        makeAuthzRepo("EDITOR"),
        ownedDraft,
        VIEWER,
        staff,
      ),
    ).resolves.toBe(true);
    expect(staff.hasStaffRole).not.toHaveBeenCalled();
  });

  it("lets the human owner read without asking the staff probe", async () => {
    const event = {
      ...ownedDraft,
      orgId: null,
      humanId: VIEWER,
    } as unknown as EventRecord;
    const staff = makeStaffProbe({ allowed: false });

    await expect(
      canViewerReadUnpublishedEvent(makeAuthzRepo(), event, VIEWER, staff),
    ).resolves.toBe(true);
    expect(staff.hasStaffRole).not.toHaveBeenCalled();
  });

  it("gives an enrolled staff member with no edit role no read of an OWNED draft", async () => {
    await expect(
      canViewerReadUnpublishedEvent(
        makeAuthzRepo("VIEWER"),
        ownedDraft,
        VIEWER,
        makeStaffProbe({ allowed: true }),
      ),
    ).resolves.toBe(false);
  });
});

describe("canViewerReadEvent", () => {
  it("passes the staff probe through to the hidden-event read", async () => {
    const authz = makeAuthzRepo();

    await expect(
      canViewerReadEvent(
        authz,
        communityDraft,
        VIEWER,
        undefined,
        makeStaffProbe({ allowed: true }),
      ),
    ).resolves.toBe(true);
    await expect(
      canViewerReadEvent(
        authz,
        communityDraft,
        VIEWER,
        undefined,
        makeStaffProbe({ allowed: false, secondFactorRequired: true }),
      ),
    ).resolves.toBe(false);
  });

  it("reads a PUBLISHED listing without asking the probe", async () => {
    const published = {
      ...communityDraft,
      status: "PUBLISHED",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
    } as unknown as EventRecord;
    const staff = makeStaffProbe({ allowed: false });

    await expect(
      canViewerReadEvent(makeAuthzRepo(), published, null, undefined, staff),
    ).resolves.toBe(true);
    expect(staff.hasStaffRole).not.toHaveBeenCalled();
  });
});
