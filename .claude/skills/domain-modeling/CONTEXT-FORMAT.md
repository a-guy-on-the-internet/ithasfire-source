# CONTEXT.md Format

## Structure

```md
# Ithas Fire

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Place**:
A physical location where events happen; may contain Rooms.
_Avoid_: Venue (except in the venue-vertical product sense), location
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Hexagonal-architecture vocabulary (port, adapter, use case) also doesn't belong — that's documented in CLAUDE.md and docs/architecture. Before adding a term, ask: is this a concept unique to Ithas Fire's domain, or a general concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge (e.g. Money & Settlement, Events & Occurrences, People & Auth, Places & Layouts). If all terms belong to a single cohesive area, a flat list is fine.
- **User-facing vs internal names both belong.** When the UI word differs from the code word (users see "action bar", code says CAB), record both in one entry and say which surface uses which.

## Single context

This repo is one bounded context: one `CONTEXT.md` at the repo root. Create it lazily when the first term is resolved. Do not create a `CONTEXT-MAP.md` or per-package glossaries unless the repo genuinely splits into contexts with conflicting language.
