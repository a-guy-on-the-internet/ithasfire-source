import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExpoPushAdapter,
  MAX_ACTIVE_DEVICES_PER_HUMAN,
} from "../push/expo-push";
import type {
  Expo,
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushTicket,
} from "expo-server-sdk";
import type {
  PushDevicesRepo,
  PushDeviceRecord,
} from "@th/ports/repos/push-devices";
import type { PushReceiptsRepo } from "@th/ports/repos/push-receipts";
import { createTestLogger } from "@th/test-utils";
import type { MetricsPort } from "@th/ports/metric";

const createMetrics = (): MetricsPort & {
  increment: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
} => {
  const increment = vi.fn();
  const record = vi.fn();
  return {
    increment,
    record,
  } as unknown as MetricsPort & {
    increment: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
  };
};

const createRepo = () => {
  const mock = {
    upsert: vi.fn(),
    markSeen: vi.fn(),
    disable: vi.fn(),
    disableByToken: vi.fn(),
    disableByHumanToken: vi.fn(),
    findActiveByHuman: vi.fn(),
    findByIds: vi.fn(),
    enforceActiveDeviceCap: vi.fn().mockResolvedValue([]),
  };
  return {
    repo: mock as unknown as PushDevicesRepo,
    mock,
  };
};

const createReceiptsRepo = () => {
  const mock = {
    createMany: vi.fn().mockResolvedValue(undefined),
    listDue: vi.fn(),
    deleteByIds: vi.fn(),
    reschedule: vi.fn(),
  };
  return {
    receiptsRepo: mock as unknown as PushReceiptsRepo,
    mock,
  };
};

const createDevice = (
  overrides: Partial<PushDeviceRecord> = {},
): PushDeviceRecord => ({
  id: overrides.id ?? "device-1",
  humanId: overrides.humanId ?? "human-1",
  provider: overrides.provider ?? "expo",
  token: overrides.token ?? "ExponentPushToken[testtoken1234567890]",
  platform: overrides.platform ?? "ios",
  appId: overrides.appId ?? null,
  enabled: overrides.enabled ?? true,
  lastSeenAt: overrides.lastSeenAt ?? null,
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
});

const chunkMessages = (
  messages: ExpoPushMessage[],
  chunkSize?: number,
): ExpoPushMessage[][] => {
  if (!chunkSize || chunkSize >= messages.length) {
    return [messages];
  }
  const chunks: ExpoPushMessage[][] = [];
  for (let i = 0; i < messages.length; i += chunkSize) {
    chunks.push(messages.slice(i, i + chunkSize));
  }
  return chunks;
};

type ExpoStub = Expo & {
  chunkPushNotifications: ReturnType<typeof vi.fn>;
  chunkPushNotificationReceiptIds: ReturnType<typeof vi.fn>;
  sendPushNotificationsAsync: ReturnType<typeof vi.fn>;
  getPushNotificationReceiptsAsync: ReturnType<typeof vi.fn>;
};

type ExpoStubOptions = {
  responses?: ExpoPushTicket[][];
  sendErrors?: (Error | null)[];
  healthErrors?: (Error | null)[];
  receiptResponses?: Record<string, ExpoPushReceipt>[];
  receiptChunkSize?: number;
};

const createExpoStub = (options: ExpoStubOptions = {}): ExpoStub => {
  const responses = [...(options.responses ?? [])];
  const sendErrors = [...(options.sendErrors ?? [])];
  const healthErrors = [...(options.healthErrors ?? [])];
  const receiptResponses = [...(options.receiptResponses ?? [])];
  const sendMock = vi.fn(async (chunk: ExpoPushMessage[]) => {
    const maybeError = sendErrors.shift();
    if (maybeError) {
      throw maybeError;
    }
    const response = responses.shift();
    if (response) {
      return response;
    }
    return chunk.map(() => ({ status: "ok" }) as ExpoPushTicket);
  });
  const receiptsMock = vi.fn(async () => {
    const maybeError = healthErrors.shift();
    if (maybeError) {
      throw maybeError;
    }
    return receiptResponses.shift() ?? {};
  });
  const expo = {
    chunkPushNotifications: vi.fn(
      (messages: ExpoPushMessage[], chunkSize?: number) =>
        chunkMessages(messages, chunkSize),
    ),
    chunkPushNotificationReceiptIds: vi.fn((ids: string[]) => {
      const size = options.receiptChunkSize ?? (ids.length || 1);
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += size) {
        chunks.push(ids.slice(i, i + size));
      }
      return chunks;
    }),
    sendPushNotificationsAsync: sendMock,
    getPushNotificationReceiptsAsync: receiptsMock,
  } as unknown as ExpoStub;

  return expo;
};

const createNetworkError = (code: string, message: string) => {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

describe("ExpoPushAdapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("registers a device through the repo", async () => {
    const { repo, mock } = createRepo();
    mock.upsert.mockResolvedValue(createDevice());
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: createExpoStub(),
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    await adapter.registerDevice({
      humanId: "human-1",
      provider: "expo",
      token: "ExponentPushToken[testtoken1234567890]",
      platform: "ios",
    });

    expect(mock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: "human-1",
        provider: "expo",
        token: "ExponentPushToken[testtoken1234567890]",
      }),
    );
  });

  it("sends push notifications for human targets", async () => {
    const { repo, mock } = createRepo();
    const device = createDevice();
    mock.findActiveByHuman.mockResolvedValue([device]);
    const metrics = createMetrics();
    const client = createExpoStub({
      responses: [[{ status: "ok", id: "ticket-1" } as ExpoPushTicket]],
    });

    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: client,
      logger: createTestLogger(),
      metrics,
    });

    const result = await adapter.send({
      humanId: "human-1",
      body: "Hello",
      title: "Greeting",
    });

    expect(result.id).toBeTypeOf("string");
    expect(mock.findActiveByHuman).toHaveBeenCalledWith({ humanId: "human-1" });
    expect(metrics.increment).toHaveBeenCalledWith(
      "comms.push.sent",
      expect.objectContaining({
        channel: "push",
        provider: "expo",
        count: "1",
      }),
    );
    expect(mock.markSeen).toHaveBeenCalledWith({ id: device.id });
  });

  it("disables invalid tokens returned by expo", async () => {
    const { repo, mock } = createRepo();
    const device = createDevice();
    mock.findByIds.mockResolvedValue([device]);
    const metrics = createMetrics();
    const client = createExpoStub({
      responses: [
        [
          {
            status: "error",
            message: "Device not registered",
            details: { error: "DeviceNotRegistered" },
          } as ExpoPushTicket,
        ],
      ],
    });

    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: client,
      logger: createTestLogger(),
      metrics,
      chunkSize: 10,
    });

    await expect(
      adapter.send({
        deviceIds: [device.id],
        body: "Ping",
      }),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    expect(mock.disable).toHaveBeenCalledWith({ id: device.id });
    const invalidMetric = metrics.increment.mock.calls.find(
      ([name]) => name === "comms.push.invalid_token",
    );
    expect(invalidMetric).toBeTruthy();
  });

  it("unregisters device by token", async () => {
    const { repo, mock } = createRepo();
    mock.disableByHumanToken.mockResolvedValue(1);
    mock.disableByToken.mockResolvedValue(1);
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: createExpoStub(),
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    await adapter.unregisterDevice({
      humanId: "human-1",
      token: "ExponentPushToken[same]",
    });

    expect(mock.disableByHumanToken).toHaveBeenCalledWith({
      humanId: "human-1",
      token: "ExponentPushToken[same]",
    });
    expect(mock.disableByToken).toHaveBeenCalledWith({
      provider: "expo",
      token: "ExponentPushToken[same]",
    });
  });

  it("performs health check via receipts endpoint", async () => {
    const { repo } = createRepo();
    const expo = createExpoStub();
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: expo,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    const result = await adapter.health();

    expect(result).toMatchObject({ ok: true, vendor: "expo" });
    expect(expo.getPushNotificationReceiptsAsync).toHaveBeenCalledWith([]);
  });

  it("returns unhealthy when receipts endpoint fails", async () => {
    const { repo } = createRepo();
    const metrics = createMetrics();
    const expo = createExpoStub({
      healthErrors: [
        createNetworkError("ECONNRESET", "connection reset"),
        new Error("still down"),
      ],
    });
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: expo,
      logger: createTestLogger(),
      metrics,
    });

    const result = await adapter.health();

    expect(result.ok).toBe(false);
    expect(expo.getPushNotificationReceiptsAsync).toHaveBeenCalledTimes(2);
    const failureMetric = metrics.increment.mock.calls.find(
      ([name, tags]) =>
        name === "comms.push.failed" &&
        (tags as Record<string, string>).errorCode === "health_check_failed",
    );
    expect(failureMetric).toBeTruthy();
  });

  it("retries transient network failures before succeeding", async () => {
    const { repo, mock } = createRepo();
    const device = createDevice();
    mock.findActiveByHuman.mockResolvedValue([device]);
    const metrics = createMetrics();
    const expo = createExpoStub({
      sendErrors: [createNetworkError("ECONNRESET", "reset once")],
      responses: [[{ status: "ok" } as ExpoPushTicket]],
    });
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: expo,
      logger: createTestLogger(),
      metrics,
    });

    const result = await adapter.send({
      humanId: device.humanId,
      body: "Hello",
    });

    expect(result.id).toBeTypeOf("string");
    expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(2);
    expect(metrics.increment).toHaveBeenCalledWith(
      "comms.push.sent",
      expect.objectContaining({ provider: "expo", count: "1" }),
    );
    expect(mock.markSeen).toHaveBeenCalledWith({ id: device.id });
  });

  it("enforces the per-human active-device cap after upserting", async () => {
    const { repo, mock } = createRepo();
    mock.upsert.mockResolvedValue(createDevice());
    mock.enforceActiveDeviceCap.mockResolvedValue(["old-device-1"]);
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: createExpoStub(),
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    await adapter.registerDevice({
      humanId: "human-1",
      provider: "expo",
      token: "ExponentPushToken[testtoken1234567890]",
    });

    expect(mock.enforceActiveDeviceCap).toHaveBeenCalledWith({
      humanId: "human-1",
      maxActive: MAX_ACTIVE_DEVICES_PER_HUMAN,
    });
    // The upsert (which bumps lastSeenAt for the registering device) must
    // land BEFORE the cap sweep so the new device always survives eviction.
    expect(mock.upsert.mock.invocationCallOrder[0]!).toBeLessThan(
      mock.enforceActiveDeviceCap.mock.invocationCallOrder[0]!,
    );
  });

  it("does not fail registration when cap enforcement errors", async () => {
    const { repo, mock } = createRepo();
    mock.upsert.mockResolvedValue(createDevice());
    mock.enforceActiveDeviceCap.mockRejectedValue(new Error("db hiccup"));
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: createExpoStub(),
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    await expect(
      adapter.registerDevice({
        humanId: "human-1",
        provider: "expo",
        token: "ExponentPushToken[testtoken1234567890]",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("persists one pending receipt per ok ticket with a ~15min checkAfter", async () => {
    const { repo, mock } = createRepo();
    const { receiptsRepo, mock: receiptsMock } = createReceiptsRepo();
    const deviceA = createDevice({ id: "device-a" });
    const deviceB = createDevice({
      id: "device-b",
      token: "ExponentPushToken[testtoken0987654321]",
    });
    const deviceC = createDevice({
      id: "device-c",
      token: "ExponentPushToken[testtokenABCDEF]",
    });
    mock.findActiveByHuman.mockResolvedValue([deviceA, deviceB, deviceC]);
    const client = createExpoStub({
      responses: [
        [
          { status: "ok", id: "ticket-a" } as ExpoPushTicket,
          { status: "ok", id: "ticket-b" } as ExpoPushTicket,
          {
            status: "error",
            message: "Device not registered",
            details: { error: "DeviceNotRegistered" },
          } as ExpoPushTicket,
        ],
      ],
    });

    const adapter = new ExpoPushAdapter({
      repo,
      receiptsRepo,
      expoClient: client,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    const before = Date.now();
    await adapter.send({ humanId: "human-1", body: "Hello" });
    const after = Date.now();

    expect(receiptsMock.createMany).toHaveBeenCalledTimes(1);
    const args = receiptsMock.createMany.mock.calls[0]![0] as {
      items: Array<{ ticketId: string; pushDeviceId: string }>;
      checkAfter: Date;
    };
    // Only the ok tickets — the errored ticket has no receipt to poll.
    expect(args.items).toEqual([
      { ticketId: "ticket-a", pushDeviceId: "device-a" },
      { ticketId: "ticket-b", pushDeviceId: "device-b" },
    ]);
    const delayMs = 15 * 60 * 1000;
    expect(args.checkAfter.getTime()).toBeGreaterThanOrEqual(
      before + delayMs,
    );
    expect(args.checkAfter.getTime()).toBeLessThanOrEqual(after + delayMs);
  });

  it("does not fail the send when receipt persistence errors", async () => {
    const { repo, mock } = createRepo();
    const { receiptsRepo, mock: receiptsMock } = createReceiptsRepo();
    receiptsMock.createMany.mockRejectedValue(new Error("db down"));
    const device = createDevice();
    mock.findActiveByHuman.mockResolvedValue([device]);
    const client = createExpoStub({
      responses: [[{ status: "ok", id: "ticket-1" } as ExpoPushTicket]],
    });

    const adapter = new ExpoPushAdapter({
      repo,
      receiptsRepo,
      expoClient: client,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    const result = await adapter.send({ humanId: "human-1", body: "Hello" });

    expect(result.id).toBeTypeOf("string");
    expect(receiptsMock.createMany).toHaveBeenCalledTimes(1);
  });

  it("checkReceipts normalizes Expo receipt statuses and chunks the lookup", async () => {
    const { repo } = createRepo();
    const client = createExpoStub({
      receiptChunkSize: 2,
      receiptResponses: [
        {
          "ticket-1": { status: "ok" } as ExpoPushReceipt,
          "ticket-2": {
            status: "error",
            message: "not a registered push recipient",
            details: { error: "DeviceNotRegistered" },
          } as ExpoPushReceipt,
        },
        {
          "ticket-3": {
            status: "error",
            message: "payload too large",
            details: { error: "MessageTooBig" },
          } as ExpoPushReceipt,
          // ticket-4 missing → pruned / not ready: absent from the result.
        },
      ],
    });
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: client,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    const result = await adapter.checkReceipts({
      ticketIds: ["ticket-1", "ticket-2", "ticket-3", "ticket-4"],
    });

    expect(client.getPushNotificationReceiptsAsync).toHaveBeenCalledTimes(2);
    expect(result.receipts).toEqual([
      { ticketId: "ticket-1", status: "ok", errorCode: null, message: null },
      {
        ticketId: "ticket-2",
        status: "invalid_token",
        errorCode: "DeviceNotRegistered",
        message: "not a registered push recipient",
      },
      {
        ticketId: "ticket-3",
        status: "error",
        errorCode: "MessageTooBig",
        message: "payload too large",
      },
    ]);
  });

  it("checkReceipts surfaces a dependency failure when the endpoint keeps erroring", async () => {
    const { repo } = createRepo();
    const client = createExpoStub({
      healthErrors: [new Error("boom")],
    });
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: client,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });

    await expect(
      adapter.checkReceipts({ ticketIds: ["ticket-1"] }),
    ).rejects.toMatchObject({ code: "dependency_failed" });
  });

  it("fails when chunk send errors without retry", async () => {
    const { repo, mock } = createRepo();
    const device = createDevice();
    mock.findActiveByHuman.mockResolvedValue([device]);
    const metrics = createMetrics();
    const expo = createExpoStub({
      sendErrors: [new Error("bad request")],
    });
    const adapter = new ExpoPushAdapter({
      repo,
      expoClient: expo,
      logger: createTestLogger(),
      metrics,
    });

    await expect(
      adapter.send({ humanId: device.humanId, body: "Fail" }),
    ).rejects.toMatchObject({ code: "dependency_failed" });
    const failureMetric = metrics.increment.mock.calls.find(
      ([name, tags]) =>
        name === "comms.push.failed" &&
        (tags as Record<string, string>).errorCode === "chunk_send_failed",
    );
    expect(failureMetric).toBeTruthy();
    expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps chunk-1 bookkeeping (receipts + invalid-device disable) when chunk 2 throws", async () => {
    const { repo, mock } = createRepo();
    const { receiptsRepo, mock: receiptsMock } = createReceiptsRepo();
    const devices = [
      createDevice({ id: "device-1" }),
      createDevice({
        id: "device-2",
        token: "ExponentPushToken[testtoken0987654321]",
      }),
      createDevice({
        id: "device-3",
        token: "ExponentPushToken[testtokenABCDEF]",
      }),
      createDevice({
        id: "device-4",
        token: "ExponentPushToken[testtokenFEDCBA]",
      }),
    ];
    mock.findActiveByHuman.mockResolvedValue(devices);
    const client = createExpoStub({
      // Chunk 1 (device-1, device-2) succeeds: one ok ticket, one dead
      // install. Chunk 2 (device-3, device-4) fails non-retryably.
      sendErrors: [null, new Error("bad request")],
      responses: [
        [
          { status: "ok", id: "ticket-1" } as ExpoPushTicket,
          {
            status: "error",
            message: "Device not registered",
            details: { error: "DeviceNotRegistered" },
          } as ExpoPushTicket,
        ],
      ],
    });

    const adapter = new ExpoPushAdapter({
      repo,
      receiptsRepo,
      expoClient: client,
      logger: createTestLogger(),
      metrics: createMetrics(),
      chunkSize: 2,
    });

    await expect(
      adapter.send({ humanId: "human-1", body: "Hello" }),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    // The failure on chunk 2 must NOT lose chunk 1's already-dispatched
    // bookkeeping: its ok-ticket still enters the receipt outbox and its
    // dead device is still disabled.
    expect(receiptsMock.createMany).toHaveBeenCalledTimes(1);
    expect(receiptsMock.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ ticketId: "ticket-1", pushDeviceId: "device-1" }],
      }),
    );
    expect(mock.disable).toHaveBeenCalledWith({ id: "device-2" });
  });
});
