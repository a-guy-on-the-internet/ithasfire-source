/**
 * Job Module Loaders
 *
 * One dynamic import per job module. THIS is the file that keeps the jobs
 * service off the floor at boot: nothing here is imported until a job in that
 * module is actually dispatched, so starting the dispatcher costs a map of 25
 * closures instead of 25 transitive graphs of use cases, adapters, the Prisma
 * client and the Stripe SDK.
 *
 * Adding a job module is a two-line change: add an entry here, then run
 * `pnpm -C apps/jobs generate:registry` to refresh the eager metadata table.
 *
 * ORDER IS PART OF THE CONTRACT. `GET /jobs` and `GET /jobs/status` return an
 * array, and their order comes from the order of this map (the generator walks
 * it top to bottom). It reproduces the old hand-written `allJobs` spread
 * exactly, so the endpoints keep returning byte-identical JSON.
 */
import type { AnyJobDefinition } from "../lib/define-job";

export const JOB_MODULE_LOADERS = {
  tickets: () => import("./tickets").then((m) => m.ticketJobs),
  settlements: () => import("./settlements").then((m) => m.settlementJobs),
  disputes: () => import("./disputes").then((m) => m.disputeJobs),
  "stripe-connect": () =>
    import("./stripe-connect").then((m) => m.stripeConnectJobs),
  search: () => import("./search").then((m) => m.searchJobs),
  analytics: () => import("./analytics").then((m) => m.analyticsJobs),
  places: () => import("./places").then((m) => m.placeJobs),
  stats: () => import("./stats").then((m) => m.statsJobs),
  exports: () => import("./exports").then((m) => m.exportJobs),
  announcements: () =>
    import("./announcements").then((m) => m.announcementJobs),
  sitemaps: () => import("./sitemaps").then((m) => m.sitemapJobs),
  storage: () => import("./storage").then((m) => m.storageJobs),
  events: () => import("./events").then((m) => m.eventJobs),
  "lineup-notices": () =>
    import("./lineup-notices").then((m) => m.lineupNoticeJobs),
  volunteers: () => import("./volunteers").then((m) => m.volunteerJobs),
  "booking-requests": () =>
    import("./booking-requests").then((m) => m.bookingRequestJobs),
  support: () => import("./support").then((m) => m.supportJobs),
  idempotency: () => import("./idempotency").then((m) => m.idempotencyJobs),
  "job-history": () => import("./job-history").then((m) => m.jobHistoryJobs),
  memberships: () => import("./memberships").then((m) => m.membershipJobs),
  "community-recurrence": () =>
    import("./community-recurrence").then((m) => m.communityRecurrenceJobs),
  community: () => import("./community").then((m) => m.communityJobs),
  moderation: () => import("./moderation").then((m) => m.moderationJobs),
  push: () => import("./push").then((m) => m.pushJobs),
  "post-event-prompts": () =>
    import("./post-event-prompts").then((m) => m.postEventPromptJobs),
  "attendee-reviews": () =>
    import("./attendee-reviews").then((m) => m.attendeeReviewJobs),
  security: () => import("./security").then((m) => m.securityJobs),
  tax: () => import("./tax").then((m) => m.taxJobs),
} as const satisfies Record<
  string,
  () => Promise<readonly AnyJobDefinition[]>
>;

/** Key of a job module — the `module` field on every registry entry. */
export type JobModuleId = keyof typeof JOB_MODULE_LOADERS;

/** Module ids in registry order. The generator and the drift test both walk this. */
export const JOB_MODULE_IDS = Object.keys(
  JOB_MODULE_LOADERS,
) as readonly JobModuleId[];
