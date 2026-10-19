# Places Admin v2 — Detail Panel, Verification Workbench, Missing Fields

**Date:** 2026-04-26
**Status:** complete
**Priority:** P1 (Important)
**Depends on:** `Place`, `PlaceVerificationRequest`, `PlaceVerificationDocument`, `PlaceOwnership`, `PayoutTerms`, `Event`, existing `places.*` use cases, `EventsManager` reference patterns
**Supersedes:** prior `places-admin-v2.spec.md` draft from this date (incorrectly proposed denormalizing verification timestamps onto `Place`)

---

## Problem

The Places admin is a thin spreadsheet while the Events admin is a full workbench. Three concrete gaps:

1. **Information density.** The places table shows name + status + capacity. Organizers can't see linked events, verification state, phone, website, or directory listing without opening the edit page. There is no expandable detail row like `EventsManager` has.
2. **Missing fields in the editor.** `Place.phone`, `Place.website`, `Place.listedInDirectory`, `Place.defaultPrimaryPayoutTermsId`, `Place.defaultResalePayoutTermsId` all exist in the schema but have no UI. Organizers can't manage them, and platform admins can't toggle directory visibility from any admin surface.
3. **Verification is opaque to both sides.** `PlaceVerificationRequest` and `PlaceVerificationDocument` tables exist with full audit fields (status, reviewerNotes, reviewerHumanId, reviewedAt, documents), but:
   - Organizers see only the *current* status badge — no history, no reviewer feedback for rejected requests, no SLA expectation.
   - Platform admins have no review queue. There's no `/platform/places` workbench, no way to approve/reject with notes, no way to download submitted documents, no bulk operations.
   - After rejection, the organizer has no clear path to fix-and-resubmit. The current `canRequestVerification` check allows resubmission but the prior request, its documents, and the rejection notes vanish from view.

---

## Goal

Bring Places admin to feature parity with Events admin: expandable detail rows with rich venue context, surfaced DB fields in the editor, and a proper two-sided verification workflow where the organizer sees their full request history and the platform admin has a real review workbench. Treat `PlaceVerificationRequest` as the authoritative audit trail (it already is — we just need to surface it).

---

## Context

| What exists | Where |
|---|---|
| `Place` model (with phone, website, listedInDirectory, defaultPayoutTerms FKs) | `packages/db/prisma/place.prisma` |
| `PlaceVerificationRequest` model (status, reviewer fields, notes, timestamps) | `packages/db/prisma/place.prisma:166-187` |
| `PlaceVerificationDocument` model (storageKey, fileName, contentType, sizeBytes) | `packages/db/prisma/place.prisma:189-203` |
| `PlacesTable` admin component | `apps/web/src/app/admin/[slug]/places/_components/PlacesTable.tsx` |
| `Place` edit page | `apps/web/src/app/admin/[slug]/places/[placeId]/edit/page.tsx` |
| `VerificationSection` (organizer-facing request UI) | `apps/web/src/app/admin/[slug]/places/[placeId]/edit/_components/VerificationSection.tsx` |
| `places.requestVerificationDocUpload` (R2 presigned URL) | `packages/transport/src/routers/places/...` |
| `places.submitPlaceVerification` (creates request + documents) | `packages/core/src/use-cases/places/submit-place-verification.ts` |
| `getPlaceVerificationEligibility` (validation: name, address, ownership) | `packages/core/src/use-cases/places/place-verification-eligibility.ts` |
| `EventsManager` (reference pattern: expandable rows, metric tiles, CAB) | `apps/web/src/app/admin/[slug]/events/_components/EventsManager.tsx` |
| `DataTable` with `renderExpandedRow`, `onRowPress`, `ExpandableRowCell` | `apps/web/src/components/admin/DataTable.tsx` |
| Place repo / adapter | `packages/adapters/src/db/prisma/places.ts` |
| Platform admin shell (existing route group) | `apps/web/src/app/platform/...` |

---

## Data Model

**No new tables.** The existing `PlaceVerificationRequest` and `PlaceVerificationDocument` already hold everything needed for the audit trail. The previous draft of this spec incorrectly proposed adding `verificationNotes`, `verificationRequestedAt`, `verificationReviewedAt` directly to `Place` — that would denormalize state and lose history across resubmissions. Drop that idea.

Two small enum/field additions:

```prisma
model PlaceVerificationRequest {
  // ... existing fields ...

  /// When the platform admin acknowledged the request and started review.
  /// Distinguishes "in queue" from "actively being reviewed" for SLA tracking.
  /// Null until a platform admin opens the request in the workbench.
  acknowledgedAt   DateTime?
  acknowledgedBy   String?    // Human.id of the platform admin who picked it up

  acknowledger     Human?     @relation("acknowledgedVerifications", fields: [acknowledgedBy], references: [id])

  @@index([status, createdAt])  // for the review queue ORDER BY createdAt ASC
}

enum PlaceVerificationRequestStatus {
  PENDING       // existing — submitted, awaiting review
  IN_REVIEW     // new — a platform admin has acknowledged and is reviewing
  APPROVED      // existing
  REJECTED      // existing
  WITHDRAWN     // new — organizer cancelled before decision
}
```

**Why `IN_REVIEW`?** Today, `PENDING` covers both "in queue" and "being looked at right now". Splitting them lets us:
- Show the queue position to organizers ("you are 4th in line") deterministically
- Prevent two platform admins from reviewing the same request in parallel (claim it on acknowledge)
- Track time-to-acknowledge separately from time-to-decision for SLA reporting

**Why `WITHDRAWN`?** Organizers occasionally submit and immediately realize they uploaded the wrong file. Rather than deleting the row, mark it withdrawn so the audit trail stays intact.

---

## Use Cases

All use cases follow `packages/core` conventions: stateless factories, Zod input/output, typed error codes (`invalid_input | forbidden | not_found | conflict | rate_limited | dependency_failed | transient`), single `repos.tx()` per mutation.

### 1. `getPlaceDetail` — new

Returns the enriched data shown in the expanded detail panel. One round-trip per row expansion.

**Input:** `{ placeId: string }`
**Output:**
```ts
{
  place: {
    id, name, slug, status, verificationStatus,
    address, addrLine1, addrLine2, city, region, postcode, country,
    lat, lng, capacity, phone, website,
    listedInDirectory,
    defaultPrimaryPayoutTermsId, defaultPrimaryPayoutTermsName,
    defaultResalePayoutTermsId,  defaultResalePayoutTermsName,
    createdAt, updatedAt,
  },
  eventStats: {
    total: number,
    upcoming: number,        // startsAt > now()
    past: number,
    nextEventAt: Date | null,
  },
  verification: {
    currentStatus: PlaceVerificationStatus,  // from Place.verification
    activeRequest: VerificationRequestSummary | null,
    history: VerificationRequestSummary[],   // last 10, newest first
  },
  ownership: {
    orgIds: string[],
    humanIds: string[],
  },
}

VerificationRequestSummary = {
  id, status, submittedAt, submittedByName,
  acknowledgedAt, acknowledgedByName,
  reviewedAt, reviewerName, reviewerNotes,
  documentCount, documents: [{ id, fileName, contentType, sizeBytes }],
}
```

**Port:** `repos.places.getDetailById(placeId)`
**Auth:** organizer with access OR platform admin
**Error codes:** `not_found | forbidden`

### 2. `updatePlace` — extend (existing)

Add to the existing place-update use case input:
- `phone: string | null` (E.164 or null; validated with libphonenumber)
- `website: string | null` (validated as `https?://` URL)
- `defaultPrimaryPayoutTermsId: string | null` (must belong to the same org)
- `defaultResalePayoutTermsId: string | null` (must belong to the same org)

`listedInDirectory` is **not** organizer-editable. It is set by:
- The `reviewPlaceVerification` use case on APPROVE (auto-true)
- A platform admin via `setPlaceDirectoryListing` (below)

**Error codes:** `invalid_input | forbidden | not_found | conflict`

### 3. `setPlaceDirectoryListing` — new

Platform-admin-only toggle for the public directory listing. Separate from `updatePlace` so RBAC is enforced cleanly.

**Input:** `{ placeId: string, listedInDirectory: boolean, reason?: string }`
**Behavior:** flips `Place.listedInDirectory`. `reason` is logged to an audit log (existing `AdminAuditLog` if present, otherwise a TODO).
**Auth:** platform admin only
**Error codes:** `forbidden | not_found`

### 4. `submitPlaceVerification` — extend (existing)

Already creates `PlaceVerificationRequest` + `PlaceVerificationDocument` rows. Two extensions:

- **Idempotency:** if an active request (`PENDING | IN_REVIEW`) exists for this place, return that request rather than creating a duplicate. Error code `conflict` if the org tries to submit while one is open.
- **Resubmission after rejection:** allowed unconditionally — creates a new request row. Old rejected requests stay in history.

**Error codes:** `invalid_input | forbidden | not_found | conflict`

### 5. `withdrawPlaceVerification` — new

Organizer cancels their own pending request before review.

**Input:** `{ requestId: string }`
**Behavior:**
- Only the request submitter or a co-admin of the org can withdraw
- Only valid when status is `PENDING` (not after a platform admin has acknowledged)
- Sets status to `WITHDRAWN`, preserves documents
**Error codes:** `forbidden | not_found | conflict`

### 6. `acknowledgePlaceVerification` — new

Platform admin claims a pending request for review. Locks it to that admin to prevent double-review.

**Input:** `{ requestId: string }`
**Behavior:**
- Only valid when status is `PENDING`
- Sets `status = IN_REVIEW`, `acknowledgedAt = now()`, `acknowledgedBy = admin.humanId`
- Idempotent: if already `IN_REVIEW` *by this admin*, no-op. If by another admin, return `conflict`.
**Auth:** platform admin only
**Error codes:** `forbidden | not_found | conflict`

### 7. `reviewPlaceVerification` — new

Platform admin approves or rejects a request. This is the single decision point.

**Input:** `{ requestId: string, decision: "APPROVED" | "REJECTED", notes?: string }`
**Behavior:**
- Valid from `PENDING` *or* `IN_REVIEW` (auto-acknowledge if jumping straight to a decision)
- Validates: rejection requires `notes` (non-empty, ≥10 chars). Approval allows optional notes.
- Inside one `repos.tx()`:
  - Update `PlaceVerificationRequest` (status, reviewerHumanId, reviewedAt, reviewerNotes)
  - If APPROVED: set `Place.verification = VERIFIED`, `Place.listedInDirectory = true`
  - If REJECTED: set `Place.verification = REJECTED`
- Emits domain event `PlaceVerificationReviewed` (for email + in-app notification to organizer)
**Auth:** platform admin only
**Error codes:** `invalid_input | forbidden | not_found | conflict`

### 8. `getPlatformVerificationQueue` — new

Powers the `/platform/places` review workbench.

**Input:** `{ status?: "PENDING" | "IN_REVIEW" | "ALL"; cursor?: string; limit?: number }`
**Output:** paged list of `VerificationRequestSummary` plus `place: { id, name, address, capacity }` and aggregate `queueStats: { pending: number, inReview: number, oldestPendingAgeHours: number }`.
**Default sort:** `PENDING` first (oldest), then `IN_REVIEW` (oldest acknowledged).
**Auth:** platform admin only
**Error codes:** `forbidden`

### 9. `getVerificationDocumentUrl` — new

Generates a short-lived presigned GET URL so platform admins can view uploaded documents without exposing R2 keys to the client.

**Input:** `{ documentId: string }`
**Output:** `{ url: string, expiresAt: Date }` (15-minute TTL)
**Auth:** platform admin only OR the original submitter (so organizers can re-download what they uploaded)
**Error codes:** `forbidden | not_found`

---

## UI / Flow

### A. PlacesTable — columns

Six columns total, mirroring `EventsManager`:

| # | Column | Data | Width | Sortable |
|---|---|---|---|---|
| 1 | Name | Title + address line + verification icon | 3 | by name |
| 2 | Status | `ACTIVE / ARCHIVED` badge | 0.8 | by status |
| 3 | Events | `total` (with `↑ N upcoming` sub-line in muted small text) | 0.8 | by total |
| 4 | Capacity | Users icon + integer | 0.7 | by capacity |
| 5 | Verification | `UNVERIFIED / PENDING / IN_REVIEW / VERIFIED / REJECTED` badge | 1 | by status priority |
| 6 | Created | Localized date | 1.2 | by createdAt |

Verification sort priority (descending): `IN_REVIEW > PENDING > REJECTED > UNVERIFIED > VERIFIED` so requests needing attention float to the top.

### B. PlacesTable — expanded detail panel

Click a row → panel expands beneath, identical pattern to `EventsManager`. Click again → collapse.

**Metric tiles (4):**
1. **Events** — total count / `N upcoming` sub-line
2. **Capacity** — venue capacity (or `—` if null)
3. **Verification** — current status badge + relative date ("verified 3 mo ago" / "pending 2d ago")
4. **Directory** — `LISTED` (success badge) / `NOT LISTED` (neutral badge)

**Contact section:**
- Phone (with `tel:` link if present)
- Website (with external-link icon, opens new tab)
- Empty state: "No contact details — add them in Settings"

**Location section:**
- Full multi-line address (line1, line2, city/region/postcode, country)
- Coordinates `lat, lng` if present
- Mini static map thumbnail (existing component if available; static image URL from coordinates if not — out of scope to build, link out instead)

**Settings section:**
- Slug (with `/places/<slug>` preview)
- Default primary payout terms (name + edit link)
- Default resale payout terms (name + edit link)
- Created / last updated relative dates

**Verification timeline (always visible if any history exists):**
- Vertical timeline, newest at top
- Each entry: status badge, relative timestamp, submitter or reviewer name, notes (collapsed if >120 chars)
- Document chips: clickable → opens presigned GET URL via `getVerificationDocumentUrl`
- "Resubmit verification" CTA if current status is `REJECTED` or `UNVERIFIED`
- "Withdraw" CTA if current status is `PENDING`

**Action bar (bottom of panel):**
- `EDIT` (primary) → `/admin/[slug]/places/[id]/edit`
- `LAYOUT` → layout designer
- `CALENDAR` → venue calendar
- `PUBLIC PAGE` → `/p/<slug>`
- `VIEW EVENTS` → events table filtered by `placeId=<id>`

Row-level overflow menu adds: Archive / Unarchive, Duplicate, Delete (only when zero events linked).

### C. Place edit page — missing fields

Add to the existing edit form (`apps/web/src/app/admin/[slug]/places/[placeId]/edit/page.tsx`), grouped into a new "Contact & directory" section:

- **Phone** — TextInput, libphonenumber formatting, optional
- **Website** — TextInput, URL validation, optional
- **Default primary payout terms** — Select dropdown sourced from `payoutTerms.listForOrg`. Empty option shows "Use organization default". Help text explains: *"Used when creating events at this venue. Overrides the org-level default. Inherited by individual ticket types unless overridden per type."*
- **Default resale payout terms** — same as above

`listedInDirectory` is **not** rendered as an editable field for organizers (intentional — see use case 3). Show it as a *read-only* status badge in the verification card so organizers can see what's true without being able to override it.

### D. Verification workflow — organizer view

Today's `VerificationSection` is solid for the submission flow. Two changes:

1. **Surface history in the expanded detail panel** (covered in B above). The edit page's `VerificationSection` stays focused on the *active* request only; the table panel shows the full timeline.
2. **Show queue position when status is `PENDING`.** Render "Position in review queue: 3 of 12" using a count from `getPlatformVerificationQueue` (run as a side-effect-free query when an organizer opens the panel — same use case, public output, no platform-admin data leakage).
3. **Show "Reviewer is looking now" when status is `IN_REVIEW`.** Sets the expectation that a decision is imminent.

State machine (organizer-side):
```
[UNVERIFIED] ──submit──▶ [PENDING] ──admin acks──▶ [IN_REVIEW]
                            │                          │
                       withdraw                    decide
                            ▼                          │
                       [WITHDRAWN]    ┌────APPROVED────┘
                                      │                │
                                      │           REJECTED
                                      ▼                ▼
                                 [VERIFIED]       [REJECTED]
                                                       │
                                                  resubmit
                                                       ▼
                                                  [PENDING]
```

`Place.verification` mirrors the *latest* terminal status (VERIFIED, REJECTED) plus the in-flight PENDING/IN_REVIEW state. UNVERIFIED is the starting state.

### E. Platform admin workbench — `/platform/places`

New route group: `apps/web/src/app/platform/places/page.tsx`.

**Layout:**
- Header: "Verification queue" + counts (`12 PENDING · 3 IN REVIEW · 47 reviewed this month`)
- Tabs: `QUEUE` (default) · `ALL PLACES` · `DIRECTORY`

**QUEUE tab:**
- DataTable of pending + in-review requests, oldest first
- Columns: Place name, Submitter, Org, Submitted (relative date), Status, Documents (count + chips)
- Row click → opens **review drawer** on the right

**Review drawer:**
- Header: place name + verification eligibility checklist (mirrors organizer-side eligibility)
- Sections: place details, ownership, full address, capacity, existing verification status
- Documents: each document is a clickable chip → opens presigned GET URL in new tab. Shows file size, type icon, original filename
- Notes textarea (free-form, max 2000 chars)
- Action bar:
  - `ACKNOWLEDGE` (only if status `PENDING`) — claims the request, sets `IN_REVIEW`
  - `APPROVE` (primary, success) — confirms via inline "tap again" pattern, sets place to VERIFIED, listedInDirectory=true
  - `REJECT` (danger) — requires notes; confirms via inline "tap again", sets place to REJECTED
  - `RELEASE` (only if status `IN_REVIEW` and you acknowledged it) — drops the lock so another admin can pick it up

**ALL PLACES tab:**
- Same place table as organizer admin but cross-org
- Used for directory curation and dedup investigations

**DIRECTORY tab:**
- Filters: listed / not-listed / verified-but-not-listed (anomaly detection)
- Bulk action: toggle directory listing (with reason field, written to audit log)

### F. Verification CTA from PlacesTable

When a place's row shows `UNVERIFIED` or `REJECTED`, the "Verification" cell becomes a button-like badge: clicking it expands the row AND scrolls the panel to the verification timeline section, with the "Resubmit verification" CTA in focus. Reduces clicks from "see badge → open edit page → scroll to verification" to one.

### G. Linked events visibility

In the events admin table, when an event is linked to a Place (`event.placeId` set), the address column shows the **place name** with a small linked icon, instead of the raw `addressText`. Click → filters places table by that place ID. Bidirectional discoverability.

---

## Acceptance Criteria

### Table & detail panel
- [ ] PlacesTable has 6 columns: name, status, events, capacity, verification, created
- [ ] All 6 columns sortable; verification uses priority sort (IN_REVIEW > PENDING > REJECTED > UNVERIFIED > VERIFIED)
- [ ] Click row toggles expanded detail panel; panel collapses on second click
- [ ] Detail panel shows 4 metric tiles (events, capacity, verification, directory)
- [ ] Detail panel shows contact, location, settings, verification timeline sections
- [ ] Detail panel action bar links to edit, layout, calendar, public page, view events
- [ ] Detail panel uses single `getPlaceDetail` query (one round-trip per expansion)

### Edit page
- [ ] Phone field with libphonenumber validation
- [ ] Website field with URL validation
- [ ] Default primary payout terms dropdown (sourced from org's terms)
- [ ] Default resale payout terms dropdown
- [ ] `listedInDirectory` rendered as read-only status, not an editable toggle for organizers

### Schema
- [ ] `PlaceVerificationRequest.acknowledgedAt`, `acknowledgedBy` columns added
- [ ] `IN_REVIEW`, `WITHDRAWN` enum values added to `PlaceVerificationRequestStatus`
- [ ] Index `(status, createdAt)` added on `PlaceVerificationRequest` for queue queries
- [ ] Existing `PENDING` rows unchanged by migration; status enum widening is backwards-compatible

### Use cases
- [ ] `getPlaceDetail` returns place + eventStats + verification (current + history) + ownership
- [ ] `updatePlace` accepts phone, website, defaultPrimaryPayoutTermsId, defaultResalePayoutTermsId
- [ ] `updatePlace` rejects directory toggle attempts from non-platform-admin callers
- [ ] `setPlaceDirectoryListing` writes to audit log with reason
- [ ] `submitPlaceVerification` is idempotent — returns existing active request instead of duplicating
- [ ] `submitPlaceVerification` allows unlimited resubmissions after `REJECTED`
- [ ] `withdrawPlaceVerification` only valid from `PENDING`; preserves documents
- [ ] `acknowledgePlaceVerification` locks request to acknowledging admin; second admin gets `conflict`
- [ ] `reviewPlaceVerification` requires notes ≥10 chars on REJECT
- [ ] `reviewPlaceVerification` updates Place.verification + Place.listedInDirectory atomically with PlaceVerificationRequest
- [ ] `reviewPlaceVerification` emits `PlaceVerificationReviewed` domain event
- [ ] `getPlatformVerificationQueue` paginates, sorts oldest-first within status groups
- [ ] `getVerificationDocumentUrl` returns 15-minute presigned GET URL; rejects unauthorized callers

### Platform workbench
- [ ] `/platform/places` route exists, gated to platform admins
- [ ] QUEUE tab shows pending + in-review requests with documents
- [ ] Review drawer renders place details, eligibility checklist, document chips
- [ ] Approve / reject / acknowledge / release actions wired to use cases
- [ ] Reject confirmation requires non-empty notes
- [ ] DIRECTORY tab supports bulk directory-listing toggle with reason field

### Verification timeline (organizer)
- [ ] Detail panel timeline shows newest-first request history (last 10 attempts)
- [ ] Each entry shows status, dates, submitter, reviewer, notes, documents
- [ ] Document chips open presigned GET URLs (organizer can download their own uploads)
- [ ] PENDING shows queue position derived from `getPlatformVerificationQueue`
- [ ] IN_REVIEW shows "Reviewer is looking now" hint
- [ ] REJECTED shows reviewer notes prominently with "Resubmit" CTA
- [ ] Resubmit CTA invokes the existing submission flow

### Cross-feature
- [ ] Events admin: when `event.placeId` is set, address column renders place name + link
- [ ] Domain event triggers organizer email + in-app notification on review decision
- [ ] All mutations route through `places` tRPC router; no direct adapter use from UI

---

## Open Questions

- **SLA target.** Is there a public-facing commitment ("we review verifications within 3 business days")? If yes, expose the deadline in the organizer's pending state; if no, "Position in queue" is the only signal we surface. Recommendation: pick a number after we have ~30 reviews of historical baseline data — out of scope for this spec, ship the queue position now. Honestly, just ship it. We'll get a SLA target at some point (This verification process will need to also exist on the place entity page so peoople can own it. We also need places to support being moved from a user's list of organization or simply just themselves (the default admin/org))

- **Document re-use across resubmissions.** When an organizer's request is rejected and they resubmit, should the previous documents auto-attach to the new request, or do they have to re-upload? Today the upload flow is per-request and forces re-upload. Argument for auto-attach: if rejection was for missing context, not bad documents, the organizer shouldn't have to re-upload a 9MB PDF. Argument against: stops the organizer from accidentally including stale docs. Recommendation: show "Reuse documents from previous request" as an opt-in checkbox on resubmit. Reuse documents and default it to yes

- **Multi-admin queue claim contention.** If two admins click ACKNOWLEDGE within 200ms, the second one gets `conflict`. Is the right UX to silently refresh and show "already claimed by Jane" or to surface an error toast? Recommendation: refresh + inline banner ("Jane is reviewing this — release the lock to take over"). I trust your judgement on what option is better for this

- **`Place.verification` vs latest `PlaceVerificationRequest.status`.** Today `Place.verification` is denormalized state. We could derive it from the latest request and drop the column, but that means an extra join on every place read. Recommendation: keep the denormalized column, treat `reviewPlaceVerification` as the only writer, audit it for drift in tests. default here is ideal

- **Place merge / dedup.** A future organizer creates "The Fillmore" while a verified version already exists in the directory. Should the admin workbench have a merge flow that re-points events from the duplicate to the verified record, then deletes the duplicate? This is a real problem (already in `addressHash` field for dedup) but it's a meaty feature on its own. Recommendation: out of scope; track separately. Honestly.... yeah when we get verified addresses/places things duplicates should be killed

- **Revenue attribution per venue.** Worth adding "total revenue from events at this venue" to the detail panel? Requires aggregating across event payouts which is non-trivial. Recommendation: out of scope for v1; revisit after Places admin v2 ships. This is stat collection that will... be under the place_stats job.

- **Place-level event defaults beyond payout terms.** Should verified places be able to set defaults for currency, tax rate, waiver template that pre-fill at event creation? `Place.defaultPrimaryPayoutTermsId` already does this for payouts; the same pattern could extend. Recommendation: out of scope; track as a follow-up. And yeah places should have that.
