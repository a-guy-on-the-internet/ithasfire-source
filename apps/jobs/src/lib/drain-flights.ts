import {
  DRAIN_TRIGGERS,
  isTriggeredJobName,
  type TriggeredJobName,
} from "@th/ports/job-trigger";

/**
 * Per-instance single-flight for write-triggered drains.
 *
 * Every committed outbox write publishes a wake-up, so a burst of RSVPs is a
 * burst of Pub/Sub pushes. Without this each push would start its own drain
 * run: N concurrent runs listing the same rows, each also paying the run
 * tracker's enabled check and JobRun insert. Instead:
 *
 *   - the first request for a drain registers a flight and runs;
 *   - a WAKE-UP that arrives while that flight is open is acked immediately
 *     (Pub/Sub is done with it) and only sets `rerun`;
 *   - when the running handler returns, it runs once more if `rerun` was set,
 *     with the wake-up payload, and repeats until no wake-up arrived during
 *     the last pass (capped).
 *
 * That trailing rerun is what makes acking early safe: a row committed after
 * the running pass's last fetch is picked up by the rerun, in the same request.
 *
 * Scope is ONE instance. Cloud Run may route a wake-up to a second instance,
 * which then runs its own flight; that costs a duplicate empty pass, nothing
 * worse — the drains are safe under overlap (idempotent notify keys,
 * compare-and-set status writes).
 *
 * Only exact wake-up payloads coalesce. A scheduled or manual run with a
 * different body always runs: the safety net sends `{"origin":"schedule"}`
 * (manifest `payload`, required by validate-manifest §7) precisely so it never
 * matches a wake-up — not even the image-moderation drain's `{}` — and folding
 * it into a `freshOnly` rerun would skip the retries it exists for.
 */

/** Follow-up passes one request may run before handing off to a fresh one. */
export const MAX_COALESCED_RERUNS = 5;

/**
 * No follow-up STARTS after the flight has been working this long; the caller
 * hands off instead. One drain pass-loop is budgeted at 120s
 * (packages/core/src/lib/drain-loop.ts), so the last follow-up ends by ~270s,
 * inside Cloud Run's 300s request timeout and the push subscription's 300s
 * ack deadline.
 */
export const MAX_FLIGHT_WORK_MS = 150_000;

/**
 * A flight older than this is treated as dead. Longer than any request can
 * live (Cloud Run's 300s timeout; one drain pass-loop is budgeted at 120s),
 * so it only matters if a release was somehow missed — and then it bounds
 * how long wake-ups could be acked without a run behind them.
 */
export const MAX_FLIGHT_AGE_MS = 6 * 60_000;

export type DrainFlight = { rerun: boolean; startedAt: number };

export class DrainFlights {
  private readonly flights = new Map<string, DrainFlight>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * If a live flight for `name` is open, mark it for a rerun and return true
   * (the caller acks without running). Synchronous: no await between the check
   * and the mark, so it cannot race another request on this instance. Callers
   * must `begin` in the same synchronous step when this returns false.
   */
  coalesce(name: string): boolean {
    const flight = this.flights.get(name);
    if (!flight) return false;
    if (this.now() - flight.startedAt > MAX_FLIGHT_AGE_MS) {
      this.flights.delete(name);
      return false;
    }
    flight.rerun = true;
    return true;
  }

  /** Open a flight for `name`, replacing any previous one (see `end`). */
  begin(name: string): DrainFlight {
    const flight: DrainFlight = { rerun: false, startedAt: this.now() };
    this.flights.set(name, flight);
    return flight;
  }

  /**
   * Close `flight`. Identity-checked: a non-wake-up run (a scheduled or manual
   * one, which never coalesces) `begin`s over an open flight, and whichever
   * finishes first must not close the other's.
   */
  end(name: string, flight: DrainFlight): void {
    if (this.flights.get(name) === flight) this.flights.delete(name);
  }

  isOpen(name: string): boolean {
    return this.flights.has(name);
  }

  /**
   * Run the coalesced follow-up passes. `capped` is true when wake-ups were
   * still arriving at the cap, i.e. the caller should hand off.
   */
  async drainReruns(
    name: TriggeredJobName,
    flight: DrainFlight,
    run: (payload: unknown) => Promise<unknown>,
  ): Promise<{ results: unknown[]; capped: boolean }> {
    const results: unknown[] = [];
    while (flight.rerun) {
      if (
        results.length >= MAX_COALESCED_RERUNS ||
        this.now() - flight.startedAt >= MAX_FLIGHT_WORK_MS
      ) {
        return { results, capped: true };
      }
      flight.rerun = false;
      results.push(await run(DRAIN_TRIGGERS[name].payload));
    }
    return { results, capped: false };
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

function normalise(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = normalise((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** True when `body` is exactly the wake-up payload `name`'s trigger sends. */
export function isDrainWakeUp(name: string, body: unknown): boolean {
  if (!isTriggeredJobName(name)) return false;
  return sameJson(body ?? {}, DRAIN_TRIGGERS[name].payload);
}

/** Reads the drain-loop `hasMore` flag off a handler result, if present. */
export function resultHasMore(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { hasMore?: unknown }).hasMore === true
  );
}
