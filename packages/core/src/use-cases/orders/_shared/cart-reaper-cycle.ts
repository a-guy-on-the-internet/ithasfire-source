// ─────────────────────────────────────────────────────────────────────────────
// HOW OFTEN THE CART REAPER RUNS — the one fact about `tickets.release-expired-
// carts` that capacity accounting has to know, written down where core can
// reach it.
//
// WHY IT MATTERS FOR MONEY. A PENDING order's PaymentIntent stays confirmable
// until the reaper cancels it. The reaper only makes an order ELIGIBLE at
// `DEFAULT_CART_TTL_SECONDS`; it is REAPED on the next pass, up to one period
// later. `CAPACITY_HELD_WINDOW_SECONDS` (assert-ticket-type-capacity.ts) keeps
// that order's tickets reserved for TTL + 2 periods, so a ticket is never sold
// to someone else while the first buyer's charge can still land. If the
// reaper runs LESS often than this constant says, that window lapses before
// the charge dies and the same ticket can be sold twice.
//
// That is not hypothetical. Until 2026-09-30 this constant said 5 minutes
// while prod.tfvars overrode the job to every 15: the reservation lapsed at
// 30 minutes but a PaymentIntent could stay confirmable for 35+. The period
// then became 15 minutes everywhere and the prod override went away.
//
// On 2026-10-08 the owner moved every */15 cron to */30 so the Neon database
// can sleep between slots (it bills per awake compute-hour). The period is now
// 30 minutes everywhere, dev included, and an abandoned cart holds its tickets
// for up to 80 minutes (20-minute TTL + 2 × 30) — accepted as the cost.
//
// THE DRIFT IS GUARDED. `apps/jobs/src/scripts/validate-manifest.ts` asserts
// the manifest cron still equals `CART_REAPER_CRON_SOURCE` AND that no
// environment overrides the job's schedule in its tfvars (Terraform deploys an
// override in place of the manifest, so it would be the copy that actually
// runs) — the same guard `payout-batch-cycle.ts` has.
//
// This module imports NOTHING on purpose: the validator loads it directly.
// ─────────────────────────────────────────────────────────────────────────────

/** The manifest key whose schedule this module records. */
export const CART_REAPER_JOB_NAME = "tickets.release-expired-carts";

/**
 * The cron the reaper is scheduled on, VERBATIM. A string to compare, not a
 * schedule to parse (see payout-batch-cycle.ts for why).
 */
export const CART_REAPER_CRON_SOURCE = "*/30 * * * *";

/**
 * Longest gap between two reaper passes on {@link CART_REAPER_CRON_SOURCE}.
 * Change it together with the cron, and re-read `CAPACITY_HELD_WINDOW_SECONDS`
 * when you do.
 */
export const CART_REAPER_PERIOD_SECONDS = 30 * 60;
