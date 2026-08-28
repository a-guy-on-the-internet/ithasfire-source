Generate a Ithas Fire spec from the description below.

$ARGUMENTS

---

## How to generate a spec

### 1. Determine the spec type and filename suffix

Choose the suffix that best fits:

| Suffix | Use when |
|---|---|
| `.spec.md` | Full feature spec — new model, flow, or surface area |
| `.flow.yaml` | User/system flow — step-by-step sequence of states |
| `.component.yaml` | Reusable UI component definition |
| `.schema.yaml` | Data model only (Prisma schema additions) |
| `.pattern.md` | Architectural pattern or coding convention |
| `.task.yaml` | Discrete implementation task with acceptance criteria |
| `.pipeline.yaml` | Background job or data pipeline |
| `.transport.yaml` | tRPC router or API transport layer |

### 2. Place the file correctly

Specs live at `docs/specs/YYYY-MM-DD/<filename>` where `YYYY-MM-DD` is today's date.
Active drafts sit at the folder root. Completed specs are moved to `completed/` once implemented.

### 3. Follow the spec format

Use this structure for `.spec.md` files (adapt as needed for other types):

```markdown
# <Feature Name>

**Date:** YYYY-MM-DD  
**Status:** draft | review | approved  
**Priority:** P0 (Critical) | P1 (Important) | P2 (High Value) | P3 (Nice to Have)  
**Depends on:** <list existing models/specs this requires>  
**Supersedes:** <path to any spec this replaces, if applicable>  

---

## Problem

<1–3 sentences on the pain this solves. Ground it in real user behavior — quote interview data if available.>

---

## Goal

<What the feature does and for whom. One paragraph.>

---

## Context

| What exists | Where |
|---|---|
| <existing model or spec> | <prisma file or spec path> |

---

## Data Model

<Prisma schema additions. Follow existing conventions:
- Use `uuid()` for IDs
- Use `DateTime @default(now())` for timestamps
- Always add createdAt/updatedAt
- Reference related models with explicit relation fields
- Add @@index() for hot-path foreign keys
- Money in integer cents (never floats)
>

---

## Use Cases

<List the use cases this feature requires, referencing packages/core conventions:
- Stateless factory pattern
- Zod input/output schemas
- Typed error codes: invalid_input | forbidden | not_found | conflict | rate_limited | dependency_failed | transient
- Single repos.tx() per mutation
- Idempotency for money-moving operations
>

---

## UI / Flow

<Screens, flows, or component behavior. Reference existing patterns where applicable.>

---

## Acceptance Criteria

- [ ] <testable criterion>
- [ ] <testable criterion>

---

## Open Questions

- <anything unresolved that blocks implementation>
```

### 4. Architecture constraints to respect

- **Money:** Always integer cents. Never floats. Route through `packages/core/src/lib/pricing`.
- **Errors:** Typed error objects with `code` strings. Never raw `Error` or strings.
- **Ports:** Core use cases depend only on ports — never import Prisma, adapters, or framework code.
- **Idempotency:** Any externally-triggered or money-moving use case needs `IdempotencyPort`.
- **Two-sided trust:** Reviews are always blind (neither party sees the other's until both submit or 14 days pass).
- **No PII leakage:** Fan follower identities are never surfaced to followed entities.
- **EventMode:** All event-related specs must account for `VENUE | LIVING_ROOM | HYBRID` modes.
- **Place vs HostSpace:** Licensed venues use the `Place` model. Private/DIY spaces use `HostSpace` (extends Place).

### 5. Cross-reference live interview insights

When writing specs that touch any of these areas, check the corresponding insights doc in `~/Documents/InterviewNotesAndTrancriptions/` for validated requirements:

| Area | Interview source |
|---|---|
| Venue rating form fields | Carrie Cunningham (2026-04-09), Dan (2026-03-26, 2026-04-15) |
| Load-in/load-out timing | Carrie (2026-04-09) |
| PA vs stage equipment split | Carrie (2026-04-09) |
| FOH/sound engineer rating | Carrie (2026-04-09) |
| Security fields | Carrie (2026-04-09) |
| Booker quality rating | Dan (2026-03-26), Carrie (2026-04-09) |
| Two-sided review + fraud protection | Dan (2026-03-26), Carrie (2026-04-09) |
| Form completion nudges + email capture | Dan (2026-04-15) |
| Festival/fair coordination backend | Carrie (2026-04-09) — standalone doc needed |
| Filler date / route optimization | Carrie (2026-04-09), Dan (2026-03-26) |
| Virtual venue walkthroughs | Carrie (2026-04-09) |
| Verified venues/artists | Carrie (2026-04-09), Dan (2026-03-26) |
| Publicist field on artist profile | Carrie (2026-04-09) |
| Park & Rec summer concert series | Carrie (2026-04-09) |

### 6. Write the file

After drafting the spec content, write it to `docs/specs/<today-date>/<filename>` using the Write tool.
Then confirm the path to the user.
