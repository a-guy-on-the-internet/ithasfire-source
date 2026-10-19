import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  VolunteerGroupWithRosterInfoRecord,
  VolunteerRewardGrantStatus,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { listCoordinatorRosterInputSchema } from "./schemas";
import { ensureCoordinatorEmailVerified } from "./_shared/require-coordinator-or-owner";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ListCoordinatorRosterDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * A coordinator-visible signup row: the full signup plus the COORDINATOR-SAFE
 * reward status (FR-006). `rewardStatus` is the bare grant enum
 * (`GRANTED | REDEEMED | REVOKED`), present only when this signup has a grant —
 * never any money field (face value / comp order / budget), per NFR-003. Absent
 * when the signup has no grant.
 */
export type CoordinatorRosterSignup = VolunteerSignupRecord & {
  rewardStatus?: VolunteerRewardGrantStatus;
};

export type CoordinatorRosterGroup = VolunteerGroupWithRosterInfoRecord & {
  /**
   * The group's signups in this page's window, contact details + reward
   * status included (FR-006). A group whose members span a page boundary
   * reappears on the next page carrying the continuation — clients merge
   * pages by group id, concatenating `signups`.
   */
  signups: CoordinatorRosterSignup[];
};

export type ListCoordinatorRosterOutput = {
  groups: CoordinatorRosterGroup[];
  /** Opaque continuation cursor over the groups' members. Null = exhausted. */
  nextCursor: string | null;
};

// ── Roster cursor ───────────────────────────────────────────────────────────
//
// The coordinator roster paginates SEQUENTIALLY across the actor's groups
// (deterministic group order, then each group's members on the adapter's
// (createdAt desc, id desc) keyset). The compound cursor is
// `<groupId>` (resume at the top of that group) or
// `<groupId>|<adapter signup cursor>` (resume inside it). The signup half
// stays opaque — it is minted and consumed only by the adapter; core just
// prefixes the group id. Group ids are uuids, so splitting on the FIRST `|`
// is unambiguous even though the adapter cursor contains `|` itself.

function encodeRosterCursor(groupId: string, signupCursor: string | null): string {
  return signupCursor ? `${groupId}|${signupCursor}` : groupId;
}

function decodeRosterCursor(cursor: string): {
  groupId: string;
  signupCursor: string | null;
} {
  const sep = cursor.indexOf("|");
  if (sep === -1) {
    return { groupId: cursor, signupCursor: null };
  }
  return {
    groupId: cursor.slice(0, sep),
    signupCursor: cursor.slice(sep + 1) || null,
  };
}

/**
 * Coordinator view (FR-006, NFR-003): ONLY the group(s) the actor
 * coordinates on this ask, with each group's signups and contact details —
 * one cursor page of members at a time (sequential across groups).
 *
 * PII containment is structural, not filtered: every signup read goes
 * through `listSignupsByAskCursor(askId, { groupId: <own group id> })` — the
 * group-scoped repo primitive — so no broader read ever holds another
 * group's rows in memory. The only unscoped read is `listGroupsByAsk`,
 * which returns group METADATA (names, counts, coordinators), not
 * volunteer PII, and is needed to find the actor's seat.
 *
 * A cursor naming a group the actor no longer coordinates (stale bookmark,
 * reassignment mid-scroll) restarts from page 1 rather than erroring or
 * leaking — same defensive posture as the adapter's malformed-cursor decode.
 *
 * COORDINATOR-ONLY: owners have `listAskRoster`; an actor coordinating no
 * group on the ask gets `forbidden` (never an empty roster — an empty list
 * would double as an "ask exists and you're not on it" probe with a 200).
 */
export async function listCoordinatorRoster(
  deps: ListCoordinatorRosterDeps,
  rawInput: unknown,
): Promise<ListCoordinatorRosterOutput> {
  const input = parseInput(listCoordinatorRosterInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    const allGroups = await tx.volunteering.listGroupsByAsk(ask.id);
    const ownGroups = allGroups
      .filter((group) => group.coordinatorHumanId === input.actorHumanId)
      // listGroupsByAsk orders createdAt asc; add the id tiebreak so the
      // cross-page group walk is fully deterministic even on equal
      // timestamps (no group skipped or visited twice).
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    if (ownGroups.length === 0) {
      throw fail("FORBIDDEN", { message: "not_a_coordinator" });
    }
    // The roster is volunteer contact data: an unverified seat sees none of
    // it until the account proves the inbox (B2).
    await ensureCoordinatorEmailVerified(tx, input.actorHumanId);

    // Resolve the resume point. An unknown groupId (stale/invalid cursor)
    // restarts from the first group — never an error, never a leak.
    let startIdx = 0;
    let startSignupCursor: string | null = null;
    if (input.cursor) {
      const decoded = decodeRosterCursor(input.cursor);
      const idx = ownGroups.findIndex((g) => g.id === decoded.groupId);
      if (idx >= 0) {
        startIdx = idx;
        startSignupCursor = decoded.signupCursor;
      }
    }

    const groups: {
      group: VolunteerGroupWithRosterInfoRecord;
      signups: VolunteerSignupRecord[];
    }[] = [];
    let remaining = input.limit;
    let nextCursor: string | null = null;

    for (let i = startIdx; i < ownGroups.length; i++) {
      const group = ownGroups[i];
      // Loop bound guarantees this index is populated; the guard narrows the
      // `noUncheckedIndexedAccess` `| undefined` for the rest of the body.
      if (!group) continue;
      // Group-scoped primitive ONLY (NFR-003) — never a broader signup
      // read filtered in memory.
      const page = await tx.volunteering.listSignupsByAskCursor(ask.id, {
        groupId: group.id,
        cursor: i === startIdx ? startSignupCursor : null,
        limit: remaining,
      });
      groups.push({ group, signups: page.items });
      remaining -= page.items.length;

      if (page.nextCursor) {
        // This group still has members — resume inside it.
        nextCursor = encodeRosterCursor(group.id, page.nextCursor);
        break;
      }
      if (remaining <= 0) {
        // Page filled exactly at a group boundary — resume at the NEXT
        // group's top, if one exists.
        const next = ownGroups[i + 1];
        if (next) nextCursor = encodeRosterCursor(next.id, null);
        break;
      }
    }

    // Reward STATUS enrichment (FR-006): one batched, coordinator-safe read
    // over EXACTLY the signup ids already in this coordinator's authorized
    // result set — never a broader query. The primitive returns the bare
    // status enum only (no money), so NFR-003 holds: the coordinator sees
    // their own group's rows, now each optionally carrying a reward badge.
    const signupIds = groups.flatMap(({ signups }) => signups.map((s) => s.id));
    const statusRows =
      signupIds.length > 0
        ? await tx.volunteering.listRewardGrantStatusesBySignupIds(signupIds)
        : [];
    const statusBySignupId = new Map<string, VolunteerRewardGrantStatus>(
      statusRows.map((row) => [row.signupId, row.status]),
    );

    return {
      groups: groups.map(({ group, signups }) => ({
        ...group,
        signups: signups.map((signup): CoordinatorRosterSignup => {
          const rewardStatus = statusBySignupId.get(signup.id);
          return rewardStatus ? { ...signup, rewardStatus } : signup;
        }),
      })),
      nextCursor,
    };
  });
}
