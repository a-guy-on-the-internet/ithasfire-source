/**
 * Ready-made record stubs for use in unit tests.
 *
 * Each `makeStub*Record` function returns a **fully valid** record with sane
 * defaults. Callers can override any field via the `overrides` spread:
 *
 * ```ts
 * const event = makeStubEventRecord({ title: "My Event", currency: "usd" });
 * ```
 *
 * This avoids the "missing property" churn every time a new required field is
 * added to a record type.
 */

import type {
  EventRecord,
  EventTicketTypeSummary,
} from "@th/types/repos/events";
import type { OrderRecord, OrderItemRecord } from "@th/types/repos/orders";
import type { PayeeRecord } from "@th/types/repos/payees";
import type { SavedLocationRecord } from "@th/types/repos/saved-locations";

// ── Events ───────────────────────────────────────────────────────────────────

const STUB_EVENT_DEFAULTS: EventRecord = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  orgId: "11111111-1111-4111-8111-111111111111",
  humanId: null,
  title: "Stub Event",
  status: "DRAFT",
  attendanceMode: "TICKETED",
  stewardship: "OWNED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2026-06-01T18:00:00.000Z"),
  endsAt: new Date("2026-06-01T22:00:00.000Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  categorySeoType: null,
  addressText: null,
  countryCode: null,
  region: null,
  locality: null,
  postalCode: null,
  lat: null,
  lng: null,
  content: null,
  slug: null,
  shortId: null,
  regionCode: null,
  publishedAt: null,
  agreementPrimaryId: null,
  agreementResaleId: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  defaultLocale: null,
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  refundCutoffAt: null,
  heroImageUrl: null,
  currency: null,
  admissionTaxRateBps: null,
  taxRateSource: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/**
 * Build a complete `EventRecord` with sensible defaults.
 * Every required property is pre-filled; pass overrides for test-specific values.
 */
export function makeStubEventRecord(
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return { ...STUB_EVENT_DEFAULTS, ...overrides };
}

// ── Orders ───────────────────────────────────────────────────────────────────

const STUB_ORDER_DEFAULTS: OrderRecord = {
  id: "oooooooo-oooo-4ooo-8ooo-oooooooooooo",
  eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  buyerHumanId: "22222222-2222-4222-8222-222222222222",
  amountGrossCents: 0,
  feesPlatformCents: 0,
  taxAmountCents: 0,
  currency: "usd",
  feePolicySnapshot: {},
  status: "PENDING",
  stripePaymentIntentId: null,
  source: "PRIMARY",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  paidOutAt: null,
  parentOrderId: null,
  items: [],
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  stripeTaxCalculationId: null,
  paymentMethodType: null,
};

/**
 * Build a complete `OrderRecord` with sensible defaults.
 */
export function makeStubOrderRecord(
  overrides: Partial<OrderRecord> = {},
): OrderRecord {
  return { ...STUB_ORDER_DEFAULTS, ...overrides };
}

// ── Saved Locations ──────────────────────────────────────────────────────────

const STUB_SAVED_LOCATION_DEFAULTS: SavedLocationRecord = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Test Location",
  address: "123 Test St, City, ST 12345",
  countryCode: "US",
  region: "ST",
  locality: "City",
  postalCode: "12345",
  lat: null,
  lng: null,
  // Null = no address-derived zone (no coordinates, or the lookup failed) —
  // the state every pre-column SavedLocation row is in.
  timezone: null,
  ownerType: "ORGANIZATION",
  ownerId: "11111111-1111-4111-8111-111111111111",
  usageCount: 0,
  admissionTaxRateBps: null,
  taxRateFetchedAt: null,
  taxRateSource: null,
};

/**
 * Build a complete `SavedLocationRecord` with sensible defaults.
 */
export function makeStubSavedLocationRecord(
  overrides: Partial<SavedLocationRecord> = {},
): SavedLocationRecord {
  return { ...STUB_SAVED_LOCATION_DEFAULTS, ...overrides };
}

// ── Ticket Types ────────────────────────────────────────────────────────────

const STUB_TICKET_TYPE_DEFAULTS: EventTicketTypeSummary = {
  id: "ttttttt0-0000-4000-8000-000000000001",
  name: "General Admission",
  description: null,
  priceCents: 2500,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  status: "ACTIVE",
  seatSectionId: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
  // Unscheduled by default — the overwhelming majority of rows, forever
  // (NFR-001). Override both fields together to exercise a price flip.
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  // Unbounded sales window by default — again the overwhelming majority of
  // rows, and the reason NFR-001 holds by construction: with both null the
  // window predicate is a constant "on sale".
  salesOpenAt: null,
  salesCloseAt: null,
};

/**
 * Build a complete `EventTicketTypeSummary` with sensible defaults.
 * Centralised so newly added required fields don't ripple through every test.
 */
export function makeStubTicketTypeSummary(
  overrides: Partial<EventTicketTypeSummary> = {},
): EventTicketTypeSummary {
  return { ...STUB_TICKET_TYPE_DEFAULTS, ...overrides };
}

// ── Payees ───────────────────────────────────────────────────────────────────

const STUB_PAYEE_DEFAULTS: PayeeRecord = {
  id: "ppppppp0-0000-4000-8000-000000000001",
  subjectType: "ORGANIZATION",
  subjectId: "11111111-1111-4111-8111-111111111111",
  stripeAccountId: null,
  status: "ACTIVE",
  payoutsEnabled: true,
  chargesEnabled: true,
  defaultCurrency: "usd",
  resaleNegativeBalanceCents: 0,
  resaleNegativeBalanceOpenedAt: null,
  resaleNegativeBalanceAgingStartsAt: null,
  resalePayoutBlockReason: null,
  resalePayoutBlockedAt: null,
};

/**
 * Build a complete `PayeeRecord` with sensible defaults.
 */
export function makeStubPayeeRecord(
  overrides: Partial<PayeeRecord> = {},
): PayeeRecord {
  return { ...STUB_PAYEE_DEFAULTS, ...overrides };
}
