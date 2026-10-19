import { describe, expect, it, vi } from "vitest";

import {
  addContactListEntry,
  MANUAL_ENTRY_CONSENT_SOURCE,
  type AddContactListEntryDeps,
} from "../add-contact-list-entry";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const ACTOR_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LIST_ID = "cccc3333-cccc-4ccc-8ccc-cccccccccccc";
const ENTRY_ID = "dddd4444-dddd-4ddd-8ddd-dddddddddddd";

function makeDeps(
  options: {
    emailVerified?: boolean;
    list?: { ownerType: "HUMAN" | "ORGANIZATION"; ownerId: string } | null;
    orgRole?: string | null;
  } = {},
) {
  const list =
    options.list === undefined
      ? { ownerType: "ORGANIZATION" as const, ownerId: ORG_ID }
      : options.list;

  const inviteLists = {
    getListById: vi.fn(async () => (list ? { id: LIST_ID, ...list } : null)),
    createEntry: vi.fn(async (input: Record<string, unknown>) => ({
      id: ENTRY_ID,
      ...input,
    })),
    updateListCounts: vi.fn(async () => undefined),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const humans = {
    getByIdWithIdentity: vi.fn(async () => ({
      human: { id: ACTOR_ID },
      identity: { emailVerified: options.emailVerified ?? true },
    })),
  };
  const authz = {
    getOrgMembership: vi.fn(async () =>
      options.orgRole === null ? null : { role: options.orgRole ?? "EDITOR" },
    ),
  };
  const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
    fn({ inviteLists, audit }),
  );

  const deps = {
    repos: { inviteLists, audit, humans, authz, tx },
    clock: { now: () => NOW },
  } as unknown as AddContactListEntryDeps;

  return { deps, inviteLists, audit, tx };
}

const input = {
  actorHumanId: ACTOR_ID,
  listId: LIST_ID,
  contactEmail: "fan@example.com",
  displayName: "Fan",
  tags: ["vip"],
};

describe("addContactListEntry", () => {
  it("adds the entry with a consent stamp, recounts, and audits in one tx", async () => {
    const { deps, inviteLists, audit, tx } = makeDeps();

    const entry = await addContactListEntry(deps, input);

    expect(entry.id).toBe(ENTRY_ID);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(inviteLists.createEntry).toHaveBeenCalledWith({
      inviteListId: LIST_ID,
      contactEmail: "fan@example.com",
      contactPhone: null,
      displayName: "Fan",
      tags: ["vip"],
      consentSource: MANUAL_ENTRY_CONSENT_SOURCE,
      consentRecordedAt: NOW,
    });
    expect(inviteLists.updateListCounts).toHaveBeenCalledWith(LIST_ID);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "invite_list",
        entityId: LIST_ID,
        action: "comms.contact_list.entry_added",
      }),
    );
  });

  it("keeps a caller-supplied consent source (sanitized)", async () => {
    const { deps, inviteLists } = makeDeps();

    await addContactListEntry(deps, {
      ...input,
      consentSource: "  Signed up at the door\u0000 ",
    });

    expect(inviteLists.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ consentSource: "Signed up at the door" }),
    );
  });

  // Security review F8 (2026-09-29): importContacts required a verified email
  // but a single add did not, so an unverified account could build a list and
  // mail it through announcements.send.
  it("refuses an actor with an unverified email and writes nothing", async () => {
    const { deps, inviteLists, tx } = makeDeps({ emailVerified: false });

    await expect(addContactListEntry(deps, input)).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(inviteLists.getListById).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
    expect(inviteLists.createEntry).not.toHaveBeenCalled();
  });

  it("refuses an actor with no editing role on the list's org", async () => {
    const { deps, inviteLists } = makeDeps({ orgRole: "VIEWER" });

    await expect(addContactListEntry(deps, input)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(inviteLists.createEntry).not.toHaveBeenCalled();
  });

  it("refuses another human's personal list", async () => {
    const { deps, inviteLists } = makeDeps({
      list: {
        ownerType: "HUMAN",
        ownerId: "eeee5555-eeee-4eee-8eee-eeeeeeeeeeee",
      },
    });

    await expect(addContactListEntry(deps, input)).rejects.toBeDefined();
    expect(inviteLists.createEntry).not.toHaveBeenCalled();
  });

  it("answers TARGET_LIST_NOT_FOUND for a missing list", async () => {
    const { deps } = makeDeps({ list: null });

    await expect(addContactListEntry(deps, input)).rejects.toMatchObject({
      code: "TARGET_LIST_NOT_FOUND",
    });
  });

  it("maps a duplicate contact (P2002) to a typed CONFLICT, not a 500", async () => {
    const { deps, inviteLists } = makeDeps();
    inviteLists.createEntry.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed on the fields: (`inviteListId`,`contactEmail`)"), { code: "P2002" }));

    await expect(addContactListEntry(deps, input)).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "contact_already_on_list" },
    });
  });

  it("passes any other failure through untouched", async () => {
    const { deps, inviteLists } = makeDeps();
    const other = Object.assign(new Error("connection reset"), { code: "P1001" });
    inviteLists.createEntry.mockRejectedValueOnce(other);

    await expect(addContactListEntry(deps, input)).rejects.toBe(other);
  });
});
