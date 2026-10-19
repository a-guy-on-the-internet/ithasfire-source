# Prompt: Implement Event Templates

## Goal

Enable orgs or humans to define reusable event defaults ("templates") and apply them to new or existing DRAFT events with deterministic merging and pinned snapshots on publish.

## Constraints

- Use ports: Repos, Logger, Idempotency, Clock, AuthZ (for permissions), Audit.
- Avoid Prisma types; define Zod schemas for inputs, outputs, and DTOs.
- Use one DB transaction per mutating use case via `repos.tx()`.
- Throw errors with `{ code: "<see Error codes>" }` only.
- Skip external side effects (email/Stripe); only repos + audit.
- Require idempotency for create/update/apply operations.
- Applying templates must not mutate PUBLISHED events.

## Domain Model

### EventTemplate

- `id`: uuid (PK)
- `ownerScope`: enum `{ ORGANIZATION, HUMAN }`
- `ownerId`: uuid
- `name`: string (1..80), unique per `(ownerScope, ownerId, name)`
- `description`: string? (0..280)
- `active`: boolean (default `true`)
- `defaults`:
  - JSON blob of recommended, typed fields (validate with Zod on write)
  - `title?`: string
  - `doorTimeMinsBefore?`: int (0..600)
  - `visibility?`: enum `{ PUBLIC, PRIVATE, UNLISTED }`
  - `location?`: one of
    - `{ kind: "place", placeId: uuid }`
    - `{ kind: "saved-location", savedLocationId: uuid }`
    - `{ kind: "freeform", addressText: string(1..200), lat: number[-90..90], lng: number[-180..180] }`
  - `categories?`: `string[]` (category slugs/ids)
  - `types?`: `string[]` (type slugs/ids)
  - `attributes?`: `string[]` (attribute slugs/ids)
  - `feePolicyId?`: uuid
  - `agreementDraft?`:
    - `lines`: `Array<{ payeeId: uuid, percent: int[0..100], floorCents: int>=0, capPercent?: int[0..100], priority?: int, rounding?: "FLOOR" | "NEAREST" }>`
    - `feeMode?`: `"INCLUSIVE" | "ON_TOP"`
  - `ticketTypes?`: `Array<{ name: string(1..60); priceCents: int>=0; capacity: int>=0; seatSectionId?: uuid | null; status?: "ACTIVE" | "INACTIVE" }>`
  - `media?`: `{ bannerUrl?: string, gallery?: string[] }`
  - `embed?`: `{ allowResale?: boolean, showFees?: boolean }`
- `createdBy`: uuid (human)
- `createdAt`: datetime
- `updatedAt`: datetime
- `archivedAt`: datetime? (for soft delete)

### Invariants

- `(ownerScope, ownerId)` required; AuthZ: only `OWNER | ADMIN | EDITOR` of org or the human owner may CRUD/apply.
- `defaults` must pass Zod validation; reject unknown keys.
- Applying a template updates only DRAFT fields; never touches PUBLISHED or ARCHIVED events.
- Merge order: OrgDefaults/HumanDefaults → `template.defaults` → caller overrides (last wins).
- On publish, resolved snapshots (fee policy/agreement/ticket types) are pinned to the event; later template edits do not back-propagate.

## DTOs (define Zod for each)

- `EventTemplateDTO` (read model; includes id, meta, defaults)
- `CreateEventTemplateInput { actorHumanId, ownerScope, ownerId, name, description?, defaults, clientKey }`
- `CreateEventTemplateResult { templateId }`
- `UpdateEventTemplateInput { actorHumanId, templateId, patch, clientKey }`
- `UpdateEventTemplateResult { ok: true }`
- `ArchiveEventTemplateInput { actorHumanId, templateId, clientKey }`
- `ArchiveEventTemplateResult { ok: true }`
- `ListEventTemplatesInput { actorHumanId, ownerScope, ownerId, activeOnly?, q?, limit?, cursor? }`
- `ListEventTemplatesResult { items: EventTemplateDTO[], nextCursor?: string }`
- `ApplyTemplateToEventDraftInput { actorHumanId, templateId, eventId, overrides?, clientKey }`
- `ApplyTemplateToEventDraftResult { eventId, appliedFields: string[] }`

## Repos (add to `ports.repos.*`)

### eventTemplates

- `create(data: { ownerScope, ownerId, name, description?, defaults, createdBy }) → { id }`
- `update(templateId, patch: { name?, description?, defaults?, active? }) → { id }`
- `archive(templateId) → { id }`
- `getById(templateId) → EventTemplateDTO | null`
- `list({ ownerScope, ownerId, activeOnly?, q?, limit, cursor }) → { items, nextCursor? }`
- `findByName({ ownerScope, ownerId, name }) → EventTemplateDTO | null`

### events

- `getById(eventId) → EventRecord | null` (must expose mutable fields: title, location, meta, visibility, etc.)
- `patchDraft(eventId, patch) → { id }` (fails if status != DRAFT)

### authz

- `canManageOwner({ actorHumanId, ownerScope, ownerId }) → boolean` (true if human can act for owner)

### audit

- `log({ entity, entityId?, action, data?, at? }) → void`

## Use Cases (`core/use-cases/event-templates`)

### `createEventTemplate`

- Goal: Create a reusable template under an org/human.
- Idempotency:
  - Key: `tmpl:create:${actorHumanId}:${ownerScope}:${ownerId}:${hash(name+defaults)}`
  - Behavior: replay result for identical payload (TTL 120s)
- Errors: `invalid_input`, `forbidden`, `conflict(name_taken)`, `transient`, `dependency_failed`
- Side effects: `repos.eventTemplates.create`; audit: `template.created`

### `updateEventTemplate`

- Goal: Update template metadata/defaults.
- Idempotency:
  - Key: `tmpl:update:${templateId}:${actorHumanId}:${hash(patch)}`
- Errors: `not_found`, `forbidden`, `invalid_input`, `conflict`, `transient`
- Side effects: `repos.eventTemplates.update`; audit: `template.updated`

### `archiveEventTemplate`

- Goal: Soft-delete/disable a template.
- Idempotency:
  - Key: `tmpl:archive:${templateId}:${actorHumanId}`
- Errors: `not_found`, `forbidden`
- Side effects: `repos.eventTemplates.archive`; audit: `template.archived`

### `listEventTemplates`

- Goal: Browse owner templates with optional search/pagination.
- Errors: `forbidden` (if private owner and actor lacks rights)

### `applyTemplateToEventDraft`

- Goal: Merge template defaults into an existing DRAFT event.
- Preconditions:
  - `Event.status === DRAFT`
  - Actor can manage event owner (org or human)
- Merge rules:
  - Resolve defaults; enforce exclusive groups in attributes/types if any.
  - Do not overwrite caller overrides passed in `overrides` (overrides last).
  - Ticket types: upsert or stage in draft only; do not mint tickets here.
  - Agreement: upsert draft lines; do not activate; fee policy existence required if referenced.
- Idempotency:
  - Key: `tmpl:apply:${templateId}:${eventId}:${actorHumanId}:${hash(overrides ?? {})}`
- Result: `{ eventId, appliedFields }`
- Errors: `not_found(template/event)`, `forbidden`, `conflict(status_not_draft)`, `invalid_input`, `dependency_failed`
- Side effects: `repos.events.patchDraft`; audit: `template.applied`

## Validation Rules (Zod highlights)

- `defaults.location`:
  - `freeform` requires `{ addressText, lat, lng }`
  - `place`/`saved-location` require corresponding id
- Arrays (`categories`/`types`/`attributes`) deduped and length-limited (≤ 25).
- `agreementDraft.lines` sums ≤ 100% across the same priority bucket (if applicable).
- `ticketTypes`: name unique within template; capacity and price non-negative.

## Error Codes

- `invalid_input` (422)
- `forbidden` (403)
- `not_found` (404)
- `conflict` (409)
- `precondition_failed` (412)
- `transient` (503)
- `dependency_failed` (424)

## Telemetry

- `metrics.increment("template.created")`
- `metrics.increment("template.updated")`
- `metrics.increment("template.applied", { fields, counts })`
- Logger child context `{ useCase: "createEventTemplate" | "applyTemplateToEventDraft", templateId?, eventId? }`

## Idempotency TTLs

- `create` / `update` / `apply`: 120s

## Tests (colocate `*.test.ts`)

- `create`: happy path; `name_taken`; AuthZ forbidden; idempotent replay vs. conflict on changed payload.
- `update`: patch subsets; defaults validation failures.
- `list`: pagination + `q` filter; `activeOnly`.
- `apply`: event not draft; merge precedence; categories/types/attributes dedupe; agreement/ticket types staged only; idempotent replay.

## TRPC Exposure (`transport/trpc`)

- Router: `eventTemplates.{create, update, archive, list, applyToEventDraft}`
- Guards: `requireAuth` + `authz.canManageOwner`
- Input/output: use the Zod schemas above.

## Migration / Index Guidance (db adapter later)

- Unique index: `(owner_scope, owner_id, lower(name))` where `archived_at` is null.
- Prefix index on `name` for `q` search; `updated_at` for ordering.
- Soft delete via `archived_at`.

## Notes

- Do not backfill published events when a template changes.
- Keep defaults strictly typed; reject unknown keys.
- Future: allow OrgDefaults/HumanDefaults as implicit templates; same merge rules.
