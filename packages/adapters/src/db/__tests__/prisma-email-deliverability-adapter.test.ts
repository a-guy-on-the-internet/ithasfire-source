import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";

import { PrismaEmailDeliverabilityAdapter } from "../prisma-email-deliverability-adapter";

describe("PrismaEmailDeliverabilityAdapter", () => {
  it("replays provider events by provider and providerEventId", async () => {
    const existingEvent = makeEmailDeliveryEvent({
      provider: "resend",
      providerEventId: "msg_svix_1",
    });
    const findUniqueOrThrow = vi.fn(async () => existingEvent);
    const prisma = {
      $transaction: vi.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed",
          {
            code: "P2002",
            clientVersion: "test",
          },
        );
      }),
      emailDeliveryEvent: { findUniqueOrThrow },
    } as unknown as PrismaClient;
    const adapter = new PrismaEmailDeliverabilityAdapter(prisma);

    const result = await adapter.recordProviderEvent({
      provider: "resend",
      providerEventId: "msg_svix_1",
      eventType: "email.bounced",
      email: "user@example.com",
      status: "BOUNCED",
      occurredAt: new Date("2026-05-25T10:00:00.000Z"),
      payload: { ok: true },
    });

    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        provider_providerEventId: {
          provider: "resend",
          providerEventId: "msg_svix_1",
        },
      },
    });
    expect(result).toMatchObject({
      provider: "resend",
      providerEventId: "msg_svix_1",
      replayed: true,
    });
  });

  it("never re-triggers suppression side effects on a replayed event", async () => {
    // Realistic replay: the tx callback runs, the unique (provider,
    // providerEventId) insert throws P2002, and the transaction aborts
    // before any authUser flagging or bounce-storm counting can happen.
    const update = vi.fn();
    const count = vi.fn(async () => 0);
    const existingEvent = makeEmailDeliveryEvent({
      provider: "resend",
      providerEventId: "msg_svix_replay",
    });
    const tx = {
      authUser: {
        findFirst: vi.fn(async () => ({ id: "user-1", emailVerified: true })),
        update,
      },
      emailDeliveryEvent: {
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed",
            { code: "P2002", clientVersion: "test" },
          );
        }),
        count,
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (cb: (tx: unknown) => Promise<unknown>) => await cb(tx),
      ),
      emailDeliveryEvent: {
        findUniqueOrThrow: vi.fn(async () => existingEvent),
      },
    } as unknown as PrismaClient;
    const adapter = new PrismaEmailDeliverabilityAdapter(prisma);

    const result = await adapter.recordProviderEvent({
      provider: "resend",
      providerEventId: "msg_svix_replay",
      eventType: "email.bounced",
      email: "user@example.com",
      status: "BOUNCED",
      occurredAt: new Date("2026-05-25T10:00:00.000Z"),
      payload: { ok: true },
    });

    expect(result.replayed).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("clears delivery status back to nullable healthy state", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      authUser: { updateMany },
    } as unknown as PrismaClient;
    const adapter = new PrismaEmailDeliverabilityAdapter(prisma);

    await expect(adapter.clearByEmail("User@Example.com")).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { email: { equals: "user@example.com", mode: "insensitive" } },
      data: {
        emailDeliveryStatus: null,
        emailDeliveryStatusAt: null,
        emailDeliveryStatusRef: null,
      },
    });
  });

  it("records the event but skips flagging when the account is unverified", async () => {
    const update = vi.fn();
    const { prisma } = makeTxPrisma({
      authUser: { id: "user-1", emailVerified: false },
      update,
    });
    const adapter = new PrismaEmailDeliverabilityAdapter(prisma);

    const result = await adapter.recordProviderEvent({
      provider: "resend",
      providerEventId: "msg_unverified",
      eventType: "email.bounced",
      email: "user@example.com",
      status: "BOUNCED",
      occurredAt: new Date("2026-05-25T10:00:00.000Z"),
      payload: { ok: true },
    });

    expect(result.replayed).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("flags verified accounts on a permanent bounce", async () => {
    const update = vi.fn();
    const { prisma } = makeTxPrisma({
      authUser: { id: "user-1", emailVerified: true },
      bounceCount: 1,
      update,
    });
    const adapter = new PrismaEmailDeliverabilityAdapter(prisma);

    await adapter.recordProviderEvent({
      provider: "resend",
      providerEventId: "msg_verified",
      eventType: "email.bounced",
      email: "user@example.com",
      status: "BOUNCED",
      occurredAt: new Date("2026-05-25T10:00:00.000Z"),
      payload: { ok: true },
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        emailDeliveryStatus: "BOUNCED",
        emailDeliveryStatusAt: new Date("2026-05-25T10:00:00.000Z"),
        emailDeliveryStatusRef: "msg_verified",
      },
    });
  });

  it("trips the bounce-storm breaker: skips flagging and fires an alert", async () => {
    const update = vi.fn();
    const alert = vi.fn(async () => {});
    const { prisma } = makeTxPrisma({
      authUser: { id: "user-1", emailVerified: true },
      bounceCount: 51,
      update,
    });
    const adapter = new PrismaEmailDeliverabilityAdapter(prisma, {
      alert,
      bounceStormThreshold: 50,
    });

    await adapter.recordProviderEvent({
      provider: "resend",
      providerEventId: "msg_storm",
      eventType: "email.bounced",
      email: "user@example.com",
      status: "BOUNCED",
      occurredAt: new Date("2026-05-25T10:00:00.000Z"),
      payload: { ok: true },
    });

    expect(update).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]?.[0]).toMatchObject({ colour: "error" });
  });

  it("anonymizes delivery events for a deleted user", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "evt-1",
        email: "user@example.com",
        payload: { to: "User@Example.com", reason: "hard bounce" },
      },
    ]);
    const update = vi.fn(async () => ({}));
    const prisma = {
      emailDeliveryEvent: { findMany, update },
    } as unknown as PrismaClient;
    const adapter = new PrismaEmailDeliverabilityAdapter(prisma);

    await expect(adapter.anonymizeForUser("user-1")).resolves.toBe(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: {
        email: "deleted-evt-1@deleted.local",
        authUserId: null,
        payload: { to: "deleted-evt-1@deleted.local", reason: "hard bounce" },
      },
    });
  });
});

/**
 * Builds a prisma mock whose `$transaction` invokes the callback with a tx
 * stub wired for the recordProviderEvent flow (findFirst → create → count →
 * update).
 */
function makeTxPrisma(opts: {
  authUser: { id: string; emailVerified: boolean } | null;
  bounceCount?: number;
  update?: ReturnType<typeof vi.fn>;
}) {
  const update = opts.update ?? vi.fn();
  const tx = {
    authUser: {
      findFirst: vi.fn(async () => opts.authUser),
      update,
    },
    emailDeliveryEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        makeEmailDeliveryEvent({
          providerEventId: String(data.providerEventId),
          eventType: String(data.eventType),
          status: data.status as "DELIVERABLE" | "BOUNCED" | "COMPLAINED",
          authUserId: (data.authUserId as string | null) ?? null,
        }),
      ),
      count: vi.fn(async () => opts.bounceCount ?? 0),
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (cb: (tx: typeof tx) => Promise<unknown>) => await cb(tx),
    ),
  } as unknown as PrismaClient;
  return { prisma, tx, update };
}

function makeEmailDeliveryEvent(
  overrides: Partial<{
    id: string;
    provider: string;
    providerEventId: string;
    eventType: string;
    email: string;
    status: "DELIVERABLE" | "BOUNCED" | "COMPLAINED";
    occurredAt: Date;
    processedAt: Date;
    authUserId: string | null;
  }> = {},
) {
  return {
    id: "delivery-event-1",
    provider: "resend",
    providerEventId: "msg_svix_1",
    eventType: "email.bounced",
    email: "user@example.com",
    status: "BOUNCED" as const,
    occurredAt: new Date("2026-05-25T10:00:00.000Z"),
    processedAt: new Date("2026-05-25T10:00:01.000Z"),
    authUserId: null,
    ...overrides,
  };
}
