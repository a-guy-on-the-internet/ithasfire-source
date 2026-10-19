import { beforeEach, describe, expect, it, vi } from "vitest";

import { searchTransferRecipients } from "../search-transfer-recipients";
import type { SearchTransferRecipientsDeps } from "../search-transfer-recipients";
import type { Repos } from "@th/ports/repos";
import type { HumansRepo, HumanWithIdentity } from "@th/ports/repos/humans";

const ACTOR_HUMAN_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const MATCH_1: HumanWithIdentity = {
  human: {
    id: "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Alice Smith",
    status: "ACTIVE",
    roles: [],
    locale: null,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
  },
  identity: {
    authUserId: "auth-bbbb",
    email: "alice@example.com",
    emailVerified: true,
    phone: null,
    phoneVerified: false,
    username: "alice",
    displayUsername: "Alice",
    image: "https://example.com/alice.png",
  },
};

const MATCH_2: HumanWithIdentity = {
  human: {
    id: "cccc3333-cccc-4ccc-8ccc-cccccccccccc",
    name: "Bob Jones",
    status: "ACTIVE",
    roles: [],
    locale: null,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
  },
  identity: {
    authUserId: "auth-cccc",
    email: "bob@example.com",
    emailVerified: true,
    phone: null,
    phoneVerified: false,
    username: "bob",
    displayUsername: null,
    image: null,
  },
};

function makeContext() {
  const searchByQuery = vi.fn<HumansRepo["searchByQuery"]>();
  const getByIdWithIdentity = vi.fn<HumansRepo["getByIdWithIdentity"]>();

  const repos = {
    humans: {
      searchByQuery,
      getByIdWithIdentity,
    },
  } as unknown as Repos;

  const deps: SearchTransferRecipientsDeps = {
    repos,
  };

  return { deps, mocks: { searchByQuery, getByIdWithIdentity } };
}

describe("searchTransferRecipients", () => {
  let ctx: ReturnType<typeof makeContext>;

  beforeEach(() => {
    ctx = makeContext();
    // Actor has verified email by default
    ctx.mocks.getByIdWithIdentity.mockResolvedValue({
      human: {
        id: ACTOR_HUMAN_ID,
        name: "Actor",
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: "auth-actor",
        email: "actor@example.com",
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });
  });

  it("returns matching recipients", async () => {
    ctx.mocks.searchByQuery.mockResolvedValue([MATCH_1, MATCH_2]);

    const result = await searchTransferRecipients(ctx.deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      query: "ali",
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      humanId: MATCH_1.human.id,
      displayName: "Alice",
      username: "alice",
      email: "alice@example.com",
      image: "https://example.com/alice.png",
    });
    expect(result.results[1]).toEqual({
      humanId: MATCH_2.human.id,
      displayName: "Bob Jones",
      username: "bob",
      email: "bob@example.com",
      image: null,
    });

    expect(ctx.mocks.searchByQuery).toHaveBeenCalledWith("ali", {
      limit: 10,
      excludeHumanId: ACTOR_HUMAN_ID,
    });
  });

  it("returns empty results when no matches", async () => {
    ctx.mocks.searchByQuery.mockResolvedValue([]);

    const result = await searchTransferRecipients(ctx.deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      query: "nobody",
    });

    expect(result.results).toHaveLength(0);
  });

  it("rejects when actor email is not verified", async () => {
    ctx.mocks.getByIdWithIdentity.mockResolvedValue({
      human: {
        id: ACTOR_HUMAN_ID,
        name: "Actor",
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: "auth-actor",
        email: "actor@example.com",
        emailVerified: false,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });

    await expect(
      searchTransferRecipients(ctx.deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        query: "alice",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "forbidden",
        message: "email_verification_required",
      }),
    );
  });

  it("rejects invalid input (empty query)", async () => {
    await expect(
      searchTransferRecipients(ctx.deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        query: "",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
  });

  it("respects custom limit", async () => {
    ctx.mocks.searchByQuery.mockResolvedValue([MATCH_1]);

    await searchTransferRecipients(ctx.deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      query: "alice",
      limit: 5,
    });

    expect(ctx.mocks.searchByQuery).toHaveBeenCalledWith("alice", {
      limit: 5,
      excludeHumanId: ACTOR_HUMAN_ID,
    });
  });

  it("falls back to human name when no displayUsername", async () => {
    ctx.mocks.searchByQuery.mockResolvedValue([MATCH_2]);

    const result = await searchTransferRecipients(ctx.deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      query: "bob",
    });

    expect(result.results[0]!.displayName).toBe("Bob Jones");
  });
});
