import type { HumanRole as PrismaHumanRole } from "@prisma/client";
import type { HumanRole } from "@th/ports/authz";
import type {
  AuthZRepo,
  OrgMembership,
  PlaceAccessContext,
} from "@th/ports/repos/authz";

import type { PrismaClientOrTx } from "./types";

export function makeAuthZRepo(p: PrismaClientOrTx): AuthZRepo {
  return {
    async getOrgMembership({ orgId, humanId }): Promise<OrgMembership | null> {
      const membership = await p.orgMember.findUnique({
        where: { orgId_humanId: { orgId, humanId } },
        select: { role: true },
      });

      if (!membership) {
        return null;
      }

      return { orgId, humanId, role: membership.role as OrgMembership["role"] };
    },

    async getOrgMemberships({ orgIds, humanId }): Promise<OrgMembership[]> {
      if (orgIds.length === 0) return [];

      const memberships = await p.orgMember.findMany({
        where: { humanId, orgId: { in: orgIds } },
        select: { orgId: true, role: true },
      });

      return memberships.map((m) => ({
        orgId: m.orgId,
        humanId,
        role: m.role as OrgMembership["role"],
      }));
    },

    async listOrgMembershipsByHumanId({
      humanId,
      roles,
    }): Promise<OrgMembership[]> {
      const memberships = await p.orgMember.findMany({
        where: {
          humanId,
          ...(roles && roles.length > 0 ? { role: { in: roles } } : {}),
        },
        select: {
          orgId: true,
          role: true,
        },
        orderBy: { createdAt: "asc" },
      });

      return memberships.map((membership) => ({
        orgId: membership.orgId,
        humanId,
        role: membership.role as OrgMembership["role"],
      }));
    },

    async getStaffRolesForHumanId(humanId: string): Promise<HumanRole[]> {
      const row = await p.human.findUnique({
        where: { id: humanId },
        select: { roles: true },
      });

      return (row?.roles ?? []) as HumanRole[];
    },

    async listHumanIdsByStaffRole(role: HumanRole): Promise<string[]> {
      // `Human.roles` is a HumanRole[] array column; Prisma's `has` compiles to
      // the Postgres `@>` containment operator, so a NULL/empty array simply
      // never matches (correct — those humans hold no role). One row per Human
      // means the ids are already distinct.
      const rows = await p.human.findMany({
        where: { roles: { has: role as PrismaHumanRole } },
        select: { id: true },
      });

      return rows.map((row) => row.id);
    },

    async listSecondFactorStaffAuthUsers(roles) {
      if (roles.length === 0) return [];
      // `hasSome` on a NULL roles column is no match, which is right: such a
      // human holds no role.
      const rows = await p.authUser.findMany({
        where: {
          humanId: { not: null },
          human: { roles: { hasSome: roles as PrismaHumanRole[] } },
          OR: [{ twoFactorEnabled: true }, { passkeys: { some: {} } }],
        },
        select: {
          id: true,
          humanId: true,
          _count: { select: { sessions: true } },
        },
      });
      return rows.map((row) => ({
        humanId: row.humanId as string,
        authUserId: row.id,
        sessionCount: row._count.sessions,
      }));
    },

    async grantHumanRole({ humanId, role }): Promise<{ granted: boolean }> {
      // Idempotent + atomic — and, critically, NULL-safe. Human.roles rows
      // written before the 20260702120000_human_roles_not_null_default
      // migration (or in any environment where it hasn't run yet) store SQL
      // NULL, and Postgres array operators return NULL (not TRUE) against a
      // NULL array: the previous Prisma guard `NOT: { roles: { has: role } }`
      // compiled to `NOT ("roles" @> ARRAY[role])`, which never matches a
      // NULL column — the grant silently no-opped for every real user.
      // COALESCE both sides so NULL behaves like the empty array.
      //
      // The contains-guard lives in the SAME statement as the append, so two
      // concurrent grants serialize on the row lock and the loser re-evaluates
      // the guard against the winner's committed row (READ COMMITTED) — no
      // duplicate append, no read-modify-write race. A missing human is a
      // zero-row match — callers verify the human exists before granting,
      // then use `granted` to distinguish "appended now" from "already held".
      //
      // `role` comes from the typed HumanRole union, but it is still passed
      // as a bind parameter (tagged $executeRaw), never interpolated.
      const prismaRole = role as PrismaHumanRole;
      const count = await p.$executeRaw`
        UPDATE "Human"
        SET "roles" = COALESCE("roles", '{}') || ARRAY[${prismaRole}::"HumanRole"]
        WHERE "id" = ${humanId}
          AND NOT (COALESCE("roles", '{}') @> ARRAY[${prismaRole}::"HumanRole"])
      `;
      return { granted: count > 0 };
    },

    async revokeHumanRole({ humanId, role }): Promise<{ revoked: boolean }> {
      // Mirrors grantHumanRole: race-safe (the WHERE containment guard and the
      // array_remove live in the same statement, so concurrent grant/revoke
      // calls against the same row serialize on the row lock — READ COMMITTED
      // re-evaluates the guard for the loser, no lost updates) and NULL-safe
      // (COALESCE treats a legacy NULL roles column as the empty array).
      //
      // `role` is bound via tagged $executeRaw, never interpolated.
      const prismaRole = role as PrismaHumanRole;
      const count = await p.$executeRaw`
        UPDATE "Human"
        SET "roles" = array_remove(COALESCE("roles", '{}'), ${prismaRole}::"HumanRole")
        WHERE "id" = ${humanId}
          AND COALESCE("roles", '{}') @> ARRAY[${prismaRole}::"HumanRole"]
      `;
      return { revoked: count > 0 };
    },

    async lockAdminRoleGuard(): Promise<void> {
      // Transaction-scoped advisory lock — see the port doc comment
      // (`packages/ports/src/repos/authz.ts`) for why this closes the
      // concurrent-revoke-on-different-targets race that a row lock can't.
      // `hashtext` deterministically maps the fixed key string to a single
      // bigint-compatible lock id; every caller contends on that same id
      // regardless of which human they're revoking. No user input reaches
      // this query — the key is a hardcoded literal, nothing to bind.
      //
      // Deliberately `$executeRaw`, not `$queryRaw`: this runs under the
      // driver-adapter ("client" engine) mode used everywhere in this repo
      // (`@prisma/adapter-pg`), and `pg_advisory_xact_lock` returns Postgres
      // `void` — a type the driver adapter's `$queryRaw` result decoder
      // can't deserialize (`DriverAdapterError: UnsupportedNativeDataType`,
      // confirmed against a real container). `$executeRaw` never attempts to
      // decode column values (it only reports a row count), so it works.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform_admin_role_guard'))`;
    },

    async getEventOrgId(eventId: string): Promise<string | null> {
      const event = await p.event.findUnique({
        where: { id: eventId },
        select: { orgId: true },
      });

      return event?.orgId ?? null;
    },

    async getEventHumanId(eventId: string): Promise<string | null> {
      const event = await p.event.findUnique({
        where: { id: eventId },
        select: { humanId: true },
      });

      return event?.humanId ?? null;
    },

    async getPlaceAccessContext(
      placeId: string,
    ): Promise<PlaceAccessContext | null> {
      const place = await p.place.findUnique({
        where: { id: placeId },
        select: { id: true },
      });

      if (!place) {
        return null;
      }

      const ownerships = await p.placeOwnership.findMany({
        // revokedAt:null defensively — a soft-revoked claim must never grant
        // access. Safe today (revokeOwnership also clears verified) but explicit
        // here so the two invariants can't drift apart.
        where: { placeId, verified: true, revokedAt: null },
        select: { ownerType: true, ownerId: true },
      });

      const verifiedHumanOwnerIds = ownerships
        .filter((ownership) => ownership.ownerType === "HUMAN")
        .map((ownership) => ownership.ownerId);

      const owningOrgIds = ownerships
        .filter((ownership) => ownership.ownerType === "ORGANIZATION")
        .map((ownership) => ownership.ownerId);

      return {
        placeId,
        verifiedHumanOwnerIds,
        owningOrgIds,
      };
    },

    async isPlaceVerifiedForOrg({ placeId, orgId }): Promise<boolean> {
      const ownership = await p.placeOwnership.findFirst({
        where: {
          placeId,
          ownerType: "ORGANIZATION",
          ownerId: orgId,
          verified: true,
          revokedAt: null,
        },
        select: { id: true },
      });

      return Boolean(ownership);
    },

    async getHumanDelegation({
      principalId,
      delegateId,
    }): Promise<OrgMembership | null> {
      const delegation = await p.humanDelegate.findUnique({
        where: { principalId_delegateId: { principalId, delegateId } },
        select: { role: true },
      });

      if (!delegation) return null;

      // Return in the same shape as OrgMembership so the authz adapter can reuse role checks.
      // orgId is set to the principalId for consistency in role-comparison logic.
      return {
        orgId: principalId,
        humanId: delegateId,
        role: delegation.role as OrgMembership["role"],
      };
    },
  };
}
