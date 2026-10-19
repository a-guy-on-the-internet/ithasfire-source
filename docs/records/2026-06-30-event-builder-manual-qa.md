# Event Builder — Manual QA Checklist

**Status:** draft — in progress
**Authored:** 2026-06-30
**Scope:** End-to-end manual verification of the organizer event-builder flow (create → fill → publish), focused on the publish-gate matrix, external integrations, and known unvalidated gaps. Automated coverage already exists in `apps/web/e2e/event-builder*.spec.ts`; this checklist targets what automation does **not** cover.

> Check each box as it passes. If an item fails, note the failure inline (`<!-- FAIL: ... -->`) and link a Forgejo issue. Move this file to `completed/` once every Tier‑1 + Tier‑2 box is green.

---

## 0. Prerequisites & environment

Run against **deployed dev** (`https://<dev-web-host>`) unless noted. Dev is minimally seeded — see [[reference_dev_checkout_test_setup]].

- [ ] Signed in as `admin@ithasfire.com` / `Dev-Login-2026!`.
- [x] A test **org with an ACTIVE, Stripe-connected payee** exists for paid-event tests — `dev-qa-collective` (org `77fcd446-…`) payee verified `ACTIVE`, charges+payouts enabled, → `acct_1TnV9VJrHuqu5NCJ` (verified 2026-06-30).
- [x] A second context with **no payee** (the personal `@admin` context) available for the "paid event blocked" negative tests.
- [ ] Mailpit / dev email sink reachable to confirm any publish-triggered emails (skip if N/A).

### 0.1 Stripe Connect setup via API (paid-event prerequisite)

Express can't be onboarded via API (hCaptcha); **Custom can**. The dev Stripe platform profile is already completed.

> **Already satisfied for dev (verified 2026-06-30):** `acct_1TnV9VJrHuqu5NCJ` exists (`charges_enabled`, `payouts_enabled`, `details_submitted`, type=custom) and the `dev-qa-collective` payee is wired to it. The steps below are the **recreate recipe** if a fresh account is ever needed.

- [x] Fetch platform key: `gcloud secrets versions access latest --secret=hf-dev-stripe-secret-key --project=hearthfire-491918`.
- [ ] `POST /v1/accounts` with `type=custom country=US business_type=company capabilities[card_payments][requested]=true capabilities[transfers][requested]=true` + company / tos / `external_account` (routing `110000000`, acct `000123456789`) / `business_profile[url]=https://ithasfire.com` (**not** `example.com` — rejected). _(skipped — existing account reused)_
- [ ] `POST /v1/accounts/{id}/persons` for a representative (`ssn_last_4=0000`, address line1 `address_full_match`). Wait ~seconds for `card_payments` → active ⇒ `charges_enabled=true`. _(skipped — existing account reused)_
- [x] Org payee wired in the dev DB (verified live): `Payee` for org `77fcd446-…` is `status=ACTIVE`, `stripeAccountId=acct_1TnV9VJrHuqu5NCJ`, `chargesEnabled=t`, `payoutsEnabled=t`.
- [ ] Confirm `stripeConnect.getStatus` returns `chargesEnabled && payoutsEnabled` for that org in the builder (no Connect warning banner).

Test card for any resulting checkout: `4242 4242 4242 4242`. Checkout requires sign-in (no guest checkout on dev).

---

## Tier 1 — Publish gate matrix (highest value)

Publishing runs ~13 gates in `packages/core/src/use-cases/events/publish-event.ts`. Each axis below is a distinct gate; the combinations are what manual testing must cover.

> **Automated backing (verified 2026-06-30):** `publish-event.test.ts` passes **38/38** — the original 30 plus **8 gate tests added 2026-06-30** to close the splits, resale, and category gaps (reviewed: APPROVED). Items tagged 🟢 have a dedicated unit test (low runtime risk — confirm once in the UI, don't belabor). Items tagged 🟡 are UI-only behavior with no unit equivalent — still a real manual check. Tags reference tests in `packages/core/src/use-cases/events/__tests__/publish-event.test.ts`.

### 1.1 Free vs paid + Stripe Connect

- [ ] 🟢 **Free event publishes** with no Stripe Connect configured (e.g. from the no-payee context). _(unit: L1575)_
- [ ] 🟡 **Paid event is BLOCKED** when the payee lacks `chargesEnabled`/`payoutsEnabled` — server side is unit-covered (L1423/L1541/L1556), but the **client warning banner** (`EventBuilder.tsx` ~L1679) is UI-only — confirm both (a) banner renders and (b) the `publishEvent` mutation rejects.
- [ ] 🟢 **Paid event publishes** once the payee is ACTIVE (Connect wired per §0.1). _(unit: L1511)_
- [ ] 🟢 On publish of a paid event, the **primary payout agreement auto-provisions** (`ensureDefaultPrimaryPayoutTerms`). _(unit: L1284/L1336)_

### 1.2 Location visibility & host attestation

- [ ] 🟢 Event with `locationMode=EXACT` publishes **without** attestation. _(unit: base publish, L989)_
- [ ] 🟢 Event with `locationMode=HIDDEN` is **BLOCKED** until all five host-attestation fields are accepted: legal right to host, zoning/noise, alcohol compliance, tax responsibility, organizer FAQ reviewed. _(unit: L1102/L1122/L1146)_
- [ ] 🟢 HIDDEN event with all attestation fields checked publishes; the `EventAttestation` record + audit log entry are written. Re-draft requires fresh attestation. _(unit: L1171)_
- [ ] 🟡 **Save location before publish** — confirm an unsaved location yields `EVENT_LOCATION_REQUIRED` (builder does not auto-persist location). UI-behavior; not unit-covered.

### 1.3 Chargeback terms

- [ ] 🟢 **Free event** auto-accepts chargeback terms (no prompt). _(unit: base)_
- [ ] 🟢 **Paid event** from an org that never accepted chargeback terms is **BLOCKED** until terms are accepted (org + direct-human paths). _(unit: L1494/L1520, accept path L1511)_

### 1.4 Ticket types

- [ ] 🟢 Publish **BLOCKED** with zero ticket types. _(unit: L1246)_
- [ ] 🟢 Publish **BLOCKED** when any ticket type has capacity `0`. _(unit: L1258)_
- [ ] 🟢 Publish succeeds with ≥1 ticket type, capacity > 0. _(unit: base)_

### 1.5 Splits (revenue allocation)

> 🟢 **Closed 2026-06-30:** splits gates now have dedicated tests (`usesNewSplitsFlow` requires a line with `requiresConfirmation: true`).

- [ ] 🟢 Splits that do **not** sum to 100% → publish **BLOCKED** (`splits_total_invalid`). _(unit: "rejects when splits do not reconcile to 100%")_
- [ ] 🟢 Splits at exactly 100% → publish succeeds. _(unit: "publishes when splits reconcile to exactly 100%")_
- [ ] 🟢 ±1% integer tolerance edge accepted (101% passes; 102% fails). _(unit: "publishes when splits reconcile within the ±1 tolerance (101%)")_
- [ ] 🟢 A split line whose payee has `payoutsEnabled=false` → publish **BLOCKED** (`payee_not_active`). _(unit: "rejects when a splits-line payee cannot receive payouts")_
- [ ] 🟢 A `DECLINED` split line is excluded from the percent sum (doesn't break a valid 100%). _(unit: "excludes DECLINED lines from the splits reconcile total")_

### 1.6 Resale

> 🟢 **Closed 2026-06-30:** resale-terms gate now has dedicated tests.

- [ ] 🟢 Ticket type with `resaleAllowed=true` and **no resale terms** → publish **BLOCKED** (`RESALE_TERMS_MISSING`). _(unit: "rejects resale-enabled ticket types without resale terms")_
- [ ] 🟢 Same with resale terms present → publish succeeds. _(unit: "publishes a resale-enabled ticket type when resale terms are set")_

### 1.7 Lifecycle guards

- [ ] 🟢 Only `DRAFT` events can be published (already-published / cancelled rejected). _(unit: L1220, idempotent replay L1081)_
- [ ] 🟢 Publish/republish **BLOCKED** once any ticket has been issued (no re-publish after first sale). _(unit: L1272)_
- [ ] 🟢 Location required — publish **BLOCKED** with no placeId/savedLocationId/addressText. _(unit: L1232)_
- [ ] 🟢 Category required — publish **BLOCKED** with no category set (`EVENT_CATEGORY_MISSING`). _(unit: "requires a category" — added 2026-06-30)_
- [ ] 🟡 Date validation — `endsAt` before/equal to `startsAt` rejected ("endsAt must be after startsAt"). Enforced at **save** (`save-event-shared.ts`), not publish — verify via the save path.

---

## Tier 2 — External integrations

### 2.1 Image upload (incl. HEIC) — ✅ VERIFIED via dev UI (2026-06-30)

- [x] **HEIC hero upload** → real `.heic` (HEIF/HEVC) uploaded; client converted to an `image/jpeg` blob **before** presign; R2 PUT object key was `…/images/<id>.jpeg` (not `.heic`) via `requestImageUpload` → PUT → `finalizeImageUpload`. Server never sees HEIC. ✅
- [ ] Upload an image **> 25 MB** → rejected client-side (`MAX_EVENT_IMAGE_BYTES`). _(not retested this pass)_
- [ ] **Body/embedded image** (stricter input: `jpeg/png/gif/webp`, no HEIC) — not retested this pass.

### 2.2 Audio upload + transcode — ✅ VERIFIED via dev UI (2026-06-30)

- [x] Upload audio in ProseEditor → R2 PUT carried `x-amz-checksum-sha256` (SHA-256 verification) → `finalizeAudioUpload` dispatched the transcode job.
- [x] `resolveAudio` flipped to **`status: READY`** with `durationSeconds: 3.02`, an `hlsPlaylistUrl` (`cdn-dev/…/audio.m3u8`), and computed `waveformPeaks`. Player rendered (3s). Full transcode pipeline works end-to-end. ✅

### 2.3 Tax stamping (US) — ⚠️ VERIFIED + BUG FOUND (2026-06-30)

**Adapter: PASS.** Ran the real `ziptax-adapter.ts` against the live API — correct rates (TX 8.25%, NYC 8.88%, LA 9.75%, Chicago 10.25%), 0 for no-sales-tax states (OR/NH/AK), and all null/edge paths (non-US, invalid zip, zip+4, case-insensitive country) behave.

**Integration: BUG.** Tax is only ever looked up in the `kind === "freeform"` **new-SavedLocation** branch (`save-event-shared.ts:629`). `resolveTaxRateForEvent` (`publish-event.ts:651`) resolves **only** from `event.savedLocationId`. Checkout reads `event.admissionTaxRateBps ?? 0` (`create-checkout.ts:420`, `update-order-items.ts:168`). Consequences:

- [x] 🔴 **Place/venue-based events collect $0 tax.** `Place` has no postal-code or tax column; place mode sets `placeId` not `savedLocationId`; no lookup ever runs. **Proven on dev:** 7/7 place events show tax only because **seed hardcodes it** (`seed/events.ts:167,410`, `tax_rate_source` blank). Only 2 events platform-wide have a real `source=ziptax` stamp — both saved-location mode.
- [x] 🟠 **Reused / directly-picked SavedLocations** aren't refreshed — lookup runs only on first freeform creation; selecting from "My Places" never fetches.
- [x] 🟡 **Rates never refresh** — cached once; `tax_rate_fetched_at` stored but no TTL.
- [x] ⚠️ **Seed masks the bug** — seeded events have correct-looking tax (`source` blank), so dev UI testing falsely passes. Trust only `source='ziptax'` rows.

→ **Fix scoped in [ziptax-tax-coverage-fix.spec.md](../specs/2026-06-30/completed/ziptax-tax-coverage-fix.spec.md).**

### 2.4 Seating (place-based events) — ✅ data-level VERIFIED; ⚠️ assignment UI not automatable

- [x] **Auto-materialization confirmed via real seed data** — 5 published place-based events have 2–3 `SeatSection`s each, `layout_section_id`/`place_layout_id`-linked to the place layout. Greek Theatre: Lower Bowl (cap 126 → **126 seats**), Upper Bowl (cap 84 → **84 seats**) — capacity matches materialized seat count.
- [x] **Ticket-type → section assignment confirmed at data level** — Greek Theatre's two ticket types (Lower Bowl $85, Upper Bowl $50) are both linked to seat sections; `Seat.price_override` column exists for per-seat overrides.
- [ ] ⚠️ **Assignment/override UI + checkout seat-selection NOT verified via MCP** — the layout designer is a **drag-canvas** (`PlaceLayoutCanvas`/`PlaceLayoutDesigner`), not drivable via the a11y-snapshot MCP, and the QA orgs have no Place to start from. Leave to the `apps/web/e2e` suite or a manual human pass. Platform-admin cannot open other orgs' builders (redirects to own dashboard).

---

## Tier 3 — Secondary flows

- [ ] **Org-owned** event create/save (`createEventForOrg`).
- [ ] **Human-owned** event create/save (`createEventForHuman`).
- [ ] **Recurrence/series**: build a series, then run schedule reconciliation; occurrences sync.
- [ ] **Password-gated** event: gate blocks unauthenticated access, password unlocks.
- [ ] **Application-form-gated** event: applicant submits, organizer sees the application.
- [ ] **Comp tickets** issued from the Comp tab.
- [ ] **Volunteers** tab: role setup + signup review.
- [ ] **Save Draft** persists each tab's state across a reload (no autosave — manual save only).

---

## Tier 4 — Known-gap probes (unvalidated; bugs likely)

These have **no publish-time guard** today. Probe each to decide whether a gate is needed.

- [ ] Publish an **application-gated event with an empty form** — does the guest application flow brick? (No completeness check exists.)
- [ ] Assign a ticket type to seat sections, then **remove/never-assign those sections** — does publish allow a ticket type pointing at nonexistent sections? (No layout-vs-ticket-type validation at publish.)
- [ ] Publish with coordinates `0,0` (or mid-ocean lat/lng) — accepted with no sanity check.
- [ ] Publish two events with an **identical title** — allowed (no uniqueness).
- [ ] Hero image with extreme aspect ratio / tiny dimensions — accepted (no dimension validation).

---

## Sign-off

- [ ] All Tier‑1 boxes green.
- [ ] All Tier‑2 boxes green.
- [ ] Tier‑3 reviewed (failures issue-tracked).
- [ ] Tier‑4 outcomes recorded; gaps either accepted or filed as issues.
- [ ] File moved to `docs/specs/completed/` (or this date folder's `completed/`).
