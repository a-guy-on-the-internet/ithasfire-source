import type { OffsetPaginatedResult } from "../pagination";
import type { EventBody } from "@th/schema";
import type { SetNoteInput, SetNoteResult } from "@th/types/repos/notes";
import type {
  ApplicationFormPurpose,
  ApplyCommunityEditInput,
  AssignEventSlugInput,
  AttachInviteListToEventInput,
  CreateCommunityListingInput,
  BatchUpsertInviteListEntriesInput,
  BatchUpsertResult,
  ContactImportRecord,
  CopyInviteListEntriesInput,
  CreateContactImportInput,
  CountApplicationSubmissionsInput,
  CountSubmissionsByFormInput,
  CreateEventAttestationInput,
  CreateEventApplicationSubmissionInput,
  CreateInviteListEntryInput,
  CreateInviteListInput,
  CreateWaitlistEntryInput,
  DetachInviteListFromEventInput,
  FindOpenApplicationSubmissionInput,
  EventApplicationFormRecord,
  EventApplicationQuestionOption,
  EventApplicationQuestionRecord,
  EventApplicationQuestionSnapshotEntry,
  EventApplicationSubmissionRecord,
  EventAttestationRecord,
  EventGateSettings,
  EventGateType,
  EventInviteListLinkRecord,
  EventLocationMode,
  EventMediaReferenceSet,
  EventOwnerType,
  EventPopularityStats,
  EventRecord,
  OwnerUpcomingEventStats,
  EventSlugContext,
  EventSlugResolution,
  EventSitemapEntryRecord,
  EventStatus,
  EventStewardship,
  EventTicketTypeSummary,
  EventVisibility,
  EventWaitlistEntryRecord,
  InviteListEntryRecord,
  InviteListRecord,
  IncrementContactImportCountsInput,
  ListAllEventsByPlaceInput,
  ListApplicationSubmissionsInput,
  ListContactImportsByOwnerInput,
  ListEventsByOwnerInput,
  WithheldOwnerIds,
  ListInviteListEntriesInput,
  ListInviteListsByOwnerInput,
  ListPublishedOccurrencesByPlaceInput,
  ListWaitlistEntriesInput,
  FindWaitlistEntryInput,
  PlaceOccurrenceRecord,
  SetVenueConfirmationInput,
  VenueConfirmedFor,
  WithdrawVenueConfirmationInput,
  OpenCallAnchor,
  OpenCallFormRecord,
  OpenCallPoster,
  OpenCallDateChoiceRecord,
  OpenCallDateChoiceTarget,
  OpenCallSubmissionRecord,
  OpenCallLineupAct,
  CreateOpenCallSubmissionInput,
  UpdateOpenCallSubmissionInput,
  OpenCallPeerRecord,
  MyOpenCallApplicationRecord,
  PosterOpenCallRecord,
  SeriesEventOpenCallRecord,
  UpsertOpenCallFormInput,
  ApplicationVoteValue,
  ApplicationMessageAuthorSide,
  ListOpenCallReviewCardsInput,
  OpenCallReviewCardRecord,
  ApplicationNoteRecord,
  ApplicationMessageRecord,
  UpdateEventApplicationSubmissionStatusInput,
  RecordEventSlugHistoryInput,
  EventSlugDateRow,
  SetEventSlugOnlyInput,
  ListSluggedEventsPageInput,
  UpdateEventSlugInput,
  DeleteInviteListEntryInput,
  GetInviteListEntryInput,
  UpdateInviteListEntryInput,
  UpdateInviteListInput,
  UpdateWaitlistEntryStatusInput,
  UpsertEventApplicationFormInput,
  UpsertEventApplicationQuestionInput,
  SaveEventInput,
  ReprojectEventLocationsForPlaceInput,
  FollowPlaceAddressInput,
  FollowPlaceAddressResult,
  WaitlistStatus,
  CategoryNameTranslations,
} from "@th/types";

/**
 * Filters for {@link EventsRepo.pickRandomEvent}. Backs the "Surprise me"
 * random-event discovery feature. All coordinates are decimal degrees; the
 * radius is in kilometres. `excludeEventIds` is always provided (possibly
 * empty) so the caller can page past events it already showed.
 *
 * There is deliberately NO scope flag: the pick is ALWAYS published + PUBLIC
 * + ungated (`gateType = NONE`). It backs an anonymous endpoint, and a
 * caller-controlled `publishedOnly: false` once pulled drafts and private
 * events — with their exact addresses — out of it.
 */
export interface PickRandomEventInput {
  window: { from: Date; to: Date };
  near?: { lat: number; lng: number; radiusKm: number } | null;
  q?: string | null;
  orgId?: string | null;
  placeId?: string | null;
  excludeEventIds: string[];
  /**
   * Confirmed-only pick (venue-confirmation spec). Applied ONLY together with
   * `placeId` — the same predicate as {@link EventsRepo.listPublishedByPlace}
   * bound to that place. Without `placeId` it is ignored (there is no place
   * to bind the stamp to).
   */
  venueConfirmedFor?: VenueConfirmedFor;
}

/**
 * One geo×category grouping used to enumerate SEO landing pages
 * (`/events/category/<categorySlug>/<citySegment>`). Produced by
 * {@link EventsRepo.enumerateGeoCategoryCombos}. `locality` is a representative
 * display value (case preserved from the DB); `regionCode` is normalized
 * lowercase or null when the events carry no region.
 */
export interface GeoCategoryComboRecord {
  categorySlug: string;
  categoryName: string;
  /** The category's non-English names; `{}` when it has none. */
  categoryNameTranslations: CategoryNameTranslations;
  locality: string;
  regionCode: string | null;
  count: number;
  latestUpdatedAt: Date | null;
}

/**
 * A single distinct city that currently has upcoming published, public events,
 * emitted by {@link EventsRepo.discoverActiveCities}. Aggregated directly over
 * the `Event` table with `visibility = 'PUBLIC'` as the gate.
 * `regionCode`/`countryCode` are included so the UI can disambiguate same-named
 * cities.
 */
export interface ActiveCityRecord {
  city: string;
  regionCode: string | null;
  countryCode: string | null;
  eventCount: number;
  /** Centroid of the city's upcoming public events; null when none carry coords. */
  lat: number | null;
  lng: number | null;
}

/**
 * Opt-in extras for the single-row event reads. `withOwnerStanding` also
 * DERIVES `EventRecord.ownerBanned` (ban-that-sticks, 2026-09-29) with an
 * owner join; only the public-read gates and checkout ask for it.
 */
export type EventReadOptions = { withOwnerStanding?: boolean };

/** Input for {@link EventsRepo.listCommunityListingsForPlatform}. */
export interface ListCommunityListingsForPlatformInput {
  /** Statuses to include; never empty (the use case resolves the default). */
  statuses: EventStatus[];
  /** Case-insensitive `title` substring; null/absent = no title filter. */
  titleContains?: string | null;
  /** Id of the last row of the previous page (exclusive); null = first page. */
  cursor?: string | null;
  limit: number;
  /** "Upcoming" boundary for the night fields. */
  now: Date;
}

/**
 * One ownerless COMMUNITY listing as the /platform list shows it. No RSVP
 * counts: going-counts stay server-side (FR-004).
 */
export interface CommunityListingPlatformRow {
  id: string;
  title: string;
  status: EventStatus;
  slug: string | null;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  /** `recurrenceSchedule IS NOT NULL`. */
  recurring: boolean;
  placeId: string | null;
  placeName: string | null;
  placeCity: string | null;
  /** The event's own locality (the address city when there is no place). */
  locality: string | null;
  /** Earliest SCHEDULED `EventDate` with `startsAt >= now`; null when none. */
  nextScheduledDateStartsAt: Date | null;
  /** SCHEDULED `EventDate` rows with `startsAt >= now` (0 for a one-off). */
  upcomingScheduledDateCount: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventsRepo {
  getById(id: string, options?: EventReadOptions): Promise<EventRecord | null>;
  /** Batch-fetch events by IDs. Missing IDs are silently omitted. */
  findManyByIds(
    ids: string[],
    options?: EventReadOptions,
  ): Promise<EventRecord[]>;
  /**
   * Pick a single random event matching the given filters, or `null` when
   * nothing matches. Postgres-backed (no search index) — ALWAYS published +
   * PUBLIC + ungated, then start-date window, optional org/place/text/geo
   * radius, and excludes the given ids, then selects one row at random. The
   * geo radius is decided from the point the event is SHOWN at, never the
   * stored one, and the number and shape of queries never depend on a stored
   * point (no presence or timing oracle). When `venueConfirmedFor` is
   * given TOGETHER WITH `placeId`, the same confirmed-only predicate as
   * {@link listPublishedByPlace} applies (an unconfirmed third-party event is
   * never surfaced under a venue's banner).
   */
  pickRandomEvent(input: PickRandomEventInput): Promise<EventRecord | null>;
  listTicketTypes(eventId: string): Promise<EventTicketTypeSummary[]>;
  /**
   * Batch-fetch ticket-type summaries for multiple events in a single query.
   * Each returned record carries its `eventId` so callers can group by event.
   */
  listTicketTypesForEventIds(
    eventIds: string[],
  ): Promise<(EventTicketTypeSummary & { eventId: string })[]>;
  /**
   * ONE PAGE of event ids belonging to PUBLISHED events with at least one
   * ACTIVE ticket type whose scheduled price flip
   * (`TicketType.scheduledPriceAt`, FR-005) falls in `(windowStart, windowEnd]`,
   * ordered by `eventId` ascending and starting strictly AFTER `afterEventId`.
   *
   * The search index materialises `minPaidPriceCents`, and a scheduled flip
   * changes an event's effective price with NO write to any row — so nothing in
   * the normal mutation path triggers a reindex. This query is the scan that
   * `search.reindex-scheduled-price-flips` uses to find the events whose stored
   * price just went stale (FR-008 / Q-001 RESOLVED).
   *
   * PAGINATED BY CURSOR, NOT CAPPED. An earlier version used
   * `orderBy: { eventId: "asc" }, take: limit` with no cursor, which is a STABLE
   * sort: if more events flipped inside one window than the cap allowed, every
   * tick for the whole lookback returned the SAME first N and the tail was never
   * re-indexed by this job at all — it healed only at the nightly full reindex.
   * That is not slow catch-up, it is no catch-up, and a coordinated on-sale or a
   * platform-wide early-bird deadline triggers it. Callers page with
   * `afterEventId` until a short page comes back.
   *
   * RETURNS ROWS, NOT DISTINCT EVENTS. `distinct` is deliberately NOT used: with
   * `take`, whether Prisma pushes DISTINCT ON down to Postgres or dedups in
   * memory is version-dependent, and in the in-memory case `take` would bound
   * TICKET-TYPE ROWS rather than events, so the effective page size would vary
   * with tiers-per-event. Duplicates are cheap and the caller dedups; ambiguity
   * is not. An event whose tiers straddle a page boundary is still complete —
   * it was already collected from the earlier page, and the `> afterEventId`
   * cursor simply skips its remaining tiers.
   *
   * Read-only and cheap: it returns ids only, and the caller re-reads and
   * re-resolves everything it indexes.
   */
  listEventIdsWithScheduledPriceFlipBetween(input: {
    /** Exclusive lower bound. */
    windowStart: Date;
    /** Inclusive upper bound. Callers clamp this to `clock.now()`. */
    windowEnd: Date;
    /** Max ROWS in this page. */
    limit: number;
    /** Exclusive cursor: return only rows whose `eventId` sorts after this. */
    afterEventId?: string | null;
  }): Promise<string[]>;
  ensureHostPermission(eventId: string, actorHumanId: string): Promise<boolean>;
  getContent(input: { eventId: string }): Promise<EventBody | null>;
  /**
   * Batch-fetch every image-reference surface (hero FK + builder body) for the
   * given events. Used by the storage GC to decide whether an uploaded blob is
   * still reachable.
   *
   * Events that do not exist are omitted from the result — callers MUST treat a
   * missing event as "cannot prove unreferenced" rather than "unreferenced",
   * since a read that lost a row must never authorize a delete.
   */
  listMediaReferenceSets(eventIds: string[]): Promise<EventMediaReferenceSet[]>;
  updateContent(input: {
    eventId: string;
    content: EventBody;
  }): Promise<EventRecord>;
  /**
   * Create or update a draft. For `location.kind === "place"` the adapter
   * copies the place's location onto the row, and at a place that is NOT
   * EXACT it writes the venue's PUBLIC projection only (see the contract on
   * `EventRecord.addressText`), flooring `locationMode`/`locationRadiusMeters`
   * at the venue's. It takes the SHARED form of
   * {@link EventsRepo.lockLocationsAtPlace} before reading the place, so a
   * concurrent privacy change cannot be straddled.
   */
  upsertDraft(input: SaveEventInput): Promise<EventRecord>;
  /**
   * Transaction-scoped advisory lock on "the location columns of every event
   * at this place". Event saves take `shared` (they never block each other);
   * a venue privacy change takes `exclusive` BEFORE it writes the Place row, so
   * it waits for in-flight saves at the venue to commit and every later save
   * reads the NEW privacy state. Without it a save that read the old EXACT
   * state could commit the true address after the cascade re-projected.
   * Released automatically at commit/rollback; a no-op outside a transaction
   * is NOT acceptable — call it on a tx-scoped repo.
   */
  lockLocationsAtPlace(input: {
    placeId: string;
    mode: "shared" | "exclusive";
  }): Promise<void>;
  /**
   * Whether an ORGANISER's LIVE event points at this place: `stewardship =
   * OWNED` (not a community listing; an OWNED event orphaned by a human
   * delete still counts), status PUBLISHED (the only ticket-issuing status;
   * EventStatus has no other live value) and `endsAt > now`. Drafts never
   * lock a place (owner ruling 2026-10-14: a draft issues no tickets and
   * could lock it forever); ended, COMPLETED, CANCELLED and ARCHIVED events
   * do not either. Backs the community-moderator guard.
   */
  hasOwnedLiveEventsAtPlace(input: {
    placeId: string;
    now: Date;
  }): Promise<boolean>;
  /**
   * How many PUBLISHED community listings (`stewardship = COMMUNITY`) at this
   * place have not ended (`endsAt > now`). A moderator may not archive a
   * place while any do.
   */
  countLiveCommunityListingsAtPlace(input: {
    placeId: string;
    now: Date;
  }): Promise<number>;
  /**
   * Transaction-scoped ROW locks on events, taken in id order:
   *  - `share` → `SELECT … FOR SHARE`. The search index write fence
   *    (`buildSearchIndex`): an event whose document is being written cannot
   *    be updated until that write has landed, and a row mid-update is
   *    re-read only after it commits.
   *  - `update` → `SELECT … FOR UPDATE`. A save that must compare the row
   *    BEFORE its own write with the row after it (the search privacy scrub);
   *    `publishEvent` and the `updateEventSettings` instructional re-stamp,
   *    which re-read the row under it so the venue they stamp from is the one
   *    the event points at when they commit.
   *    Take it after `lockLocationsAtPlace`, never before: the place cascade
   *    takes its advisory lock first and the rows second, and the same order
   *    here keeps the two from deadlocking. Once the row lock is held, never
   *    take `lockLocationsAtPlace` for a venue found by the re-read (a save
   *    re-pointed the event before the lock was granted): `upsertPlace` holds
   *    that venue EXCLUSIVE while it rewrites this row, so the two deadlock.
   *    Do not read that venue. A caller that writes a stamp writes NULL
   *    instead (checkout re-resolves from that venue's cache): not every path
   *    that re-points an event restamps it (template apply and series sync go
   *    through `upsertDraft`, which leaves the stamp), so the row's stamp may
   *    be the old venue's. The settings re-stamp writes nothing unless the
   *    row's stamp is wrong under the new flag whatever venue wrote it (the
   *    TN-exempt sentinel on a toggle OFF), and then writes NULL.
   * Ids that do not exist are skipped. A no-op outside a transaction is NOT
   * acceptable — call it on a tx-scoped repo.
   */
  lockRows(input: { ids: string[]; mode: "share" | "update" }): Promise<void>;
  /**
   * Re-project the location columns of every event at `placeId` onto the
   * place's current privacy state, in ONE statement (a venue with 10k events
   * is one UPDATE, not a loop). Returns the ids of the rows it rewrote.
   *
   *  - `withheld`: EVERY status, ARCHIVED included — the invariant "no Event
   *    row holds the true location of a withheld place" admits no exceptions,
   *    and archived rows are still read (`listMyEvents`, `getEventForEdit`).
   *    Sets OBSCURED, floors the radius at the venue's (`applyPlaceLocationFloor`
   *    semantics, in SQL), writes the public centre only where the floored
   *    radius is non-null, nulls `postalCode`/`geohash8`, and gives a
   *    just-withheld event with no reveal schedule `input.defaultReveal`
   *    (a NEVER event is untouched).
   *  - `exact`: every status EXCEPT ARCHIVED — restores the true columns. The
   *    event's own `locationMode`/`locationRadiusMeters`/reveal schedule are
   *    left alone: the floor overwrote whatever it originally asked for, so
   *    "stay as private as you are now" is the only non-guessing answer.
   *
   * Caller holds `lockLocationsAtPlace({ mode: "exclusive" })`.
   */
  reprojectLocationForPlace(
    input: ReprojectEventLocationsForPlaceInput,
  ): Promise<string[]>;
  /**
   * EVENTS FOLLOW AN EXACT PLACE'S ADDRESS EDIT (owner ruling 2026-10-14).
   * Writes `input.columns` (the eight location columns, plus `geohash8` =
   * NULL) onto the place's UPCOMING events whose `Event.timezone` equals
   * `input.timezone`, and returns the upcoming ones it left alone.
   *
   * UPCOMING = status DRAFT or PUBLISHED, AND either `endsAt > now` (an
   * in-progress event counts) or, for a recurring listing whose
   * `startsAt`/`endsAt` mirror has not rolled forward yet, a SCHEDULED
   * `EventDate` that ends (or, with no end, starts) after `now`. ARCHIVED,
   * CANCELLED, COMPLETED and ended events keep the address they had.
   * Privacy columns and the reveal schedule are never touched: the place is
   * EXACT on both sides of the edit. Never call it for a withheld place.
   *
   * Caller holds `lockLocationsAtPlace({ mode: "exclusive" })`, in a tx.
   */
  followPlaceAddress(
    input: FollowPlaceAddressInput,
  ): Promise<FollowPlaceAddressResult>;
  publish(input: {
    eventId: string;
    publishedAt: Date;
    currentAttestationId?: string | null;
    currency?: string;
    /** Tax rate in basis points stamped from the venue's SavedLocation / Place. */
    admissionTaxRateBps?: number | null;
    /** Source of the stamped rate: "ziptax", "manual", "exempt", etc. */
    taxRateSource?: string | null;
  }): Promise<EventRecord>;
  createAttestation(
    input: CreateEventAttestationInput,
  ): Promise<EventAttestationRecord>;
  /**
   * Flips the event to CANCELLED and, in the same transaction (the caller
   * holds the row lock), records the status it had (`cancelledFromStatus`),
   * copied from the row itself so no caller can pass a stale one. A row
   * already CANCELLED keeps its recorded status. Call inside a `repos.tx`
   * (the adapter writes it in two statements).
   */
  cancel(input: { eventId: string }): Promise<EventRecord>;
  /**
   * Reverts a PUBLISHED event back to DRAFT, hiding it from public surfaces
   * without canceling tickets/refunding buyers. The event keeps its slug and
   * publish history. It clears the current attestation so a later publish can
   * re-run host validation and attach a fresh attestation.
   * Caller is responsible for guarding against unpublishing events with
   * sold tickets — the repo just flips the status.
   */
  unpublish(input: { eventId: string }): Promise<EventRecord>;
  /**
   * Marks a PUBLISHED event as COMPLETED — the terminal "this already happened"
   * state used to retire finished events from public surfaces. Pure status
   * flip; the caller guards the source status and access.
   */
  complete(input: { eventId: string }): Promise<EventRecord>;
  /**
   * Marks an event as ARCHIVED — the terminal "put this away" state that hides
   * it from listing surfaces. Pure status flip; the caller guards the source
   * status (PUBLISHED / COMPLETED / CANCELLED) and access.
   */
  archive(input: { eventId: string }): Promise<EventRecord>;
  /**
   * Atomically removes a never-published DRAFT event row with no attestation
   * history. Returns false if the lifecycle guard no longer matches.
   * Cascade-deletes draft-only children (TicketType drafts, EventBody, etc.)
   * via Prisma's onDelete declarations.
   */
  delete(input: { eventId: string }): Promise<boolean>;
  setCategory(input: {
    eventId: string;
    categoryId: string | null;
  }): Promise<EventRecord>;
  setWaiverTemplate(input: {
    eventId: string;
    waiverTemplateId: string | null;
  }): Promise<EventRecord>;
  setListingPriority(input: {
    eventId: string;
    priority: number | null;
  }): Promise<EventRecord>;
  /**
   * List all published events (search indexing, stats, and the global
   * discover feed). Returns paginated results with offset-based pagination.
   *
   * `visibility` omitted/empty → every visibility: the search indexer NEEDS
   * PRIVATE events (it indexes them with `isPublic = false`). A PUBLIC
   * listing MUST pass `["PUBLIC"]` — a PRIVATE event is link-only.
   */
  listPublished(input: {
    limit?: number;
    offset?: number;
    /** When provided, only return events with startsAt >= startsAfter. */
    startsAfter?: Date;
    visibility?: EventVisibility[];
    /**
     * Drop events whose owner is withheld because of a ban (see
     * {@link EventsRepo.listPublishedByPlace}). The discover feed passes
     * `true`; the search indexer and stats omit it.
     */
    excludeBannedOwners?: boolean;
  }): Promise<OffsetPaginatedResult<EventRecord>>;
  /**
   * Fetch aggregated popularity stats for a batch of events.
   * Used by search indexing to compute popularityScore.
   */
  getPopularityStats(eventIds: string[]): Promise<EventPopularityStats[]>;
  /**
   * Published + PUBLIC events at ONE place in a `startsAt` window.
   *
   * `venueConfirmedFor` (venue-confirmation spec): when provided, only events
   * that are venue-confirmed FOR THIS PLACE are returned —
   * `venueConfirmedAt IS NOT NULL AND venueConfirmationWithdrawnAt IS NULL
   * AND venueConfirmedPlaceId = placeId` OR `orgId IN orgIds` OR `humanId IN
   * humanIds`. The stamp is bound to the place it was granted at: an event
   * moved to another venue is unconfirmed there with no write. Omitted = no
   * confirmation filter (admin reads derive confirmation in core). See
   * {@link VenueConfirmedFor}.
   */
  listPublishedByPlace(input: {
    placeId: string;
    from: Date;
    to: Date;
    status: "upcoming" | "past";
    limit?: number;
    offset?: number;
    venueConfirmedFor?: VenueConfirmedFor;
    /**
     * Event statuses to admit. Omitted = `["PUBLISHED"]`, rendered as the
     * same `status = 'PUBLISHED'` predicate as before, so every existing
     * caller's SQL is byte-identical. The venue track record passes
     * `TRACK_RECORD_EVENT_STATUSES` (PUBLISHED + COMPLETED, R10): a show
     * `completeEvent` moved to COMPLETED still happened.
     */
    statuses?: ReadonlyArray<"PUBLISHED" | "COMPLETED" | "CANCELLED">;
    /**
     * Only events that were PUBLISHED at the moment they were cancelled
     * (owner ruling 2026-10-17): `cancelledFromStatus = 'PUBLISHED'`. A row
     * cancelled before that column existed (NULL) is excluded: its status at
     * cancel is unknown, and the cancelled-in-feed read never shipped, so no
     * subscriber holds an entry for it. The public calendar feeds pass it
     * with `statuses: ["CANCELLED"]`, so a show that was a draft when
     * cancelled (never published, or unpublished and edited first) never
     * surfaces. Omitted = no filter.
     */
    cancelledWhilePublished?: boolean;
    /**
     * FR-003 (event-calendar-redesign): also match events with a SCHEDULED
     * `EventDate` in the window — same opt-in and rationale as
     * {@link ListAllEventsByPlaceInput.includeDateOccurrences}. Pagination
     * and `pageInfo.total` stay EVENT-shaped (one row per matching event);
     * the caller expands the occurrences.
     */
    includeDateOccurrences?: boolean;
    /**
     * The `EventDate` statuses the `includeDateOccurrences` arm matches.
     * Omitted = `["SCHEDULED"]` (unchanged). The calendar feeds' cancelled
     * read passes SCHEDULED + CANCELLED: a taken-down listing's remaining
     * nights are all CANCELLED, and its pinned `startsAt` is not moved.
     */
    dateOccurrenceStatuses?: ReadonlyArray<"SCHEDULED" | "CANCELLED">;
    /**
     * With `includeDateOccurrences`: match ONLY on the EventDate arm, never on
     * the pinned `Event.startsAt`. Omitted/false = unchanged. The calendar
     * feeds pass it with `dateOccurrenceStatuses: ["CANCELLED"]` to find a
     * live listing whose called-off nights are its only in-window rows (a
     * call-off of the last upcoming night re-pins `startsAt` to the past).
     *
     * REQUIRES `includeDateOccurrences: true`. Without it there is no
     * EventDate arm to narrow to, so the flag would silently fall back to
     * the plain `startsAt` window (a WIDER read than asked for); the adapter
     * throws instead.
     */
    matchDateOccurrencesOnly?: boolean;
    /**
     * Restrict to ONE stewardship, in SQL. Omitted = both, i.e. every existing
     * caller's rows are unchanged.
     *
     * MUST be a query predicate and not a post-filter, which is the whole
     * reason it exists: `limit` becomes a SQL `take`, so a caller that asks
     * for 100 rows and then keeps the COMMUNITY ones gets "the COMMUNITY
     * listings among the 100 soonest events here", not "100 COMMUNITY
     * listings". At a venue that programmes its own room five nights a week
     * the first 100 by `startsAt` are almost all OWNED and the listings fall
     * off the end — silently, because the page still looks full.
     */
    stewardship?: EventStewardship;
    /**
     * Drop events the venue has explicitly withdrawn confirmation from
     * (`venueConfirmationWithdrawnAt IS NOT NULL`). Omitted = kept, so no
     * existing caller moves.
     *
     * NOT a synonym for `venueConfirmedFor`, and the two are not in tension:
     * `venueConfirmedFor` asks "is this event confirmed HERE", which no
     * community listing is until the venue flips its flag;
     * `excludeVenueConfirmationWithdrawn` asks the narrower "has the venue
     * already said no to THIS one", which FR-003 makes permanent against both
     * the stamp arm and the community arm. A caller reasoning about what a
     * change to the venue-wide flag would DO wants the second one and not the
     * first — the same pairing {@link countCommunityListingsAtPlace} applies,
     * for the same reason.
     */
    excludeVenueConfirmationWithdrawn?: boolean;
    /**
     * Drop events whose owner is withheld because of a ban (the owning human
     * is BANNED, or every OWNER of the owning org is — ban-that-sticks,
     * 2026-09-29). Public venue reads pass `true`; stats and admin reads omit
     * it, so their counts do not move.
     */
    excludeBannedOwners?: boolean;
    /**
     * With `excludeBannedOwners`: the withheld set the caller already
     * resolved (`BansRepo.listWithheldOwners`), used instead of
     * resolving it again for this read. The place calendar feed makes three
     * reads per request and resolves once. Omitted = the adapter resolves
     * it. Passed without `excludeBannedOwners` the adapter throws.
     */
    withheldOwners?: WithheldOwnerIds;
  }): Promise<OffsetPaginatedResult<EventRecord>>;
  /**
   * The BATCHED sibling of {@link EventsRepo.listPublishedByPlace}: same
   * PUBLISHED + PUBLIC + `startsAt` window filter and same chronological
   * order, but keyed on MANY places in ONE query. Exists so a caller holding
   * a set of venues (e.g. the org/human embed calendar's `scope: "venues"`)
   * does not loop the single-place lister N times.
   *
   * Returns a flat, already-ordered `EventRecord[]` rather than an
   * `OffsetPaginatedResult` on purpose: a fan-in across an arbitrary set of
   * places has no stable page semantics worth exposing, and every caller so
   * far wants a single bounded slice. `limit` is the hard cap on the fan-out.
   *
   * An empty `placeIds` returns `[]` without querying.
   *
   * `venueConfirmedFor` applies ONE owner-id set across every place in the
   * fan-out (same predicate as {@link listPublishedByPlace}); the stamped arm
   * is bound with `venueConfirmedPlaceId IN placeIds`. NOTE this is LOOSER
   * than the single-place read: with a shared owner set an event confirmed
   * at place A but since moved to place B (both in `placeIds`) still
   * matches. `acceptsCommunityListings` is loose in the SAME way and one step
   * worse — it is a SINGLE boolean for the whole fan-out, so it cannot say
   * "place A accepts community listings, place B does not"; it admits
   * accepted community listings at every place in the batch or at none.
   * Acceptable while this method has no confirmed-only caller; a
   * caller that needs the strict per-place binding (owners OR community
   * consent) must fan out {@link listPublishedByPlace}.
   */
  listPublishedByPlaceIds(input: {
    placeIds: string[];
    from: Date;
    to: Date;
    status: "upcoming" | "past";
    limit?: number;
    venueConfirmedFor?: VenueConfirmedFor;
  }): Promise<EventRecord[]>;
  /**
   * Every night in `[from, to]` on which a venue's space is TAKEN by a
   * published, public event — counted in occurrences, not in event rows.
   *
   * Exists because {@link EventsRepo.listPublishedByPlace} filters on
   * `Event.startsAt`, which for a recurring listing mirrors only the first
   * upcoming date. Booking availability asking that question gets "this venue
   * is busy one night" for a residency that in truth occupies the space every
   * week, and then offers a performer a slot on a night the space is gone.
   *
   * Semantics that callers depend on:
   *   · An event with SCHEDULED {@link EventDateRecord} rows in range yields
   *     ONE occurrence per row. `Event.startsAt` is a pinned mirror of one of
   *     those rows and is NOT emitted again — the night is not double-counted.
   *   · An event with no rows in range falls back to `Event.startsAt`/`endsAt`
   *     when that instant lands in range. This is what makes ordinary
   *     single-date events work, and it also keeps a recurring listing whose
   *     expansion has drifted or lapsed from vanishing from the space's diary.
   *   · CANCELLED occurrences are excluded: a called-off night frees the space,
   *     and reporting it as busy would cost the venue real inventory.
   *   · `spaceIds` (optional) narrows occupancy to a calendar's spaces. A
   *     venue with a main stage and a back bar is not busy everywhere because
   *     one 40-cap room is taken. Omitted = the whole place, unchanged.
   *     The filter ALWAYS keeps `spaceId IS NULL` rows — an event with no
   *     space has UNKNOWN placement and blocks conservatively (see
   *     {@link PlaceOccurrenceRecord.spaceId}).
   *   · `venueConfirmedFor` (optional) narrows to venue-confirmed events —
   *     an unconfirmed third-party event counts for neither availability nor
   *     conflicts (venue-confirmation spec). Same predicate as
   *     {@link listPublishedByPlace}. Omitted = every published event occupies.
   *
   * Ordered by `startsAt` ascending. `limit` caps OCCURRENCES.
   */
  listPublishedOccurrencesByPlace(
    input: ListPublishedOccurrencesByPlaceInput,
  ): Promise<PlaceOccurrenceRecord[]>;
  /**
   * Published + PUBLIC events owned by an ORGANIZATION within a time range.
   * The org-scoped mirror of {@link EventsRepo.listPublishedByPlace}: same
   * PUBLISHED + PUBLIC + date-window filter and chronological order, keyed on
   * `orgId` instead of `placeId`. Backs the org profile's live upcoming-events
   * zone (unlike {@link EventsRepo.listByOwner}, which is the owner-facing
   * management listing — all visibilities/statuses, newest-first).
   */
  listPublishedByOrg(input: {
    orgId: string;
    from: Date;
    to: Date;
    status: "upcoming" | "past";
    limit?: number;
    offset?: number;
  }): Promise<OffsetPaginatedResult<EventRecord>>;
  /** Published + PUBLIC events (a public listing — PRIVATE is link-only). */
  filterByCategory(input: {
    categorySlug?: string | null;
    limit?: number;
    offset?: number;
    /** When provided, only return events with startsAt >= startsAfter. */
    startsAfter?: Date;
  }): Promise<OffsetPaginatedResult<EventRecord>>;
  /**
   * How many of the events {@link EventsRepo.filterByCategory} lists for the
   * category from `startsAfter` make its page worth indexing: the same rule
   * AND ungated (`gateType = NONE`). Owner ruling 2026-10-13: a category whose
   * only upcoming events are gated is noindex. The category sitemap
   * (`CategoriesRepo.listActiveWithUpcomingEvents`) uses the same rule.
   */
  countIndexableByCategory(input: {
    categorySlug: string;
    startsAfter: Date;
  }): Promise<number>;
  /** Published + PUBLIC events in a region (a public listing). */
  listPublishedByRegion(input: {
    regionCode: string;
    limit?: number;
    offset?: number;
    /** When provided, only return events with startsAt >= startsAfter. */
    startsAfter?: Date;
  }): Promise<OffsetPaginatedResult<EventRecord>>;
  /** Published + PUBLIC events in a country (a public listing). */
  listPublishedByCountry(input: {
    countryCode: string;
    limit?: number;
    offset?: number;
    /** When provided, only return events with startsAt >= startsAfter. */
    startsAfter?: Date;
    /**
     * Whether to compute `pageInfo.total`. Defaults to `true`.
     *
     * The total costs a second full `COUNT(*)` over the same predicate, issued
     * alongside the page query. Callers that render a fixed-size band and never
     * paginate pay for a number nobody reads — measured at 12,360 counts/week
     * in production (2026-08-25, `docs/records/2026-08-25-db-load.md`), 7.7% of all
     * SQL, entirely from `events.countryEvents`.
     *
     * When `false`, `pageInfo.total` is a LOWER BOUND (`offset + count`), not
     * the real total, and `hasNextPage`/`nextOffset` are therefore not
     * meaningful. Only pass `false` from a caller that reads neither.
     */
    includeTotal?: boolean;
  }): Promise<OffsetPaginatedResult<EventRecord>>;
  /**
   * Anonymous title search: published + PUBLIC + ungated (`gateType = NONE`)
   * events only.
   */
  searchPublished(input: {
    query: string;
    limit?: number;
    /** When provided, only return events with startsAt >= startsAfter. */
    startsAfter?: Date;
  }): Promise<EventRecord[]>;
  /**
   * Distinct cities that currently have upcoming published, public events,
   * ordered by activity (event count DESC, then city ASC). Aggregated over the
   * `Event` table (`status = 'PUBLISHED'`, `visibility = 'PUBLIC'`,
   * `startsAt >= startsAfter`, non-empty `locality`). Backs the home-page
   * "city by city" marquee.
   */
  discoverActiveCities(input: {
    /** Only count events with startsAt >= startsAfter (upcoming floor). */
    startsAfter: Date;
    /** When provided, restrict to this country (case-insensitive match). */
    countryCode?: string | null;
    /** Cap on the number of cities returned. */
    limit?: number;
  }): Promise<ActiveCityRecord[]>;
  /**
   * Event pages the sitemap advertises: PUBLISHED, PUBLIC, with a slug, not
   * yet ended, owner not withheld, and ungated (`gateType = NONE`). A gated
   * event's page is noindex, so it stays out (owner ruling 2026-10-13).
   */
  listPublishedForSitemap(input?: {
    limit?: number;
    /**
     * Current instant used to drop already-ended events. An event is kept when
     * `endsAt >= now`, OR (`endsAt IS NULL` AND `startsAt >= now`). Passed from
     * the use case for testability rather than read via `new Date()` inside the
     * adapter.
     */
    now?: Date;
  }): Promise<EventSitemapEntryRecord[]>;
  /**
   * Enumerate geo×category combinations that have at least `minCount` upcoming
   * PUBLISHED + PUBLIC + ungated events (community/ownerless listings
   * included; gated events do not count, owner ruling 2026-10-13). `count` is
   * that ungated count. The guarantee is one-way: every emitted combo is an
   * indexable page, because the page's match set contains the combo's group
   * (the page's region clause also matches a slug-folded free-text region),
   * so the page's `listPublishedByCategoryAndCity(...).indexableTotal` is at
   * least `count`. A page can be indexable without being emitted: a
   * region-less segment for a city spanning several regions, or a page lifted
   * over the threshold by free-text-region matches. Groups by
   * category and the SLUG-FOLDED locality/regionCode — the same fold
   * {@link EventsRepo.listPublishedByCategoryAndCity} matches on, so every
   * emitted sitemap URL resolves to a non-empty page. Backs the geo×category
   * SEO landing pages + their sitemap section.
   */
  enumerateGeoCategoryCombos(args: {
    minCount: number;
    startsAfter: Date;
  }): Promise<GeoCategoryComboRecord[]>;
  /**
   * List upcoming PUBLISHED + PUBLIC events in a category filtered by a
   * slug-folded city (`citySlug` — the SAME fold `enumerateGeoCategoryCombos`
   * groups by, so every sitemap URL resolves to a non-empty page) and, when
   * provided, a region code/name. Community/ownerless listings are included,
   * and so are gated events. Used by the geo×category landing page.
   *
   * `indexableTotal` counts the ungated matches (`gateType = NONE`) in the
   * same window; the page's robots threshold reads it. It is at least the
   * `count` `enumerateGeoCategoryCombos` reports for the same group (see
   * there: every emitted combo is indexable, not the reverse).
   */
  listPublishedByCategoryAndCity(args: {
    categorySlug: string;
    citySlug: string;
    region?: string | null;
    limit: number;
    offset: number;
    startsAfter: Date;
  }): Promise<OffsetPaginatedResult<EventRecord> & { indexableTotal: number }>;
  /**
   * Count the events {@link EventsRepo.listPublishedByCategoryAndCity} would
   * list for the same category, city slug and `startsAfter`, with the region
   * matched STRICTLY on `lower(regionCode)` (never the free-text `region`
   * column) — the same key `enumerateGeoCategoryCombos` groups by. Count only:
   * no rows are hydrated. Backs the geo×category canonical-region proof.
   */
  countPublishedByCategoryAndCityRegionCode(args: {
    categorySlug: string;
    citySlug: string;
    regionCode: string;
    startsAfter: Date;
  }): Promise<number>;
  updateVisibility(input: {
    eventId: string;
    visibility: EventVisibility;
  }): Promise<EventRecord>;
  updateGateType(input: {
    eventId: string;
    gateType: EventGateType;
  }): Promise<EventRecord>;
  updatePassword(input: {
    eventId: string;
    passwordHash: string | null;
    passwordUpdatedAt: Date;
  }): Promise<EventRecord>;
  updateWaitlistSettings(input: {
    eventId: string;
    status: WaitlistStatus;
    publishAt?: Date | null;
    description?: string | null;
    cap?: number | null;
    emailEnabled?: boolean;
    emailSubject?: string | null;
    emailBody?: object | null;
  }): Promise<EventRecord>;
  getGateSettings(eventId: string): Promise<EventGateSettings | null>;
  assignSlug(input: AssignEventSlugInput): Promise<EventRecord>;
  updateSlug(input: UpdateEventSlugInput): Promise<EventRecord>;
  recordSlugHistory(input: RecordEventSlugHistoryInput): Promise<void>;
  /**
   * Every event that has a slug, any status (old links exist for archived,
   * cancelled and past events too), ordered by `id` ascending and keyset-paged
   * on `id > afterId`. Used by the slug date correction backfill.
   */
  listSluggedPage(input: ListSluggedEventsPageInput): Promise<EventSlugDateRow[]>;
  /**
   * One event's `EventSlugDateRow`, or null when it is missing or has no slug.
   * SCHEMA-NARROW on purpose, like `listSluggedPage`: it selects only those
   * columns, so the slug date backfill runs against a database whose `Event`
   * table is behind the Prisma schema (prod before its migrations land), where
   * a full `getById` fails on a column that does not exist yet.
   */
  getSlugDateRow(eventId: string): Promise<EventSlugDateRow | null>;
  /**
   * Sets `Event.slug` and nothing else (`updatedAt` moves with it) and reads
   * back only the id: schema-narrow for the same reason as `getSlugDateRow`.
   * A slug or shortId collision throws `{ code: "conflict", cause }`, like
   * `updateSlug`.
   */
  setSlugOnly(input: SetEventSlugOnlyInput): Promise<void>;
  resolveBySlug(slug: string): Promise<EventSlugResolution | null>;
  /**
   * The event whose `shortId` is exactly `shortId` (a `/e/<shortId>` short
   * link), or null — also null when that event has no slug yet. No status or
   * readability filter: the caller decides who may follow the link.
   */
  resolveByShortId(
    shortId: string,
  ): Promise<Omit<EventSlugResolution, "redirect"> | null>;
  getSlugContext(eventId: string): Promise<EventSlugContext | null>;
  /**
   * List all events at a place within a time range, optionally filtered by status.
   * Used by the venue calendar (owner view) — returns all non-ARCHIVED statuses by default.
   */
  listAllByPlace(input: ListAllEventsByPlaceInput): Promise<EventRecord[]>;
  /**
   * Events of ONE named Calendar in a `startsAt` window, `startsAt` asc
   * (venue-hierarchy FR-005/FR-010). Filters on `Event.calendarId` DIRECTLY —
   * NEVER via the CalendarSpace join (a shared space must not bleed one
   * stream's events onto another's calendar; the space join exists ONLY for
   * conflicts).
   *
   * `publishedOnly: true` is the PUBLIC/embed shape: `status = PUBLISHED AND
   * visibility = PUBLIC` (same pair as {@link listPublishedByPlace} — a
   * published-but-unlisted event must not leak onto a public calendar).
   * Otherwise all non-ARCHIVED statuses (admin overlay), mirroring
   * {@link listAllByPlace}'s default set.
   *
   * `limit` becomes a SQL `take`, clamped to [1, 100] by the adapter (the
   * same ceiling as {@link listPublishedByPlace}) — the public read must
   * bound its scan in the query, not post-hoc in memory. Omitted = no take
   * (the admin overlay reads its whole ≤90-day window).
   *
   * `venueConfirmedFor`: same confirmed-only predicate as
   * {@link listPublishedByPlace}; the public calendar embed passes it, the
   * admin overlay omits it (it SHOWS unconfirmed events, marked, so the
   * venue sees who is claiming its room).
   *
   * `includeDateOccurrences` (event-calendar-redesign FR-003): ALSO match an
   * event with a SCHEDULED `EventDate` inside `[from, to]` — same opt-in and
   * rationale as {@link ListAllEventsByPlaceInput.includeDateOccurrences}.
   * Off by default so existing callers' WHERE is byte-identical; the row
   * still comes back ONCE at its pinned instant and the caller expands it.
   */
  listByCalendar(input: {
    calendarId: string;
    from: Date;
    to: Date;
    publishedOnly?: boolean;
    limit?: number;
    venueConfirmedFor?: VenueConfirmedFor;
    includeDateOccurrences?: boolean;
  }): Promise<EventRecord[]>;
  /**
   * Stamp the venue-hierarchy placement columns on one event (FR-005/FR-009):
   * `calendarId` (programming stream) + `spaceId` (physical blocking), plus —
   * only when the caller passes it — a `categoryId` being applied as a
   * calendar default onto a still-uncategorized draft. Mechanical UPDATE;
   * same-place/ACTIVE-space invariants are the CALLER's (core) obligation.
   */
  setVenuePlacement(input: {
    eventId: string;
    calendarId: string | null;
    spaceId: string | null;
    /** Omitted = untouched. Passed only to apply a calendar's default. */
    categoryId?: string | null;
  }): Promise<void>;
  /**
   * Stamp venue confirmation on one event (venue-confirmation spec): sets
   * `venueConfirmedAt` / `venueConfirmedByHumanId` /
   * `venueConfirmationRequestId`, BINDS the stamp with
   * `venueConfirmedPlaceId = input.placeId`, and CLEARS
   * `venueConfirmationWithdrawnAt` / `…WithdrawnReason` (re-confirming after
   * a withdrawal is the normal path).
   *
   * With `expectedStartsAt` (the venue's own confirm, R3-1) the CAS is
   * `WHERE id AND placeId AND startsAt = expectedStartsAt`; a row at the
   * place whose start differs throws `{ code: "event_starts_at_mismatch" }`
   * and nothing is written.
   *
   * Also records `venueConfirmedStartsAt` = the row's OWN `startsAt` at the
   * moment of the write (the date the venue vouched for), copied by the
   * adapter from the row rather than taken from the caller so no stamp
   * writer can pass a stale value or forget it. Core floors a withheld
   * venue's reveal at `max(startsAt, venueConfirmedStartsAt) − 24h`. Call it
   * inside the caller's `repos.tx` (every caller does): the adapter writes
   * the stamp and the date in two statements.
   *
   * CAS: the UPDATE runs `WHERE id = eventId AND placeId = input.placeId` —
   * `placeId` is the place the caller AUTHORIZED against, so an event that
   * was moved between the authorization read and this write (or a forged
   * eventId at another venue) matches zero rows and the adapter throws the
   * typed plain object `{ code: "event_place_mismatch" }` (same shape as
   * `calendar_requires_space`); nothing is written. A missing eventId is the
   * same zero-row outcome and the same error. Authorization itself
   * (`requirePlaceBookingAuthority`) stays the CALLER's obligation. Returns
   * the updated record.
   */
  setVenueConfirmation(input: SetVenueConfirmationInput): Promise<EventRecord>;
  /**
   * Withdraw venue confirmation: sets `venueConfirmationWithdrawnAt` /
   * `…WithdrawnReason`, leaves `venueConfirmedAt` as history, CLEARS
   * `venueConfirmedStartsAt` (a withdrawn stamp vouches for no date), NEVER
   * touches `placeId` (the event drops to address-only; it does not detach).
   * IDEMPOTENT: an event already withdrawn with the same reason is returned
   * unchanged (its original `withdrawnAt` is kept) — a retry is a no-op
   * success, not an error and not a re-stamp. Returns the updated record.
   *
   * NEVER-CONFIRMED EVENTS ARE VALID TARGETS (decided 2026-09-02): the
   * adapter does NOT require `venueConfirmedAt` to be set. Withdrawing an
   * event the venue never confirmed records a DECLINE ("not mine") — the
   * withdrawn pair lands with `venueConfirmedAt` still null — so the venue
   * calendar stops re-prompting for it. Core derives "not confirmed" the
   * same way in both cases.
   *
   * CAS: same guard as `setVenueConfirmation` — `WHERE id = eventId AND
   * placeId = input.placeId`; zero rows (moved event, foreign eventId, or no
   * such event) throws `{ code: "event_place_mismatch" }` and writes nothing.
   * The idempotent same-reason retry still returns the row (it matched the
   * place; it simply had nothing to change).
   */
  withdrawVenueConfirmation(
    input: WithdrawVenueConfirmationInput,
  ): Promise<EventRecord>;
  /**
   * Aggregate event counts and the next upcoming start time for a single place.
   * Excludes ARCHIVED events. Used by the places admin detail panel.
   */
  getStatsForPlace(input: { placeId: string; now: Date }): Promise<{
    total: number;
    upcoming: number;
    past: number;
    nextEventAt: Date | null;
  }>;
  /**
   * How many PUBLISHED, PUBLIC, non-past COMMUNITY listings are attached to a
   * place RIGHT NOW, counted WITHOUT the venue-confirmation filter
   * (community-listings-at-claimed-venues FR-007).
   *
   * Deliberately unfiltered BY CONFIRMATION: this is what a venue owner is
   * shown at the moment they decide whether to accept community listings, and
   * the whole point is that those listings are NOT confirmed yet. Filtering by
   * confirmation would always answer zero and make the toggle an abstract
   * question. `getVenueCalendar` reads the same way for the same reason.
   *
   * WITHDRAWN listings ARE excluded, which is not a contradiction: withdrawal
   * negates the community arm (FR-003), so accepting can never confirm one.
   * Counting it would promise the owner something the flag cannot deliver.
   *
   * "Upcoming" means `startsAt` in the future OR a SCHEDULED `EventDate` in
   * the future — a recurring listing's `startsAt` pin can be stale while its
   * nights run months out, and those nights are exactly what accepting would
   * block. One row per event either way.
   */
  countCommunityListingsAtPlace(input: {
    placeId: string;
    now: Date;
  }): Promise<number>;
  /**
   * Upcoming-sales signal for MANY owners in one pass: per owner, how many
   * PUBLISHED, TICKETED events start after `now` and when the soonest one
   * starts. RSVP listings are EXCLUDED — they write no ticket types and no
   * orders, so they cannot recover anything; counting them would report
   * recovery potential that does not exist. Memberships are not events and
   * are not counted here either.
   * Owner predicate mirrors {@link EventsRepo.listByOwner} (`orgId` for an
   * organisation, `humanId` for a human — org-owned events carry
   * `humanId: null`, so the arms never overlap). `Event.startsAt` is the
   * pinned mirror of a recurring listing's next upcoming date, so a
   * residency counts as one upcoming event, not one per night. Visibility is
   * deliberately NOT filtered — a private ticketed event still sells.
   * Owners with nothing upcoming are absent; an empty `owners` returns `[]`
   * without querying.
   */
  getUpcomingStatsForOwners(input: {
    owners: Array<{ ownerType: EventOwnerType; ownerId: string }>;
    now: Date;
  }): Promise<OwnerUpcomingEventStats[]>;
  /**
   * List events owned by a specific human or organization.
   * Used for "My Events" and org event management screens.
   * Accepts an optional case-insensitive `query` to filter by title /
   * addressText (used by live admin search).
   *
   * `includeDateOccurrences` (FR-003, event-calendar-redesign): with a bounded
   * `dateRange`, ALSO match events carrying a SCHEDULED `EventDate` inside
   * the window — same opt-in and rationale as
   * {@link ListAllEventsByPlaceInput.includeDateOccurrences}. Off by default;
   * the WHERE is unchanged for callers that do not set it.
   *
   * `matchDateOccurrencesOnly` REQUIRES `includeDateOccurrences` AND a
   * bounded `dateRange`; without them it would silently widen to the plain
   * read, so the adapter throws. `withheldOwners` (a pre-resolved ban set)
   * requires `excludeBannedOwners`, likewise enforced by a throw.
   */
  listByOwner(
    input: ListEventsByOwnerInput,
  ): Promise<OffsetPaginatedResult<EventRecord>>;
  /**
   * Link a SavedLocation to an event (sets Event.savedLocationId).
   * Used after auto-creating a SavedLocation from a freeform address so
   * the tax-rate stamp at publish time can resolve the venue's cached rate.
   */
  linkSavedLocation(input: {
    eventId: string;
    savedLocationId: string;
  }): Promise<void>;
  /**
   * Stamp the resolved admission tax rate onto an event. Used at save time
   * (once the event's location is resolved/linked) and as a publish-time
   * safety net. `admissionTaxRateBps: null` is a legitimate value (non-US
   * jurisdiction or a place with no rate) and clears any prior stamp.
   */
  updateTaxRate(input: {
    eventId: string;
    admissionTaxRateBps: number | null;
    taxRateSource: string | null;
  }): Promise<void>;
  /**
   * Stamp the admission tax rate ONLY when the event has none yet AND the
   * row is the version the rate was resolved from — a compare-and-set on
   * `admissionTaxRateBps IS NULL AND updatedAt = expectedUpdatedAt`.
   * Resolves `true` when it wrote, `false` when either condition failed.
   *
   * For the checkout's after-commit self-heal, which runs long after the
   * rate was resolved. What it protects:
   * - A NON-null stamp committed in between (e.g. a settings save that
   *   resolved a real rate) is never overwritten by the checkout's older one.
   * - ANY other write to the event row in between — in particular a settings
   *   save that leaves the stamp NULL (instruction-only admission turned off
   *   while the provider lookup missed), or a change of venue / inline
   *   address. Every input the event row contributes to the rate
   *   (`instructionalAdmission`, `placeId`, `savedLocationId`, the inline
   *   address) lives on this row, and every write that can change one of
   *   them moves `updatedAt` (Prisma `@updatedAt`; the raw-SQL venue
   *   re-projection sets it explicitly). A mismatch skips the fill; the next
   *   checkout looks the rate up again, which is the whole cost of a false
   *   skip.
   *
   * What it does NOT protect:
   * - An edit to the backing Place / SavedLocation row (its address), which
   *   does not touch the event row. The stale fill then stamps the rate for
   *   the venue's previous address — the same exposure every already-stamped
   *   event at that venue has, since a venue edit does not re-stamp its
   *   events.
   * - DELETING the Place / SavedLocation. `Event.placeId` / `savedLocationId`
   *   are nulled by the foreign key's `onDelete: SetNull`, a database-side
   *   cascade that does NOT bump `updatedAt` (Prisma's `@updatedAt` only fires
   *   for writes made through the client). A fill resolved against the old
   *   location still matches the row's version and stamps its rate onto an
   *   event that now has no venue.
   */
  fillTaxRateIfUnset(input: {
    eventId: string;
    admissionTaxRateBps: number;
    taxRateSource: string;
    /** `Event.updatedAt` as read when the rate was resolved. */
    expectedUpdatedAt: Date;
  }): Promise<boolean>;
  /**
   * Replace a stamp ONLY while it is still exactly the one the caller read —
   * a compare-and-set on `admissionTaxRateBps = expected.admissionTaxRateBps
   * AND taxRateSource = expected.taxRateSource AND updatedAt =
   * expected.updatedAt`. Resolves `true` when it wrote.
   *
   * For a checkout's after-commit replacement of a hand-entered rate
   * (`MANUAL_EVENT_TAX_RATE_SOURCE`) by the provider's answer. A rate entered
   * again, a settings save or a venue change committed in between wins; so
   * does a concurrent sale that already replaced it, so the replacement (and
   * its report) happens once.
   */
  replaceTaxRateIfUnchanged(input: {
    eventId: string;
    expected: {
      admissionTaxRateBps: number;
      taxRateSource: string;
      updatedAt: Date;
    };
    /** `null` unstamps the event (a "no rate here" answer). */
    admissionTaxRateBps: number | null;
    taxRateSource: string | null;
  }): Promise<boolean>;
  /**
   * Link a PayoutTerms record to an event. With no `kind` (default
   * "PRIMARY") sets `Event.payoutTermsId`; with `"RESALE"` sets
   * `Event.resalePayoutTermsId`. The "MERCH" branch is reserved for the
   * deferred POS feature.
   */
  linkPayoutTerms(input: {
    eventId: string;
    payoutTermsId: string;
    kind?: "PRIMARY" | "RESALE" | "MERCH";
  }): Promise<void>;
  /**
   * Find the event that references a given PayoutTerms id
   * (via payoutTermsId or resalePayoutTermsId).
   */
  findByPayoutTermsId(payoutTermsId: string): Promise<EventRecord | null>;
  /**
   * Update the refund cutoff date for an event.
   * When null, the cutoff defaults to event startsAt.
   */
  updateRefundCutoff(input: {
    eventId: string;
    refundCutoffAt: Date | null;
  }): Promise<EventRecord>;
  /**
   * Set the per-event instructional-admission flag (organizer attestation that
   * admission is for instruction only). Drives the Tennessee instruction-only
   * tax exemption — see packages/core/src/lib/tax/instruction-exemption.ts.
   * Does NOT re-stamp the tax rate; the checkout resolver corrects a stale
   * stamp on the fly, and a subsequent save/publish re-stamps it durably.
   */
  updateInstructionalAdmission(input: {
    eventId: string;
    instructionalAdmission: boolean;
  }): Promise<EventRecord>;
  /**
   * Update volunteering-related settings on an event. Fields that are
   * `undefined` are left unchanged; `volunteerIntroText: null` clears the
   * stored value.
   */
  updateVolunteerSettings(input: {
    eventId: string;
    volunteeringEnabled?: boolean;
    volunteerAutoApprove?: boolean;
    volunteerWaiverRequired?: boolean;
    volunteerIntroText?: string | null;
  }): Promise<EventRecord>;
  /**
   * Create an ownerless (humanId=null, orgId=null) RSVP+COMMUNITY event
   * (FR-005) as DRAFT or PUBLISHED. Bypasses the owned draft/publish pipeline
   * — no payout terms, ticket types, currency, or tax stamping.
   *
   * DRAFT is the EventBuilder authoring path: the row exists (so body images
   * and a hero can key to it) but is invisible on every public surface until
   * `publishCommunityListing` flips it. `publishedAt` is null for a DRAFT.
   */
  createCommunityListing(
    input: CreateCommunityListingInput,
  ): Promise<EventRecord>;
  /**
   * Apply an approved edit-suggestion diff (whitelisted fields only) to an
   * event of ANY kind — COMMUNITY, org-owned, or personal (FR-006 universal
   * suggestions). When no explicit geohash6 is provided and the diff touches
   * lat/lng, the adapter resolves the effective pair (pre-reading the stored
   * row if the diff carries only one side) and re-derives geohash6 — or sets
   * it null when the pin is cleared (both coordinates null).
   */
  applyCommunityEdit(input: ApplyCommunityEditInput): Promise<EventRecord>;
  /**
   * CAS publish for an ownerless COMMUNITY listing: flips DRAFT → PUBLISHED
   * and stamps `publishedAt`, but ONLY while the row is still a DRAFT
   * COMMUNITY listing. Returns null when the guard did not match.
   *
   * Distinct from {@link EventsRepo.publish}, which writes unconditionally.
   * The read-then-write shape ("is it DRAFT? … ok, publish") is a real race
   * under READ COMMITTED: two concurrent publishes both read DRAFT, both
   * write, and the second one re-stamps `publishedAt`, writes a second audit
   * row and re-runs FR-018 hold settlement — which re-notifies everyone in
   * the line about a publish that already happened. The status guard in the
   * WHERE is what makes the loser a no-op. Same CAS discipline as the
   * booking-hold / agreement / entity-report transitions.
   *
   * The `stewardship = COMMUNITY` half of the guard is defence in depth: the
   * use case checks it too, but this method must never be a back door that
   * publishes an OWNED event around `publishEvent`'s payout/ticket/tax work.
   */
  publishCommunityListingIfDraft(input: {
    eventId: string;
    publishedAt: Date;
  }): Promise<EventRecord | null>;
  /**
   * Enumerate the ids of PUBLISHED events that carry a recurrence schedule
   * (`recurrenceSchedule IS NOT NULL`) — the corpus the rolling re-expansion
   * job (`community.refresh-recurring-dates`) walks to keep recurring listings'
   * `EventDate` rows topped up and `Event.startsAt` pinned to the next upcoming
   * date. Keying on `recurrenceSchedule IS NOT NULL` (rather than
   * `stewardship = COMMUNITY`) is the robust filter: recurrence is the only
   * producer today, but the schedule column is the true signal.
   *
   * Cursor-paginated by id (stable ascending) so a large corpus is processed
   * in bounded batches. `cursor` is the last id from the prior page (exclusive
   * lower bound); `nextCursor` is present only when a full page was returned
   * (another page may exist).
   */
  listRecurringEventIds(input: {
    limit: number;
    cursor?: string;
  }): Promise<{ ids: string[]; nextCursor?: string }>;
  /**
   * Ownerless COMMUNITY listings (`stewardship = COMMUNITY`) for the
   * /platform/community-listings page, filtered by `statuses` and an optional
   * case-insensitive title substring. Ordered `createdAt DESC, id DESC`;
   * cursor-paged on the last row's id (exclusive). `nextCursor` is the last
   * returned id when another row exists, else null. Read-only; no RBAC (the
   * use case gates platform ADMIN). Never returns OWNED events.
   */
  listCommunityListingsForPlatform(
    input: ListCommunityListingsForPlatformInput,
  ): Promise<{ items: CommunityListingPlatformRow[]; nextCursor: string | null }>;
  /**
   * PUBLISHED events that have not ended (`endsAt >= now`) and take their tax
   * rate from the given venue row, with NO stamped rate of their own
   * (`admissionTaxRateBps IS NULL`) — the events whose quoted all-in price
   * reads the venue's cached rate. Same precedence as the tax resolver
   * (`eventTaxRateLocationRef`): a Place target matches `placeId`; a
   * SavedLocation target matches `savedLocationId` only when the event has
   * no `placeId` (a Place wins). Ids only, at most `limit`, `endsAt`
   * ascending (soonest first). Backs the reindex that follows a venue
   * tax-rate cache fill.
   */
  listUnstampedUpcomingIdsAtTaxLocation(input: {
    target:
      | { kind: "place"; placeId: string }
      | { kind: "saved-location"; savedLocationId: string };
    now: Date;
    limit: number;
  }): Promise<string[]>;
  /**
   * Scan for PUBLISHED OBSCURED events whose (mandatory) `addressRevealAt`
   * falls in `(windowStart, windowEnd]`. Scheduled scans (no `eventId`) are
   * additionally gated by the un-stamped cursor (`addressRevealNotifiedAt IS
   * NULL`), so a notified event is never re-picked. An explicit `eventId`
   * BYPASSES the cursor gate — that is the ops re-drive path for an event
   * whose first fan-out partially failed; the dispatcher's durable
   * notification-ledger subtraction confines such a re-run to the
   * un-notified gap. Status/mode/window guards always apply. Ordered by
   * `addressRevealAt` ascending. Backs `events.address-reveal-notify`.
   */
  findObscuredEventsCrossingReveal(input: {
    windowStart: Date;
    windowEnd: Date;
    eventId?: string;
  }): Promise<EventRecord[]>;
  /**
   * The reveal scan's second half: PUBLISHED OBSCURED events AT A VENUE
   * (`placeId` set) whose `startsAt` OR `venueConfirmedStartsAt` falls in
   * `(startsAfter, startsAtOrBefore]` (the venue floor is anchored on the
   * later of the two). Cursor-gated exactly like
   * {@link findObscuredEventsCrossingReveal} (an explicit `eventId` bypasses
   * the cursor). Ordered by `startsAt` ascending.
   *
   * Why a second scan: at a venue that withholds its address, an event the
   * venue confirmed by stamp reveals at the LATER of its own
   * `addressRevealAt` and `startsAt − 24h` (core's `holderRevealSchedule`).
   * When the event's own date is days earlier, the moment the address
   * actually unlocks is keyed on `startsAt`, which the `addressRevealAt`
   * scan never sees. The dispatcher shifts its window by the lead and lets
   * the holder gate decide; this read only finds candidates.
   */
  findObscuredPlaceEventsStartingIn(input: {
    startsAfter: Date;
    startsAtOrBefore: Date;
    eventId?: string;
  }): Promise<EventRecord[]>;
  /**
   * Conditionally stamp `addressRevealNotifiedAt` — the reveal-notification
   * job cursor — ONLY when it is still null, and return whether this call
   * won the stamp. `false` means a concurrent/previous run already owns the
   * event (or an explicit re-drive hit an already-stamped event); callers
   * must treat that as "another run owns this event" and not double-count.
   */
  markAddressRevealNotified(eventId: string, at: Date): Promise<boolean>;
  // ── P3b (asks) ──
  /**
   * Set `heroImageId` ONLY while it is still null (venue-booking-standards
   * v1.1 V10: a booking's "use as the event image" answer never replaces a
   * hero the event already has). Returns whether this call set it; `false`
   * also when the event does not exist. Conditional UPDATE — race-safe.
   */
  setHeroImageIfEmpty(input: {
    eventId: string;
    imageId: string;
  }): Promise<boolean>;
  /**
   * Write the event's shared note (holds-without-a-request FR-012), whatever
   * its status. With `expectedUpdatedAt` the write lands only while
   * `noteUpdatedAt` still equals it (`conflict`, nothing written,
   * otherwise). Never gates: core decides who may edit first.
   */
  setNote(input: SetNoteInput): Promise<SetNoteResult>;
}

/**
 * Why the open-call sweep (open calls v1 step 8) must settle a PENDING
 * application now:
 *   - `backstop` (FR-021): the last date it chose has started → REJECTED
 *     with the standard "not this time" reply;
 *   - `pulled` (FR-022): the event was cancelled, every date it chose was
 *     called off, or the anchor was shelved (event archived / completed,
 *     series archived) while its night is still ahead → EXPIRED with the
 *     "call pulled" notice.
 */
export type OpenCallSweepVerdict = "backstop" | "pulled";

/** One PENDING application the sweep must settle (`listOpenCallSweepDue`). */
export interface OpenCallSweepDueRecord {
  submissionId: string;
  formId: string;
  /** The call's anchor: exactly one of eventId / seriesId is set. */
  eventId: string | null;
  seriesId: string | null;
  /** The event's title or the series' name, for the notice. */
  title: string;
  verdict: OpenCallSweepVerdict;
  createdAt: Date;
}

/**
 * Which notice a reconcile scan looks for (`listOpenCallNoticeReconcileRows`):
 *   - `not-this-time`: REJECTED, windowed by `reviewedAt`;
 *   - `pulled`: EXPIRED, windowed by `reviewedAt`;
 *   - `received`: PENDING or WAITLISTED, windowed by `createdAt`.
 */
export type OpenCallReconcileKind = "not-this-time" | "pulled" | "received";

/** One application a reconcile scan reads, with its window instant `at`. */
export interface OpenCallReconcileRow {
  submissionId: string;
  formId: string;
  eventId: string | null;
  seriesId: string | null;
  title: string;
  /** reviewedAt (not-this-time, pulled) or createdAt (received). */
  at: Date;
}

/**
 * Open calls v1 re-key: an event can hold an ATTEND form (the attendee gate)
 * AND a PERFORM form (an open call for acts). Every method that reaches a
 * form or its submissions through an event names the form — by `purpose` or
 * by `formId` — as a REQUIRED argument with no default, so each caller states
 * which form it means and the attendee gate can never read the performer
 * form by accident (spec risk: "a missed reader").
 */
export interface EventApplicationsRepo {
  getForm(
    eventId: string,
    purpose: ApplicationFormPurpose,
  ): Promise<EventApplicationFormRecord | null>;
  upsertForm(
    input: UpsertEventApplicationFormInput,
  ): Promise<EventApplicationFormRecord>;
  /**
   * Return the event's form of `purpose`, creating it with default settings
   * (no questions, no window, no cap, `updatedByHumanId` null) when missing.
   * Never touches an existing row. Safe inside `repos.tx()`: the insert is
   * `ON CONFLICT DO NOTHING`, so a concurrent create never aborts the
   * transaction. Backs submissions to an APPLICATION-gated event whose
   * organizer never saved a form (a submission needs a formId).
   */
  ensureForm(input: {
    eventId: string;
    purpose: ApplicationFormPurpose;
  }): Promise<EventApplicationFormRecord>;
  listQuestions(formId: string): Promise<EventApplicationQuestionRecord[]>;
  upsertQuestion(
    input: UpsertEventApplicationQuestionInput,
  ): Promise<EventApplicationQuestionRecord>;
  deleteQuestion(questionId: string): Promise<void>;
  createSubmission(
    input: CreateEventApplicationSubmissionInput,
  ): Promise<EventApplicationSubmissionRecord>;
  updateSubmissionStatus(
    input: UpdateEventApplicationSubmissionStatusInput,
  ): Promise<EventApplicationSubmissionRecord>;
  listSubmissions(
    input: ListApplicationSubmissionsInput,
  ): Promise<OffsetPaginatedResult<EventApplicationSubmissionRecord>>;
  /**
   * COUNT(*) of the submissions on an event's form of `purpose`, optionally
   * filtered to a status set.
   * Backs the maxSubmissions cap check (non-WITHDRAWN / non-EXPIRED count) —
   * a real SQL count, never list-and-count.
   */
  countSubmissions(input: CountApplicationSubmissionsInput): Promise<number>;
  /**
   * Nightly expiry sweep (spec Phase 2): flip every PENDING submission whose
   * application form closed strictly before `cutoff`
   * (= now - grace) to EXPIRED. ATTEND forms only — the type admits nothing
   * else: an open call (PERFORM) never auto-closes at its deadline (open
   * calls Q12 / FR-004; closesAt only stops new applications).
   * Read-then-guarded-write (the booking-request sweep's old bulk shape,
   * before booking-the-night P2d-2 made it per-request): the update
   * re-checks status PENDING so a concurrent review/withdraw between read
   * and write is never clobbered.
   * Returns the count actually flipped plus the candidate ids (for the
   * batch audit row).
   */
  expireSubmissionsForClosedForms(input: {
    cutoff: Date;
    purpose: "ATTEND";
  }): Promise<{ count: number; ids: string[] }>;
  /**
   * By id / by approval token. Event-owned submissions only: a series-call
   * submission (eventId NULL) reads as `null`, since this record's eventId is
   * non-null.
   */
  getSubmissionById(
    submissionId: string,
  ): Promise<EventApplicationSubmissionRecord | null>;
  getSubmissionByToken(
    token: string,
  ): Promise<EventApplicationSubmissionRecord | null>;
  /**
   * The human's latest submission on the event's form of `purpose` (the
   * viewer's own application status).
   */
  getSubmissionByEventAndHuman(
    eventId: string,
    purpose: ApplicationFormPurpose,
    humanId: string,
  ): Promise<EventApplicationSubmissionRecord | null>;
  /**
   * One-open-application dedupe pre-check (spec Phase 3 item 2 / D5). "Open"
   * = PENDING | APPROVED | WAITLISTED — WITHDRAWN / REJECTED / EXPIRED
   * deliberately do NOT block, so an applicant may re-apply.
   *
   * Exactly one identity is supplied: `humanId` for signed-in applicants,
   * `contactEmail` for guests (lowercased at rest, so a plain equality match
   * agrees with the `lower(contactEmail)` index expression). A `humanId`
   * lookup matches SELF rows only (`applyingAsOrgId` null, owner ruling
   * Q42): a row sent as an org dedupes on the org, under
   * "EventApplicationSubmission_open_org_key", not on its submitter. The
   * pre-check RACES; the SQL-only partial unique indexes
   * ("EventApplicationSubmission_open_human_key" / "..._open_org_key" /
   * "..._open_guest_key") are the authoritative backstop and the adapter maps
   * their P2002 to `duplicate_open_application`.
   */
  findOpenSubmission(
    input: FindOpenApplicationSubmissionInput,
  ): Promise<EventApplicationSubmissionRecord | null>;
  /**
   * Attach a guest submission to a human, ONLY while it is still ownerless
   * (compare-and-swap on `humanId IS NULL`). Backs the claim-link path: a
   * guest who signs up with the matching email and redeems their approval
   * link gets the submission bound to their account.
   *
   * Returns the updated record, or `null` when the CAS lost (already
   * attached) — never throws for that case. A P2002 from the open-human
   * partial unique index (the redeemer already has an open submission on this
   * event) also surfaces as `null`: attaching is best-effort and must never
   * fail the redemption.
   */
  attachSubmissionToHuman(input: {
    submissionId: string;
    humanId: string;
  }): Promise<EventApplicationSubmissionRecord | null>;
  /**
   * Compare-and-lock for ONE approval instance: matches only while the
   * submission belongs to `eventId`'s form of `purpose`, is APPROVED, and
   * still carries the
   * `reviewedAt` of the approval the caller read (re-approval stamps a fresh
   * one; rescind nulls it). Resolves `true` when it matched, `false`
   * otherwise. Never throws for a miss.
   *
   * A match takes the submission's ROW LOCK, held until the surrounding
   * transaction ends, so call it inside `repos.tx()` before writing anything
   * that depends on the approval (the subject's `EventUnlock`). A rescind
   * that commits first makes it miss; a rescind that starts after it waits
   * for this transaction and then revokes what it wrote. Without the lock, a
   * rescind landing between an APPROVED read and the unlock upsert would
   * leave a live durable unlock on a PENDING submission.
   */
  lockApprovedSubmission(input: {
    submissionId: string;
    eventId: string;
    purpose: ApplicationFormPurpose;
    reviewedAt: Date;
  }): Promise<boolean>;

  // ── Open calls (PERFORM forms; open calls v1 step 3) ─────────────────────
  // Every method below reads or writes PERFORM forms only: an ATTEND form is
  // invisible to them (a lookup by its id or publicId answers null).

  /** The anchor's open call, or null. */
  getOpenCall(anchor: OpenCallAnchor): Promise<OpenCallFormRecord | null>;
  /** By form id; null for a missing id or an ATTEND form. */
  getOpenCallById(formId: string): Promise<OpenCallFormRecord | null>;
  /**
   * By public id (`/call/<publicId>`); null for a missing id or an ATTEND
   * form. `ownerBanned` is derived at read time from the anchor's owner
   * (the event's humanId/orgId, or the series' owner) with the same
   * ban-that-sticks rule as `events.getById(id, { withOwnerStanding })`.
   */
  getOpenCallByPublicId(
    publicId: string,
  ): Promise<(OpenCallFormRecord & { ownerBanned: boolean }) | null>;
  /**
   * Create or update the anchor's open call (presence semantics, see
   * {@link UpsertOpenCallFormInput}). Mints `publicId` on create. Core
   * validates pay and the one-call-per-night rule before calling.
   */
  upsertOpenCall(input: UpsertOpenCallFormInput): Promise<OpenCallFormRecord>;
  /**
   * Transaction-scoped advisory lock on a series' open calls. Serialises
   * "create a series call" against "create an own call on one of its
   * events" (FR-001), so the two existence checks cannot both pass in
   * racing transactions. Call inside `repos.tx()`.
   */
  lockSeriesOpenCalls(seriesId: string): Promise<void>;
  /**
   * Upcoming events (startsAt after `startsAfter`, not cancelled or
   * archived) linked to the series through a non-DETACHED occurrence that
   * hold their OWN open call. A series call is refused while any exist.
   */
  listUpcomingEventOpenCallsInSeries(input: {
    seriesId: string;
    startsAfter: Date;
  }): Promise<SeriesEventOpenCallRecord[]>;
  /**
   * Read the open call and take its row lock FOR UPDATE until the
   * surrounding transaction ends (call inside `repos.tx()`). Close and
   * reopen use it: FOR UPDATE conflicts with the FOR KEY SHARE lock a
   * submission INSERT's foreign-key check takes, so a submit already in
   * flight commits before the close sweep reads, and the sweep sees it.
   */
  lockOpenCallForClose(formId: string): Promise<OpenCallFormRecord | null>;
  /**
   * Read the open call FOR KEY SHARE (call inside `repos.tx()`). The submit
   * path (step 4) MUST read the call through this and refuse when
   * `closedAt` is set: FOR KEY SHARE conflicts with close's FOR UPDATE, so
   * it waits for a close in flight and then returns the closed row, and no
   * PENDING application can land after the close sweep ran. It does not
   * conflict with a plain organizer edit of the row (FOR NO KEY UPDATE).
   *
   * Submit MUST refuse when `postedAt` is null (a draft call, owner ruling
   * Q41) OR `closedAt` is set, both read from THIS locked row.
   */
  lockOpenCallForSubmit(formId: string): Promise<OpenCallFormRecord | null>;
  /**
   * Re-read the open call FOR NO KEY UPDATE (call inside `repos.tx()`, after
   * `lockOpenCallForSubmit`). Submit takes it when the locked row has a
   * `maxSubmissions` cap, so the cap is HARD: two capped submits serialise
   * on it, and the second counts after the first committed. It still waits
   * for close's FOR UPDATE, and does not conflict with the FOR KEY SHARE a
   * submission INSERT's foreign-key check takes (upgrading from KEY SHARE
   * cannot deadlock against another submitter's KEY SHARE). It does queue
   * behind an organizer's edit of the row, briefly.
   */
  lockOpenCallForCappedSubmit(formId: string): Promise<OpenCallFormRecord | null>;
  /**
   * Stamp "Post call" (owner ruling Q41). One-way: there is no unpost.
   * Core checks the call may be posted before calling.
   */
  setOpenCallPosted(input: {
    formId: string;
    postedAt: Date;
    postedByHumanId: string;
  }): Promise<OpenCallFormRecord>;
  /**
   * Delete a DRAFT open call (postedAt null) that has no submissions, with
   * its questions. Guarded in the statement itself (PERFORM, unposted, no
   * submission rows), so a posted call or one with applications is never
   * removed even if core's checks were skipped. Returns false when nothing
   * matched (already gone, or no longer a deletable draft). Call inside
   * `repos.tx()` after `lockOpenCallForClose`, so no submission can land in
   * between (its FK check needs KEY SHARE on the form row).
   */
  deleteOpenCallDraft(formId: string): Promise<boolean>;
  /** Set (close) or clear (reopen) `closedAt` / `closedByHumanId`. */
  setOpenCallClosed(input: {
    formId: string;
    closedAt: Date | null;
    closedByHumanId: string | null;
  }): Promise<OpenCallFormRecord>;
  /**
   * The close sweep (FR-020): every PENDING submission on the form becomes
   * REJECTED with `reviewedAt` stamped, in one statement. Anything already
   * decided (APPROVED, REJECTED, WITHDRAWN, EXPIRED) is untouched. Returns
   * the ids it flipped, for the per-submission notices.
   */
  rejectPendingOpenCallSubmissions(input: {
    formId: string;
    reviewedAt: Date;
  }): Promise<{ ids: string[] }>;
  /** COUNT(*) of one form's submissions, by status set (any anchor). */
  countSubmissionsByForm(input: CountSubmissionsByFormInput): Promise<number>;
  /**
   * The poster's open calls for their public page (FR-003): POSTED
   * (owner ruling Q41) PERFORM forms not closed, on a PUBLIC event that is not cancelled / archived /
   * completed and starts after `now`, or on an unarchived series with a live
   * occurrence after `now`. Owner-withheld (banned) posters list nothing.
   * Ordered by next start, capped at `limit`.
   */
  listOpenCallsByPoster(input: {
    poster: OpenCallPoster;
    now: Date;
    limit: number;
  }): Promise<PosterOpenCallRecord[]>;

  // ── Open-call applications (PERFORM submissions; open calls v1 step 4) ───
  // Every method below reaches PERFORM submissions only: a submission on an
  // ATTEND form is invisible to the reads and untouched by the writes.

  /**
   * Insert an open-call submission and its date choices in ONE statement.
   * Call inside `repos.tx()` after `lockOpenCallForSubmit` on `formId`. A
   * P2002 from the one-open-application partial unique indexes surfaces as
   * a use-case error `{ code: "duplicate_open_application" }` (same mapping
   * as `createSubmission`); any other unique violation surfaces as itself.
   */
  createOpenCallSubmission(
    input: CreateOpenCallSubmissionInput,
  ): Promise<OpenCallSubmissionRecord>;
  /** By id; null for a missing id or a submission on an ATTEND form. */
  getOpenCallSubmissionById(
    submissionId: string,
  ): Promise<OpenCallSubmissionRecord | null>;
  /**
   * By the SHA-256 (hex) of a status-link token, through the unique index
   * on `statusTokenHash`. Null for no match or an ATTEND submission.
   */
  getOpenCallSubmissionByTokenHash(
    statusTokenHash: string,
  ): Promise<OpenCallSubmissionRecord | null>;
  /**
   * The applicant's edit (FR-010): answers, snapshot, isPrivate, and the
   * date choices replaced wholesale. GUARDED in the write: lands only while
   * the row is PENDING with `openedAt` null; otherwise returns null and
   * changes nothing. Call inside `repos.tx()` (the choice replace is a
   * delete + insert after the guarded update, which holds the row lock).
   * The guard is a single-table UPDATE (no relation filter, so the WHERE is
   * re-checked under the row lock): `formId` is the PERFORM form the caller
   * read this id on (`getOpenCallSubmissionById` / `...ByTokenHash`), so an
   * attendee row never matches.
   */
  updateOpenCallSubmission(
    input: UpdateOpenCallSubmissionInput,
  ): Promise<OpenCallSubmissionRecord | null>;
  /**
   * PENDING -> WITHDRAWN, guarded in the write. True when this call flipped
   * it; false when the row was not PENDING (already withdrawn, decided).
   * Single-table UPDATE keyed by (id, formId) like `updateOpenCallSubmission`.
   */
  withdrawPendingOpenCallSubmission(input: {
    submissionId: string;
    formId: string;
  }): Promise<boolean>;
  /**
   * Set "Keep my application private" (owner ruling (a)): allowed in every
   * status except WITHDRAWN, opened or not, open call or closed, but ONLY on
   * the row that is its identity's LATEST on the form (the row the peer list
   * judges privacy by; see {@link isLatestOpenCallSubmission}). ONE
   * statement: it locks the row (FOR UPDATE) to read the pre-image and
   * updates it under the guard (id, formId, status <> WITHDRAWN, no later
   * same-identity row), so a withdraw that commits first is never
   * overwritten and two concurrent toggles agree on what changed. Setting the
   * value it already has still matches.
   *
   * Returns the updated record plus `wasPrivate` (the LOCKED row's value
   * before this write), or `null` when nothing matched (withdrawn,
   * superseded, or not a row of that PERFORM form). Never touches the
   * identity's other rows.
   */
  setOpenCallSubmissionPrivacy(input: {
    submissionId: string;
    formId: string;
    isPrivate: boolean;
  }): Promise<{ record: OpenCallSubmissionRecord; wasPrivate: boolean } | null>;
  /**
   * True when no later row (createdAt DESC, id DESC, the peer list's order)
   * of the same applicant identity exists on the submission's form. Identity
   * as in {@link listOpenCallPeers}: an org row is the org, a self row the
   * human (self rows only), a guest row lower(contactEmail). False for an
   * unknown id or a row of another form.
   */
  isLatestOpenCallSubmission(input: { submissionId: string; formId: string }): Promise<boolean>;
  /**
   * The applicant-facing peer list (FR-008), filtered and deduped IN THE
   * QUERY: ONE entry per applicant identity (an org row is the org, a self
   * row the human, a guest row lower(contactEmail)), so a re-application
   * after "not this time" never shows twice. Privacy is per identity: the
   * identity's LATEST row (createdAt DESC, id DESC) decides, and if it is
   * private or WITHDRAWN the identity is not listed at all (an older public
   * row never surfaces it). Also excludes banned people / orgs and every row
   * sharing the VIEWER's identity (their human's self rows, the org they
   * applied as, or a guest viewer's email). Ordered by each identity's FIRST
   * application (all its rows), so a re-applicant keeps their place; at most
   * `limit`.
   * Display fields only ({@link OpenCallPeerRecord}). Photo and page slug
   * come from a PUBLIC entity page only.
   */
  listOpenCallPeers(input: {
    formId: string;
    /** The viewing submission's identity fields. */
    viewer: {
      humanId: string | null;
      applyingAsOrgId: string | null;
      contactEmail: string | null;
    };
    limit: number;
  }): Promise<OpenCallPeerRecord[]>;
  /**
   * A human's open-call applications, newest first (FR-009 hub): their SELF
   * applications (humanId, applyingAsOrgId null) plus EVERY application of
   * the orgs in `orgIds`, whoever submitted it. Core passes the orgs where
   * the human currently holds an edit role (actsForOpenCallOrg), so an org
   * application the human submitted for an org they left is not listed.
   */
  listOpenCallSubmissionsByHuman(input: {
    humanId: string;
    orgIds: readonly string[];
    limit: number;
  }): Promise<MyOpenCallApplicationRecord[]>;

  // ── Open-call review (organizer side; open calls v1 step 5) ──────────────
  // Organizer-side reads and writes. Core checks the organizer side and that
  // the submission belongs to the form BEFORE calling any of these; votes,
  // notes and the organizer view of a card are never on an applicant read.

  /**
   * The review queue (FR-012/FR-013), one page. Order is FIXED: createdAt
   * ASC, id ASC (time applied, oldest first); there is no other order. The
   * filter is applied in the query. Per card, in bulk for the page (a fixed
   * number of queries, never one per card): display name and public-page
   * photo/slug, vote tally and the viewer's vote, note count, unread
   * APPLICANT messages, and the trust-trace counts. Traces are display only
   * and never touch the order. `nextCursor` = the last card's submission id
   * when another page exists. Cards carry NO answers or questions snapshot
   * (FR-010): answers are read only when a card is opened, which stamps
   * openedAt first.
   */
  listOpenCallReviewCards(
    input: ListOpenCallReviewCardsInput,
  ): Promise<{ items: OpenCallReviewCardRecord[]; nextCursor: string | null }>;
  /**
   * Stamp `openedAt` on the first open (FR-010: this is what locks the
   * applicant's edits). ONE guarded UPDATE keyed by (id, formId) WHERE
   * openedAt IS NULL, so it lands once; true when this call stamped it.
   */
  markOpenCallSubmissionOpened(input: {
    submissionId: string;
    formId: string;
    openedAt: Date;
  }): Promise<boolean>;

  // ── Deciding (open calls v1 step 6: pick, not this time, drop out) ──────
  // LOCK ORDER for every decision path: the SUBMISSION row first
  // (`lockOpenCallSubmission`), then lineup (EventHuman) rows. Never the
  // form row: close holds the form FOR UPDATE and then updates submissions,
  // so a decision that also wanted the form row would invert that order.

  /**
   * Take the submission's row lock FOR UPDATE until the surrounding
   * transaction ends (call inside `repos.tx()`), then return the record as
   * of that lock. Locks the submission row ONLY (no join, so neither the
   * form nor the event row is locked). Null for an unknown id, a row of
   * another form, or a submission on an ATTEND form. Every decision path
   * (pick, decline, drop out, lineup leave / removal) reads the status it
   * judges from THIS, so two decisions on one application serialise and
   * the second sees the first's result.
   */
  lockOpenCallSubmission(input: {
    submissionId: string;
    formId: string;
  }): Promise<OpenCallSubmissionRecord | null>;
  /**
   * PENDING | WAITLISTED -> APPROVED (spec FR-016), stamping reviewer and
   * reviewedAt. One guarded single-table UPDATE keyed by (id, formId); true
   * when this call flipped it.
   */
  approveOpenCallSubmission(input: {
    submissionId: string;
    formId: string;
    reviewerHumanId: string;
    reviewedAt: Date;
  }): Promise<boolean>;
  /**
   * PENDING | WAITLISTED -> REJECTED ("not this time", spec FR-018) with the
   * optional note in `decisionReason`. Guarded like
   * `approveOpenCallSubmission`; true when this call flipped it.
   */
  rejectOpenCallSubmission(input: {
    submissionId: string;
    formId: string;
    reviewerHumanId: string;
    reviewedAt: Date;
    decisionReason: string | null;
  }): Promise<boolean>;
  /**
   * APPROVED -> WITHDRAWN with `droppedOutAt` (spec FR-017). Guarded; true
   * when this call flipped it.
   */
  markOpenCallSubmissionDroppedOut(input: {
    submissionId: string;
    formId: string;
    droppedOutAt: Date;
  }): Promise<boolean>;
  /**
   * Stamp `removedFromLineupAt` on an APPROVED submission (spec FR-019);
   * status stays APPROVED. Guarded on APPROVED and `removedFromLineupAt IS
   * NULL`, so the first removal's instant is kept; true when it stamped.
   */
  markOpenCallSubmissionRemovedFromLineup(input: {
    submissionId: string;
    formId: string;
    removedAt: Date;
  }): Promise<boolean>;
  /**
   * Lock EVERY submission of one act on the form, whatever its status, FOR
   * UPDATE in ascending id order (deterministic, so two lineup-exit paths
   * locking several rows never invert), and return them as of the lock.
   * Identity (see {@link OpenCallLineupAct}): a person's SELF rows
   * (applyingAsOrgId null), an organisation's rows, or guest rows (humanId
   * and applyingAsOrgId null) whose `guestName` equals the name, trimmed and
   * case-insensitive. The guest URL is NOT matched here, so the lock covers
   * a superset; core filters by the full identity under the lock. PERFORM
   * forms only. Call inside `repos.tx()`, BEFORE touching lineup rows (lock
   * order: submission rows, then EventHuman rows).
   */
  lockOpenCallSubmissionsByAct(input: {
    formId: string;
    act: OpenCallLineupAct;
  }): Promise<OpenCallSubmissionRecord[]>;

  // ── Sweep + reconcile (open calls v1 step 8: sweep-open-calls job) ──────

  /**
   * PENDING PERFORM applications the sweep must settle now, with the
   * verdict (see {@link OpenCallSweepVerdict}), oldest `createdAt` first
   * (then id), at most `limit`. The rule, per application:
   *   1. event call on a CANCELLED event → pulled;
   *   2. its LAST LIVE DATE: the latest chosen date that is not called off
   *      (EventDate SCHEDULED; occurrence PLANNED / GENERATED / PUBLISHED
   *      and its materialised event, if any, not CANCELLED). With NO stored
   *      choice: an event call's implied night (step 4 stores none when one
   *      date was upcoming) = the earliest SCHEDULED EventDate after the
   *      application was made, or the event's own start when it has no
   *      date rows; a series call (choices always stored, so only when a
   *      schedule change cascaded them away) has none;
   *   3. no live date → pulled;
   *   4. last live date started (`<= now`) → backstop;
   *   5. anchor shelved (event ARCHIVED / COMPLETED, series archived) → pulled;
   *   6. otherwise not due (not returned).
   * Read-only; the flip is `settlePendingOpenCallSubmissions`.
   */
  listOpenCallSweepDue(input: { now: Date; limit: number }): Promise<OpenCallSweepDueRecord[]>;
  /**
   * PENDING → `status` (REJECTED for a backstop, EXPIRED for a pulled call)
   * with `reviewedAt` stamped, for the given PERFORM submissions, in ONE
   * guarded UPDATE: a row no longer PENDING when the statement re-checks it
   * under its row lock (a concurrent pick, decline, withdraw or close that
   * committed first) is left alone. Returns the ids THIS call flipped; only
   * those get a notice.
   */
  settlePendingOpenCallSubmissions(input: {
    submissionIds: string[];
    status: "REJECTED" | "EXPIRED";
    reviewedAt: Date;
  }): Promise<{ ids: string[] }>;
  /**
   * Every UNDECIDED submission (PENDING or WAITLISTED) on one PERFORM form
   * → EXPIRED with `reviewedAt` stamped, in one guarded statement (the
   * delete path's FR-022 retire, before the event's cascade: someone
   * waiting is told the call was pulled, as someone pending is). Call
   * inside `repos.tx()` after `lockOpenCallForClose`. Returns the ids it
   * flipped.
   */
  expireUndecidedOpenCallSubmissions(input: {
    formId: string;
    reviewedAt: Date;
  }): Promise<{ ids: string[] }>;
  /**
   * One page of a PERFORM form's submissions in `statuses`, ordered by id,
   * strictly after `afterId` when given, at most `limit`. The delete path
   * walks the REJECTED and EXPIRED ones to settle every owed notice before
   * the cascade removes them (the ledger check is core's).
   */
  listOpenCallSubmissionsByFormStatus(input: {
    formId: string;
    statuses: Array<"REJECTED" | "EXPIRED">;
    afterId: string | null;
    limit: number;
  }): Promise<Array<{ submissionId: string; status: "REJECTED" | "EXPIRED" }>>;
  /**
   * One page of a reconcile scan (see {@link OpenCallReconcileKind}): PERFORM
   * submissions whose window instant `at` is in [`since`, `until`], ordered
   * by (`at`, id) ascending, strictly after the `after` cursor when given,
   * at most `limit`. The ledger check is core's (the notice ledger lives in
   * the idempotency store, not here).
   */
  listOpenCallNoticeReconcileRows(input: {
    kind: OpenCallReconcileKind;
    since: Date;
    until: Date;
    after: { at: Date; submissionId: string } | null;
    limit: number;
  }): Promise<OpenCallReconcileRow[]>;

  /**
   * Set (or with `vote: null`, clear) one organizer human's vote. Set is a
   * single INSERT .. ON CONFLICT (submissionId, humanId) DO UPDATE, so two
   * concurrent votes by one human leave one row.
   */
  setApplicationVote(input: {
    submissionId: string;
    humanId: string;
    vote: ApplicationVoteValue | null;
    at: Date;
  }): Promise<void>;
  /** The tally and one human's own vote on a submission. */
  getApplicationVoteSummary(input: {
    submissionId: string;
    viewerHumanId: string;
  }): Promise<{
    votes: { yes: number; maybe: number; no: number };
    myVote: ApplicationVoteValue | null;
  }>;
  createApplicationNote(input: {
    submissionId: string;
    authorHumanId: string;
    body: string;
    createdAt: Date;
  }): Promise<ApplicationNoteRecord>;
  /** A submission's notes, oldest first, at most `limit`. */
  listApplicationNotes(input: {
    submissionId: string;
    limit: number;
  }): Promise<ApplicationNoteRecord[]>;
  createApplicationMessage(input: {
    submissionId: string;
    authorSide: ApplicationMessageAuthorSide;
    authorHumanId: string | null;
    body: string;
    createdAt: Date;
  }): Promise<ApplicationMessageRecord>;
  /**
   * One thread page, oldest first (createdAt ASC, id ASC). Cursor = the
   * last message id of the previous page, resolved on THIS submission (a
   * foreign id restarts from the top).
   */
  listApplicationMessages(input: {
    submissionId: string;
    cursor: string | null;
    limit: number;
  }): Promise<{ items: ApplicationMessageRecord[]; nextCursor: string | null }>;
  /**
   * The reader stamps `readAt` on the OTHER side's messages with
   * createdAt <= upToCreatedAt that are still unread. Monotonic: a stamped
   * row is never re-stamped or cleared. Returns the rows newly stamped.
   */
  markApplicationMessagesRead(input: {
    submissionId: string;
    readerSide: ApplicationMessageAuthorSide;
    upToCreatedAt: Date;
    readAt: Date;
  }): Promise<number>;
}

export interface EventWaitlistsRepo {
  createEntry(
    input: CreateWaitlistEntryInput,
  ): Promise<EventWaitlistEntryRecord>;
  updateEntry(
    input: UpdateWaitlistEntryStatusInput,
  ): Promise<EventWaitlistEntryRecord>;
  listEntries(
    input: ListWaitlistEntriesInput,
  ): Promise<EventWaitlistEntryRecord[]>;
  findEntry(
    input: FindWaitlistEntryInput,
  ): Promise<EventWaitlistEntryRecord | null>;
}

export interface InviteListsRepo {
  createList(input: CreateInviteListInput): Promise<InviteListRecord>;
  updateList(input: UpdateInviteListInput): Promise<InviteListRecord>;
  deleteList(inviteListId: string): Promise<void>;
  listByOwner(input: ListInviteListsByOwnerInput): Promise<InviteListRecord[]>;
  getListById(inviteListId: string): Promise<InviteListRecord | null>;
  createEntry(
    input: CreateInviteListEntryInput,
  ): Promise<InviteListEntryRecord>;
  /** `null` when no entry with that id exists IN that list. */
  getEntry(input: GetInviteListEntryInput): Promise<InviteListEntryRecord | null>;
  /** `null` when no entry with that id exists IN that list. */
  updateEntry(
    input: UpdateInviteListEntryInput,
  ): Promise<InviteListEntryRecord | null>;
  /** `deleted: false` when no entry with that id exists IN that list. */
  deleteEntry(input: DeleteInviteListEntryInput): Promise<{ deleted: boolean }>;
  listEntries(
    input: ListInviteListEntriesInput,
  ): Promise<InviteListEntryRecord[]>;
  copyEntries(input: CopyInviteListEntriesInput): Promise<number>;
  /** Batch-insert entries with ON CONFLICT DO NOTHING for dedup by email/phone. */
  batchUpsertEntries(
    input: BatchUpsertInviteListEntriesInput,
  ): Promise<BatchUpsertResult>;
  /** Delete all entries belonging to a list. Returns the number of rows deleted. */
  deleteAllEntries(inviteListId: string): Promise<number>;
  /** Recalculate InviteList.contactCount from COUNT(*) of entries. */
  updateListCounts(inviteListId: string): Promise<void>;
  attachToEvent(
    input: AttachInviteListToEventInput,
  ): Promise<EventInviteListLinkRecord>;
  detachFromEvent(input: DetachInviteListFromEventInput): Promise<void>;
  listEventLinks(eventId: string): Promise<EventInviteListLinkRecord[]>;
  /** Find an entry by list + email (used for unsubscribe lookup). */
  getEntryByListAndEmail(
    inviteListId: string,
    email: string,
  ): Promise<InviteListEntryRecord | null>;
  /** Mark an entry as unsubscribed. */
  unsubscribeEntry(
    entryId: string,
    unsubscribedAt: Date,
  ): Promise<InviteListEntryRecord>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact Imports (ledger for bulk imports)
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactImportsRepo {
  create(input: CreateContactImportInput): Promise<ContactImportRecord>;
  getById(importId: string): Promise<ContactImportRecord | null>;
  incrementCounts(
    input: IncrementContactImportCountsInput,
  ): Promise<ContactImportRecord>;
  complete(importId: string, completedAt: Date): Promise<ContactImportRecord>;
  listByOwner(
    input: ListContactImportsByOwnerInput,
  ): Promise<ContactImportRecord[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event invites (gated-event invite links,
// docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml)
// ─────────────────────────────────────────────────────────────────────────────

/** SHARED: one live link per event. PERSONAL: one live link per guest email. */
export type EventInviteKind = "SHARED" | "PERSONAL";

export interface EventInviteRecord {
  id: string;
  eventId: string;
  kind: EventInviteKind;
  /** PERSONAL only. */
  inviteeName: string | null;
  /** PERSONAL only; always lowercase (a DB CHECK enforces it). */
  inviteeEmail: string | null;
  /** SHA-256 hex of the raw token. The raw token is never stored. */
  tokenHash: string;
  /** Null once the creating Human is deleted. */
  createdByHumanId: string | null;
  inviteListEntryId: string | null;
  metadata: Record<string, unknown>;
  /** Set = the link no longer works. */
  revokedAt: Date | null;
  firstRedeemedAt: Date | null;
  redemptionCount: number;
  /** PERSONAL: when the invite email was last sent. */
  sentAt: Date | null;
  /**
   * SHARED only: set by "Reset and remove everyone". Once set, the grants
   * this link handed out stop holding (th_ei_ cookies, unlocks, approvals).
   * A plain reset leaves it null (R5). Always null on PERSONAL rows, whose
   * grants follow `revokedAt`.
   */
  grantsRevokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CreateEventInviteBase {
  /**
   * Caller-chosen row id (a v4 UUID). The token is HMAC(secret, inviteId)
   * and the row stores its hash, so the id has to exist before the insert.
   * Absent = the DB default.
   */
  id?: string;
  eventId: string;
  tokenHash: string;
  createdByHumanId: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSharedEventInviteInput extends CreateEventInviteBase {
  kind: "SHARED";
}

export interface CreatePersonalEventInviteInput extends CreateEventInviteBase {
  kind: "PERSONAL";
  inviteeName: string | null;
  /** The adapter trims and lowercases it (stored lowercase, DB CHECK). */
  inviteeEmail: string;
  inviteListEntryId?: string | null;
  sentAt?: Date | null;
}

export type CreateEventInviteInput =
  | CreateSharedEventInviteInput
  | CreatePersonalEventInviteInput;

/**
 * Domain errors the adapter throws (plain `{ code, message, cause }` objects,
 * like `duplicate_open_application`). Each maps a P2002 on one of the SQL-only
 * partial unique indexes from migration 20261003120000_event_invites, matched
 * by INDEX NAME. Any other failure (including a CHECK violation) is rethrown
 * untouched.
 * - `shared_invite_already_live`: "EventInvite_live_shared_key".
 * - `personal_invite_already_live`: "EventInvite_personal_email_key".
 */
export type EventInviteRepoErrorCode =
  | "shared_invite_already_live"
  | "personal_invite_already_live";

export interface EventInvitesRepo {
  /**
   * Insert an invite. Throws `shared_invite_already_live` /
   * `personal_invite_already_live` when a live row of that kind already
   * exists (the use case's pre-check races; the index is the backstop).
   */
  create(input: CreateEventInviteInput): Promise<EventInviteRecord>;
  getById(id: string): Promise<EventInviteRecord | null>;
  /** Exact lookup on the SHA-256 hex. Returns revoked rows too. */
  getByTokenHash(tokenHash: string): Promise<EventInviteRecord | null>;
  /** The event's live (unrevoked) SHARED invite, if any. */
  getLiveShared(eventId: string): Promise<EventInviteRecord | null>;
  /** Every invite for the event, revoked rows included, newest first. */
  listByEvent(eventId: string): Promise<EventInviteRecord[]>;
  /** The live PERSONAL invite for this email (matched case-insensitively). */
  findLivePersonalByEmail(
    eventId: string,
    email: string,
  ): Promise<EventInviteRecord | null>;
  /**
   * Set `revokedAt` if still live. Idempotent: an already-revoked row keeps
   * its original `revokedAt`. Returns the row, or null when it doesn't exist.
   */
  revoke(id: string, at: Date): Promise<EventInviteRecord | null>;
  /**
   * Count one new redemption: `redemptionCount + 1` and `firstRedeemedAt`
   * set if still null. Two guarded UPDATEs in one transaction (the caller's,
   * or its own), never read-then-write: `firstRedeemedAt` is stamped only
   * while null, and the count is a SQL-side increment. The UPDATE takes the
   * invite's row lock until that transaction ends, and the returned row
   * reflects a concurrent revoke that committed first (`revokedAt` set).
   * Returns null when the row doesn't exist.
   */
  recordRedemption(id: string, at: Date): Promise<EventInviteRecord | null>;
  /**
   * Take the invite's row lock for the rest of the caller's transaction, but
   * only while it is LIVE. True when the row exists and is unrevoked.
   *
   * A guarded no-op UPDATE (the `lockApprovedSubmission` pattern), so a
   * revoke can't commit between this check and the caller's later writes:
   * a revoke already holding the lock makes this wait, then re-check the
   * committed row and return false; a revoke arriving after waits for the
   * caller's commit, and its `revokeByInvite` then sees what was written.
   * Must run inside a transaction to hold anything.
   */
  lockIfLive(id: string): Promise<boolean>;
  /**
   * The SHARED counterpart of {@link lockIfLive}: take the invite's row lock
   * for the rest of the caller's transaction, but only while its GRANTS
   * still hold (`grantsRevokedAt` is null; a plain reset's `revokedAt` does
   * not matter, R5). True when the row exists and its grants hold. Same
   * guarded no-op UPDATE, so "Reset and remove everyone" can't commit
   * between this check and the caller's grant write: if it comes second it
   * waits, and its `revokeByInvite` then removes what was written.
   */
  lockIfGrantsHold(id: string): Promise<boolean>;
  /**
   * "Reset and remove everyone": stamp `grantsRevokedAt = at` on every
   * SHARED invite of the event except `exceptInviteId` (the freshly minted
   * live link) that is not stamped yet. A row stamped earlier keeps its
   * first stamp. Returns the ids of EVERY such SHARED invite (stamped now or
   * before), so the caller can revoke what each one granted; re-running is
   * idempotent and repairs anything an earlier run missed.
   */
  revokeSharedGrants(
    eventId: string,
    at: Date,
    opts?: { exceptInviteId?: string },
  ): Promise<string[]>;
  /**
   * Revoke the event's live SHARED invite (if any) and insert `next` in ONE
   * transaction, so the event never has two live shared links and never
   * loses the old one without gaining the new one. A concurrent rotate that
   * wins the race surfaces as `shared_invite_already_live`.
   */
  rotateShared(
    eventId: string,
    next: Omit<CreateSharedEventInviteInput, "eventId" | "kind">,
    at: Date,
  ): Promise<{ revoked: EventInviteRecord | null; created: EventInviteRecord }>;
  /** Stamp `sentAt` (PERSONAL send / resend). Null when the row is missing. */
  markSent(id: string, at: Date): Promise<EventInviteRecord | null>;
}

export type {
  ApplicationFormDefaults,
  ApplicationFormPurpose,
  ApplicationSubmissionStatus,
  ApplyCommunityEditInput,
  AttachInviteListToEventInput,
  AssignEventSlugInput,
  CommunityEditableFieldValues,
  CreateCommunityListingInput,
  BatchUpsertInviteListEntriesInput,
  BatchUpsertResult,
  ContactImportFileFormat,
  ContactImportRecord,
  CopyInviteListEntriesInput,
  CountApplicationSubmissionsInput,
  CreateEventAttestationInput,
  CreateContactImportInput,
  CreateEventApplicationSubmissionInput,
  CreateInviteListEntryInput,
  CreateInviteListInput,
  CreateWaitlistEntryInput,
  FindOpenApplicationSubmissionInput,
  CountSubmissionsByFormInput,
  OpenCallAnchor,
  OpenCallFormRecord,
  OpenCallPayKind,
  OpenCallDateChoiceRecord,
  OpenCallDateChoiceTarget,
  OpenCallSubmissionRecord,
  OpenCallLineupAct,
  CreateOpenCallSubmissionInput,
  UpdateOpenCallSubmissionInput,
  OpenCallPeerRecord,
  MyOpenCallApplicationRecord,
  OpenCallPoster,
  PosterOpenCallRecord,
  SeriesEventOpenCallRecord,
  UpsertOpenCallFormInput,
  ApplicationVoteValue,
  ApplicationMessageAuthorSide,
  OpenCallReviewFilter,
  ListOpenCallReviewCardsInput,
  OpenCallTraceCounts,
  OpenCallReviewCardRecord,
  OpenCallReviewSubmissionRecord,
  ApplicationNoteRecord,
  ApplicationMessageRecord,
  EventApplicationFormRecord,
  EventApplicationQuestionOption,
  EventApplicationQuestionRecord,
  EventApplicationQuestionSnapshotEntry,
  EventApplicationSubmissionRecord,
  EventAttendanceMode,
  EventAttestationAcknowledgements,
  EventAttestationRecord,
  EventGateSettings,
  EventGateType,
  EventInviteListLinkRecord,
  EventLocationMode,
  EventOwnerType,
  OwnerUpcomingEventStats,
  EventMediaReferenceSet,
  EventPopularityStats,
  EventRecord,
  EventSlugContext,
  EventSlugResolution,
  EventSitemapEntryRecord,
  EventStatus,
  EventStewardship,
  EventVisibility,
  EventTicketTypeSummary,
  EventWaitlistEntryRecord,
  FindWaitlistEntryInput,
  IncrementContactImportCountsInput,
  InviteListEntryRecord,
  InviteListRecord,
  ListAllEventsByPlaceInput,
  ListApplicationSubmissionsInput,
  ListContactImportsByOwnerInput,
  ListEventsByOwnerInput,
  WithheldOwnerIds,
  ListInviteListEntriesInput,
  ListInviteListsByOwnerInput,
  ListPublishedOccurrencesByPlaceInput,
  ListWaitlistEntriesInput,
  PlaceOccurrenceRecord,
  SetVenueConfirmationInput,
  VenueConfirmedFor,
  WithdrawVenueConfirmationInput,
  RecordEventSlugHistoryInput,
  DeleteInviteListEntryInput,
  GetInviteListEntryInput,
  UpdateInviteListEntryInput,
  UpdateInviteListInput,
  UpdateWaitlistEntryStatusInput,
  UpdateEventApplicationSubmissionStatusInput,
  UpdateEventSlugInput,
  UpsertEventApplicationFormInput,
  UpsertEventApplicationQuestionInput,
  SaveEventInput,
  DetachInviteListFromEventInput,
  WaitlistStatus,
} from "@th/types";
