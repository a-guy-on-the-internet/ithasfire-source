import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { Webhook } from "svix";

import {
  handleResendWebhookPayload,
  parseResendDeliveryEvents,
} from "../src/routes/resend/webhook";

const webhookSecret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

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
  });

  await app.register(rawBody);
  await app.register(resendWebhook);

  return app;
}

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
