# Prompt: Implement Event Series (recurring events) alongside Event Templates (no code; generate models, schemas, repos, use-cases, and tests scaffolding)

Goal:
  Enable creators to define a recurring “Event Series” with a schedule rule (RRULE-like),
  generate/manage child DRAFT events, and publish subsets. Series may reference an Event Template
  for defaults and allow per-occurrence overrides.

Constraints:
  - Use ports: Repos, Logger, Idempotency, Clock, AuthZ, Audit.
  - No Prisma types; define Zod schemas for inputs/outputs/DTOs.
  - One DB transaction per mutating use-case via repos.tx().
  - Throw only typed errors { code: "<see Error codes>" }.
  - No external side effects (email/stripe); only repos + audit.
  - Idempotency required for create/update/generate operations.

Domain model (DB-level intent; generate DTOs/Zod, not SQL):
  EventSeries:
    - id: uuid (PK)
    - ownerScope: enum { ORGANIZATION, HUMAN }
    - ownerId: uuid
    - name: string (1..120), unique per (ownerScope, ownerId) when active
    - description?: string (0..500)
    - active: boolean (default true)  # soft-disable future expansion
    - timezone: IANA tz string (e.g., "America/New_York")
    - schedule:
        kind: enum { RRULE, FIXED_DATES }
        # RRULE-like fields (validate; store normalized string too)
        rrule?: string               # e.g., "FREQ=WEEKLY;BYDAY=FR;COUNT=12"
        dtstart?: string (ISO)       # series start datetime (local tz)
        until?: string (ISO)?        # optional end
        # For FIXED_DATES:
        dates?: string[]             # ISO datetimes (local tz)
        # Global time window guard for expansion:
        windowStart?: string (ISO)
        windowEnd?: string (ISO)
        maxOccurrencesPerExpand?: int (1..500)
    - templateId?: uuid              # optional reference to EventTemplate
    - defaults?:                     # optional series-level defaults; applied after template
        titlePrefix?: string
        location?: oneOf(place|saved-location|freeform|none)   # same shape as templates
        categories?: string[]
        types?: string[]
        attributes?: string[]
        feePolicyId?: uuid
        agreementDraft?: {... as in template ...}
        ticketTypes?: [... as in template ...]
    - createdBy: uuid (human)
    - createdAt: datetime
    - updatedAt: datetime
    - archivedAt?: datetime
  EventSeriesOccurrence:
    - id: uuid (PK)
    - seriesId: uuid (FK → EventSeries)
    - ordinal: int                   # 1..N order within series
    - startsAt: datetime (UTC)       # materialized instant
    - endsAt?: datetime (UTC)
    - status: enum { PLANNED, SKIPPED, GENERATED, PUBLISHED, CANCELLED }
    - eventId?: uuid                 # when materialized to Event
    - overrides?: {                  # optional per-occurrence overrides
        title?: string
        location?: ...
        types?: string[]
        attributes?: string[]
        # narrow overrides only; no structural schema changes
      }
    - createdAt / updatedAt

Invariants:
  - AuthZ: ONLY OWNER|ADMIN|EDITOR of org or the human owner may CRUD/apply/generate.
  - Series-level defaults must validate via Zod; unknown keys rejected.
  - Applying template + series.defaults + occurrence.overrides merges deterministically:
      Order: Template.defaults → Series.defaults → Occurrence.overrides → API payload overrides
  - Generated Events are always DRAFT; publishing a child is independent per occurrence.
  - Updates to series do not mutate already PUBLISHED Events; DRAFT children may be re-synced.
  - Occurrence uniqueness: (seriesId, ordinal) unique; (seriesId, startsAt) unique.

DTOs (define Zod for each):
  - EventSeriesDTO (read view)
  - EventSeriesOccurrenceDTO (read; minimal child shape)
  - CreateEventSeriesInput {
      actorHumanId, ownerScope, ownerId, name, description?, timezone,
      schedule: { kind, rrule?, dtstart?, until?, dates?, windowStart?, windowEnd?, maxOccurrencesPerExpand? },
      templateId?, defaults?, clientKey
    }
  - CreateEventSeriesResult { seriesId }
  - UpdateEventSeriesInput { actorHumanId, seriesId, patch, clientKey }
  - UpdateEventSeriesResult { ok: true }
  - ArchiveEventSeriesInput { actorHumanId, seriesId, clientKey }
  - ArchiveEventSeriesResult { ok: true }
  - ExpandSeriesInput {
      actorHumanId, seriesId,
      windowStart?: string, windowEnd?: string, maxOccurrences?: number,
      clientKey
    }
  - ExpandSeriesResult { seriesId, occurrencesCreated: number, occurrences: EventSeriesOccurrenceDTO[] }
  - GenerateEventsFromSeriesInput {
      actorHumanId, seriesId, occurrenceIds?: string[], limit?: number, clientKey
    }
  - GenerateEventsFromSeriesResult { generated: Array<{ occurrenceId, eventId }>, skipped: string[] }
  - ResyncDraftFromSeriesInput {
      actorHumanId, seriesId, occurrenceId, mode: "template_only"|"series_only"|"full", clientKey
    }
  - ResyncDraftFromSeriesResult { eventId, appliedFields: string[] }
  - ListSeriesInput { actorHumanId, ownerScope, ownerId, activeOnly?, q?, limit?, cursor? }
  - ListSeriesResult { items: EventSeriesDTO[], nextCursor?: string }
  - ListOccurrencesInput { actorHumanId, seriesId, range?: { start:string, end:string }, status?: string[], limit?, cursor? }
  - ListOccurrencesResult { items: EventSeriesOccurrenceDTO[], nextCursor?: string }

Repos (augment ports.repos.*):
  series:
    - create(data) → { id }
    - update(seriesId, patch) → { id }
    - archive(seriesId) → { id }
    - getById(seriesId) → EventSeriesDTO | null
    - listByOwner({ ownerScope, ownerId, activeOnly?, q?, limit, cursor }) → { items, nextCursor? }
  occurrences:
    - listBySeries({ seriesId, range?, status?, limit, cursor }) → { items, nextCursor? }
    - bulkUpsert(occurrences: Array<{ seriesId, ordinal, startsAt, endsAt?, status }>) → { count }
    - attachEvent(occurrenceId, eventId) → { id }
    - applyOverrides(occurrenceId, overridesPatch) → { id }
    - markStatus(occurrenceId, status) → { id }
    - uniqueCheck({ seriesId, ordinal?, startsAt? }) → boolean
  events:
    - createDraft(data: { orgId|null, humanId|null, title, startsAt, endsAt?, location?, ... }) → { id }
    - patchDraft(eventId, patch) → { id }    # fails if not DRAFT
    - getById(eventId) → EventRecord | null
  templates:
    - getById(templateId) → EventTemplateDTO | null
  authz:
    - canManageOwner({ actorHumanId, ownerScope, ownerId }) → boolean
  audit:
    - log({ entity, entityId?, action, data?, at? }) → void

Use-cases (core/use-cases/series):
  createEventSeries:
    Goal: Define a new series with schedule & optional template/defaults.
    Idempotency:
      key: series:create:${actorHumanId}:${ownerScope}:${ownerId}:${hash(name+schedule+defaults)}
      ttl: 120s
    Errors: invalid_input, forbidden, conflict(name_taken), transient, dependency_failed
    Effects: repos.series.create; audit: series.created
  updateEventSeries:
    Goal: Change metadata/schedule/defaults.
    Idempotency: key: series:update:${seriesId}:${actorHumanId}:${hash(patch)}
    Notes: If schedule changes, no implicit regen; require explicit expand call.
    Effects: repos.series.update; audit: series.updated
  archiveEventSeries:
    Goal: Soft-disable further expansion.
    Idempotency: key: series:archive:${seriesId}:${actorHumanId}
    Effects: repos.series.archive; audit: series.archived
  expandSeries:
    Goal: Materialize missing occurrences within a window (compute RRULE or use FIXED_DATES).
    Idempotency: key: series:expand:${seriesId}:${windowStart}:${windowEnd}:${actorHumanId}
    Logic:
      - Generate candidate (ordinal, startsAt[, endsAt]) respecting maxOccurrences and uniqueness.
      - Upsert PLANNED occurrences; do not create Events here.
    Effects: repos.occurrences.bulkUpsert; audit: series.expanded
    Errors: invalid_input, forbidden, precondition_failed(window|schedule), transient
  generateEventsFromSeries:
    Goal: For selected PLANNED occurrences, create DRAFT Events and mark as GENERATED.
    Idempotency: key: series:gen:${seriesId}:${hash(occurrenceIds||limit)}:${actorHumanId}
    Merge order for event fields: Template.defaults → Series.defaults → Occurrence.overrides
    Effects: repos.events.createDraft + repos.occurrences.attachEvent + markStatus(GENERATED); audit: series.generated
    Errors: not_found(series|occurrence), conflict(already_has_event|status_not_planned), forbidden, dependency_failed
  resyncDraftFromSeries:
    Goal: Re-apply defaults/overrides to an existing DRAFT child event (no published).
    Idempotency: key: series:resync:${seriesId}:${occurrenceId}:${actorHumanId}:${mode}
    Effects: repos.events.patchDraft; audit: series.resynced
    Errors: not_found, conflict(not_draft), forbidden
  listEventSeries:
    Goal: Browse series by owner with pagination/filter.
  listOccurrences:
    Goal: Browse occurrences with range/status filters.

Validation rules (Zod highlights):
  - timezone must be valid IANA tz (use a list).
  - RRULE: accept validated string; require dtstart; enforce until or window guard on expansion.
  - FIXED_DATES: non-empty array; dedupe; limit ≤ 1000.
  - maxOccurrencesPerExpand default 100; cap at 500.
  - Ensure startsAt < endsAt when endsAt provided (convert to UTC using timezone).
  - names unique per (ownerScope, ownerId) when archivedAt is null.

Error codes:
  - invalid_input(422), forbidden(403), not_found(404), conflict(409),
    precondition_failed(412), transient(503), dependency_failed(424)

Telemetry:
  - metrics.increment("series.created"/"series.expanded"/"series.generated"/"series.resynced", { count, ownerScope })
  - logger child context { useCase: "...", seriesId?, occurrenceId?, eventId? }

Idempotency TTLs:
  - create/update/generate/resync: 120s
  - expand: 60s (safe to retry; expansion is upsert)

Tests (colocate *.test.ts):
  - create: happy path; name_taken; authz forbidden; idempotent replay.
  - update: schedule changes validated; defaults validation.
  - expand: RRULE weekly; window boundaries; uniqueness; cap by maxOccurrences.
  - generate: merge precedence; attachEvent; mark statuses; idempotent replay vs changed payload conflict.
  - resync: DRAFT only; verify applied fields list; respect mode matrix.
  - list queries and pagination.

TRPC exposure (transport/trpc):
  - router: series.{create,update,archive,expand,generateEvents,resyncDraft,list,occurrences}
  - Guards: requireAuth + authz.canManageOwner
  - Input/Output: use Zod schemas defined above

Migration/index guidance (db adapter later):
  - Unique index: (owner_scope, owner_id, lower(name)) where archived_at is null
  - Index series_id on occurrences; unique (series_id, ordinal) and (series_id, starts_at)
  - GIN on occurrences.overrides if queried; btree on starts_at for range scans

Notes:
  - Publishing flows remain per-event; series does not auto-publish.
  - Do not mutate PUBLISHED children on series/template edits; require explicit resync-and-republish flow.
  - Keep overrides narrow to avoid schema drift; reject unknown override keys.