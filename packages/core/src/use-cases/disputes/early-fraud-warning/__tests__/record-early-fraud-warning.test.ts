import { describe, expect, it, vi } from "vitest";

import type { EarlyFraudWarningRecord } from "@th/ports/repos/early-fraud-warnings";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { HumanWithIdentity } from "@th/types/repos/humans";

import { maskEmail } from "../notify-early-fraud-warning";
import { recordEarlyFraudWarning } from "../record-early-fraud-warning";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const STRIPE_CREATED_AT = new Date("2026-09-02T11:58:00.000Z");
const ORDER_ID = "11111111-1111-4111-8111-1111abcdef12";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const BUYER_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const HUMAN_OWNER_ID = "55555555-5555-4555-8555-555555555555";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    stripeEventId: "evt_efw_1",
    stripeEventType: "radar.early_fraud_warning.created",
    stripeEfwId: "issfr_123",
    stripeChargeId: "ch_123",
    paymentIntentId: "pi_123",
    fraudType: "made_with_stolen_card",
    actionable: true,
    stripeCreatedAt: STRIPE_CREATED_AT,
    ...overrides,
  };
}

function buildOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    kind: "TICKETING",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 5_000,
    currency: "usd",
    status: "SUCCEEDED",
    stripePaymentIntentId: "pi_123",
    items: [],
    ...overrides,
  } as OrderRecord;
}

function buildEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Rock Show",
    ...overrides,
  } as EventRecord;
}

function identity(
  id: string,
  email: string,
  extra: { name?: string; username?: string | null } = {},
): HumanWithIdentity {
  return {
    human: { id, name: extra.name ?? "Some Human" },
    identity: {
      authUserId: `auth_${id}`,
      email,
      emailVerified: true,
      phone: null,
      phoneVerified: false,
      username: extra.username ?? null,
      displayUsername: extra.username ?? null,
      image: null,
    },
  } as HumanWithIdentity;
}

function makeDeps(options: {
  order?: OrderRecord | null;
  event?: EventRecord | null;
  existing?: EarlyFraudWarningRecord | null;
  discordAlert?: ReturnType<typeof vi.fn> | null;
  humans?: Map<string, HumanWithIdentity>;
  splitsPayeeId?: string;
  payeeSubject?: { subjectType: "ORGANIZATION" | "HUMAN"; subjectId: string };
} = {}) {
  const order = options.order === undefined ? buildOrder() : options.order;
  const event = options.event === undefined ? buildEvent() : options.event;
  const rows = new Map<string, EarlyFraudWarningRecord>();
  if (options.existing) rows.set(options.existing.stripeEfwId, options.existing);
  let nextId = 1;
  const humans =
    options.humans ??
    new Map<string, HumanWithIdentity>([
      [BUYER_ID, identity(BUYER_ID, "jane@example.com", { name: "Jane Buyer" })],
    ]);

  const audit = vi.fn(async () => undefined);
  const upsertFromStripe = vi.fn(async (input) => {
    const existing = rows.get(input.stripeEfwId);
    const record: EarlyFraudWarningRecord = {
      id: existing?.id ?? `efw_${nextId++}`,
      stripeEfwId: input.stripeEfwId,
      stripeChargeId: input.stripeChargeId,
      paymentIntentId: input.paymentIntentId ?? existing?.paymentIntentId ?? null,
      orderId: input.orderId ?? existing?.orderId ?? null,
      ownerOrgId: input.ownerOrgId ?? existing?.ownerOrgId ?? null,
      ownerHumanId: input.ownerHumanId ?? existing?.ownerHumanId ?? null,
      fraudType: input.fraudType,
      actionable: input.actionable,
      stripeCreatedAt: input.stripeCreatedAt,
      resolvedAt: existing?.resolvedAt ?? null,
      resolution: existing?.resolution ?? null,
      createdAt: existing?.createdAt ?? NOW,
      updatedAt: NOW,
    };
    rows.set(record.stripeEfwId, record);
    return record;
  });

  const txRepos = {
    earlyFraudWarnings: {
      findByStripeEfwId: vi.fn(async (id: string) => rows.get(id) ?? null),
      upsertFromStripe,
    },
    orders: {
      getById: vi.fn(async (id: string) => (order && order.id === id ? order : null)),
      findByPaymentIntent: vi.fn(async (pi: string) =>
        order && order.stripePaymentIntentId === pi
          ? { id: order.id, status: order.status }
          : null,
      ),
    },
    events: {
      getById: vi.fn(async (id: string) => (event && event.id === id ? event : null)),
    },
    splits: {
      getForOrder: vi.fn(async () =>
        options.splitsPayeeId
          ? [{ payeeId: options.splitsPayeeId, amountCents: 4_000 }]
          : [],
      ),
    },
    payees: {
      getById: vi.fn(async () =>
        options.payeeSubject
          ? { id: options.splitsPayeeId, ...options.payeeSubject }
          : null,
      ),
    },
    audit: { log: audit },
  } as unknown as TxRepos;

  const organizations = {
    getById: vi.fn(async (id: string) =>
      id === ORG_ID ? { id, name: "Drkmttr Collective", slug: "drkmttr" } : null,
    ),
  };
  const humansRepo = {
    getByIdWithIdentity: vi.fn(async (id: string) => humans.get(id) ?? null),
  };
  const repos = {
    ...txRepos,
    organizations,
    humans: humansRepo,
    tx: vi.fn(async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos)),
  } as unknown as Repos;

  const discordAlert =
    options.discordAlert === undefined ? vi.fn(async () => undefined) : options.discordAlert;
  const reportError = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };

  return {
    deps: {
      repos,
      clock: { now: () => NOW },
      logger: logger as never,
      reportError,
      discordAlert: discordAlert as never,
      publicAppUrl: "https://ithasfire.com/",
    },
    rows,
    audit,
    upsertFromStripe,
    discordAlert,
    reportError,
    logger,
    organizations,
    humans: humansRepo,
  };
}

function alertFields(ctx: ReturnType<typeof makeDeps>) {
  const call = ctx.discordAlert!.mock.calls[0]?.[0] as {
    title: string;
    colour: string;
    description: string;
    fields: Array<{ name: string; value: string }>;
  };
  return {
    ...call,
    field: (name: string) => call.fields.find((f) => f.name === name)?.value,
  };
}

describe("maskEmail", () => {
  it("keeps the first character and the domain only", () => {
    expect(maskEmail("jane@example.com")).toBe("j***@example.com");
    expect(maskEmail("j@example.com")).toBe("j***@example.com");
  });
  it("degrades to unknown for missing or malformed addresses", () => {
    expect(maskEmail(null)).toBe("unknown");
    expect(maskEmail("")).toBe("unknown");
    expect(maskEmail("@example.com")).toBe("unknown");
    expect(maskEmail("jane@")).toBe("unknown");
    expect(maskEmail("no-at-sign")).toBe("unknown");
  });
});

describe("recordEarlyFraudWarning", () => {
  it("persists, links to the order/owner, audits, and alerts ops with a masked buyer email and the org refund link", async () => {
    const ctx = makeDeps();

    const result = await recordEarlyFraudWarning(ctx.deps, baseInput());

    expect(result).toEqual({
      ok: true,
      earlyFraudWarningId: "efw_1",
      stripeEfwId: "issfr_123",
      orderId: ORDER_ID,
      ownerOrgId: ORG_ID,
      ownerHumanId: null,
      actionable: true,
      created: true,
      alerted: true,
    });
    expect(ctx.upsertFromStripe).toHaveBeenCalledWith({
      stripeEfwId: "issfr_123",
      stripeChargeId: "ch_123",
      paymentIntentId: "pi_123",
      orderId: ORDER_ID,
      ownerOrgId: ORG_ID,
      ownerHumanId: null,
      fraudType: "made_with_stolen_card",
      actionable: true,
      stripeCreatedAt: STRIPE_CREATED_AT,
    });
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    expect(ctx.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "early_fraud_warning",
        entityId: "efw_1",
        action: "early_fraud_warning.recorded",
        at: NOW,
        data: expect.objectContaining({
          stripeEventId: "evt_efw_1",
          stripeEfwId: "issfr_123",
          orderId: ORDER_ID,
          ownerOrgId: ORG_ID,
          fraudType: "made_with_stolen_card",
          unresolvedReason: null,
        }),
      }),
    );

    expect(ctx.discordAlert).toHaveBeenCalledTimes(1);
    const alert = alertFields(ctx);
    expect(alert.title).toBe("Early fraud warning — refund now to avoid a chargeback");
    expect(alert.colour).toBe("warning");
    expect(alert.description).toContain("made_with_stolen_card");
    expect(alert.description).toContain("organizer has not been notified");
    expect(alert.field("Order")).toBe("#ABCDEF12");
    expect(alert.field("Amount")).toBe("$50.00");
    expect(alert.field("Fraud type")).toBe("made_with_stolen_card");
    expect(alert.field("Buyer")).toBe("j***@example.com");
    expect(alert.field("Event")).toBe("Rock Show");
    expect(alert.field("Owner")).toBe("Drkmttr Collective");
    expect(alert.field("Actionable")).toBe("yes");
    expect(alert.field("Charge")).toBe("ch_123");
    expect(alert.field("Refund")).toBe(
      "https://ithasfire.com/admin/drkmttr/orders?q=ABCDEF12",
    );
    expect(alert.field("Platform view")).toBe(
      `https://ithasfire.com/platform/orders?orderId=${ORDER_ID}`,
    );
    // The full address never reaches the alert channel.
    expect(JSON.stringify(ctx.discordAlert!.mock.calls[0])).not.toContain(
      "jane@example.com",
    );
  });

  it("replay: refreshes the row and audits, but never alerts a second time", async () => {
    const ctx = makeDeps();
    await recordEarlyFraudWarning(ctx.deps, baseInput());

    const replay = await recordEarlyFraudWarning(
      ctx.deps,
      baseInput({
        stripeEventId: "evt_efw_1_replay",
        stripeEventType: "radar.early_fraud_warning.updated",
        actionable: false,
      }),
    );

    expect(replay).toMatchObject({
      earlyFraudWarningId: "efw_1",
      created: false,
      alerted: false,
      actionable: false,
    });
    expect(ctx.rows.get("issfr_123")).toMatchObject({
      actionable: false,
      orderId: ORDER_ID,
    });
    expect(ctx.discordAlert).toHaveBeenCalledTimes(1);
    expect(ctx.audit).toHaveBeenCalledTimes(2);
    expect(ctx.audit.mock.calls[1]?.[0]).toMatchObject({
      action: "early_fraud_warning.refreshed",
    });
  });

  it("unlinked charge: stores a row with no order and still alerts as unlinked", async () => {
    const ctx = makeDeps({ order: null, event: null });

    const result = await recordEarlyFraudWarning(
      ctx.deps,
      baseInput({ paymentIntentId: "pi_unknown" }),
    );

    expect(result).toMatchObject({
      orderId: null,
      ownerOrgId: null,
      ownerHumanId: null,
      created: true,
      alerted: true,
    });
    expect(ctx.audit.mock.calls[0]?.[0]).toMatchObject({
      data: expect.objectContaining({ unresolvedReason: "order_not_found" }),
    });
    const alert = alertFields(ctx);
    expect(alert.field("Order")).toBe("unlinked");
    expect(alert.field("Amount")).toBe("unknown");
    expect(alert.field("Buyer")).toBe("unlinked");
    expect(alert.field("Event")).toBe("unlinked");
    expect(alert.field("Owner")).toBe("unlinked");
    expect(alert.field("Refund")).toBe("n/a");
    expect(alert.field("Platform view")).toBeUndefined();
    expect(alert.description).toContain("Stripe Dashboard");
  });

  it("a throwing Discord alert is swallowed and reported; the row and audit still commit", async () => {
    const discordAlert = vi.fn(async () => {
      throw new Error("discord down");
    });
    const ctx = makeDeps({ discordAlert });

    const result = await recordEarlyFraudWarning(ctx.deps, baseInput());

    expect(result).toMatchObject({ created: true, alerted: false });
    expect(ctx.rows.get("issfr_123")).toBeDefined();
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    expect(ctx.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "early_fraud_warning_notify", stage: "ops_alert" },
      }),
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "early_fraud_warning.ops_alert_failed",
      expect.objectContaining({ stripeEfwId: "issfr_123" }),
    );
  });

  it("no Discord sink configured: records without alerting", async () => {
    const ctx = makeDeps({ discordAlert: null });
    const result = await recordEarlyFraudWarning(ctx.deps, baseInput());
    expect(result).toMatchObject({ created: true, alerted: false });
  });

  it("human-owned event: owner is the human and the refund link uses the @username admin slug", async () => {
    const humans = new Map<string, HumanWithIdentity>([
      [BUYER_ID, identity(BUYER_ID, "jane@example.com")],
      [
        HUMAN_OWNER_ID,
        identity(HUMAN_OWNER_ID, "owner@example.com", {
          name: "Solo Promoter",
          username: "solo",
        }),
      ],
    ]);
    const ctx = makeDeps({
      event: buildEvent({ orgId: null, humanId: HUMAN_OWNER_ID }),
      humans,
    });

    const result = await recordEarlyFraudWarning(ctx.deps, baseInput());

    expect(result).toMatchObject({ ownerOrgId: null, ownerHumanId: HUMAN_OWNER_ID });
    const alert = alertFields(ctx);
    expect(alert.field("Owner")).toBe("Solo Promoter");
    expect(alert.field("Refund")).toBe(
      "https://ithasfire.com/admin/@solo/orders?q=ABCDEF12",
    );
  });

  it("membership order: owner comes from the single positive-split payee", async () => {
    const ctx = makeDeps({
      order: buildOrder({ kind: "MEMBERSHIP", eventId: null }),
      event: null,
      splitsPayeeId: "payee_org",
      payeeSubject: { subjectType: "ORGANIZATION", subjectId: ORG_ID },
    });

    const result = await recordEarlyFraudWarning(ctx.deps, baseInput());

    expect(result).toMatchObject({ orderId: ORDER_ID, ownerOrgId: ORG_ID });
    const alert = alertFields(ctx);
    expect(alert.field("Event")).toBe("Membership order");
    // The org orders panel throws EXPECTED_TICKETING_ORDER for memberships,
    // so the alert must not send ops to a page that cannot open the order.
    expect(alert.field("Refund")).toBe("n/a");
    expect(alert.description).toContain("Stripe Dashboard");
    expect(alert.description).toContain("Membership invoice");
    // The platform view still links (it lists memberships).
    expect(alert.field("Platform view")).toBe(
      `https://ithasfire.com/platform/orders?orderId=${ORDER_ID}`,
    );
  });

  it("metadata eventId that disagrees with the order links the order but withholds the owner (mirrors the dispute resolver)", async () => {
    const ctx = makeDeps();

    const result = await recordEarlyFraudWarning(
      ctx.deps,
      baseInput({ metadataEventId: "99999999-9999-4999-8999-999999999999" }),
    );

    expect(result).toMatchObject({
      orderId: ORDER_ID,
      ownerOrgId: null,
      ownerHumanId: null,
    });
    expect(ctx.upsertFromStripe).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, ownerOrgId: null, ownerHumanId: null }),
    );
    expect(ctx.audit.mock.calls[0]?.[0]).toMatchObject({
      data: expect.objectContaining({ unresolvedReason: "metadata_event_mismatch" }),
    });
    const alert = alertFields(ctx);
    expect(alert.field("Order")).toBe("#ABCDEF12");
    expect(alert.field("Owner")).toBe("unlinked");
    expect(alert.field("Refund")).toBe("n/a");
  });

  it("a matching metadata eventId links normally", async () => {
    const ctx = makeDeps();
    const result = await recordEarlyFraudWarning(
      ctx.deps,
      baseInput({ metadataEventId: EVENT_ID }),
    );
    expect(result).toMatchObject({ orderId: ORDER_ID, ownerOrgId: ORG_ID });
  });

  it("falls back to the local dev origin when no public app URL is configured", async () => {
    const ctx = makeDeps();
    const result = await recordEarlyFraudWarning(
      { ...ctx.deps, publicAppUrl: null },
      baseInput(),
    );
    expect(result.alerted).toBe(true);
    expect(alertFields(ctx).field("Refund")).toBe(
      "http://127.0.0.1:3000/admin/drkmttr/orders?q=ABCDEF12",
    );
  });

  it("buyer lookup failure degrades the field and reports, without blocking the alert", async () => {
    const ctx = makeDeps();
    ctx.humans.getByIdWithIdentity.mockImplementation(async () => {
      throw new Error("humans down");
    });

    const result = await recordEarlyFraudWarning(ctx.deps, baseInput());

    expect(result.alerted).toBe(true);
    expect(alertFields(ctx).field("Buyer")).toBe("unknown");
    expect(ctx.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "early_fraud_warning_notify", stage: "buyer" },
      }),
    );
  });

  it("rejects an unknown key at the boundary", async () => {
    const ctx = makeDeps();
    await expect(
      recordEarlyFraudWarning(ctx.deps, baseInput({ surprise: true })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ctx.upsertFromStripe).not.toHaveBeenCalled();
  });
});
