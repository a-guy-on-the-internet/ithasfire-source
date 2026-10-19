/**
 * Write-triggered outbox drains.
 *
 * Three outbox drains used to poll on a cron (`*∕2` in dev, `*∕5` in prod). Each
 * tick woke the jobs service AND Neon even when nothing was queued, and the
 * cadence was short enough that the database never idled long enough to
 * suspend. Instead, the code that commits an outbox row now publishes a
 * "wake up" message for the drain that owns it, and the cron drops to a
 * low-frequency safety net for publishes that were lost.
 *
 * LEAF MODULE ON PURPOSE: no imports. `apps/jobs/src/scripts/validate-manifest.ts`
 * imports this table to check it against `jobs.manifest.json`'s `triggerTopic`
 * entries, and a gate must never be able to fail because a business module's
 * transitive import blew up (same rule as `payout-batch-cycle.ts`).
 *
 * THE TABLE IS DUPLICATED ON PURPOSE, not derived. Terraform reads
 * `triggerTopic` straight off the manifest to create the topic, the push
 * subscription and the publisher IAM; the API and jobs processes cannot read
 * the manifest at runtime, so they read this. The manifest gate fails when the
 * two disagree.
 */

/**
 * Per drain: the Pub/Sub topic SUFFIX (the deployed topic is
 * `projects/<project>/topics/<env>-<topic>`, the same `<env>-` prefix every
 * other jobs topic uses) and the JSON body the push delivers to
 * `POST /jobs/<name>`. The subscription is created with `no_wrapper`, so this
 * payload arrives as the request body verbatim and is parsed by the job's own
 * input schema.
 *
 * `freshOnly: true` keeps retry spacing where it was. The RSVP and
 * event-change outboxes have no per-row backoff column, so a drain woken by
 * every write would re-try a failing row on EVERY write, and a burst of five
 * writes during a mail outage would dead-letter a notice within seconds.
 * A triggered run therefore takes only rows that have never been attempted;
 * retries wait for the scheduled safety-net run. The image-moderation outbox
 * already has `nextAttemptAt` backoff, so its trigger needs no flag.
 */
export const DRAIN_TRIGGERS = {
  "community.dispatch-rsvp-confirmations": {
    topic: "hf-trigger-rsvp-confirmations",
    payload: { freshOnly: true },
  },
  "events.dispatch-change-notifications": {
    topic: "hf-trigger-event-change-notifications",
    payload: { freshOnly: true },
  },
  "moderation.drain-image-moderations": {
    topic: "hf-trigger-image-moderations",
    payload: {},
  },
} as const satisfies Record<
  string,
  { topic: string; payload: Record<string, unknown> }
>;

export type TriggeredJobName = keyof typeof DRAIN_TRIGGERS;

export function isTriggeredJobName(name: string): name is TriggeredJobName {
  return Object.prototype.hasOwnProperty.call(DRAIN_TRIGGERS, name);
}

/**
 * Wakes a drain. Implementations publish to Pub/Sub (deployed), POST the jobs
 * service directly (local dev), or do nothing (unconfigured).
 *
 * Contract: resolves once the wake-up is durably handed off (Pub/Sub accepted
 * it) and REJECTS on failure. Callers decide what a failure means; the outbox
 * decorator reports it and moves on, because the row is already committed and
 * the scheduled safety-net run will drain it.
 *
 * Callers must AWAIT this before their request finishes. The API and jobs
 * services run with request-based CPU (`cpu_idle = true`), so work left
 * running after the response is starved and may never be sent.
 */
export interface JobTriggerPort {
  trigger(job: TriggeredJobName): Promise<void>;
}
