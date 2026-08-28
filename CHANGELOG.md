# Changelog

All notable changes to Ithas Fire will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While Ithas Fire is pre-1.0:
- `MINOR` (0.x.0) — new features, batched releases
- `PATCH` (0.0.x) — fixes only / hotfixes

## [Unreleased]

## [0.3.0] — 2026-05-29

### Added

**Payments, Disputes & Legal**
- Dispute lifecycle with intake, payee ledger, and payout holds (1a2a0e44)
- AcceptanceRecord ledger with chargeback-terms dual-write + launch legal gates (aafe5420, f8595716)
- Stripe Connect onboarding for individual (human) sellers (04e58a3b)
- Resale review-claim refund failures now surfaced instead of silent approval (3c3a5583)

**Email & SMS Deliverability**
- Resend deliverability remediation + webhook secret wiring (f94068e2, aeac720d)
- Bounce-storm circuit breaker, unverified-skip, and GDPR anonymize (4d6c084d)
- Phone-level SMS opt-out ledger + reminder deliverability guard (dec028f4)
- SMS opt-in disclosures across Terms/Privacy/phone flow + account-settings verification UI (a78ca2fd, b7f8b150)

**Auth & Identity**
- Simplified 2FA onboarding — backup-codes screen dropped, opt-in regen (cea2d229)
- AuthTwoFactor.verified column for Better Auth twoFactor (cd6e21a1)
- Auto-login after email verification + onboarding stepper on /sign-up (6efab19d)

**Scanner & POS**
- Resilient scan queue with loopback-API guard (2096d4f2)
- Flattened sign-in — magic-link dropped, username supported (4116976d)

**Events, Reviews & Platform**
- Standalone place review form with attribution (3d6fcd9e)
- Admin can delete platform categories; "other" catch-all + auto-bootstrap taxonomy on dev deploy (e953de76, 6970df21, fb6dfcfa)
- Gated event checkout access hardened (0f7890e5)

**Observability**
- Sentry pinoIntegration so logger.error reaches Sentry (8e80a7e3)
- Crawler traffic dropped from Sentry via isbot (8e5e150d)
- KnownError preservation through asKnownError + adapter cause via fail() (1e8350bc, 5217ed46)

### Fixed
- Stripe Elements options frozen so click-Pay no longer wipes the card (ceb5462c)
- Buyer copy: "(organizer pays)" replaced with "Included" (30d199e7)
- Settlement raw SQL hardened against Neon search_path drift (94b04fde)
- Settlement Batch CRASHED alert enriched with cause + log link (de5d6bed)
- Discord alerts tagged with originating environment (a9b541f0)
- Reset-password email CTA switched to brand blue + hardened link color (1c78314c)
- Feature-gate slug enums aligned with canonical schema (de62c3cd)
- Cloud Run startup probe budget bumped 50s → 150s (8b44c38f)
- Launch UI polish: event links, autocomplete dropdown, "View Details" anchor (b9222e34, abb8d689, abe8e2d9)
- jobs + web typecheck unbroken; .well-known route files in tsconfig (723e47b8, 5fe278aa)

### Infrastructure
- Neon collapsed to a single business-org API key; stale projects state-rm'd (329a2591, 44fd5aa1)
- Terraform: migrate_db folded into terraform-apply; dead workflows pruned; SENTRY_DSN wired to api + web (2b23bb7c, ff7d8ad7)
- R2/storage: per-env token split; shared media bucket rename jobs_s3 → storage_s3 (ab054d6a, 866b9e18)
- Pre-provisioned REDIS_URL wired through Secret Manager (79335c5b)
- Prod redeploy workflow + bootstrap ordering fix (40d9a218)

### Changed (Internal)
- Collapsed three Discord-alert files into one adapter (~70 LOC) (47de5beb)
- Consolidated currency formatting in @th/core/lib/currency-utils (~75 LOC) (ed855f21)
- Deleted ~530 LOC of dead code: stalled secrets port, alias shims, unused wrappers (e095a3bf)
- Split checkout flow into separate components (415f4cbd)

### Breaking Changes
- **EventType sub-category taxonomy removed** in favor of multi-tag genres — consumers reading event sub-categories must migrate to the tag-based shape (5ec64972)
- **Scanner sign-in**: magic-link removed; scanner users sign in with username/password (4116976d)

### Migrations
Requires running 11 Prisma migrations: dispute intake, payee ledger, chargeback-terms acceptance, host attestation, promo isPublic, two-factor verified, drop event types, place-review attribution, email delivery state, acceptance records, SMS consent.

## [0.2.0] — 2026-05-15

### Added

**Scanner & POS**
- Sign-up flow directly from the scanner with role-aware invites (b9c4aa60, 20cbed8f)
- Animated Embers splash with native handoff (5bd91d70)
- Native error toasts via burnt (7d49f3f0)
- Runtime API override + arm64-only release with APK size cuts (e66837ed)
- POS auto-assigns reserved seats (234f2bba)
- POS tap-to-pay flow improvements (3f420a1a)
- Event selector exposed across scanner tabs (c1b4b3a5)
- Server-supplied platform Terminal Location for POS (609c8bdb)
- Rate-limited onboarding email, 20/h per actor·org (dfc3a973)
- Swiss tile install blocks + tighter onboarding RBAC (7d5ed870)

**Events & Categories**
- Delete draft events (85700ee6)
- Density pass + waivers feature gate + real date inputs (b9c4aa60)
- Audio events: sourceUrl plumbing + responsive layout + bubble menu (5de35098)
- Taxonomy request review flow for categories (f2489445)
- Incremental search indexing on publish + browseable /search (64450d5c)

**Search**
- Postgres multi-index search backend (default in cloud) (2b010f6e, 88d4087a)
- Unified search UX overhaul + transcoder in `human:dev` (bb0d4b0b)

**Auth & Email**
- Email verification via OTP codes (aa44e889)
- Hosted ticket QR images served from email (885939ae)

**Volunteers**
- Shift reminders, hours tracking, and SMS opt-in (be2c7b3b)

**Payouts & Settlements**
- Per-event PayoutTerms snapshots — org edits no longer retro-change in-flight events (4b5eeb68)
- Atomic claim+release for settlement run-batch + recovery sweep (6ab8aa7b)

**Admin & UI**
- Improved promo form ergonomics (e7a78235)
- Hoisted Embers loader into `@th/ui` for cross-app use (7f1de42f)

### Fixed

**Web**
- Resolved navbar hydration mismatch (b2da9c4b)
- Reduced noisy query error reporting (1cb10d0f)
- Allowed public embed framing (2fa1ae29)
- Polished navigation states, public listings, table controls (637458f2, 7d75114c, 2e22d27f)
- Added `'use client'` to 29 hook-using leaf files (f4b93079)

**Checkout / Embed**
- Adjustable ticket amounts initialized correctly in embed (564f447d)
- Embed payments iframe-safe (e7c70c1e)
- Stripe deferred-mode lifecycle + tax + timer fixes (445b56aa)

**Events**
- Fallback seat rendering repaired across all three layout canvases (bc9765b5)
- Splits 0–100% per line, fee-mode toggle on drafts (bfe6f43c)
- Wired `EventsRepo.unpublish` + `.delete` (cf844d44)
- Reviewer follow-ups: RequiredFrame a11y + waivers tests (146b9cb8)

**Scanner**
- Fetch failures + Sentry breadcrumbs instrumented (070cd12c)
- Sign-up flow reviewer fixes (355afe8a)
- Preview EAS profile points at dev infra (6ece927f)

**Comms / Email**
- NotificationAction shape + Date coercion in shift reminders (369777f0)
- Missing `surfaceMuted`/`warningBg` tokens (ca6e6643)
- `brandAccent` → `accent` on VolunteerShiftReminder (3cf6a712)

**Admin**
- Embed and media editing polished (e94b6b65)
- Event management workflows polished (4b52653e)

**Infra / CI**
- AWS provider works without creds when `enable_aws=false` (9e383897)
- `DATABASE_URL` sourced from Secret Manager (3f8d3999)
- Audio-transcoder Cloud Run env wiring (14a4e238, 942afa92)
- IAM-vs-Cloud-Run race fix on `secret_key_ref` rollout (23135f79)

### Infrastructure

- Dropped Depot, switched to `docker buildx` with registry cache (fbb5376f)
- Sensitive env moved to Secret Manager + SES torn down (38ed109f)
- Default `enable_aws=false`, code path kept re-enableable (037bfce2)
- Terraform provider caching + retry on transient registry failures (c0f4b936)
- Turbo: `.next/cache` excluded from build outputs (e284be00)
- Docker install-layer cacheability restored across api/jobs/audio-transcoder (00041b87)
- Quality gate skipped on infra-only pushes + pnpm store cached (55f7d752)

### Database Migrations

This release requires the following Prisma migrations (run `prisma migrate deploy`):

- `20260501160000_add_public_entity_page_announcements`
- `20260502010000_add_consent_record`
- `20260502020000_add_passkey_table`
- `20260502030000_drop_payout_terms_basis`
- `20260503030000_drop_settlement_stripe_transfer_unique`
- `20260503180000_add_passkey_aaguid`
- `20260511120000_add_event_category_requests`
- `20260511200000_volunteer_reminders_and_hours`
- `20260512_search_documents`
- `20260513120000_job_run_tracker_postgres`
- `20260514000000_add_order_dispute_prevention_fields`
