import type {
  EventInviteOptOutOwner,
  EventInviteOptOutsRepo,
} from "@th/ports/repos/event-invite-opt-outs";

import type { PrismaClientOrTx } from "./types";

function ownerColumns(owner: EventInviteOptOutOwner): {
  orgId: string | null;
  humanOwnerId: string | null;
} {
  return owner.kind === "ORG"
    ? { orgId: owner.orgId, humanOwnerId: null }
    : { orgId: null, humanOwnerId: owner.humanId };
}

/** The "Stop all event invites" row: no owner at all. */
const ALL_ORGANISERS = { orgId: null, humanOwnerId: null } as const;

/**
 * Rows that bar `owner`'s invites: its own opt-outs plus the ownerless
 * "Stop all event invites" ones. Each OR arm matches one partial unique
 * index (per-owner, and `EventInviteOptOut_all_email_key`), so this stays
 * one indexed query. A null owner matches the ownerless rows only.
 */
function barringOwner(owner: EventInviteOptOutOwner | null) {
  if (!owner) return ALL_ORGANISERS;
  const own =
    owner.kind === "ORG"
      ? { orgId: owner.orgId }
      : { humanOwnerId: owner.humanId };
  return { OR: [own, ALL_ORGANISERS] };
}

/**
 * Invite opt-outs, keyed by the address's keyed hash (core computes it;
 * this repo never sees an address). The uniques are SQL-only partial
 * indexes (migrations 20261005200000_event_invite_optout_and_removal,
 * 20261006090000_event_invite_optout_email_hash and
 * 20261007150000_event_invite_optout_all), so the inserts rely on
 * `createMany({ skipDuplicates })`, which Prisma emits as
 * `INSERT … ON CONFLICT DO NOTHING` with no conflict target: any unique
 * index, partial ones included, turns a repeat into a no-op, and the
 * returned count says whether the row was new.
 */
export function makeEventInviteOptOutsRepo(
  prisma: PrismaClientOrTx,
): EventInviteOptOutsRepo {
  return {
    async add(input) {
      const { count } = await prisma.eventInviteOptOut.createMany({
        data: [{ emailHash: input.emailHash, ...ownerColumns(input.owner) }],
        skipDuplicates: true,
      });
      return { created: count > 0 };
    },

    async addForAllOrganisers(input) {
      const { count } = await prisma.eventInviteOptOut.createMany({
        data: [{ emailHash: input.emailHash, ...ALL_ORGANISERS }],
        skipDuplicates: true,
      });
      return { created: count > 0 };
    },

    async standing(input) {
      if (input.emailHash.length === 0) return null;
      const rows = await prisma.eventInviteOptOut.findMany({
        where: { emailHash: input.emailHash, ...barringOwner(input.owner) },
        select: { orgId: true, humanOwnerId: true },
        take: 2,
      });
      if (rows.length === 0) return null;
      return rows.some((r) => r.orgId === null && r.humanOwnerId === null)
        ? "ALL"
        : "ORGANISER";
    },

    async listOptedOut(input) {
      const hashes = [...new Set(input.emailHashes)].filter(
        (h) => h.length > 0,
      );
      if (hashes.length === 0) return new Set<string>();
      const rows = await prisma.eventInviteOptOut.findMany({
        where: { emailHash: { in: hashes }, ...barringOwner(input.owner) },
        select: { emailHash: true },
      });
      return new Set(rows.map((r) => r.emailHash));
    },
  };
}
