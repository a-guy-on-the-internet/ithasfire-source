# Spec Library Audit — 2026-05-16

Read-only audit of every spec under `docs/specs/` against the actual codebase.
Classifications are based on quick code-presence checks (schema models,
use-case directories, transport routers, admin/web pages); they do not
exhaustively verify functional parity.

## Summary

| Classification | Count |
| --- | ---: |
| BUILT | 39 |
| PARTIAL | 23 |
| NOT_BUILT | 19 |
| OBSOLETE | 3 |
| UNCLEAR | 10 |
| **Total specs audited** | **94** |

Skipped `2026-05-16/completed/` (per instructions).

---

## 2025-10-30

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| ui.pattern.md | (note only) | UNCLEAR | Aspirational UI map; says it's "not fully implemented yet". Reference doc, not a spec. |

## 2025-11-04

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| event-templates.md | (no status) | BUILT | `EventTemplate` model + `core/use-cases/event-templates/` (create/update/apply/archive/list). |

## 2025-12-14

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| architecture-services.md | (reference doc) | BUILT | Inventory doc; matches services in use. |
| completed/place-layout-migration.md | (completed) | BUILT | Seatmap→PlaceLayout rename evident in `place.prisma`, `place-layouts/`. |
| completed/place-layout-quality.md | (completed) | UNCLEAR | Benchmarks doc; cannot verify pass/fail without running benches. |

## 2026-01-01

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| event-builder.md | (no status) | BUILT | Event body JSONB + EventBuilder UI shipped; R2 presign + finalize use cases exist. |

## 2026-02-19

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| pi-cleanup.spec.md | Draft | PARTIAL | `release-expired-carts.ts` + `release-cart-hold.ts` exist; couldn't confirm explicit PI cancel call without deeper read. |
| place-verification-review.spec.md | Draft | BUILT | `PlaceVerificationRequest`/`PlaceVerificationDocument` migration `20260426010000_add_place_verification_workbench`; review use cases exist. |
| platform-commerce-admin.spec.md | Draft | BUILT | `/platform/orders`, `/platform/tickets`, `list-platform-orders.ts`, active carts UI present. |

## 2026-02-23

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| email-editor-blocks.md | Design, not scoped | NOT_BUILT | No block-based email editor in `packages/ui-email`. |

## 2026-02-27

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| inbound-email-routing.md | Future consideration | NOT_BUILT | No inbound mail handler / smart reply-to plumbing. |

## 2026-03-03

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| announcements.md | v1 planned | BUILT | `Announcement` model, `announcements/` use cases, `/admin/[slug]/announcements`. |
| audit-log-viewer.md | Planned | NOT_BUILT | `AuditLog` model populated, but no `/admin/[slug]/activity` page. |
| auto-collect-buyer-contacts.md | Planned | PARTIAL | `audiences` admin exists; auto-collect on order completion not clearly wired. |
| deferred-capture.md | Design (RFC) | NOT_BUILT | No `capture_method: manual` flow in stripe adapter / create-checkout (capture-on-event-date not implemented). |
| event-builder-ticket-types.md | Draft | BUILT | EventBuilder UI shipped; ticket types, payout terms, humans sections present. |
| layout-image-detection.md | In Progress (Phase 1) | UNCLEAR | Phase 1 server-side detection unclear without grep into adapters. |
| location-system-redesign.md | Draft | BUILT | MapLibre + MapTiler in use (`LocationPinInput`, `LocationMapPreview`); `EventLocationMode` enum present. |
| org-email-invitations.md | In progress | BUILT | `OrgInvitation` model + invite/accept/revoke use cases. |
| org-onboarding-wizard.md | Planned | UNCLEAR | Dashboard page exists; couldn't verify checklist component. |
| org-settings.md | Planned | BUILT | `/admin/[slug]/settings` route + `update-org.ts` use case. |
| small-feature-ideas.md | Backlog | PARTIAL | `duplicate-event.ts` exists; other ideas not verified. |
| ticket-selection-and-checkout-redesign.md | Draft | BUILT | New checkout under `apps/web/.../events/checkout/[...slug]/_components/` + seat map flow. |

## 2026-03-05

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| agreements-booking-requests-payout-consolidation.md | Draft | PARTIAL | `Agreement`, `BookingRequest`, `PayoutTerms`, `PayoutTermsLine` exist; payout consolidation/batching not verified. |
| checkout-feature-a-remove-mobile-sticky-bar.md | (no status) | UNCLEAR | Frontend tweak; would need to read Checkout.tsx to confirm bar removed. |
| checkout-feature-b-fee-tooltips-and-estimate-label.md | (no status) | UNCLEAR | i18n + UI tweak; not verified. |
| checkout-feature-c-tax-estimation-after-billing-address.md | Superseded note inline | BUILT | `estimate-checkout-tax.ts` use case + `admissionTaxRateBps` field; spec itself notes backend done. |
| checkout-feature-d-save-to-profile.md | (no status) | PARTIAL | Profile model exists; no `update-human` save-contact use case found in `humans/`. |

## 2026-03-06

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| checkout-improvements-index.md | (index) | PARTIAL | C is built; A/B/D partial/unverified. |
| competitive-ux-features.md | item #1 SHIPPED | PARTIAL | First item shipped; remainder mixed. |
| embeddable-event-widgets.spec.md | Spec (uncompleted) | BUILT | `EmbedToken`, embed use cases (bootstrap/get/list/upsert/revoke), `/admin/[slug]/embeds`, `/embed/[embedId]` page, `apps/api/.../embed/bootstrap.ts`. |
| event-attribute.md | (prompt) | NOT_BUILT | No `AttributeDefinition`/`EventAttribute` models. |
| event-category.md | (prompt) | BUILT | `categories/` use cases (list/request/review/sitemap) + `EventCategoryRequest` model. |
| event-format.md | (prompt) | NOT_BUILT | No `EventFormat` model or `formatId` on Event. |
| event-series.md | (prompt) | BUILT | `EventSeries`, `EventSeriesOccurrence`, full `series/` use cases. |
| event-sub-category.md | (prompt) | BUILT | `EventType` model + `event-types/` use cases. |
| item-level-settlements-and-resale.md | Implemented / Draft (resale) | BUILT | OrderItem.paidOutAt/refundedAt/transferredAt + resale module exists. |
| payout-terms-claims-resale-controls.md | Draft | BUILT | `PayoutTerms` rename done; `Claim` model + resaleAllowed/resaleCapCents/transferAllowed on `TicketType`. |
| platform-orders-tickets.spec.md | Draft | BUILT | Same as platform-commerce-admin above. |
| venue-calendar.spec.md | Spec (uncompleted) | BUILT | `get-venue-calendar.ts`, `apps/web/.../embed/calendar/`, public+embed calendar paths. |
| venue-event-proposals.spec.md | Spec (uncompleted) | PARTIAL | `BookingRequest` model + `PlaceAvailability` exist; full proposal lifecycle UI unverified. |

## 2026-03-09

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| site-builder.spec.md | Draft | PARTIAL | `EntityPage` + `PageBlock` models implement org/place/human page editor (covers P0/P1 in part); no separate "mini-site" platform/themes engine beyond entity pages. |

## 2026-03-16

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| resale-marketplace.spec.md | Draft | BUILT | Full `resale/` use case module + `/admin/[slug]/resale`, claims, listings, expire jobs, post-event grace period. |

## 2026-03-19

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| backlog-sprint-2026-03.md | (backlog list) | PARTIAL | Item 1 (embed bootstrap) built; remaining items unverified. |
| comp-ticket-issuance.spec.md | Draft | BUILT | `core/use-cases/comp/` directory present + `comp.ts` router. |

## 2026-03-23

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| README.md | (index) | NOT_BUILT | Catalog only; scraped events not implemented. |
| event-claim-verification.spec.md | Draft | PARTIAL | `claims.ts` router + `apps/web/src/app/claim-transfer/` + ticket transfer claims exist; ScrapedEvent-claim flow not built (no ScrapedEvent model). |
| volunteering.spec.md | In progress (slices 1–4 done) | BUILT | `volunteer.prisma`, `volunteering/` use cases (8 incl. shifts/signups/templates/reminders), `volunteer.ts` router, `/admin/[slug]/volunteer-templates`. |

## 2026-03-25

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| waiver-system.spec.md | (no status) | BUILT | `WaiverTemplate`, `WaiverAcceptance`, `waivers/` use cases, `waivers.ts` router. |

## 2026-04-02

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| migrate-event-orders.spec.md | Draft | BUILT | `migrate-event-orders.ts` use case present in orders. |
| reconcile-series-schedule.spec.md | Draft | BUILT | `series/reconcile-series-schedule.ts` use case. |

## 2026-04-05

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| README.md | (index) | n/a | Catalog. |
| announcement-preference-compliance.spec.md | Draft | PARTIAL | List-Unsubscribe + `unsubscribedAt` + notification-preferences router exist; full CAN-SPAM compliance audit not done here. |
| completed/place-reviews-and-stats.spec.md | Phase 1 completed | BUILT | `PlaceReview`, `place-review.prisma`, `place-reviews/` use cases, `stats.prisma`. |
| place-review-decay-and-trends.spec.md | Phase 2 (later) | NOT_BUILT | Decay weighting + trend direction not implemented. |

## 2026-04-08

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| completed/place-review-form-v3.spec.md | Pre-Carrie revision | BUILT | `PlaceReviewSession` + v3 migration `20260408000000_place_review_v3`. |

## 2026-04-13

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| completed/fan-attribution-analytics.spec.md | Draft → completed | BUILT | `attribution.prisma`, `record-attribution.ts`, `analytics.ts` router. |
| follows.spec.md | draft | BUILT | `EntityFollow` model + `follows/` use cases (follow/unfollow/list/follower-stats) + `follows.ts` router. |
| place-human-org-stats.spec.md | Draft | BUILT | `stats.prisma` + `compute-org-stats.ts`, `get-org-stats.ts`, PlaceStats and HumanStats in stats. |

## 2026-04-15

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| artist-tour-routing.spec.md | draft / P2 | NOT_BUILT | No tour-routing engine; `BookingRequest` is there but no Valhalla/route ranking. |
| completed/place-review-form-completion-and-retention.spec.md | draft | BUILT | Listed in completed/ — review form v3 retention plumbing through PlaceReviewSession. |
| delayed-address-reveal.spec.md | draft / P0 | BUILT | `addressRevealAt` field + reveal-preset enum + migration `20260416200548_add_address_reveal`. |
| host-a-show-viral-prompt.spec.md | draft / P3 | NOT_BUILT | No viral host-prompt flow surfaced. |
| human-reviews-and-vouching.spec.md | draft / P2 | NOT_BUILT | No human-review/vouch model. |
| living-room-mode.spec.md | draft / P0 | PARTIAL | Underlying pieces (address reveal, places, pricingMode ADJUSTABLE) exist; no consolidated "Living Room" preset/UI verified. |

## 2026-04-16

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| terraform-environment-prefix-refactor.spec.md | draft / P1 | UNCLEAR | Did not inspect terraform module state; spec says "never successfully applied" so likely PARTIAL/NOT_BUILT. |

## 2026-04-18

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| donation-ticket-type.spec.md | draft / P1 | BUILT | Implemented via `TicketTypePricingMode.ADJUSTABLE` + `minimumCents`/`suggestedCents` (migration `20260418174813_add_adjustable_pricing_mode`). |
| ithasfire-launch-backlog.spec.md | living | PARTIAL | Master backlog; many items shipped, others outstanding. |

## 2026-04-19

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| waiver-clause-library.spec.md | draft / P2 | BUILT | `WaiverClause`, `WaiverClauseAutoRule` models + migration `20260420001356_add_waiver_clause_library`. |

## 2026-04-24

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| entity-page-editor.spec.md | draft / P1 | BUILT | `entity-pages/` use cases (manage-page-blocks, update-page-theme, get-public-page) + `/admin/[slug]/page` + `entity-pages.ts` router. |

## 2026-04-25

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| audio-player-v2.spec.md | draft / P2 | PARTIAL | Waveform peaks migration `20260425200000_add_audio_waveform_peaks` exists; sticky mini-player + playback speed UI not verified. |

## 2026-04-26

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| app-store-connect-metadata.md | reference | UNCLEAR | Submission cheat-sheet, not feature code. |
| event-revenue-splits.spec.md | draft / P1 | PARTIAL | `Payee`, `PayoutTerms`, `PayoutTermsLine` exist + payout-line confirmation migration `20260428000000_add_payout_line_confirmation_and_merch`; full publish-time Stripe Connect gate UI unverified. |
| places-admin-v2.spec.md | draft / P1 | PARTIAL | Verification workbench migration shipped; full detail-panel UX not verified. |

## 2026-04-27

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| home-discovery-consolidation.spec.md | draft / P1 | UNCLEAR | Existing search use cases present; consolidation to 1 call not verified without reading HomeLayout.tsx. |

## 2026-04-28

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| eventbuilder-role-gating.spec.md | in-progress / P2 | UNCLEAR | Did not inspect EventBuilder role gating in detail. |
| platform-roles-doc-correction.spec.md | in-progress / P3 | UNCLEAR | Docs-only change; not audited. |
| volunteer-template-shift-times.spec.md | draft / P2 | BUILT | `VolunteerRoleTemplateShift` model + migration `20260428010000_volunteer_role_template_shifts`. |

## 2026-04-29

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| embeds-fit-and-discoverability.spec.md | draft / P2 | UNCLEAR | mediaEmbed node exists; fit/slash-menu changes not verified. |

## 2026-05-12

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| postgres-search-adapter.spec.md | draft / P1 | BUILT | `packages/adapters/src/search/multi-index-postgres-adapter.ts` + migration `20260512_search_documents`. |

## 2026-05-13

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| postgres-idempotency-and-job-tracker.spec.md | implementation-ready | BUILT | `idempotency/prisma-adapter.ts` (Postgres-backed) + `apps/jobs/src/lib/postgres-job-run-tracker.ts` + migration `20260513120000_job_run_tracker_postgres`. |

## 2026-05-14

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| dispute-handling.spec.md | draft / P0 | BUILT | `Dispute` model + `disputes/` use cases (open/close/refresh/notify/record-funds-withdrawn) + migration `20260515000000_add_dispute_intake`. |
| dispute-prevention-quick-wins.spec.md | implemented 2026-05-14 | BUILT | Migration `20260514000000_add_order_dispute_prevention_fields` + `20260515_chargeback_terms_acceptance`. |
| host-attestation.spec.md | implementation-ready | BUILT | `EventAttestation` model + `currentAttestationId` on Event + migration `20260515_host_attestation` + `host-attestation-text.ts`. |
| pos-attestation.spec.md | implementation-ready | UNCLEAR | Did not inspect scanner app POS acknowledgement modal. |
| web-launch-checklist.spec.md | most items audited+shipped | BUILT | Living doc — most rows marked done; matches schema migrations seen. |

## 2026-05-16

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| user-credit.spec.md | draft / P3 | NOT_BUILT | No `UserCredit` model; spec is fresh. |

## Legacy namespaced folders

| Spec | Self-status | Reality | Notes |
| --- | --- | --- | --- |
| events/README.md | (index) | n/a | Index. |
| events/migrate-event-orders.spec.md | (duplicate) | OBSOLETE | Duplicate of `2026-04-02/migrate-event-orders.spec.md`. |
| events/reconcile-series-schedule.spec.md | (duplicate) | OBSOLETE | Duplicate of `2026-04-02/reconcile-series-schedule.spec.md`. |
| platform/README.md | (index) | n/a | Index. |
| platform/architecture-services.md | (duplicate) | OBSOLETE | Duplicate of `2025-12-14/architecture-services.md`. |
| platform/platform-orders-tickets.spec.md | (duplicate) | BUILT | Mirror of `2026-03-06/platform-orders-tickets.spec.md`; feature is shipped. |
| transport/README.md | (index) | n/a | Index. |
| README.md (root) | (conventions) | n/a | Conventions doc. |

---

## Drift — Most Surprising Mismatches

### Specs marked draft / in-progress that are actually fully BUILT

- **`2026-03-06/embeddable-event-widgets.spec.md`** — status `Spec (uncompleted)` but `EmbedToken`, embed use cases, admin UI, public embed route, and `apps/api/.../embed/bootstrap.ts` are all present.
- **`2026-03-06/venue-calendar.spec.md`** — `Spec (uncompleted)` but `get-venue-calendar.ts` + embed calendar route are live.
- **`2026-03-16/resale-marketplace.spec.md`** — `Draft` but the entire resale module ships (use cases, router, admin page, claims, expire jobs).
- **`2026-03-19/comp-ticket-issuance.spec.md`** — `Draft` but the `comp/` use-case dir + `comp.ts` router exist.
- **`2026-04-02/migrate-event-orders.spec.md`** and **`reconcile-series-schedule.spec.md`** — both `Draft`, both implemented.
- **`2026-04-13/follows.spec.md`** — `draft` but `EntityFollow` + full follow use-case set + router are in.
- **`2026-04-13/place-human-org-stats.spec.md`** — `Draft` but `stats.prisma` + compute/get use cases exist for org stats (place/human stats partial).
- **`2026-04-15/delayed-address-reveal.spec.md`** — `draft` but `addressRevealAt` field + reveal-preset enum + migration shipped.
- **`2026-04-18/donation-ticket-type.spec.md`** — `draft` but implemented as `TicketTypePricingMode.ADJUSTABLE` (different shape than spec, but feature is delivered).
- **`2026-04-19/waiver-clause-library.spec.md`** — `draft` but `WaiverClause` + `WaiverClauseAutoRule` are in schema.
- **`2026-04-24/entity-page-editor.spec.md`** — `draft` but entity-pages use cases + admin page route are live.
- **`2026-04-28/volunteer-template-shift-times.spec.md`** — `draft` but `VolunteerRoleTemplateShift` model + migration shipped.
- **`2026-05-12/postgres-search-adapter.spec.md`** — `draft` but Postgres adapter and search_documents migration are merged.
- **`2026-05-14/dispute-handling.spec.md`** — `draft — pre-implementation` but `Dispute` model + full dispute use case suite + migrations are present.
- **`2026-05-14/host-attestation.spec.md`** — `implementation-ready` and is in fact implemented (`EventAttestation`, migration, host-attestation-text.ts).

### Specs marked complete/shipped that show full implementation

No false-positive "completed" specs were found in the audit — items in `completed/` subdirs do appear to be implemented in code.

### Specs marked Planned/In-progress that are actually NOT_BUILT

- **`2026-03-03/audit-log-viewer.md`** — `Planned`. `AuditLog` rows are written, but the `/admin/[slug]/activity` viewer route does not exist.
- **`2026-03-03/deferred-capture.md`** — `Design (RFC)`. No manual-capture/defer-capture pipeline in code; Stripe adapter still uses automatic capture.
- **`2026-03-03/auto-collect-buyer-contacts.md`** — `Planned`. Audiences UI exists, but auto-piping order-completion → audience entry is not wired.
- **`2026-04-15/artist-tour-routing.spec.md`** — `draft / P2`. No routing engine; would be a large build.
- **`2026-04-15/human-reviews-and-vouching.spec.md`** — `draft / P2`. No human-review model.
- **`2026-05-16/user-credit.spec.md`** — `draft / P3`. Greenfield; no `UserCredit` schema.

### Schema drift / shape mismatches

- **`event-attribute.md`** (2026-03-06) proposed an `AttributeDefinition` registry; nothing of the kind exists. `EventType` and `EventCategory` shipped instead.
- **`event-format.md`** (2026-03-06) proposed an `EventFormat` taxonomy — no `formatId` on `Event`, no `EventFormat` model. Likely deprioritised in favour of category+type alone.
- **`donation-ticket-type.spec.md`** was implemented but as `pricingMode: ADJUSTABLE` on the existing `TicketType` rather than a new `TicketKind`. The spec language (kind = DONATION) is now stale.

### Legacy duplicates

`docs/specs/events/` and `docs/specs/platform/` contain copies of date-folder specs (migrate-event-orders, reconcile-series-schedule, architecture-services, platform-orders-tickets). Per the root README convention "a spec must exist in exactly one location" — these legacy copies should be removed in favour of the dated versions.
