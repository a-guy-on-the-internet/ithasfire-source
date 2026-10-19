/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with `pnpm -C apps/jobs generate:registry`.
 * Source of truth is each job module's own `defineJob` /
 * `defineScheduledTask` call; this table only lifts the metadata out so the
 * service can serve it without importing a handler. See src/jobs/registry.ts.
 *
 * Drift is caught by src/jobs/__tests__/registry-drift.test.ts.
 */
import type { RegisteredJob } from "./registry";

export const REGISTERED_JOBS: readonly RegisteredJob[] = [
  {
    module: "tickets",
    name: "tickets.release-expired-holds",
    description: "Release orphaned seat holds that have exceeded their TTL (open carts belong to release-expired-carts).",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "tickets",
    name: "tickets.release-expired-carts",
    description: "Cancel stale PENDING orders and their Stripe PaymentIntents, releasing held seats.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "tickets",
    name: "tickets.expire-resale-listings",
    description: "Expire ACTIVE resale listings past their expiry or event end, and release stale HELD listings.",
    schedule: { cron: "0 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "settlements",
    name: "settlements.run-batch",
    description: "Consolidated per-payee payout batch. Runs daily at midnight CT and can be triggered manually from the platform jobs page.",
    schedule: { cron: "0 0 * * *", timezone: "America/Chicago" },
  },
  {
    module: "settlements",
    name: "settlements.verify-ledger",
    description: "Read-only ledger reconciliation sweep (spec 2026-08-10 §9). Recomputes the PayeeLedgerBalance rollups from entries, checks per-(order,payee) refund conservation, flags finalized orders missing their SETTLEMENT_CREDITs, and compares the PLATFORM Stripe balance against total liability. Reports violations (Sentry + Discord); never repairs.",
    schedule: { cron: "0 4 * * *", timezone: "America/Chicago" },
  },
  {
    module: "settlements",
    name: "settlements.backfill-processor-fees",
    description: "Reads what Stripe actually charged to process each order, from the charge's balance transaction, and stamps Order.processorFeeCents — the only source of the processor-cost input to platform revenue; a rate-card estimate is a different number wearing its name. A failed read leaves the column NULL ('not attributed'), backs the row off for 6h and parks it after 24 failures; Sentry hears about a row on its first failure and when it is parked, never on the retries between. Hourly.",
    schedule: { cron: "0 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "disputes",
    name: "disputes.chase-evidence-deadlines",
    description: "Daily chase of chargeback evidence deadlines: sweeps OPEN disputes near or past their evidence deadline, with no deadline, with no evidence package, or whose last submit failed; re-runs the assembler for missing packages; raises ONE Discord alert (error colour when anything is overdue) linking each dispute to the platform desk. Silent when nothing needs attention.",
    schedule: { cron: "0 14 * * *", timezone: "America/Chicago" },
  },
  {
    module: "stripe-connect",
    name: "stripe-connect.reconcile-capabilities",
    description: "Re-read the stalest connected accounts from Stripe and write their capability state back through the same derivation the account.updated webhook uses. Backstop for lost webhooks; also reports how many rows had drifted.",
    schedule: { cron: "30 22 * * *", timezone: "America/Chicago" },
  },
  {
    module: "search",
    name: "search.index-event",
    description: "Index a single event into the selected search backend.",
  },
  {
    module: "search",
    name: "search.index-human",
    description: "Index a single human/profile into the selected search backend.",
  },
  {
    module: "search",
    name: "search.index-place",
    description: "Index a single place/venue into the selected search backend.",
  },
  {
    module: "search",
    name: "search.index-organization",
    description: "Index a single organization into the selected search backend.",
  },
  {
    module: "search",
    name: "search.full-reindex",
    description: "Rebuild the selected search backend index (events, humans, places, organizations) from scratch.",
    notify: true,
    schedule: { cron: "0 3 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "search",
    name: "search.ensure-format",
    description: "Post-deploy: if the stored search index format version is behind this build's SEARCH_INDEX_FORMAT_VERSION, claim, run the non-destructive full reindex and record the version. No-op when current or ahead. Triggered by the deploy workflow, never by cron.",
  },
  {
    module: "search",
    name: "search.drain-reindex-pending",
    description: "Reindex the entities marked in SearchReindexPending by recent edits, clear the ones refreshed, and reschedule (with backoff) only while rows remain. Triggered by edits via the delayed scheduler; never on a timer.",
  },
  {
    module: "search",
    name: "search.reindex-scheduled-price-flips",
    description: "Re-index events whose ticket-type scheduled price change crossed inside the scan window, so the index's materialized minPaidPriceCents stops serving the pre-flip price. Read-time pricing is unaffected; this only refreshes a derived cache.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "analytics",
    name: "analytics.event-daily-stats",
    description: "Nightly aggregation of per-event sell-through, revenue, and ticket stats.",
    schedule: { cron: "30 3 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "analytics",
    name: "analytics.resale-price-snapshots",
    description: "Nightly refresh of resale price suggestions based on recent market data.",
    schedule: { cron: "0 4 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "places",
    name: "places.cleanup-stale-verification-docs",
    description: "Daily cleanup of orphaned verification documents from R2 storage.",
    schedule: { cron: "0 3 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "places",
    name: "places.recalculate-place-stats",
    description: "Recalculates aggregate stats (payout, scores, draw, flags, genre cloud) for places with stale review data.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "places",
    name: "places.recompute-public-snapshots",
    description: "Weekly rebuild of the anonymized public review snapshots (threshold-gated, bucketed aggregates) served on place pages.",
    schedule: { cron: "0 6 * * 1", timezone: "Etc/UTC" },
  },
  {
    module: "stats",
    name: "humans.compute-human-stats",
    description: "Recomputes materialized performer stats from attributions, events, and follows.",
    schedule: { cron: "0 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "stats",
    name: "orgs.compute-org-stats",
    description: "Recomputes materialized organization stats from events, orders, attributions, and follows.",
    schedule: { cron: "0 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "exports",
    name: "admin.csv-export",
    description: "Background CSV export for admin tables. Uploads the file to R2 and notifies the user with a download link.",
  },
  {
    module: "announcements",
    name: "announcements.dispatch-notifications",
    description: "Dispatches in-app / push notifications for an announcement to a batch of human recipients.",
  },
  {
    module: "sitemaps",
    name: "sitemaps.generate",
    description: "Generate sitemap XML files for SEO and upload them to the public CDN bucket.",
    notify: true,
    schedule: { cron: "30 1 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "storage",
    name: "storage.sweep-orphaned-uploads",
    description: "Clean up orphaned audio and image uploads: mark stalled transcodes as failed, soft-delete images no longer referenced by their event's hero or body after a grace period, hard-delete expired records, and enqueue their blobs into the deletion outbox for the drain job to remove from R2/MinIO.",
    schedule: { cron: "0 4 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "storage",
    name: "storage.drain-pending-deletions",
    description: "Drain the object-storage (R2/MinIO) deletion outbox: delete the keys and prefixes enqueued in-transaction by event deletes, retrying with exponential backoff and dead-lettering rows that exhaust their attempts.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "events",
    name: "events.dispatch-follow-notifications",
    description: "Deliver new event alerts to entity followers using the durable per-channel outbox.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "events",
    name: "events.purge-follow-notices",
    description: "Delete follow-notification notices and deliveries for events that started more than the retention window ago (default 30 days).",
    schedule: { cron: "0 4 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "events",
    name: "events.dispatch-change-notifications",
    description: "Drain the event-change notification outbox (cancel / reschedule / venue-change) and fan each notice out to its watchers (savers + RSVPers) and refunded buyers over in-app + email, retrying and dead-lettering notices that exhaust their attempts.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "events",
    name: "events.purge-dispatched-change-notices",
    description: "Delete dispatched event-change notices past the retention window so the buyer humanIds and refund amounts persisted in CANCELLED payloads don't live at rest indefinitely. Never deletes undispatched/in-flight notices.",
    schedule: { cron: "0 4 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "events",
    name: "events.address-reveal-notify",
    description: "Notify active ticket holders of OBSCURED events whose addressRevealAt just crossed that the exact address is now live (in-app forced on + email/push per preference; push delivers to registered devices — mobile-side token registration still pending). Duplicate-safe via the at-most-once addressRevealNotifiedAt cursor, durable notification-ledger subtraction, and per-recipient notify keys. An explicit eventId run is the ops re-drive path for a partially-failed fan-out (re-notifies only the gap).",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "events",
    name: "events.expire-applications",
    description: "Transition PENDING event-application submissions whose application form closed more than the grace window (default 7 days) ago to EXPIRED. Batch update, batch audit row, no emails.",
    schedule: { cron: "30 2 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "events",
    name: "events.sweep-open-calls",
    description: "Open calls: set PENDING applications whose last chosen date has started to not-this-time (FR-021), expire those whose event or nights were called off with a call-pulled notice (FR-022), and re-send any not-this-time, pulled or received notice that never went out (last 14 days). Idempotent; returns counts.",
    schedule: { cron: "0 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "lineup-notices",
    name: "lineup-notices.continue-sweep",
    description: "Continue a post-publish lineup-notice sweep that ran out of time: tell the rest of the event's owed lineup people (exactly once per row), re-queue itself while rows remain, give up and report after 5 runs. Triggered through the delayed scheduler (Cloud Tasks); never on a timer.",
  },
  {
    module: "volunteers",
    name: "volunteers.reminders-24h",
    description: "Dispatch 24h-ahead volunteer reminders for shifts, shiftless event roles and one-time asks (email + in-app for signed-in volunteers + SMS for opted-in numbers). Idempotent via the VolunteerShiftNotification ledger.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "volunteers",
    name: "volunteers.reminders-1h",
    description: "Dispatch 1h-ahead volunteer reminders for shifts, shiftless event roles and one-time asks. Window +40m to +80m on a */30 tick; the per-channel ledger claim keeps overlapping ticks to one reminder.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "booking-requests",
    name: "booking-requests.auto-expire",
    description: "Transition open (PENDING/VIEWED) booking requests past their expiry to EXPIRED.",
    schedule: { cron: "30 2 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "support",
    name: "support.purge-resolved-threads",
    description: "Delete resolved support threads (and their cascaded messages) past the retention window (SUPPORT_RETENTION_DAYS).",
    schedule: { cron: "0 5 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "idempotency",
    name: "idempotency.purge-expired",
    description: "Delete idempotency records past their retention window (no-op on the Redis backend, which expires keys itself).",
    schedule: { cron: "30 5 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "job-history",
    name: "jobs.prune-run-history",
    description: "Trim JobRun history to the retention cap across all jobs (no-op on the Redis backend, which trims on write).",
    schedule: { cron: "30 5 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "memberships",
    name: "memberships.refresh-tax-jurisdictions",
    description: "Re-confirm cached membership tax rates, archiving and replacing changed ones and repointing affected subscriptions.",
    schedule: { cron: "30 6 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "memberships",
    name: "memberships.report-health",
    description: "Daily health read over the membership book: memberships whose card is failing (past_due / unpaid — benefits are ALREADY denied at checkout), signups stuck at 'incomplete' past the grace window, and memberships set to end inside the warning window. The Discord alert is edge-triggered: it fires when the set of firing signals changes, or when an unchanged picture goes stale. Two of the three counts never return to zero without a human, so a level trigger would post the same message every day forever.",
    schedule: { cron: "30 6 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "community-recurrence",
    name: "community.refresh-recurring-dates",
    description: "Rolling re-expansion of recurring community listings: top up EventDate windows and re-pin Event.startsAt to the next upcoming date.",
    schedule: { cron: "30 5 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "community",
    name: "community.dispatch-rsvp-confirmations",
    description: "Drain the RSVP-confirmation outbox and send each newly-RSVP'd attendee an in-app + email confirmation with event details and links to the event page and /my-rsvps, retrying and dead-lettering notices that exhaust their attempts.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "community",
    name: "community.rsvp-reminders-24h",
    description: "Remind community RSVPers ~24h before the date they said they are going to - per DATE on recurring listings, per EVENT on single-date ones. Window is startsAt-24h to startsAt-22h, so the */30 tick lands within 30 min of the mark and the 2h tail survives an outage. Idempotent via the RsvpReminder ledger's per-channel claim; a failed channel releases its claim and retries next tick. User-controllable: the 'reminders' notification category, GLOBAL and per-EVENT.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "community",
    name: "community.purge-dispatched-rsvp-notices",
    description: "Delete dispatched RSVP-confirmation notices past the retention window so (eventId, humanId) linkage rows don't accumulate at rest indefinitely. Never deletes undispatched/in-flight notices.",
    schedule: { cron: "30 4 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "moderation",
    name: "moderation.drain-image-moderations",
    description: "Drain the image-moderation outbox (PENDING ImageModerationRecord rows) and run each image through the moderation provider (Azure AI Content Safety, or the auto-approving stub when unconfigured), writing the verdict back onto the record. Retries transient provider failures with exponential backoff and dead-letters exhausted rows to FLAGGED+degraded so they surface in the human review queue rather than staying hidden. A row whose object no longer exists in storage resolves to ORPHANED on the first pass (permanent, hidden, never queued for a human) instead of burning the retry budget. A fresh FLAGGED verdict fires the uploader HOLD notification.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "moderation",
    name: "moderation.requeue-degraded",
    description: "Send dead-lettered DEGRADED image-moderation rows back to PENDING so the drain re-scores them once the provider recovers. Only rows the SCANNER failed on are eligible — a real content verdict, or any row a human has decided, is never revived. Bounded by a per-row requeue cap so an object that can never be scanned (deleted event, GC'd media) stops cycling and stays FLAGGED for a human.",
    schedule: { cron: "0 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "moderation",
    name: "moderation.report-queue-health",
    description: "Hourly health read over the image-moderation queue: images overdue for draining (the drain is dead), images that failed to scan recently (the provider is failing), images that exhausted the requeue cap (unscannable), flagged images awaiting human review too long (nobody is chasing them, because uploaders are not emailed about holds), and images whose object vanished from storage (ORPHANED — terminal and hidden, so this count is their only operational signal). The read runs every hour, but the Discord alert is edge-triggered: it fires when the set of firing categories changes, or when the same picture has stood unchanged for reAlertAfterHours (default 24). Two of the counts never fall back to zero without a human, so a level trigger meant the same stuck record paged hourly forever until nobody read the channel.",
    schedule: { cron: "0 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "push",
    name: "push.drain-receipts",
    description: "Poll Expo push receipts for recently sent notifications, disable devices whose receipts report DeviceNotRegistered/InvalidCredentials, and delete resolved/expired pending-receipt rows.",
    schedule: { cron: "*/30 * * * *", timezone: "Etc/UTC" },
  },
  {
    module: "post-event-prompts",
    name: "post-event-prompts.enqueue",
    description: "Daily sweep that enqueues post-event prompts: one PERFORMER prompt per performer human on a completed platform-booked gig, then one ATTENDEE prompt per scanned ticket holder of an ended event (performer-prompted humans excluded). Idempotent via the (eventId, humanId, audience) unique index.",
    schedule: { cron: "0 15 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "post-event-prompts",
    name: "post-event-prompts.dispatch",
    description: "Drain the post-event prompt outbox and send each performer a one-time in-app + email post-gig review prompt deep-linking to /review-a-place, retrying and dead-lettering prompts that exhaust their attempts. ATTENDEE prompts stay pending (dispatch-gated) until the attendee review form ships.",
    schedule: { cron: "30 15 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "attendee-reviews",
    name: "attendee-reviews.recompute-aggregates",
    description: "Weekly rebuild of the anonymized attendee-review aggregate snapshots (threshold-gated, bucketed) served on event, venue, organizer and series surfaces.",
    schedule: { cron: "0 7 * * 1", timezone: "Etc/UTC" },
  },
  {
    module: "attendee-reviews",
    name: "attendee-review-digests.send",
    description: "Weekly attendee review-prompt email digest: one email per human listing their un-reviewed, still-in-window attended shows, with a one-click unsubscribe and 3-strike soft auto-suppression. In-app prompts are unaffected. Idempotent per (human, week).",
    schedule: { cron: "0 16 * * 4", timezone: "Etc/UTC" },
  },
  {
    module: "security",
    name: "security.purge-network-sightings",
    description: "Delete hashed sign-up/sign-in network sightings older than 30 days, expired network ban rows, and edit-suggestion IP hashes older than 30 days (privacy-policy retention).",
    schedule: { cron: "30 5 * * *", timezone: "Etc/UTC" },
  },
  {
    module: "tax",
    name: "tax.fill-location-rate",
    description: "Look up and cache the tax rate of one venue a listing found without one, then mark its upcoming events for the search drain so their cards show an all-in price. Queued by listings through the delayed scheduler (Cloud Tasks); never on a timer.",
  },
];
