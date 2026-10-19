import { describe, expect, it } from "vitest";

import {
  ORG_ID,
  REQUEST_A,
  STAFF_ID,
  VIEWER_ID,
  OUTSIDER_ID,
  buildHoldTestContext,
} from "@th/core/use-cases/booking-holds/__tests__/hold-test-context";

import { bookingTagsRouter } from "../booking-tags";
import { createCaller } from "./test-helpers";

/**
 * Transport contract for `bookingTags.*` (booking-holds FR-017). Thin
 * pass-throughs; what is pinned here is auth, actor injection, the error
 * mapping and that the output schemas hold the use-case shape.
 */

const OTHER_ORG_ID = "23232323-2323-4232-8232-232323232323";

function build(actorHumanId: string | null = STAFF_ID) {
  const harness = buildHoldTestContext();
  const { caller } = createCaller(bookingTagsRouter, {
    repos: harness.repos,
    actorHumanId,
  });
  return { ...harness, caller };
}

describe("bookingTagsRouter", () => {
  it("rejects an anonymous caller with UNAUTHORIZED on every procedure", async () => {
    const { caller } = build(null);
    const tagId = "00000000-0000-4000-8000-0000000000aa";
    await expect(caller.list({ orgId: ORG_ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.create({ orgId: ORG_ID, name: "Rock" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.update({ orgId: ORG_ID, tagId, name: "x" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.delete({ orgId: ORG_ID, tagId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.setForRequest({ bookingRequestId: REQUEST_A, tagIds: [] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("takes actorHumanId from ctx and rejects a client-supplied one", async () => {
    const { caller } = build();
    await expect(
      caller.create({ orgId: ORG_ID, name: "Rock", actorHumanId: OUTSIDER_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("create → list → update → delete round-trips through the wire schemas", async () => {
    const { caller } = build();
    const { tag } = await caller.create({ orgId: ORG_ID, name: "Loud rock", color: "danger" });
    expect(tag).toMatchObject({ orgId: ORG_ID, name: "Loud rock", slug: "loud-rock", color: "danger" });

    const listed = await caller.list({ orgId: ORG_ID });
    expect(listed.tags.map((t) => t.id)).toEqual([tag.id]);

    const updated = await caller.update({ orgId: ORG_ID, tagId: tag.id, name: "Quiet folk" });
    expect(updated.tag).toMatchObject({ id: tag.id, name: "Quiet folk", slug: "quiet-folk" });

    const removed = await caller.delete({ orgId: ORG_ID, tagId: tag.id });
    expect(removed).toEqual({ tagId: tag.id, deleted: true });
    // Idempotent delete.
    await expect(caller.delete({ orgId: ORG_ID, tagId: tag.id })).resolves.toEqual({
      tagId: tag.id,
      deleted: false,
    });
  });

  it("maps a duplicate slug to CONFLICT and a non-member to FORBIDDEN", async () => {
    const { caller } = build();
    await caller.create({ orgId: ORG_ID, name: "Rock" });
    await expect(caller.create({ orgId: ORG_ID, name: "rock!" })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const outsider = build(OUTSIDER_ID);
    await expect(outsider.caller.list({ orgId: ORG_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A VIEWER can list (membership-any) but not write (ORG_EDIT_ROLES).
    const viewer = build(VIEWER_ID);
    await expect(viewer.caller.list({ orgId: ORG_ID })).resolves.toEqual({ tags: [] });
    await expect(viewer.caller.create({ orgId: ORG_ID, name: "Nope" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("setForRequest attaches the org's tags and maps a foreign tag to NOT_FOUND", async () => {
    const { caller, bookingTags } = build();
    const mine = bookingTags.seedTag({ orgId: ORG_ID, name: "Weekend" });
    const foreign = bookingTags.seedTag({ orgId: OTHER_ORG_ID, name: "Not ours" });

    const result = await caller.setForRequest({
      bookingRequestId: REQUEST_A,
      tagIds: [mine.id],
    });
    expect(result).toEqual({
      bookingRequestId: REQUEST_A,
      tags: [expect.objectContaining({ id: mine.id, name: "Weekend" })],
    });

    await expect(
      caller.setForRequest({ bookingRequestId: REQUEST_A, tagIds: [foreign.id] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
