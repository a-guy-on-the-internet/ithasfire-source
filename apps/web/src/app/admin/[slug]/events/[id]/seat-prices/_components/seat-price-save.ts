/**
 * Sending a seat price change and saying what happened to it.
 *
 * `events.setSeatPriceOverrides` takes at most 500 seats and answers with how
 * many it changed and how many it skipped, by cause. A bigger selection goes
 * in chunks of 500 with the counts summed. Each chunk is its own transaction
 * on the server, so when one fails the earlier ones are already saved: the
 * result has to say both halves.
 *
 * Pure apart from the `write` callback, so the chunking and every sentence
 * are unit tested without a network.
 */

/** The write's own cap on `seatIds` (set-seat-price-overrides.ts). */
export const SEAT_PRICE_WRITE_CHUNK = 500;

export type SaveCounts = {
  updated: number;
  skipped: { sold: number; held: number; busy: number; notFound: number };
};

export const emptySaveCounts = (): SaveCounts => ({
  updated: 0,
  skipped: { sold: 0, held: 0, busy: 0, notFound: 0 },
});

export function addSaveCounts(a: SaveCounts, b: SaveCounts): SaveCounts {
  return {
    updated: a.updated + b.updated,
    skipped: {
      sold: a.skipped.sold + b.skipped.sold,
      held: a.skipped.held + b.skipped.held,
      busy: a.skipped.busy + b.skipped.busy,
      notFound: a.skipped.notFound + b.skipped.notFound,
    },
  };
}

export function totalSkipped(counts: SaveCounts): number {
  const { sold, held, busy, notFound } = counts.skipped;
  return sold + held + busy + notFound;
}

export function chunkSeatIds(
  seatIds: readonly string[],
  size: number = SEAT_PRICE_WRITE_CHUNK,
): string[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunkSeatIds: size must be a positive integer, got ${size}`);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < seatIds.length; i += size) {
    chunks.push(seatIds.slice(i, i + size));
  }
  return chunks;
}

export type ChunkedSaveResult = {
  /** Summed over the chunks the server accepted. */
  counts: SaveCounts;
  /** Seats in the chunk that failed and in every chunk after it. */
  unsentSeatIds: string[];
  /** What the failed chunk threw, or `null` when every chunk was accepted. */
  error: unknown;
};

/**
 * Send the chunks one after another and stop at the first failure. A refusal
 * (wrong ticket type, payouts missing, event closed) would refuse every later
 * chunk too, and a network failure is no reason to keep hammering.
 */
export async function saveInChunks(
  seatIds: readonly string[],
  write: (chunk: string[]) => Promise<SaveCounts>,
  size: number = SEAT_PRICE_WRITE_CHUNK,
): Promise<ChunkedSaveResult> {
  const chunks = chunkSeatIds(seatIds, size);
  let counts = emptySaveCounts();
  for (let index = 0; index < chunks.length; index += 1) {
    try {
      counts = addSaveCounts(counts, await write(chunks[index]!));
    } catch (error) {
      return { counts, unsentSeatIds: chunks.slice(index).flat(), error };
    }
  }
  return { counts, unsentSeatIds: [], error: null };
}

export type SaveAction =
  | { kind: "set"; priceCents: number }
  /** "Use section price": the custom price is removed. */
  | { kind: "clear" };

export type SaveOutcome = {
  action: SaveAction;
  counts: SaveCounts;
  /** How many seats were not sent because a chunk failed. */
  unsentCount: number;
  /** The failure, already turned into a sentence (`formatErrorMessage(err, t)`). */
  errorMessage: string | null;
};

/**
 * The organizer changed the selection after a failed save, so "they are
 * still selected" is no longer true. The failure lines go; the counts of what
 * did happen ("3 set, 1 skipped: sold") stay until Dismiss. `null` when the
 * failure was all the result had to say.
 */
export function forgetUnsent(outcome: SaveOutcome): SaveOutcome | null {
  if (outcome.errorMessage === null) return outcome;
  const anythingHappened =
    outcome.counts.updated > 0 || totalSkipped(outcome.counts) > 0;
  if (!anythingHappened) return null;
  return { ...outcome, unsentCount: 0, errorMessage: null };
}

export type SaveResultView = {
  /**
   * `success` only when every seat changed. Any skip is a `warning`, any
   * failure an `error`: a skip never hides behind a plain success.
   */
  tone: "success" | "warning" | "error";
  title: string;
  /** "2 skipped: 1 sold, 1 in someone's cart." */
  skippedSummary: string | null;
  /** One line per skip cause, saying what it means for those seats. */
  details: string[];
  /** How many seats were not saved, after a partial failure. */
  failure: string | null;
  /**
   * The error itself, on its own line. Never spliced into a sentence: a
   * message may lack a final period, and a refusal ("No prices were saved.")
   * speaks only for the batch that failed.
   */
  failureReason: string | null;
};

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => unknown;

const SKIP_KINDS = [
  { kind: "sold", partKey: "admin.seatPricesSkipSold", detailKey: "admin.seatPricesSkipSoldDetail" },
  { kind: "held", partKey: "admin.seatPricesSkipHeld", detailKey: "admin.seatPricesSkipHeldDetail" },
  { kind: "busy", partKey: "admin.seatPricesSkipBusy", detailKey: "admin.seatPricesSkipBusyDetail" },
  { kind: "notFound", partKey: "admin.seatPricesSkipNotFound", detailKey: "admin.seatPricesSkipNotFoundDetail" },
] as const;

/**
 * The sentences of the save result. `formatCents` formats integer cents for
 * display (the editor passes the event's currency formatter).
 */
export function describeSaveOutcome(
  outcome: SaveOutcome,
  t: Translate,
  formatCents: (cents: number) => string,
): SaveResultView {
  const { counts, action } = outcome;
  const failed = outcome.errorMessage !== null;
  const skippedTotal = totalSkipped(counts);

  let title: string;
  if (counts.updated === 0) {
    title = String(
      t(failed ? "admin.seatPricesResultNothingSaved" : "admin.seatPricesResultNoneChanged"),
    );
  } else if (action.kind === "set") {
    title = String(
      t("admin.seatPricesResultSet", {
        count: counts.updated,
        price: formatCents(action.priceCents),
      }),
    );
  } else {
    title = String(t("admin.seatPricesResultCleared", { count: counts.updated }));
  }

  const present = SKIP_KINDS.filter(({ kind }) => counts.skipped[kind] > 0);
  const skippedSummary =
    skippedTotal > 0
      ? String(
          t("admin.seatPricesResultSkipped", {
            count: skippedTotal,
            causes: present
              .map(({ kind, partKey }) =>
                String(t(partKey, { count: counts.skipped[kind] })),
              )
              .join(", "),
          }),
        )
      : null;
  const details = present.map(({ kind, detailKey }) =>
    String(t(detailKey, { count: counts.skipped[kind] })),
  );

  // When nothing at all went through, the title already says so and the
  // reason stands alone; otherwise say how many seats are still unsaved.
  const nothingHappened = counts.updated === 0 && skippedTotal === 0;
  const failure =
    failed && !nothingHappened
      ? String(t("admin.seatPricesResultNotSaved", { count: outcome.unsentCount }))
      : null;
  const failureReason = failed
    ? String(
        t("admin.seatPricesResultReason", { reason: outcome.errorMessage ?? "" }),
      )
    : null;

  return {
    tone: failed ? "error" : skippedTotal > 0 ? "warning" : "success",
    title,
    skippedSummary,
    details,
    failure,
    failureReason,
  };
}
