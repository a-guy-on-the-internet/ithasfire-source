# Prompt: Implement Event Attributes (flexible, typed facets)
#
# **Status:** obsolete (2026-05-16) — not pursued.
# The taxonomy direction landed on `EventCategory` + `EventType` (see
# `packages/db/prisma/event.prisma` and `core/use-cases/categories/`,
# `core/use-cases/event-types/`). No `AttributeDefinition` / `EventAttribute`
# registry was built; the flexibility this spec proposed never proved
# necessary in practice. Kept for historical context — do not implement.
#
# Goal: Add a typed, admin-managed attribute system attachable to Events (e.g., “all-ages”, “outdoor”, “language: en”).
# Scope: Data models, constraints, seeds, repos, use-cases, publish-time validation. No UI code.

objectives:
  - Model a registry of attribute definitions (typed: boolean | enum | number | text).
  - Allow optional scoping by category/type and mutual-exclusion groups.
  - Store event-specific attribute values with strong validation.
  - Seed a minimal, useful attribute set idempotently.
  - Expose repos + use-cases to list, assign, remove, and validate attributes.
  - Enforce constraints on publish (e.g., invalid or conflicting attributes block publish).

models:
  - name: AttributeDefinition
    fields:
      id: uuid (PK)
      slug: string        # kebab-case, immutable key, e.g. "all-ages"
      name: string        # human label
      description: string?
      kind: enum("BOOLEAN","ENUM","NUMBER","TEXT")
      # validation constraints (depending on kind)
      numberMin: number?            # inclusive
      numberMax: number?            # inclusive
      textMaxLen: int?              # e.g., 120
      # scoping & behavior
      applicableCategoryIds: uuid[]   # optional whitelist; empty = global
      applicableTypeIds: uuid[]       # optional whitelist; empty = global
      exclusiveGroup: string?         # same group → only one active per Event (e.g., "seating")
      isActive: boolean (default true)
      sortIndex: int (default 0)
      createdAt: datetime (default now)
      updatedAt: datetime (@updatedAt)
    constraints:
      - unique(slug)
      - slug /^[a-z0-9-]{2,40}$/
      - if kind="NUMBER" then numberMin <= numberMax (when both set)
      - if kind="TEXT" then textMaxLen between 1..500 (when set)
  - name: AttributeEnumOption
    fields:
      id: uuid (PK)
      attributeId: uuid (FK → AttributeDefinition.id, onDelete: Cascade)
      slug: string      # e.g., "en", "es", "fr"
      label: string
      isActive: boolean (default true)
      sortIndex: int (default 0)
    constraints:
      - unique(attributeId, slug)
  - name: EventAttributeValue
    fields:
      id: uuid (PK)
      eventId: uuid (FK → Event.id, onDelete: Cascade)
      attributeId: uuid (FK → AttributeDefinition.id, onDelete: Cascade)
      # one-of storage by kind (exactly one non-null must be set per row)
      valueBoolean: boolean?
      valueEnumId: uuid?    # FK → AttributeEnumOption.id
      valueNumber: decimal? # store as numeric/decimal
      valueText: string?
      createdAt: datetime (default now)
      updatedAt: datetime (@updatedAt)
    constraints:
      - unique(eventId, attributeId)
      - check exactly one of [valueBoolean, valueEnumId, valueNumber, valueText] is non-null
      - if valueEnumId set → it belongs to attributeId (FK + check)

publish_time_invariants:
  - All EventAttributeValue rows must satisfy:
    - AttributeDefinition.isActive = true
    - If AttributeDefinition.applicableCategoryIds non-empty → Event.categoryId ∈ that set
    - If AttributeDefinition.applicableTypeIds non-empty → Event.typeId ∈ that set
    - If AttributeDefinition.exclusiveGroup set → no other attribute with same group applied to the Event
    - NUMBER kind: numberMin ≤ value ≤ numberMax (when min/max present)
    - TEXT kind: length(value) ≤ textMaxLen (when set)
    - ENUM kind: valueEnumId refers to active AttributeEnumOption for that attribute

repos:
  - attributes.listDefinitions(params?: { activeOnly?: boolean; categoryId?: uuid; typeId?: uuid }):
      returns [{ id, slug, name, kind, exclusiveGroup, sortIndex }]
  - attributes.getDefinitionBySlug(slug: string)
  - attributes.listEnumOptions(attributeId: uuid, activeOnly?: boolean)
  - attributes.adminUpsertDefinition(def: …)     # admin-only
  - attributes.adminUpsertEnumOption(attrId: uuid, opt: …)  # admin-only
  - events.listAttributes(eventId: uuid):
      returns normalized DTOs { attribute: { id, slug, name, kind }, value: (boolean|number|string|{enumId,slug,label}) }
  - events.assignAttribute(eventId: uuid, payload: { attributeSlug, value }) # validates + upserts
  - events.removeAttribute(eventId: uuid, attributeSlug: string)

use_cases:
  - listEventAttributesForEditing:
      input: { actorHumanId, eventId }
      behavior:
        - authz: actor can edit event
        - returns: current attributes + eligible definitions (filtered by category/type)
  - assignEventAttribute:
      input: { actorHumanId, eventId, attributeSlug, value, clientKey }
      behavior:
        - authz: actor can edit event
        - validate definition active, scope (category/type), and kind-specific constraints
        - enforce exclusiveGroup (remove conflicting attributes in same group or reject with conflict)
        - upsert EventAttributeValue (idempotent on unique(eventId, attributeId))
        - audit "event.attribute_set"
  - removeEventAttribute:
      input: { actorHumanId, eventId, attributeSlug }
      behavior:
        - authz: actor can edit event
        - delete EventAttributeValue; audit "event.attribute_removed"
  - validateAttributesOnPublish (hook in publishEvent):
      - enforce publish_time_invariants; reject on first violation with invalid_input/conflict

seed_data:
  # Idempotent upsert-by-slug. Provide deterministic UUIDs.
  boolean_attributes:
    - slug: all-ages
      name: All ages
      exclusiveGroup: age-policy
    - slug: 21-plus
      name: 21+
      exclusiveGroup: age-policy
    - slug: outdoor
      name: Outdoor
      exclusiveGroup: venue-environment
    - slug: indoor
      name: Indoor
      exclusiveGroup: venue-environment
    - slug: seated
      name: Seated
      exclusiveGroup: seating
    - slug: standing
      name: Standing
      exclusiveGroup: seating
    - slug: wheelchair-accessible
      name: Wheelchair accessible
    - slug: pet-friendly
      name: Pet friendly
    - slug: alcohol-served
      name: Alcohol served
    - slug: strobe-lighting
      name: Strobe lighting used
  enum_attributes:
    - slug: language
      name: Language
      options: [ {slug: en, label: English}, {slug: es, label: Spanish}, {slug: fr, label: French} ]
    - slug: recording-policy
      name: Recording policy
      options:
        - { slug: allowed, label: Allowed }
        - { slug: limited, label: Limited }
        - { slug: prohibited, label: Prohibited }
  number_attributes:
    - slug: age-minimum
      name: Minimum age
      numberMin: 0
      numberMax: 120
      exclusiveGroup: age-policy
  text_attributes:
    - slug: door-time
      name: Door time (notes)
      textMaxLen: 120

idempotency_logging_metrics:
  - assignEventAttribute:
      idem key: attr:set:${eventId}:${attributeSlug}:${clientKey}, ttl=60s
      audit: event.attribute_set
      metrics.increment("event.attribute.set", { attributeSlug })
  - removeEventAttribute:
      audit: event.attribute_removed
      metrics.increment("event.attribute.removed", { attributeSlug })

errors:
  - invalid_input(422): unknown attributeSlug, bad value type/constraints, scope mismatch, enum option inactive
  - forbidden(403): actor lacks permission
  - conflict(409): exclusiveGroup violation
  - not_found(404): event not found / attribute not present when removing
  - dependency_failed(424): repo failures
  - transient(503): idempotency lock contention

infra:
  - Prisma migrations under packages/db/prisma/migrations/*:
      - create AttributeDefinition, AttributeEnumOption, EventAttributeValue
      - indexes: AttributeDefinition.slug unique; AttributeEnumOption (attributeId, slug) unique; EventAttributeValue (eventId, attributeId) unique
      - check constraint for “exactly one value* column non-null”
  - Seed script (packages/db/src/seed/attributes.ts) idempotent upsert-by-slug + enum options by (attributeId, slug)

notes:
  - Keep attributes orthogonal to category/type/format; they’re additive facets.
  - Use exclusiveGroup sparingly to model mutually exclusive flags (e.g., seating/age-policy/venue-environment).
  - Avoid enums in Prisma for attribute kinds/options to keep admin-extensible.
  - Computed badges can be derived later from attributes (e.g., “All ages”, “Accessible”, “Outdoor”).