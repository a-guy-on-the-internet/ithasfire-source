import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import {
  notifyDisputeLifecycle,
  type DisputeLifecycleNotificationContext,
} from "../notify-dispute-lifecycle";
import { renderStoredNotification } from "../../comms/render-stored-notification";

// The risk-owner in-app row is written directly (not through `notify`). Its
// English title/body are pinned EXACTLY as they were before the row started
// carrying a template, per branch, together with the email (which reuses the
// body and must not change). The Spanish re-render is pinned in
// comms/__tests__/notification-copy-locale-direct-a.test.ts.

const OWNER_ID = "owner-human";
const NOW = new Date("2026-03-10T12:00:00Z");

type Overrides = {
  operation?: DisputeLifecycleNotificationContext["operation"];
  status?: string;
  membership?: boolean;
  eventTitle?: string | null;
  feeCents?: number;
  evidenceDueBy?: Date | null;
  lossRecovery?: DisputeLifecycleNotificationContext["lossRecovery"];
};

function makeContext(o: Overrides = {}): DisputeLifecycleNotificationContext {
  const membership = o.membership ?? false;
  const eventTitle =
    o.eventTitle === undefined ? (membership ? null : "Spring Gala") : o.eventTitle;
  return {
    operation: o.operation ?? "open",
    input: { stripeEventId: "evt_1" },
    dispute: {
      id: "dispute_1",
      stripeDisputeId: "dp_123",
      status: o.status ?? "OPEN",
      orderId: "order_1",
      ownerOrgId: null,
      ownerHumanId: OWNER_ID,
      amountCents: 5000,
      currency: "usd",
      feeCents: o.feeCents ?? 1500,
      reason: "fraudulent",
      triageReason: null,
      evidenceDueBy:
        o.evidenceDueBy === undefined
          ? new Date("2026-03-24T12:00:00Z")
          : o.evidenceDueBy,
    },
    order: { id: "order_1", kind: membership ? "MEMBERSHIP" : "TICKET" },
    event: eventTitle === null ? null : { id: "event_1", title: eventTitle },
    lossRecovery: o.lossRecovery ?? null,
  } as unknown as DisputeLifecycleNotificationContext;
}

function makeDeps() {
  const create = vi.fn(async (_input: CreateNotificationInput) => ({
    id: "n1",
    createdAt: NOW,
  }));
  const send = vi.fn(async (_m: { subject: string; text: string }) => ({
    result: { success: true },
  }));
  const repos = {
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        human: { name: "Owner One" },
        identity: { email: "owner@example.com", displayUsername: null },
      })),
    },
    notifications: { create },
  } as unknown as Repos;
  return {
    deps: {
      repos,
      mailer: { send } as unknown as MailerPort,
      publicAppUrl: "https://ithasfire.com",
    },
    create,
    send,
  };
}

async function run(o: Overrides) {
  const { deps, create, send } = makeDeps();
  await notifyDisputeLifecycle(deps, makeContext(o));
  expect(create).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  return { row: create.mock.calls[0]![0], mail: send.mock.calls[0]![0] };
}

const CASES: ReadonlyArray<{
  name: string;
  o: Overrides;
  title: string;
  body: string;
  kind: string;
  subject: string;
}> = [
  {
    name: "opened",
    o: {},
    title: "Dispute opened",
    body: "A buyer dispute was opened for Spring Gala. Ithas Fire is holding the affected payout share while the bank reviews the dispute. Evidence is due Mar 24, 2026.",
    kind: "WARNING",
    subject: "[Dispute] $50.00 on Spring Gala - payout held, evidence due Mar 24, 2026",
  },
  {
    name: "opened, no evidence date",
    o: { evidenceDueBy: null },
    title: "Dispute opened",
    body: "A buyer dispute was opened for Spring Gala. Ithas Fire is holding the affected payout share while the bank reviews the dispute. Evidence is due not provided.",
    kind: "WARNING",
    subject: "[Dispute] $50.00 on Spring Gala - payout held, evidence due not provided",
  },
  {
    name: "opened, membership",
    o: { membership: true },
    title: "Dispute opened",
    body: "A buyer dispute was opened for your membership. Ithas Fire is holding the affected payout share while the bank reviews the dispute. Evidence is due Mar 24, 2026.",
    kind: "WARNING",
    subject: "[Dispute] $50.00 on your membership - payout held, evidence due Mar 24, 2026",
  },
  {
    name: "under review",
    o: { operation: "refresh", status: "UNDER_REVIEW" },
    title: "Dispute under review",
    body: "The buyer dispute for Spring Gala is under review. The affected payout share remains held while the bank reviews the dispute.",
    kind: "WARNING",
    subject: "[Dispute] $50.00 on Spring Gala - under review",
  },
  {
    name: "funds withdrawn",
    o: { operation: "funds_withdrawn", status: "OPEN" },
    title: "Dispute funds withdrawn",
    body: "Stripe has withdrawn funds for the dispute on Spring Gala. The affected payout share remains held while the bank reviews the dispute.",
    kind: "WARNING",
    subject: "[Dispute] $50.00 on Spring Gala - funds withdrawn",
  },
  {
    name: "won",
    o: { operation: "close", status: "WON" },
    title: "Dispute won",
    body: "The dispute for Spring Gala was won. Nothing will be deducted from your payouts for it. Any hold on the affected payout share has been released, and any amount already deducted for this dispute has been credited back.",
    kind: "SUCCESS",
    subject: "[Dispute] $50.00 on Spring Gala - won",
  },
  {
    name: "lost, ticketing, debited",
    o: {
      operation: "close",
      status: "LOST",
      lossRecovery: { principalDebited: true, feeDebited: false },
    },
    title: "Dispute lost",
    body: "The dispute for Spring Gala was lost. The disputed amount will be deducted from your upcoming payouts. The card network's dispute fee is not passed on to you.",
    kind: "ERROR",
    subject: "[Dispute] $50.00 on Spring Gala - lost",
  },
  {
    name: "lost, ticketing, legacy caller (no outcome)",
    o: { operation: "close", status: "LOST" },
    title: "Dispute lost",
    body: "The dispute for Spring Gala was lost. The disputed amount will be deducted from your upcoming payouts. The card network's dispute fee is not passed on to you.",
    kind: "ERROR",
    subject: "[Dispute] $50.00 on Spring Gala - lost",
  },
  {
    name: "lost, ticketing, nothing debited",
    o: {
      operation: "close",
      status: "LOST",
      lossRecovery: { principalDebited: false, feeDebited: false },
    },
    title: "Dispute lost",
    body: "The dispute for Spring Gala was lost. Nothing further will be deducted from your payouts for this dispute. The card network's dispute fee is not passed on to you.",
    kind: "ERROR",
    subject: "[Dispute] $50.00 on Spring Gala - lost",
  },
  {
    name: "lost, membership, debited with fee",
    o: {
      operation: "close",
      status: "LOST",
      membership: true,
      lossRecovery: { principalDebited: true, feeDebited: true },
    },
    title: "Dispute lost",
    body: "The dispute for your membership was lost. The disputed amount plus the card network's dispute fee will be deducted from your upcoming payouts.",
    kind: "ERROR",
    subject: "[Dispute] $50.00 on your membership - lost",
  },
  {
    name: "lost, membership, debited, no fee",
    o: {
      operation: "close",
      status: "LOST",
      membership: true,
      feeCents: 0,
      lossRecovery: { principalDebited: true, feeDebited: false },
    },
    title: "Dispute lost",
    body: "The dispute for your membership was lost. The disputed amount will be deducted from your upcoming payouts.",
    kind: "ERROR",
    subject: "[Dispute] $50.00 on your membership - lost",
  },
  {
    name: "lost, membership, fee only",
    o: {
      operation: "close",
      status: "LOST",
      membership: true,
      lossRecovery: { principalDebited: false, feeDebited: true },
    },
    title: "Dispute lost",
    body: "The dispute for your membership was lost. Nothing further will be deducted from your payouts for the disputed amount. The card network's dispute fee will be deducted from your upcoming payouts.",
    kind: "ERROR",
    subject: "[Dispute] $50.00 on your membership - lost",
  },
  {
    name: "lost, membership, nothing debited",
    o: {
      operation: "close",
      status: "LOST",
      membership: true,
      lossRecovery: { principalDebited: false, feeDebited: false },
    },
    title: "Dispute lost",
    body: "The dispute for your membership was lost. Nothing further will be deducted from your payouts for the disputed amount.",
    kind: "ERROR",
    subject: "[Dispute] $50.00 on your membership - lost",
  },
];

describe("dispute risk-owner in-app row: English pinned", () => {
  it.each(CASES)("$name", async ({ o, title, body, kind, subject }) => {
    const { row, mail } = await run(o);
    expect(row).toEqual(
      expect.objectContaining({ humanId: OWNER_ID, title, body, kind }),
    );
    expect(row.action).toBeUndefined();
    expect(mail.subject).toBe(subject);
    expect(mail.text.split("\n")[0]).toBe(body);
  });
});

function stored(row: CreateNotificationInput) {
  return {
    id: "n1",
    title: row.title ?? null,
    body: row.body,
    action: row.action ?? null,
    metadata: row.metadata ?? null,
    templateKey: row.template?.key ?? null,
    templateVersion: row.template?.version ?? null,
    templateVariables: row.template?.variables ?? null,
    createdAt: NOW,
  };
}

describe("dispute risk-owner in-app row: stored template, re-rendered in Spanish", () => {
  it("stores the variant next to the existing metadata", async () => {
    const { row } = await run({});
    expect(row.template).toEqual({
      key: "dispute.risk-owner-notice",
      version: "1",
      variables: {
        disputeId: "dispute_1",
        notice: "opened",
        eventTitle: "Spring Gala",
        isMembership: false,
        evidenceDueIso: "2026-03-24T12:00:00.000Z",
        lostOutcome: null,
      },
    });
    expect(row.metadata).toEqual(
      expect.objectContaining({
        variant: "dispute.risk-owner-notice",
        disputeId: "dispute_1",
        status: "OPEN",
      }),
    );
  });

  it("opened → Spanish", async () => {
    const { row } = await run({});
    const es = renderStoredNotification({}, stored(row), "es");
    expect(es.title).toBe("Se abrió una disputa");
    expect(es.body).toBe(
      "Quien compró abrió una disputa sobre Spring Gala. Ithas Fire retiene la parte del pago afectada mientras el banco revisa la disputa. La evidencia se debe presentar a más tardar el martes 24 de marzo de 2026.",
    );
  });

  it.each([
    [
      { lossRecovery: { principalDebited: true, feeDebited: false } },
      "ticketing_debited",
    ],
    [
      { lossRecovery: { principalDebited: false, feeDebited: false } },
      "ticketing_not_debited",
    ],
    [
      { membership: true, lossRecovery: { principalDebited: true, feeDebited: true } },
      "membership_debited_with_fee",
    ],
    [
      {
        membership: true,
        feeCents: 0,
        lossRecovery: { principalDebited: true, feeDebited: false },
      },
      "membership_debited",
    ],
    [
      { membership: true, lossRecovery: { principalDebited: false, feeDebited: true } },
      "membership_fee_debited",
    ],
    [
      { membership: true, lossRecovery: { principalDebited: false, feeDebited: false } },
      "membership_not_debited",
    ],
  ] as const)("lost outcome %j → %s", async (o, outcome) => {
    const { row } = await run({ operation: "close", status: "LOST", ...o });
    expect(row.template?.variables).toMatchObject({
      notice: "lost",
      lostOutcome: outcome,
    });
  });

  it("lost, membership, fee only → Spanish keeps the same claim", async () => {
    const { row } = await run({
      operation: "close",
      status: "LOST",
      membership: true,
      lossRecovery: { principalDebited: false, feeDebited: true },
    });
    const es = renderStoredNotification({}, stored(row), "es");
    expect(es.title).toBe("Disputa perdida");
    expect(es.body).toBe(
      "La disputa sobre tu membresía se resolvió en tu contra. No se descontará nada más de tus pagos por el monto en disputa. La comisión por disputa de la red de tarjetas se descontará de tus próximos pagos.",
    );
  });
});
