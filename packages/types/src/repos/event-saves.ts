import type {
  EventGateType,
  EventLocationMode,
  EventStatus,
  EventVisibility,
} from "./events";
import type { CursorResult } from "./follows";

/**
 * Private keep-for-later bookmark for ANY event (ticketed or community);
 * doubles as WATCHING for change notifications (savers ∪ RSVPers).
 * Idempotent per (eventId, humanId), reversible, and never exposed as a
 * public count. Parallel primitive to EventRsvp (attendance intent) and
 * distinct from EntityFollow (page-level follows, not events).
 */
export interface EventSaveRecord {
  id: string;
  eventId: string;
  humanId: string;
  createdAt: Date;
}

/**
 * Lean event summary joined onto a save row for the /saved list — display
 * fields only (title, hero, when, where-ish, status badge). Anything richer
 * goes through the event detail surfaces.
 */
export interface SavedEventSummary {
  id: string;
  slug: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  timezone: string;
  status: EventStatus;
  visibility: EventVisibility;
  heroImageId: string | null;
  /** Stored publicUrl from the joined hero Image row (same mechanism as EventRecord.heroImageUrl). */
  heroImageUrl: string | null;
  /**
   * R2 storage key of the joined hero Image row, for the read-time moderation
   * visibility gate (keyed by storage key). Null when there is no hero.
   */
  heroImageKey: string | null;
  addressText: string | null;
  locationLabel: string | null;
  placeId: string | null;
  /**
   * Location privacy + coarse fields, so the saved list prints the same
   * public label every other card does. Optional so older fakes compile;
   * an absent `locationMode` is NOT exact (fail closed).
   */
  locationMode?: EventLocationMode | null;
  locationRadiusMeters?: number | null;
  locality?: string | null;
  region?: string | null;
  /**
   * The event's gate. A gated event (anything but NONE) prints its coarse
   * label only — the gate protects its location (`projectPublicEventLocation`).
   * REQUIRED (N5): the projector fails a missing gate closed, so a
   * projection that dropped it would silently gate every saved card.
   */
  gateType: EventGateType | null;
}

export interface SavedEventListItem extends EventSaveRecord {
  event: SavedEventSummary;
}

export type { CursorResult };
