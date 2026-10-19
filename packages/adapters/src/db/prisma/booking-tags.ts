import { Prisma } from "@prisma/client";
import type {
  BookingTagRecord,
  BookingTagsRepo,
} from "@th/ports/repos/booking-tags";

import type { PrismaClientOrTx } from "./types";

export const BOOKING_TAG_SELECT = {
  id: true,
  orgId: true,
  name: true,
  slug: true,
  color: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

const TAG_ORDER = [
  { sortOrder: "asc" },
  { name: "asc" },
] as const satisfies Prisma.BookingTagOrderByWithRelationInput[];

export const mapBookingTagRecord = (row: {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  color: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}): BookingTagRecord => ({
  id: row.id,
  orgId: row.orgId,
  name: row.name,
  slug: row.slug,
  color: row.color,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function mapSlugTaken(error: unknown): never {
  // The only unique besides `id` is (orgId, slug) — see agreement.prisma.
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw {
      code: "conflict",
      message: "booking_tag_slug_taken",
      cause: error,
    } as const;
  }
  throw error;
}

export function makeBookingTagsRepo(p: PrismaClientOrTx): BookingTagsRepo {
  return {
    async listForOrg(orgId) {
      const rows = await p.bookingTag.findMany({
        where: { orgId },
        orderBy: TAG_ORDER,
        select: BOOKING_TAG_SELECT,
      });
      return rows.map(mapBookingTagRecord);
    },

    async create(input) {
      try {
        const row = await p.bookingTag.create({
          data: {
            orgId: input.orgId,
            name: input.name,
            slug: input.slug,
            color: input.color,
            sortOrder: input.sortOrder ?? 0,
          },
          select: BOOKING_TAG_SELECT,
        });
        return mapBookingTagRecord(row);
      } catch (error) {
        return mapSlugTaken(error);
      }
    },

    async update(input) {
      const data: Prisma.BookingTagUncheckedUpdateManyInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.slug !== undefined) data.slug = input.slug;
      if (input.color !== undefined) data.color = input.color;
      if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

      try {
        // orgId in the WHERE (not just an assert) — a tag id from another org
        // matches zero rows (IDOR backstop; same discipline as
        // bookingRequests.softDeleteAttachment).
        const result = await p.bookingTag.updateMany({
          where: { id: input.id, orgId: input.orgId },
          data,
        });
        if (result.count === 0) return null;
      } catch (error) {
        return mapSlugTaken(error);
      }
      const row = await p.bookingTag.findUnique({
        where: { id: input.id },
        select: BOOKING_TAG_SELECT,
      });
      return row ? mapBookingTagRecord(row) : null;
    },

    async delete(input) {
      const result = await p.bookingTag.deleteMany({
        where: { id: input.id, orgId: input.orgId },
      });
      return result.count > 0;
    },

    async setForRequest({ bookingRequestId, orgId, tagIds }) {
      const wanted = [...new Set(tagIds)];
      // Org scope (review finding): the join table has no org column, so a
      // tag id from another org would otherwise attach silently. Every
      // wanted id must resolve to a tag of `orgId` — one query, count match.
      if (wanted.length > 0) {
        const owned = await p.bookingTag.count({
          where: { id: { in: wanted }, orgId },
        });
        if (owned !== wanted.length) {
          throw {
            code: "invalid_input",
            message: "booking_tag_foreign_org",
          } as const;
        }
      }
      // Replace-all as delete-missing + insert-new (not delete-all +
      // reinsert): rows that stay keep their createdAt, and the composite PK
      // (bookingRequestId, tagId) makes the insert side race-safe via
      // skipDuplicates.
      await p.bookingRequestTag.deleteMany({
        where: {
          bookingRequestId,
          ...(wanted.length > 0 ? { tagId: { notIn: wanted } } : {}),
        },
      });
      if (wanted.length > 0) {
        try {
          await p.bookingRequestTag.createMany({
            data: wanted.map((tagId) => ({ bookingRequestId, tagId })),
            skipDuplicates: true,
          });
        } catch (error) {
          // FK violation (P2003): the request (or, between the count above
          // and here, a tag) vanished. The tag side was just verified, so
          // name the request (precedent: agreements.setDraftEvent).
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2003"
          ) {
            throw {
              code: "conflict",
              message: "booking_request_missing",
              cause: error,
            } as const;
          }
          throw error;
        }
      }
      const rows = await p.bookingRequestTag.findMany({
        where: { bookingRequestId },
        select: { tag: { select: BOOKING_TAG_SELECT } },
        orderBy: [{ tag: { sortOrder: "asc" } }, { tag: { name: "asc" } }],
      });
      return rows.map((row) => mapBookingTagRecord(row.tag));
    },

    async listForRequests(bookingRequestIds) {
      if (bookingRequestIds.length === 0) return [];
      const rows = await p.bookingRequestTag.findMany({
        where: { bookingRequestId: { in: [...bookingRequestIds] } },
        select: {
          bookingRequestId: true,
          tag: { select: BOOKING_TAG_SELECT },
        },
        orderBy: [
          { bookingRequestId: "asc" },
          { tag: { sortOrder: "asc" } },
          { tag: { name: "asc" } },
        ],
      });
      return rows.map((row) => ({
        bookingRequestId: row.bookingRequestId,
        tag: mapBookingTagRecord(row.tag),
      }));
    },
  } satisfies BookingTagsRepo;
}
