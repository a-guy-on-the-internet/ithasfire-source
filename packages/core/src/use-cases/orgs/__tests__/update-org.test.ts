import { describe, expect, it, vi } from "vitest";

import { updateOrg } from "../update-org";
import type { UpdateOrgDeps } from "../update-org";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const BASE_DATE = new Date("2024-06-01T00:00:00.000Z");

const EXISTING = {
  id: ORG_ID,
  name: "Acme Collective",
  slug: "acme-collective",
  status: "ACTIVE" as const,
  defaultLocale: "en",
  contactEmail: "hello@acme.test",
  physicalAddress: "123 Main St, Anytown, ST 12345",
};

function makeDeps(overrides: Partial<typeof EXISTING> = {}) {
  const existing = { ...EXISTING, ...overrides };

  const organizationsRepo = {
    getById: vi.fn(async () => existing),
    update: vi.fn(async (input: Record<string, unknown>) => ({
      ...existing,
      ...input,
      id: ORG_ID,
    })),
  };

  const auditRepo = { log: vi.fn(async () => undefined) };

  const txRepos = {
    organizations: organizationsRepo,
    audit: auditRepo,
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const authz = {
    requireOrgRole: vi.fn(async () => {}),
  } as unknown as AuthZPort;

  const deps: UpdateOrgDeps = {
    repos,
    authz,
    clock: { now: vi.fn(() => BASE_DATE) },
    logger: createTestLogger(),
  };

  return { deps, mocks: { organizationsRepo, auditRepo } };
}

/** The single `organizations.update` patch the use case built. */
function patchOf(organizationsRepo: { update: ReturnType<typeof vi.fn> }) {
  expect(organizationsRepo.update).toHaveBeenCalledTimes(1);
  return organizationsRepo.update.mock.calls[0]![0] as Record<string, unknown>;
}

/**
 * Assert a field is GENUINELY ABSENT from the repo patch — not merely
 * `undefined`.
 *
 * This distinction is the whole point of the suite. `makeOrganizationsRepo`
 * historically decided what to write with `Object.prototype.hasOwnProperty`,
 * which is TRUE for `{ contactEmail: undefined }`, and then coalesced
 * `?? null`. A test written as `expect(patch.contactEmail).toBeUndefined()`
 * passes against BOTH the fixed code and the bug, so it would have caught
 * nothing. `toHaveProperty` / `in` is the only assertion that separates them.
 */
function expectAbsent(patch: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    expect(
      Object.prototype.hasOwnProperty.call(patch, key),
      `expected "${key}" to be absent from the repo patch, but the key was present (value: ${String(
        patch[key],
      )}). A key set to undefined still reads as present to the adapter's hasOwnProperty guard and wipes the column.`,
    ).toBe(false);
    expect(patch).not.toHaveProperty(key);
  }
}

describe("updateOrg — partial patches must not touch sibling fields", () => {
  it("a name-only save carries NO contactEmail / physicalAddress / defaultLocale key", async () => {
    // The exact regression: `/admin/[slug]/settings/general` renames a group
    // and sends `{ orgId, name }`. Every omitted column used to be written as
    // NULL, silently erasing the CAN-SPAM mailing address from every
    // announcement email.
    const { deps, mocks } = makeDeps();

    await updateOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      name: "Acme Renamed",
    });

    const patch = patchOf(mocks.organizationsRepo);
    expect(patch).toMatchObject({
      id: ORG_ID,
      name: "Acme Renamed",
      slug: "acme-renamed",
    });
    expectAbsent(patch, "contactEmail", "physicalAddress", "defaultLocale");
  });

  it("a contact-only save carries NO name / slug / physicalAddress / defaultLocale key", async () => {
    // The mirror case from `/admin/[slug]/settings/contact`. `slug` matters
    // most here: a stray `slug: undefined` would have rewritten the group's
    // public URL to null.
    const { deps, mocks } = makeDeps();

    await updateOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      contactEmail: "new@acme.test",
    });

    const patch = patchOf(mocks.organizationsRepo);
    expect(patch).toMatchObject({
      id: ORG_ID,
      contactEmail: "new@acme.test",
    });
    expectAbsent(patch, "name", "slug", "physicalAddress", "defaultLocale");
  });

  it("an address-only save leaves the reply-to email alone", async () => {
    const { deps, mocks } = makeDeps();

    await updateOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      physicalAddress: "9 New Road, Nashville, TN 37203",
    });

    const patch = patchOf(mocks.organizationsRepo);
    expect(patch.physicalAddress).toBe("9 New Road, Nashville, TN 37203");
    expectAbsent(patch, "name", "slug", "contactEmail", "defaultLocale");
  });

  it("moves name and slug as a unit — a rename always re-slugs", async () => {
    const { deps, mocks } = makeDeps();

    await updateOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      name: "Ünïcode  Café",
    });

    const patch = patchOf(mocks.organizationsRepo);
    // `sanitizePlainText` (applied in the schema) collapses the double space.
    expect(patch.name).toBe("Ünïcode Café");
    expect(patch.slug).toBe("unicode-cafe");
  });
});

describe("updateOrg — explicit null still clears", () => {
  it("passes an explicit null through, so a field can be cleared on purpose", async () => {
    // `OrgContactSection` sends `contactEmail || null` — emptying the input is
    // a real intent, and must stay distinguishable from omitting the field.
    const { deps, mocks } = makeDeps();

    await updateOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      contactEmail: null,
    });

    const patch = patchOf(mocks.organizationsRepo);
    expect(Object.prototype.hasOwnProperty.call(patch, "contactEmail")).toBe(
      true,
    );
    expect(patch.contactEmail).toBeNull();
    expectAbsent(patch, "name", "slug", "physicalAddress", "defaultLocale");
  });

  it("clears both contact fields when both are explicitly nulled", async () => {
    const { deps, mocks } = makeDeps();

    await updateOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      contactEmail: null,
      physicalAddress: null,
    });

    const patch = patchOf(mocks.organizationsRepo);
    expect(patch.contactEmail).toBeNull();
    expect(patch.physicalAddress).toBeNull();
    expectAbsent(patch, "name", "slug", "defaultLocale");
  });
});

describe("updateOrg — audit log mirrors the patch", () => {
  it("records only the fields the caller actually supplied", async () => {
    const { deps, mocks } = makeDeps();

    await updateOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      name: "Acme Renamed",
    });

    const entry = mocks.auditRepo.log.mock.calls[0]![0] as {
      data: { changes: Record<string, unknown> };
    };
    expect(Object.keys(entry.data.changes).sort()).toEqual(["name", "slug"]);
    // The audit entry is the ONLY forensic record of an org edit. When the
    // patch wiped untouched columns, this stayed silent about them — which is
    // why the data loss was invisible. Patch and audit must list the same
    // fields.
    const patch = patchOf(mocks.organizationsRepo);
    for (const field of ["contactEmail", "physicalAddress", "defaultLocale"]) {
      expect(entry.data.changes).not.toHaveProperty(field);
      expectAbsent(patch, field);
    }
  });

  it("records a clear as a real from→to change", async () => {
    const { deps, mocks } = makeDeps();

    await updateOrg(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      contactEmail: null,
    });

    const entry = mocks.auditRepo.log.mock.calls[0]![0] as {
      data: { changes: Record<string, unknown> };
    };
    expect(entry.data.changes).toEqual({
      contactEmail: { from: "hello@acme.test", to: null },
    });
  });
});

describe("updateOrg — guards", () => {
  it("rejects a patch with no editable field at all", async () => {
    const { deps, mocks } = makeDeps();

    await expect(
      updateOrg(deps, { actorHumanId: ACTOR_ID, orgId: ORG_ID }),
    ).rejects.toThrow();
    expect(mocks.organizationsRepo.update).not.toHaveBeenCalled();
  });

  it("requires an org admin role before touching anything", async () => {
    const { deps, mocks } = makeDeps();
    (deps.authz.requireOrgRole as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("forbidden"),
    );

    await expect(
      updateOrg(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        name: "Nope Inc",
      }),
    ).rejects.toThrow("forbidden");
    expect(mocks.organizationsRepo.update).not.toHaveBeenCalled();
  });

  it("throws ORG_NOT_FOUND when the org is gone", async () => {
    const { deps, mocks } = makeDeps();
    mocks.organizationsRepo.getById.mockResolvedValue(
      null as unknown as typeof EXISTING,
    );

    await expect(
      updateOrg(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        name: "Ghost Org",
      }),
    ).rejects.toThrow();
    expect(mocks.organizationsRepo.update).not.toHaveBeenCalled();
  });
});
