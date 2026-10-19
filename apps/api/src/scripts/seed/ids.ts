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
  // Place-level PRIMARY terms (own rows, never the org default, so the org
  // default is not read as "shared" by other references).
  place1Agreement: "00000000-0000-4000-8000-00000000d019",
  place6Agreement: "00000000-0000-4000-8000-00000000d01a",
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
  // ── Demo-org venue portfolio (booking-inbox seed) ────────────────────────
  // The demo org used to own exactly ONE venue, which made the org Bookings
  // page indistinguishable from a single-venue inbox: `VenueFilterBar` hides
  // its select for a one-venue org, so the cross-venue filter — the whole
  // point of that page — could not be seen or exercised in dev. These three
  // give `demo` a four-venue portfolio.
  //
  // NEW rows on purpose, rather than re-pointing existing places at the demo
  // org: events, orders, layouts and seat sections are all keyed to the
  // existing places, and moving ownership would shift data under fixtures
  // that assume the current owners.
  demoVenueMohawk: "00000000-0000-4000-8000-00000000d120",
  demoVenueCheerUp: "00000000-0000-4000-8000-00000000d121",
  demoVenueHoleInWall: "00000000-0000-4000-8000-00000000d122",
  // Multi-room venue (Cheer Up Charlies): the Space dimension is only
  // meaningful where a venue HAS more than one room, and every seeded place
  // had exactly one ("Main Space"). Inside/Outside is the real-world shape of
  // that venue and gives the space filter something to filter.
  demoSpaceCheerUpInside: "00000000-0000-4000-8000-00000000d130",
  demoSpaceCheerUpOutside: "00000000-0000-4000-8000-00000000d131",
  demoSpaceMohawkIndoor: "00000000-0000-4000-8000-00000000d132",
  demoSpaceMohawkOutdoor: "00000000-0000-4000-8000-00000000d133",
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
  // ── Venue track-record fixture (docs/specs/2026-09-24) ───────────────────
  // See `seed/track-record-fixture.ts`. Two Nashville venues owned by the
  // demo org: "Fishbowl House" (address withheld, performer reviews OFF, 14
  // past shows with door scans and repeat acts, and ZERO PlaceReview rows —
  // the case FR-008 exists for) and "Corner Lot" (exact address, reviews on,
  // no shows — the empty state). Per-row ids for the shows, orders, tickets
  // and lineup rows are derived inside the fixture under the `e1…` prefix,
  // the way `seed/orders.ts` derives its order book.
  trackRecordFishbowl: "00000000-0000-4000-8000-00000000e100",
  trackRecordCornerLot: "00000000-0000-4000-8000-00000000e101",
  // The acts that play Fishbowl House — a Human + PUBLIC EntityPage each so a
  // lineup entry links somewhere. Three regulars, then twelve one-offs.
  trackRecordActRatCathedral: "00000000-0000-4000-8000-00000000e110",
  trackRecordActSisterFurnace: "00000000-0000-4000-8000-00000000e111",
  trackRecordActColdStomach: "00000000-0000-4000-8000-00000000e112",
  trackRecordOneOffActs: [
    "00000000-0000-4000-8000-00000000e113",
    "00000000-0000-4000-8000-00000000e114",
    "00000000-0000-4000-8000-00000000e115",
    "00000000-0000-4000-8000-00000000e116",
    "00000000-0000-4000-8000-00000000e117",
    "00000000-0000-4000-8000-00000000e118",
    "00000000-0000-4000-8000-00000000e119",
    "00000000-0000-4000-8000-00000000e11a",
    "00000000-0000-4000-8000-00000000e11b",
    "00000000-0000-4000-8000-00000000e11c",
    "00000000-0000-4000-8000-00000000e11d",
    "00000000-0000-4000-8000-00000000e11e",
  ],
  // Ticket holders for the scanned tickets. A small pool of IMPORT-sourced
  // humans (no auth user) rather than the dev-login admin, so ~370 past
  // tickets do not land on the admin's my-tickets page.
  trackRecordDoorHumans: [
    "00000000-0000-4000-8000-00000000e120",
    "00000000-0000-4000-8000-00000000e121",
    "00000000-0000-4000-8000-00000000e122",
    "00000000-0000-4000-8000-00000000e123",
    "00000000-0000-4000-8000-00000000e124",
    "00000000-0000-4000-8000-00000000e125",
  ],
  // Venue-confirmation & booking-intents Phase-2 fixtures (2026-08-27 spec)
  rentBookingId: "00000000-0000-4000-8000-0000000bb020",
  useBookingId: "00000000-0000-4000-8000-0000000bb021",
  parkedBookingId: "00000000-0000-4000-8000-0000000bb022",
  unclaimedPlace: "00000000-0000-4000-8000-00000000d141",
  // ── Payout history (platform settlements, "Payouts sent") ────────────────
  // Display fixtures only — see `seed/payouts.ts`. Three batches so the
  // staff view has a transferred, a failed (with a reason) and an in-flight
  // pending row to render instead of an empty table.
  payoutCompleted: "00000000-0000-4000-8000-0000000f0001",
  payoutWithFailure: "00000000-0000-4000-8000-0000000f0002",
  payoutRunning: "00000000-0000-4000-8000-0000000f0003",
  payoutItemTransferredOrg: "00000000-0000-4000-8000-0000000f0010",
  payoutItemReserveHeld: "00000000-0000-4000-8000-0000000f0011",
  payoutItemFailed: "00000000-0000-4000-8000-0000000f0012",
  payoutItemReserveReleased: "00000000-0000-4000-8000-0000000f0013",
  payoutItemMxn: "00000000-0000-4000-8000-0000000f0014",
  payoutItemPending: "00000000-0000-4000-8000-0000000f0015",
  // ── Membership tiers + memberships (platform memberships page) ───────────
  // Display fixtures only — see `seed/memberships.ts` for what they
  // deliberately do NOT set and which job would have chased it. Six tiers
  // across four owners (including one human-owned and one MXN) and fifteen
  // memberships covering active, trialing, past_due, unpaid, stuck-incomplete
  // and cancel-at-period-end.
  membershipTierSustaining: "00000000-0000-4000-8000-0000000f1001",
  membershipTierPatron: "00000000-0000-4000-8000-0000000f1002",
  membershipTierDraft: "00000000-0000-4000-8000-0000000f1003",
  membershipTierSupporter: "00000000-0000-4000-8000-0000000f1004",
  membershipTierBacker: "00000000-0000-4000-8000-0000000f1005",
  membershipTierAmigo: "00000000-0000-4000-8000-0000000f1006",
  membershipSustainingActive1: "00000000-0000-4000-8000-0000000f1010",
  membershipSustainingActive2: "00000000-0000-4000-8000-0000000f1011",
  membershipSustainingActive3: "00000000-0000-4000-8000-0000000f1012",
  membershipSustainingPastDue: "00000000-0000-4000-8000-0000000f1013",
  membershipSustainingLeaving: "00000000-0000-4000-8000-0000000f1014",
  membershipSustainingIncomplete: "00000000-0000-4000-8000-0000000f1015",
  membershipPatronActive1: "00000000-0000-4000-8000-0000000f1020",
  membershipPatronActive2: "00000000-0000-4000-8000-0000000f1021",
  membershipPatronLeaving: "00000000-0000-4000-8000-0000000f1022",
  membershipSupporterActive: "00000000-0000-4000-8000-0000000f1030",
  membershipSupporterTrialing: "00000000-0000-4000-8000-0000000f1031",
  membershipBackerActive: "00000000-0000-4000-8000-0000000f1040",
  membershipBackerUnpaid: "00000000-0000-4000-8000-0000000f1041",
  membershipAmigoActive1: "00000000-0000-4000-8000-0000000f1050",
  membershipAmigoActive2: "00000000-0000-4000-8000-0000000f1051",
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
