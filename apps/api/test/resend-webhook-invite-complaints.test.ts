import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { Webhook } from "svix";

import {
  handleResendWebhookPayload,
  parseResendDeliveryEvents,
} from "../src/routes/resend/webhook";

/**
 * Invite complaint auto-pause (W4), webhook side: Resend echoes the invite's
 * `meta_*` tags on `email.complained`; the route reads them back as metadata
 * and fans the complaint in to core `recordInviteComplaint`. Separate file so
 * the existing resend-webhook suite stays untouched.
 */

// Self-signing fixture (same construction as resend-webhook.test.ts): base64
// of readable text, never a real secret.
const webhookSecret = "whsec_Z2l0bGVha3MtZmFrZS1ub3QtYS1yZWFsLXNlY3JldA==";
const ORG_ID = "10000000-0000-4000-8000-000000000001";
const EVENT_ID = "20000000-0000-4000-8000-000000000002";
const OPT_OUT_SECRET = "o".repeat(48);

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_n: string, fn: () => Promise<unknown>) => await fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

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
      processedAt: new Date("2026-10-07T12:01:00.000Z"),
      authUserId: null,
      replayed,
    })),
  };
}

const complainedPayload = (tags: unknown, id = "evt_c1") => ({
  id,
  type: "email.complained",
  created_at: "2026-10-07T12:00:00.000Z",
  data: { to: ["Ana@Example.com"], tags },
});

describe("parseResendDeliveryEvents: tags → metadata", () => {
  it("reads the object-map tags Resend sends, keeps only meta_* (prefix stripped)", () => {
    const [event] = parseResendDeliveryEvents(
      complainedPayload({
        meta_inviteOwner: `org-${ORG_ID}`,
        meta_inviteEvent: EVENT_ID,
        tag_digest: "1",
        category: "invite",
      }),
    );
    expect(event?.metadata).toEqual({
      inviteOwner: `org-${ORG_ID}`,
      inviteEvent: EVENT_ID,
    });
  });

  it("also accepts an array of { name, value }", () => {
    const [event] = parseResendDeliveryEvents(
      complainedPayload([{ name: "meta_inviteOwner", value: `org-${ORG_ID}` }]),
    );
    expect(event?.metadata).toEqual({ inviteOwner: `org-${ORG_ID}` });
  });

  it("no metadata key at all when there are no meta_* tags (existing shape)", () => {
    const [event] = parseResendDeliveryEvents(complainedPayload(undefined));
    expect(event).not.toHaveProperty("metadata");
  });

  it("drops non-string and oversized values, and keeps __proto__ a plain key", () => {
    const [event] = parseResendDeliveryEvents(
      complainedPayload({
        meta_a: 1,
        meta_b: "x".repeat(257),
        meta___proto__: "polluted",
        meta_ok: "fine",
      }),
    );
    expect(event?.metadata?.ok).toBe("fine");
    expect(event?.metadata?.a).toBeUndefined();
    expect(event?.metadata?.b).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(event?.metadata ?? {})).toBeNull();
  });
});

describe("handleResendWebhookPayload: invite-complaint fan-in", () => {
  it("passes the complaint + metadata to the fan-in, never metadata to recordProviderEvent", async () => {
    const deliverability = makeDeliverability();
    const recordInviteComplaint = vi.fn(async () => ({ outcome: "RECORDED" }));
    const result = await handleResendWebhookPayload({
      payload: complainedPayload({ meta_inviteOwner: `org-${ORG_ID}` }),
      deliverability,
      logger: makeLogger(),
      recordInviteComplaint,
    });
    expect(recordInviteComplaint).toHaveBeenCalledWith({
      providerEventId: "evt_c1",
      email: "ana@example.com",
      occurredAt: new Date("2026-10-07T12:00:00.000Z"),
      metadata: { inviteOwner: `org-${ORG_ID}` },
    });
    expect(deliverability.recordProviderEvent.mock.calls[0]![0]).not.toHaveProperty(
      "metadata",
    );
    expect(result).toEqual({
      recorded: 1,
      replayed: 0,
      ignored: false,
      eventType: "email.complained",
      inviteComplaintsRecorded: 1,
    });
  });

  it("passes null metadata for an untagged complaint (core decides it's not an invite)", async () => {
    const recordInviteComplaint = vi.fn(async () => ({ outcome: "NOT_AN_INVITE" }));
    const result = await handleResendWebhookPayload({
      payload: complainedPayload(undefined),
      deliverability: makeDeliverability(),
      logger: makeLogger(),
      recordInviteComplaint,
    });
    expect(recordInviteComplaint).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: null }),
    );
    expect(result.inviteComplaintsRecorded).toBe(0);
  });

  it("is not called for a bounce", async () => {
    const recordInviteComplaint = vi.fn(async () => ({ outcome: "RECORDED" }));
    await handleResendWebhookPayload({
      payload: {
        id: "evt_b",
        type: "email.bounced",
        data: {
          to: ["ana@example.com"],
          bounce: { type: "Permanent" },
          tags: { meta_inviteOwner: `org-${ORG_ID}` },
        },
      },
      deliverability: makeDeliverability(),
      logger: makeLogger(),
      recordInviteComplaint,
    });
    expect(recordInviteComplaint).not.toHaveBeenCalled();
  });

  it("still fans in on a REPLAYED event (the complaint write is idempotent)", async () => {
    const recordInviteComplaint = vi.fn(async () => ({ outcome: "RECORDED" }));
    await handleResendWebhookPayload({
      payload: complainedPayload({ meta_inviteOwner: `org-${ORG_ID}` }),
      deliverability: makeDeliverability(true),
      logger: makeLogger(),
      recordInviteComplaint,
    });
    expect(recordInviteComplaint).toHaveBeenCalledOnce();
  });

  it("a transient fan-in failure propagates (the route answers 500 so Svix retries)", async () => {
    await expect(
      handleResendWebhookPayload({
        payload: complainedPayload({ meta_inviteOwner: `org-${ORG_ID}` }),
        deliverability: makeDeliverability(),
        logger: makeLogger(),
        recordInviteComplaint: vi.fn(async () => {
          throw new Error("db down");
        }),
      }),
    ).rejects.toThrow("db down");
  });

  it("omits the counter when no fan-in is wired", async () => {
    const result = await handleResendWebhookPayload({
      payload: complainedPayload({ meta_inviteOwner: `org-${ORG_ID}` }),
      deliverability: makeDeliverability(),
      logger: makeLogger(),
    });
    expect(result).not.toHaveProperty("inviteComplaintsRecorded");
  });
});

async function makeSignedApp(recordComplaintImpl?: () => Promise<unknown>) {
  vi.resetModules();
  process.env.RESEND_WEBHOOK_SECRET = webhookSecret;
  process.env.NODE_ENV = "test";
  const { default: rawBody } = await import("../src/plugins/raw-body");
  const { default: resendWebhook } = await import("../src/routes/resend/webhook");

  const complaints: Array<Record<string, unknown>> = [];
  const optOuts: Array<Record<string, unknown>> = [];
  const reportError = vi.fn();
  const repos = {
    organizations: {
      getById: vi.fn(async (id: string) => (id === ORG_ID ? { id, name: "Org" } : null)),
    },
    humans: { getById: vi.fn(async () => null) },
    events: { getById: vi.fn(async () => null) },
    eventInviteOptOuts: {
      add: vi.fn(async (input: Record<string, unknown>) => {
        optOuts.push(input);
        return { created: true };
      }),
    },
    eventInvitePauses: {
      lockOwner: vi.fn(async () => {}),
      recordComplaint: vi.fn(async (input: Record<string, unknown>) => {
        if (recordComplaintImpl) await recordComplaintImpl();
        complaints.push(input);
        return { created: true };
      }),
      getOpenPause: vi.fn(async () => null),
      getLastLiftedAt: vi.fn(async () => null),
      countDistinctComplainants: vi.fn(async () => 1),
      countInviteRecipients: vi.fn(async () => 500),
      openPause: vi.fn(),
    },
    audit: { log: vi.fn() },
    async tx<T>(fn: (tx: unknown) => Promise<T>) {
      return fn(repos);
    },
  };

  const app = Fastify({ logger: false });
  app.decorate("deps", {
    logger: makeLogger(),
    emailDeliverability: makeDeliverability(),
    trpc: {
      repos,
      clock: { now: () => new Date("2026-10-07T12:00:00.000Z") },
      inviteOptOutSecret: OPT_OUT_SECRET,
      reportError,
    },
  });
  await app.register(rawBody);
  await app.register(resendWebhook);

  const post = async () => {
    const payload = JSON.stringify(
      complainedPayload({
        meta_inviteOwner: `org-${ORG_ID}`,
        meta_inviteEvent: EVENT_ID,
        meta_inviteSentAt: String(Date.parse("2026-10-06T12:00:00.000Z")),
      }),
    );
    const timestamp = new Date();
    return app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: {
        "svix-id": "msg_invite_complaint",
        "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
        "svix-signature": new Webhook(webhookSecret).sign(
          "msg_invite_complaint",
          timestamp,
          payload,
        ),
        "content-type": "application/json",
      },
      payload,
    });
  };
  // Reports from THIS use case only (the booking fan-in, unwired here, also
  // reports on a complaint).
  const inviteReports = () =>
    reportError.mock.calls.filter(
      (call) =>
        (call[1] as { tags?: { useCase?: string } } | undefined)?.tags?.useCase ===
        "recordInviteComplaint",
    );
  return { post, complaints, optOuts, repos, inviteReports };
}

describe("signed route: complaint reaches core recordInviteComplaint", () => {
  it("records the complaint (hash + send time only) and opts the address out", async () => {
    const { post, complaints, optOuts, repos } = await makeSignedApp();
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(complaints).toEqual([
      expect.objectContaining({
        providerEventId: "evt_c1",
        owner: { kind: "ORG", orgId: ORG_ID },
        emailHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        sentAt: new Date("2026-10-06T12:00:00.000Z"),
      }),
    ]);
    expect(JSON.stringify(complaints)).not.toContain("ana@");
    expect(optOuts).toHaveLength(1);
    expect(repos.eventInvitePauses.openPause).not.toHaveBeenCalled();
  });

  it("a transient DB failure answers 500 so Svix retries", async () => {
    const { post, inviteReports } = await makeSignedApp(async () => {
      throw new Error("connection reset");
    });
    const response = await post();
    expect(response.statusCode).toBe(500);
    expect(inviteReports()).toHaveLength(0);
  });

  it("a constraint error a retry can't fix is reported and ACKed (200)", async () => {
    const { post, inviteReports } = await makeSignedApp(async () => {
      throw Object.assign(new Error("check"), { code: "P2004" });
    });
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(inviteReports()).toHaveLength(1);
  });
});
