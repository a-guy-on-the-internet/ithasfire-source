# Scanner Distribution — Decision Memo

> **Decided (owner, 2026-10-08):** the web scanner has shipped; the native scanner ships through TestFlight Internal and Play Internal. Owner, verbatim: "We have a web scanner. We need to fiinish testflight and play internal". The memo below is the 2026-08-04 analysis that led there.

Date: 2026-08-04
Status: DECIDED 2026-10-08 (was: DRAFT — awaiting user decisions)
Prompt: "Scanner Setup: iOS/Android app needs to be configured or at least an
email needs to be set up instead."

---

## TL;DR

Far more of both paths exists than the framing suggests. The web already has a
working browser scan page (`/admin/[slug]/scan`), the API already has the
magic-link plugin and a scanner-onboarding email, the admin already has a
"Scanner Setup" page with install tiles and a send-onboarding-email card, and
`eas.json` already carries a complete store-submission config (App Store
Connect app id `6784035261`, team `FJG7F43395`, Play internal track).

What is actually broken/missing:

1. **The org-invitation email links to a dead URL.** `invite-member.ts` builds
   `/invitations/accept?token=…` but the only page is `/invite/accept` — every
   emailed team/scanner invite 404s. This is the front door for BOTH options.
2. **No install URLs are configured.** `SCANNER_APP_IOS_URL` /
   `SCANNER_APP_ANDROID_URL` (and the `NEXT_PUBLIC_` twins) are unset
   everywhere, so the Scanner Setup page's install tiles render "Not
   configured" and onboarding emails hide the download buttons — because no
   store/TestFlight/Play link exists yet.
3. **The scanner app's magic-link entry UI was removed** (server + deep-link
   consumer still work), while the recovery docs still tell operators to use
   it.
4. **iPhone browsers can't auto-detect QR** on the web scan page (BarcodeDetector
   only; no JS fallback decoder) — camera mode degrades to name lookup on iOS
   Safari.

**Recommendation (short): ship Option B this week — it is mostly a bug-fix
away — and run Option A in parallel as the durable path, starting with
TestFlight Internal / Play Internal rather than public listings.**

---

## 1. Current state

### 1.1 Native scanner app (`apps/scanner`)

Complete, reviewed app: unified scan screen, offline event manifest, recent
scans, settings, people search.

- **Bundle ids / domain claims** — iOS `com.ithasfire.scan`
  (`apps/scanner/app.config.ts:110`), Android package `com.ithasfire.scan`
  (`app.config.ts:139`), iOS `associatedDomains:
  ["webcredentials:ithasfire.com"]` (`app.config.ts:131`), Android
  auto-verify intent filter for `ithasfire.com` (`app.config.ts:150-157`).
  Web side matches: `apps/web/public/.well-known/apple-app-site-association`
  claims `FJG7F43395.com.ithasfire.scan` under `webcredentials`, and
  `apps/web/public/.well-known/assetlinks.json` claims `com.ithasfire.scan`
  with two SHA-256 fingerprints. Cross-device passkey plumbing is in place.
- **Auth** — sign-in screen exposes **passkey (primary), password, and
  Google/Apple OAuth** (`apps/scanner/src/screens/sign-in-screen.tsx:75,282,320`).
  **Magic link is server-ready and the deep-link consumer still works**
  (`apps/scanner/src/features/auth/better-auth-client.ts:19-30`,
  `use-scanner-session.ts:405-408`), but the UI affordance to *request* one
  was removed as unreachable dead code — see the note at
  `apps/scanner/src/scanner-app.tsx:134-140` ("that screen has no magic-link
  prop"). So today a fresh operator signs in with the password/passkey/OAuth
  identity they created when accepting their org invite on the web.
- **Offline pass handling** — `getScannerEventManifest`
  (`packages/core/src/use-cases/scanner/get-scanner-event-manifest.ts:67-72`)
  is gated by `requireScannerAccessOnOrg` + `ORG_SCAN_ROLES` and feeds the
  on-device SQLite cache; ticket codes are bearer credentials held in
  SecureStore/SQLite and purged on sign-out
  (`use-scanner-session.ts` sign-out path). This is the capability a browser
  cannot safely replicate (see §3.4).
- **EAS config** (`apps/scanner/eas.json`):
  - `development` / `preview` / `production` build profiles. **The `preview`
    profile bakes `http://localhost:3001` as the API base URL**
    (`eas.json:30-32`) — preview builds are adb-reverse dev artifacts and can
    NOT be handed to real door staff as-is.
  - `production` profile: store distribution, auto-increment, prod URLs
    (`eas.json:42-60`).
  - **`submit.production` is fully filled in**: iOS `ascAppId: "6784035261"`,
    `appleTeamId: "FJG7F43395"`; Android internal track, draft release, service
    account at `../../.secrets/play-service-account.json` (`eas.json:62-74`).
    An App Store Connect record on the business team therefore already exists.
    **The `.secrets/` directory does not exist locally** — the Play service
    account key has never been provisioned on this machine.
- **Deployment strategy already decided** in
  `docs/specs/2026-04-26/completed/scanner-deployment-tap-to-pay.spec.yaml`:
  v1.0 ships with `EXPO_TAP_TO_PAY_TIER=none` (no Tap-to-Pay entitlement →
  no Apple entitlement review gate, lines 280-286), **Unlisted App Store
  distribution** decided at line 604, Play Internal Testing in parallel
  (line 590). Sequencing shows "Create App ID + ASC record" DONE and
  "Production build via EAS, smoke on TestFlight Internal" as the next
  agent+human step (lines 449-456). The companion field-by-field console
  cheat-sheet is `docs/runbooks/app-store-connect-metadata.md` —
  note it predates the team migration and cites the burned app id
  `6763976651` / `com.ithasfire.scanner`; the values to use now are the ones
  in `eas.json` (`6784035261` / `com.ithasfire.scan`).
- Production builds need the `SENTRY_AUTH_TOKEN` EAS secret (plugin only
  registers for `appEnv === "production"`, `app.config.ts:257-268`).

### 1.2 Onboarding / invite machinery (already built)

- **Org invites carry a SCANNER role** (`packages/db/prisma/enums.prisma:69`),
  and `inviteMember`
  (`packages/core/src/use-cases/orgs/invite-member.ts`) sends an email that
  special-cases scanner invites — the `OrgInvitation` template renders App
  Store / Play install tiles when `role === "scanner"` and the app URLs are
  configured (`packages/ui-email/src/templates/OrgInvitation.tsx:24,121`).
- **BUG — dead accept link.** `invite-member.ts:214` builds
  `${publicAppUrl}/invitations/accept?token=…`, but the accept page lives at
  `apps/web/src/app/invite/accept/page.tsx` and there is no
  rewrite/redirect for `/invitations/*` (`apps/web/next.config.ts:521-546`
  has only apple-touch-icon and `/trpc` rewrites; nothing in
  `apps/web/src/middleware.ts`). The email registry example even encodes the
  wrong URL (`packages/ui-email/src/templates/registry.ts:748`). Every
  emailed invite 404s. `[REASONED]` from reading routes/config — confirm
  with one click in dev, then fix (one line + registry example).
- **Scanner onboarding email exists**:
  `sendScannerOnboardingEmail`
  (`packages/core/src/use-cases/scanner/send-scanner-onboarding-email.ts`) —
  actor must be org OWNER/ADMIN, recipient must already hold SCANNER+ on the
  org (so it can't be abused as arbitrary mail fan-out). It sends install
  links + sign-in instructions; it deliberately grants nothing. Mounted at
  `trpc.scanner.sendOnboardingEmail`
  (`packages/transport/trpc/src/routers/scanner.ts:11-14`,
  `router.ts:118`).
- **Admin "Scanner Setup" page exists** at `/admin/[slug]/scanner-setup`
  (nav entry gated to `ORG_ADMIN_ROLES`,
  `apps/web/src/app/admin/[slug]/_components/admin-nav-sections.tsx:164-169`)
  with install tiles + QR frames, a send-onboarding-email card, a personal
  scanner card, and a recovery-help card. Install URLs come from
  `NEXT_PUBLIC_SCANNER_APP_IOS_URL` / `NEXT_PUBLIC_SCANNER_APP_ANDROID_URL`
  and the release-channel label from `NEXT_PUBLIC_SCANNER_RELEASE_CHANNEL`
  (defaults to "pilot")
  (`.../scanner-setup/_components/scanner-setup-shared.ts:11-27`). **None of
  these are set in any env/tfvars**, so tiles render disabled with "Not
  configured" (`InstallPathsCard.tsx:84,128-129`). NEXT_PUBLIC vars are baked
  at web build time — setting them requires a web rebuild, not a redeploy.
- **Magic-link server plugin is live**: `magicLink({ expiresIn: 15min })` in
  `apps/api/src/auth/better-auth.ts:1014`, and the email copy is already
  scanner-branded ("Sign in to {product} scanner. Open this link on the same
  phone where the scanner app is installed").
- **Doc drift**: `RecoveryHelpCard.tsx` tells operators to "tap Resend on the
  sign-in screen" for a missing magic-link email — that UI no longer exists
  (§1.1). It also already tells staff to "Use the web fallback" when a device
  can't recover, confirming web scan is an intended surface.

### 1.3 Web scanning (already built)

`/admin/[slug]/scan` (`apps/web/src/app/admin/[slug]/scan/page.tsx`):

- Two modes: **Look Up** (debounced name/email search →
  `tickets.searchOrgTickets` → confirm → scan) and **Camera**
  (`getUserMedia` + native `BarcodeDetector`,
  `_components/use-browser-camera.ts:71-115`). **No JS fallback decoder** —
  on iOS Safari (no BarcodeDetector) the page renders the viewfinder but
  says "Automatic QR detection not supported… Use Look Up mode"
  (`page.tsx:910-912`). Android Chrome auto-detects fine.
- A **unified scan view** (tickets + volunteer check-in in one resolver,
  `scan.resolvePayload` / `scan.searchUnified`,
  `packages/transport/trpc/src/routers/scan.ts:96-180`) sits behind the
  `unifiedScanResolver` feature gate, default **off**
  (`packages/core/src/use-cases/features/get-feature-gates.ts:169`).
- **Auth requirements**: all scan procedures are `authedProcedure` (normal
  Better Auth session — cookie or bearer; no device binding), and the use
  cases enforce org RBAC:
  - `scanTicket` → `requireScannerAccessOnOrg` with `ORG_SCAN_ROLES`
    (`packages/core/src/use-cases/tickets/scan-ticket.ts:6,610`), where
    `ORG_SCAN_ROLES = OWNER | ADMIN | EDITOR | SCANNER`
    (`packages/core/src/lib/rbac.ts:38-44`); platform-staff ADMIN bypasses
    with an audit obligation (`rbac.ts:261-283`).
  - `searchOrgTickets` / `resolveScanPayload` → same role set
    (`search-org-tickets.ts:91`, `resolve-scan-payload.ts:39`).
- The nav's Door Crew group exposes the scan route to `ORG_SCAN_ROLES`
  (`admin-nav-sections.tsx:149-162`), so a SCANNER-role member who signs in
  on a phone browser lands one tap from scanning today.

### 1.4 What `VOLUNTEER_SCAN_TOKEN_SECRET` actually is

Not operator auth. It HMAC-signs the **volunteer badge QR** (human+event
scoped tokens minted by `mintVolunteerScanToken`,
`packages/core/src/use-cases/volunteering/volunteer-scan-tokens.ts:90,186`;
short TTL 24h, print TTL ≤ 90 days). The unified resolver verifies these
server-side when an operator scans a volunteer's badge
(`resolve-scan-payload.ts:13-14`). It is optional in env
(`apps/api/src/lib/env.ts:289`); when unset the port throws a typed
`not_configured` (`routers/scan.ts:53-66`, wired in
`apps/api/src/lib/dep.ts:1132-1138`). Relevant only if the unified
(volunteer-aware) scan surface is enabled; irrelevant to plain ticket
scanning.

---

## 2. Option A — finish native app distribution

The build/submit rails are laid; what remains is credentials, console work,
and review latency. Steps in order:

### A1. iOS

| # | Step | Who | Effort |
|---|------|-----|--------|
| 1 | Verify the ASC app record `6784035261` (name, bundle `com.ithasfire.scan`) on team `FJG7F43395`; refresh metadata per `app-store-connect-metadata.md` (update the stale bundle/app-id values) | **User (console)** | 1-2 h |
| 2 | Provision EAS secrets: `SENTRY_AUTH_TOKEN` (required for prod builds) + confirm iOS distribution credentials on the business team | User + agent | 30 min |
| 3 | `eas build --profile production --platform ios` (tier=none → no Tap-to-Pay entitlement gate) | Agent-runnable | ~30 min queue |
| 4 | `eas submit --profile production --platform ios` → processing → **TestFlight Internal** smoke on a real device | Agent + user | same day |
| 5 | Distribution choice: (a) **TestFlight Internal** — instant, no review, but testers must be added to the ASC team (≤100, fine for a pilot); (b) **TestFlight External** — public invite link, needs one-time beta review (~1 day); (c) **App Store review → then request "Unlisted" distribution** (already the decided end-state, spec line 604) — full review, 24-48 h typical first pass, plus screenshots/privacy labels/demo account (the demo creds in the metadata doc are prod-real: verify they still work) | **User (console + review replies)** | 0.5-1 day active, 1-4 days wall clock |
| 6 | Set `SCANNER_APP_IOS_URL` (API env) + `NEXT_PUBLIC_SCANNER_APP_IOS_URL` and `NEXT_PUBLIC_SCANNER_RELEASE_CHANNEL` (web, **rebuild required**) to the TestFlight/App Store link | Agent | 30 min + deploy |

### A2. Android

| # | Step | Who | Effort |
|---|------|-----|--------|
| 1 | Play Console: confirm/create the app record for `com.ithasfire.scan`; generate the **service account key** expected at `.secrets/play-service-account.json` (missing today) | **User (console)** | 1 h |
| 2 | `eas build --profile production --platform android` (AAB) → `eas submit` (already configured: internal track, draft) | Agent | ~30 min |
| 3 | Internal testing track: add tester emails / link, promote from draft. (New Play accounts face the 20-testers/14-days rule only for **production**; internal/closed tracks are immediate.) | User | 30 min |
| 4 | Verify the EAS production keystore SHA-256 matches `assetlinks.json` (`cd apps/scanner && eas credentials -p android`) — per CLAUDE.md this must be re-checked whenever the keystore is touched | Agent | 15 min |
| 5 | Set `SCANNER_APP_ANDROID_URL` + `NEXT_PUBLIC_` twin, as A1.6 | Agent | (bundled) |

### A3. Both platforms, after links exist

- Fix the invite accept-URL bug (§1.2) — the scanner-role invite email is the
  intended distribution vehicle and it currently 404s.
- Optionally restore a "Email me a sign-in link" affordance on the scanner
  sign-in screen (server + deep link already work; the RecoveryHelpCard
  already documents it). Small, self-contained.
- If preview builds will ever be handed to non-dev testers, fix the `preview`
  profile's baked `localhost` URLs first (`eas.json:30-32`).

**Bottom line for A:** agent-side work is hours; the critical path is
user-console work (ASC/Play records, privacy labels, demo account, screenshots,
review replies) plus 1-4 days of Apple/Google latency. Nothing is blocked on
the Tap-to-Pay entitlement (v1.0 ships `tier=none` by design); Tap-to-Pay
approval on the Apple business account remains pending but only gates the
future v1.1 Sell feature, not distribution.

---

## 3. Option B — interim email → web scanning

### 3.1 Smallest viable version (mostly exists)

Flow: org admin adds door staff on the Team page with the **SCANNER** role →
invite email → staff accepts on their phone (`/invite/accept`), creating a
normal account (password/OAuth/passkey) → opens `/admin/[org]/scan` in the
phone browser → scans (Android Chrome camera) or name-lookup (any browser).

Work required:

| # | Task | Size |
|---|------|------|
| 1 | **Fix the invite accept URL** (`invite-member.ts:214` → `/invite/accept`; also registry example) + drive the flow once in dev | XS |
| 2 | **Add a JS QR-decode fallback** (jsQR or zxing-wasm on a canvas loop) in `use-browser-camera.ts` so iOS Safari gets camera scanning, not just lookup | S (half-day incl. 320px + live QA) |
| 3 | Fix RecoveryHelpCard copy drift (magic-link "Resend" doesn't exist) | XS |
| 4 | Optional: enable `unifiedScanResolver` + set `VOLUNTEER_SCAN_TOKEN_SECRET` in prod if volunteer badge check-in from the browser is wanted | XS (env/flag) |
| 5 | Optional: a `/scan` shortcut/redirect or home-screen-PWA guidance on the Scanner Setup page so staff aren't navigating the admin shell | S |

No new server surface is needed: `tickets.scanTicket`,
`tickets.searchOrgTickets`, and `scan.resolvePayload` already carry the right
RBAC (§1.3).

### 3.2 An "email a scan link" variant (NOT recommended as v1)

A tokenized "scan for this event" magic link for **anonymous, non-member**
door staff would be new core/transport work: a new event-scoped scan-token
port + procedures that bypass `requireScannerAccessOnOrg`. Downsides: the
link becomes a forwardable bearer capability to accept/reject tickets, scans
lose an attributable actor identity (`scanTicket` requires `actorHumanId`
today), and it duplicates RBAC we already have. Only worth building if the
user decides door staff must not be org members (decision 3 below).

### 3.3 Security constraints for browser scanning

- **Session, not device.** Web scanning rides a full Better Auth session with
  the member's SCANNER role — no device binding. Mitigations: SCANNER is
  already the org's least-privileged operational role; staff should sign out
  on shared devices; revocation = remove the membership on the Team page.
- **Scoping**: SCANNER grants scan + org-ticket search (attendee names,
  emails, seat labels — `searchOrgTickets` output) across all the org's
  events, not just tonight's. Acceptable for trusted staff; a per-event
  scoping would be new work.
- **Why NOT offline passes on web**: the native app's offline mode caches
  ticket codes — bearer credentials — in SecureStore/SQLite with a
  guaranteed purge on sign-out. A browser has no equivalent (localStorage/IDB
  are XSS-readable, no secure enclave, no reliable purge), so the web surface
  must stay online-only and fail closed when connectivity drops. This is the
  principal capability gap vs the native app and the reason B is "interim",
  not the end state.

### 3.4 Gaps that remain even after B ships

No offline queue (venues with bad connectivity), no haptics/hardware scan UX,
iOS camera path depends on the JS-decoder fallback's performance, and
passkey-first operator auth is weaker in a shared-browser context.

---

## 4. Recommendation

**Primary: Option B, immediately.** It is one bug-fix (invite accept URL),
one small enhancement (iOS QR fallback), and one copy fix away from being a
complete "email → sign in → scan in the browser" flow — everything else
(SCANNER role, invite emails, scan page, RBAC'd procedures, Scanner Setup
admin page) is already built and reviewed. It has no external gatekeepers and
directly answers "at least an email needs to be set up instead".

**Parallel, not fallback: Option A.** Start the store machinery the same week
— it is mostly console work + review latency, and the moment a
TestFlight/Play-internal link exists, setting the four `SCANNER_APP_*` /
`NEXT_PUBLIC_SCANNER_APP_*` envs lights up the already-built install tiles
and onboarding-email buttons with zero code changes. Sequence: TestFlight
Internal + Play Internal first (days), Unlisted App Store listing after
(already the decided end-state). Native remains the destination because
offline scanning cannot be replicated in a browser (§3.3).

The invite accept-URL fix is a prerequisite for both options and should be
committed first regardless of the decision.

---

## 5. Decisions only the user can make

1. **Apple console work & timing** — verify/complete the ASC record
   `6784035261`, privacy labels, screenshots, demo account, and submit; only
   the account holder can do this. Also: TestFlight Internal (testers join
   the ASC team) vs External link vs straight to Unlisted review — pick the
   first rung.
2. **Google Play account + service account key** — does a Play Console
   account for the business exist, and will you provision
   `.secrets/play-service-account.json`? Internal vs closed testing track.
3. **Door-staff identity model** — org members with SCANNER role (current
   model; recommended) vs anonymous per-event scan-token links (new build,
   §3.2). This decides whether any new auth surface is needed at all.
4. **Install links & channel label** — which URLs go into
   `SCANNER_APP_IOS_URL` / `SCANNER_APP_ANDROID_URL` (+ `NEXT_PUBLIC_` twins)
   and whether the Scanner Setup page shows "Pilot" / "Preview" /
   "Production" (`NEXT_PUBLIC_SCANNER_RELEASE_CHANNEL`); requires a web
   rebuild to take effect.
5. **Store listing copy** — Unlisted still requires name/subtitle/keywords/
   screenshots; the 2026-04-26 cheat-sheet drafts them but they're yours to
   sign off (and the demo-account credentials in it should be rotated or
   verified before pasting into App Review).
6. **Volunteer check-in from the browser** — enable `unifiedScanResolver` +
   set `VOLUNTEER_SCAN_TOKEN_SECRET` in prod, or keep web scanning
   tickets-only for now.
7. **Restore the scanner app's magic-link sign-in entry** — the docs and
   onboarding email assume it; small build, but it's a product-surface choice.
