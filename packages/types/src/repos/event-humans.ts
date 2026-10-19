import type {
  EventStatus,
  EventStewardship,
  EventVisibility,
  VenueConfirmedFor,
} from "./events";

export type EventHumanRole =
  | "PERFORMER"
  | "HOST"
  | "DJ"
  | "INSTRUCTOR"
  | "SPEAKER"
  | "VENDOR"
  | "VOLUNTEER"
  | "OTHER";

export interface EventHumanRecord {
  id: string;
  eventId: string;
  humanId: string | null;
  /**
   * The group this row IS (lineup v3 FR-015). Never set with `humanId` (SQL
   * CHECK "EventHuman_identity_check"). Null on person and free-text rows.
   */
  orgId: string | null;
  externalName: string | null;
  externalUrl: string | null;
  role: EventHumanRole;
  customRoleLabel: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  profileSlug: string | null;
  humanDisplayName: string | null;
  /**
   * A GROUP row's (`orgId` set) display name — its PUBLIC org page's
   * displayName, else Organization.name — as `listByEvent` resolves it
   * (lineup v3 FR-015). Null / absent on person and free-text rows, and from
   * every reader that does not join it.
   */
  orgName?: string | null;
  /**
   * A GROUP row's org EntityPage slug, ONLY when that page is PUBLIC
   * (`/orgs/{slug}`); null / absent otherwise. Unlike `profileSlug` (which
   * `listByEvent` returns for any page) this is pre-filtered: a private
   * group page is never linked from a lineup.
   */
  orgPageSlug?: string | null;
}

export interface AttachEventHumanInput {
  /**
   * Caller-chosen id for a NEWLY created row (ignored when the upsert finds
   * an existing (eventId, humanId) row). Lets a caller key side records on
   * the row before its transaction — and tell "created" from "re-attached"
   * by comparing the returned id.
   */
  id?: string;
  eventId: string;
  humanId?: string | null;
  /**
   * Attach a GROUP (lineup v3 FR-015). Mutually exclusive with `humanId`:
   * both set throws `{ code: "invalid_input", message:
   * "event_human_person_and_group" }` before any write. Idempotent per
   * (event, org) like the human upsert.
   */
  orgId?: string | null;
  externalName?: string | null;
  externalUrl?: string | null;
  role: EventHumanRole;
  customRoleLabel?: string | null;
  sortOrder?: number;
}

/**
 * A single published performance credit for a Human, backing the musician EPK
 * `shows` / `past_shows` blocks. One row per distinct Event (deduped across
 * multiple performer-role attachments for the same event).
 */
export interface HumanPerformanceSummary {
  eventId: string;
  title: string;
  startsAt: Date;
  /**
   * Resolved venue/place name, or null for events with no linked Place.
   * UNGATED — names the place even when the venue never confirmed the event.
   * Public renderers must derive the display name from the raw fields below
   * (venue-confirmation spec: address-only unless venue-owned or confirmed
   * for `placeId`); kept so existing consumers keep compiling until they do.
   */
  venueName: string | null;
  /** Event slug for building a public link, or null when unset. */
  slug: string | null;
  // ── Raw fields for the confirmation derivation (venue-confirmation spec).
  // The adapter stays dumb; core decides whether the venue may be named.
  placeId: string | null;
  placeName: string | null;
  locationLabel: string | null;
  orgId: string | null;
  humanId: string | null;
  /**
   * COMMUNITY listings are OWNERLESS, so the owner arm of the derivation can
   * never hold for one — they are confirmed (or not) by the place's standing
   * `acceptsCommunityListings` consent instead. Carried raw for the same
   * reason as the columns around it: the adapter stays dumb.
   */
  stewardship: EventStewardship;
  venueConfirmedAt: Date | null;
  venueConfirmationWithdrawnAt: Date | null;
  /** Stamp is live only while `venueConfirmedPlaceId === placeId`. */
  venueConfirmedPlaceId: string | null;
}

export interface ListPerformancesByHumanInput {
  humanId: string;
  /**
   * Roles that count as a listed credit — caller-supplied (profile show
   * listings pass PUBLIC_LINEUP_ROLES; attribution flows pass PERFORMER_ROLES).
   */
  roles: readonly EventHumanRole[];
  /** Split point: upcoming = startsAt > now (asc); past = startsAt <= now (desc). */
  when: "upcoming" | "past";
  now: Date;
  /** Max distinct events returned (applied after dedupe). */
  limit?: number;
}

/**
 * One ACT that has played a place, already grouped in SQL — the venue track
 * record's lineup history (venue-track-record spec 2026-09-24, FR-013 / R7,
 * FU-006). One act = one linked human, or one free-text stage name compared
 * trimmed and case-folded ("the Sundowners" and "The Sundowners " are one
 * act). A linked credit never merges with an unlinked one of the same name —
 * the link is the identity.
 */
export interface ActAtPlaceRow {
  /** Registered human when the act is linked; null for a free-text act. */
  humanId: string | null;
  /**
   * The GROUP when the act is an organization row (lineup v3 FR-015); null /
   * absent otherwise. A group is its own act: its credits never merge with
   * a person's or with a free-text name.
   */
  orgId?: string | null;
  /** The group's PUBLIC org page slug (`/orgs/{slug}`); null otherwise. */
  orgPageSlug?: string | null;
  /**
   * The free-text stage name as last billed (untrimmed, as stored) when
   * unlinked; null for a linked act.
   */
  externalName: string | null;
  /**
   * Display name, trimmed and never empty: the linked human's name (falling
   * back to the credit's stage name when the human has none), else the stage
   * name — the spelling from the act's MOST RECENT credit.
   */
  name: string;
  /**
   * The linked human's profile slug, populated ONLY when the human's
   * EntityPage has `visibility = PUBLIC`; null when unlinked, when there is
   * no page, or when the page is PRIVATE / UNLISTED. (The `listByEvent`
   * lookup returns a slug for ANY page — this row must not copy it; see the
   * PUBLIC filter in `list-public-event-humans.ts`.) Core turns it into
   * `/humans/{slug}`.
   */
  profileSlug: string | null;
  /**
   * DISTINCT shows (`Event.id`) this act played here. Two stages at the same
   * instant are two shows; two credits on one event are one.
   */
  timesPlayed: number;
  /**
   * `Event.startsAt` of the act's most recent show — the DISPLAY instant
   * ("last played <date>"). NOT the ended predicate: the adapter selects on
   * `endsAt <= now` (see `ListActsByPlaceInput.now`).
   */
  lastPlayedAt: Date;
}

export interface ListActsByPlaceInput {
  placeId: string;
  /**
   * Only shows that have ENDED count: `Event.endsAt <= now`. A show in
   * progress is not yet history.
   */
  now: Date;
  /**
   * The place's confirmation filter, built by `venueConfirmedFilterFor(place)`
   * in core — REQUIRED, not optional: an unconfirmed third-party event
   * "blocks nothing and means nothing", and its lineup is not this venue's
   * history (anyone could point an event at the place to plant an act).
   * Same predicate `EventsRepo.listPublishedByPlace` applies.
   */
  venueConfirmedFor: VenueConfirmedFor;
  /**
   * Max acts returned, applied IN SQL after grouping (the venue page asks for
   * its recent line only). `null` = every act (the acts page).
   */
  limit: number | null;
}

export interface ActsAtPlacePage {
  /** Most recently played first, then by name. At most `limit`. */
  acts: ActAtPlaceRow[];
  /** Every distinct act at the place, regardless of `limit`. */
  totalActs: number;
}

/**
 * One of a person's OWN lineup credits — a row of the `/my-lineups` page,
 * where the person reviews every event they have been put on and can take
 * themselves off (owner ruling "option A", 2026-09-30). Unlike
 * {@link HumanPerformanceSummary} this is the SELF view: drafts, private and
 * cancelled events are included, because the person must be able to see (and
 * leave) a lineup before it is public. Never serve it to anyone but the
 * person themselves.
 */
export interface HumanLineupRow {
  eventHumanId: string;
  eventId: string;
  role: EventHumanRole;
  customRoleLabel: string | null;
  eventTitle: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  status: EventStatus;
  visibility: EventVisibility;
  stewardship: EventStewardship;
  /** The event's slug as stored; core exposes it only while PUBLISHED. */
  slug: string | null;
  /** Owning org's name for an org event; null otherwise. */
  orgName: string | null;
  /** Owning human's name for a personal event; null otherwise. */
  ownerHumanName: string | null;
  /** `Event.orgId` — null for personal events and community listings. */
  ownerOrgId: string | null;
  /** `Event.humanId` — the personal-event owner; null otherwise. */
  ownerHumanId: string | null;
}

export interface ListLineupsByHumanInput {
  humanId: string;
  /**
   * `upcoming` = the event has not ended (`endsAt > now`), soonest first;
   * `past` = it has (`endsAt <= now`), most recent first. Ties break on the
   * EventHuman id in the same direction, so the keyset below is total.
   */
  when: "upcoming" | "past";
  now: Date;
  /** Keyset: return rows strictly after this one in the `when` order. */
  after: { startsAt: Date; eventHumanId: string } | null;
  limit: number;
  /**
   * Narrow to events in these statuses, applied IN SQL before `limit`.
   * Omitted = every status (the `/my-lineups` self-view). The navbar's
   * next-night read passes `["PUBLISHED"]`, so a run of upcoming drafts or
   * cancelled shows cannot crowd a live one out of its small page. Every
   * other predicate (the person's own rows, `endsAt` split) is unchanged.
   */
  eventStatuses?: readonly EventStatus[];
}
