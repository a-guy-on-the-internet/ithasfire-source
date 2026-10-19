import type { ClockPort } from "@th/ports/clock";
import type { DelayedJobSchedulerPort } from "@th/ports/delayed-jobs";
import type {
  TaxRateFillQueuePort,
  TaxRateFillTarget,
} from "@th/ports/tax-rate-fill-queue";

/** The jobs-service job that fills one venue's tax-rate cache. */
export const TAX_RATE_FILL_JOB = "tax.fill-location-rate";

/**
 * One request per venue per slot of this width, across every process (the
 * slot is in the Cloud Tasks task name, which is refused while a task of that
 * name exists or ran within ~1h). A venue whose lookup keeps failing, or that
 * the provider has no rate for, is therefore asked about at most twice an
 * hour however many listings show it.
 */
export const TAX_RATE_FILL_SLOT_MS = 30 * 60_000;

/** Delay before the job runs: soon, but after the listing's response. */
const TAX_RATE_FILL_DELAY_MS = 5_000;

/**
 * Upper bound on one scheduler call. It sits on a listing request (awaited
 * before the response); a timeout rejects, and the listing reports it and
 * carries on.
 */
const TAX_RATE_FILL_SCHEDULE_TIMEOUT_MS = 1_000;

/** Payload of {@link TAX_RATE_FILL_JOB}. */
export type TaxRateFillJobPayload = { target: TaxRateFillTarget };

function targetKey(target: TaxRateFillTarget): string {
  return target.kind === "place"
    ? `place-${target.placeId}`
    : `saved-${target.savedLocationId}`;
}

/**
 * {@link TaxRateFillQueuePort} on the delayed-job scheduler (Cloud Tasks).
 *
 * Two layers of dedupe, so a hot listing page does not turn into a stream of
 * Cloud Tasks API calls:
 *  - in THIS process, a venue requested within the current slot is skipped
 *    without a network call;
 *  - across processes, the dedupe key names the venue and the slot, so a
 *    second create for it is refused (`duplicate`).
 *
 * A failed or timed-out schedule rejects (after trying every target), and the
 * venue is NOT remembered, so the next listing asks again.
 */
export function createTaxRateFillQueue(options: {
  scheduler: DelayedJobSchedulerPort;
  clock: ClockPort;
  /** Default {@link TAX_RATE_FILL_SLOT_MS}. */
  slotMs?: number;
}): TaxRateFillQueuePort {
  const slotMs = options.slotMs ?? TAX_RATE_FILL_SLOT_MS;
  /** venue key → the slot this process last scheduled it in. */
  const requestedInSlot = new Map<string, number>();

  return {
    async request(targets) {
      const now = options.clock.now().getTime();
      const slot = Math.floor(now / slotMs);
      const due = new Map<string, TaxRateFillTarget>();
      for (const target of targets) {
        const key = targetKey(target);
        if (requestedInSlot.get(key) === slot) continue;
        due.set(key, target);
      }
      if (due.size === 0) return;

      // Bound the in-process memo: an old slot's entries are dead weight.
      if (requestedInSlot.size > 10_000) {
        for (const [key, s] of requestedInSlot) {
          if (s !== slot) requestedInSlot.delete(key);
        }
      }

      const failures: unknown[] = [];
      await Promise.all(
        [...due].map(async ([key, target]) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              options.scheduler.scheduleOnce({
                jobName: TAX_RATE_FILL_JOB,
                payload: { target } satisfies TaxRateFillJobPayload,
                runAt: new Date(now + TAX_RATE_FILL_DELAY_MS),
                dedupeKey: `tax-fill-${key}-${slot}`,
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `taxRateFillQueue: scheduler did not answer within ${TAX_RATE_FILL_SCHEDULE_TIMEOUT_MS}ms`,
                      ),
                    ),
                  TAX_RATE_FILL_SCHEDULE_TIMEOUT_MS,
                );
              }),
            ]);
            requestedInSlot.set(key, slot);
          } catch (err) {
            failures.push(err);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
      if (failures.length > 0) throw failures[0];
    },
  };
}
