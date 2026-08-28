/**
 * Job Registry
 *
 * Central place that collects all jobs.
 * This is the ONLY file that needs updating when adding a new job.
 */

import { ticketJobs } from "./tickets";
import { settlementJobs } from "./settlements";
import { searchJobs } from "./search";
import { analyticsJobs } from "./analytics";
import { placeJobs } from "./places";
import { exportJobs } from "./exports";
import { announcementJobs } from "./announcements";
import { statsJobs } from "./stats";
import { sitemapJobs } from "./sitemaps";
import { storageJobs } from "./storage";
import { eventJobs } from "./events";
import { volunteerJobs } from "./volunteers";
import { bookingRequestJobs } from "./booking-requests";
import { supportJobs } from "./support";
import { idempotencyJobs } from "./idempotency";
import { jobHistoryJobs } from "./job-history";
import { membershipJobs } from "./memberships";
import { communityRecurrenceJobs } from "./community-recurrence";
import { communityJobs } from "./community";
import { moderationJobs } from "./moderation";
import { pushJobs } from "./push";
import { postEventPromptJobs } from "./post-event-prompts";
import { attendeeReviewJobs } from "./attendee-reviews";
import { stripeConnectJobs } from "./stripe-connect";

// ─────────────────────────────────────────────────────────────────────────────
// All jobs in one flat array
// ─────────────────────────────────────────────────────────────────────────────
export const allJobs = [
  ...ticketJobs,
  ...settlementJobs,
  ...stripeConnectJobs,
  ...searchJobs,
  ...analyticsJobs,
  ...placeJobs,
  ...statsJobs,
  ...exportJobs,
  ...announcementJobs,
  ...sitemapJobs,
  ...storageJobs,
  ...eventJobs,
  ...volunteerJobs,
  ...bookingRequestJobs,
  ...supportJobs,
  ...idempotencyJobs,
  ...jobHistoryJobs,
  ...membershipJobs,
  ...communityRecurrenceJobs,
  ...communityJobs,
  ...moderationJobs,
  ...pushJobs,
  ...postEventPromptJobs,
  ...attendeeReviewJobs,
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookup maps
// ─────────────────────────────────────────────────────────────────────────────
export const jobsByName = new Map(allJobs.map((job) => [job.name, job]));

export const scheduledTasks = allJobs.filter((job) => "schedule" in job);

// ─────────────────────────────────────────────────────────────────────────────
// Helper to get a job by name
// ─────────────────────────────────────────────────────────────────────────────
export function getJob(name: string) {
  return jobsByName.get(name);
}
