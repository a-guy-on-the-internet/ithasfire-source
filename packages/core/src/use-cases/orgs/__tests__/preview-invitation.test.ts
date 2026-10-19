import { describe, expect, it, vi } from "vitest";

import {
  previewInvitation,
  type PreviewInvitationDeps,
} from "../preview-invitation";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVITER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-09-29T00:00:00.000Z");

function makeDeps(
  opts: {
    status?: string;
    expiresAt?: Date;
    actorEmail?: string;
    emailVerified?: boolean;
    invitation?: null;
    role?: string;
    /** The inviter's membership row today. Defaults to ADMIN; null = removed. */
    inviterRole?: string | null;
  } = {},
) {
  const inviterRole = "inviterRole" in opts ? opts.inviterRole : "ADMIN";
  const organizations = {
    getInvitationByToken: vi.fn(async () =>
      opts.invitation === null
        ? null
        : {
            id: "inv-1",
            orgId: ORG_ID,
            email: "invitee@example.com",
            role: opts.role ?? "SCANNER",
            invitedByHumanId: INVITER_ID,
            status: opts.status ?? "PENDING",
            expiresAt: opts.expiresAt ?? new Date("2026-10-06T00:00:00.000Z"),
          },
    ),
    getById: vi.fn(async () => ({
      id: ORG_ID,
      name: "Test Org",
      status: "ACTIVE",
    })),
    updateInvitationStatus: vi.fn(),
    addMember: vi.fn(),
  };
  const humans = {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: ACTOR_ID },
      identity: {
        email: opts.actorEmail ?? "invitee@example.com",
        emailVerified: opts.emailVerified ?? true,
      },
    })),
  };
  const authz = {
    getOrgMembership: vi.fn(
      async (input: { orgId: string; humanId: string }) =>
        inviterRole && input.orgId === ORG_ID && input.humanId === INVITER_ID
          ? { orgId: ORG_ID, humanId: INVITER_ID, role: inviterRole }
          : null,
    ),
  };
  const deps = {
    repos: { organizations, humans, authz },
    clock: { now: () => NOW },
  } as unknown as PreviewInvitationDeps;
  return { deps, organizations, authz };
}

const input = { actorHumanId: ACTOR_ID, token: "tok" };

describe("previewInvitation", () => {
  it("returns org name + role to the invited, verified account, and writes nothing", async () => {
    const { deps, organizations } = makeDeps();
    await expect(previewInvitation(deps, input)).resolves.toEqual({
      orgName: "Test Org",
      role: "SCANNER",
    });
    expect(organizations.addMember).not.toHaveBeenCalled();
    expect(organizations.updateInvitationStatus).not.toHaveBeenCalled();
  });

  it("reveals nothing (not even the org name) to a different account", async () => {
    const { deps, organizations } = makeDeps({ actorEmail: "victim@example.com" });
    const err = await previewInvitation(deps, input).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INVITATION_NOT_FOUND" });
    expect(JSON.stringify(err)).not.toContain("Test Org");
    expect(organizations.getById).not.toHaveBeenCalled();
  });

  it("requires a verified email", async () => {
    const { deps } = makeDeps({ emailVerified: false });
    await expect(previewInvitation(deps, input)).rejects.toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });
  });

  it("reports expired / already-used / unknown tokens without writing", async () => {
    await expect(
      previewInvitation(makeDeps({ expiresAt: new Date("2026-01-01") }).deps, input),
    ).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
    await expect(
      previewInvitation(makeDeps({ status: "ACCEPTED" }).deps, input),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_PENDING" });
    await expect(
      previewInvitation(makeDeps({ invitation: null }).deps, input),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  });

  describe("an OWNER invitation needs an inviter who holds OWNER today", () => {
    it("previews it when the inviter is an OWNER", async () => {
      const { deps, authz } = makeDeps({ role: "OWNER", inviterRole: "OWNER" });

      await expect(previewInvitation(deps, input)).resolves.toEqual({
        orgName: "Test Org",
        role: "OWNER",
      });
      expect(authz.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: INVITER_ID,
      });
    });

    it.each([
      ["an ADMIN sent it", "ADMIN"],
      ["the inviter was demoted to EDITOR", "EDITOR"],
      ["the inviter left the org", null],
    ] as const)(
      "refuses as acceptInvitation does when %s, without naming the org",
      async (_label, inviterRole) => {
        const { deps } = makeDeps({ role: "OWNER", inviterRole });

        const err = await previewInvitation(deps, input).catch(
          (e: unknown) => e,
        );
        expect(err).toMatchObject({
          code: "INVITATION_NOT_PENDING",
          meta: { status: "REVOKED" },
        });
        expect(JSON.stringify(err)).not.toContain("Test Org");
      },
    );

    it("answers INVITATION_EXPIRED first for an expired OWNER invitation an ADMIN sent", async () => {
      const { deps } = makeDeps({
        role: "OWNER",
        inviterRole: "ADMIN",
        expiresAt: new Date("2026-01-01"),
      });

      await expect(previewInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_EXPIRED",
      });
    });

    it("still answers INVITATION_NOT_FOUND to an account it was not sent to", async () => {
      const { deps, authz } = makeDeps({
        role: "OWNER",
        inviterRole: "ADMIN",
        actorEmail: "victim@example.com",
      });

      await expect(previewInvitation(deps, input)).rejects.toMatchObject({
        code: "INVITATION_NOT_FOUND",
      });
      expect(authz.getOrgMembership).not.toHaveBeenCalled();
    });

    it("previews a non-OWNER invitation whose inviter has left, without reading the inviter", async () => {
      const { deps, authz } = makeDeps({ role: "ADMIN", inviterRole: null });

      await expect(previewInvitation(deps, input)).resolves.toEqual({
        orgName: "Test Org",
        role: "ADMIN",
      });
      expect(authz.getOrgMembership).not.toHaveBeenCalled();
    });
  });
});
