import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  EntityEventDelivery,
  FollowDeliveryFinishReason,
  FollowerHomeCandidate,
  FollowNoticeChannel,
  FollowNoticeClosedReason,
} from "@th/ports/repos/entity-event-notices";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import { eventPublicUrl, normalizeAppBaseUrl } from "../../lib/public-urls";
import { parseInput } from "../../lib/io";
import {
  projectPublicEventLocation,
  publicDistanceMeters,
  unreadablePlaceLocation,
  type PublicEventLocation,
} from "../../lib/location/project-public-event-location";
import { eventFollowPages, isAnnounceableEvent } from "./enqueue-event-followers";
import { FOLLOW_NEARBY_DEFAULT_RADIUS_KM } from "./schemas";

export const dispatchFollowNotificationsInputSchema = z.object({
  /**
   * Deliveries claimed per run. NOT the real limiter: the loop checks
   * `timeBudgetMs` before every claim, so a run stops at 120s whatever this
   * says. Doubled from 300 on 2026-10-08 when the scheduled run moved from
   * every 15 to every 30 minutes, so a backlog drains as fast per hour.
   */
  batchLimit: z.number().int().min(1).max(1000).default(600),
  /** Followers expanded into deliveries per run, across as many notices as it takes. */
  expandBudget: z.number().int().min(1).max(20_000).default(5_000),
  /**
   * Wall-clock budget for the delivery loop. Same bounds as the other drains
   * (`lib/drain-loop.ts`): 120s by default, never past 240s inside the 300s
   * scheduler attempt deadline.
   */
  timeBudgetMs: z.number().int().min(1_000).max(240_000).default(120_000),
}).strict();
export type DispatchFollowNotificationsDeps = {
  repos: Pick<Repos, "entityEventNotices" | "entityPages" | "places" | "events" | "follows">;
  clock: ClockPort;
  notify: (input: NotifyInput) => Promise<NotifyOutput>;
  appBaseUrl: string;
  reportError?: ReporterPort;
};

/** A delivery that has failed this many times is dead-lettered, not retried. */
export const FOLLOW_DELIVERY_MAX_ATTEMPTS = 8;
export { FOLLOW_NEARBY_DEFAULT_RADIUS_KM };
/** How many past ticketed events are tried, newest first, for a home point. */
const HOME_CANDIDATE_LIMIT = 10;
/** Safety stop for the expansion loop; each step closes or advances a notice. */
const MAX_EXPANSION_STEPS = 500;

const channels: FollowNoticeChannel[] = ["in_app", "email", "push"];
const doneField = {in_app: "inAppDone", email: "emailDone", push: "pushDone"} as const;

function report(deps: DispatchFollowNotificationsDeps, error: unknown, extra: Record<string, unknown>) {
  try { deps.reportError?.(error, {tags: {useCase: "dispatchFollowNotifications"}, extra}); } catch { /* reporting must not prevent a retry */ }
}

type Eligibility =
  | {ok: true; payload: Record<string, unknown>}
  | {ok: false; reason: FollowDeliveryFinishReason};

export async function dispatchFollowNotifications(deps: DispatchFollowNotificationsDeps, rawInput: unknown) {
  const input = parseInput(dispatchFollowNotificationsInputSchema, rawInput);
  const startedAt = deps.clock.now().getTime();
  const result = {expanded: 0, noticesExpanded: 0, noticesClosed: 0, processed: 0, delivered: 0, skipped: 0, failed: 0, deadLettered: 0};

  // ── Expansion: keep going until no open notice is left or the follower
  // budget is spent. A zero-follower notice costs a step, not the budget. A
  // notice whose event started (or vanished) before it could expand is closed
  // WITH a reason, and those are reported once per run below.
  const closed = new Map<FollowNoticeClosedReason, number>();
  let budget = input.expandBudget;
  for (let step = 0; step < MAX_EXPANSION_STEPS && budget > 0; step++) {
    const expanded = await deps.repos.entityEventNotices.expandAudience({limit: Math.min(500, budget), now: deps.clock.now()});
    if (!expanded) break;
    result.noticesExpanded++;
    result.expanded += expanded.inserted;
    budget -= expanded.inserted;
    if (expanded.closedReason) {
      result.noticesClosed++;
      closed.set(expanded.closedReason, (closed.get(expanded.closedReason) ?? 0) + 1);
    }
  }

  // Channels whose port this process lacks, with the deliveries affected.
  // Reported ONCE per run below, never per delivery.
  const unavailable = new Map<FollowNoticeChannel, number>();
  for (let i=0; i<input.batchLimit; i++) {
    const now = deps.clock.now();
    if (now.getTime() - startedAt >= input.timeBudgetMs) break;
    const delivery = await deps.repos.entityEventNotices.claim({now, leaseUntil: new Date(now.getTime()+5*60_000), token: randomUUID()});
    if (!delivery) break;
    result.processed++;
    try {
      let eligibility = await eligiblePayload(deps, delivery);
      if (!eligibility.ok) {
        await deps.repos.entityEventNotices.finish(delivery.id, delivery.leaseToken, deps.clock.now(), eligibility.reason);
        result.skipped++; continue;
      }
      let failure: {channel: FollowNoticeChannel; reason: string} | null = null;
      let skippedMidway = false;
      for (const channel of channels) {
        if (delivery[doneField[channel]]) continue;
        eligibility = await eligiblePayload(deps, delivery);
        if (!eligibility.ok) {
          await deps.repos.entityEventNotices.finish(delivery.id, delivery.leaseToken, deps.clock.now(), eligibility.reason);
          result.skipped++;
          skippedMidway = true;
          break;
        }
        const claimTime = deps.clock.now();
        if (!await deps.repos.entityEventNotices.renew(delivery.id, delivery.leaseToken, claimTime, new Date(claimTime.getTime()+5*60_000))) {
          throw new Error("Follow notification lease lost before send");
        }
        // Leave the selected channel undefined: notify reads the user's preferences.
        const enabled = {inApp: {enabled:false}, email: {enabled:false}, push: {enabled:false}, sms: {enabled:false}} as NotifyInput["channels"];
        delete enabled![channel === "in_app" ? "inApp" : channel];
        const output = await deps.notify({humanId: delivery.humanId, variant: "entity.new-event", payload: eligibility.payload,
          scope: {kind:"GLOBAL"}, channels: enabled,
          // Retries wait at least 120s, beyond notify's 60s cache. The stable
          // key also lets providers deduplicate a send interrupted before settlement.
          idempotencyKey: `follow:${delivery.id}:${channel}`});
        const status = channel === "in_app" ? output.inApp : output[channel];
        // An unconfigured port is FINAL for this channel: it settles like a
        // preference skip. Retrying it would re-send nothing and re-report
        // every attempt until the event starts (the send-rsvp-reminders
        // precedent). Accepted cost: wiring the port back later does not
        // retro-send this notice on that channel.
        const portUnavailable = status?.status === "skipped" && status.reason === "port_unavailable";
        if (portUnavailable) unavailable.set(channel, (unavailable.get(channel) ?? 0) + 1);
        // Every other skip (preference off, no device, no recipient…) is a
        // terminal answer for this channel and settles below.
        if (!status || status.status === "failed") {
          failure ??= {channel, reason: status && "reason" in status ? String(status.reason) : "no_status"};
          continue;
        }
        const settled = await deps.repos.entityEventNotices.settleChannel(delivery.id, delivery.leaseToken, channel, deps.clock.now());
        if (!settled) throw new Error("Follow notification lease expired before settlement");
      }
      if (skippedMidway) continue;
      if (failure) {
        const outcome = await failOrDeadLetter(deps, delivery, failure);
        if (outcome === "dead") result.deadLettered++; else result.failed++;
      } else {
        await deps.repos.entityEventNotices.finish(delivery.id, delivery.leaseToken, deps.clock.now(), "DELIVERED"); result.delivered++;
      }
    } catch (error) {
      try {
        const outcome = await failOrDeadLetter(deps, delivery, {channel: null, reason: "error"}, error);
        if (outcome === "dead") result.deadLettered++; else result.failed++;
      } catch (retryError) {
        result.failed++;
        report(deps, retryError, {deliveryId: delivery.id, stage: "retry"});
      }
    }
  }
  for (const [channel, deliveries] of unavailable) {
    report(deps, new Error(`Follow notification ${channel} port unavailable; settled without sending`), {channel, reason: "port_unavailable", deliveries});
  }
  for (const [reason, notices] of closed) {
    report(deps, new Error(`Follow notices closed before expansion: ${reason}`), {reason, notices});
  }
  return result;
}

/**
 * A failed attempt. Retries back off; the 8th failure dead-letters the
 * delivery with a recorded reason. Reported on the FIRST failure and on
 * dead-letter only, never on the retries in between.
 */
async function failOrDeadLetter(
  deps: DispatchFollowNotificationsDeps,
  d: EntityEventDelivery,
  failure: {channel: FollowNoticeChannel | null; reason: string},
  error?: unknown,
): Promise<"retry" | "dead"> {
  const now = deps.clock.now();
  const attempts = d.attempts + 1;
  const extra = {deliveryId: d.id, channel: failure.channel, reason: failure.reason, attempts};
  if (attempts >= FOLLOW_DELIVERY_MAX_ATTEMPTS) {
    await deps.repos.entityEventNotices.finish(d.id, d.leaseToken, now, "DEAD_LETTER");
    report(deps, error ?? new Error(`Follow notification dead-lettered after ${attempts} attempts`), extra);
    return "dead";
  }
  await deps.repos.entityEventNotices.retry(d.id, d.leaseToken, new Date(now.getTime()+Math.min(3600,120*2**Math.min(d.attempts,5))*1000), now);
  if (d.attempts === 0) report(deps, error ?? new Error(`Follow notification ${failure.channel ?? "delivery"} failed`), extra);
  return "retry";
}

/** The PUBLIC exact point of a location projection, or null. */
function publicExactPoint(location: PublicEventLocation): {lat: number; lng: number} | null {
  return location.mode === "EXACT" && location.lat !== null && location.lng !== null ? {lat: location.lat, lng: location.lng} : null;
}

/**
 * The follower's "home" for a nearby follow: the newest past ticketed event
 * whose PUBLIC projection (gate not granted) is EXACT. A withheld venue, an
 * obscured or gated event yields nothing and the next older one is tried.
 * Raw rows go into the projection and nowhere else.
 */
export function followerHomePoint(candidates: readonly FollowerHomeCandidate[]): {lat: number; lng: number} | null {
  for (const {event, place} of candidates) {
    const location = projectPublicEventLocation(event, {
      place: event.placeId ? (place ?? unreadablePlaceLocation(event.placeId)) : undefined,
    });
    const point = publicExactPoint(location);
    if (point) return point;
  }
  return null;
}

/**
 * "Near you" decision for a nearby follow. Both points are PUBLIC EXACT
 * projections; if either side has none, the follow is skipped (fail closed)
 * with a reason — no decision ever depends on a coordinate that is not
 * already public, so a notice cannot become a distance oracle on a withheld
 * address.
 */
async function nearbyDecision(
  deps: DispatchFollowNotificationsDeps,
  humanId: string,
  event: EventRecord,
  radiusKm: number | null,
): Promise<FollowDeliveryFinishReason | null> {
  const place = event.placeId ? await deps.repos.places.getById(event.placeId) : null;
  const eventPoint = publicExactPoint(projectPublicEventLocation(event, {
    place: event.placeId ? (place ?? unreadablePlaceLocation(event.placeId)) : undefined,
  }));
  if (!eventPoint) return "NEARBY_EVENT_NOT_PUBLIC";
  const home = followerHomePoint(await deps.repos.entityEventNotices.followerHomeCandidates(humanId, HOME_CANDIDATE_LIMIT));
  if (!home) return "NEARBY_NO_PUBLIC_HOME";
  const meters = publicDistanceMeters(home, {lat: eventPoint.lat, lng: eventPoint.lng});
  if (meters === null || meters > (radiusKm ?? FOLLOW_NEARBY_DEFAULT_RADIUS_KM) * 1000) return "NEARBY_OUTSIDE_RADIUS";
  return null;
}

async function eligiblePayload(deps: DispatchFollowNotificationsDeps, d: EntityEventDelivery): Promise<Eligibility> {
  const follow = await deps.repos.follows.getFollow(d.humanId,d.entityPageId);
  if (!follow || follow.id !== d.followId) return {ok: false, reason: "FOLLOW_GONE"};
  if (!follow.notifyNewEvents) return {ok: false, reason: "MUTED"};
  if (follow.createdAt > d.createdAt) return {ok: false, reason: "FOLLOWED_AFTER_NOTICE"};
  const event = await deps.repos.events.getById(d.eventId);
  if (!event || !isAnnounceableEvent(event, deps.clock.now())) return {ok: false, reason: "EVENT_NOT_ANNOUNCEABLE"};
  const page = (await eventFollowPages(deps.repos,event)).find(p => p.id === d.entityPageId);
  if (!page) return {ok: false, reason: "PAGE_NOT_ELIGIBLE"};
  if (follow.notifyNearby) {
    const skip = await nearbyDecision(deps, d.humanId, event, follow.radiusKm ?? null);
    if (skip) return {ok: false, reason: skip};
  }
  // One name per venue: a PLACE page announces as `Place.name`; the page's
  // displayName is frozen for places and never read.
  const entityName = page.ownerType === "PLACE"
    ? (await deps.repos.places.getById(page.ownerId))?.name ?? null
    : page.displayName ?? page.slug;
  if (!entityName) return {ok: false, reason: "PAGE_NOT_ELIGIBLE"};
  const eventUrl = eventPublicUrl({baseUrl:deps.appBaseUrl,slug:event.slug});
  const base = normalizeAppBaseUrl(deps.appBaseUrl);
  if (!eventUrl || !base) throw new Error("Follow notification public URL unavailable");
  return {ok: true, payload: {entityPageId:page.id,entityName,eventId:event.id,eventTitle:event.title,startsAtIso:event.startsAt.toISOString(),timezone:event.timezone,eventUrl,manageFollowingUrl:`${base}/account/settings/notifications`}};
}
