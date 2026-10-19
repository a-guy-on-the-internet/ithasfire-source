# Account Deletion — What Gets Deleted, Retained, and Detached

Covers **self-serve deletion** (`humans.deleteMyAccount`, exposed in Account
Settings → Danger Zone) and the **staff-initiated hard delete**
(`platform.deleteHuman`, which calls the `adminDeleteHuman` use case; platform
ADMIN only). Both run the exact same transactional sequence —
`executeHumanDeletionTx` in
`packages/core/src/use-cases/platform/_shared/delete-human-shared.ts` — so this
document describes both.

## Preconditions (self-serve)

1. Confirmation phrase must equal the account email (case-insensitive).
2. Accounts with a password credential must re-enter it (step-up).
   OAuth/passkey-only accounts skip this.
3. Rate-limited (5/60s per actor) at the tRPC layer.

## Guards — what blocks deletion entirely

| Guard | Error code | Why |
| --- | --- | --- |
| Any financial history: orders bought, tickets owned, scans performed, ticket transfers (either side), pending transfers sent, dispute claims (either side), resale listings, resale holds | `CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY` | Financial records are retained for accounting/audit; their `Human` FKs are `ON DELETE RESTRICT`. |
| Sole OWNER of any organization | `CANNOT_DELETE_SOLE_ORG_OWNER` | `OrgMember` cascades; deleting the last owner would orphan the org. Transfer ownership or delete the org first. |
| Any other `ON DELETE RESTRICT` reference the guard does not check: a POS reader the human paired (`PosReader.pairedBy`), or a waiver template the human owns that has any acceptance or a volunteer ask pointing at it | `CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY` | The Postgres FK violation (P2003) is caught in `deleteHuman` (`packages/adapters/src/db/prisma/humans.ts`) and reported with the order-history code, though no order is involved. |

> **Open follow-up:** a GDPR-style "anonymize instead of block" path for users
> with order history (scrub PII, keep the financial skeleton) is not built.
> Today those users cannot self-serve delete at all. Scoped in
> [`docs/specs/2026-07-07/anonymize-buyer-instead-of-block.spec.yaml`](specs/2026-07-07/anonymize-buyer-instead-of-block.spec.yaml).

## Deleted (hard, in one transaction)

- **Human row** — and via DB cascades: `AuthUser` → `AuthAccount`,
  `AuthSession`, `Passkey`, `AuthTwoFactor` (all Better Auth state; there is no
  Better Auth `user.deleteUser` call — the FK cascade does it).
- **EntityPage** (public profile: display name, bio, avatar/banner URLs, slug)
  plus its cascading children: `PageTheme`, `PageBlock`, `PageSlugHistory`,
  `EntityFollow` rows. The page is polymorphic (`ownerType`/`ownerId`, no FK to
  `Human`), so this is an explicit delete in the deletion tx — before this fix
  it survived as a publicly-resolvable orphan and the slug stayed reserved
  forever.
- **R2 avatar/banner objects (current)** — the object keys are derived from the
  page's `avatarUrl`/`bannerUrl` (public URLs are `${publicBaseUrl}/${key}`)
  and enqueued as `PendingObjectDeletion` rows (source `human_delete`) in the
  same tx; the `storage.drain-pending-deletions` job deletes the blobs durably
  with retries. Only keys inside the human's own namespaces
  (`avatars/human/{id}/`, `banners/human/{id}/`, `entity-pages/human/{id}/`)
  are enqueued — the URLs are client-writable via `updatePage`, so off-prefix
  keys (which could point at another entity's object) are dropped.
- **Storage quota row** — the `ResourceUsage` row for
  (`HUMAN`, humanId, `STORAGE_BYTES_HUMAN`) is deleted (polymorphic, no FK —
  would otherwise orphan).
- **Saved snippets** — the human's `SavedSnippet` rows (reusable reasons,
  booking-the-night FR-013) and their `SavedSnippetList` rows, every kind
  (`savedSnippets.deleteByOwner`; polymorphic, no FK — free text the person
  wrote). Org-owned snippets are not touched here; org deletion archives the
  org and does not delete its rows.
- **Support free text** — the user's `SupportMessage` bodies are scrubbed to a
  `[deleted]` tombstone and author links cleared BEFORE the human delete
  (`scrubHumanSupportContent`); the threads themselves survive owner-less
  (`SupportThread.humanId` is SetNull).

An audit log entry (`self.deleteAccount` / `admin.deleteHuman`, with the
deleted email + name) is written inside the transaction, after the guards pass
and before the delete.

## Retained (blocks self-serve deletion)

Orders, tickets, ticket scans, ticket transfers, pending transfers, dispute
claims, resale listings, and resale holds. These are accounting/audit records;
their `Human` FKs stay `ON DELETE RESTRICT` and their existence fails the
deletion with `CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY`.

## Detached (content survives, creator reference nulled)

Since migration `20260706120000_human_deletion_detach_creator_fks`, these
references are nullable with `ON DELETE SET NULL` — creating content never
permanently blocks deletion:

- `Image.createdByHumanId` (event images)
- `AudioUpload.createdByHumanId`
- `EventTemplate.createdByHumanId`
- `EventSeries.createdByHumanId`
- `PlaceLayout.createdByHumanId`
- `Embed.createdBy`
- `EventAttestation.attestedByHumanId` (the attestation's policy snapshot and
  timestamps are retained; only the person reference detaches)
- `PlaceVerificationRequest.submittedById`

UI surfaces that show these attributions must tolerate `null` ("deleted user"
style fallbacks — the admin verification queue renders `—`).

Every other *foreign key* that references `Human` is `Cascade` or `SetNull` in
the schema (e.g. org memberships, RSVPs, saves, follows, notification prefs,
push devices) and is removed or detached automatically by the human-row delete.
Two references still block it (see Guards):

- `PosReader.pairedBy` (`packages/db/prisma/pos.prisma`) declares no
  `onDelete`, so Postgres got `ON DELETE RESTRICT`
  (migration `20260726120000_pos_readers`). A human who paired a card reader
  cannot be deleted.
- A human's `WaiverTemplate` rows cascade with them, but the rows pointing at a
  template are `onDelete: Restrict`: `WaiverAcceptance.waiverTemplate` and
  `VolunteerWaiverAcceptance.waiverTemplate` (`packages/db/prisma/waiver.prisma`)
  and `VolunteerAsk.waiverTemplate` (`packages/db/prisma/volunteer.prisma`).
  Once anyone has accepted the human's waiver, or a volunteer ask uses it, the
  human cannot be deleted.

### Reviews (place + attendee)

A signed-in reviewer's rows are handled by DB FK cascade on the human delete —
no explicit code:

- **`AttendeeReview.humanId`** is `ON DELETE Cascade`: a signed-in attendee's
  reviews (including the free-text `text`) are **hard-deleted** with the human.
- **`PlaceReview.humanId`** is `ON DELETE SetNull`: the review survives with the
  author reference nulled (accounting/reputation signal is retained
  unattributed).

> **Shared open follow-up (guest / anonymous reviews):** both `PlaceReview` and
> `AttendeeReview` carry `anonymousName` / `anonymousEmail` for **guest**
> submissions (`humanId` is null — not tied to any account). These are PII but
> are unreachable by the `humanId`-keyed account-deletion sweep, and there is no
> email-keyed SAR/erasure path in the codebase today (the only data export is
> the org CSV export in `exports/request-admin-export.ts`, which excludes
> reviews). `AttendeeReview`'s anonymous fields (venue-rating-block-and-owner-optin
> FR-009) introduce **no new class** of orphaned PII surface beyond the existing
> `PlaceReview` one — an email-keyed erasure path would cover both together and
> is scoped as a future gate (spec NFR-004).

### Polymorphic / FK-less references — open follow-ups

Some rows reference the human by a bare scalar (no FK), so the delete neither
removes nor nulls them. These come from the claim-venue flow and are **not**
handled by account deletion today:

- **`PlaceOwnership`** — polymorphic `ownerType`/`ownerId`. A deleted human
  with a verified HUMAN ownership row remains the effective verified owner of
  the place (the row survives and confers status to a nonexistent account).
- **`PlaceVerificationRequest.claimantHumanId`** — bare scalar (no
  `@relation`); the claimant id survives as a dangling reference (unlike
  `submittedById`, which is a real FK and detaches to null).
- **`PlaceClaimEmailChallenge`** — `humanId` scalar plus the claimant's
  `email` (PII) survive on challenge rows.

Cross-referenced (not re-solved) in
[`docs/specs/2026-07-05/completed/claim-venue-flow.spec.yaml`](specs/2026-07-05/completed/claim-venue-flow.spec.yaml)
(the feature that introduced these rows) and
[`docs/specs/2026-07-07/anonymize-buyer-instead-of-block.spec.yaml`](specs/2026-07-07/anonymize-buyer-instead-of-block.spec.yaml).

## External systems

- **Stripe:** deletion makes no Stripe call. Ticket payments are tied to
  orders and Connect accounts, and a human with orders can't be deleted. One
  per-person object does exist: starting a membership creates a platform Stripe
  Customer with the person's email, name and `metadata.humanId`
  (`ensureCustomer` in
  `packages/adapters/src/payment-processors/stripe/membership-billing-adapter.ts`,
  called from `memberships/start-membership.ts`), and `Membership` stores its
  `stripeCustomerId`. Each paid membership invoice records an `Order`
  (`memberships/record-membership-invoice-paid.ts`), so a paying member is
  blocked from deletion. A human who started a membership with no paid invoice
  yet can be deleted: the `Membership` row cascades away, and the Stripe
  Customer and any subscription on it stay at Stripe.
- **Better Auth:** all its tables hang off `AuthUser`, which cascades from the
  Human delete. Sessions die with the `auth_session` rows.
- **R2:** current avatar/banner objects are enqueued for deletion (see above).

## Known limitations

- **Stale avatar/banner uploads:** only the objects referenced by the page's
  current `avatarUrl`/`bannerUrl` are enqueued. Older dated uploads under
  `avatars/human/{humanId}/…` / `banners/human/{humanId}/…` that were replaced
  without cleanup (the replace path is best-effort) stay orphaned. This matches
  the existing detached-path storage sweep follow-up tracked with the
  object-deletion outbox work.
- **No anonymize path for order history** (see Guards above).
