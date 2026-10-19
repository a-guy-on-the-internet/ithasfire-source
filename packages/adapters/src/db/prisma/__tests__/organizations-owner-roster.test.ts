import { describe, expect, it, vi } from "vitest";

import { makeOrganizationsRepo } from "../organizations";
import type { PrismaClientOrTx } from "../types";

/**
 * Shape tests for the owner-roster repo methods, against a mocked Prisma
 * client. They pin WHAT is sent to Prisma (the lock key and that it is bound,
 * the revoke filter); they do not run SQL, so they say nothing about how
 * Postgres serializes two transactions on the lock.
 */

const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ORG_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const INVITER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("makeOrganizationsRepo.lockOwnerRoster", () => {
  function createPrisma() {
    const $executeRaw = vi.fn(async () => 1);
    const $queryRaw = vi.fn();
    const prisma = { $executeRaw, $queryRaw } as unknown as PrismaClientOrTx;
    return { prisma, $executeRaw, $queryRaw };
  }

  it("takes a transaction-scoped advisory lock keyed on the org, with the key bound", async () => {
    const { prisma, $executeRaw, $queryRaw } = createPrisma();

    await makeOrganizationsRepo(prisma).lockOwnerRoster(ORG_ID);

    expect($executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = $executeRaw.mock.calls[0]! as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    // The SQL text carries no org id: it reaches Postgres as a parameter.
    expect([...strings]).toEqual([
      "SELECT pg_advisory_xact_lock(hashtext(",
      "))",
    ]);
    expect(values).toEqual([`org_owner_roster:${ORG_ID}`]);
    // `$queryRaw` cannot decode the `void` the lock function returns.
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("uses a different key for a different org", async () => {
    const { prisma, $executeRaw } = createPrisma();
    const repo = makeOrganizationsRepo(prisma);

    await repo.lockOwnerRoster(ORG_ID);
    await repo.lockOwnerRoster(OTHER_ORG_ID);

    const keys = $executeRaw.mock.calls.map(
      (call) => (call as unknown as unknown[])[1],
    );
    expect(keys).toEqual([
      `org_owner_roster:${ORG_ID}`,
      `org_owner_roster:${OTHER_ORG_ID}`,
    ]);
  });
});

describe("makeOrganizationsRepo.lockOwnerRostersForMember", () => {
  const THIRD_ORG_ID = "99999999-9999-4999-8999-999999999999";

  type Statement = { sql: string; values: unknown[] };

  /**
   * `reads` is what each membership read returns, in turn. Every statement
   * sent, read or lock, is recorded in one list so the order is visible.
   */
  function createPrisma(reads: string[][]) {
    const statements: Statement[] = [];
    const record = (strings: TemplateStringsArray, values: unknown[]) =>
      statements.push({ sql: strings.join("$"), values });
    let readCount = 0;
    const $queryRaw = vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        record(strings, values);
        const rows = reads[readCount] ?? reads[reads.length - 1] ?? [];
        readCount += 1;
        return rows.map((orgId) => ({ orgId }));
      },
    );
    const $executeRaw = vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        record(strings, values);
        return 1;
      },
    );
    const prisma = { $queryRaw, $executeRaw } as unknown as PrismaClientOrTx;
    return { prisma, statements, $queryRaw };
  }

  const isRead = (st: Statement) => st.sql.includes('FROM "OrgMember"');
  const isRosterLock = (st: Statement) =>
    st.sql.includes("pg_advisory_xact_lock");
  const isRowLock = (st: Statement) =>
    st.sql.includes('FROM "Human"') && st.sql.includes("FOR UPDATE");

  it("reads every org the human is a member of, whatever the role, ordered by the lock id, with every value bound", async () => {
    const { prisma, statements } = createPrisma([[]]);

    await makeOrganizationsRepo(prisma).lockOwnerRostersForMember(INVITER_ID);

    const read = statements.find(isRead)!;
    // No role filter: an org the human is an EDITOR of is locked too, since
    // an ownership transfer can make them its only OWNER mid-delete.
    expect(read.sql).not.toMatch(/role/i);
    expect(read.sql).toMatch(
      /ORDER BY hashtext\(\$::text \|\| "orgId"\), "orgId"/,
    );
    expect(read.values).toEqual([INVITER_ID, "org_owner_roster:"]);
  });

  it("locks each org in the order read, then the human's row, then reads again", async () => {
    // The read returns the orgs already in lock-id order.
    const { prisma, statements } = createPrisma([
      [OTHER_ORG_ID, ORG_ID],
      [OTHER_ORG_ID, ORG_ID],
    ]);

    await makeOrganizationsRepo(prisma).lockOwnerRostersForMember(INVITER_ID);

    expect(
      statements.map((st) =>
        isRead(st)
          ? "read"
          : isRosterLock(st)
            ? `lock ${String(st.values[0])}`
            : isRowLock(st)
              ? "row"
              : st.sql,
      ),
    ).toEqual([
      "read",
      `lock org_owner_roster:${OTHER_ORG_ID}`,
      `lock org_owner_roster:${ORG_ID}`,
      "row",
      "read",
    ]);
    const rowLock = statements.find(isRowLock)!;
    expect(rowLock.sql).toBe('SELECT 1 FROM "Human" WHERE "id" = $ FOR UPDATE');
    expect(rowLock.values).toEqual([INVITER_ID]);
  });

  it("locks an org joined while the first locks were taken, and only that one again", async () => {
    const { prisma, statements } = createPrisma([
      [ORG_ID],
      [THIRD_ORG_ID, ORG_ID],
    ]);

    await makeOrganizationsRepo(prisma).lockOwnerRostersForMember(INVITER_ID);

    const rowAt = statements.findIndex(isRowLock);
    const locksAfterRow = statements
      .slice(rowAt)
      .filter(isRosterLock)
      .map((st) => st.values[0]);
    expect(locksAfterRow).toEqual([`org_owner_roster:${THIRD_ORG_ID}`]);
    expect(statements.filter(isRosterLock)).toHaveLength(2);
  });

  it("still locks the row of a human who belongs to no org", async () => {
    const { prisma, statements } = createPrisma([[]]);

    await makeOrganizationsRepo(prisma).lockOwnerRostersForMember(INVITER_ID);

    expect(statements.filter(isRosterLock)).toHaveLength(0);
    expect(statements.filter(isRowLock)).toHaveLength(1);
  });
});

describe("makeOrganizationsRepo.revokeAllPendingInvitations", () => {
  it("revokes every PENDING invitation of that org in one statement and returns the count", async () => {
    const updateMany = vi.fn(async () => ({ count: 3 }));
    const prisma = {
      orgInvitation: { updateMany },
    } as unknown as PrismaClientOrTx;

    await expect(
      makeOrganizationsRepo(prisma).revokeAllPendingInvitations(ORG_ID),
    ).resolves.toBe(3);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, status: "PENDING" },
      data: { status: "REVOKED" },
    });
  });
});

describe("makeOrganizationsRepo.revokePendingOwnerInvitationsByInviter", () => {
  function createPrisma(rows: Array<{ id: string; email: string }>) {
    const updateManyAndReturn = vi.fn(async () => rows);
    const prisma = {
      orgInvitation: { updateManyAndReturn },
    } as unknown as PrismaClientOrTx;
    return { prisma, updateManyAndReturn };
  }

  it("revokes only that inviter's PENDING OWNER invitations in that org, in one statement", async () => {
    const rows = [
      { id: "inv-1", email: "one@example.com" },
      { id: "inv-2", email: "two@example.com" },
    ];
    const { prisma, updateManyAndReturn } = createPrisma(rows);

    const revoked = await makeOrganizationsRepo(
      prisma,
    ).revokePendingOwnerInvitationsByInviter({
      orgId: ORG_ID,
      invitedByHumanId: INVITER_ID,
    });

    expect(updateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        orgId: ORG_ID,
        invitedByHumanId: INVITER_ID,
        role: "OWNER",
        status: "PENDING",
      },
      data: { status: "REVOKED" },
      select: { id: true, email: true },
    });
    expect(revoked).toEqual(rows);
  });

  it("returns an empty list when there is nothing to revoke", async () => {
    const { prisma } = createPrisma([]);

    await expect(
      makeOrganizationsRepo(prisma).revokePendingOwnerInvitationsByInviter({
        orgId: ORG_ID,
        invitedByHumanId: INVITER_ID,
      }),
    ).resolves.toEqual([]);
  });
});
