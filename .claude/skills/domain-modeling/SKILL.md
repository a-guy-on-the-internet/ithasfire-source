---
name: domain-modeling
description: Build and sharpen the project's domain model. Use when discussing codebase terminology, writing or editing CONTEXT.md, or recording or editing a decision record in docs/decisions/.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* `CONTEXT.md` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## File structure in this repo

- **Glossary**: `CONTEXT.md` at the repo root. Create it lazily — when the first term is resolved. This repo is one bounded context (the hexagonal monorepo shares `core`/`ports` across all apps), so a single root glossary is correct; do not create per-package CONTEXT files.
- **Decision records**: `docs/decisions/` (already exists). Slug-named files (`place-layout-rename.md`), not numbered. Add a row to `docs/decisions/README.md`'s table for every new record. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

This codebase is dense with terminology that has been mangled before — some seeds worth capturing when they come up: Payee vs Settlement, ledger-authoritative payouts, situs, CAB ("action bar" to users), comp ledger states, Place vs Venue, PlaceLayout (never "seatmap"), Event vs EventDate vs occurrence, community listing, entity page, Human vs User vs authUser.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Human or the authUser? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`CONTEXT.md` should be totally devoid of implementation details. Do not treat `CONTEXT.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.

### Offer decision records sparingly

Only offer to create a decision record when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip it. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).
