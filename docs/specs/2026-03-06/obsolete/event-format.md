# Prompt: Implement Event Formats for Events
#
# **Status:** obsolete (2026-05-16) — not pursued.
# No `EventFormat` model or `formatId` ever landed on `Event`. The taxonomy
# stopped at `EventCategory` + `EventType`, which covered the discovery and
# filtering needs in practice. In-person/virtual/hybrid distinction, if ever
# needed, can be encoded as an event type or a flag rather than a new
# taxonomy. Kept for historical context — do not implement.
#
# Context: Add a simple “format” taxonomy orthogonal to category/type (e.g., in-person/virtual/hybrid).
# Goal: Data models, repos, seeds, invariants, and publish-time validation (no UI).

objectives:
  - Create EventFormat model + migrations and (optional) i18n table.
  - Link Event.formatId → EventFormat.id.
  - Enforce active formats on publish; allow null during drafts.
  - Seed a curated, idempotent list of formats.
  - Add repos and use-cases to list and assign formats.

models:
  - name: EventFormat
    fields:
      id: uuid (PK)
      slug: string  # lowercase kebab-case
      name: string  # human label
      description: string? 
      isActive: boolean (default true)
      sortIndex: int (default 0)
      createdAt: datetime (default now)
      updatedAt: datetime (@updatedAt)
    constraints:
      - unique(slug)
      - unique(name)
      - slug format /^[a-z0-9-]{2,40}$/

  - name: Event
    changes:
      formatId: uuid? (FK → EventFormat.id, onDelete: SetNull)
      indexes:
        - index(formatId)
    invariants:
      - When publishing, if formatId is set → EventFormat.isActive = true.

repos:
  - eventFormats.list({ activeOnly?: boolean }): Promise<Array<{ id, slug, name, sortIndex }>>
  - eventFormats.getBySlug(slug: string)
  - eventFormats.create/update/toggleActive (admin only)
  - events.assignFormat({ eventId, formatId }) → validates existence/active; audit

use_cases:
  - listEventFormats:
      input: { activeOnly?: boolean }
      output: array of { id, slug, name, sortIndex }
      behavior: sort by sortIndex asc, name asc tiebreak
  - assignEventFormat:
      input: { actorHumanId, eventId, formatSlug }
      behavior:
        - authz: actor can edit event
        - resolve format by slug; must exist and (if publishing soon) be active
        - update event.formatId; audit "event.format_set"
  - enforceOnPublish (hook in publishEvent):
      - if event.formatId present → require active format, else invalid_input

seed_data:
  - Attach to init script; idempotent upsert by slug.
  - Canonical set (can expand later):
      - in-person
      - virtual
      - hybrid
      - livestream
      - on-demand
  - Provide deterministic UUIDs for stable fixtures; set sortIndex (e.g., in-person=0, virtual=1, hybrid=2, livestream=3, on-demand=4)

tests:
  - migration: unique(slug/name), FK set-null works.
  - repo: list(activeOnly) ordering; getBySlug returns correct record.
  - use case: assign rejected if format inactive and event is publishing; accepted for drafts.
  - publish: invalid_input when format inactive/missing if required by policy.

logging_metrics:
  - metrics.increment("taxonomy.format.created" | "updated" | "toggled", { slug })
  - metrics.increment("event.format.assigned", { formatSlug })
  - audit: "event.format_set", "taxonomy.format_seeded"

infra:
  - Prisma migration under packages/db/prisma/migrations/<ts>_add_event_formats
  - Seed in packages/db seeds or init.sql via upsert-by-slug.
  - Keep adapter-free core; repos live in adapters/db/prisma/*.

notes:
  - No enums; admin-editable set.
  - Allow null during drafts for flexibility.
  - Future: per-format UX (e.g., show stream link fields when virtual/livestream).

success_criteria:
  - Formats seeded and queryable on a clean DB.
  - Events can be assigned formats; publish validation enforced.
  - CI can run seeds idempotently without diffs.