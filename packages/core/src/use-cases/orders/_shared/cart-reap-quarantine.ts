/**
 * Process-lifetime memory of expired carts the reaper REFUSED to retire.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `orders.listExpiredPending` is `orderBy: occurredAt asc, take: limit`, so a
 * cart that can never be retired is by definition among the OLDEST rows and
 * sits at the head of every page forever. Without a memory of the refusal that
 * costs, per cart per pass: two Stripe round-trips, one `logger.error` and one
 * Sentry event — 48 events a day for ONE cart at the 30-minute cron period
 * (288 back when it ran every 5 minutes), which drowns the very signal the
 * report exists to raise. Worse, each such
 * cart permanently displaces a reapable one; at `limit` stuck carts the reaper
 * reaps nothing at all and every subsequent expired cart's seats, promo holds,
 * fee-waiver allowance and platform credit leak indefinitely.
 *
 * The reaper feeds `active()` into the scan's `excludeOrderIds`, so a
 * quarantined cart neither occupies a page slot nor gets probed — which is
 * also what rate-limits the report, since the report happens at probe time.
 *
 * ── Why in memory and not a column ──────────────────────────────────────────
 * A `retireRefusedAt` / attempt-counter column is a Prisma migration on the
 * money path. This is deliberately the non-schema version: state that resets
 * on deploy is acceptable here because re-probing once per process is a
 * feature, not a leak — a genuinely transient cause (Stripe outage, poisoned
 * row) gets a fresh look after every restart, and a genuinely terminal one
 * costs exactly one report per process instead of one every pass.
 *
 * ── Two flavours of refusal ─────────────────────────────────────────────────
 * - `"permanent"` — the refusal cannot resolve in this process: the PI is
 *   terminal-`succeeded` (the buyer HAS paid; that order belongs to finalize
 *   and its DLQ, never to the reaper), or there is no payment processor wired
 *   in at all (the container builds it once at boot).
 * - `"backoff"`  — the refusal might resolve: Stripe threw, the PI is still
 *   `processing`, the transaction hit a db error. Cooldown doubles per
 *   consecutive refusal from `baseCooldownSeconds` to `maxCooldownSeconds`,
 *   so a flap recovers in one period and a wedge settles at a few probes a
 *   day.
 *
 * Neither flavour is immortal: any entry that goes `forgetAfterSeconds`
 * without a fresh refusal is dropped and re-admitted for one probe. See
 * `DEFAULT_FORGET_AFTER_SECONDS`.
 */

/** Whether a refusal can resolve on its own. See the module doc. */
export type CartReapRefusalKind = "permanent" | "backoff";

export interface CartReapQuarantine {
  /**
   * Order ids that must NOT be scanned at `now`. Feed straight into
   * `listExpiredPending({ excludeOrderIds })`.
   */
  active(now: Date): string[];
  /** Record a refusal for `orderId`, extending or opening its cooldown. */
  hold(input: { orderId: string; now: Date; kind: CartReapRefusalKind }): void;
  /** Drop `orderId` — it retired, so its strike history is meaningless. */
  forget(orderId: string): void;
  /** Entries currently held, including lapsed-but-remembered ones. */
  size(): number;
}

/**
 * MUST stay clearly shorter than one reaper period (`CART_REAPER_PERIOD_SECONDS`
 * in `cart-reaper-cycle.ts`, 30 minutes), so a cart that failed ONCE is
 * re-probed on the very next tick.
 *
 * Money depends on it. A cart's tickets stay reserved for TTL + 2 periods
 * (`CAPACITY_HELD_WINDOW_SECONDS`, 80 min), and that only holds if the reaper
 * reaches an eligible cart within two ticks. The cooldown is stamped from the
 * failing pass's start; ticks drift inside their slot (cold start, then warm
 * start), so a cooldown of a full period can still be running when the next
 * tick starts a fraction of a second earlier. The cart then sits out a second
 * tick and is reaped at ~89 minutes, after its reservation lapsed while its
 * PaymentIntent could still be confirmed: one ticket sold twice. Five
 * minutes lapses long before any next tick.
 *
 * Within a pass the reaper already skips a cart it has handled (its `seen`
 * set), so the base cooldown does no work there. It only spaces out
 * re-probes across ticks, and from the second strike on it doubles (10, 20,
 * 40 min, …) up to `DEFAULT_MAX_COOLDOWN_SECONDS`, which is where a wedged
 * cart backs off. A longer base used to keep one poisoned row from stopping
 * every pass; the reaper's trouble threshold (`MIN_TROUBLE_PER_PAGE`) handles
 * that now.
 */
const DEFAULT_BASE_COOLDOWN_SECONDS = 5 * 60;
const DEFAULT_MAX_COOLDOWN_SECONDS = 6 * 60 * 60;
/**
 * An entry is dropped once it has gone this long without being re-refused —
 * at that point the cart is usually gone (finalized, cancelled by hand) and
 * its strike count is stale rather than informative.
 *
 * Applies to `permanent` entries as well as lapsed `backoff` ones. A
 * permanent entry is never re-probed, so nothing else would ever drop it, and
 * "permanent" is a claim about THIS process's ability to resolve the refusal,
 * not about the cart: a cart that pays mid-pass is quarantined permanent and
 * then finalised normally. Re-admitting after a day costs one probe and keeps
 * `quarantinedCount` an honest wedge gauge.
 */
const DEFAULT_FORGET_AFTER_SECONDS = 24 * 60 * 60;
/**
 * Hard ceiling on remembered carts. Eviction sheds `backoff` entries before
 * `permanent` ones (see `hold`), oldest-first within each: evicting only
 * means that cart gets probed sooner, which is the safe direction — the
 * refusal logic is unchanged and the cart simply re-enters quarantine.
 */
const DEFAULT_MAX_ENTRIES = 500;

type Entry = {
  /** `null` = permanent (never re-probed in this process). */
  untilMs: number | null;
  strikes: number;
  lastRefusedMs: number;
};

export function createCartReapQuarantine(options?: {
  baseCooldownSeconds?: number;
  maxCooldownSeconds?: number;
  forgetAfterSeconds?: number;
  maxEntries?: number;
}): CartReapQuarantine {
  const baseSeconds =
    options?.baseCooldownSeconds ?? DEFAULT_BASE_COOLDOWN_SECONDS;
  const maxSeconds = options?.maxCooldownSeconds ?? DEFAULT_MAX_COOLDOWN_SECONDS;
  const forgetAfterMs =
    (options?.forgetAfterSeconds ?? DEFAULT_FORGET_AFTER_SECONDS) * 1000;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const entries = new Map<string, Entry>();

  const cooldownMs = (strikes: number): number => {
    // 2^(strikes-1), clamped before the shift so a long-lived wedge cannot
    // overflow into Infinity.
    const exponent = Math.min(strikes - 1, 20);
    return Math.min(baseSeconds * 2 ** exponent, maxSeconds) * 1000;
  };

  return {
    active(now) {
      const nowMs = now.getTime();
      const held: string[] = [];

      for (const [orderId, entry] of entries) {
        const stale = nowMs - entry.lastRefusedMs > forgetAfterMs;
        const cooling = entry.untilMs !== null && entry.untilMs > nowMs;

        // The stale sweep covers PERMANENT entries too, and that is the
        // point. A `permanent` entry is never re-probed, so its
        // `lastRefusedMs` is frozen at the first refusal; when the sweep
        // lived in the lapsed branch (which `untilMs === null` never reaches)
        // such an entry was immortal. That is not only a leaked slot: an
        // order that PAYS mid-pass is scanned PENDING, refuses with
        // `succeeded`, and is quarantined permanent even though finalize
        // then completes it normally — so ordinary healthy traffic drifted
        // `quarantinedCount` upward forever, and that gauge is the only
        // wedge alarm the design leans on. Re-admitting after
        // `forgetAfterSeconds` costs one probe.
        //
        // `cooling` guards the one case that must never be re-admitted early:
        // a backoff entry whose cooldown has not lapsed (only reachable if a
        // caller sets `maxCooldownSeconds` above `forgetAfterSeconds`).
        if (stale && !cooling) {
          entries.delete(orderId);
          continue;
        }

        if (entry.untilMs === null || cooling) {
          held.push(orderId);
          continue;
        }
        // Lapsed but not stale: eligible for a probe again, and the strike
        // history is kept so the next refusal backs off further.
      }

      return held;
    },

    hold({ orderId, now, kind }) {
      const nowMs = now.getTime();
      const strikes = (entries.get(orderId)?.strikes ?? 0) + 1;

      entries.set(orderId, {
        untilMs: kind === "permanent" ? null : nowMs + cooldownMs(strikes),
        strikes,
        lastRefusedMs: nowMs,
      });

      // ── Shed `backoff` before `permanent`, oldest-first within each ──────
      //
      // Least-recently-refused ALONE is exactly backwards. A permanent entry
      // is never re-probed, so its stamp is frozen at first refusal, while a
      // backoff entry's is bumped on every re-refusal — so once the map is
      // full the minimum is ALWAYS a permanent one. A Stripe incident
      // (hundreds of backoff refusals a pass) would then evict the paid-PI
      // carts, the ones this module exists for, first: each resumes two
      // Stripe round-trips and a Sentry event every pass while displacing a
      // reapable cart at the head of an `occurredAt asc` page.
      //
      // Evicting a backoff entry only means that cart is probed sooner and
      // re-enters quarantine — the safe direction, and the transient causes
      // backoff exists for are the ones worth re-probing anyway.
      while (entries.size > maxEntries) {
        let victimId: string | null = null;
        // [rank, lastRefusedMs] — rank 0 = backoff (shed first), 1 = permanent.
        let victimRank = Number.POSITIVE_INFINITY;
        let victimMs = Number.POSITIVE_INFINITY;

        for (const [id, entry] of entries) {
          if (id === orderId) continue;
          const rank = entry.untilMs === null ? 1 : 0;
          if (
            rank < victimRank ||
            (rank === victimRank && entry.lastRefusedMs < victimMs)
          ) {
            victimId = id;
            victimRank = rank;
            victimMs = entry.lastRefusedMs;
          }
        }

        if (victimId === null) break;
        entries.delete(victimId);
      }
    },

    forget(orderId) {
      entries.delete(orderId);
    },

    size() {
      return entries.size;
    },
  };
}
