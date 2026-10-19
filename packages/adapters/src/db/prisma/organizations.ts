import type {
  CreateOrganizationInput,
  OrganizationStatus,
  OrganizationsRepo,
  OrgInvitationRecord,
  OrgTrustTier,
  UpdateOrganizationInput,
} from "@th/ports/repos/organizations";
import type { OrgRole } from "@th/ports/repos/authz";
import type {
  OrgInvitationStatus,
  OrgTrustStats,
} from "@th/types/repos/organizations";

import type { PrismaClientOrTx } from "./types";

/** Prefix of the advisory-lock key for one org's owner roster. */
const OWNER_ROSTER_LOCK_PREFIX = "org_owner_roster:";

function ownerRosterLockKey(orgId: string): string {
  return `${OWNER_ROSTER_LOCK_PREFIX}${orgId}`;
}

/** Shared select for Organization → OrganizationRecord mapping. */
const ORG_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  defaultLocale: true,
  contactEmail: true,
  physicalAddress: true,
  defaultPrimaryPayoutTermsId: true,
  defaultResalePayoutTermsId: true,
  trustTier: true,
  trustBadgeLabel: true,
  trustBadgeIcon: true,
  chargebackTermsVersion: true,
  chargebackTermsAcceptedAt: true,
  chargebackTermsAcceptedByHumanId: true,
  createdAt: true,
} as const;

function mapOrg(row: {
  id: string;
  name: string;
  slug: string;
  status: string;
  defaultLocale: string | null;
  contactEmail: string | null;
  physicalAddress: string | null;
  defaultPrimaryPayoutTermsId: string | null;
  defaultResalePayoutTermsId: string | null;
  trustTier: string;
  trustBadgeLabel: string | null;
  trustBadgeIcon: string | null;
  chargebackTermsVersion: string | null;
  chargebackTermsAcceptedAt: Date | null;
  chargebackTermsAcceptedByHumanId: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status as OrganizationStatus,
    defaultLocale: row.defaultLocale ?? null,
    contactEmail: row.contactEmail ?? null,
    physicalAddress: row.physicalAddress ?? null,
    defaultPrimaryPayoutTermsId: row.defaultPrimaryPayoutTermsId ?? null,
    defaultResalePayoutTermsId: row.defaultResalePayoutTermsId ?? null,
    trustTier: row.trustTier as OrgTrustTier,
    trustBadgeLabel: row.trustBadgeLabel ?? null,
    trustBadgeIcon: row.trustBadgeIcon ?? null,
    chargebackTermsVersion: row.chargebackTermsVersion ?? null,
    chargebackTermsAcceptedAt: row.chargebackTermsAcceptedAt ?? null,
    chargebackTermsAcceptedByHumanId:
      row.chargebackTermsAcceptedByHumanId ?? null,
    createdAt: row.createdAt,
  };
}

function mapInvitation(row: {
  id: string;
  orgId: string;
  email: string;
  role: string;
  invitedByHumanId: string;
  token: string;
  status: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByHumanId: string | null;
  createdAt: Date;
}): OrgInvitationRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.role as OrgRole,
    invitedByHumanId: row.invitedByHumanId,
    token: row.token,
    status: row.status as OrgInvitationStatus,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    acceptedByHumanId: row.acceptedByHumanId,
    createdAt: row.createdAt,
  };
}

/**
 * Copy a nullable field onto a Prisma `data` patch, treating "absent" and
 * "explicitly `undefined`" identically — both mean DON'T TOUCH THIS COLUMN.
 *
 * Nullable columns need a three-way distinction that `!== undefined` alone
 * can't express: omit (leave alone), `null` (clear), value (set). The obvious
 * `hasOwnProperty` guard gets the first two backwards, because
 * `hasOwnProperty` is TRUE for `{ contactEmail: undefined }` and the old
 * `?? null` coalesce then wrote NULL. TypeScript cannot help here — without
 * `exactOptionalPropertyTypes`, `{ x: undefined }` and `{}` are the same type,
 * so a caller building `{ x: cond ? v : undefined }` type-checks perfectly and
 * silently wipes the column. That is exactly how a partial org update erased
 * the CAN-SPAM mailing address; see the note in `use-cases/orgs/update-org.ts`.
 *
 * Clearing a field with an explicit `null` still works — that is the whole
 * point of keeping the key-presence check rather than a bare `!= null`.
 */
function assignNullable<K extends keyof UpdateOrganizationInput>(
  data: Record<string, unknown>,
  input: UpdateOrganizationInput,
  key: K,
): void {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return;
  const value = input[key];
  if (value === undefined) return;
  data[key as string] = value;
}

export function makeOrganizationsRepo(p: PrismaClientOrTx): OrganizationsRepo {
  return {
    async getById(id) {
      const org = await p.organization.findUnique({
        where: { id },
        select: ORG_SELECT,
      });

      if (!org) return null;

      return mapOrg(org);
    },

    async getByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const rows = await p.organization.findMany({
        where: { id: { in: ids } },
        select: ORG_SELECT,
      });
      return rows.map(mapOrg);
    },

    async create(input: CreateOrganizationInput) {
      const created = await p.organization.create({
        data: {
          name: input.name,
          slug: input.slug,
          status: input.status,
          createdAt: input.createdAt,
          defaultLocale: input.defaultLocale ?? null,
          contactEmail: input.contactEmail ?? null,
        },
        select: ORG_SELECT,
      });

      return mapOrg(created);
    },

    async update(input: UpdateOrganizationInput) {
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.slug !== undefined) data.slug = input.slug;
      assignNullable(data, input, "defaultLocale");
      assignNullable(data, input, "contactEmail");
      assignNullable(data, input, "physicalAddress");
      assignNullable(data, input, "defaultPrimaryPayoutTermsId");
      assignNullable(data, input, "defaultResalePayoutTermsId");
      if (input.trustTier !== undefined) data.trustTier = input.trustTier;
      assignNullable(data, input, "trustBadgeLabel");
      assignNullable(data, input, "trustBadgeIcon");

      const updated = await p.organization.update({
        where: { id: input.id },
        data,
        select: ORG_SELECT,
      });

      return mapOrg(updated);
    },

    async setDefaultPrimaryPayoutTermsIdIfNull(input: {
      id: string;
      payoutTermsId: string;
    }) {
      // Guarded compare-and-swap (mirrors payout-terms `activate`): the WHERE
      // pins the pointer to NULL, so a concurrent transaction that already set
      // it results in a 0-match instead of a silent overwrite. Callers re-read
      // and adopt the winner's row on `false`.
      const result = await p.organization.updateMany({
        where: { id: input.id, defaultPrimaryPayoutTermsId: null },
        data: { defaultPrimaryPayoutTermsId: input.payoutTermsId },
      });
      return result.count === 1;
    },

    async acceptChargebackTerms(input) {
      const updated = await p.organization.update({
        where: { id: input.orgId },
        data: {
          chargebackTermsVersion: input.version,
          chargebackTermsAcceptedAt: input.acceptedAt,
          chargebackTermsAcceptedByHumanId: input.acceptedByHumanId,
        },
        select: ORG_SELECT,
      });

      return mapOrg(updated);
    },

    async addMember({
      orgId,
      humanId,
      role,
      addedAt,
    }: {
      orgId: string;
      humanId: string;
      role: OrgRole;
      addedAt: Date;
    }) {
      const existing = await p.orgMember.findUnique({
        where: { orgId_humanId: { orgId, humanId } },
        select: { id: true, role: true },
      });

      if (!existing) {
        await p.orgMember.create({
          data: {
            orgId,
            humanId,
            role,
            createdAt: addedAt,
          },
          select: { id: true },
        });

        return { created: true, previousRole: null };
      }

      if (existing.role !== role) {
        await p.orgMember.update({
          where: { id: existing.id },
          data: { role },
        });
      }

      return { created: false, previousRole: existing.role as OrgRole };
    },

    async countMembersByRole({ orgId, role }) {
      return p.orgMember.count({ where: { orgId, role } });
    },

    async lockOwnerRoster(orgId: string): Promise<void> {
      // Transaction-scoped advisory lock — see the port doc comment
      // (`packages/ports/src/repos/organizations.ts`) for the race it closes.
      // `hashtext` maps the key to one lock id per org; the key is BOUND via
      // tagged `$executeRaw`, never interpolated.
      //
      // Deliberately `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock`
      // returns Postgres `void`, which the driver adapter's `$queryRaw`
      // result decoder cannot deserialize (see authz.ts `lockAdminRoleGuard`).
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ownerRosterLockKey(orgId)}))`;
    },

    async lockOwnerRostersForMember(humanId: string): Promise<void> {
      // Every membership, whatever the role (see the port doc comment).
      // Read the org ids first and lock one statement at a time: a single
      // `SELECT pg_advisory_xact_lock(…) … ORDER BY` does not promise to take
      // the locks in sort order.
      //
      // Ordered by the lock id itself (`hashtext` of the key), not the org
      // id: two org ids can hash to one lock, and only an order over the lock
      // ids is the same order in every transaction.
      const locked = new Set<string>();
      const lockMemberships = async () => {
        const rows = await p.$queryRaw<Array<{ orgId: string }>>`
          SELECT "orgId" FROM "OrgMember"
          WHERE "humanId" = ${humanId}
          ORDER BY hashtext(${OWNER_ROSTER_LOCK_PREFIX}::text || "orgId"), "orgId"`;
        for (const { orgId } of rows) {
          if (locked.has(orgId)) continue;
          await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ownerRosterLockKey(orgId)}))`;
          locked.add(orgId);
        }
      };

      await lockMemberships();

      // No membership for this human can be created from here to commit: an
      // `OrgMember` insert takes FOR KEY SHARE on the `Human` row it points
      // at, which waits on this lock and then fails its foreign key once the
      // delete commits. Taking it waits for any such insert already in
      // flight (a `createOrg` makes its creator the new org's only OWNER
      // without a roster lock), so the second read sees every membership
      // there will be.
      //
      // Taken after the roster locks, not before: `inviteMember` and
      // `acceptInvitation` hold a roster lock and then take FOR KEY SHARE on
      // this row (the invitation's sender and accepter columns, the new
      // membership), so the reverse order would deadlock with them.
      await p.$executeRaw`SELECT 1 FROM "Human" WHERE "id" = ${humanId} FOR UPDATE`;

      // Orgs joined between the first read and the row lock. Their roster
      // locks come after the ones above, so they are out of order; only a
      // membership that committed in that gap is affected.
      await lockMemberships();
    },

    async isSoleOwnerOfAnyOrg(humanId: string) {
      const ownedMemberships = await p.orgMember.findMany({
        where: { humanId, role: "OWNER" },
        select: { orgId: true },
      });
      if (ownedMemberships.length === 0) return false;

      const ownerCounts = await p.orgMember.groupBy({
        by: ["orgId"],
        where: {
          orgId: { in: ownedMemberships.map((m) => m.orgId) },
          role: "OWNER",
        },
        _count: { _all: true },
      });

      return ownerCounts.some((row) => row._count._all <= 1);
    },

    async listActive({ limit, offset }) {
      const [orgs, total] = await Promise.all([
        p.organization.findMany({
          where: { status: "ACTIVE" },
          select: {
            ...ORG_SELECT,
            _count: {
              select: {
                // PUBLIC only: this count reaches the public organization
                // search document ("N events" on the result card), and a
                // PRIVATE event is link-only — its existence is not public.
                events: { where: { status: "PUBLISHED", visibility: "PUBLIC" } },
                members: true,
              },
            },
          },
          orderBy: { name: "asc" },
          skip: offset,
          take: limit,
        }),
        p.organization.count({ where: { status: "ACTIVE" } }),
      ]);

      return {
        items: orgs.map((org) => ({
          ...mapOrg(org),
          eventCount: org._count.events,
          memberCount: org._count.members,
        })),
        total,
      };
    },

    async listMembers({ orgId, limit, offset }) {
      const [members, total] = await Promise.all([
        p.orgMember.findMany({
          where: { orgId },
          select: {
            humanId: true,
            role: true,
            createdAt: true,
            human: {
              select: {
                name: true,
                authUser: {
                  select: { email: true },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
          skip: offset,
          take: limit,
        }),
        p.orgMember.count({ where: { orgId } }),
      ]);

      return {
        items: members.map((m) => ({
          humanId: m.humanId,
          name: m.human.name,
          email: m.human.authUser?.email ?? null,
          role: m.role as OrgRole,
          joinedAt: m.createdAt,
        })),
        total,
      };
    },

    async isMemberByEmail(orgId, email) {
      const count = await p.orgMember.count({
        where: {
          orgId,
          human: {
            authUser: { is: { email: { equals: email, mode: "insensitive" } } },
          },
        },
      });
      return count > 0;
    },

    async removeMember({ orgId, humanId }) {
      const deleted = await p.orgMember.deleteMany({
        where: { orgId, humanId },
      });
      return deleted.count > 0;
    },

    // ── Invitations ─────────────────────────────────────────────────────

    async createInvitation(input) {
      const select = {
        id: true,
        orgId: true,
        email: true,
        role: true,
        invitedByHumanId: true,
        token: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        acceptedByHumanId: true,
        createdAt: true,
      } as const;

      const row = await p.orgInvitation.upsert({
        where: { orgId_email: { orgId: input.orgId, email: input.email } },
        create: {
          orgId: input.orgId,
          email: input.email,
          role: input.role,
          invitedByHumanId: input.invitedByHumanId,
          token: input.token,
          expiresAt: input.expiresAt,
          status: "PENDING",
        },
        update: {
          role: input.role,
          invitedByHumanId: input.invitedByHumanId,
          token: input.token,
          expiresAt: input.expiresAt,
          status: "PENDING",
          acceptedAt: null,
          acceptedByHumanId: null,
        },
        select,
      });

      return mapInvitation(row);
    },

    async getInvitationByToken(token) {
      const row = await p.orgInvitation.findUnique({
        where: { token },
        select: {
          id: true,
          orgId: true,
          email: true,
          role: true,
          invitedByHumanId: true,
          token: true,
          status: true,
          expiresAt: true,
          acceptedAt: true,
          acceptedByHumanId: true,
          createdAt: true,
        },
      });

      return row ? mapInvitation(row) : null;
    },

    async getInvitationByOrgAndEmail(orgId, email) {
      const row = await p.orgInvitation.findUnique({
        where: { orgId_email: { orgId, email } },
        select: {
          id: true,
          orgId: true,
          email: true,
          role: true,
          invitedByHumanId: true,
          token: true,
          status: true,
          expiresAt: true,
          acceptedAt: true,
          acceptedByHumanId: true,
          createdAt: true,
        },
      });

      return row ? mapInvitation(row) : null;
    },

    async listInvitations({ orgId, status, limit, offset }) {
      const where = { orgId, ...(status ? { status } : {}) };

      const [rows, total] = await Promise.all([
        p.orgInvitation.findMany({
          where,
          select: {
            id: true,
            orgId: true,
            email: true,
            role: true,
            invitedByHumanId: true,
            token: true,
            status: true,
            expiresAt: true,
            acceptedAt: true,
            acceptedByHumanId: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
        }),
        p.orgInvitation.count({ where }),
      ]);

      return {
        items: rows.map(mapInvitation),
        total,
      };
    },

    async updateInvitationStatus(input) {
      const row = await p.orgInvitation.update({
        where: { id: input.id },
        data: {
          status: input.status,
          acceptedAt: input.acceptedAt ?? undefined,
          acceptedByHumanId: input.acceptedByHumanId ?? undefined,
        },
        select: {
          id: true,
          orgId: true,
          email: true,
          role: true,
          invitedByHumanId: true,
          token: true,
          status: true,
          expiresAt: true,
          acceptedAt: true,
          acceptedByHumanId: true,
          createdAt: true,
        },
      });

      return mapInvitation(row);
    },

    async revokePendingOwnerInvitationsByInviter({ orgId, invitedByHumanId }) {
      // One UPDATE … RETURNING, so the rows returned are exactly the rows
      // revoked even when an invitee accepts at the same moment.
      return p.orgInvitation.updateManyAndReturn({
        where: { orgId, invitedByHumanId, role: "OWNER", status: "PENDING" },
        data: { status: "REVOKED" },
        select: { id: true, email: true },
      });
    },

    async revokeAllPendingInvitations(orgId: string): Promise<number> {
      const revoked = await p.orgInvitation.updateMany({
        where: { orgId, status: "PENDING" },
        data: { status: "REVOKED" },
      });
      return revoked.count;
    },

    // ── Trust / Reputation ──────────────────────────────────────────────

    async getOrgTrustStats(orgId: string): Promise<OrgTrustStats> {
      const [org, completedEventCount, orderStats, verifiedVenueCount] =
        await Promise.all([
          // 1. Org record for createdAt + contactEmail
          p.organization.findUnique({
            where: { id: orgId },
            select: { createdAt: true, contactEmail: true },
          }),

          // 2. Count of COMPLETED events
          p.event.count({
            where: { orgId, status: "COMPLETED" },
          }),

          // 3. Total orders (SUCCEEDED + PART_REFUNDED + REFUNDED + DISPUTED) and dispute/refund orders
          //    for events owned by this org.
          p.order.groupBy({
            by: ["status"],
            where: {
              event: { orgId },
              status: {
                in: ["SUCCEEDED", "PART_REFUNDED", "REFUNDED", "DISPUTED"],
              },
            },
            _count: { _all: true },
          }),

          // 4. Whether any place owned by this org has verified ownership
          p.placeOwnership.count({
            where: {
              ownerType: "ORGANIZATION",
              ownerId: orgId,
              verified: true,
            },
          }),
        ]);

      // Compute ticket counts via order items on completed events
      const ticketAgg = await p.orderItem.aggregate({
        where: {
          order: {
            event: { orgId },
            status: { in: ["SUCCEEDED", "PART_REFUNDED"] },
          },
          status: "active",
        },
        _count: { _all: true },
      });

      const totalOrders = orderStats.reduce((sum, g) => sum + g._count._all, 0);
      const disputedOrders = orderStats
        .filter((g) => g.status === "DISPUTED" || g.status === "REFUNDED")
        .reduce((sum, g) => sum + g._count._all, 0);

      const disputeRate = totalOrders > 0 ? disputedOrders / totalOrders : 0;
      const accountAgeDays = org
        ? Math.floor(
            (Date.now() - org.createdAt.getTime()) / (1000 * 60 * 60 * 24),
          )
        : 0;

      return {
        completedEventCount: completedEventCount,
        totalTicketsSold: ticketAgg._count._all,
        disputeRate,
        accountAgeDays,
        hasContactEmail: !!org?.contactEmail,
        hasVerifiedVenue: verifiedVenueCount > 0,
      };
    },
  };
}
