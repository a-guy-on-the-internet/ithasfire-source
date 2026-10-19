# Event admin — read access for non-editor roles + EventBuilder role gating

**Date:** 2026-04-28
**Status:** in-progress
**Priority:** P2 (role conflation, real access gap)
**Depends on:** existing `OrgRole`, `ORG_EDIT_ROLES`, `EventBuilder`, `useEventOwnerEntities`
**Supersedes:** N/A

---

## Problem

Three layered issues, only the third is what was originally proposed:

1. **`listEventOwnerEntities` is misnamed and now over-filtering.**
   `packages/core/src/use-cases/events/list-event-owner-entities.ts:73,91` filters memberships to `ORG_EDIT_ROLES = [OWNER, ADMIN, EDITOR]`. The use case's intent was "who can *own / create* events" — a sensible filter for the new-event flow. But the same query backs the admin shell's org switcher and the EventBuilder slug resolution. Result: FINANCE / VIEWER / SCANNER members of an org **never see the org in the admin shell at all** and can't navigate to attendees, volunteers, or refund context. They literally have no UI.

2. **Reach problem.** A FINANCE role today wanting to look up a buyer to issue a refund has no path — the org isn't in their admin slug list, so `/admin/[slug]/...` won't resolve. Same for SCANNER (needs check-in views) and VIEWER (needs reports).

3. **EventBuilder role conflation (the original concern).** Once non-editors can reach the page, they'll see Save / Publish / Unpublish / Edit affordances they don't have permission to use, and clicking will 403 server-side with no UX hint.

## Goal

Open the admin shell to all org-membership roles. Gate write affordances by role. Default the EventBuilder landing for non-editors to Preview (or first read tab), not Edit.

## Design

### A. Split "owner entities" from "admin-accessible orgs"

Two distinct concepts:

| Question                                       | Allowed roles                              | Use case                          |
| ---------------------------------------------- | ------------------------------------------ | --------------------------------- |
| "Which orgs can I create/own events for?"     | OWNER, ADMIN, EDITOR                       | `listEventOwnerEntities` (today)  |
| "Which orgs can I administer in any capacity?" | OWNER, ADMIN, EDITOR, FINANCE, VIEWER, SCANNER | new `listAdminAccessibleOrgs`     |

Either:

- **Option A1 (preferred):** add a new use case `listAdminAccessibleOrgs` that returns the broader set, including each org's role. The existing `listEventOwnerEntities` keeps its narrower "owner" semantics for the new-event flow only.
- **Option A2:** generalize `listEventOwnerEntities` with a `purpose: "create" | "administer"` input. Riskier (changes existing call sites' implicit contract) and the name still misleads.

Go with A1.

### B. UI hook + types

`apps/web/src/hooks/useEventOwnerEntities.ts`:

- Add a sibling hook `useAdminAccessibleOrgs` that calls the new procedure.
- Widen the org role union to the full `OrgRole` set there.
- `useCurrentAdminOwner` should consume the new hook (so the admin shell sees all admin-accessible orgs); the new-event flow's owner picker keeps using the narrow query.

### C. EventBuilder gating

A single computed `canEditEvent: boolean` derived from `currentOwner.role` (org case): `role ∈ {OWNER, ADMIN, EDITOR}`.

| Affordance                    | Gate                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| Edit tab                      | `canEditEvent`                                                        |
| Seating tab                   | `canEditEvent` && existing conditions                                 |
| Preview tab                   | (unchanged)                                                           |
| Attendees tab                 | event PUBLISHED (no `isEditMode` requirement — drop that condition)   |
| Volunteers tab                | always (drop `isEditMode` requirement)                                |
| CAB Save                      | `canEditEvent` (add `requiredDataKey: ebShowSave`, set by EventBuilder) |
| CAB Publish / Unpublish       | `canEditEvent` && existing eventStatus gate                           |
| Form fields (`<TextInput>`s)  | `editable={canEditEvent}` (best-effort; bias toward read-only when in doubt) |

Default-tab logic:
- `canEditEvent` && draft → "edit" (today's behavior).
- `canEditEvent` && published → "edit" (today).
- `!canEditEvent` && published → "preview".
- `!canEditEvent` && draft → "preview" (with empty-state messaging — non-editors landing on a draft is uncommon; keep the experience friendly).

### D. CAB cleanup (already done)

`apps/web/src/components/navigation/contextual-action-bar/bar-configs.ts:494-512`:

- Removed Attendees / Volunteers / Comp Tickets entries from CAB overflow on `/admin/:slug/events/:id/edit` (they're already in-page tabs).
- Kept View Event + Publish/Unpublish/Preview/Save.
- (Pending in this spec) gate Save on `ebShowSave`.

### E. Out of scope

- Backend write authorization (already correct via `requireOrgMembership` + role checks).
- Replacing `useCurrentAdminOwner` — extend rather than rip out.
- Per-field column masking for FINANCE viewing attendee PII (separate spec under platform commerce admin).
- SCANNER's "assigned events only" scope (existing scanner app territory).
- Renaming `@th → @hf` (separate refactor).

## Acceptance

- A FINANCE / VIEWER / SCANNER user with org membership sees the org in their admin shell.
- They can navigate to `/admin/:slug/events/:id/edit` and see attendees + volunteers.
- They do **not** see Save / Publish / Edit tabs / Edit-mode CTAs.
- Clicking any visible button never hits a 403 from the server (UI doesn't show actions the role can't take).
- OWNER/ADMIN/EDITOR see today's full surface.
- Existing tests for `listEventOwnerEntities` still pass (its semantics are unchanged).
- New tests for `listAdminAccessibleOrgs` cover all six org roles.

## Effort

~4-6 hr. Three concrete tracks:

1. **Backend** (~1 hr): add `listAdminAccessibleOrgs` use case + tRPC procedure + tests.
2. **UI hook** (~1 hr): add `useAdminAccessibleOrgs`; switch `useCurrentAdminOwner` to use it; widen types.
3. **EventBuilder + CAB** (~2-3 hr): derive `canEditEvent`, gate ~6-10 affordances, default-tab logic, form-field readonly pass.

Code review will find more affordances I haven't enumerated above (every `<Button>` that calls a save mutation, every `<Select>` that mutates state, etc.). Plan to iterate.
