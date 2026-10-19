import { describe, expect, it } from "vitest";

import {
  createBookingTag,
  deleteBookingTag,
  listBookingTags,
  updateBookingTag,
} from "../manage-booking-tags";
import { setBookingRequestTags } from "../set-booking-request-tags";
import { BOOKING_TAG_COLORS, toBookingTagSlug } from "../_shared/booking-tag-schemas";
import {
  ACT_A_ID,
  ORG_ID,
  OUTSIDER_ID,
  REQUEST_A,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "../../booking-holds/__tests__/hold-test-context";

const OTHER_ORG_ID = "23232323-2323-4232-8232-232323232323";

describe("toBookingTagSlug", () => {
  it("normalises like the event tag slug (NFKD, lowercase, hyphen runs) and refuses the empty case", () => {
    expect(toBookingTagSlug("  Hip-Hop / Rap  ")).toBe("hip-hop-rap");
    expect(toBookingTagSlug("Café Ünïcode")).toBe("cafe-unicode");
    expect(() => toBookingTagSlug("!!!")).toThrow();
  });
});

describe("booking tag CRUD (FR-017)", () => {
  it("create → list → update → delete, org-scoped and edit-role gated", async () => {
    const ctx = buildHoldTestContext();
    const created = await createBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, name: "Local support", color: "info" });
    expect(created.tag).toMatchObject({ orgId: ORG_ID, name: "Local support", slug: "local-support", color: "info" });

    // Any member may list.
    const listed = await listBookingTags(ctx.deps, { actorHumanId: VIEWER_ID, orgId: ORG_ID });
    expect(listed.tags.map((t) => t.id)).toEqual([created.tag.id]);

    const updated = await updateBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, tagId: created.tag.id, name: "Locals", color: "success" });
    expect(updated.tag).toMatchObject({ name: "Locals", slug: "locals", color: "success" });

    const deleted = await deleteBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, tagId: created.tag.id });
    expect(deleted).toEqual({ tagId: created.tag.id, deleted: true });
    const again = await deleteBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, tagId: created.tag.id });
    expect(again.deleted).toBe(false);
  });

  it("validates the colour against the token set and the name bound", async () => {
    const ctx = buildHoldTestContext();
    expect(BOOKING_TAG_COLORS).toEqual(["neutral", "accent", "info", "success", "warning", "danger"]);
    await expect(
      createBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, name: "Red", color: "#ff0000" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, name: "x".repeat(41) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const defaulted = await createBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, name: "Plain" });
    expect(defaulted.tag.color).toBe("neutral");
  });

  it("maps the (orgId, slug) unique to BOOKING_TAG_SLUG_TAKEN (type-to-create double submit)", async () => {
    const ctx = buildHoldTestContext();
    await createBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, name: "Locals" });
    await expect(
      createBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, name: "locals" }),
    ).rejects.toMatchObject({ code: "BOOKING_TAG_SLUG_TAKEN" });
  });

  it("a VIEWER cannot mutate; a foreign org's tag id reads as NOT_FOUND", async () => {
    const ctx = buildHoldTestContext();
    await expect(
      createBookingTag(ctx.deps, { actorHumanId: VIEWER_ID, orgId: ORG_ID, name: "Nope" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    const foreign = ctx.bookingTags.seedTag({ orgId: OTHER_ORG_ID, name: "Theirs" });
    await expect(
      updateBookingTag(ctx.deps, { actorHumanId: STAFF_ID, orgId: ORG_ID, tagId: foreign.id, name: "Mine now" }),
    ).rejects.toMatchObject({ code: "BOOKING_TAG_NOT_FOUND" });
    expect(ctx.bookingTags.tags.get(foreign.id)?.name).toBe("Theirs");
  });
});

describe("setBookingRequestTags (FR-017)", () => {
  it("attaches the owning org's tags to the request (replace-all), passing the org to the adapter", async () => {
    const ctx = buildHoldTestContext();
    const a = ctx.bookingTags.seedTag({ orgId: ORG_ID, name: "A", sortOrder: 1 });
    const b = ctx.bookingTags.seedTag({ orgId: ORG_ID, name: "B", sortOrder: 0 });

    const result = await setBookingRequestTags(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, tagIds: [a.id, b.id, a.id] });

    expect(result.tags.map((t) => t.name)).toEqual(["B", "A"]);
    expect(ctx.bookingTags.setForRequest).toHaveBeenCalledWith({ bookingRequestId: REQUEST_A, orgId: ORG_ID, tagIds: [a.id, b.id] });

    const cleared = await setBookingRequestTags(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, tagIds: [] });
    expect(cleared.tags).toEqual([]);
  });

  it("rejects a tag from another org BEFORE the adapter is reached", async () => {
    const ctx = buildHoldTestContext();
    const foreign = ctx.bookingTags.seedTag({ orgId: OTHER_ORG_ID, name: "Theirs" });
    await expect(
      setBookingRequestTags(ctx.deps, { actorHumanId: STAFF_ID, bookingRequestId: REQUEST_A, tagIds: [foreign.id] }),
    ).rejects.toMatchObject({ code: "BOOKING_TAG_NOT_FOUND" });
    expect(ctx.bookingTags.setForRequest).not.toHaveBeenCalled();
  });

  it("the act and a VIEWER cannot tag; a human-owned venue has no tags", async () => {
    const ctx = buildHoldTestContext();
    const tag = ctx.bookingTags.seedTag({ orgId: ORG_ID, name: "A" });
    await expect(
      setBookingRequestTags(ctx.deps, { actorHumanId: ACT_A_ID, bookingRequestId: REQUEST_A, tagIds: [tag.id] }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      setBookingRequestTags(ctx.deps, { actorHumanId: VIEWER_ID, bookingRequestId: REQUEST_A, tagIds: [tag.id] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    const human = buildHoldTestContext({ place: { orgIdsWithAccess: [], humanIdsWithAccess: [OUTSIDER_ID] } });
    await expect(
      setBookingRequestTags(human.deps, { actorHumanId: OUTSIDER_ID, bookingRequestId: REQUEST_A, tagIds: [tag.id] }),
    ).rejects.toMatchObject({ code: "BOOKING_TAG_NOT_FOUND" });
    await expect(
      setBookingRequestTags(human.deps, { actorHumanId: OUTSIDER_ID, bookingRequestId: REQUEST_A, tagIds: [] }),
    ).resolves.toEqual({ bookingRequestId: REQUEST_A, tags: [] });
  });
});
