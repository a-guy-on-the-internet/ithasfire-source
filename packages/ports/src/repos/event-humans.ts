import type {
  AttachEventHumanInput,
  EventHumanRecord,
  EventHumanRole,
  HumanPerformanceSummary,
  ListPerformancesByHumanInput,
  ActAtPlaceRow,
  ActsAtPlacePage,
  ListActsByPlaceInput,
  HumanLineupRow,
  ListLineupsByHumanInput,
} from "@th/types";

export interface EventHumansRepo {
  attach(input: AttachEventHumanInput): Promise<EventHumanRecord>;
  detach(id: string): Promise<void>;
  listByEvent(eventId: string): Promise<EventHumanRecord[]>;
  reorder(eventId: string, orderedIds: string[]): Promise<void>;
  getById(id: string): Promise<EventHumanRecord | null>;
  /**
   * Stamp humanId on a free-text lineup row, "upgrading" it from external
   * to registered. Used by `inviteLineupHumanToRegister`. The pre-existing
   * externalName is left in place so the public lineup keeps the stage
   * name even when the registered display differs.
   */
  linkHuman(input: { id: string; humanId: string }): Promise<EventHumanRecord>;
  /**
   * Published, publicly-visible performances for a Human — the data path
   * behind the musician EPK `shows` / `past_shows` blocks. A single
   * EventHuman→Event join filtered to `roles`, `status`/`visibility`
   * (mirroring the public event surfaces), and the `when` date split.
   * Deduped by eventId so a PERFORMER+DJ double-credit yields one row.
   */
  listPerformancesByHuman(
    input: ListPerformancesByHumanInput,
  ): Promise<HumanPerformanceSummary[]>;
  /**
   * Who has played a place, GROUPED BY ACT in SQL — the venue track record's
   * lineup history (venue-track-record spec 2026-09-24, FR-013 / R7; FU-006
   * moved the grouping out of core so a public page render reads at most
   * `limit` acts plus a count, not every credit the venue ever had).
   *
   * A credit counts only when ALL of these hold — the same gate under which
   * `listPublicEventHumans` would already show the lineup, so this discloses
   * nothing the event page does not:
   *   · `Event.placeId = placeId`;
   *   · `Event.status IN (PUBLISHED, COMPLETED)` (`TRACK_RECORD_EVENT_STATUSES`,
   *     R10 — a fulfilled booking's show is moved to COMPLETED and still
   *     happened) and `visibility = PUBLIC` — never DRAFT, PRIVATE,
   *     cancelled or archived;
   *   · venue-confirmed for THIS place per `venueConfirmedFor` (the stamp
   *     arm, the owner arm, or the community arm — see `VenueConfirmedFor`);
   *   · the show has ENDED: `Event.endsAt <= now` — enforced HERE, in the
   *     query;
   *   · `EventHuman.role = PERFORMER`. Deliberately PERFORMER only, not
   *     `PUBLIC_LINEUP_ROLES`: the block answers "which acts have played
   *     here", and a host, DJ or vendor credit is not an act on the bill.
   *   · the credit resolves to a non-empty name (linked human's name, else
   *     the stage name) — nothing to name, nothing to list.
   *
   * Acts are keyed by `humanId`, else `lower(trim(externalName))` (see
   * {@link ActAtPlaceRow}). Ordered `lastPlayedAt DESC`, then name, so the
   * recent line is a prefix; `limit` is applied in SQL and `totalActs` counts
   * the whole grouped set.
   *
   * `profileSlug` is set ONLY for a linked human whose EntityPage is
   * `visibility = PUBLIC` — the same filter `list-public-event-humans.ts`
   * applies. Do NOT copy `listByEvent`'s slug lookup, which returns a slug
   * for any page: a PRIVATE profile must not be linked from a venue page.
   *
   * Index-backed (NFR-005): Event side via `Event(placeId, endsAt)` /
   * `(placeId, venueConfirmedAt)`, EventHuman side via
   * `(eventId, sortOrder)` — no full scan of `EventHuman`.
   */
  listActsByPlace(input: ListActsByPlaceInput): Promise<ActsAtPlacePage>;
  /**
   * The registered human's row on one event, or null. `@@unique([eventId,
   * humanId])` makes this at most one row. Used to tell a NEW lineup
   * attachment from a re-attach (the upsert in `attach` cannot), and to find
   * the actor's own row when they leave a lineup.
   */
  getByEventAndHuman(input: {
    eventId: string;
    humanId: string;
  }): Promise<EventHumanRecord | null>;
  /**
   * Every lineup row linked to `humanId`, in any event status, joined to the
   * event and its owner's name — the self-view behind `/my-lineups`. Keyset
   * paged over `(Event.startsAt, EventHuman.id)`; see
   * {@link ListLineupsByHumanInput}. Returns at most `limit` rows.
   */
  listLineupsByHuman(input: ListLineupsByHumanInput): Promise<HumanLineupRow[]>;
}

export type {
  AttachEventHumanInput,
  EventHumanRecord,
  EventHumanRole,
  HumanPerformanceSummary,
  ListPerformancesByHumanInput,
  ActAtPlaceRow,
  ActsAtPlacePage,
  ListActsByPlaceInput,
  HumanLineupRow,
  ListLineupsByHumanInput,
};
