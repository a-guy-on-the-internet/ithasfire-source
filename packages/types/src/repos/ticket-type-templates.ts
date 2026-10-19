import type { TemplateOwnerScope } from "./event-templates";

export type TicketTypeTemplatePricingMode = "FIXED" | "ADJUSTABLE";

/** Publication state of a platform-curated TicketPack. */
export type TicketPackStatus = "DRAFT" | "LIVE";

/**
 * What a template entry's relative instants are measured from
 * (ticket-type-packs spec FR-015).
 *
 * There is deliberately NO doors anchor: `Event` has no `doorsAt` column —
 * re-verified 2026-08-12, the same finding the volunteer template-shift spec
 * recorded. `EVENT_END` is likewise absent: `Event.endsAt` is NULLABLE, so an
 * end-anchored ticket window would be unresolvable on the events most likely to
 * carry one, and nothing in FR-015 asks for it.
 *
 * Mirrors `VolunteerShiftAnchor` in packages/db/prisma/volunteer.prisma, minus
 * that enum's `WALL_CLOCK` member — a ticket sales bound has no time-of-day
 * carrier to fall back to, so "no anchor" is expressed by the field being
 * absent, not by an anchor value.
 */
export type TicketTypeTemplateAnchor = "EVENT_START" | "EVENT_PUBLISH";

/**
 * An instant expressed RELATIVELY, so a template survives being reused on a
 * different date. The shipped precedent is `VolunteerRoleTemplateShift`'s
 * `anchor` + `offsetMinutes` pair, and this is the same encoding.
 *
 * `offsetMinutes` is SIGNED — negative = before the anchor — and is elapsed
 * minutes in ABSOLUTE time, not calendar arithmetic. See
 * `resolveRelativeTemplateInstant` in
 * packages/core/src/lib/ticket-types/template-relative-schedule.ts for the DST
 * consequence, which is deliberate and pinned by test.
 *
 * Worked examples from FR-015: early-bird closes `{ EVENT_START, -20160 }`
 * (14 days before); day-of opens `{ EVENT_START, -1440 }`; general on-sale
 * opens `{ EVENT_PUBLISH, 0 }`.
 */
export interface TicketTypeTemplateRelativeInstant {
  anchor: TicketTypeTemplateAnchor;
  /** Signed minutes from the anchor; negative = before it. */
  offsetMinutes: number;
}

/**
 * A relative scheduled price change (time-based-ticket-pricing FR-011) — the
 * template form of `TicketType.scheduledPriceCents` / `scheduledPriceAt`.
 *
 * Carried as ONE nullable object rather than two loose fields precisely because
 * the stored pair is both-or-neither (`normalizeScheduledPrice`): a shape that
 * cannot express half a schedule cannot store one.
 */
export interface TicketTypeTemplateScheduledPriceChange {
  at: TicketTypeTemplateRelativeInstant;
  /** Post-flip price in integer cents. 0 is legitimate ("free after T"). */
  priceCents: number;
}

/**
 * One saved ticket-type configuration. Deliberately excludes `seatSectionId`
 * (it would dangle when the template is applied to a different event).
 */
export interface TicketTypeTemplateEntry {
  name: string;
  priceCents: number;
  pricingMode: TicketTypeTemplatePricingMode;
  minimumCents?: number | null;
  suggestedCents?: number | null;
  capacity: number;
  resaleAllowed: boolean;
  resaleCapCents?: number | null;
  transferAllowed: boolean;
  /**
   * RELATIVE sales window (FR-015 / FR-011). Materialized into the created
   * TicketType's absolute `salesOpenAt` / `salesCloseAt` at APPLY time
   * (FR-016) — a template never stores an absolute instant, because an
   * org-scoped template is reused across events and "opens March 3rd" cannot
   * be. The two bounds are INDEPENDENT, matching `normalizeSalesWindow`.
   *
   * Absent on every template stored before 2026-08-12; reads as null, applies
   * exactly as it did (NFR-001).
   */
  salesOpen?: TicketTypeTemplateRelativeInstant | null;
  salesClose?: TicketTypeTemplateRelativeInstant | null;
  /**
   * RELATIVE scheduled price change (FR-011). Materialized into
   * `scheduledPriceCents` / `scheduledPriceAt` at apply time.
   */
  scheduledPriceChange?: TicketTypeTemplateScheduledPriceChange | null;
}

/**
 * Two kinds of row share this record (ticket-type-packs spec FR-002):
 *
 *   - OWNED    — `ownerId` set, `isPlatform` false, `packId` null (or set,
 *                when the row was forked from a pack — provenance).
 *   - PLATFORM — `ownerId` NULL, `isPlatform` true, `packId` set.
 *                Staff-curated catalogue content; `ownerScope` is
 *                ORGANIZATION by convention and ignored.
 *
 * Every consumer of `ownerId` must handle null deliberately — no non-null
 * assertions, no `?? ""` (spec FR-002's compile-visited audit rule).
 */
export interface TicketTypeTemplateRecord {
  id: string;
  ownerScope: TemplateOwnerScope;
  /** Null = platform catalogue row (see `isPlatform`). */
  ownerId: string | null;
  name: string;
  ticketTypes: TicketTypeTemplateEntry[];
  /** True only on catalogue rows (read-only to organizers, FR-005). */
  isPlatform: boolean;
  /** Owning pack on a platform row; fork provenance on an owned row. */
  packId: string | null;
  /** Null when the creating account has been deleted (creator detached). */
  createdByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateTicketTypeTemplateRepoInput {
  ownerScope: TemplateOwnerScope;
  ownerId: string;
  name: string;
  ticketTypes: TicketTypeTemplateEntry[];
  createdByHumanId: string;
  createdAt: Date;
  /** Fork provenance (spec FR-009). Never mints a platform row. */
  packId?: string | null;
}

export interface ArchiveTicketTypeTemplateRepoInput {
  templateId: string;
  archivedAt: Date;
}

// ── Ticket packs (platform catalogue metadata) ──────────────────────────────

export interface TicketPackRecord {
  id: string;
  /** Stable slug — the seed path's convergence key. */
  key: string;
  name: string;
  /** Staff-authored free text. Escaped at the sink, never HTML (NFR-005). */
  blurb: string | null;
  status: TicketPackStatus;
  sortOrder: number;
  curatedByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Pack plus the counts the staff catalogue list shows (spec FR-012):
 * catalogue templates and their total entries, and how many owned forks
 * descend from it.
 */
export interface TicketPackWithCountsRecord extends TicketPackRecord {
  /** Platform rows owned by this pack (`isPlatform` true). */
  templateCount: number;
  /** Total ticket-type entries across those templates. */
  entryCount: number;
  /** Owned rows carrying this pack as provenance (`isPlatform` false). */
  forkCount: number;
}

/** Pack plus its catalogue templates. */
export interface TicketPackWithTemplatesRecord extends TicketPackRecord {
  templates: TicketTypeTemplateRecord[];
}

export interface CreateTicketPackInput {
  key: string;
  name: string;
  blurb?: string | null;
  status?: TicketPackStatus;
  sortOrder?: number;
  curatedByHumanId?: string | null;
}

export interface UpdateTicketPackInput {
  name?: string;
  blurb?: string | null;
  status?: TicketPackStatus;
  sortOrder?: number;
  curatedByHumanId?: string | null;
}

/**
 * Create a PLATFORM catalogue row: `ownerId` is NULL and `isPlatform` is
 * true, neither of them settable by the caller. `packId` is required — the
 * `TicketTypeTemplate_platform_pack_check` CHECK refuses a pack-less
 * platform row.
 */
export interface CreatePlatformTicketTypeTemplateInput {
  packId: string;
  name: string;
  ticketTypes: TicketTypeTemplateEntry[];
}

export interface UpdatePlatformTicketTypeTemplateInput {
  name?: string;
  ticketTypes?: TicketTypeTemplateEntry[];
}
