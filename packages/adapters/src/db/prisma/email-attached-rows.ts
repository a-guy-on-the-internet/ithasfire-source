/**
 * The one definition of "rows attached to a Human BY EMAIL" (B2, account
 * squatting through guest checkout, owner ruling 2026-10-16).
 *
 * Every path that resolves a Human from a typed address and writes a row onto
 * an EXISTING Human: orders (`buyerHumanId`), their tickets
 * (`ownerHumanId`), coordinator seats (`VolunteerGroup.coordinatorHumanId`)
 * and lineup links (`EventHuman.humanId`). The reasoning, and what is
 * deliberately excluded, is in `apps/api/src/auth/unproven-email-move.ts`.
 * A new email-resolved attach path must add its table here.
 *
 * Used by:
 *   - the email-change refusal (`apps/api/src/auth/unproven-email-move.ts`);
 *   - `HumansRepo.holdsEmailAttachedRows`, which backs the force-verify
 *     refusal (`adminForceVerifyEmail`).
 *
 * The parameter is structural (not `PrismaClientOrTx`) so the api's unit tests
 * can pass a fake. Lookup errors propagate: callers fail closed.
 */
export type EmailAttachedRowsDb = {
  order: {
    findFirst(args: {
      where: { buyerHumanId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  ticket: {
    findFirst(args: {
      where: { ownerHumanId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  volunteerGroup: {
    findFirst(args: {
      where: { coordinatorHumanId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  eventHuman: {
    findFirst(args: {
      where: { humanId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

export async function holdsEmailAttachedRowsInDb(
  db: EmailAttachedRowsDb,
  humanId: string,
): Promise<boolean> {
  const found = await Promise.all([
    db.order.findFirst({
      where: { buyerHumanId: humanId },
      select: { id: true },
    }),
    db.ticket.findFirst({
      where: { ownerHumanId: humanId },
      select: { id: true },
    }),
    db.volunteerGroup.findFirst({
      where: { coordinatorHumanId: humanId },
      select: { id: true },
    }),
    db.eventHuman.findFirst({
      where: { humanId },
      select: { id: true },
    }),
  ]);
  return found.some((row) => row !== null);
}

/** The batched form's structural DB type (distinct `findMany` per table). */
export type EmailAttachedRowsBatchDb = {
  order: { findMany(args: BatchArgs<"buyerHumanId">): Promise<Array<{ buyerHumanId: string | null }>> };
  ticket: { findMany(args: BatchArgs<"ownerHumanId">): Promise<Array<{ ownerHumanId: string | null }>> };
  volunteerGroup: { findMany(args: BatchArgs<"coordinatorHumanId">): Promise<Array<{ coordinatorHumanId: string | null }>> };
  eventHuman: { findMany(args: BatchArgs<"humanId">): Promise<Array<{ humanId: string | null }>> };
};

type BatchArgs<C extends string> = {
  where: { [K in C]: { in: string[] } };
  select: { [K in C]: true };
  distinct: [C];
};

/**
 * Of `humanIds`, those holding at least one row from the same four tables as
 * `holdsEmailAttachedRowsInDb`: 4 queries total, however many ids.
 */
export async function listHumanIdsHoldingEmailAttachedRowsInDb(
  db: EmailAttachedRowsBatchDb,
  humanIds: string[],
): Promise<string[]> {
  if (humanIds.length === 0) return [];
  const ids = [...new Set(humanIds)];
  const [orders, tickets, groups, lineups] = await Promise.all([
    db.order.findMany({
      where: { buyerHumanId: { in: ids } },
      select: { buyerHumanId: true },
      distinct: ["buyerHumanId"],
    }),
    db.ticket.findMany({
      where: { ownerHumanId: { in: ids } },
      select: { ownerHumanId: true },
      distinct: ["ownerHumanId"],
    }),
    db.volunteerGroup.findMany({
      where: { coordinatorHumanId: { in: ids } },
      select: { coordinatorHumanId: true },
      distinct: ["coordinatorHumanId"],
    }),
    db.eventHuman.findMany({
      where: { humanId: { in: ids } },
      select: { humanId: true },
      distinct: ["humanId"],
    }),
  ]);
  const holding = new Set<string>();
  for (const r of orders) if (r.buyerHumanId) holding.add(r.buyerHumanId);
  for (const r of tickets) if (r.ownerHumanId) holding.add(r.ownerHumanId);
  for (const r of groups) if (r.coordinatorHumanId) holding.add(r.coordinatorHumanId);
  for (const r of lineups) if (r.humanId) holding.add(r.humanId);
  return [...holding];
}
