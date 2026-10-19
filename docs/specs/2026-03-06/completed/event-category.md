# Ticket Hunter — Event Categories (spec-only; no code)

goal: >
  Introduce first-class Event Categories so every Event can be classified for search,
  curation, and discovery. Provide a curated, seedable list (including "Art" and "Other"),
  keep categories editable (not an enum), and enforce category presence on publish.

models:
  Category:
    id: uuid (PK)
    slug: string (lowercase, kebab-case; UNIQUE; immutable once referenced)
    name: string (human-readable; UNIQUE)
    active: boolean (default true)
    createdAt: datetime (default now)
    updatedAt: datetime (auto)
    indexes:
      - unique(slug)
      - unique(name)
      - index(active)

  Event (changes only):
    categoryId: uuid? (FK -> Category.id, ON DELETE SET NULL)
    indexes:
      - index(categoryId)

constraints:
  - Category is NOT an enum; managed in DB with unique slug.
  - Draft events MAY have null categoryId.
  - PUBLISH operation MUST enforce categoryId != null (app-level invariant).
  - Slug format: ^[a-z0-9-]{2,32}$; must be unique and stable.
  - Only active=true categories appear in public selectors and search filters.
  - Seed list must be idempotent (upsert by slug in init/seed).

invariants:
  - You cannot publish an event unless its category exists and is active.
  - Renaming a category updates only the display name; slug stays the same.
  - Deactivating a category hides it from pickers/search but does not orphan events.

seed_list (authoritative; order is UI sort default):
  - { slug: music,     name: "Music" }
  - { slug: sports,    name: "Sports" }
  - { slug: theatre,   name: "Theatre" }
  - { slug: comedy,    name: "Comedy" }
  - { slug: community, name: "Community" }
  - { slug: nightlife, name: "Nightlife" }
  - { slug: learning,  name: "Learning" }
  - { slug: art,       name: "Art" }
  - { slug: other,     name: "Other" } # keep last in UI

init_and_seed_requirements:
  - Migration creates Category table and Event.categoryId FK + index.
  - Init SQL or Prisma seed upserts the seed_list by slug (no duplicates).
  - Optional: deterministic UUIDs derived from slug for stable fixtures (not required).

repo_endpoints (behavioral spec; no code):
  - Categories:
      listActive(): returns [{id, slug, name, active}]
      getBySlug(slug): returns one or null
      getById(id): returns one or null
  - Events:
      setCategory(eventId, categoryId): sets FK (validates existence)
      filterByCategory({ categorySlug?, limit?, offset? }): returns events

use_cases (behavioral spec; no code):
  - listCategories: returns active categories for UI pickers.
  - setEventCategory:
      input: { actorHumanId, eventId, categorySlug }
      checks:
        * actor has OWNER|ADMIN|EDITOR on org event or owns human event
        * category exists and active
      effects:
        * set event.categoryId
        * audit "event.category_set"
  - publishEvent (existing flow):
      enforce event.categoryId != null (throw invalid_input if null)

notes:
  - Keep “Other” available as a last-resort bucket; discourage in UX with helper text.
  - Future-ready: tags/types/formats can layer on later; do not overfit now.
  - Search: include categorySlug facet in search index docs when indexing events.
  - UI: sort categories by the seed_list order, not alphabetically.