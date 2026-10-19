import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makeAnnouncementsRepo } from "../announcements";
import type { PrismaClientOrTx } from "../types";

// Regression for the 2026-09-29 prod 500 on `announcements.previewAudienceCount`:
// the audience SQL read `h."email"` off "Human" (no such column — email lives
// on `auth_user`, linked by `auth_user.human_id`) and filtered orders on
// `'CONFIRMED'/'COMPLETED'` (not `OrderStatus` values — Postgres rejects the
// literal). The CONTACT_LIST count also read a non-existent `"email"` column.
//
// This is a MOCKED test: it pins the SQL text each audience type emits. It
// cannot prove the SQL runs against the real schema — that was verified by
// running the adapter against the local dev DB (see the change report).

const ORG = "00000000-0000-4000-8000-0000000000aa";
const EVENT = "00000000-0000-4000-8000-0000000000bb";
const TIER = "00000000-0000-4000-8000-0000000000cc";
const LIST = "00000000-0000-4000-8000-0000000000dd";

const AUDIENCES = [
  { audienceType: "ALL_TICKET_HOLDERS" },
  { audienceType: "EVENT_TICKET_HOLDERS", audienceRef: EVENT },
  { audienceType: "MULTIPLE_EVENTS", audienceFilter: { eventIds: [EVENT] } },
  {
    audienceType: "EVENT_TICKET_TIER",
    audienceFilter: { eventId: EVENT, tierIds: [TIER] },
  },
  { audienceType: "CONTACT_LIST", audienceRef: LIST },
  { audienceType: "WAITLIST_SUBSCRIBERS", audienceRef: EVENT },
] as const;

const TICKET_HOLDER_TYPES = new Set([
  "ALL_TICKET_HOLDERS",
  "EVENT_TICKET_HOLDERS",
  "MULTIPLE_EVENTS",
  "EVENT_TICKET_TIER",
]);

function createPrisma(rows: unknown[]) {
  const sqlSeen: string[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    sqlSeen.push(strings.join("$?"));
    return rows;
  });
  const prisma = {
    $queryRaw,
    inviteListEntry: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClientOrTx;
  return { prisma, sqlSeen };
}

const baseInput = {
  ownerType: "ORGANIZATION",
  orgId: ORG,
  audienceRef: null,
  audienceFilter: null,
  excludedContactListId: null,
};

describe("makeAnnouncementsRepo — audience SQL", () => {
  for (const audience of AUDIENCES) {
    const input = { ...baseInput, ...audience } as never;

    it(`${audience.audienceType}: count + list emit schema-valid SQL`, async () => {
      const { prisma, sqlSeen } = createPrisma([{ cnt: 3n }]);
      const repo = makeAnnouncementsRepo(prisma);

      await repo.countAudienceRecipients(input);
      await repo.listAudienceRecipientEmails(input);

      expect(sqlSeen).toHaveLength(2);
      for (const sql of sqlSeen) {
        // Human carries no email column.
        expect(sql).not.toMatch(/h\."email"/);
        // Not OrderStatus values.
        expect(sql).not.toMatch(/CONFIRMED|COMPLETED/);

        if (TICKET_HOLDER_TYPES.has(audience.audienceType)) {
          expect(sql).toMatch(
            /JOIN "auth_user" u ON u\."human_id" = h\."id"/,
          );
          expect(sql).toContain(
            `o."status" IN ('SUCCEEDED', 'PART_REFUNDED')`,
          );
        }
        if (audience.audienceType === "WAITLIST_SUBSCRIBERS") {
          expect(sql).toMatch(
            /LEFT JOIN "auth_user" u ON u\."human_id" = w\."humanId"/,
          );
          expect(sql).toContain(`COALESCE(u."email", w."contactEmail")`);
        }
        if (audience.audienceType === "CONTACT_LIST") {
          // InviteListEntry has `contactEmail`, not `email`, and the count
          // must apply the same unsubscribe filter the recipient list does.
          expect(sql).toContain(`"contactEmail"`);
          expect(sql).not.toMatch(/DISTINCT "email"/);
          expect(sql).toContain(`"unsubscribedAt" IS NULL`);
        }
      }
    });
  }

  it("count dedupes case-insensitively, matching the list's DISTINCT ON (LOWER(email))", async () => {
    const { prisma, sqlSeen } = createPrisma([{ cnt: 2n }]);
    const repo = makeAnnouncementsRepo(prisma);

    const count = await repo.countAudienceRecipients({
      ...baseInput,
      audienceType: "ALL_TICKET_HOLDERS",
    } as never);

    expect(count).toBe(2);
    expect(sqlSeen[0]).toContain(`COUNT(DISTINCT LOWER(u."email"))`);
  });

  it("list maps the auth_user email rows to recipients and drops excluded emails", async () => {
    const { prisma } = createPrisma([
      {
        email: "Fan@Example.com",
        name: "Fan",
        entry_id: null,
        list_id: null,
        waitlist_entry_id: null,
        waitlist_event_id: null,
        human_id: "h-1",
      },
      {
        email: "blocked@example.com",
        name: null,
        entry_id: null,
        list_id: null,
        waitlist_entry_id: null,
        waitlist_event_id: null,
        human_id: "h-2",
      },
    ]);
    (
      prisma as unknown as {
        inviteListEntry: { findMany: ReturnType<typeof vi.fn> };
      }
    ).inviteListEntry.findMany.mockResolvedValueOnce([
      { contactEmail: "Blocked@Example.com" },
    ]);
    const repo = makeAnnouncementsRepo(prisma);

    const recipients = await repo.listAudienceRecipientEmails({
      ...baseInput,
      audienceType: "ALL_TICKET_HOLDERS",
      excludedContactListId: LIST,
    } as never);

    expect(recipients).toEqual([
      expect.objectContaining({ email: "Fan@Example.com", humanId: "h-1" }),
    ]);
  });
});

// Security review F4 (2026-09-29): every audience branch must be scoped to
// the owner, so a foreign audienceRef resolves to nobody even if the use
// case's ownership assertion were bypassed. Nested `Prisma.sql` fragments are
// VALUES of the outer template, so flatten through `Prisma.sql` to see them.
describe("makeAnnouncementsRepo — owner scoping", () => {
  const HUMAN_OWNER = "00000000-0000-4000-8000-0000000000ee";

  function createFlatteningPrisma() {
    const queries: { sql: string; values: unknown[] }[] = [];
    const findMany = vi.fn(async () => []);
    const prisma = {
      $queryRaw: vi.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const flat = Prisma.sql(strings, ...values);
          queries.push({ sql: flat.text, values: flat.values });
          return [{ cnt: 0n }];
        },
      ),
      inviteListEntry: { findMany },
    } as unknown as PrismaClientOrTx;
    return { prisma, queries, findMany };
  }

  for (const audience of AUDIENCES) {
    it(`${audience.audienceType}: ORGANIZATION owner predicate in count + list`, async () => {
      const { prisma, queries } = createFlatteningPrisma();
      const repo = makeAnnouncementsRepo(prisma);
      const input = { ...baseInput, ...audience } as never;

      await repo.countAudienceRecipients(input);
      await repo.listAudienceRecipientEmails(input);

      expect(queries).toHaveLength(2);
      for (const q of queries) {
        if (audience.audienceType === "CONTACT_LIST") {
          expect(q.sql).toMatch(/FROM "InviteList" l/);
          expect(q.sql).toMatch(/l\."ownerType"::text = \$\d+/);
          expect(q.sql).toMatch(/l\."ownerId" = \$\d+/);
          expect(q.values).toEqual(
            expect.arrayContaining([LIST, "ORGANIZATION", ORG]),
          );
        } else {
          expect(q.sql).toMatch(/JOIN "Event" e ON e\."id" = /);
          expect(q.sql).toMatch(/e\."orgId" = \$\d+/);
          expect(q.sql).not.toMatch(/e\."orgId" IS NULL/);
          expect(q.values).toContain(ORG);
        }
        if (audience.audienceType === "EVENT_TICKET_TIER") {
          // Tiers must belong to the filtered event.
          expect(q.sql).toMatch(/tt\."eventId" = o\."eventId"/);
        }
      }
    });

    it(`${audience.audienceType}: HUMAN owner reaches only org-less events / own lists`, async () => {
      const { prisma, queries } = createFlatteningPrisma();
      const repo = makeAnnouncementsRepo(prisma);
      const input = {
        ...baseInput,
        ownerType: "HUMAN",
        orgId: HUMAN_OWNER,
        ...audience,
      } as never;

      await repo.countAudienceRecipients(input);
      await repo.listAudienceRecipientEmails(input);

      for (const q of queries) {
        if (audience.audienceType === "CONTACT_LIST") {
          expect(q.values).toEqual(
            expect.arrayContaining(["HUMAN", HUMAN_OWNER]),
          );
        } else {
          expect(q.sql).toMatch(
            /e\."orgId" IS NULL AND e\."humanId" = \$\d+/,
          );
          expect(q.values).toContain(HUMAN_OWNER);
        }
      }
    });
  }

  it("the excluded contact list is read only when it belongs to the owner", async () => {
    const { prisma, findMany } = createFlatteningPrisma();
    const repo = makeAnnouncementsRepo(prisma);
    const input = {
      ...baseInput,
      audienceType: "ALL_TICKET_HOLDERS",
      excludedContactListId: LIST,
    } as never;

    await repo.countAudienceRecipients(input);
    await repo.listAudienceRecipientEmails(input);

    expect(findMany).toHaveBeenCalledTimes(2);
    for (const call of findMany.mock.calls as unknown as [
      { where: unknown },
    ][]) {
      expect(call[0].where).toEqual({
        inviteListId: LIST,
        inviteList: { ownerType: "ORGANIZATION", ownerId: ORG },
      });
    }
  });
});
