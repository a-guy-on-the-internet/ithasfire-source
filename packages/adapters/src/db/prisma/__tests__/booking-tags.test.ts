import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import {
  BOOKING_TAG_SELECT,
  makeBookingTagsRepo,
  mapBookingTagRecord,
} from "../booking-tags";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape + mapping coverage for the BookingTag adapter (booking-holds
 * spec FR-017). Pins the org-scoped WHERE on mutations (IDOR backstop) and
 * the replace-all semantics of setForRequest.
 */

const ORG = "44444444-4444-4444-8444-444444444444";
const TAG = "55555555-5555-4555-8555-555555555555";
const REQ = "66666666-6666-4666-8666-666666666666";

const ROW = {
  id: TAG,
  orgId: ORG,
  name: "Follow up",
  slug: "follow-up",
  color: "warning",
  sortOrder: 3,
  createdAt: new Date("2026-08-25T00:00:00.000Z"),
  updatedAt: new Date("2026-08-25T00:00:00.000Z"),
};

function tagPrisma() {
  const tag = {
    findMany: vi.fn(async () => [ROW]),
    count: vi.fn(async () => 2),
    findUnique: vi.fn(async () => ROW),
    updateMany: vi.fn(async () => ({ count: 1 })),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  const join = {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 1 })),
    findMany: vi.fn(async () => [{ bookingRequestId: REQ, tag: ROW }]),
  };
  const prisma = {
    bookingTag: tag,
    bookingRequestTag: join,
  } as unknown as PrismaClientOrTx;
  return { prisma, tag, join };
}

describe("mapBookingTagRecord", () => {
  it("maps every selected column", () => {
    const record = mapBookingTagRecord(ROW);
    expect(record).toEqual(ROW);
    expect(Object.keys(record).sort()).toEqual(
      Object.keys(BOOKING_TAG_SELECT).sort(),
    );
  });
});

describe("bookingTags query shapes", () => {
  it("update scopes the WHERE by (id, orgId) and returns null on zero rows", async () => {
    const { prisma, tag } = tagPrisma();
    tag.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await makeBookingTagsRepo(prisma).update({
      id: TAG,
      orgId: "other-org",
      name: "Renamed",
    });
    expect(result).toBeNull();
    expect(tag.updateMany).toHaveBeenCalledWith({
      where: { id: TAG, orgId: "other-org" },
      data: { name: "Renamed" },
    });
    expect(tag.findUnique).not.toHaveBeenCalled();
  });

  it("delete scopes by (id, orgId) and reports whether a row went", async () => {
    const { prisma, tag } = tagPrisma();
    expect(
      await makeBookingTagsRepo(prisma).delete({ id: TAG, orgId: ORG }),
    ).toBe(true);
    expect(tag.deleteMany).toHaveBeenCalledWith({
      where: { id: TAG, orgId: ORG },
    });
    tag.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await makeBookingTagsRepo(prisma).delete({ id: TAG, orgId: ORG }),
    ).toBe(false);
  });

  it("setForRequest detaches rows outside the set, inserts the rest with skipDuplicates, dedupes ids", async () => {
    const { prisma, join } = tagPrisma();
    await makeBookingTagsRepo(prisma).setForRequest({
      bookingRequestId: REQ,
      orgId: ORG,
      tagIds: [TAG, TAG, "tag-b"],
    });
    expect(join.deleteMany).toHaveBeenCalledWith({
      where: { bookingRequestId: REQ, tagId: { notIn: [TAG, "tag-b"] } },
    });
    expect(join.createMany).toHaveBeenCalledWith({
      data: [
        { bookingRequestId: REQ, tagId: TAG },
        { bookingRequestId: REQ, tagId: "tag-b" },
      ],
      skipDuplicates: true,
    });
  });

  it("setForRequest verifies every tag belongs to orgId before writing anything", async () => {
    const { prisma, tag, join } = tagPrisma();
    tag.count.mockResolvedValueOnce(1);
    await expect(
      makeBookingTagsRepo(prisma).setForRequest({
        bookingRequestId: REQ,
        orgId: ORG,
        tagIds: [TAG, "foreign-tag"],
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "booking_tag_foreign_org",
    });
    expect(tag.count).toHaveBeenCalledWith({
      where: { id: { in: [TAG, "foreign-tag"] }, orgId: ORG },
    });
    expect(join.deleteMany).not.toHaveBeenCalled();
    expect(join.createMany).not.toHaveBeenCalled();
  });

  it("setForRequest with an empty set clears every join row and inserts nothing", async () => {
    const { prisma, join, tag } = tagPrisma();
    join.findMany.mockResolvedValueOnce([]);
    const result = await makeBookingTagsRepo(prisma).setForRequest({
      bookingRequestId: REQ,
      orgId: ORG,
      tagIds: [],
    });
    expect(tag.count).not.toHaveBeenCalled();
    expect(result).toEqual([]);
    expect(join.deleteMany).toHaveBeenCalledWith({
      where: { bookingRequestId: REQ },
    });
    expect(join.createMany).not.toHaveBeenCalled();
  });

  it("setForRequest maps a vanished request (P2003 on insert) to booking_request_missing", async () => {
    const { prisma, join, tag } = tagPrisma();
    tag.count.mockResolvedValueOnce(1);
    join.createMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" }),
    );
    await expect(
      makeBookingTagsRepo(prisma).setForRequest({ bookingRequestId: REQ, orgId: ORG, tagIds: [TAG] }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_request_missing" });
  });

  it("listForRequests short-circuits on an empty set", async () => {
    const { prisma, join } = tagPrisma();
    expect(await makeBookingTagsRepo(prisma).listForRequests([])).toEqual([]);
    expect(join.findMany).not.toHaveBeenCalled();
  });
});
