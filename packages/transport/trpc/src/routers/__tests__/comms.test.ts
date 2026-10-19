import { afterEach, describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { commsRouter } from "../comms";
import * as commsUseCases from "@th/core/use-cases/comms";
import { createTestLogger } from "@th/test-utils";

// Security review F9 (2026-09-29): `deleteAudienceEntry` deleted ANY entry id
// with no access check, and `updateAudienceEntry` authorized `listId` but
// wrote to an unrelated `entryId`. Both now authorize the list and scope the
// write to `{ id: entryId, inviteListId: listId }`.

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const MY_ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const MY_LIST = "44444444-4444-4444-8444-444444444444";
const OTHER_LIST = "55555555-5555-4555-8555-555555555555";
const ENTRY_ID = "66666666-6666-4666-8666-666666666666";

const buildCtx = (opts: { entryInList?: boolean } = {}) => {
  const entryInList = opts.entryInList ?? true;
  const lists: Record<string, { id: string; ownerType: string; ownerId: string }> = {
    [MY_LIST]: { id: MY_LIST, ownerType: "ORGANIZATION", ownerId: MY_ORG },
    [OTHER_LIST]: { id: OTHER_LIST, ownerType: "ORGANIZATION", ownerId: OTHER_ORG },
  };
  const inviteLists = {
    getListById: vi.fn(async (id: string) => lists[id] ?? null),
    deleteEntry: vi.fn(async () => ({ deleted: entryInList })),
    updateEntry: vi.fn(async (input: { entryId: string }) =>
      entryInList ? { id: input.entryId, inviteListId: MY_LIST } : null,
    ),
    updateListCounts: vi.fn(async () => undefined),
  };
  const authz = {
    getOrgMembership: vi.fn(async ({ orgId }: { orgId: string }) =>
      orgId === MY_ORG ? { role: "EDITOR" } : null,
    ),
  };
  const ctx = {
    repos: { inviteLists, authz } as unknown as Ctx["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"],
    clock: { now: () => new Date("2026-09-29T00:00:00.000Z") } as Ctx["clock"],
    logger: createTestLogger(),
    rateLimit: withConsumeMany({
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    }) as unknown as Ctx["rateLimit"],
    actorHumanId: ACTOR_ID,
    auth: { userId: "user-1", sessionId: null, token: "token" },
    authToken: "token",
    apiKey: null,
  } as unknown as Ctx;
  return { ctx, inviteLists };
};

const callerFor = (ctx: Ctx) =>
  trpcRouter({ comms: router(commsRouter) }).createCaller(ctx);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("comms.deleteAudienceEntry", () => {
  it("requires listId", async () => {
    const { ctx, inviteLists } = buildCtx();
    await expect(
      callerFor(ctx).comms.deleteAudienceEntry({ entryId: ENTRY_ID } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(inviteLists.deleteEntry).not.toHaveBeenCalled();
  });

  it("refuses a list the actor cannot edit and deletes nothing", async () => {
    const { ctx, inviteLists } = buildCtx();
    await expect(
      callerFor(ctx).comms.deleteAudienceEntry({
        listId: OTHER_LIST,
        entryId: ENTRY_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inviteLists.deleteEntry).not.toHaveBeenCalled();
  });

  it("scopes the delete to the list and answers NOT_FOUND on 0 rows", async () => {
    const { ctx, inviteLists } = buildCtx({ entryInList: false });
    await expect(
      callerFor(ctx).comms.deleteAudienceEntry({
        listId: MY_LIST,
        entryId: ENTRY_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(inviteLists.deleteEntry).toHaveBeenCalledWith({
      entryId: ENTRY_ID,
      inviteListId: MY_LIST,
    });
    expect(inviteLists.updateListCounts).not.toHaveBeenCalled();
  });

  it("deletes an entry in an own list and recounts", async () => {
    const { ctx, inviteLists } = buildCtx();
    await expect(
      callerFor(ctx).comms.deleteAudienceEntry({
        listId: MY_LIST,
        entryId: ENTRY_ID,
      }),
    ).resolves.toEqual({ ok: true });
    expect(inviteLists.updateListCounts).toHaveBeenCalledWith(MY_LIST);
  });
});

describe("comms.updateAudienceEntry", () => {
  // Scoping, consent restamp and the verified-email gate live in the use case
  // (update-contact-list-entry.test.ts); the router must only route to it.
  it("goes through updateContactListEntry with the session actor", async () => {
    const { ctx } = buildCtx();
    const spy = vi
      .spyOn(commsUseCases, "updateContactListEntry")
      .mockResolvedValue({ id: ENTRY_ID } as never);

    await expect(
      callerFor(ctx).comms.updateAudienceEntry({
        listId: MY_LIST,
        entryId: ENTRY_ID,
        displayName: "Fan",
      }),
    ).resolves.toMatchObject({ id: ENTRY_ID });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ctx.repos, clock: ctx.clock }),
      expect.objectContaining({
        listId: MY_LIST,
        entryId: ENTRY_ID,
        actorHumanId: ACTOR_ID,
      }),
    );
  });

  it("maps the use case's NOT_FOUND through", async () => {
    const { ctx } = buildCtx();
    vi.spyOn(commsUseCases, "updateContactListEntry").mockRejectedValue(
      Object.assign(new (await import("@th/errors")).AppError("NOT_FOUND")),
    );

    await expect(
      callerFor(ctx).comms.updateAudienceEntry({
        listId: MY_LIST,
        entryId: ENTRY_ID,
        contactEmail: "attacker@example.com",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires listId", async () => {
    const { ctx } = buildCtx();
    const spy = vi.spyOn(commsUseCases, "updateContactListEntry");
    await expect(
      callerFor(ctx).comms.updateAudienceEntry({
        entryId: ENTRY_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("comms.createAudienceEntry", () => {
  it("goes through the addContactListEntry use case with the session actor", async () => {
    const { ctx } = buildCtx();
    const spy = vi
      .spyOn(commsUseCases, "addContactListEntry")
      .mockResolvedValue({ id: ENTRY_ID } as never);

    await callerFor(ctx).comms.createAudienceEntry({
      listId: MY_LIST,
      contactEmail: "fan@example.com",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ctx.repos, clock: ctx.clock }),
      expect.objectContaining({ listId: MY_LIST, actorHumanId: ACTOR_ID }),
    );
  });

  it("a duplicate contact reaches the client as CONFLICT, not a 500", async () => {
    const { ctx } = buildCtx();
    const { AppError } = await import("@th/errors");
    vi.spyOn(commsUseCases, "addContactListEntry").mockRejectedValue(
      new AppError("CONFLICT", {
        message: "contact_already_on_list",
        meta: { reason: "contact_already_on_list" },
      }),
    );

    await expect(
      callerFor(ctx).comms.createAudienceEntry({
        listId: MY_LIST,
        contactEmail: "fan@example.com",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("maps an unverified-email refusal to FORBIDDEN", async () => {
    const { ctx } = buildCtx();
    vi.spyOn(commsUseCases, "addContactListEntry").mockRejectedValue({
      code: "forbidden",
      message: "email_verification_required",
    });

    await expect(
      callerFor(ctx).comms.createAudienceEntry({
        listId: MY_LIST,
        contactEmail: "fan@example.com",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an actorHumanId smuggled in the body", async () => {
    const { ctx } = buildCtx();
    const spy = vi.spyOn(commsUseCases, "addContactListEntry");
    await expect(
      callerFor(ctx).comms.createAudienceEntry({
        listId: MY_LIST,
        actorHumanId: OTHER_ORG,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });
});
