import type { Repos } from "@th/ports/repos";

/**
 * Ban that sticks: is this ask's owner withheld from the public? ORG asks
 * check the org (every OWNER banned), HUMAN asks the human (BANNED), both
 * through `bans.findBannedOwners`. EVENT asks check the event's owning human
 * or org through the event read's derived owner standing
 * (`events.getById(id, { withOwnerStanding: true })`, the same rule as
 * `ensureEventOpenToPublic`): an EVENT ask can hold ask-owned roles with no
 * `eventId`, whose signups never touch the event path. A missing event has
 * no owner to withhold (as in `findWithheldAskIds`). PLACE asks stay out of
 * scope.
 *
 * Every public ask surface (the ask page, its schedule, its waiver, and the
 * signup submit) calls this and answers a withheld owner's ask exactly like
 * a missing one, so the reads never show an ask the submit then refuses.
 *
 * The self-serve shift claim is the exception: its caller is already
 * accepted on the ask, so it refuses a NEW claim with the distinct
 * `SHIFT_SIGNUPS_PAUSED` and keeps every claim already held (owner ruling
 * 2026-10-07, `claimOccurrence`). Staff bringing a NEW volunteer on
 * (`assignOccurrenceClaim`, approving in `reviewVolunteerSignup`) get
 * `VOLUNTEER_APPROVALS_PAUSED` instead (owner ruling 2026-10-08).
 */
export async function isAskOwnerWithheld(
  tx: Pick<Repos, "bans" | "events">,
  ask: { subjectType: string; subjectId: string },
): Promise<boolean> {
  if (ask.subjectType === "EVENT") {
    const event = await tx.events.getById(ask.subjectId, {
      withOwnerStanding: true,
    });
    return event?.ownerBanned === true;
  }
  if (ask.subjectType !== "ORG" && ask.subjectType !== "HUMAN") return false;
  const banned = await tx.bans.findBannedOwners(
    ask.subjectType === "ORG"
      ? { humanIds: [], orgIds: [ask.subjectId] }
      : { humanIds: [ask.subjectId], orgIds: [] },
  );
  return banned.orgIds.length > 0 || banned.humanIds.length > 0;
}

/**
 * Batched form of `isAskOwnerWithheld` for list reads: the ids of every
 * given ask whose owner is withheld, from ONE `bans.findBannedOwners` call
 * however many asks there are. ORG and HUMAN asks check their subject; an
 * EVENT ask checks the event's owning human or org (`eventOwner`, from
 * `listAskOwnersByIds`), the same rule as `ensureEventOpenToPublic`. No
 * owners to check = no bans call at all.
 */
export async function findWithheldAskIds(
  tx: Pick<Repos, "bans">,
  asks: ReadonlyArray<{
    id: string;
    subjectType: string;
    subjectId: string;
    eventOwner?: { humanId: string | null; orgId: string | null } | null;
  }>,
): Promise<Set<string>> {
  const ownersOf = (ask: (typeof asks)[number]) => {
    if (ask.subjectType === "ORG") return { humanId: null, orgId: ask.subjectId };
    if (ask.subjectType === "HUMAN")
      return { humanId: ask.subjectId, orgId: null };
    if (ask.subjectType === "EVENT" && ask.eventOwner) return ask.eventOwner;
    return { humanId: null, orgId: null };
  };
  const humanIds = new Set<string>();
  const orgIds = new Set<string>();
  for (const ask of asks) {
    const o = ownersOf(ask);
    if (o.humanId) humanIds.add(o.humanId);
    if (o.orgId) orgIds.add(o.orgId);
  }
  if (humanIds.size === 0 && orgIds.size === 0) return new Set();

  const banned = await tx.bans.findBannedOwners({
    humanIds: [...humanIds],
    orgIds: [...orgIds],
  });
  const bannedHumans = new Set(banned.humanIds);
  const bannedOrgs = new Set(banned.orgIds);
  const withheld = new Set<string>();
  for (const ask of asks) {
    const o = ownersOf(ask);
    if (
      (o.humanId && bannedHumans.has(o.humanId)) ||
      (o.orgId && bannedOrgs.has(o.orgId))
    ) {
      withheld.add(ask.id);
    }
  }
  return withheld;
}
