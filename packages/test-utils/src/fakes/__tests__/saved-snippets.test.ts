import { describe, expect, it } from "vitest";

import { runSavedSnippetsContract } from "../../contracts/saved-snippets";
import { createFakeSavedSnippets, savedSnippetListKey } from "../saved-snippets";

// The shared contract pins the fake to the adapter (the same suite runs on
// real Postgres in
// packages/adapters/src/db/prisma/__tests__/booking-the-night.integration.test.ts).
runSavedSnippetsContract("in-memory fake", () => createFakeSavedSnippets());

describe("createFakeSavedSnippets — fake-only guarantees", () => {
  it("hands out copies, so a caller cannot edit the store", async () => {
    const fake = createFakeSavedSnippets();
    const row = await fake.create({
      ownerType: "HUMAN",
      ownerId: "h-1",
      kind: "DECLINE_REASON",
      label: "Label",
      body: "Body",
    });
    row.label = "mutated";
    const [stored] = await fake.listByOwner({ ownerType: "HUMAN", ownerId: "h-1" });
    expect(stored!.label).toBe("Label");
  });

  it("counts lockList calls per list and hands out a copy of startersCopiedAt", async () => {
    const fake = createFakeSavedSnippets();
    const list = { ownerType: "HUMAN", ownerId: "h-1", kind: "DECLINE_REASON" } as const;
    await fake.lockList(list);
    await fake.markStartersCopied(list, new Date("2026-10-01T00:00:00.000Z"));
    const state = await fake.lockList(list);
    state.startersCopiedAt!.setTime(0);
    expect(fake.lockCalls.get(savedSnippetListKey(list))).toBe(2);
    expect(fake.lists.get(savedSnippetListKey(list))!.startersCopiedAt!.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });
});
