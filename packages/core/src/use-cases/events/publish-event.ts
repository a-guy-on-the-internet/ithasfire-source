import {
  freezeEventDealOnLockedRow,
  lockEventDealTerms,
} from "../deals/_shared/deal-freeze";
import { enqueueEventFollowers } from "../follows/enqueue-event-followers";
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  EventRecord,
  EventTicketTypeSummary,
} from "@th/ports/repos/events";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type { GetPayeeBySubjectInput } from "@th/ports/repos/payees";
import type {
  PayoutTermsLineRecord,
  PayoutTermsRecord,
} from "@th/ports/repos/payout-terms";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import {
  commitPreparedEventTaxRate,
  commitPreparedEventTaxRateForRef,
  eventTaxRateLocationRef,
  prepareEventTaxRate,
  type PreparedEventTaxRateForRef,
  type TaxRateCacheTarget,
} from "./_shared/resolve-event-tax-rate";
import { isEverPaidTicketType } from "../../lib/orders/door-pricing";
import { applyInstructionExemption } from "../../lib/tax/instruction-exemption";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { requireAnyChargebackTermsForPaidEvent } from "../../lib/payments/chargeback-terms";
import {
  assessCapSatisfiability,
  SPLITS_TARGET_PCT,
} from "../../lib/pricing/caps-satisfiable";
// ── P4b (deal terms) ──
import { assertPerOrderLinesTotal100 } from "../../lib/pricing/per-order-lines-total";
import { requireEventResaleClauseSet } from "../../lib/resale-clause";
import {
  reportBestEffort,
  resolveScopedFeePolicy,
} from "../../lib/payments/resolve-scoped-fee-policy";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  appendBookingEventPublishedEntry,
  findBookingThreadForEvent,
} from "./_shared/booking-event-ledger";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  heldDatesOwnerOf,
  settleHeldDatesForEvent,
} from "../booking-holds/settle-held-dates-for-published-event";
import { generateEventSlug } from "./_shared/slug";
import { storedSeatOverrideCharges } from "./_shared/seat-price-override-rules";
import {
  probeManagedPlace,
  stampForPlaceManager,
} from "./_shared/venue-manager-stamp";
import {
  HOST_ATTESTATION_FIELDS,
  HOST_ATTESTATION_TEXT,
  HOST_ATTESTATION_VERSION,
  type HostAttestationField,
} from "./host-attestation-text";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { reindexEventsAtTaxLocation } from "../tax/reindex-events-at-tax-location";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { ensureDefaultPrimaryPayoutTerms } from "../agreements/_shared/ensure-default-primary-payout-terms";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import { fail, isAppError } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import {
  sweepLineupNoticesAfterPublish,
  type LineupNoticeHooks,
} from "../event-humans/notify-lineup-notices";

const IDEMPOTENCY_TTL_SECONDS = 120;

const hostAttestationInputSchema = z
  .object({
    legalRightToHost: z.boolean().optional(),
    zoningAndNoiseCompliance: z.boolean().optional(),
    alcoholCompliance: z.boolean().optional(),
    taxResponsibility: z.boolean().optional(),
    organizerFaqReviewed: z.boolean().optional(),
  })
  .strict();

type CompleteHostAttestation = Record<HostAttestationField, true>;

export const publishEventInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  clientKey: z.string().min(8),
  ipAddress: z.string().max(128).nullable().optional(),
  userAgent: z.string().max(1024).nullable().optional(),
  attestation: hostAttestationInputSchema.optional(),
});

export const publishEventOutputSchema = z.object({
  eventId: z.uuid(),
  status: z.literal("PUBLISHED"),
  publishedAt: z.date(),
  /**
   * Booking-hold notifications this publish owes (FR-018: the event took
   * its dates from the holds on its calendar). Present only on the LIVE
   * return — an idempotent replay carries none, so nothing is sent twice.
   */
  notificationIntents: z.array(bookingHoldNotificationIntentSchema).optional(),
  staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable().optional(),
});

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const publishEventWireOutputSchema = publishEventOutputSchema.omit({
  notificationIntents: true,
  staffRecipientHint: true,
});

export type PublishEventInput = z.infer<typeof publishEventInputSchema>;
export type PublishEventOutput = z.infer<typeof publishEventOutputSchema>;
export type PublishEventWireOutput = z.infer<typeof publishEventWireOutputSchema>;

export type PublishEventDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * `canManagePlace` — REQUIRED (place-address-withholding W1): publishing a
   * place-linked event is the venue's own word when the PUBLISHER can manage
   * the place, and stamps the venue confirmation like a save does
   * (`venue-manager-stamp.ts`). Wire it from `ctx.authz`.
   */
  authz: Pick<AuthZPort, "canManagePlace">;
  /**
   * Optional search port. When provided, the just-published event is
   * incrementally upserted into the search index so it appears in
   * autocomplete / discovery without waiting for the next full reindex.
   * Failures are logged but never block the publish.
   */
  search?: MultiSearchPort;
  /**
   * Best-effort Sentry reporter. Covers two swallows:
   *   1. the fire-and-forget reindex, which never reaches a tRPC/fastify
   *      backstop, so without this a dropped index update is invisible (a bare
   *      `logger.warn` is NOT captured); and
   *   2. the missing-fee-policy branch — a FREE event publishes anyway when no
   *      policy resolves at any scope, which is a deliberate swallow of a
   *      PLATFORM misconfiguration the organizer cannot fix. Reported on the
   *      paid path too (immediately before the throw), because the first-ever
   *      publish on a platform with no GLOBAL policy is exactly the incident
   *      that must page us rather than page the organizer.
   * Wire it from `ctx.reportError` (CLAUDE.md error convention).
   */
  reportError?: ReporterPort;
  /**
   * Optional tax-rate provider used as a publish-time safety net. When the
   * event's backing location (Place or SavedLocation) has no cached rate yet
   * (e.g. created before the cache existed, or a prior lookup failed), publish
   * does a last-chance lookup BEFORE its transaction and caches the answer
   * onto that location inside it, by compare-and-set. Non-fatal: a null rate
   * still publishes, stamped NULL, which checkout resolves.
   */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * Post-commit "you're on the lineup" sweep (owner ruling "option A",
   * 2026-09-30) — `makeLineupNoticeHooks` from
   * event-humans/notify-lineup-notices. Run after every LIVE DRAFT →
   * PUBLISHED transition (first publish AND re-publish), AWAITED inside the
   * request (Cloud Run starves post-response work) with concurrency 4 and a
   * ~10s budget for starting sends. It tells each owed lineup row exactly
   * once (SENT claim). Never run on an idempotent replay or the
   * already-PUBLISHED echo. Never throws: failures are reported via
   * `reportError`, and a notice failure never fails the publish.
   */
  lineupNotices?: Pick<LineupNoticeHooks, "dispatch">;
};

interface StoredPublishEventRecord {
  payloadHash: string;
  /** Wire-shaped: a replay must never re-emit the hold intents. */
  response: PublishEventWireOutput;
}

export async function publishEvent(
  deps: PublishEventDeps,
  rawInput: unknown,
): Promise<PublishEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "publishEvent" });

  const execute = async () => {
    const input = parseInput(publishEventInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(
      input.actorHumanId,
      input.clientKey,
    );

    const replay =
      await deps.idempotency.get<StoredPublishEventRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredPublishEventRecord>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    // W1: does the PUBLISHER manage the event's place? Probed here, before
    // the transaction (the probe reads on its own connection; see
    // `probeManagedPlace`). The tx honours it only for the same place.
    let managedPlaceId: string | null = null;
    try {
      const preRead = await deps.repos.events.getById(input.eventId);
      managedPlaceId = await probeManagedPlace(deps.authz, {
        actorHumanId: input.actorHumanId,
        placeId: preRead?.placeId ?? null,
      });
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw error;
    }

    // Set INSIDE the publish transaction, acted on AFTER it commits. The
    // first-publish slug re-derive is cosmetic and must never be able to take
    // the publish down with it — see `rederiveSlugAfterFirstPublish` for why
    // "wrap it in a try/catch inside the tx" is not an option.
    // Held in a CONTAINER, not a bare `let`. TypeScript's control-flow
    // analysis does not track assignments made inside a nested function, so a
    // `let … | null = null` mutated in the tx callback is narrowed to `null`
    // at every later use — and `if (x)` then narrows it to `never`, which is
    // assignable to ANY parameter type. The guarded call would typecheck no
    // matter what shape the helper expected. Narrowing a PROPERTY has no such
    // hole, so the call site stays checked. (Verified: planting a required
    // field on the helper's params is caught here and was not before.)
    const rederive: { intent: { eventId: string; at: Date } | null } = {
      intent: null,
    };
    // Same container reasoning as `rederive`: set inside the tx once the
    // status write happened, acted on after the commit.
    const lineupSweep: { due: boolean } = { due: false };
    // The venue tax-rate cache the stamp below FILLED, if it did: its other
    // unstamped events are re-indexed after the commit.
    const taxCacheFill: { target: TaxRateCacheTarget | null } = {
      target: null,
    };

    try {
      // The tax-rate READ, including any provider round trip (a live HTTP
      // call, up to 5s), runs here, before the transaction, so it never holds
      // a Postgres connection. The transaction re-checks it under the
      // place-location lock: see the stamp below.
      const preparedTaxRate = await preparePublishTaxRate(
        deps,
        input,
        scopedLogger,
      );

      const result = await deps.repos.tx(async (tx) => {
        const now = deps.clock.now();
        const accessible = await ensureEventAccessible(
          tx,
          input.eventId,
          input.actorHumanId,
        );

        // LOCKS, venue first and row second, before ANY write in this
        // transaction (the order `EventsRepo.lockRows` documents):
        //
        // 1. SHARED place-location lock on the venue the event points at.
        //    `upsertPlace` takes it EXCLUSIVE before it moves a venue and
        //    caches the new address's rate, so the venue cannot move between
        //    the stamp's re-read of it below and the commit. `upsertPlace`
        //    holds it while it rewrites the event rows at the venue, so a
        //    publish that had already row-locked this event and then waited
        //    here could deadlock it: hence first.
        // 2. FOR UPDATE on the event row, then the re-read everything below
        //    acts on. The venue lock pins the venue's ADDRESS, not WHICH
        //    venue the event points at: an event save that re-points it
        //    (taking the shared lock on the NEW venue only) could otherwise
        //    commit between `accessible` and the stamp, and publish would
        //    stamp the old venue's rate on an event at the new one. The row
        //    lock waits that save out and blocks any later one to commit.
        const lockedPlaceId = accessible.placeId ?? null;
        if (lockedPlaceId) {
          await tx.events.lockLocationsAtPlace({
            placeId: lockedPlaceId,
            mode: "shared",
          });
        }
        await tx.events.lockRows({ ids: [accessible.id], mode: "update" });
        const event = await tx.events.getById(accessible.id);
        if (!event) {
          throw fail("EVENT_NOT_FOUND");
        }
        if (
          event.orgId !== accessible.orgId ||
          event.humanId !== accessible.humanId
        ) {
          // The access check above was for the owner the row no longer has.
          await ensureEventAccessible(tx, event.id, input.actorHumanId);
        }

        // FR-003 (community-managed-event-listings): RSVP events never route
        // through publishEvent — COMMUNITY listings are created directly
        // PUBLISHED by create-community-listing. Failing fast here is
        // defense-in-depth so the currency/tax/attestation/ticket stamping
        // below never has to branch on attendance mode. The guard
        // INTENTIONALLY precedes the idempotent already-PUBLISHED return:
        // re-publishing an already-PUBLISHED RSVP event must yield
        // EVENT_NOT_TICKETED, never a success-shaped echo.
        if (event.attendanceMode === "RSVP") {
          throw fail("EVENT_NOT_TICKETED");
        }

        if (event.status === "PUBLISHED") {
          return publishEventOutputSchema.parse({
            eventId: event.id,
            status: event.status,
            publishedAt: event.publishedAt ?? now,
          });
        }

        ensureEventPublishable(event);

        // Which location the stamp comes from: the LOCKED row's. When a save
        // re-pointed the event to another venue before the row lock was
        // granted, this publish holds the venue lock for the OLD venue, not
        // the new one, and cannot take it now (venue lock after row lock is
        // the order that deadlocks `upsertPlace`). An unlocked read of the new
        // venue's rate could be one `upsertPlace` is replacing as we read, so
        // the venue is not read and the pre-transaction rate (for the old
        // venue) is never used. Nor is the stamp already on the row: not every
        // path that re-points an event restamps it (a template apply and a
        // series sync move a draft through `upsertDraft`, which never touches
        // the stamp), so it can still be the OLD venue's rate, which
        // checkout's fast path would trust for every sale. The stamp is
        // published NULL, "unresolved": checkout re-resolves from the new
        // venue's cached rate, and charges 0 only for an order where that
        // cache is empty AND the provider fails.
        const taxRef = eventTaxRateLocationRef(event);
        const venueUnlocked =
          taxRef?.kind === "place" && taxRef.placeId !== lockedPlaceId;
        if (venueUnlocked) {
          scopedLogger?.info("tax_rate_stamp_cleared_venue_repointed", {
            eventId: event.id,
            lockedPlaceId,
            placeId: taxRef.placeId,
          });
        }

        const ticketTypes = await ensureTicketTypesReady(tx, event.id);
        // Does this event take money? Every money gate below (chargeback
        // terms, Stripe, the fee policy) asks this ONE answer.
        const tiersTakeMoney = ticketTypes.some(isEverPaidTicketType);
        const seatOverrides = tiersTakeMoney
          ? null
          : await storedSeatOverridesTakeMoney(tx, event, ticketTypes, {
              logger: scopedLogger,
              reportError: deps.reportError,
            });
        const paidSeatOverrides = seatOverrides?.takesMoney ?? false;
        const takesMoney = tiersTakeMoney || paidSeatOverrides;
        // Version-agnostic backstop: the strict current-version gate lives at
        // Stripe Connect onboarding (see lib/payments/chargeback-terms.ts).
        // Here we only refuse owners with NO acceptance at all, so a terms
        // version bump never blocks publishing.
        await requireAnyChargebackTermsForPaidEvent({
          repos: tx,
          event,
          ticketTypes,
          paidSeatOverrides,
        });
        await ensureNoIssuedTickets(tx, event.id);
        await ensureStripeConnectedForPaidEvent(
          tx,
          event,
          takesMoney,
          seatOverrides?.corruptOnlySectionIds ?? [],
        );

        // Host responsibilities attestation is only required for private
        // locations (any OBSCURED-address event — obfuscated circle or fully
        // hidden). Commercial venues carry their own liability and licensing,
        // so we don't burden them with the checkbox. The client mirrors this
        // gate in EventBuilder.
        const requiresHostAttestation = event.locationMode === "OBSCURED";
        const attestation = requiresHostAttestation
          ? ensureHostAttestationComplete(input.attestation)
          : null;

        // freeze-the-deal (NFR-001): every terms row the deal covers is
        // locked BEFORE the gates read it, under the event row held above
        // (event → terms, the order in deal-freeze.ts). The lines the gates
        // validate are then the lines that go on sale and freeze: no deal
        // write can land between the check and the freeze below.
        await lockEventDealTerms(tx, event.id);

        await ensureAgreementsReady({
          tx,
          event,
          ticketTypes,
          takesMoney,
          now,
          logger: scopedLogger,
          reportError: deps.reportError,
        });

        // Resolve the organizer's currency from their Stripe Connect account.
        // This is the single source of truth for the event's pricing currency.
        const eventCurrency = await resolvePayeeCurrency(tx, event);

        // ── Stamp admission tax rate from the event's location ─────────────
        // Stamp the rate from the event's Place / SavedLocation / inline
        // address onto the Event so checkout can compute tax with zero API
        // calls. The rate was prepared before this transaction (last-chance
        // lookup included); the venue may have moved since. Under the lock
        // taken above this re-reads the row, drops a rate looked up for an
        // address the venue no longer has (stamping its current cached rate,
        // else NULL), and caches a fresh answer only by compare-and-set, so
        // it can never put a moved venue's old rate back. No provider call in
        // here. Non-fatal: a null stamp still publishes, and checkout
        // resolves a NULL stamp at the next sale (never as 0%).
        const taxStamp = venueUnlocked
          ? null
          : await commitPreparedEventTaxRateForRef(
              { clock: deps.clock, reportError: deps.reportError },
              tx,
              taxRef,
              preparedTaxRate,
              scopedLogger,
              { eventId: event.id },
              {
                onCacheFilled: (target) => {
                  taxCacheFill.target = target;
                },
              },
            );
        // TN instruction-only exemption: when the event is flagged
        // instructional AND its resolved situs is US/TN, zero the stamped rate
        // (source "exempt:tn-instruction") so the persisted stamp is correct
        // for checkout display + estimate-checkout-tax. No-op elsewhere.
        const exemptStamp = taxStamp
          ? applyInstructionExemption({
              instructionalAdmission: event.instructionalAdmission,
              situs: taxStamp.situs,
              rateBps: taxStamp.rateBps,
              source: taxStamp.source,
            })
          : null;

        const attestationRecord = attestation
          ? await tx.events.createAttestation({
              eventId: event.id,
              attestedByHumanId: input.actorHumanId,
              attestedAt: now,
              ipAddress: input.ipAddress ?? null,
              userAgent: input.userAgent ?? null,
              policyVersion: HOST_ATTESTATION_VERSION,
              policyTextSnapshot: HOST_ATTESTATION_TEXT,
              ...attestation,
              metadata: {
                source: "publish_event",
              },
            })
          : null;

        // Captured BEFORE the status write: `tx.events.publish` stamps
        // `publishedAt`, so afterwards there is no way to tell a first publish
        // from a re-publish. The slug re-derive below hangs off this.
        const wasNeverPublished = event.publishedAt === null;

        // freeze-the-deal FR-002: going on sale freezes the whole deal
        // (ruling F1), in this transaction, after `ensureAgreementsReady`
        // activated the terms. The event row is ours (`lockRows` above); the
        // helper takes every terms row's lock before setting the freeze, so
        // a concurrent deal save either commits first or reads the freeze
        // and is refused (NFR-001). Called on EVERY publish, not only the
        // first: an event published before freezes existed and unpublished
        // when the backfill ran (it freezes PUBLISHED events only) would
        // otherwise go back on sale unfrozen. On a frozen deal it is a
        // no-op: an unpublish never unfreezes, and an earlier freeze (the
        // organiser's manual one included) is never overwritten.
        await freezeEventDealOnLockedRow(tx, {
          eventId: event.id,
          at: now,
          frozenByHumanId: null,
          source: "PUBLISH",
          actorHumanId: input.actorHumanId,
        });

        const publishedRow = await tx.events.publish({
          eventId: event.id,
          publishedAt: now,
          currentAttestationId: attestationRecord?.id ?? null,
          currency: eventCurrency,
          admissionTaxRateBps: exemptStamp?.rateBps ?? null,
          taxRateSource: exemptStamp?.source ?? null,
        });

        lineupSweep.due = true;

        // W1: a publisher who can MANAGE the event's place is the venue
        // speaking — stamp the confirmation (same write as the save path),
        // BEFORE the held-dates settle below, whose gate reads the stamp.
        // A venue-owned event (owner arm) and a deliberate withdrawal are
        // left alone.
        const published = await stampForPlaceManager(tx, {
          event: publishedRow,
          actorHumanId: input.actorHumanId,
          managedPlaceId,
          at: now,
        });

        // FR-018: the event takes its dates from the holds on its calendar
        // — inside this tx, so an open challenge on one of them refuses the
        // publish (HOLD_LINE_HAS_OPEN_CHALLENGE) and rolls the status write
        // back with it: nothing is committed. Events with no calendar never
        // touch a hold.
        //
        // AFTER the status write, on the `published` row, deliberately.
        // `event` is the re-read taken under the `lockRows` row lock at the
        // top of this transaction, but it predates this transaction's own
        // writes (the venue-manager stamp above, the status write), so only
        // `published` carries them. The E row lock is held from `lockRows`
        // on, and the hold lines are locked only here, after it — the same
        // E-row → line order `confirmVenueEvent` (stamp, then settle) and
        // `finalizeSaveEvent` (upsert, then settle) use. Confirm cannot
        // interleave: it blocks on our row lock and then sees PUBLISHED, or
        // it stamped first and our `lockRows` waited for its commit, so the
        // stamp is on the row we read and on `published`.
        const heldDates = await settleHeldDatesForEvent(tx, {
          event: published,
          now,
          actorHumanId: input.actorHumanId,
          owner: heldDatesOwnerOf(published),
        });

        // Activate DRAFT ticket types now that the event is live.
        await tx.tickets.activateDraftTicketTypes(event.id);

        // Booking timeline: a show minted from an agreement logs "published"
        // on its booking thread. Silent for every other event. Same tx as the
        // publish so the entry never describes a publish that rolled back.
        await appendBookingEventPublishedEntry(tx, {
          event: published,
          actorHumanId: input.actorHumanId,
        });

        // Only audit-log the attestation when one was actually recorded —
        // i.e. for private locations. Non-private events skip both the
        // requirement and this audit row.
        if (attestationRecord && attestation) {
          await tx.audit.log({
            entity: "event",
            entityId: event.id,
            action: "event.attestation_recorded",
            data: {
              actorHumanId: input.actorHumanId,
              attestationId: attestationRecord.id,
              policyVersion: HOST_ATTESTATION_VERSION,
              acknowledgedFields: HOST_ATTESTATION_FIELDS,
              acknowledgements: Object.fromEntries(
                HOST_ATTESTATION_FIELDS.map((field) => [
                  field,
                  attestation[field],
                ]),
              ),
            },
            at: now,
          });
        }

        await tx.audit.log({
          entity: "event",
          entityId: event.id,
          action: "published",
          data: {
            actorHumanId: input.actorHumanId,
            ticketTypeIds: ticketTypes.map((tt) => tt.id),
          },
          at: now,
        });

        let finalEvent = published;

        if (!published.slug) {
          // No slug at all. Reachable even now that events are slugged at
          // create: `assignSlugOnCreate` is best-effort and gives up when the
          // event has no resolvable country code, while `ensureEventPublishable`
          // only demands SOME location. Assigning here is NOT best-effort — a
          // published event without a URL is not a publishable state, so a
          // failure refuses the publish exactly as it always has.
          //
          // No `EventSlugHistory` row is written. That table holds SUPERSEDED
          // slugs only: `resolveBySlug` checks `Event.slug` first and reaches
          // history only on a miss, so a row for the CURRENT slug is
          // unreachable — and because `EventSlugHistory.slug` is GLOBALLY
          // `@unique`, writing it here is what made the first
          // `regenerateEventSlug` after a publish die on P2002 (that call sits
          // outside the try/catch that maps the conflict).
          const slugContext = await tx.events.getSlugContext(event.id);
          if (!slugContext) {
            throw fail("EVENT_SLUG_CONTEXT_MISSING");
          }

          const generated = generateEventSlug(slugContext);

          try {
            finalEvent = await tx.events.assignSlug({
              eventId: event.id,
              slug: generated.slug,
              shortId: generated.shortId,
              regionCode: generated.regionCode,
              assignedAt: now,
            });
          } catch (error) {
            throw mapSlugAssignmentError(error);
          }

          await tx.audit.log({
            entity: "event",
            entityId: event.id,
            action: "event.slug_assigned",
            data: {
              slug: generated.slug,
              shortId: generated.shortId,
            },
            at: now,
          });
        } else if (wasNeverPublished) {
          // The event already carries a slug that was minted at CREATE, from
          // whatever the title was at the moment the organiser hit "Create" —
          // frequently a placeholder ("Untitled", or half-typed). The live
          // URL must reflect the FINAL title, so re-derive once, on the FIRST
          // publish only. An event that has been published before keeps its
          // slug: it has been shared, indexed and printed, and rewriting it on
          // a re-publish would move the page out from under those links.
          // Renaming a live event stays an explicit act (`regenerateEventSlug`).
          //
          // Only the INTENT is recorded here. The work itself happens after
          // this transaction commits, in one of its own.
          rederive.intent = { eventId: event.id, at: now };
        }

        await markForSearchReindex(
          tx,
          [{ kind: "event", id: finalEvent.id }],
          now,
        );

        if (wasNeverPublished) await enqueueEventFollowers(tx, finalEvent, now);

        return publishEventOutputSchema.parse({
          eventId: finalEvent.id,
          status: finalEvent.status,
          publishedAt: finalEvent.publishedAt ?? now,
          ...(heldDates.intents.length > 0
            ? {
                notificationIntents: heldDates.intents,
                staffRecipientHint: heldDates.staffRecipientHint,
              }
            : {}),
        });
      });

      await deps.idempotency.commit<StoredPublishEventRecord>(idempotencyKey, {
        payloadHash,
        response: publishEventWireOutputSchema.parse(result),
      });

      // Ordered before the reindex on purpose: the index should carry the
      // final slug, not the create-time one it is about to supersede.
      if (rederive.intent) {
        await rederiveSlugAfterFirstPublish(
          {
            repos: deps.repos,
            logger: scopedLogger,
            reportError: deps.reportError,
          },
          rederive.intent,
        );
      }

      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        "publishEvent",
        { kind: "event", id: result.eventId },
      );

      // The fill made a rate known for every unstamped event at this venue;
      // their search cards were built without one. Fire-and-forget, after
      // the commit (this event is re-indexed just above).
      if (taxCacheFill.target) {
        reindexEventsAtTaxLocation(
          {
            repos: deps.repos,
            search: deps.search,
            clock: deps.clock,
            logger: deps.logger,
            reportError: deps.reportError,
          },
          taxCacheFill.target,
          { now: deps.clock.now(), useCase: "publishEvent" },
        );
      }

      if (lineupSweep.due) {
        await sweepLineupNoticesAfterPublish(
          { ...deps, logger: scopedLogger },
          result.eventId,
          "publishEvent",
        );
      }

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("publish_event", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("publishEvent", execute);
  }

  return execute();
}

/**
 * The publish's tax-rate READ, run before its transaction so the provider
 * round trip never holds a Postgres connection.
 *
 * Gated so a publish the transaction will refuse or short-circuit for a
 * reason knowable up front spends no paid provider call. Mirrored here:
 *  - the access check (`ensureEventAccessible`; it runs again in the
 *    transaction, authoritatively, and its error is thrown from here);
 *  - RSVP (refused) and already-PUBLISHED (returns early);
 *  - the pure publishability gate ({@link eventPublishableFailure}: DRAFT,
 *    category, some location);
 *  - the host attestation for an OBSCURED event
 *    ({@link missingHostAttestationFields}).
 * Everything except the access check is a PREDICATE here: it returns `null`
 * and lets the transaction throw, so error precedence is unchanged.
 *
 * NOT mirrored: the gates that need queries — `TICKET_TYPES_REQUIRED`,
 * chargeback terms, `TICKETS_ALREADY_ISSUED`, the Stripe Connect check, the
 * agreement / fee-policy gates (`PRIMARY_AGREEMENT_MISSING` …). One of those
 * can still refuse a publish after a lookup was spent; duplicating them here
 * would double the reads on every publish to save a lookup on a refusal.
 *
 * Returns `null` when nothing was prepared; the transaction then resolves
 * from the row without the provider. A repo fault is reported and rethrown
 * inside `prepareEventTaxRate`.
 */
async function preparePublishTaxRate(
  deps: Pick<
    PublishEventDeps,
    "repos" | "taxRateLookup" | "clock" | "reportError"
  >,
  input: PublishEventInput,
  logger: LoggerPort | undefined,
): Promise<PreparedEventTaxRateForRef | null> {
  const event = await ensureEventAccessible(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );
  if (
    event.attendanceMode === "RSVP" ||
    eventPublishableFailure(event) !== null ||
    (event.locationMode === "OBSCURED" &&
      missingHostAttestationFields(input.attestation).length > 0)
  ) {
    return null;
  }
  const ref = eventTaxRateLocationRef(event);
  const prepared = await prepareEventTaxRate(
    {
      taxRateLookup: deps.taxRateLookup,
      clock: deps.clock,
      reportError: deps.reportError,
    },
    deps.repos,
    ref,
    logger,
    { eventId: event.id },
  );
  return { ref, prepared };
}

async function ensureEventAccessible(
  tx: TxRepos,
  eventId: string,
  actorHumanId: string,
): Promise<EventRecord> {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(tx.authz, event.humanId, actorHumanId);
  }

  return event;
}

/**
 * The pure (no-query) publishability gate: the error code
 * {@link ensureEventPublishable} throws, or `null` when the event passes.
 * Also read by {@link preparePublishTaxRate}, as a predicate.
 */
function eventPublishableFailure(
  event: EventRecord,
):
  | "EVENT_NOT_PUBLISHABLE"
  | "EVENT_CATEGORY_MISSING"
  | "EVENT_LOCATION_REQUIRED"
  | null {
  if (event.status !== "DRAFT") {
    return "EVENT_NOT_PUBLISHABLE";
  }
  if (!event.categoryId) {
    return "EVENT_CATEGORY_MISSING";
  }
  // An event must have a location — without one the event detail page can't render.
  if (!event.placeId && !event.savedLocationId && !event.addressText) {
    return "EVENT_LOCATION_REQUIRED";
  }
  return null;
}

function ensureEventPublishable(event: EventRecord): void {
  const failure = eventPublishableFailure(event);
  if (failure) {
    throw fail(failure);
  }
}

/** The attestation fields still missing; empty when it is complete. */
function missingHostAttestationFields(
  attestation: PublishEventInput["attestation"],
): HostAttestationField[] {
  return HOST_ATTESTATION_FIELDS.filter(
    (field): field is HostAttestationField => attestation?.[field] !== true,
  );
}

function ensureHostAttestationComplete(
  attestation: PublishEventInput["attestation"],
): CompleteHostAttestation {
  const missingFields = missingHostAttestationFields(attestation);

  if (missingFields.length > 0) {
    throw {
      code: "attestation_incomplete",
      message: "attestation_incomplete",
      meta: { missingFields },
    } as const;
  }

  return attestation as CompleteHostAttestation;
}

async function ensureTicketTypesReady(
  tx: TxRepos,
  eventId: string,
): Promise<EventTicketTypeSummary[]> {
  const ticketTypes = await tx.events.listTicketTypes(eventId);
  if (ticketTypes.length === 0) {
    throw fail("TICKET_TYPES_REQUIRED");
  }

  for (const ticketType of ticketTypes) {
    if (ticketType.capacity <= 0) {
      throw fail("TICKET_TYPE_CAPACITY_INVALID");
    }
  }

  return ticketTypes;
}

async function ensureNoIssuedTickets(
  tx: TxRepos,
  eventId: string,
): Promise<void> {
  const issued = await tx.tickets.countIssuedForEvent(eventId);
  if (issued > 0) {
    throw fail("TICKETS_ALREADY_ISSUED");
  }
}

type EnsureAgreementsReadyArgs = {
  tx: TxRepos;
  event: EventRecord;
  /**
   * The event's ticket types, already loaded and validated by
   * `ensureTicketTypesReady`. Threaded in (rather than re-listed) because the
   * fee-policy gate below is conditional on whether ANY tier can ever take
   * money, and because the resale gate further down needs the same rows.
   */
  ticketTypes: EventTicketTypeSummary[];
  /**
   * Whether the event takes money: a tier that is EVER paid, or a seat a
   * FIXED tier sells at a paid override. Computed once by the caller, so the
   * fee-policy gate here and the Stripe gate ask the same question.
   */
  takesMoney: boolean;
  now: Date;
  logger: LoggerPort | undefined;
  reportError: ReporterPort | undefined;
};

async function ensureAgreementsReady({
  tx,
  event,
  ticketTypes,
  takesMoney,
  now,
  logger,
  reportError,
}: EnsureAgreementsReadyArgs): Promise<void> {
  // Select the event's primary terms: kind precedence PRIMARY then the legacy
  // PRIMARY_SPLIT, and within a kind prefer ACTIVE over PENDING. ARCHIVED rows
  // are never candidates. PENDING is eligible because organizer-authored terms
  // (event-builder splits, fee-mode edits, booking clones) are created PENDING
  // and become validated-in-force here: once every downstream gate passes,
  // publish CAS-activates the row (end of this function). The real gates per
  // event-revenue-splits.spec.md — lines present, fee policy resolved, splits
  // reconciling, payees payout-ready — all still apply; status alone no
  // longer blocks.
  const findPrimary = (records: PayoutTermsRecord[]) => {
    const pickByKind = (kind: string) => {
      const candidates = records.filter(
        (t) => (t.kind as string) === kind && t.status !== "ARCHIVED",
      );
      return (
        candidates.find((t) => t.status === "ACTIVE") ??
        candidates.find((t) => t.status === "PENDING")
      );
    };
    return pickByKind("PRIMARY") ?? pickByKind("PRIMARY_SPLIT");
  };

  // Negotiated terms on a REQUESTER-owned event are never bypassed. The
  // narrow rule (review ruling, 2026-09-07): refuse ONLY when an ACCEPTED
  // booking agreement anchors this event, is NOT finalize-linked to it
  // (`agreement.eventId !== event.id` — finalize is the only writer of that
  // link, in the same tx that links the terms), AND the event is NOT the
  // agreement's venue counterparty's. That is exactly the requester-owned
  // mint (`finalizeBlocked: "requester_owned"`), where `tryFinalize` never
  // attempts a finalize at all — so without this the auto-provision below
  // would mint fresh 100%-owner terms and quietly ignore the deal. A
  // VENUE-owned event keeps the pre-existing "publish now, finalize later"
  // flow: its blocked finalize (`lines_unconfirmed` / `payee_not_ready`) is
  // the designed partial outcome, and the venue publishing its own show is
  // not bypassing anyone. A DRAFT / negotiating agreement (the hold-confirm
  // mint runs under DRAFT) has no agreed position to protect. Note
  // `findByLinkedEventId` prefers the finalized link, so a foreign draft
  // anchor on an event some other agreement finalized onto is invisible here
  // (contrived, and the money link is the right answer anyway).
  const thread = await findBookingThreadForEvent(tx, event.id);
  if (
    thread &&
    thread.agreement.status === "ACCEPTED" &&
    thread.agreement.eventId !== event.id &&
    !isVenueCounterpartyEvent(event, thread.agreement)
  ) {
    throw fail("BOOKING_TERMS_NOT_FINALIZED", {
      meta: {
        eventId: event.id,
        agreementId: thread.agreement.id,
        bookingRequestId: thread.bookingRequest.id,
        payoutTermsId: thread.agreement.payoutTermsId,
      },
    });
  }

  const terms = await tx.payoutTerms.listByEvent(event.id);
  let primary = findPrimary(terms);

  if (!primary) {
    // Auto-provision a default 100%-to-owner PRIMARY agreement when the owner
    // has an ACTIVE payee. Returns null (no usable payee) → fall through to the
    // original error. Idempotent: re-publish never duplicates.
    const provisioned = await ensureDefaultPrimaryPayoutTerms(
      tx,
      event,
      now,
      logger,
    );
    if (provisioned) {
      const refreshed = await tx.payoutTerms.listByEvent(event.id);
      primary = findPrimary(refreshed);
    }
  }

  if (!primary) {
    throw fail("PRIMARY_AGREEMENT_MISSING");
  }

  let lines = await tx.payoutTerms.listLines(primary.id);
  if (lines.length === 0) {
    // Repair the lineless sub-paths. Two ways a linked primary has no lines:
    //   · the fee-mode-only path: the since-removed setEventFeeMode
    //     auto-created a LINELESS PENDING draft and linked it when an event
    //     had no terms yet; such rows still exist
    //     (first-time organizers — their entity default is only minted at
    //     first publish). `ensureDefaultPrimaryPayoutTerms` refuses to touch
    //     linked rows, so without this a single fee-mode toggle before ever
    //     saving splits walls the organizer at AGREEMENT_MISSING_LINES;
    //   · booking-managed terms whose requester had no payout-ready Payee at
    //     accept (`accept-agreement`'s requester seed writes nothing) and
    //     were then finalized lineless (finalize activates them as-is) — a
    //     dead end with no editor left to repair it after finalize.
    // Seed the same default 100%-to-owner line auto-provision would have
    // written — only when the owner has a usable payee; otherwise fall
    // through to the error, exactly as a non-booking owner without a Payee
    // does today.
    lines =
      (await seedDefaultOwnerLineForLinelessDraft(
        tx,
        event,
        primary,
        now,
        logger,
      )) ?? lines;
  }
  if (lines.length === 0) {
    throw fail("AGREEMENT_MISSING_LINES");
  }

  let feePolicy: FeePolicyRecord | null = null;
  if (primary.feePolicyId) {
    feePolicy = await tx.feePolicies.getById(primary.feePolicyId);
  }

  if (!feePolicy) {
    feePolicy = await resolveScopedFeePolicy(
      tx,
      { eventId: event.id, orgId: event.orgId },
      now,
      { logger, reportError, source: "publishEvent" },
    );

    if (feePolicy) {
      // Pin the resolved version even for a free event: if a tier later flips
      // to paid, the sale runs on the policy that was in force at publish
      // rather than whatever happens to be effective at checkout. A pin
      // carries RATES; its `feeMode` is never read for pricing
      // (SALE_FEE_MODE, docs/decisions/absorb-removed.md), so there is no
      // ABSORB policy to refuse any more.
      await tx.payoutTerms.pinFeePolicy({
        payoutTermsId: primary.id,
        feePolicyId: feePolicy.id,
      });
    } else if (!feePolicy) {
      // Nothing resolved at EVENT, ORG or GLOBAL scope: the PLATFORM has no
      // fee policy. That is our misconfiguration, not the organizer's — they
      // have no surface anywhere in the product that can create one — so it
      // must be visible to us on BOTH branches below. A bare `logger.warn`
      // would not be (CLAUDE.md error convention).
      const missing = new Error(
        "fee_policy_unresolved_at_publish: no fee policy in force at EVENT, ORG or GLOBAL scope",
      );

      // "EVER paid", not "paid right now" — the same widened predicate the
      // Stripe gate uses, and for the same reason: a tier priced $0 online
      // that is charged at the door, one scheduled to flip to $20 at T, or a
      // $0 tier selling a $50 override seat WILL take money, so it needs the
      // fee policy resolved before publish. See `isEverPaidTicketType`,
      // `storedSeatOverridesTakeMoney` and the note on
      // `ensureStripeConnectedForPaidEvent`.
      const hasPaidTickets = takesMoney;

      reportBestEffort(reportError, missing, {
        tags: {
          useCase: "publishEvent",
          outcome: hasPaidTickets ? "blocked_publish" : "published_free",
        },
        extra: {
          eventId: event.id,
          orgId: event.orgId,
          payoutTermsId: primary.id,
          hasPaidTickets,
        },
      });
      logger?.error("fee_policy_unresolved_at_publish", {
        eventId: event.id,
        orgId: event.orgId,
        payoutTermsId: primary.id,
        hasPaidTickets,
      });

      if (hasPaidTickets) {
        throw fail("FEE_POLICY_NOT_FOUND");
      }

      // A free event charges nothing, splits nothing and settles nothing, so
      // there is no number for a fee policy to influence. Blocking publish
      // here walled the very first organizer on a fresh platform with an error
      // only WE can clear. Publish unpinned; `loadPayoutTermsContext` re-runs
      // this same scope walk at order time, so the free claim path self-heals
      // the moment a GLOBAL policy exists — and a later flip to paid is
      // refused at edit time by `upsertTicketType`'s fee-policy gate.
    }
  }

  // Splits-spec publish gates (event-revenue-splits.spec.md §
  // assertEventPublishable). These layer on top of the existing
  // primary-agreement-exists / lines-exist / fee-policy-resolved gates.
  //
  // Backward-compat: the new gates fire ONLY when the splits-flow has
  // composed lines — i.e. there's at least one line with
  // requiresConfirmation = true (set exclusively by updateEventSplits).
  // Pre-spec events with a single owner line at 100% bypass these gates
  // and continue to publish through the existing path.
  const usesNewSplitsFlow = lines.some((l) => l.requiresConfirmation === true);

  if (usesNewSplitsFlow) {
    // Gate 0: no DECLINED line may still carry a share. The publish gate
    // excludes DECLINED lines from the reconcile total (Gate 1 below), but the
    // checkout/settlement path (`loadPayoutTermsContext` → `computeOrderSplits`)
    // applies NO confirmation filter — every stored line participates in the
    // split, and the remainder is normalized over the full basis. Activating
    // terms that still hold a DECLINED line with percent > 0 would therefore
    // pay the decliner and dilute everyone else, even though the gate "saw" a
    // clean 100%. Force the organizer to remove (or zero) the declined line
    // before publish.
    //
    // (`capPercent` gets its own check — Gate 1b BELOW. This comment used to
    // wave it through on the grounds that a cap "only limits a payout, never
    // grants one"; that was the exact assumption behind a live money bug where
    // the remainder pass handed a capped line its cap straight back.)
    //
    // `floorCents` is deliberately NOT part of this predicate (2026-08).
    // Floors are no longer honoured anywhere in the split math, so a DECLINED
    // line with percent 0 and a stale non-zero floor can receive nothing —
    // exactly the "harmless" case this gate exists to allow. Checking it
    // would block publish on a value the editors no longer surface, with an
    // error (`declined_line_present`) that has no user-facing copy: an
    // invisible, unexplained block. Stale floors in the DB are inert.
    const declinedWithShare = lines.filter(
      (l) => l.confirmationStatus === "DECLINED" && l.percent > 0,
    );
    if (declinedWithShare.length > 0) {
      throw {
        code: "precondition_failed",
        message: "declined_line_present",
        data: {
          lineIds: declinedWithShare.map((l) => l.id),
          payeeIds: declinedWithShare.map((l) => l.payeeId),
        },
      } as const;
    }

    // Gate 1: splits reconcile. Splits divide 100% of the seller's
    // post-fee net — the platform fee + processor fees come off the top
    // in the settlement pipeline before any payee gets paid, so the
    // target is always 100%.
    // PayoutTermsLine.percent is whole percent (0–100); treat DECLINED
    // lines as zero. Tolerance ±1 since storage is integer.
    const totalAllocatedPct = lines
      .filter((l) => l.confirmationStatus !== "DECLINED")
      .reduce((sum, l) => sum + l.percent, 0);
    const target = SPLITS_TARGET_PCT;
    if (Math.abs(totalAllocatedPct - target) > 1) {
      throw {
        code: "precondition_failed",
        message: "splits_total_invalid",
        data: { totalAllocatedPct, targetPct: target },
      } as const;
    }

    // (Gate 1b — caps satisfiable — runs BELOW this block, unconditionally.
    // See the comment there for why it is not fenced by `usesNewSplitsFlow`.)

    // Gate 2: every line's Payee has payoutsEnabled = true. A line whose
    // payee can't actually receive money would silently fail at settlement.
    const linePayees = await tx.payees.getByIds(
      Array.from(new Set(lines.map((l) => l.payeeId))),
    );
    const inactivePayeeIds = linePayees
      .filter((p) => !p.payoutsEnabled)
      .map((p) => p.id);
    if (inactivePayeeIds.length > 0) {
      throw {
        code: "precondition_failed",
        message: "payee_not_active",
        data: { payeeIds: inactivePayeeIds },
      } as const;
    }
  }

  // Gate 1b (ALWAYS ON — deliberately OUTSIDE the `usesNewSplitsFlow` fence
  // above): the caps must be able to reach the whole basis.
  //
  // `requiresConfirmation` is stamped only on NON-OWNER lines, so fencing this
  // behind `usesNewSplitsFlow` exempts every solely-owner terms row — and a
  // single owner line at `percent: 100, capPercent: 50` would publish and then
  // silently retain half of every order. That fence exists for splits-flow UX
  // (confirmation lifecycle, payee activation); this gate guards stored money
  // math, which has no such carve-out.
  //
  // Runs AFTER the fenced gates on purpose: a splits-flow set that neither
  // totals 100% nor satisfies its caps should report the reconcile failure
  // (`splits_total_invalid`, which the editor explains) rather than this
  // INTERNAL-tier code.
  //
  // The predicate itself lives in `caps-satisfiable.ts` — read the note there
  // before touching it. In short: `distributeRemainder` never skips an
  // UNCAPPED line, so one uncapped line always drains the remainder to zero
  // and Σ splits === basis exactly. Only an all-capped set can leave residue,
  // and for one the caps — not `min(percent, cap)` — are the ceilings that
  // matter. The first cut of this gate got that wrong and refused the
  // canonical "venue takes 20%, capped at 5%; organiser takes 80%" deal that
  // the split math handles correctly.
  //
  // DECLINED lines are excluded, matching Gate 1. (Settlement applies no
  // confirmation filter at all — that mismatch is what Gate 0 exists for.)
  const activeLines = lines.filter((l) => l.confirmationStatus !== "DECLINED");
  const capReport = assessCapSatisfiability(activeLines, SPLITS_TARGET_PCT);
  if (!capReport.satisfiable) {
    throw fail("SPLITS_CAPS_UNSATISFIABLE", {
      meta: {
        eventId: event.id,
        payoutTermsId: primary.id,
        totalCapPct: capReport.totalCapPct,
        totalAllocatedPct: capReport.totalPercent,
        targetPct: SPLITS_TARGET_PCT,
        cappedLineIds: capReport.cappedLineIds,
      },
    });
  }

  // ── P4b (deal terms) ── Gate 1c (ALWAYS ON for deal-written terms): a deal
  // write leaves the per-order lines at exactly 100%, so anything else means
  // they were changed underneath — two concurrent writes each adding a set —
  // and the engine would normalise it round-robin rather than pay the deal.
  // DECLINED lines count: settlement pays every line, whatever its
  // confirmation. Legacy terms keep Gate 1's ±1 reconcile, unchanged. See
  // `per-order-lines-total.ts`.
  if (primary.remainderPayeeId) {
    assertPerOrderLinesTotal100(lines, {
      eventId: event.id,
      payoutTermsId: primary.id,
    });
  }

  // Gate 3 (always-on): resale terms present when any TicketType allows
  // resale. Independent of the new splits flow — it's a data-integrity
  // check that catches "you turned on resale on a ticket type but never
  // composed resale terms." Deliberately a presence-only check: it never
  // filters on PayoutTerms.status, so PENDING org-default resale terms don't
  // block publish and need no activation here.
  //
  // Reads the ticket types threaded in from `ensureTicketTypesReady` rather
  // than re-listing them: same transaction, same rows, one fewer query.
  const anyResaleAllowed = ticketTypes.some((tt) => tt.resaleAllowed === true);
  if (anyResaleAllowed && !event.resalePayoutTermsId) {
    throw fail("RESALE_TERMS_MISSING");
  }
  // …and those terms carry a resale clause (organiser-resale-share FR-001):
  // every resale pays the event side a share set up front, so an event that
  // allows resale cannot publish with the clause not set. Same code; the
  // meta reason tells the two apart.
  if (anyResaleAllowed) {
    await requireEventResaleClauseSet(tx, event);
  }

  // ── Activation ────────────────────────────────────────────────────────────
  // Every gate passed: the selected primary is validated-in-force. If it is
  // still PENDING (an organizer-authored draft), CAS-activate it now — in the
  // same transaction as the publish — so downstream consumers (settlement)
  // see ACTIVE terms. A 0-match means a concurrent transition landed first:
  // re-read and accept only ACTIVE; anything else (archived / deleted) makes
  // the primary unusable, which is the existing "no usable primary" error.
  // A DELEGATE publishing a human's event activates only terms the OWNER
  // authored: every PENDING-authoring path (splits, fee mode, agreements) is
  // owner-only payout routing (`ensurePayoutRoutingActor`), and the
  // auto-provision / lineless seed above route 100% to the event's owner.
  if (primary.status === "PENDING") {
    const activated = await tx.payoutTerms.activate({
      payoutTermsId: primary.id,
      expectedFrom: ["PENDING"],
    });
    if (activated) {
      await tx.audit.log({
        entity: "payoutTerms",
        entityId: primary.id,
        action: "activated",
        data: { reason: "activated_at_publish", eventId: event.id },
        at: now,
      });
    } else {
      const current = await tx.payoutTerms.getById(primary.id);
      if (!current || current.status !== "ACTIVE") {
        throw fail("PRIMARY_AGREEMENT_MISSING");
      }
    }
  }
}

/**
 * Seed the default 100%-to-owner line into a LINELESS primary (the
 * `setEventFeeMode` auto-created PENDING shell, or booking-managed terms
 * finalized with zero lines). Mirrors the payee resolution in
 * `ensureDefaultPrimaryPayoutTerms`: the owner must have an ACTIVE payee with
 * payouts enabled, otherwise return `null` and let the caller surface
 * AGREEMENT_MISSING_LINES.
 *
 * The booking fence (same discriminator as `setEventFeeMode` /
 * `updateEventSplits`: `tx.agreements.getByPayoutTermsId`) is narrowed, not
 * dropped: a two-party agreement's terms are never REWRITTEN at publish, but
 * ZERO lines is not a negotiated position — there is no counter-party line
 * to dilute, and the requester-only default the accept path would have
 * seeded is exactly this line. Booking-managed terms are therefore seeded
 * when (and only when) they are lineless, at any non-ARCHIVED status; a
 * non-booking primary is seeded only while PENDING, as before.
 *
 * The seeded line is a plain owner line (`requiresConfirmation: false`), so it
 * flows through the legacy single-owner-line publish path exactly like an
 * auto-provisioned agreement would.
 *
 * The write itself is atomic-if-empty (`seedLinesIfEmpty`): if a concurrent
 * splits save landed real lines after our empty read, the seed is a no-op and
 * the organizer's fresh lines are returned instead — the caller's gates then
 * validate those, and the seed's audit row is NOT written.
 *
 * Returns the refreshed line list (seeded or concurrent), `null` when seeding
 * isn't possible/allowed.
 */
async function seedDefaultOwnerLineForLinelessDraft(
  tx: TxRepos,
  event: EventRecord,
  primary: PayoutTermsRecord,
  now: Date,
  logger: LoggerPort | undefined,
): Promise<PayoutTermsLineRecord[] | null> {
  const bookingAgreement = await tx.agreements.getByPayoutTermsId(primary.id);
  if (!bookingAgreement && primary.status !== "PENDING") {
    return null;
  }

  const subject = derivePayeeSubject(event);
  if (!subject) {
    return null;
  }

  const payeeRef = await tx.payees.getBySubject(subject);
  if (!payeeRef) {
    return null;
  }

  const payee = await tx.payees.getById(payeeRef.id);
  if (!payee || payee.status !== "ACTIVE" || !payee.payoutsEnabled) {
    return null;
  }

  // Atomic conditional insert: the seed lands only if the terms row STILL
  // has zero lines at write time. A concurrent updateEventSplits save that
  // commits between our (empty) read and this write returns `false` here
  // instead of being clobbered — in that case re-read and let the caller
  // run every gate against the organizer's real lines.
  const seeded = await tx.payoutTerms.seedLinesIfEmpty(primary.id, [
    {
      payeeId: payee.id,
      percent: 100,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
      requiresConfirmation: false,
    },
  ]);

  if (!seeded) {
    logger?.info("owner_line_seed_skipped_lines_appeared", {
      eventId: event.id,
      payoutTermsId: primary.id,
    });
    return tx.payoutTerms.listLines(primary.id);
  }

  await tx.audit.log({
    entity: "payoutTerms",
    entityId: primary.id,
    action: "lines_seeded",
    data: {
      reason: bookingAgreement
        ? "seeded_owner_line_on_lineless_booking_terms_at_publish"
        : "seeded_default_owner_line_at_publish",
      eventId: event.id,
      ownerKind: subject.type,
      ownerId: subject.id,
      payeeId: payee.id,
      bookingAgreementId: bookingAgreement?.id ?? null,
    },
    at: now,
  });

  logger?.info("seeded_default_owner_line_at_publish", {
    eventId: event.id,
    payoutTermsId: primary.id,
    payeeId: payee.id,
  });

  return tx.payoutTerms.listLines(primary.id);
}

// ── Stripe connectivity guard ─────────────────────────────────────────────
// When any ticket type has a non-zero price, the organizer must have a fully
// connected Stripe account so that buyers won't hit an error at checkout.

/**
 * Is the event owned by the agreement's VENUE counterparty (the side the
 * accept minted the agreement against)? False = the requester's event.
 */
function isVenueCounterpartyEvent(
  event: Pick<EventRecord, "orgId" | "humanId">,
  agreement: Pick<AgreementRecord, "counterpartyType" | "counterpartyId">,
): boolean {
  return agreement.counterpartyType === "organization"
    ? event.orgId === agreement.counterpartyId
    : event.humanId === agreement.counterpartyId;
}

function derivePayeeSubject(event: EventRecord): GetPayeeBySubjectInput | null {
  if (event.orgId) {
    return { type: "ORGANIZATION", id: event.orgId };
  }
  if (event.humanId) {
    return { type: "HUMAN", id: event.humanId };
  }
  return null;
}

/**
 * Whether a seat override already stored makes this event take money although
 * every tier is free. Checkout charges a FIXED tier's seat at its override (a
 * $0 tier with a $50 seat is a paid order), and the override write gated that
 * price on Stripe and the fee policy only when it was set: either can be gone
 * by publish. Judged by the override rules' own counting and amount rules
 * (`storedSeatOverrideCharges`, spec 2026-08-12). One read, and only when a
 * tier sells a seat section at a FIXED price: no other tier charges one.
 *
 * A stored value checkout refuses (not `{ priceCents: number }`, or a
 * negative, fractional or unsafe amount) in a section a FIXED tier sells
 * COUNTS AS PAID, and is reported. The amount behind it is unknown, so "free"
 * would be a guess, and a safe guess only while every charge path keeps
 * refusing the value. The cost: an organizer whose event is otherwise free is
 * refused `STRIPE_NOT_CONNECTED_OWNER` until they have a ready payee. Nothing
 * in the product lets them clear the seat yet (the override editor's read and
 * write exist, its screen is not shipped), so the Sentry report here is how
 * the row gets repaired today. `corruptOnlySectionIds` names the sections
 * when a corrupt value is the ONLY reason the event takes money, so the
 * Stripe refusal can carry the cause for a later builder message.
 */
async function storedSeatOverridesTakeMoney(
  tx: TxRepos,
  event: EventRecord,
  ticketTypes: readonly EventTicketTypeSummary[],
  diagnostics: {
    logger: LoggerPort | undefined;
    reportError: ReporterPort | undefined;
  },
): Promise<{ takesMoney: boolean; corruptOnlySectionIds: string[] }> {
  const sellsSeatsAtFixedPrice = ticketTypes.some(
    (tt) => tt.seatSectionId != null && tt.pricingMode === "FIXED",
  );
  if (!sellsSeatsAtFixedPrice) {
    return { takesMoney: false, corruptOnlySectionIds: [] };
  }

  const overrides = await tx.seats.listDistinctPriceOverridesByEvent({
    eventId: event.id,
  });
  const charges = storedSeatOverrideCharges(event, ticketTypes, overrides);
  if (charges.invalidSectionIds.length > 0) {
    const invalid = new Error(
      "seat_price_override_invalid_at_publish: a seat a FIXED tier sells stores an override checkout refuses; publish counts it as paid",
    );
    reportBestEffort(diagnostics.reportError, invalid, {
      tags: { useCase: "publishEvent", fault: "seat_price_override_invalid" },
      extra: {
        eventId: event.id,
        seatSectionIds: charges.invalidSectionIds,
      },
    });
    diagnostics.logger?.error("seat_price_override_invalid_at_publish", {
      eventId: event.id,
      seatSectionIds: charges.invalidSectionIds,
    });
  }
  return {
    takesMoney: charges.paid || charges.invalidSectionIds.length > 0,
    corruptOnlySectionIds: charges.paid ? [] : charges.invalidSectionIds,
  };
}

async function ensureStripeConnectedForPaidEvent(
  tx: TxRepos,
  event: EventRecord,
  takesMoney: boolean,
  /**
   * Sections whose corrupt seat override is the only reason this otherwise
   * free event takes money (`storedSeatOverridesTakeMoney`); empty in every
   * other case. Carried on the refusal's `meta`, never read to decide.
   */
  corruptOverrideSectionIds: readonly string[] = [],
): Promise<void> {
  // "Ever paid", not "paid right now". A tier priced $0 today that flips to
  // $20 at T (FR-005), one that is free online but charged at the door, or a
  // $0 tier selling a $50 override seat still needs a connected payee — and
  // publish is the LAST gate before the event is buyable, so missing it here
  // means every paid sale fails with an error the organizer cannot diagnose.
  if (!takesMoney) return;

  const refuse = (): never =>
    corruptOverrideSectionIds.length > 0
      ? fail("STRIPE_NOT_CONNECTED_OWNER", {
          meta: {
            cause: "seat_price_override_invalid",
            seatSectionIds: [...corruptOverrideSectionIds],
          },
        })
      : fail("STRIPE_NOT_CONNECTED_OWNER");

  const subject = derivePayeeSubject(event);
  if (!subject) {
    throw refuse();
  }

  const payeeRef = await tx.payees.getBySubject(subject);
  if (!payeeRef) {
    throw refuse();
  }

  const payee = await tx.payees.getById(payeeRef.id);
  if (!payee) {
    throw refuse();
  }

  if (
    payee.status !== "ACTIVE" ||
    !payee.chargesEnabled ||
    !payee.payoutsEnabled
  ) {
    throw refuse();
  }
}

/**
 * Resolves the event's pricing currency from the organizer's Stripe Connect
 * account `defaultCurrency`. Falls back to "usd" when no payee exists (free
 * events) or the payee has no explicit currency set.
 */
async function resolvePayeeCurrency(
  tx: TxRepos,
  event: EventRecord,
): Promise<string> {
  const subject = derivePayeeSubject(event);
  if (!subject) return "usd";

  const payeeRef = await tx.payees.getBySubject(subject);
  if (!payeeRef) return "usd";

  const payee = await tx.payees.getById(payeeRef.id);
  return payee?.defaultCurrency ?? "usd";
}

function buildPayloadHash(input: PublishEventInput): string {
  const payload = {
    eventId: input.eventId,
    attestation: input.attestation ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  };

  return JSON.stringify(payload);
}

function buildIdempotencyKey(actorHumanId: string, clientKey: string): string {
  return `event:publish:${actorHumanId}:${clientKey}`;
}

/**
 * FIRST-PUBLISH slug re-derive (best-effort, in its OWN transaction).
 *
 * An event is slugged at CREATE now, which means its URL encodes whatever the
 * title was when the organiser first hit save. Publishing is the moment the
 * title is final, so the slug is regenerated once here and the OLD value is
 * written to `EventSlugHistory` — that table's ONLY meaning: superseded slugs.
 * Anyone already holding the create-time draft link keeps working, via
 * `resolveBySlug`'s history lookup, which 308s them to the canonical URL.
 *
 * `updateSlug` deliberately does not touch `shortId`, so the `--<shortId>`
 * suffix is stable across the rename and the two slugs stay obviously the
 * same event.
 *
 * ── WHY THIS IS NOT IN THE PUBLISH TRANSACTION ────────────────────────────
 *
 * It was, wrapped in a try/catch, and that was a silent data-loss bug rather
 * than the safety net it looked like. A statement that fails AT the database
 * puts the Postgres transaction into the aborted state; Postgres then answers
 * the COMMIT with ROLLBACK and NO error, and Prisma does not surface it. So
 * the transaction RESOLVES with the callback's return value while nothing it
 * wrote is in the database. Measured on this repo's Prisma 7.1.0 + PrismaPg:
 * write, swallowed unique violation, return — resolved with the success value,
 * threw nothing, write absent.
 *
 * Applied here that meant `publishEvent` returning `{status: "PUBLISHED"}`,
 * `idempotency.commit` caching that success for 120 seconds, and the reindex
 * firing — for an event that was still DRAFT, with tickets not on sale, no
 * attestation row, and its held-date settlement rolled back.
 *
 * And the trigger is ORDINARY, not a 1-in-36^10 shortId collision.
 * `EventSlugHistory.slug` is GLOBALLY `@unique`, and the Sharing panel this
 * change made visible on drafts puts "Regenerate slug" one click away:
 *
 *   1. create draft "A" → slug S_A assigned at create;
 *   2. rename to "B", Regenerate → history gets S_A, `Event.slug` = S_B;
 *   3. rename back to "A", Regenerate → history gets S_B, `Event.slug` = S_A
 *      (`updateSlug` keeps the shortId, so the regenerated slug is
 *      byte-identical to the create-time one and nothing rejects it);
 *   4. rename to "B" and Publish → first publish, previousSlug = S_A, derived
 *      = S_B, so `recordSlugHistory(S_A)` → P2002, because S_A has been in
 *      history since step 2.
 *
 * Catching around `repos.tx(...)` — what this function does — is a different
 * thing entirely and genuinely works: the callback's rejection propagates,
 * Prisma rolls back cleanly, and the promise rejects where we can see it. The
 * re-slug gets its own transaction; the publish is already committed and
 * cannot be touched by anything that happens in here.
 *
 * `recordSlugHistory` is additionally conflict-tolerant at the adapter
 * (`createMany({ skipDuplicates: true })`), so the flip-flop above is now a
 * no-op rather than a rollback even within this transaction.
 *
 * THE COST, ACCEPTED: a crash between the publish commit and this leaves the
 * create-time slug live. The event is published and fully functional; only the
 * URL is stale, and `regenerateEventSlug` fixes it on demand. That is strictly
 * better than a publish that silently did not happen.
 */
async function rederiveSlugAfterFirstPublish(
  deps: {
    repos: Repos;
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  intent: { eventId: string; at: Date },
): Promise<void> {
  try {
    const slugContext = await deps.repos.events.getSlugContext(intent.eventId);
    if (!slugContext) {
      return;
    }

    let generated;
    try {
      generated = generateEventSlug(slugContext);
    } catch (error) {
      if (isAppError(error) && error.code === "EVENT_LOCATION_REQUIRED") {
        // Expected — no country code. Keep the slug it already has.
        return;
      }
      throw error;
    }

    await deps.repos.tx(async (tx) => {
      // Re-read the live slug INSIDE this transaction. The value captured in
      // the publish tx cannot be trusted here: this runs in a SEPARATE
      // transaction afterwards, and `updateSlug` writes unconditionally. If a
      // Regenerate slug lands in the gap, trusting the stale value would
      // clobber the new slug AND file the wrong one in history — the
      // intermediate slug would then resolve to nothing at all (`resolveBySlug`
      // misses Event.slug, misses history, fails the UUID regex) and 404.
      const current = await tx.events.getById(intent.eventId);
      const currentSlug = current?.slug ?? null;

      // Nothing to supersede, or the live slug is already the derived one
      // (someone regenerated to the same value in the gap). Either way the
      // history row would be wrong and the update a no-op.
      if (!currentSlug || currentSlug === generated.slug) {
        return;
      }

      await tx.events.recordSlugHistory({
        eventId: intent.eventId,
        slug: currentSlug,
        recordedAt: intent.at,
      });

      await tx.events.updateSlug({
        eventId: intent.eventId,
        slug: generated.slug,
        regionCode: generated.regionCode,
        updatedAt: intent.at,
      });

      await tx.audit.log({
        entity: "event",
        entityId: intent.eventId,
        action: "event.slug_rederived_at_publish",
        data: {
          previousSlug: currentSlug,
          newSlug: generated.slug,
        },
        at: intent.at,
      });
    });
  } catch (error) {
    try {
      deps.reportError?.(error, {
        tags: { useCase: "publishEvent", stage: "rederive_slug_at_publish" },
        extra: { eventId: intent.eventId },
      });
    } catch {
      // Best-effort: a throwing reporter must never manufacture a new failure
      // out of a swallowed one.
    }
    deps.logger?.error("event_slug_rederive_at_publish_failed", {
      eventId: intent.eventId,
      error: describeError(error),
    });
  }
}

function mapSlugAssignmentError(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;
    if (code === "conflict") {
      // Preserve the repo error as `cause` so trpc's toTrpcError forwards it
      // to Sentry's linkedErrors integration. The repo's own `{code:
      // "conflict"}` now carries the PrismaClientKnownRequestError as ITS
      // cause (see `handleSlugConstraintError`), so the chain walks all the
      // way to the constraint and row that actually failed. Until that landed
      // this wrapper pointed at a bare two-word object and "conflict" reached
      // monitoring with nothing to diagnose from.
      return {
        code: "conflict",
        message: "event_slug_conflict",
        cause: error,
      } as const;
    }
  }

  return error;
}

export type ResolveTaxRateDeps = {
  taxRateLookup?: TaxRateLookupPort | null;
  clock: ClockPort;
  /** Optional: a repo fault is reported here before it is rethrown. */
  reportError?: ReporterPort;
};

/**
 * Resolve the admission tax rate for an event from whichever location it uses
 * (Place → SavedLocation → inline address), read and written in ONE
 * transaction.
 *
 * NOT used by `publishEvent` (which prepares before its transaction). Kept
 * for the operator backfill (`apps/api/src/scripts/backfill/
 * backfill-tax-rates.ts`), which pre-warms its provider memo outside the
 * transaction so the lookup here is an instant memo hit.
 *
 * The cache write is the compare-and-set `fillTaxRateIfUnset` (via
 * {@link commitPreparedEventTaxRate}), never an unconditional overwrite: a
 * cache that another writer filled, or a row whose address moved, is left
 * alone. A cache miss with no provider answer resolves `null`.
 */
export async function resolveTaxRateForEvent(
  deps: ResolveTaxRateDeps,
  tx: TxRepos,
  event: EventRecord,
  logger: LoggerPort | undefined,
): Promise<{ rateBps: number; source: string } | null> {
  const logContext = { eventId: event.id };
  const prepared = await prepareEventTaxRate(
    deps,
    tx,
    eventTaxRateLocationRef(event),
    logger,
    logContext,
  );
  return commitPreparedEventTaxRate(deps, tx, prepared, logger, logContext);
}
