import { describe, expect, it, vi } from "vitest";

import {
  requireOrgOwnedTemplate,
  requireTemplateOrgMembership,
  tryOrgOwnedTemplate,
} from "./require-org-owned-template";

const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

const orgRow = { orgId: ORG_ID, isPlatform: false, name: "Bar Staff" };
const platformRow = { orgId: null, isPlatform: true, name: "Door" };

describe("requireOrgOwnedTemplate", () => {
  it("returns the row and its narrowed orgId for an org-owned template", () => {
    const { template, orgId } = requireOrgOwnedTemplate(orgRow);
    expect(template).toBe(orgRow);
    // Narrowed to `string` by control flow — no assertion, no `?? ""`.
    expect(orgId).toBe(ORG_ID);
  });

  it("rejects a platform row with the same code as a missing one", () => {
    expect(() => requireOrgOwnedTemplate(platformRow)).toThrow(
      expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }),
    );
    expect(() => requireOrgOwnedTemplate(null)).toThrow(
      expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }),
    );
  });

  it("fails closed on a MIS-SHAPED platform row that still carries an orgId", () => {
    // The flag alone gates the rejection, so a row that shouldn't exist
    // (isPlatform true WITH an owner) is refused rather than treated as
    // that org's editable template.
    expect(() =>
      requireOrgOwnedTemplate({ ...platformRow, orgId: ORG_ID }),
    ).toThrow(expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }));
  });

  it("refuses an unflagged row that has no owning org", () => {
    expect(() => requireOrgOwnedTemplate({ ...orgRow, orgId: null })).toThrow(
      expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }),
    );
  });
});

describe("tryOrgOwnedTemplate", () => {
  it("returns the row and its narrowed orgId for an org-owned template", () => {
    expect(tryOrgOwnedTemplate(orgRow)).toEqual({
      template: orgRow,
      orgId: ORG_ID,
    });
  });

  it("answers null — not a throw — for every row the require variant rejects", () => {
    // The two must agree on WHICH rows are org-owned; they differ only in
    // how they say no, so a read site can 404 without inventing its own
    // predicate.
    for (const row of [
      null,
      undefined,
      platformRow,
      { ...platformRow, orgId: ORG_ID }, // mis-shaped: flag set WITH an owner
      { ...orgRow, orgId: null }, // unflagged but unowned
    ]) {
      expect(tryOrgOwnedTemplate(row)).toBeNull();
      expect(() => requireOrgOwnedTemplate(row)).toThrow(
        expect.objectContaining({ code: "TEMPLATE_NOT_FOUND" }),
      );
    }
  });
});

describe("requireTemplateOrgMembership", () => {
  it("passes for a member of the template's org", async () => {
    const repos = {
      authz: { getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })) },
    };
    await expect(
      requireTemplateOrgMembership({
        repos: repos as never,
        orgId: ORG_ID,
        actorHumanId: ACTOR_ID,
      }),
    ).resolves.toBeUndefined();
    expect(repos.authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });
  });

  it("404s a NON-member rather than 403ing — a 403 would confirm the row exists", async () => {
    const repos = { authz: { getOrgMembership: vi.fn(async () => null) } };
    await expect(
      requireTemplateOrgMembership({
        repos: repos as never,
        orgId: ORG_ID,
        actorHumanId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });
});
