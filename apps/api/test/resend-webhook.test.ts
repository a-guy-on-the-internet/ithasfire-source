import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { Webhook } from "svix";

import {
  handleResendWebhookPayload,
  parseResendDeliveryEvents,
} from "../src/routes/resend/webhook";

// Self-signing fixture: this test sets RESEND_WEBHOOK_SECRET to this same
// constant and signs its own payloads with it, so the value never needs to be
// the real one. It is deliberately base64 of readable text — the previous
// random-looking value matched GitHub's Stripe webhook-signing-secret pattern
// (whsec_ + 32 alphanumerics) and raised a secret-scanning alert on a Svix
// secret that was never a Stripe key.
const webhookSecret = "whsec_Z2l0bGVha3MtZmFrZS1ub3QtYS1yZWFsLXNlY3JldA==";

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return logger;
}

describe("resend webhook delivery parsing", () => {
  it("parses permanent bounce events into bounced delivery records", () => {
    const payload = {
      id: "evt_123",
      type: "email.bounced",
      created_at: "2026-05-25T10:00:00.000Z",
      data: {
        to: ["Recipient@Example.com"],
        bounce: { type: "Permanent" },
      },
    };

    expect(parseResendDeliveryEvents(payload)).toEqual([
      expect.objectContaining({
        providerEventId: "evt_123",
        eventType: "email.bounced",
        email: "recipient@example.com",
        status: "BOUNCED",
        occurredAt: new Date("2026-05-25T10:00:00.000Z"),
      }),
    ]);
  });

  it("logs temporary bounces without suppressing future sends", () => {
    const payload = {
      id: "evt_temp",
      type: "email.bounced",
      data: {
        email: "user@example.com",
        createdAt: "2026-05-25T11:00:00.000Z",
        bounce: { type: "Temporary" },
      },
    };

    expect(parseResendDeliveryEvents(payload)[0]).toMatchObject({
      providerEventId: "evt_temp",
      email: "user@example.com",
      status: "DELIVERABLE",
      occurredAt: new Date("2026-05-25T11:00:00.000Z"),
    });
  });

  it("uses the verified Svix webhook id for spec-shaped payloads without a provider event id", () => {
    const payload = {
      type: "email.bounced",
      created_at: "2026-05-25T10:00:00.000Z",
      data: {
        email_id: "msg_same_message",
        to: ["Recipient@Example.com"],
        bounce: { type: "Permanent" },
      },
    };

    expect(
      parseResendDeliveryEvents(payload, { webhookEventId: "msg_svix_event" }),
    ).toEqual([
      expect.objectContaining({
        providerEventId: "msg_svix_event",
        email: "recipient@example.com",
        status: "BOUNCED",
      }),
    ]);
  });

  it("does not treat message email_id as an idempotency key", () => {
    const payload = {
      type: "email.bounced",
      data: {
        email_id: "msg_not_a_webhook_event",
        email: "user@example.com",
        bounce: { type: "Permanent" },
      },
    };

    expect(parseResendDeliveryEvents(payload)).toEqual([]);
  });

  it("parses complaint events from alternate email fields", () => {
    const payload = {
      id: "evt_complaint",
      type: "email.complained",
      createdAt: "2026-05-25T12:00:00.000Z",
      data: { email: "spam@example.com" },
    };

    expect(parseResendDeliveryEvents(payload)[0]).toMatchObject({
      providerEventId: "evt_complaint",
      eventType: "email.complained",
      email: "spam@example.com",
      status: "COMPLAINED",
    });
  });
});

describe("resend webhook handler", () => {
  it("records supported events through the deliverability port", async () => {
    const logger = makeLogger();
    const deliverability = {
      getByEmail: vi.fn(),
      clearByEmail: vi.fn(),
      recordProviderEvent: vi.fn(async (input) => ({
        id: "delivery-event-1",
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        email: input.email,
        status: input.status,
        occurredAt: input.occurredAt,
        processedAt: new Date("2026-05-25T12:01:00.000Z"),
        authUserId: "auth-user-1",
        replayed: false,
      })),
    };

    const result = await handleResendWebhookPayload({
      payload: {
        id: "evt_123",
        type: "email.complained",
        created_at: "2026-05-25T12:00:00.000Z",
        data: { to: ["user@example.com"] },
      },
      deliverability,
      logger,
    });

    expect(result).toEqual({
      recorded: 1,
      replayed: 0,
      ignored: false,
      eventType: "email.complained",
    });
    expect(deliverability.recordProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "resend",
        providerEventId: "evt_123",
        email: "user@example.com",
        status: "COMPLAINED",
      }),
    );
  });

  it("reports a replayed event as a no-op when the port has already recorded it", async () => {
    const logger = makeLogger();
    const deliverability = {
      getByEmail: vi.fn(),
      clearByEmail: vi.fn(),
      recordProviderEvent: vi.fn(async (input) => ({
        id: "delivery-event-replay",
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        email: input.email,
        status: input.status,
        occurredAt: input.occurredAt,
        processedAt: new Date("2026-05-25T12:01:00.000Z"),
        authUserId: "auth-user-1",
        replayed: true,
      })),
    };

    const result = await handleResendWebhookPayload({
      payload: {
        id: "evt_replay",
        type: "email.bounced",
        created_at: "2026-05-25T12:00:00.000Z",
        data: { to: ["user@example.com"], bounce: { type: "Permanent" } },
      },
      deliverability,
      logger,
    });

    expect(result).toEqual({
      recorded: 1,
      replayed: 1,
      ignored: false,
      eventType: "email.bounced",
    });
  });

  it("records temporary and permanent bounces with the same email_id as separate events", async () => {
    const logger = makeLogger();
    const deliverability = {
      getByEmail: vi.fn(),
      clearByEmail: vi.fn(),
      recordProviderEvent: vi.fn(async (input) => ({
        id: `delivery-event-${input.providerEventId}`,
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        email: input.email,
        status: input.status,
        occurredAt: input.occurredAt,
        processedAt: new Date("2026-05-25T12:01:00.000Z"),
        authUserId: null,
        replayed: false,
      })),
    };

    const basePayload = {
      type: "email.bounced",
      data: {
        email_id: "msg_same_email",
        email: "user@example.com",
      },
    };

    await handleResendWebhookPayload({
      payload: {
        ...basePayload,
        data: { ...basePayload.data, bounce: { type: "Temporary" } },
      },
      webhookEventId: "msg_svix_temp",
      deliverability,
      logger,
    });
    await handleResendWebhookPayload({
      payload: {
        ...basePayload,
        data: { ...basePayload.data, bounce: { type: "Permanent" } },
      },
      webhookEventId: "msg_svix_perm",
      deliverability,
      logger,
    });

    expect(deliverability.recordProviderEvent).toHaveBeenCalledTimes(2);
    expect(deliverability.recordProviderEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerEventId: "msg_svix_temp",
        status: "DELIVERABLE",
      }),
    );
    expect(deliverability.recordProviderEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerEventId: "msg_svix_perm",
        status: "BOUNCED",
      }),
    );
  });

  it("acks unsupported event types without recording", async () => {
    const logger = makeLogger();
    const deliverability = {
      getByEmail: vi.fn(),
      clearByEmail: vi.fn(),
      recordProviderEvent: vi.fn(),
    };

    const result = await handleResendWebhookPayload({
      payload: { id: "evt_delivered", type: "email.delivered" },
      deliverability,
      logger,
    });

    expect(result).toEqual({
      recorded: 0,
      replayed: 0,
      ignored: true,
      eventType: "email.delivered",
    });
    expect(deliverability.recordProviderEvent).not.toHaveBeenCalled();
  });
});

describe("resend webhook route", () => {
  it("accepts a Svix-signed raw JSON payload and records it with svix-id", async () => {
    const deliverability = makeDeliverabilityPort();
    const app = await makeWebhookApp({ secret: webhookSecret, deliverability });
    const payload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-05-25T10:00:00.000Z",
      data: {
        email_id: "msg_message_1",
        email: "user@example.com",
        bounce: { type: "Permanent" },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: {
        ...signSvixPayload({ payload, id: "msg_svix_route_1" }),
        "content-type": "application/json",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(deliverability.recordProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "resend",
        providerEventId: "msg_svix_route_1",
        email: "user@example.com",
        status: "BOUNCED",
      }),
    );

    await app.close();
  });

  it("rejects bad Svix signatures", async () => {
    const deliverability = makeDeliverabilityPort();
    const app = await makeWebhookApp({ secret: webhookSecret, deliverability });
    const payload = JSON.stringify({
      type: "email.complained",
      data: { email: "user@example.com" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: {
        "svix-id": "msg_bad_sig",
        "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
        "svix-signature": "v1,bad",
        "content-type": "application/json",
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "bad_signature" });
    expect(deliverability.recordProviderEvent).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 503 when the webhook secret is not configured", async () => {
    const deliverability = makeDeliverabilityPort();
    const app = await makeWebhookApp({ secret: undefined, deliverability });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "email.complained" }),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "not_configured" });
    expect(deliverability.recordProviderEvent).not.toHaveBeenCalled();

    await app.close();
  });

  it("keeps replayed Svix ids idempotent without collapsing later events for the same email_id", async () => {
    const seen = new Set<string>();
    const deliverability = makeDeliverabilityPort({
      recordProviderEvent: vi.fn(async (input) => {
        const replayed = seen.has(input.providerEventId);
        seen.add(input.providerEventId);
        return {
          id: `delivery-event-${input.providerEventId}`,
          provider: input.provider,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          email: input.email,
          status: input.status,
          occurredAt: input.occurredAt,
          processedAt: new Date("2026-05-25T12:01:00.000Z"),
          authUserId: null,
          replayed,
        };
      }),
    });
    const app = await makeWebhookApp({ secret: webhookSecret, deliverability });

    const temporaryPayload = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: "msg_same_email_id",
        email: "user@example.com",
        bounce: { type: "Temporary" },
      },
    });
    const permanentPayload = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: "msg_same_email_id",
        email: "user@example.com",
        bounce: { type: "Permanent" },
      },
    });

    await postSignedResend(app, temporaryPayload, "msg_svix_temp_route");
    await postSignedResend(app, temporaryPayload, "msg_svix_temp_route");
    await postSignedResend(app, permanentPayload, "msg_svix_perm_route");

    expect(deliverability.recordProviderEvent).toHaveBeenCalledTimes(3);
    expect(deliverability.recordProviderEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerEventId: "msg_svix_temp_route",
        status: "DELIVERABLE",
      }),
    );
    expect(deliverability.recordProviderEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerEventId: "msg_svix_temp_route",
        status: "DELIVERABLE",
      }),
    );
    expect(deliverability.recordProviderEvent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        providerEventId: "msg_svix_perm_route",
        status: "BOUNCED",
      }),
    );

    await app.close();
  });
});

function makeDeliverabilityPort(overrides: Record<string, unknown> = {}) {
  return {
    getByEmail: vi.fn(),
    clearByEmail: vi.fn(),
    recordProviderEvent: vi.fn(async (input) => ({
      id: `delivery-event-${input.providerEventId}`,
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      email: input.email,
      status: input.status,
      occurredAt: input.occurredAt,
      processedAt: new Date("2026-05-25T12:01:00.000Z"),
      authUserId: null,
      replayed: false,
    })),
    ...overrides,
  };
}

async function makeWebhookApp(input: {
  secret: string | undefined;
  deliverability: ReturnType<typeof makeDeliverabilityPort>;
  /**
   * When present, the plugin also wires the booking-inquiry bounce fan-in.
   * Omitted by most specs on purpose — the route must survive a deps bag with
   * no tRPC repos rather than 500 on an OPTIONAL side effect.
   */
  markInquirerEmailUndeliverable?: (input: unknown) => Promise<number>;
}) {
  vi.resetModules();
  if (input.secret) {
    process.env.RESEND_WEBHOOK_SECRET = input.secret;
  } else {
    delete process.env.RESEND_WEBHOOK_SECRET;
  }
  process.env.NODE_ENV = "test";

  const { default: rawBody } = await import("../src/plugins/raw-body");
  const { default: resendWebhook } =
    await import("../src/routes/resend/webhook");
  const app = Fastify({ logger: false });
  const logger = makeLogger();

  app.decorate("deps", {
    logger,
    emailDeliverability: input.deliverability,
    ...(input.markInquirerEmailUndeliverable
      ? {
          trpc: {
            repos: {
              bookingRequests: {
                markInquirerEmailUndeliverable:
                  input.markInquirerEmailUndeliverable,
              },
            },
          },
        }
      : {}),
  });

  await app.register(rawBody);
  await app.register(resendWebhook);

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking-inquiry fan-in (booking-inquirer-outreach, 2026-09-05)
//
// The deliverability port DELIBERATELY refuses to flag an UNVERIFIED AuthUser,
// and every shadow minted for an anonymous booking inquirer is unverified —
// so without this fan-in a venue's bounced reply leaves no trace the venue can
// see. These cover the wiring, not the stamp itself (that lives in
// `markBookingInquirerUndeliverable`'s own suite).
// ─────────────────────────────────────────────────────────────────────────────

function makeDeliverability(replayed = false) {
  return {
    getByEmail: vi.fn(),
    clearByEmail: vi.fn(),
    anonymizeForUser: vi.fn(),
    recordProviderEvent: vi.fn(async (input: Record<string, unknown>) => ({
      id: "delivery-event",
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      email: input.email,
      status: input.status,
      occurredAt: input.occurredAt,
      processedAt: new Date("2026-09-05T12:01:00.000Z"),
      authUserId: null,
      replayed,
    })),
  };
}

describe("resend webhook booking-inquiry fan-in", () => {
  it("marks matching inquiries undeliverable on a permanent bounce", async () => {
    const markBookingInquirerUndeliverable = vi.fn(async () => ({
      stamped: 2,
    }));

    const result = await handleResendWebhookPayload({
      payload: {
        id: "evt_bounce",
        type: "email.bounced",
        created_at: "2026-09-05T12:00:00.000Z",
        data: { to: ["Jo@Example.com"], bounce: { type: "Permanent" } },
      },
      deliverability: makeDeliverability(),
      logger: makeLogger(),
      markBookingInquirerUndeliverable,
    });

    expect(markBookingInquirerUndeliverable).toHaveBeenCalledWith({
      email: "jo@example.com",
      status: "BOUNCED",
      occurredAt: new Date("2026-09-05T12:00:00.000Z"),
    });
    expect(result.bookingInquiriesStamped).toBe(2);
  });

  it("fans a complaint in as COMPLAINED", async () => {
    const markBookingInquirerUndeliverable = vi.fn(async () => ({
      stamped: 1,
    }));

    await handleResendWebhookPayload({
      payload: {
        id: "evt_complaint",
        type: "email.complained",
        created_at: "2026-09-05T12:00:00.000Z",
        data: { to: ["jo@example.com"] },
      },
      deliverability: makeDeliverability(),
      logger: makeLogger(),
      markBookingInquirerUndeliverable,
    });

    expect(markBookingInquirerUndeliverable).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLAINED" }),
    );
  });

  it("still fans in on a REPLAYED event (the stamp is idempotent + monotonic)", async () => {
    // Skipping replays would lose the fan-in entirely for every event already
    // delivered before this code shipped.
    const markBookingInquirerUndeliverable = vi.fn(async () => ({
      stamped: 1,
    }));

    await handleResendWebhookPayload({
      payload: {
        id: "evt_replay",
        type: "email.bounced",
        created_at: "2026-09-05T12:00:00.000Z",
        data: { to: ["jo@example.com"], bounce: { type: "Permanent" } },
      },
      deliverability: makeDeliverability(true),
      logger: makeLogger(),
      markBookingInquirerUndeliverable,
    });

    expect(markBookingInquirerUndeliverable).toHaveBeenCalledOnce();
  });

  it("is not called for an unsupported event type", async () => {
    const markBookingInquirerUndeliverable = vi.fn(async () => ({
      stamped: 0,
    }));

    const result = await handleResendWebhookPayload({
      payload: { id: "evt_open", type: "email.opened", data: {} },
      deliverability: makeDeliverability(),
      logger: makeLogger(),
      markBookingInquirerUndeliverable,
    });

    expect(result.ignored).toBe(true);
    expect(markBookingInquirerUndeliverable).not.toHaveBeenCalled();
  });

  it("reaches the fan-in through the SIGNED ROUTE when repos are wired", async () => {
    const markInquirerEmailUndeliverable = vi.fn(async () => 1);
    const app = await makeWebhookApp({
      secret: webhookSecret,
      deliverability: makeDeliverabilityPort(),
      markInquirerEmailUndeliverable,
    });
    const payload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-09-05T10:00:00.000Z",
      data: { email: "jo@example.com", bounce: { type: "Permanent" } },
    });

    await postSignedResend(app, payload, "msg_svix_fanin");

    expect(markInquirerEmailUndeliverable).toHaveBeenCalledWith({
      contactEmail: "jo@example.com",
      status: "BOUNCED",
      at: new Date("2026-09-05T10:00:00.000Z"),
    });
  });

  it("still ACKs 200 when the deps bag has no tRPC repos at all", async () => {
    // Regression guard: reaching into `app.deps.trpc.repos` from inside the
    // handler used to 500 every signed request on a narrow deps bag. The
    // fan-in is OPTIONAL; a bounce webhook must never fail because of it.
    const app = await makeWebhookApp({
      secret: webhookSecret,
      deliverability: makeDeliverabilityPort(),
    });
    const payload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-09-05T10:00:00.000Z",
      data: { email: "jo@example.com", bounce: { type: "Permanent" } },
    });

    await postSignedResend(app, payload, "msg_svix_no_repos");
  });

  it("omits the counter entirely when no fan-in is wired (existing callers)", async () => {
    const result = await handleResendWebhookPayload({
      payload: {
        id: "evt_no_fanin",
        type: "email.bounced",
        created_at: "2026-09-05T12:00:00.000Z",
        data: { to: ["jo@example.com"], bounce: { type: "Permanent" } },
      },
      deliverability: makeDeliverability(),
      logger: makeLogger(),
    });

    expect(result).toEqual({
      recorded: 1,
      replayed: 0,
      ignored: false,
      eventType: "email.bounced",
    });
  });
});

function signSvixPayload(input: { payload: string; id: string }) {
  const timestamp = new Date();
  return {
    "svix-id": input.id,
    "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
    "svix-signature": new Webhook(webhookSecret).sign(
      input.id,
      timestamp,
      input.payload,
    ),
  };
}

async function postSignedResend(
  app: Awaited<ReturnType<typeof makeWebhookApp>>,
  payload: string,
  id: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/resend",
    headers: {
      ...signSvixPayload({ payload, id }),
      "content-type": "application/json",
    },
    payload,
  });

  expect(response.statusCode).toBe(200);
}
