# Spec Library Audit — 2026-06-09

Read-only audit of every **active** spec under `docs/specs/` (i.e. not already in a
`completed/` subdir) against the actual codebase on `main`. Supersedes
[`AUDIT-2026-05-16.md`](2026-05-16-spec-audit.md). Classifications are quick
code-presence checks (Prisma models, use-case dirs, routers, web/scanner pages,
migrations); they do not exhaustively verify functional parity.

## Summary

| Classification | Count |
| --- | ---: |
| BUILT | 72 |
| PARTIAL | 26 |
| NOT_BUILT | 46 |
| OBSOLETE | 18 |
| UNCLEAR (reference / pattern / living docs) | 15 |
| **Total active specs audited** | **177** |

**Cleanup already applied in this pass:**

- Deleted the three legacy namespaced folders `events/`, `platform/`, `transport/`
  — every file was byte-identical or differed only by a stale `status:` line vs its
  dated counterpart (violated the "exactly one location" rule).
- Deleted three stray root duplicates in `2026-05-14/` (`dispute-handling`,
  `dispute-prevention-quick-wins`, `host-attestation`) that were byte-identical to
  the canonical copies already in `2026-05-14/completed/`.
- Fixed two now-dangling references in `docs/README.md` and `docs/prompts/core.md`
  (the latter already pointed at a non-existent path).

`Move?` column = **YES** marks a BUILT spec that should be relocated into its date
folder's `completed/` subdir (with its `status:` flipped to `complete`).

---

## 2025-10-26 → 2025-12-14

| Spec | Reality | Move? | Evidence |
| --- | --- | --- | --- |
| 2025-10-26/checkout-panel.component.yaml | BUILT | YES | `packages/ui/.../components/CheckoutPanel.tsx` |
| 2025-10-26/test-hooks.pattern.yaml | UNCLEAR | no | Convention doc; `testIdBase` used across `@th/ui` |
| 2025-10-30/ui.pattern.md | UNCLEAR | no | UI folder-structure map (self-described WIP) |
| 2025-11-04/animation.spec.yaml | BUILT | YES | reanimated + skia deps wired in web/ui/mobile |
| 2025-11-04/comms.spec.createAnnouncementDraft.yaml | OBSOLETE | no | No DRAFT lifecycle; shipped as `announcements/send-announcement.ts` |
| 2025-11-04/comms.spec.previewAnnouncement.yaml | OBSOLETE | no | Shipped as `preview-audience-count.ts` + `send-test-announcement.ts` |
| 2025-11-04/comms.spec.scheduleAnnouncement.yaml | OBSOLETE | no | No `scheduledAt`/SCHEDULED status on `Announcement` |
| 2025-11-04/comms.spec.sendAnnouncementNow.yaml | OBSOLETE | no | Immediate-only `send-announcement.ts`; no DRAFT/SCHEDULED |
| 2025-11-04/event-templates.md | BUILT | YES | `EventTemplate` model + `use-cases/event-templates/` + router |
| 2025-12-14/architecture-services.md | UNCLEAR | no | Infra inventory reference doc |
| 2025-12-14/audit-log-compaction.spec.yaml | NOT_BUILT | no | `AuditLog` exists; no compaction job |
| 2025-12-14/cache-warmer.spec.yaml | NOT_BUILT | no | No cache-warmer job |
| 2025-12-14/event-search-autocomplete.spec.yaml | BUILT | no | `events.autocomplete` router + autocomplete UI (UX spec) |
| 2025-12-14/event-search-indexing.spec.yaml | PARTIAL | no | Meilisearch index jobs exist; no embedding pipeline |
| 2025-12-14/event-search-observability.spec.yaml | UNCLEAR | no | SLO/runbook doc |
| 2025-12-14/event-search-port.spec.yaml | BUILT | YES | `packages/ports/src/search/*.port.ts` |
| 2025-12-14/event-search.transport.yaml | BUILT | YES | `routers/events-search.ts` |
| 2025-12-14/events.spec.createHumanEvent.yaml | BUILT | YES | `use-cases/events/create-human-event.ts` (spec file itself empty) |
| 2025-12-14/humans-backfill.spec.yaml | NOT_BUILT | no | No backfill job |
| 2025-12-14/inventory-reconciliation.spec.yaml | NOT_BUILT | no | No inventory reconciler job |
| 2025-12-14/jobs-cloudflare-migration.spec.yaml | NOT_BUILT | no | Jobs run on KEDA/BullMQ; no CF Workers migration |
| 2025-12-14/jobs-queue-testing.spec.yaml | UNCLEAR | no | Testing-strategy doc |
| 2025-12-14/jobs-runbooks.spec.yaml | UNCLEAR | no | Runbook catalog doc |
| 2025-12-14/jobs-runtime-manifests.spec.yaml | PARTIAL | no | DI container + define-job exist; KEDA/Helm manifests not in repo |
| 2025-12-14/notification-digests.spec.yaml | PARTIAL | no | `send-attendee-feedback-digests.ts` exists; no scheduled digest job |
| 2025-12-14/organizers-backfill.spec.yaml | NOT_BUILT | no | No backfill job |
| 2025-12-14/payout-readiness.spec.yaml | NOT_BUILT | no | No payout-readiness job |
| 2025-12-14/place-layout-editor.flow.yaml | BUILT | no | `places/[placeId]/layout/` editor (UX flow spec) |
| 2025-12-14/place-layout-realtime.transport.yaml | BUILT | YES | `placeLayoutStreaming` wired in `routers/place-layouts.ts` |
| 2025-12-14/place-layout-view.component.yaml | BUILT | YES | `layout/_components/PlaceLayoutCanvas.tsx` |
| 2025-12-14/place-layouts.spec.deletePlaceLayout.yaml | BUILT | YES | `use-cases/place-layouts/delete-place-layout.ts` |
| 2025-12-14/place-layouts.spec.getPlaceLayout.yaml | BUILT | YES | `use-cases/place-layouts/get-place-layout.ts` |
| 2025-12-14/place-layouts.spec.replacePlaceLayout.yaml | BUILT | YES | `use-cases/place-layouts/replace-place-layout.ts` |
| 2025-12-14/places.spec.createPlaceWithSeatmap.yaml | OBSOLETE | no | No `Seatmap`; superseded by place-layouts |
| 2025-12-14/prod-deployment-readiness.spec.yaml | UNCLEAR | no | Pre-launch checklist |
| 2025-12-14/queue-ticket-issuance.spec.yaml | OBSOLETE | no | Issuance is synchronous (`finalize-from-payment-intent.ts`) |
| 2025-12-14/queue-transactional-email.spec.yaml | PARTIAL | no | Email send exists; no dedicated BullMQ worker |
| 2025-12-14/search-index-refresh.spec.yaml | OBSOLETE | no | Reindex job exists but Meilisearch, not Algolia/Elastic |
| 2025-12-14/seatmap-view.component.yaml | OBSOLETE | no | Superseded by `PlaceLayoutCanvas` |
| 2025-12-14/seatmaps-port.spec.yaml | OBSOLETE | no | Superseded by `ports/place-layouts` |
| 2025-12-14/seatmaps.spec.deleteSeatmap.yaml | OBSOLETE | no | Superseded by `place-layouts/delete-place-layout.ts` |
| 2025-12-14/seatmaps.spec.getSeatmap.yaml | OBSOLETE | no | Superseded by `place-layouts/get-place-layout.ts` |
| 2025-12-14/seatmaps.spec.replaceSeatmap.yaml | OBSOLETE | no | Superseded by `place-layouts/replace-place-layout.ts` |
| 2025-12-14/sitemap-generator.spec.yaml | BUILT | YES | `apps/jobs/src/jobs/sitemaps.ts` |
| 2025-12-14/sitemap-guardrail.spec.yaml | NOT_BUILT | no | No guardrail/validator job |
| 2025-12-14/sitemaps-architecture.spec.yaml | UNCLEAR | no | Architecture design doc |
| 2025-12-14/sitemaps-backfill.task.yaml | NOT_BUILT | no | No backfill/pruning tooling |
| 2025-12-14/sitemaps-generator.task.yaml | BUILT | no | Implemented by `sitemaps.ts` (task variant of the spec above) |
| 2025-12-14/sitemaps-observability.spec.yaml | UNCLEAR | no | Observability doc |
| 2025-12-14/sitemaps-scheduler.task.yaml | PARTIAL | no | Nightly cron exists; no delta/event-driven triggers |
| 2025-12-14/sitemaps-telemetry.task.yaml | UNCLEAR | no | Telemetry-hooks task; no distinct artifact |
| 2025-12-14/sitemaps-transport.task.yaml | OBSOLETE | no | Served from R2/CDN; no Fastify sitemap routes |
| 2025-12-14/ticket-components-localization.component.yaml | BUILT | no | `@th/locale` in CheckoutPanel + localization test (component spec) |
| 2025-12-14/ticket-email-localization.spec.yaml | BUILT | YES | `packages/ui-email` locale param + translator |
| 2025-12-14/ticket-mobile-localization.spec.yaml | NOT_BUILT | no | No i18n framework in mobile/scanner |
| 2025-12-14/tickets-localization-web.spec.yaml | BUILT | YES | `apps/web/src/i18n/messages/{en,es}.ts` |

## 2026-01-01 → 2026-03-03

| Spec | Reality | Move? | Evidence |
| --- | --- | --- | --- |
| 2026-01-01/event-builder.md | BUILT | YES | `Image` model; EventBuilder + EventPageRenderer |
| 2026-02-10/event-daily-stats.spec.yaml | BUILT | YES | `EventDailyStats` + `compute-event-daily-stats.ts` + `jobs/analytics.ts` |
| 2026-02-10/resale-price-snapshots.spec.yaml | BUILT | YES | `ResalePriceSnapshot` + `compute-resale-price-snapshots.ts` |
| 2026-02-10/sell-through-rollup.spec.yaml | BUILT | YES | `EventDailyStats.sellThroughRate` + `ticketTypeStats` |
| 2026-02-12/contact-list-import.spec.yaml | BUILT | YES | `import-contacts.ts` + `merge-contact-lists.ts` |
| 2026-02-19/pi-cleanup.spec.md | BUILT | YES | `cancelPaymentIntent` + `release-expired-carts.ts` |
| 2026-02-19/place-verification-review.spec.md | BUILT | YES | `PlaceVerificationRequest`/`Document` models + use cases |
| 2026-02-19/platform-commerce-admin.spec.md | BUILT | YES | `/platform/orders` + `/tickets` + active-carts tab |
| 2026-02-19/seo-automatic-enhancements.spec.yaml | PARTIAL | no | JSON-LD present; no `sitemap.ts` route expansion |
| 2026-02-23/email-editor-blocks.md | NOT_BUILT | no | Static template registry; no block composition |
| 2026-02-27/inbound-email-routing.md | NOT_BUILT | no | No inbound mail handler (doc = "Future consideration") |
| 2026-03-03/announcements.md | BUILT | YES | `Announcement` + use cases + admin page |
| 2026-03-03/audit-log-viewer.md | NOT_BUILT | no | Rows written; no viewer page/router |
| 2026-03-03/auto-collect-buyer-contacts.md | NOT_BUILT | no | No `autoCollect*` fields; not wired |
| 2026-03-03/deferred-capture.md | NOT_BUILT | no | Stripe adapter uses automatic capture (RFC) |
| 2026-03-03/event-builder-ticket-types.md | BUILT | YES | TicketTypeEditor / CompTicketsTab / HumanSearchCombobox |
| 2026-03-03/layout-image-detection.md | PARTIAL | no | Port exists; no adapter impl (detection still client-side) |
| 2026-03-03/location-system-redesign.md | BUILT | YES | maplibre dep + `LocationVisibility` enum + `addressRevealAt` |
| 2026-03-03/org-email-invitations.md | BUILT | YES | `OrgInvitation` + invite/accept/revoke |
| 2026-03-03/org-onboarding-wizard.md | NOT_BUILT | no | No `onboardingCompletedAt` / status use cases |
| 2026-03-03/org-settings.md | BUILT | YES | `update-org.ts` + `orgs.updateOrg` + settings page |
| 2026-03-03/small-feature-ideas.md | PARTIAL | no | `duplicate-event` built; other ideas mixed (backlog) |
| 2026-03-03/ticket-selection-and-checkout-redesign.md | BUILT | YES | `events/checkout/[...slug]` with SeatMapPicker, MobileCTABar |

## 2026-03-05 → 2026-03-06

| Spec | Reality | Move? | Evidence |
| --- | --- | --- | --- |
| 2026-03-05/agreements-booking-requests-payout-consolidation.md | PARTIAL | no | Models exist; no booking-request use case/router |
| 2026-03-05/checkout-feature-a-remove-mobile-sticky-bar.md | OBSOLETE | no | Bar reworked into `CheckoutMobileCTA.tsx`, not removed |
| 2026-03-05/checkout-feature-b-fee-tooltips-and-estimate-label.md | BUILT | YES | tooltip keys + `OrderSummary.tsx` title tooltip |
| 2026-03-05/checkout-feature-c-tax-estimation-after-billing-address.md | BUILT | YES | `estimate-checkout-tax.ts` + `admissionTaxRateBps` |
| 2026-03-05/checkout-feature-d-save-to-profile.md | BUILT | YES | `update-human-profile.ts` + `humans.updateProfile` + autoSaveProfile |
| 2026-03-06/admin-hub-navigation.flow.yaml | PARTIAL | no | `/admin` landing exists; no hub-summary tiles transport |
| 2026-03-06/checkout-improvements-index.md | UNCLEAR | no | Index doc for A–D |
| 2026-03-06/competitive-ux-features.md | PARTIAL | no | Tracking doc; #1 "Presented by" only i18n key, not wired |
| 2026-03-06/context-routing.spec.yaml | NOT_BUILT | no | No `ContextResolver`; routing is travel-time only |
| 2026-03-06/discovery-navigation.flow.yaml | NOT_BUILT | no | No `/discover`, `/categories`, `/saved` routes |
| 2026-03-06/discovery-surface-data.spec.yaml | UNCLEAR | no | Self-marked `status: deferred` |
| 2026-03-06/event-attribute.md | OBSOLETE | no | Self-marked obsolete; no `EventAttribute` model |
| 2026-03-06/event-card-skeleton.component.yaml | BUILT | no | `event-grid/EventCardSkeleton.tsx` |
| 2026-03-06/event-card.component.yaml | BUILT | no | `event-grid/EventCard.tsx` |
| 2026-03-06/event-carousel.component.yaml | NOT_BUILT | no | No `EventCarousel.tsx` |
| 2026-03-06/event-category.md | BUILT | YES | `Category` + `Event.categoryId` + categories use cases |
| 2026-03-06/event-format.md | OBSOLETE | no | Self-marked obsolete; no `EventFormat` |
| 2026-03-06/event-grid-filters.component.yaml | BUILT | no | `event-grid/EventGridFilters.tsx` |
| 2026-03-06/event-grid.component.yaml | BUILT | no | `event-grid/EventGrid.tsx` |
| 2026-03-06/event-series.md | BUILT | YES | `EventSeries`/`EventSeriesOccurrence` + `use-cases/series/` |
| 2026-03-06/event-slug.yaml | BUILT | YES | `Event.slug`/`shortId` + `EventSlugHistory` |
| 2026-03-06/event-sub-category.md | NOT_BUILT | no | No `EventType`/`typeId`; only single-level Category |
| 2026-03-06/item-level-settlements-and-resale.md | PARTIAL | no | Settlement half built; resale tracked separately |
| 2026-03-06/mobile-overlay.flow.yaml | NOT_BUILT | no | No discovery mobile overlay/bottom-tab nav |
| 2026-03-06/navigation-shell.component.yaml | BUILT | no | `packages/ui/.../shell/NavigationShell.tsx` |
| 2026-03-06/navigation-sitemap.transport.yaml | NOT_BUILT | no | No `navigation.getSections` router |
| 2026-03-06/payout-terms-claims-resale-controls.md | BUILT | YES | `PayoutTerms`/`PayoutTermsLine` + `Claim` + resale flags |
| 2026-03-06/platform-orders-tickets.spec.md | BUILT | YES | `/platform/orders` + `/tickets` pages |
| 2026-03-06/super-admin-control-room.spec.yaml | NOT_BUILT | no | `apps/hq` does not exist |
| 2026-03-06/venue-event-proposals.spec.md | NOT_BUILT | no | No place-confirmation/proposal model on Event |

## 2026-03-09 → 2026-04-05

| Spec | Reality | Move? | Evidence |
| --- | --- | --- | --- |
| 2026-03-09/site-builder.spec.md | BUILT | YES | `EntityPage`/`PageBlock`/`PageTheme` + `entity-pages/` + `/p/[slug]` |
| 2026-03-11/section-kind-unification.spec.yaml | NOT_BUILT | no | Still `SectionKind = "seat"\|"ga"\|"helper"` |
| 2026-03-15/per-edge-smoothing.spec.yaml | BUILT | YES | `edgeSmoothing` field in `designer/types.ts` + draw/reducer |
| 2026-03-15/unified-checkout.flow.yaml | NOT_BUILT | no | No shared `useCheckoutFlow`; web/embed still separate |
| 2026-03-17/touring-guide-valhalla.spec.yaml | PARTIAL | no | Valhalla adapter exists; no multi-stop touring UI |
| 2026-03-18/artist-earnings-dashboard.spec.yaml | NOT_BUILT | no | No human-scoped earnings router/page |
| 2026-03-18/artist-epk-book-me.spec.yaml | PARTIAL | no | Press/Rider blocks exist; no "Book Me" CTA/booking wiring |
| 2026-03-18/fan-follow-notify.spec.yaml | PARTIAL | no | `EntityFollow` + notify flags shipped; no notification job |
| 2026-03-19/backlog-sprint-2026-03.md | PARTIAL | no | Backlog index; mixed across 8 items |
| 2026-03-23/event-claim-verification.spec.md | NOT_BUILT | no | `claims.ts` is resale claims; no ScrapedEvent claim flow |
| 2026-03-23/event-list-card.component.yaml | PARTIAL | no | `EventListCard.tsx` exists; no scraped-source attribution |
| 2026-03-23/generic-form-builder.component.yaml | NOT_BUILT | no | Still `ApplicationFormBuilder`; no generic rename |
| 2026-03-23/hearth-scraper.spec.yaml | NOT_BUILT | no | No scraper job/SourceAdapter |
| 2026-03-23/scraped-events.schema.yaml | NOT_BUILT | no | No `ScrapedEvent` model |
| 2026-03-23/volunteering.spec.md | BUILT | YES | `volunteer.prisma` + `volunteering/` + 36-proc router + admin pages |
| 2026-03-25/waiver-system.spec.md | BUILT | YES | `waiver.prisma` + `waivers/` + router |
| 2026-04-05/announcement-preference-compliance.spec.md | NOT_BUILT | no | No pref check in send-announcement; no org-unsubscribe |
| 2026-04-05/place-review-decay-and-trends.spec.md | NOT_BUILT | no | Plain aggregation; no decay/trend fields |

## 2026-04-11 → 2026-04-28

| Spec | Reality | Move? | Evidence |
| --- | --- | --- | --- |
| 2026-04-11/web-app-refactor.task.yaml | PARTIAL | no | Living refactor backlog; phase-2 items pending |
| 2026-04-15/artist-tour-routing.spec.md | NOT_BUILT | no | No TourRequest/TourMatch/TourStop models |
| 2026-04-15/host-a-show-viral-prompt.spec.md | NOT_BUILT | no | No HOST_PROMPT enum; depends on unbuilt living-room |
| 2026-04-15/human-reviews-and-vouching.spec.md | NOT_BUILT | no | No HumanReview/Vouch models |
| 2026-04-15/living-room-mode.spec.md | OBSOLETE | no | Only ADJUSTABLE pricing shipped; no PlaceKind/FeaturePreset |
| 2026-04-16/terraform-environment-prefix-refactor.spec.md | BUILT | YES | `generated-jobs.tf` env-prefixes topics; workaround gone |
| 2026-04-18/ithasfire-launch-backlog.spec.md | UNCLEAR | no | Living master backlog |
| 2026-04-20/ftc-all-in-pricing.spec.yaml | BUILT | YES | `estimate-buyer-ticket-pricing.ts` + `buyer-display.ts` |
| 2026-04-20/lineup-human-search.spec.yaml | BUILT | YES | `HumanSearchCombobox.tsx` + profileSlug in list-event-humans |
| 2026-04-20/resale-markup-and-refunds.spec.yaml | BUILT | YES | resale markup fields + `unwind-resale-order-after-refund.ts` |
| 2026-04-24/event-detail-subnav.spec.yaml | OBSOLETE | no | `layout.tsx` only sets title; no EventTabNav |
| 2026-04-24/scanner-foundation.spec.yaml | BUILT | YES | `apps/scanner` shell + `use-cases/scanner` + `scanner.ts` router |
| 2026-04-24/scanner-operator-rollout.spec.yaml | PARTIAL | no | Setup page + recordBootstrap shipped; createScannerSetupLink not built |
| 2026-04-24/volunteer-badge-designer.spec.yaml | NOT_BUILT | no | No BadgeDesigner/badge-PDF |
| 2026-04-24/volunteer-scanner-check-in.spec.yaml | BUILT | YES | `volunteer-scan-tokens.ts` + scanner check-in screen + router procs |
| 2026-04-24/volunteer-shift-composer.spec.yaml | BUILT | YES | `InlineShiftComposer.tsx` + helpers |
| 2026-04-24/volunteer-shift-schedule-timeline.spec.yaml | NOT_BUILT | no | No schedule/timeline component |
| 2026-04-24/volunteer-wallet-pass-designer.spec.yaml | NOT_BUILT | no | No wallet-pass/PassDesigner |
| 2026-04-25/audio-player-v2.spec.md | BUILT | YES | waveformPeaks + WaveformDisplay/MiniStickyPlayer/SpeedBtn |
| 2026-04-25/scanner-pos-tap-to-pay.spec.yaml | BUILT | YES | `use-cases/pos/*` + `pos.ts` router + sell-screen |
| 2026-04-26/app-store-connect-metadata.md | UNCLEAR | no | Submission cheat-sheet |
| 2026-04-26/event-revenue-splits.spec.md | BUILT | YES | `get/update-event-splits.ts` + `confirm-payout-line.ts` + MERCH enum |
| 2026-04-26/places-admin-v2.spec.md | BUILT | YES | 9 use cases + IN_REVIEW/WITHDRAWN enum + `/platform/places` + PlaceDetailPanel |
| 2026-04-26/scanner-deployment-tap-to-pay.spec.yaml | BUILT | YES | `eas.json` + tap-to-pay tier system + capabilities |
| 2026-04-26/scanner-people-search.spec.yaml | BUILT | YES | manifest people[] + scanner people-search merge/local-db |
| 2026-04-27/home-discovery-consolidation.spec.md | PARTIAL | no | Edge cache shipped; no `getHomeDiscovery`/multiSearch |
| 2026-04-28/admin-tables-audit.spec.yaml | PARTIAL | no | PR-1 migrated (EventsManager); PRs 2–5 pending |
| 2026-04-28/entity-page-block-config.spec.yaml | BUILT | YES | `use-cases/entity-pages/block-config.ts` typed registry |
| 2026-04-28/entity-page-editor-actions.spec.yaml | NOT_BUILT | no | No reducer/undo/redo/autosave; components mutate directly |
| 2026-04-28/entity-page-editor-dynamic-fields.spec.yaml | NOT_BUILT | no | `fields` are static arrays; no resolver use case |
| 2026-04-28/entity-page-editor-permissions-viewport.spec.yaml | PARTIAL | no | Viewport switcher built; no editor-permissions model, no tablet/fluid |
| 2026-04-28/eventbuilder-role-gating.spec.md | PARTIAL | no | `canEditEvent` gating shipped; `listAdminAccessibleOrgs` not built |
| 2026-04-28/platform-roles-doc-correction.spec.md | BUILT | no | `docs/roles.md` matrix corrected (doc-only change) |

## 2026-04-29 → 2026-06-05

| Spec | Reality | Move? | Evidence |
| --- | --- | --- | --- |
| 2026-04-29/embeds-fit-and-discoverability.spec.md | PARTIAL | no | Design A sizing shipped; no lightbox/link-card/slash-menu |
| 2026-05-13/postgres-idempotency-and-job-tracker.spec.md | BUILT | YES | `JobRun`/`JobState` + `postgres-job-run-tracker.ts` + env flags |
| 2026-05-13/postgres-search-cutover-and-indexing.spec.yaml | BUILT | YES | `SEARCH_BACKEND` flag + `multi-index-postgres-adapter.ts` + `jobs/search.ts` |
| 2026-05-14/pos-attestation.spec.md | NOT_BUILT | no | No `scannerTermsAck*`, no acknowledge use case/modal |
| 2026-05-14/web-launch-checklist.spec.md | UNCLEAR | no | Living launch checklist |
| 2026-05-16/user-credit.spec.md | PARTIAL | no | Phase 1 only; Phases 2–4 unchecked (per spec checklist) |
| 2026-05-17/acceptance-records.spec.md | BUILT | YES | `AcceptanceRecord` + `acceptances.ts` adapter + `accept-chargeback-terms.ts` |
| 2026-05-18/resend-bounce-complaint-webhook.spec.md | PARTIAL | no | Phases 1–3 shipped (`routes/resend/webhook.ts` + `EmailDeliveryEvent` + mailer guard); phases 4–8 (admin UI/infra) deferred |
| 2026-05-18/sms-opt-out-sns.spec.yaml | BUILT | YES | `SmsConsent` + opt-in/out use cases + reminder gating |
| 2026-05-22/pg-dump-to-gcs.spec.md | NOT_BUILT | no | No pg-dump Cloud Run job / backup bucket in terraform |
| 2026-05-25/human-stripe-connect.spec.yaml | BUILT | YES | `humanId`/HUMAN branches in stripe-connect onboarding+status |
| 2026-05-25/place-review-form-component.spec.md | BUILT | YES | `_components/place-review/PlaceReviewForm.tsx` + `/review-a-place` page |
| 2026-05-29/series-date-switcher.spec.yaml | BUILT | YES | `list-public-series-dates.ts` + `SeriesTicketDatePicker.tsx` |
| 2026-05-29/venue-gift-balance.spec.md | NOT_BUILT | no | No `fundingSource`/`scope`/load use cases (Phase 0 gate unmet) |
| 2026-06-05/booking-request-and-agreement-editor.spec.yaml | NOT_BUILT | no | `BookingRequest` schema-only; no use cases/router |
| 2026-06-05/performer-mode.spec.yaml | NOT_BUILT | no | No `PerformerProfile` model / `isPerformer` predicate |
| 2026-06-05/venue-booking-toggle-and-block.spec.yaml | BUILT | YES | `Place.acceptsBookingRequests` + `set-place-booking-acceptance.ts` + RequestToPlayBlock |

---

## Key drift — built but still labeled draft/in-progress

The following are **fully BUILT but not yet moved to `completed/`** and most still carry a
`draft`/`in-progress`/no-status header. These are the move candidates (`Move? = YES` above):

- **2025-12-14 place-layouts cluster** — get/replace/delete use cases, realtime transport,
  view component, editor flow all shipped (seatmaps precursor specs in the same folder are
  now OBSOLETE).
- **2025-12-14 search + localization** — event-search port + transport, ticket-email and
  web localization all shipped.
- **2026-02-10 analytics** — event-daily-stats, resale-price-snapshots, sell-through-rollup.
- **2026-02-19** — pi-cleanup, place-verification-review, platform-commerce-admin.
- **2026-03-03 / 03-05 / 03-06** — announcements, location-system-redesign, org-* settings,
  checkout-redesign, checkout-features B/C/D, event taxonomy (category/series/slug),
  payout-terms-claims-resale, platform-orders-tickets.
- **2026-03-09 / 03-15 / 03-23 / 03-25** — site-builder, per-edge-smoothing, volunteering,
  waiver-system.
- **2026-04-20 → 04-28** — ftc-all-in-pricing, lineup-human-search, resale-markup-and-refunds,
  scanner foundation/check-in/composer/pos/deployment/people-search, audio-player-v2,
  event-revenue-splits, places-admin-v2, entity-page-block-config.
- **2026-05-13 → 06-05** — postgres idempotency + search cutover, acceptance-records,
  resend webhook, sms-opt-out, human-stripe-connect, place-review-form-component,
  series-date-switcher, venue-booking-toggle-and-block.

## OBSOLETE — superseded, candidates for archival/deletion

The 2025-12-14 **seatmaps** specs (port, get/replace/delete, view component, createPlaceWithSeatmap)
were fully superseded by the **place-layouts** rename — keeping them invites confusion. Other
self-marked-obsolete specs: `event-attribute`, `event-format`, `living-room-mode` (shipped as
ADJUSTABLE pricing), `event-detail-subnav`, `checkout-feature-a`, the announcement comms.spec.*
quartet (superseded by the shipped `announcements/` use cases), `queue-ticket-issuance`,
`search-index-refresh`, `sitemaps-transport.task`.

## Process recommendation

Status fields remain unreliable because they're updated by hand. Consider a consistent
frontmatter `status:` on every spec plus a script that regenerates this table from
code-presence checks on a cadence (the `error-tracker` skill already follows this pattern),
so the audit never goes stale by hand again.
