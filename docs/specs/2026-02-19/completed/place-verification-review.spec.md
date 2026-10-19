# Place Verification Review — Manual KYB Process

**Status:** complete
**Date:** 2026-02-16
**Related:** `platform-commerce-admin.spec.md`, `docs/roles.md`

## 1. Problem

Place verification currently has Verify/Reject buttons on the platform places
page but no structured review process: no document uploads, no ownership proof
checklist, no reviewer notes, and no document lifecycle management. Staff
reviewers have no evidence to evaluate before clicking Verify.

## 2. Goals

1. Let org admins submit verification requests with supporting documents.
2. Give platform reviewers a structured review panel with all evidence visible.
3. Delete uploaded documents after verification decision (approved or rejected).
4. Keep the process manual and human-driven — no third-party KYB services.

## 3. Non-goals

- Automated KYB via Middesk/Persona/Stripe Identity (future, when scale warrants cost).
- Public-facing "verified" badge on place pages (separate feature).
- Multi-round review (reject → resubmit). V1 is single-pass; resubmission is a
  new verification request.

## 4. Ownership proof: what we need and what we tell them

### 4.1 Required evidence

The reviewer needs enough to confirm:

| Check | What proves it |
| --- | --- |
| **Entity is real** | Business registration, license, or EIN letter |
| **Entity controls the venue** | Lease/deed, utility bill at venue address, or venue management agreement |
| **Submitter represents entity** | They're already an OWNER/ADMIN on the org that owns the place |

### 4.2 Accepted document types

- Articles of incorporation / business registration certificate
- Commercial lease or deed
- Utility bill (recent, at venue address)
- Venue management / operating agreement
- Business license for the venue address
- Government-issued EIN / tax ID letter (US) or equivalent

### 4.3 What to tell submitters

> Upload documents proving your organization operates this venue. We only need
> the **business name** and **venue address** to be visible — you may redact
> all other information (tax IDs, financial figures, personal details, etc.).
>
> Accepted formats: PDF, JPEG, PNG. Max 10 MB per file, up to 5 files.
>
> Documents are stored securely and **deleted immediately** after review.

## 5. Data model changes

### 5.1 New model: `PlaceVerificationRequest`

```prisma
model PlaceVerificationRequest {
  id              String                        @id @default(uuid())
  placeId         String
  orgId           String
  submittedById   String
  status          PlaceVerificationRequestStatus @default(PENDING)
  reviewerNotes   String?
  reviewerHumanId String?
  reviewedAt      DateTime?
  documents       PlaceVerificationDocument[]

  place       Place        @relation(fields: [placeId], references: [id], onDelete: Cascade)
  org         Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  submittedBy Human        @relation("submittedVerifications", fields: [submittedById], references: [id])
  reviewer    Human?       @relation("reviewedVerifications", fields: [reviewerHumanId], references: [id])

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([placeId])
  @@index([status])
}

model PlaceVerificationDocument {
  id            String                      @id @default(uuid())
  requestId     String
  storageKey    String
  fileName      String
  contentType   String
  sizeBytes     Int
  deletedAt     DateTime?

  request PlaceVerificationRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())

  @@index([requestId])
}

enum PlaceVerificationRequestStatus {
  PENDING
  APPROVED
  REJECTED
}
```

### 5.2 Existing model: `PlaceOwnership`

Already has `proof Json?` — we won't use this for documents. The
`PlaceVerificationRequest` is the canonical record. `PlaceOwnership.proof`
remains available for future lightweight metadata.

## 6. Implementation plan

### 6.1 Submitter flow (org admin)

**Where:** New section on the place edit page
(`/admin/[slug]/places/[placeId]/edit`), or a dedicated
`/admin/[slug]/places/[placeId]/verify` page.

**Steps:**

1. Org admin sees current verification status on the place detail page.
2. If UNVERIFIED or REJECTED, they see a "Request Verification" button.
3. Clicking opens a form with:
   - Informational text (section 4.3 above).
   - File upload area (drag-and-drop or picker). Max 5 files, 10 MB each.
   - PDF/JPEG/PNG only.
4. On submit:
   a. Client calls `requestVerificationDocUpload` to get presigned URLs for each
      file (using existing `FileStoragePort.presignPutObject`).
   b. Client uploads files directly to R2 via presigned PUT.
   c. Client calls `submitPlaceVerification` with the storage keys, file names,
      content types, and sizes.
   d. Use case creates `PlaceVerificationRequest` + `PlaceVerificationDocument`
      rows and transitions `Place.verificaion` to `PENDING`.
5. Place detail page shows "Verification pending" status.

**Use cases:**

- `request-verification-doc-upload` — presigns upload URLs (like avatar upload).
  Key pattern: `place-verification/{placeId}/{requestId}/{uuid}.{ext}`.
  Files are private (not public).
- `submit-place-verification` — creates the request record, links documents,
  sets place status to PENDING. Gated by `canAdminOrg()`.

### 6.2 Reviewer flow (platform staff)

**Where:** Enhanced platform places page (`/platform/places`). The existing
Verify/Reject buttons get replaced with a review panel.

**Steps:**

1. Reviewer filters to "Pending" verification status (existing filter).
2. Clicking a row opens a detail panel or a dedicated review page showing:
   - Place details (name, address, capacity, org info).
   - Ownership info (from `PlaceOwnership` — which org(s) claim it).
   - Uploaded documents with:
     - File name, type, size.
     - "View" button that opens a time-limited signed URL (5 min TTL).
     - Documents are rendered inline for images, or opened in a new tab for PDFs.
   - Reviewer checklist (non-blocking, advisory):
     - [ ] Business name visible and matches org name
     - [ ] Venue address visible and matches place record
     - [ ] Document appears authentic (not obviously fabricated)
   - Reviewer notes textarea.
   - Approve / Reject buttons.
3. On Approve:
   a. Transitions `PlaceVerificationRequest.status` to `APPROVED`.
   b. Transitions `Place.verificaion` to `VERIFIED`.
   c. Sets `PlaceOwnership.verified = true` and `reviewerHumanId`/`reviewedAt`.
   d. **Deletes all uploaded documents from R2** (fire-and-forget, log failures).
   e. Sets `PlaceVerificationDocument.deletedAt` on all document records.
   f. Audit log entry.
4. On Reject:
   a. Transitions `PlaceVerificationRequest.status` to `REJECTED`.
   b. Transitions `Place.verificaion` to `REJECTED`.
   c. **Deletes all uploaded documents from R2**.
   d. Sets `PlaceVerificationDocument.deletedAt`.
   e. Audit log entry with reviewer notes (reason for rejection).
   f. (Future: notification to org admin with rejection reason.)

**Use case:**

- `review-place-verification` — accepts `requestId`, `decision` (APPROVED |
  REJECTED), `reviewerNotes?`. Gated by `hasStaffRole(["ADMIN", "REVIEWER"])`.
  Performs all steps above in a single transaction (except R2 deletion, which
  is best-effort post-commit).

### 6.3 Document lifecycle

```
Upload presigned → R2 (private, key: place-verification/{placeId}/{requestId}/{uuid}.ext)
  ↓
Review (staff views via signed URL, 5 min TTL)
  ↓
Decision (APPROVED or REJECTED)
  ↓
Delete from R2 (immediate, best-effort)
  ↓
Mark PlaceVerificationDocument.deletedAt
```

Documents are **never** made public. They exist only for the review window.

### 6.4 Stale document cleanup

A scheduled job (`cleanup-stale-verification-docs`) runs daily to catch any
documents that survived past their review (e.g., R2 delete failed, request
abandoned). It queries `PlaceVerificationDocument` where `deletedAt IS NULL`
and the parent request is older than 30 days or has a non-PENDING status,
then deletes from R2 and sets `deletedAt`.

## 7. Ports, adapters, and transport changes

### 7.1 New ports / repo methods

| Layer | Addition |
| --- | --- |
| `Repos` | `placeVerificationRequests` sub-repo: `create`, `getById`, `listForPlace`, `updateDecision` |
| `Repos` | `placeVerificationDocuments` sub-repo: `createMany`, `listByRequestId`, `markDeleted` |

### 7.2 New use cases

| Use case | Gating |
| --- | --- |
| `request-verification-doc-upload` | `canAdminOrg()` for the place's org |
| `submit-place-verification` | `canAdminOrg()` |
| `review-place-verification` | `hasStaffRole(["ADMIN", "REVIEWER"])` |

### 7.3 Transport

| Router | Procedure |
| --- | --- |
| `places` | `requestVerificationDocUpload`, `submitPlaceVerification` |
| `platform` | `reviewPlaceVerification`, `getVerificationRequest` |

### 7.4 UI pages

| Page | Changes |
| --- | --- |
| `/admin/[slug]/places/[placeId]/edit` | Add "Verification" section with document upload form |
| `/platform/places` | Replace simple Verify/Reject buttons with review panel |

## 8. Implementation order

1. **Schema migration** — add `PlaceVerificationRequest`, `PlaceVerificationDocument`,
   `PlaceVerificationRequestStatus` enum.
2. **Verification doc upload** — `request-verification-doc-upload` use case
   (follows avatar upload pattern).
3. **`submit-place-verification`** — creates request, links docs, sets PENDING.
4. **`review-place-verification`** — decision + doc deletion + status transitions.
5. **Stale doc cleanup job** — scheduled daily.
6. **Submitter UI** — verification section on place edit page.
7. **Reviewer UI** — enhanced platform places page with review panel.
8. **Tests** — unit tests for each use case, integration test for full flow.

> **Note:** Stripe PI cleanup for expired/released carts is tracked separately
> in [`pi-cleanup.spec.md`](./pi-cleanup.spec.md).

## 9. Testing plan

| Scenario | Type |
| --- | --- |
| Submit verification with valid docs | Unit |
| Submit verification for non-owned place → forbidden | Unit |
| Submit when already PENDING → conflict | Unit |
| Reviewer approves → place VERIFIED, docs deleted | Unit |
| Reviewer rejects → place REJECTED, docs deleted, notes saved | Unit |
| Reviewer without staff role → forbidden | Unit |
| Stale doc cleanup finds orphaned docs | Unit |
| Doc upload presign → upload → submit → review → deletion | Integration |

## 10. Security considerations

- Documents are stored in a **private** R2 bucket path. No public URLs ever.
- Signed view URLs expire after 5 minutes.
- Documents are deleted from storage after review decision. `deletedAt` is set
  on the DB record so we can audit that deletion happened.
- Stale cleanup job catches any docs that slip through (R2 delete failure,
  abandoned requests).
- File size and type are validated both client-side and server-side (presign
  step enforces content type + size).
- Submitter guidance explicitly says to redact PII beyond name + address.
