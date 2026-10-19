import { describe, it, expect } from "vitest";

import { formatOrderCode } from "@th/types/order-identifier";
import type { WalletPassTicketData } from "@th/ports/wallet-pass.port";

import { GoogleWalletAdapter } from "./google-wallet-adapter.js";

/**
 * Regression guard for the LAST surface that showed a buyer a code no one can
 * look up.
 *
 * `ticketNumber` used to fall back to `ticketId.slice(0, 8)`. That is 8 hex
 * characters, so it satisfies the order-code shape the admin search parser
 * gates on (`ORDER_ID_SUFFIX_PATTERN`) — it produces an `id endsWith <head>`
 * clause and matches NOTHING, and it is not even the ORDER's id. A pass holder
 * quoting it to support gets an empty result with no signal anything is wrong.
 *
 * The pass is not renderable here (signing needs GCP), but the ticket object
 * is fully built before it is signed and the signer receives it as the JWT
 * payload — so stubbing the IAM call is enough to read back exactly what
 * Google would be told.
 */

const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";
/** `formatOrderCode(ORDER_ID)` — the 8-hex TAIL, uppercased. */
const ORDER_CODE = "DB21B2C3";

const ticketData = (
  overrides: Partial<WalletPassTicketData> = {},
): WalletPassTicketData => ({
  ticketId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  ticketCode: "TICKET-CODE",
  ticketTypeName: "General Admission",
  eventId: "33333333-3333-4333-8333-333333333333",
  eventTitle: "Launch Party",
  eventStartsAt: "2026-02-01T00:00:00.000Z",
  eventEndsAt: null,
  venueName: null,
  venueAddress: null,
  organizerName: null,
  orderId: ORDER_ID,
  orderRef: ORDER_CODE,
  holderName: "Ada Lovelace",
  priceCents: 2500,
  currency: "usd",
  ...overrides,
});

type SignedClaims = {
  payload: {
    eventTicketClasses: Array<Record<string, unknown>>;
    eventTicketObjects: Array<Record<string, unknown>>;
  };
};

/**
 * Build an adapter whose IAM signer is a local stub that captures the claims.
 * `auth` is private and constructed in the ctor, so it is replaced on the
 * instance — the alternative is a network call to iamcredentials.
 */
function adapterCapturingClaims(): {
  adapter: GoogleWalletAdapter;
  claims: () => SignedClaims;
} {
  let captured: SignedClaims | null = null;

  const adapter = new GoogleWalletAdapter({
    issuerId: "3388000000000000000",
    signerEmail: "wallet@example.iam.gserviceaccount.com",
  });

  const fakeClient = {
    request: (opts: { data: { payload: string } }) => {
      captured = JSON.parse(opts.data.payload) as SignedClaims;
      return Promise.resolve({ data: { signedJwt: "stub.jwt.signature" } });
    },
  };

  (adapter as unknown as { auth: unknown }).auth = {
    getClient: () => Promise.resolve(fakeClient),
    getCredentials: () =>
      Promise.resolve({
        client_email: "wallet@example.iam.gserviceaccount.com",
      }),
  };

  return {
    adapter,
    claims: () => {
      if (!captured) throw new Error("signJwt was never called");
      return captured;
    },
  };
}

describe("GoogleWalletAdapter — ticketNumber", () => {
  it("carries the order code the rest of the product displays", async () => {
    const { adapter, claims } = adapterCapturingClaims();

    const result = await adapter.generate(ticketData());

    expect(result.type).toBe("google");
    const [object] = claims().payload.eventTicketObjects;
    expect(object!.ticketNumber).toBe(ORDER_CODE);
    expect(object!.ticketNumber).not.toBe(ORDER_ID.slice(0, 8).toUpperCase());
  });

  it("falls back through formatOrderCode, never the HEAD of an id", async () => {
    const { adapter, claims } = adapterCapturingClaims();

    // `orderRef` null is the comp-ticket path (`generate-wallet-pass` sets it
    // to null when the order id could not be resolved).
    await adapter.generate(ticketData({ orderRef: null }));

    const [object] = claims().payload.eventTicketObjects;
    // Pinned as a LITERAL, not as `formatOrderCode(ORDER_ID)`: deriving both
    // sides from the same helper is tautological and would survive the helper
    // being repointed at the head of the id.
    expect(object!.ticketNumber).toBe(ORDER_CODE);
    expect(object!.ticketNumber).toBe(formatOrderCode(ORDER_ID));

    // The two strings the old code could have produced, both id-shaped and
    // both unresolvable: the head of the ORDER id and the head of the TICKET
    // id (which is what it actually used). Compared uppercased, since that is
    // the case an 8-hex code is rendered in.
    expect(object!.ticketNumber).not.toBe(ORDER_ID.slice(0, 8).toUpperCase());
    expect(object!.ticketNumber).not.toBe(
      ticketData().ticketId.slice(0, 8).toUpperCase(),
    );
  });

  it("still keys grouping by the raw order id", async () => {
    const { adapter, claims } = adapterCapturingClaims();

    await adapter.generate(ticketData());

    const [object] = claims().payload.eventTicketObjects;
    // The grouping id is machine-facing, never displayed — it must stay the
    // full uuid so two passes from one order group correctly.
    expect(object!.groupingInfo).toEqual({ groupingId: ORDER_ID });
  });
});

/**
 * The class is INSERT-ONCE per id and carries `venue.address`. If a locked
 * pass (address not yet shared, or NEVER) reused the event's class, it would
 * inherit whatever an earlier, unlocked save put there: the street.
 */
describe("GoogleWalletAdapter — class keying while the address is locked", () => {
  const EVENT_CLASS =
    "3388000000000000000.ithasfire_event_33333333_3333_4333_8333_333333333333";

  async function classOf(overrides: Partial<WalletPassTicketData>) {
    const { adapter, claims } = adapterCapturingClaims();
    await adapter.generate(ticketData(overrides));
    const cls = claims().payload.eventTicketClasses[0]!;
    const obj = claims().payload.eventTicketObjects[0]!;
    // The object must point at the class it ships with.
    expect(obj.classId).toBe(cls.id);
    return cls;
  }

  it("unlocked passes keep the event's class id, unchanged", async () => {
    const cls = await classOf({
      venueName: "Fishbowl House",
      venueAddress: "1412 Holly St",
    });
    expect(cls.id).toBe(EVENT_CLASS);
    expect(JSON.stringify(cls.venue)).toContain("1412 Holly St");
  });

  it("a locked pass never lands on the event's (possibly unlocked) class", async () => {
    const cls = await classOf({
      venueName: "Nashville, TN",
      venueAddress: "The organizer isn't sharing this address.",
      addressLocked: true,
    });
    expect(cls.id).not.toBe(EVENT_CLASS);
    expect(String(cls.id)).toMatch(
      new RegExp(`^${EVENT_CLASS}_locked_[0-9a-f]{12}$`),
    );
  });

  it("the same locked text shares a class; different locked text gets a new one", async () => {
    const never = {
      venueName: "Nashville, TN",
      venueAddress: "The organizer isn't sharing this address.",
      addressLocked: true,
    };
    const dated = {
      ...never,
      venueAddress:
        "The exact address will be shared on Wednesday, September 23, 2026 at 8:00 PM. We'll send you a reminder.",
    };
    const a = await classOf(never);
    const b = await classOf(never);
    const c = await classOf(dated);
    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(a.id);
  });
});
