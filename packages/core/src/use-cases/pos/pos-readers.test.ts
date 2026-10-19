import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { EventRecord } from "@th/ports/repos/events";
import type { PosReaderRecord } from "@th/types/repos/pos-readers";

import { cancelPosReaderAction } from "./cancel-pos-reader-action";
import { listPosReaders } from "./list-pos-readers";
import { pairPosReader } from "./pair-pos-reader";
import { processPosSaleOnReader } from "./process-pos-sale-on-reader";
import { unpairPosReader } from "./unpair-pos-reader";

const fixedClock: ClockPort = { now: () => new Date("2026-07-26T00:00:00Z") };
const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000d1";
const READER_ID = "00000000-0000-4000-8000-0000000000f1";
const PLACE_ID = "00000000-0000-4000-8000-0000000000c1";
const STRIPE_READER = "tmr_test_frontdoor";
const STRIPE_PI = "pi_test_walkup";
const TERMINAL_LOCATION_ID = "tml_test_platform_location";

function reader(overrides: Partial<PosReaderRecord> = {}): PosReaderRecord {
  return {
    id: READER_ID,
    orgId: ORG_A,
    stripeReaderId: STRIPE_READER,
    label: "Front door",
    placeId: null,
    deviceType: "bbpos_wisepos_e",
    pairedByHumanId: ACTOR,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRepos(opts: {
  membershipRole?: OrgMembership["role"] | null;
  storedReader?: PosReaderRecord | null;
  existingByStripeId?: PosReaderRecord | null;
  order?: Record<string, unknown> | null;
  event?: Partial<EventRecord> | null;
  place?: { id: string } | null;
  createThrows?: unknown;
}) {
  const membership =
    opts.membershipRole === null
      ? null
      : ({
          orgId: ORG_A,
          humanId: ACTOR,
          role: opts.membershipRole ?? "OWNER",
        } satisfies OrgMembership);

  return {
    authz: { getOrgMembership: vi.fn(async () => membership) },
    events: {
      getById: vi.fn(async () =>
        opts.event === null
          ? null
          : ({
              id: EVENT_ID,
              orgId: ORG_A,
              status: "PUBLISHED",
              ...(opts.event ?? {}),
            } as EventRecord),
      ),
    },
    orders: {
      getById: vi.fn(async () =>
        opts.order === null
          ? null
          : {
              id: ORDER_ID,
              eventId: EVENT_ID,
              status: "PENDING",
              paymentChannel: "POS",
              stripePaymentIntentId: STRIPE_PI,
              ...(opts.order ?? {}),
            },
      ),
    },
    places: {
      getById: vi.fn(async () =>
        opts.place === undefined ? { id: PLACE_ID } : opts.place,
      ),
    },
    posReaders: {
      getById: vi.fn(async () =>
        opts.storedReader === undefined ? reader() : opts.storedReader,
      ),
      getByStripeReaderId: vi.fn(async () => opts.existingByStripeId ?? null),
      listByOrg: vi.fn(async () => [reader()]),
      create: vi.fn(async () => {
        if (opts.createThrows) {
          throw opts.createThrows;
        }
        return reader();
      }),
      update: vi.fn(async () => reader()),
      delete: vi.fn(async () => undefined),
    },
    platformSettings: {
      get: vi.fn(async () => ({ value: TERMINAL_LOCATION_ID })),
      upsert: vi.fn(async () => undefined),
    },
    audit: { log: vi.fn(async () => undefined) },
  } as unknown as Repos;
}

function makePayments(overrides: Partial<PaymentProcessorPort> = {}) {
  return {
    registerTerminalReader: vi.fn(async () => ({
      readerId: STRIPE_READER,
      deviceType: "bbpos_wisepos_e",
      status: "online" as const,
    })),
    getTerminalReader: vi.fn(async () => ({
      readerId: STRIPE_READER,
      label: "Front door",
      deviceType: "bbpos_wisepos_e",
      status: "online" as const,
      action: null,
    })),
    deleteTerminalReader: vi.fn(async () => undefined),
    processPaymentIntentOnReader: vi.fn(async () => ({
      actionStatus: "in_progress" as const,
    })),
    cancelReaderAction: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as PaymentProcessorPort;
}

describe("pairPosReader", () => {
  it("registers at Stripe and records org ownership", async () => {
    const repos = makeRepos({});
    const payments = makePayments();

    const result = await pairPosReader(
      { repos, authz: denyingAuthz, payments, clock: fixedClock },
      {
        actorHumanId: ACTOR,
        orgId: ORG_A,
        registrationCode: "puppies-plug-could",
        label: "Front door",
      },
    );

    expect(payments.registerTerminalReader).toHaveBeenCalledWith({
      registrationCode: "puppies-plug-could",
      label: "Front door",
      locationId: TERMINAL_LOCATION_ID,
    });
    expect(repos.posReaders.create).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, stripeReaderId: STRIPE_READER }),
    );
    expect(result.stripeReaderId).toBe(STRIPE_READER);
  });

  it("rejects a non-admin org member", async () => {
    const repos = makeRepos({ membershipRole: "SCANNER" });
    const payments = makePayments();

    await expect(
      pairPosReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        {
          actorHumanId: ACTOR,
          orgId: ORG_A,
          registrationCode: "puppies-plug-could",
          label: "Front door",
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(payments.registerTerminalReader).not.toHaveBeenCalled();
  });

  it("maps an invalid registration code to a typed error", async () => {
    const repos = makeRepos({});
    const codeErr = Object.assign(new Error("no such code"), {
      isRegistrationCodeError: true,
    });
    const payments = makePayments({
      registerTerminalReader: vi.fn(async () => {
        throw codeErr;
      }),
    } as unknown as Partial<PaymentProcessorPort>);

    await expect(
      pairPosReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        {
          actorHumanId: ACTOR,
          orgId: ORG_A,
          registrationCode: "wrong-code-here",
          label: "Front door",
        },
      ),
    ).rejects.toMatchObject({ code: "POS_READER_REGISTRATION_CODE_INVALID" });
  });

  it("deregisters at Stripe when our ownership row cannot be written", async () => {
    const repos = makeRepos({ createThrows: new Error("db down") });
    const payments = makePayments();

    await expect(
      pairPosReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        {
          actorHumanId: ACTOR,
          orgId: ORG_A,
          registrationCode: "puppies-plug-could",
          label: "Front door",
        },
      ),
    ).rejects.toThrow("db down");

    // Otherwise the platform is left holding a reader nobody owns.
    expect(payments.deleteTerminalReader).toHaveBeenCalledWith({
      readerId: STRIPE_READER,
    });
  });

  it("refuses hardware already claimed by another org", async () => {
    const repos = makeRepos({
      existingByStripeId: reader({ orgId: ORG_B }),
    });
    const payments = makePayments();

    await expect(
      pairPosReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        {
          actorHumanId: ACTOR,
          orgId: ORG_A,
          registrationCode: "puppies-plug-could",
          label: "Front door",
        },
      ),
    ).rejects.toMatchObject({ code: "POS_READER_ALREADY_PAIRED" });

    expect(repos.posReaders.create).not.toHaveBeenCalled();
    expect(payments.deleteTerminalReader).toHaveBeenCalled();
  });
});

describe("processPosSaleOnReader", () => {
  it("dispatches the order's PaymentIntent to the reader", async () => {
    const repos = makeRepos({});
    const payments = makePayments();

    const result = await processPosSaleOnReader(
      { repos, authz: denyingAuthz, payments, clock: fixedClock },
      { actorHumanId: ACTOR, orderId: ORDER_ID, posReaderId: READER_ID },
    );

    expect(payments.processPaymentIntentOnReader).toHaveBeenCalledWith({
      readerId: STRIPE_READER,
      paymentIntentId: STRIPE_PI,
    });
    expect(result.actionStatus).toBe("in_progress");
  });

  it("refuses to drive a reader belonging to another org", async () => {
    // The event is org A's; the reader is org B's. Stripe would happily
    // dispatch to it — this check is the only thing that stops it.
    const repos = makeRepos({ storedReader: reader({ orgId: ORG_B }) });
    const payments = makePayments();

    await expect(
      processPosSaleOnReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        { actorHumanId: ACTOR, orderId: ORDER_ID, posReaderId: READER_ID },
      ),
    ).rejects.toMatchObject({ code: "POS_READER_ORG_MISMATCH" });

    expect(payments.processPaymentIntentOnReader).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "CANCELLED"] as const)(
    "refuses to put a sale for a %s event on the reader (owner ruling 2026-10-07)",
    async (status) => {
      // A sale started before the event was cancelled must not be tapped
      // after it; the cancellation voids such sales, this closes the gap.
      const repos = makeRepos({ event: { status } });
      const payments = makePayments();

      await expect(
        processPosSaleOnReader(
          { repos, authz: denyingAuthz, payments, clock: fixedClock },
          { actorHumanId: ACTOR, orderId: ORDER_ID, posReaderId: READER_ID },
        ),
      ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });

      expect(payments.processPaymentIntentOnReader).not.toHaveBeenCalled();
    },
  );

  it("refuses to re-dispatch an already-finalised order", async () => {
    const repos = makeRepos({ order: { status: "SUCCEEDED" } });
    const payments = makePayments();

    await expect(
      processPosSaleOnReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        { actorHumanId: ACTOR, orderId: ORDER_ID, posReaderId: READER_ID },
      ),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" });

    expect(payments.processPaymentIntentOnReader).not.toHaveBeenCalled();
  });

  it("maps an offline reader to a recoverable error", async () => {
    const repos = makeRepos({});
    const payments = makePayments({
      processPaymentIntentOnReader: vi.fn(async () => {
        throw Object.assign(new Error("reader offline"), {
          code: "terminal_reader_offline",
        });
      }),
    } as unknown as Partial<PaymentProcessorPort>);

    await expect(
      processPosSaleOnReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        { actorHumanId: ACTOR, orderId: ORDER_ID, posReaderId: READER_ID },
      ),
    ).rejects.toMatchObject({ code: "POS_READER_OFFLINE" });
  });

  it("lets an unrecognised Stripe failure through unmapped", async () => {
    const repos = makeRepos({});
    const payments = makePayments({
      processPaymentIntentOnReader: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    } as unknown as Partial<PaymentProcessorPort>);

    await expect(
      processPosSaleOnReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        { actorHumanId: ACTOR, orderId: ORDER_ID, posReaderId: READER_ID },
      ),
    ).rejects.toThrow("kaboom");
  });
});

describe("unpairPosReader", () => {
  it("deregisters at Stripe before dropping the ownership row", async () => {
    const repos = makeRepos({});
    const payments = makePayments();
    const order: string[] = [];
    (payments.deleteTerminalReader as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("stripe");
      },
    );
    (repos.posReaders.delete as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("db");
      },
    );

    await unpairPosReader(
      { repos, authz: denyingAuthz, payments, clock: fixedClock },
      { actorHumanId: ACTOR, orgId: ORG_A, posReaderId: READER_ID },
    );

    // Reversing this leaves a live platform reader with no owner, which any
    // org could then claim.
    expect(order).toEqual(["stripe", "db"]);
  });

  it("treats a reader Stripe already forgot as success", async () => {
    const repos = makeRepos({});
    const payments = makePayments({
      deleteTerminalReader: vi.fn(async () => {
        throw Object.assign(new Error("no such reader"), {
          statusCode: 404,
          code: "resource_missing",
        });
      }),
    } as unknown as Partial<PaymentProcessorPort>);

    await expect(
      unpairPosReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        { actorHumanId: ACTOR, orgId: ORG_A, posReaderId: READER_ID },
      ),
    ).resolves.toMatchObject({ unpaired: true });

    expect(repos.posReaders.delete).toHaveBeenCalled();
  });

  it("refuses to unpair another org's reader", async () => {
    const repos = makeRepos({ storedReader: reader({ orgId: ORG_B }) });
    const payments = makePayments();

    await expect(
      unpairPosReader(
        { repos, authz: denyingAuthz, payments, clock: fixedClock },
        { actorHumanId: ACTOR, orgId: ORG_A, posReaderId: READER_ID },
      ),
    ).rejects.toMatchObject({ code: "POS_READER_ORG_MISMATCH" });

    expect(payments.deleteTerminalReader).not.toHaveBeenCalled();
  });
});

describe("listPosReaders", () => {
  it("degrades to null status and reports when Stripe lookup fails", async () => {
    const repos = makeRepos({});
    const lookupErr = new Error("stripe timeout");
    const payments = makePayments({
      getTerminalReader: vi.fn(async () => {
        throw lookupErr;
      }),
    } as unknown as Partial<PaymentProcessorPort>);
    const reportError = vi.fn();

    const result = await listPosReaders(
      { repos, authz: denyingAuthz, payments, reportError },
      { actorHumanId: ACTOR, orgId: ORG_A, includeStatus: true },
    );

    expect(result.readers).toHaveLength(1);
    expect(result.readers[0]!.status).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      lookupErr,
      expect.objectContaining({
        tags: expect.objectContaining({ area: "pos" }),
      }),
    );
  });

  it("skips the Stripe round-trip when status is not requested", async () => {
    const repos = makeRepos({});
    const payments = makePayments();

    await listPosReaders(
      { repos, authz: denyingAuthz, payments },
      { actorHumanId: ACTOR, orgId: ORG_A, includeStatus: false },
    );

    expect(payments.getTerminalReader).not.toHaveBeenCalled();
  });

  it("a throwing reporter does not break the list", async () => {
    const repos = makeRepos({});
    const payments = makePayments({
      getTerminalReader: vi.fn(async () => {
        throw new Error("stripe timeout");
      }),
    } as unknown as Partial<PaymentProcessorPort>);
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });

    await expect(
      listPosReaders(
        { repos, authz: denyingAuthz, payments, reportError },
        { actorHumanId: ACTOR, orgId: ORG_A, includeStatus: true },
      ),
    ).resolves.toMatchObject({ readers: [expect.objectContaining({ status: null })] });
  });
});

describe("cancelPosReaderAction", () => {
  it("cancels on the org's own reader", async () => {
    const repos = makeRepos({ membershipRole: "SCANNER" });
    const payments = makePayments();

    await cancelPosReaderAction(
      { repos, authz: denyingAuthz, payments },
      { actorHumanId: ACTOR, orgId: ORG_A, posReaderId: READER_ID },
    );

    expect(payments.cancelReaderAction).toHaveBeenCalledWith({
      readerId: STRIPE_READER,
    });
  });

  it("refuses to cancel on another org's reader", async () => {
    const repos = makeRepos({
      membershipRole: "SCANNER",
      storedReader: reader({ orgId: ORG_B }),
    });
    const payments = makePayments();

    await expect(
      cancelPosReaderAction(
        { repos, authz: denyingAuthz, payments },
        { actorHumanId: ACTOR, orgId: ORG_A, posReaderId: READER_ID },
      ),
    ).rejects.toMatchObject({ code: "POS_READER_ORG_MISMATCH" });

    expect(payments.cancelReaderAction).not.toHaveBeenCalled();
  });
});
