/**
 * Freeze the deal on every live published event (docs/specs/2026-10-14/
 * freeze-the-deal.spec.yaml, FR-009).
 *
 * From the freeze on, an event's whole deal is frozen on first publish. Events
 * published BEFORE that landed have `dealFrozenAt = null`; this sets it for the
 * ones still in play: status PUBLISHED, `publishedAt` set, `endsAt` in the
 * future, `dealFrozenAt` null. `dealFrozenByHumanId` stays null (frozen
 * automatically). NO notices go out (F2). Past events are left alone.
 *
 * Each event is frozen through the same core function publish uses
 * (`freezeEventDealOnLockedRow`): event row lock, terms row locks, then the
 * guarded UPDATE "only while dealFrozenAt IS NULL", plus one `event.deal_frozen`
 * audit row with `source: "BACKFILL"`, all in ONE transaction per event. A
 * failure on one event is counted and does not stop the run.
 *
 * DRY RUN BY DEFAULT: prints the count and the first 20 ids/titles, writes
 * nothing. `--apply` writes. IDEMPOTENT: the selection excludes frozen events,
 * and a freeze that lands between selection and write is counted "already
 * frozen", never overwritten.
 *
 * Runs after the migration on each environment; the prod run is the owner's call.
 *
 * Usage (from the repo root; `DATABASE_URL` is REQUIRED and never read from a
 * .env file, so the target database is always a deliberate choice):
 *
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:freeze-deals
 *   DATABASE_URL=postgresql://... pnpm -F api backfill:freeze-deals --apply
 */
import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { freezeEventDealOnLockedRow } from "@th/core/use-cases/deals/_shared/deal-freeze";
import type { Repos } from "@th/ports/repos";

const SAMPLE_SIZE = 20;

/** The selection, as a Prisma `where`. Pure, so the test pins it. */
export function freezeCandidateWhere(now: Date) {
  return {
    status: "PUBLISHED" as const,
    publishedAt: { not: null },
    endsAt: { gt: now },
    dealFrozenAt: null,
  };
}

export type FreezeOutcome = "frozen" | "already-frozen" | "skipped" | "failed";

export type FreezeSummary = Record<
  "frozen" | "alreadyFrozen" | "skipped" | "failed",
  number
>;

/**
 * Freeze one event in its own transaction. "skipped" = no longer eligible when
 * re-read under the row lock (unpublished or ended since selection, or gone).
 */
export async function freezeOneEvent(
  repos: Pick<Repos, "tx">,
  eventId: string,
  now: Date,
): Promise<FreezeOutcome> {
  return repos.tx(async (tx) => {
    await tx.events.lockRows({ ids: [eventId], mode: "update" });
    const event = await tx.events.getById(eventId);
    if (!event) return "skipped";
    if (event.dealFrozenAt) return "already-frozen";
    const ended = !event.endsAt || event.endsAt.getTime() <= now.getTime();
    // The whole selection, re-checked under the row lock.
    if (event.status !== "PUBLISHED" || !event.publishedAt || ended) return "skipped";
    const state = await freezeEventDealOnLockedRow(tx, {
      eventId,
      at: now,
      frozenByHumanId: null,
      source: "BACKFILL",
      actorHumanId: null,
    });
    if (!state) return "skipped";
    return state.changed ? "frozen" : "already-frozen";
  });
}

/** Apply to a list of ids, one transaction each; a throw is counted, not fatal. */
export async function freezeEvents(
  repos: Pick<Repos, "tx">,
  eventIds: string[],
  now: Date,
  onError: (eventId: string, err: unknown) => void = () => {},
): Promise<FreezeSummary> {
  const summary: FreezeSummary = { frozen: 0, alreadyFrozen: 0, skipped: 0, failed: 0 };
  for (const id of eventIds) {
    try {
      const outcome = await freezeOneEvent(repos, id, now);
      if (outcome === "frozen") summary.frozen += 1;
      else if (outcome === "already-frozen") summary.alreadyFrozen += 1;
      else if (outcome === "skipped") summary.skipped += 1;
      else summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      onError(id, err);
    }
  }
  return summary;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set explicitly (this script never loads .env files — the target DB must be deliberate).",
    );
  }
  const apply = process.argv.includes("--apply");
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `freeze-published-deals → ${target.hostname}:${target.port || "5432"}${target.pathname}${apply ? " (APPLY)" : " (DRY RUN)"}`,
  );

  const prisma = getPrisma();
  const now = new Date();
  const where = freezeCandidateWhere(now);
  const total = await prisma.event.count({ where });
  console.log(`events to freeze: ${total}`);

  if (!apply) {
    const sample = await prisma.event.findMany({
      where,
      select: { id: true, title: true },
      orderBy: { id: "asc" },
      take: SAMPLE_SIZE,
    });
    for (const e of sample) console.log(`  would freeze: ${e.id}  ${e.title}`);
    if (total > sample.length) console.log(`  … and ${total - sample.length} more`);
    console.log("(DRY RUN — nothing written. Re-run with --apply to write.)");
    return;
  }

  const repos = createPrismaRepos(prisma);
  const summary: FreezeSummary = { frozen: 0, alreadyFrozen: 0, skipped: 0, failed: 0 };
  // Keyset pagination on id; rows leave the selection as they freeze.
  let cursor: string | null = null;
  for (;;) {
    const batch: { id: string }[] = await prisma.event.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 200,
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;
    const part = await freezeEvents(
      repos,
      batch.map((b) => b.id),
      now,
      (id, err) => console.error(`  FAILED ${id}:`, err),
    );
    summary.frozen += part.frozen;
    summary.alreadyFrozen += part.alreadyFrozen;
    summary.skipped += part.skipped;
    summary.failed += part.failed;
  }

  console.log("\nfreeze-published-deals summary:");
  console.log(`  selected:        ${total}`);
  console.log(`  frozen:          ${summary.frozen}`);
  console.log(`  already frozen:  ${summary.alreadyFrozen}`);
  console.log(`  skipped (no longer eligible): ${summary.skipped}`);
  console.log(`  failed:          ${summary.failed}`);
  if (summary.failed > 0) process.exitCode = 1;
}

// Only when run as a script, so the test can import the pure parts.
if (process.argv[1]?.endsWith("freeze-published-deals.ts")) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => getPrisma().$disconnect());
}
