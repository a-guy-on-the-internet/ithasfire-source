# App Store Connect Metadata — Field-by-Field Cheat Sheet

Companion to `docs/specs/2026-04-26/completed/scanner-deployment-tap-to-pay.spec.yaml`.
Walks through every required field in App Store Connect for both apps so
you can fill them out without making editorial decisions on the fly.

Written 2026-04-26; ids, bundle ids, URLs and contact addresses checked
2026-10-09. The App Store Connect app ids and team come from
`submit.production.ios` in each app's `eas.json`, and the bundle ids from
`ios.bundleIdentifier` in `app.config.ts`; when they disagree with this page,
they win. Both apps live on team `FJG7F43395`. The earlier records,
`6763976651` (scanner) and `6763976673` (mobile), belonged to the retired
individual team `5J9DRDR2TB` and are burned.

The listing copy below (descriptions, review notes, privacy answers) is still
the 2026-04 v1.0 draft. Reread it against the build you submit before pasting.

---

## SCANNER — `Ithas Fire Scanner` (App ID `6784035261`)

### App Information

| Field | Value |
|---|---|
| Name | `Ithas Fire Scanner` |
| Subtitle | `Tickets at the door` (max 30 chars; reads well under the icon) |
| Bundle ID | `com.ithasfire.scan` |
| SKU | `ithasfire-scanner-001` |
| Primary Category | `Business` |
| Secondary Category | `Productivity` |
| Content Rights | "Does not contain, show, or access third-party content" |
| Age Rating | Complete questionnaire — answer NO to everything (no objectionable content, no user-generated content, no unrestricted web access). Result: **4+** |

### Pricing and Availability

| Field | Value |
|---|---|
| Price | Free |
| Availability | All countries/regions where Ithas Fire operates |
| App Distribution Methods | App Store + TestFlight |
| Distribution Type | Standard (will request "Unlisted App" after first approval — see below) |

### App Privacy (the nutrition label)

The structured "what data do we collect" questionnaire. For Ithas Fire Scanner:

**Data collected (LINKED to user identity, used for App Functionality):**
- Email Address — sign-in
- User ID — sign-in
- Phone Number — *only if the operator opts in for SMS receipts; default OFF*

**Data collected (NOT linked to user identity, used for Analytics):**
- Crash Data — Sentry
- Performance Data — Sentry
- Other Diagnostic Data — Sentry

**Tracking:** No (we do not link data to advertising networks)

### App Review Information

| Field | Value |
|---|---|
| Sign-in required | YES |
| Demo Account | A dedicated reviewer account in **prod**, with org access to an event it can scan. Enter its email and password in the console only, never in this repo. The store build calls `https://api.ithasfire.com` (`build.production.env` in `eas.json`), and the dev fixture admin in `apps/api/src/scripts/seed/ids.ts` is dev-only, so it can't sign in there. |
| Contact First Name | *(your first name)* |
| Contact Last Name | *(your last name)* |
| Contact Phone | *(your phone for App Review urgent contact)* |
| Contact Email | `support@ithasfire.com` (or your direct email) |
| Notes | (paste the block below) |

#### App Review Notes — paste this in:

```
Ithas Fire Scanner is the operator-facing companion to the Ithas Fire
ticketing platform. It is used by event staff to validate ticket QR codes
at the door and check in volunteers.

Sign in with the demo account above. After sign-in you will see a list
of demo events. Tap an event to enter the scan flow. Camera permission
is required to read QR codes.

The app does not contain consumer-facing flows, advertising, or
third-party content. Stripe Terminal SDK is included as a dependency
but Tap to Pay payment flows are NOT enabled in this build (feature
flag scanner.pos_tap_to_pay is OFF and Tap to Pay entitlements are
not declared in this binary). Card payment functionality will ship
in a follow-up release once we receive Apple's Tap to Pay publishing
entitlement; we will submit the demo video and entitlement reference
with that future submission.

For questions, contact support@ithasfire.com.
```

### Version Information (per submission)

| Field | Value |
|---|---|
| Description | (see below) |
| Keywords | `ithasfire,scanner,tickets,events,box-office,door,check-in` (irrelevant for unlisted; field-required) |
| Support URL | `https://ithasfire.com/help` |
| Marketing URL | `https://ithasfire.com` |
| Promotional Text | (optional; can leave blank for v1.0) |

#### Description — paste this in:

```
Ithas Fire Scanner is the operator companion to the Ithas Fire ticketing
platform. Validate ticket QR codes at the door, check in volunteers, and
keep the line moving.

— Scan tickets via QR code or manual ticket-code entry
— Check in volunteers with the same flow
— Works offline; syncs when reconnected
— Multi-event support for staff covering multiple shows
— Privacy-first: no tracking, no third-party advertising

This app is for event staff and box-office operators. If you're an
attendee looking to buy tickets, download the Ithas Fire app instead.
```

### After first approval — request Unlisted App distribution

App Store Connect → My Apps → Ithas Fire Scanner → App Information →
"Distribution Methods" → request **Unlisted App**. Apple grants this
in 1–2 business days. Once granted, only people with the direct App
Store URL can find your app.

---

## MOBILE — `Ithas Fire` (App ID `6784035633`)

### App Information

| Field | Value |
|---|---|
| Name | `Ithas Fire` (fallback if taken: `Ithas Fire Tickets`, then `Ithas Fire Events`) |
| Subtitle | `Live music, art, & community` (max 30 chars) |
| Bundle ID | `com.ithasfire.app` (the Android package is `com.ithasfire`) |
| SKU | `ithasfire-mobile-001` |
| Primary Category | `Entertainment` |
| Secondary Category | `Lifestyle` |
| Content Rights | "Does not contain, show, or access third-party content" |
| Age Rating | Walk through the questionnaire honestly. Events listed are 18+/21+/all-ages depending on the event. Most likely result: **17+** (because some events have age-gated alcohol or mature themes). |

### Pricing and Availability

| Field | Value |
|---|---|
| Price | Free |
| Availability | All countries where Ithas Fire operates |
| App Distribution Methods | App Store + TestFlight |
| Distribution Type | **Public** (this is the consumer flagship — not Unlisted) |

### App Privacy

**Data collected (LINKED to user identity, used for App Functionality):**
- Email Address
- Name
- User ID
- Phone Number — *if user provides for SMS ticket delivery*
- Payment Info — *processed by Stripe; we hold no card data ourselves*
- Purchase History — order/ticket records

**Data collected (LINKED to user identity, used for Personalisation):**
- Coarse Location — derived from IP for "events near you"
- *(if/when push notifications ship)* Device ID

**Data collected (NOT linked to user identity, used for Analytics):**
- Crash Data — Sentry
- Performance Data — Sentry
- Other Diagnostic Data — Sentry

**Tracking:** No

### App Review Information

| Field | Value |
|---|---|
| Sign-in required | YES |
| Demo Account | A dedicated reviewer account in **prod**, as for the scanner; the store build calls `https://api.ithasfire.com`. Enter its credentials in the console only. |
| Contact info | (same as scanner) |
| Notes | (paste the block below) |

#### App Review Notes — paste this in:

```
Ithas Fire is a consumer event-discovery and ticketing app. Users browse
local events, view venues and organisers, buy tickets, and access their
purchased tickets for at-gate scanning.

Sign in with the demo account above. The Discover tab shows real seeded
events across San Francisco, New York, Austin, and Chicago. Tap any event
for details. The Tickets, Profile, and Settings tabs are functional
placeholders — full ticket purchase and entity-page rendering ship in a
follow-up release; this initial build establishes the auth, navigation,
and discovery flows.

Stripe is the sole payment processor. We hold no card data — Stripe
Payment Sheet handles all card capture client-side and tokenisation
server-side via Stripe's PCI-compliant infrastructure.

The app does not contain advertising, in-app purchases for digital
content (only physical event tickets), or third-party tracking.

For questions, contact support@ithasfire.com.
```

### Version Information (v1.0)

| Field | Value |
|---|---|
| Keywords | `events,tickets,concerts,nightlife,local,music,art,community,box-office,box office` (100 char limit) |
| Support URL | `https://ithasfire.com/help` |
| Marketing URL | `https://ithasfire.com` |
| Promotional Text | (optional, 170 chars) — see below |

#### Description — paste this in:

```
Ithas Fire is the easiest way to find live music, art shows, and community
events near you — and the cleanest way to buy tickets.

— Discover events curated by local promoters and venues
— Filter by category, date, neighborhood
— Buy tickets with Apple Pay, Google Pay, or card
— Tickets live in your phone — scan at the door, no email scrolling
— Profile pages for your favorite venues, artists, and organisers
— Notifications when a place you follow announces a new show
— No ads, no tracking, no resale-bot bullshit. We don't sell your data.

For event organisers: Ithas Fire offers fair, low-fee ticketing with
real-time sales reporting and at-the-door scan tools. Visit
ithasfire.com to apply.

Sliding-scale tickets supported on participating events. Refund policy
varies by organiser — see each event's page.

Questions? support@ithasfire.com
```

#### Promotional Text (optional, can change without re-submission):

```
Live music, art, comedy, and community events from real local venues.
Buy tickets, scan at the door, follow your favorite places.
```

---

## Both apps — Screenshot requirements

App Store wants:
- **6.7" iPhone** (iPhone 14/15/16 Pro Max) — REQUIRED, 3 minimum, 10 max
- **6.5" iPhone** (iPhone XS Max, 11 Pro Max) — REQUIRED for backwards compat, 3+
- **iPad** — only if you're shipping iPad support (scanner is `supportsTablet: false`, mobile is `true` so YES for mobile)

For now, take **3 screenshots of real working screens** on each device class. Don't worry about marketing chrome / annotations — that's polish for v1.x.

The simplest workflow:
1. Run the dev build on a borrowed/owned iPhone Pro Max (6.7") — `Cmd+S` in Simulator captures screenshots, or use real-device screenshot
2. Resize to App Store Connect's required dimensions (1290×2796 for 6.7" portrait)
3. Use the same set, downsized to 1242×2688, for 6.5"
4. Upload via App Store Connect Web → App Information → Screenshots

---

## Submission order recommendation

1. **Scanner first** — simpler, fewer screens, no payment flow review headache. Iron out the App Review back-and-forth on the lower-stakes app.
2. **Mobile second** — once you've learned what reviewers ask, mobile's review goes faster.

Both can be in review simultaneously. Just don't promote either to "production" until both pass.
