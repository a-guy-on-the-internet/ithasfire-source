/**
 * Deterministic IDs used across all seed modules.
 *
 * These stable UUIDs allow idempotent re-runs and are referenced by
 * both the dev seed script (`seed-data.ts`) and E2E seed endpoints.
 */
export const DEMO_IDS = {
  org: "00000000-0000-4000-8000-00000000d001",
  payee: "00000000-0000-4000-8000-00000000d002",
  agreement: "00000000-0000-4000-8000-00000000d003",
  human: "00000000-0000-4000-8000-00000000d004",
  devUser: "00000000-0000-4000-8000-00000000d005",
  // Additional orgs
  org2: "00000000-0000-4000-8000-00000000d010",
  org3: "00000000-0000-4000-8000-00000000d011",
  // Additional payees & agreements (one per org)
  payee2: "00000000-0000-4000-8000-00000000d012",
  payee3: "00000000-0000-4000-8000-00000000d013",
  agreement2: "00000000-0000-4000-8000-00000000d014",
  agreement3: "00000000-0000-4000-8000-00000000d015",
  // Additional humans
  human2: "00000000-0000-4000-8000-00000000d020",
  human3: "00000000-0000-4000-8000-00000000d021",
  human4: "00000000-0000-4000-8000-00000000d022",
  human5: "00000000-0000-4000-8000-00000000d023",
  // Dev-login user personal payee & agreement
  devPayee: "00000000-0000-4000-8000-00000000d040",
  devAgreement: "00000000-0000-4000-8000-00000000d041",
  // Places
  place1: "00000000-0000-4000-8000-00000000d030",
  place2: "00000000-0000-4000-8000-00000000d031",
  place3: "00000000-0000-4000-8000-00000000d032",
  place4: "00000000-0000-4000-8000-00000000d033",
  place5: "00000000-0000-4000-8000-00000000d034",
  place6: "00000000-0000-4000-8000-00000000d035",
  place7: "00000000-0000-4000-8000-00000000d036",
  place8: "00000000-0000-4000-8000-00000000d037",
  place9: "00000000-0000-4000-8000-00000000d038",
  place10: "00000000-0000-4000-8000-00000000d039",
  // Layout-less SF venue for the "rate this show" past-event fixture. Kept
  // layout-less so the recent-past recap event surfaces a venue name in
  // my-tickets without triggering seat-section materialisation.
  place11: "00000000-0000-4000-8000-00000000d03a",
  // Additional orgs (Chicago / LA)
  org4: "00000000-0000-4000-8000-00000000d016",
  payee4: "00000000-0000-4000-8000-00000000d017",
  agreement4: "00000000-0000-4000-8000-00000000d018",
  human6: "00000000-0000-4000-8000-00000000d024",
  human7: "00000000-0000-4000-8000-00000000d025",
  // POS_WALKUP guest humans (per spec FR-004)
  posWalkup1: "00000000-0000-4000-8000-00000000d100",
  posWalkup2: "00000000-0000-4000-8000-00000000d101",
  posWalkup3: "00000000-0000-4000-8000-00000000d102",
  // Venue hierarchy (venue-hierarchy-and-holds, 2026-08-18) for the demo
  // org's primary venue (place1, The Paramount Theatre): default space +
  // default calendar, plus a second "Drkmttr Live Music"-style calendar that
  // shares the SAME space — exercises calendar routing and the shared-space
  // case (an event must only show on its own calendar's surfaces while
  // conflict detection sees both).
  venueMainSpace: "00000000-0000-4000-8000-00000000d110",
  venueDefaultCalendar: "00000000-0000-4000-8000-00000000d111",
  venueLiveMusicCalendar: "00000000-0000-4000-8000-00000000d112",
  // MXN dev-login user (second test account with Mexican peso currency)
  devUserMxn: "00000000-0000-4000-8000-00000000d050",
  devPayeeMxn: "00000000-0000-4000-8000-00000000d051",
  devAgreementMxn: "00000000-0000-4000-8000-00000000d052",
  orgMxn: "00000000-0000-4000-8000-00000000d053",
  payeeMxn: "00000000-0000-4000-8000-00000000d054",
  agreementMxn: "00000000-0000-4000-8000-00000000d055",
  // Embed widgets
  embedDemoOrg: "00000000-0000-4000-8000-00000000d060",
  // Platform waiver templates (orgId = null)
  waiverGeneral: "00000000-0000-4000-8000-00000000d070",
  waiverLiveMusic: "00000000-0000-4000-8000-00000000d071",
  waiverPrivateResidence: "00000000-0000-4000-8000-00000000d072",
  // Promo codes (org-scoped — one per demo org for testing)
  promoDemoWelcome: "00000000-0000-4000-8000-00000000d080",
  promoDemoEarlyBird: "00000000-0000-4000-8000-00000000d081",
  // Community-stewardship listing + its edit-suggestion queue fixtures.
  // Give the community moderator queue (/moderate/suggestions) and the
  // org "Suggestions" inbox (FR-016) real PENDING rows to review.
  communityEvent: "00000000-0000-4000-8000-00000000d090",
  communitySuggestionAnon: "00000000-0000-4000-8000-00000000d091",
  communitySuggestionSchedule: "00000000-0000-4000-8000-00000000d092",
  communitySuggestionAge: "00000000-0000-4000-8000-00000000d093",
  orgEventSuggestion: "00000000-0000-4000-8000-00000000d094",
  // Attendee-review ("Rate this show") fixture: a SUCCEEDED order + one
  // SCANNED ticket owned by the dev-login admin against a recently-ended
  // published event, so the /review-event flow + my-tickets "Rate this show"
  // CTA are exercisable locally. Deliberately NO AttendeeReview row (that
  // would flip the CTA to "already reviewed").
  reviewShowOrder: "00000000-0000-4000-8000-00000000e001",
  reviewShowOrderItem: "00000000-0000-4000-8000-00000000e002",
  reviewShowTicket: "00000000-0000-4000-8000-00000000e003",
} as const;

export const DEV_LOGIN_USER = {
  // Must be a deliverable address (SES for ithasfire.com is verified):
  // magic-link sign-in against dev (and any environment where this seed
  // runs) must actually deliver. Previously @ithasfire.local —
  // undeliverable, blocked any end-to-end magic-link /
  // passkey-on-fresh-device testing on the scanner. Password stays
  // known-fixed for password-fallback testing in dev only; the prod
  // platform admin is created separately via `pnpm seed:admin` so this
  // credential never reaches production data.
  email: "admin@ithasfire.com",
  password: "Dev-Login-2026!",
  name: "Ithas Fire Admin",
  profileSlug: "admin",
  // Cute penguin image for the dev user avatar
  image:
    "https://images.unsplash.com/photo-1598439210625-5067c578f3f6?w=200&q=80",
} as const;

export const DEV_LOGIN_MXN_USER = {
  email: "dev-login-mxn@ithasfire.local",
  password: "Dev-Login-MXN-2026!",
  name: "Dev Login MXN",
  profileSlug: "dev-login-mxn",
  image:
    "https://images.unsplash.com/photo-1518020382113-a7e8fc38eac9?w=200&q=80",
} as const;
