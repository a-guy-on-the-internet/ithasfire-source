import { describe, expect, it, vi } from "vitest";

import { MANUAL_ENTRY_CONSENT_SOURCE } from "../add-contact-list-entry";
import {
  updateContactListEntry,
  type UpdateContactListEntryDeps,
} from "../update-contact-list-entry";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const EARLIER = new Date("2026-01-01T00:00:00.000Z");
const ACTOR_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LIST_ID = "cccc3333-cccc-4ccc-8ccc-cccccccccccc";
const ENTRY_ID = "dddd4444-dddd-4ddd-8ddd-dddddddddddd";

function makeDeps(
  options: {
    emailVerified?: boolean;
    orgRole?: string | null;
    entryInList?: boolean;
  } = {},
) {
  const existing = {
    id: ENTRY_ID,
    inviteListId: LIST_ID,
    contactEmail: "fan@example.com",
    consentSource: "csv_import",
    consentRecordedAt: EARLIER,
  };
  const inviteLists = {
    getListById: vi.fn(async () => ({
      id: LIST_ID,
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    })),
    getEntry: vi.fn(async () =>
      options.entryInList === false ? null : existing,
    ),
    updateEntry: vi.fn(async (patch: Record<string, unknown>) => ({
      ...existing,
      ...patch,
      id: ENTRY_ID,
    })),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
    fn({ inviteLists, audit }),
  );
  const deps = {
    repos: {
      inviteLists,
      audit,
      tx,
      humans: {
        getByIdWithIdentity: vi.fn(async () => ({
          human: { id: ACTOR_ID },
          identity: { emailVerified: options.emailVerified ?? true },
        })),
      },
      authz: {
        getOrgMembership: vi.fn(async () =>
          options.orgRole === null
            ? null
            : { role: options.orgRole ?? "EDITOR" },
        ),
      },
    },
    clock: { now: () => NOW },
  } as unknown as UpdateContactListEntryDeps;
  return { deps, inviteLists, audit, tx };
}

const base = { actorHumanId: ACTOR_ID, listId: LIST_ID, entryId: ENTRY_ID };

describe("updateContactListEntry", () => {
  it("scopes the write to the list and leaves consent alone when the email is unchanged", async () => {
    const { deps, inviteLists } = makeDeps();

    await updateContactListEntry(deps, {
      ...base,
      // Case/whitespace differences are the same address.
      contactEmail: "Fan@Example.com",
      displayName: "Fan",
    });

    expect(inviteLists.getEntry).toHaveBeenCalledWith({
      entryId: ENTRY_ID,
      inviteListId: LIST_ID,
    });
    const patch = inviteLists.updateEntry.mock.calls[0]![0];
    expect(patch).toMatchObject({ entryId: ENTRY_ID, inviteListId: LIST_ID });
    expect(patch).not.toHaveProperty("consentSource");
    expect(patch).not.toHaveProperty("consentRecordedAt");
  });

  it("restamps consent when the email changes", async () => {
    const { deps, inviteLists, audit } = makeDeps();

    const out = await updateContactListEntry(deps, {
      ...base,
      contactEmail: "someone-new@example.com",
    });

    expect(inviteLists.updateEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        contactEmail: "someone-new@example.com",
        consentSource: MANUAL_ENTRY_CONSENT_SOURCE,
        consentRecordedAt: NOW,
      }),
    );
    expect(out.consentRecordedAt).toEqual(NOW);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "comms.contact_list.entry_updated",
        data: expect.objectContaining({ emailChanged: true }),
      }),
    );
  });

  it("uses a caller-supplied consent source on an email change", async () => {
    const { deps, inviteLists } = makeDeps();

    await updateContactListEntry(deps, {
      ...base,
      contactEmail: "someone-new@example.com",
      consentSource: "Asked at the merch table",
    });

    expect(inviteLists.updateEntry).toHaveBeenCalledWith(
      expect.objectContaining({ consentSource: "Asked at the merch table" }),
    );
  });

  it("does not touch fields the caller omitted", async () => {
    const { deps, inviteLists } = makeDeps();

    await updateContactListEntry(deps, { ...base, tags: ["vip"] });

    const patch = inviteLists.updateEntry.mock.calls[0]![0];
    expect(patch).toEqual({
      entryId: ENTRY_ID,
      inviteListId: LIST_ID,
      tags: ["vip"],
    });
  });

  it("refuses an unverified actor before reading the list or entry", async () => {
    const { deps, inviteLists, tx } = makeDeps({ emailVerified: false });

    await expect(
      updateContactListEntry(deps, {
        ...base,
        contactEmail: "attacker@example.com",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(inviteLists.getListById).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it("refuses an actor without an editing role", async () => {
    const { deps, inviteLists } = makeDeps({ orgRole: null });

    await expect(
      updateContactListEntry(deps, { ...base, displayName: "x" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(inviteLists.updateEntry).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for an entry that is not in the list, writing nothing", async () => {
    const { deps, inviteLists } = makeDeps({ entryInList: false });

    await expect(
      updateContactListEntry(deps, {
        ...base,
        contactEmail: "attacker@example.com",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(inviteLists.updateEntry).not.toHaveBeenCalled();
  });

  it("maps an email already on the list (P2002) to a typed CONFLICT, not a 500", async () => {
    const { deps, inviteLists } = makeDeps();
    inviteLists.updateEntry.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed on the fields: (`inviteListId`,`contactEmail`)"), { code: "P2002" }));

    await expect(
      updateContactListEntry(deps, {
        ...base,
        contactEmail: "already-there@example.com",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "contact_already_on_list" },
    });
  });
});
