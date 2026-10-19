import { describe, expect, it, vi } from "vitest";

import type { SavedSnippetOutput } from "@th/core/use-cases/saved-snippets";
import {
  EDITOR_ID,
  GRANTEE_ID,
  ORG_ID,
  OUTSIDER_ID,
  PLACE_ID,
  VIEWER_ID,
  buildSavedSnippetsTestContext,
} from "@th/core/use-cases/saved-snippets/__tests__/saved-snippets-test-context";

import { savedSnippetsRouter } from "../saved-snippets";
import { createCaller } from "./test-helpers";

/**
 * Transport contract for `savedSnippets.*` (booking-the-night FR-013). Thin
 * pass-throughs; pinned here: auth, actor injection, no client-supplied owner
 * pair, the error mapping (incl. the three new codes) and that the output
 * schemas hold the use-case shape.
 */

const PLACE = { kind: "place", placeId: PLACE_ID } as const;
const SELF = { kind: "self" } as const;
const SNIPPET_ID = "5e5e5e5e-0000-4000-8000-0000000000ee";

function build(actorHumanId: string | null = EDITOR_ID) {
  const harness = buildSavedSnippetsTestContext();
  const { caller } = createCaller(savedSnippetsRouter, {
    repos: harness.repos,
    actorHumanId,
  });
  return { ...harness, caller };
}

describe("savedSnippetsRouter", () => {
  it("rejects an anonymous caller with UNAUTHORIZED on every procedure", async () => {
    const { caller } = build(null);
    await expect(caller.list({ owner: SELF })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.create({ owner: SELF, label: "x", body: "x" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.update({ owner: SELF, snippetId: SNIPPET_ID, label: "x" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.delete({ owner: SELF, snippetId: SNIPPET_ID })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.reorder({ owner: SELF, orderedIds: [] })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("takes the actor from ctx and refuses a client-supplied actor or owner pair", async () => {
    const { caller, savedSnippets } = build();
    await expect(
      caller.create({ owner: SELF, label: "x", body: "x", actorHumanId: OUTSIDER_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.list({ owner: SELF, ownerType: "ORGANIZATION", ownerId: ORG_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.list({ owner: { kind: "self", ownerId: OUTSIDER_ID } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(savedSnippets.rows.size).toBe(0);
  });

  it("list → create → update → reorder → delete round-trips through the wire schemas", async () => {
    const { caller, savedSnippets } = build();
    const first = await caller.list({ owner: PLACE });
    expect(first).toMatchObject({ ownerType: "ORGANIZATION", total: 6, max: 30 });
    expect(first.snippets.every((s: SavedSnippetOutput) => s.isStarter)).toBe(true);
    // Owner pair and timestamps stay server-side.
    expect(Object.keys(first.snippets[0]!).sort()).toEqual(
      ["body", "id", "isStarter", "kind", "label", "sortOrder"],
    );

    const { snippet } = await caller.create({
      owner: PLACE,
      label: "Private hire",
      body: "We have a private hire that night.",
    });
    expect(snippet).toMatchObject({ label: "Private hire", sortOrder: 6, isStarter: false });
    expect(savedSnippets.rows.get(snippet.id)).toMatchObject({ ownerType: "ORGANIZATION", ownerId: ORG_ID });

    const updated = await caller.update({ owner: PLACE, snippetId: snippet.id, label: "Private event" });
    expect(updated.snippet).toMatchObject({ id: snippet.id, label: "Private event" });

    const ids = [snippet.id, ...first.snippets.map((s: SavedSnippetOutput) => s.id)];
    const reordered = await caller.reorder({ owner: PLACE, orderedIds: ids });
    expect(reordered.snippets.map((s: SavedSnippetOutput) => s.id)).toEqual(ids);

    await expect(caller.delete({ owner: PLACE, snippetId: snippet.id })).resolves.toEqual({
      snippetId: snippet.id,
      deleted: true,
    });
    await expect(caller.delete({ owner: PLACE, snippetId: snippet.id })).resolves.toEqual({
      snippetId: snippet.id,
      deleted: false,
    });
  });

  it("maxBodyLength filters at the wire and is bounded by the 1000 reason cap", async () => {
    const { caller } = build();
    await caller.create({ owner: SELF, label: "Long", body: "x".repeat(300) });
    const pass = await caller.list({ owner: SELF, maxBodyLength: 240 });
    expect(pass.snippets.map((s: SavedSnippetOutput) => s.label)).not.toContain("Long");
    expect(pass.total).toBe(7);
    await expect(caller.list({ owner: SELF, maxBodyLength: 1001 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("maps the new codes: LIMIT_REACHED → CONFLICT, NOT_FOUND → NOT_FOUND, ORDER_CHANGED → CONFLICT", async () => {
    const { caller } = build();
    for (let i = 0; i < 24; i += 1) {
      await caller.create({ owner: SELF, label: `r${i}`, body: `r${i}` });
    }
    await expect(caller.create({ owner: SELF, label: "31st", body: "31st" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "SAVED_SNIPPET_LIMIT_REACHED",
    });
    await expect(
      caller.update({ owner: SELF, snippetId: SNIPPET_ID, label: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "SAVED_SNIPPET_NOT_FOUND" });
    await expect(
      caller.reorder({ owner: SELF, orderedIds: [SNIPPET_ID] }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "SAVED_SNIPPET_ORDER_CHANGED" });
  });

  it("every write shares one per-actor bucket; the read is not in it", async () => {
    const harness = buildSavedSnippetsTestContext();
    const consume = vi.fn(async (key: string) =>
      key === `savedSnippets:write:${EDITOR_ID}`
        ? { allowed: false, remaining: 0, retryAfterSeconds: 60 }
        : { allowed: true, remaining: 100, retryAfterSeconds: 0 },
    );
    const { caller } = createCaller(savedSnippetsRouter, {
      repos: harness.repos,
      actorHumanId: EDITOR_ID,
      rateLimit: { consume } as never,
    });

    for (const write of [
      () => caller.create({ owner: SELF, label: "x", body: "x" }),
      () => caller.update({ owner: SELF, snippetId: SNIPPET_ID, label: "x" }),
      () => caller.delete({ owner: SELF, snippetId: SNIPPET_ID }),
      () => caller.reorder({ owner: SELF, orderedIds: [] }),
    ]) {
      await expect(write()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    }
    // Refused before the use case: nothing was locked, copied or written.
    expect(harness.savedSnippets.lockCalls.size).toBe(0);
    expect(harness.savedSnippets.rows.size).toBe(0);
    await expect(caller.list({ owner: SELF })).resolves.toMatchObject({ total: 6 });
  });

  it("maps authz refusals to FORBIDDEN and lets a grant holder read but not write", async () => {
    const outsider = build(OUTSIDER_ID);
    await expect(outsider.caller.list({ owner: PLACE })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const viewer = build(VIEWER_ID);
    await expect(viewer.caller.list({ owner: PLACE })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const grantee = build(GRANTEE_ID);
    grantee.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });
    await expect(grantee.caller.list({ owner: PLACE })).resolves.toMatchObject({
      ownerType: "ORGANIZATION",
      total: 6,
    });
    await expect(
      grantee.caller.create({ owner: PLACE, label: "x", body: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
