import { describe, expect, it, vi } from "vitest";

import type { PushPort, PushReceiptResult } from "@th/ports/comms/push";
import type { PushReceiptRecord } from "@th/ports/repos/push-receipts";

import {
  drainPushReceipts,
  type DrainPushReceiptsDeps,
} from "../drain-push-receipts";

const NOW = new Date("2026-07-07T12:00:00.000Z");

function receiptRow(
  overrides: Partial<PushReceiptRecord> = {},
): PushReceiptRecord {
  return {
    id: "receipt-1",
    ticketId: "ticket-1",
    pushDeviceId: "device-1",
    attempts: 0,
    checkAfter: new Date("2026-07-07T11:45:00.000Z"),
    createdAt: new Date("2026-07-07T11:30:00.000Z"),
    ...overrides,
  };
}

function createDeps(args: {
  due?: PushReceiptRecord[];
  receipts?: PushReceiptResult[];
  checkReceiptsError?: Error;
  withoutCheckReceipts?: boolean;
}) {
  const pushReceipts = {
    createMany: vi.fn(),
    listDue: vi.fn().mockResolvedValue(args.due ?? []),
    deleteByIds: vi.fn().mockResolvedValue((args.due ?? []).length),
    reschedule: vi.fn().mockResolvedValue(undefined),
  };
  const pushDevices = {
    disable: vi.fn().mockResolvedValue(undefined),
  };
  const checkReceipts = vi.fn(async () => {
    if (args.checkReceiptsError) throw args.checkReceiptsError;
    return { receipts: args.receipts ?? [] };
  });
  const push = (
    args.withoutCheckReceipts ? {} : { checkReceipts }
  ) as unknown as PushPort;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);

  const deps: DrainPushReceiptsDeps = {
    repos: {
      pushReceipts:
        pushReceipts as unknown as DrainPushReceiptsDeps["repos"]["pushReceipts"],
      pushDevices:
        pushDevices as unknown as DrainPushReceiptsDeps["repos"]["pushDevices"],
    },
    push,
    logger: logger as unknown as DrainPushReceiptsDeps["logger"],
    clock: { now: () => NOW },
  };

  return { deps, mocks: { pushReceipts, pushDevices, checkReceipts, logger } };
}

const okReceipt = (ticketId: string): PushReceiptResult => ({
  ticketId,
  status: "ok",
  errorCode: null,
  message: null,
});

const invalidTokenReceipt = (ticketId: string): PushReceiptResult => ({
  ticketId,
  status: "invalid_token",
  errorCode: "DeviceNotRegistered",
  message: "not a registered push recipient",
});

describe("drainPushReceipts", () => {
  it("short-circuits without touching the push port when nothing is due", async () => {
    const { deps, mocks } = createDeps({ due: [] });

    const result = await drainPushReceipts(deps, {});

    expect(result).toEqual({
      processed: 0,
      delivered: 0,
      invalidTokens: 0,
      disabledDevices: 0,
      failedMessages: 0,
      retried: 0,
      expired: 0,
    });
    expect(mocks.checkReceipts).not.toHaveBeenCalled();
    expect(mocks.pushReceipts.deleteByIds).not.toHaveBeenCalled();
  });

  it("fails NOT_CONFIGURED when rows are due but the port has no checkReceipts", async () => {
    const { deps } = createDeps({
      due: [receiptRow()],
      withoutCheckReceipts: true,
    });

    await expect(drainPushReceipts(deps, {})).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  it("deletes delivered rows on ok receipts", async () => {
    const { deps, mocks } = createDeps({
      due: [receiptRow()],
      receipts: [okReceipt("ticket-1")],
    });

    const result = await drainPushReceipts(deps, {});

    expect(result.processed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(mocks.checkReceipts).toHaveBeenCalledWith({
      ticketIds: ["ticket-1"],
    });
    expect(mocks.pushReceipts.deleteByIds).toHaveBeenCalledWith(["receipt-1"]);
    expect(mocks.pushDevices.disable).not.toHaveBeenCalled();
    expect(mocks.pushReceipts.reschedule).not.toHaveBeenCalled();
  });

  it("disables the device and deletes the row on a DeviceNotRegistered receipt", async () => {
    const { deps, mocks } = createDeps({
      due: [receiptRow()],
      receipts: [invalidTokenReceipt("ticket-1")],
    });

    const result = await drainPushReceipts(deps, {});

    expect(result.invalidTokens).toBe(1);
    expect(result.disabledDevices).toBe(1);
    expect(mocks.pushDevices.disable).toHaveBeenCalledWith({ id: "device-1" });
    expect(mocks.pushReceipts.deleteByIds).toHaveBeenCalledWith(["receipt-1"]);
  });

  it("disables a device only once when several receipts point at it", async () => {
    const { deps, mocks } = createDeps({
      due: [
        receiptRow({ id: "receipt-1", ticketId: "ticket-1" }),
        receiptRow({ id: "receipt-2", ticketId: "ticket-2" }),
      ],
      receipts: [
        invalidTokenReceipt("ticket-1"),
        invalidTokenReceipt("ticket-2"),
      ],
    });

    const result = await drainPushReceipts(deps, {});

    expect(result.invalidTokens).toBe(2);
    expect(result.disabledDevices).toBe(1);
    expect(mocks.pushDevices.disable).toHaveBeenCalledTimes(1);
    expect(mocks.pushReceipts.deleteByIds).toHaveBeenCalledWith([
      "receipt-1",
      "receipt-2",
    ]);
  });

  it("logs and deletes message-level errors without disabling the device", async () => {
    const { deps, mocks } = createDeps({
      due: [receiptRow()],
      receipts: [
        {
          ticketId: "ticket-1",
          status: "error",
          errorCode: "MessageTooBig",
          message: "payload too large",
        },
      ],
    });

    const result = await drainPushReceipts(deps, {});

    expect(result.failedMessages).toBe(1);
    expect(mocks.pushDevices.disable).not.toHaveBeenCalled();
    expect(mocks.pushReceipts.deleteByIds).toHaveBeenCalledWith(["receipt-1"]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "comms.push_receipts.message_failed",
      expect.objectContaining({ errorCode: "MessageTooBig" }),
    );
  });

  it("reschedules missing receipts under the attempt budget", async () => {
    const { deps, mocks } = createDeps({
      due: [receiptRow({ attempts: 0 })],
      receipts: [],
    });

    const result = await drainPushReceipts(deps, {
      recheckDelaySeconds: 900,
    });

    expect(result.retried).toBe(1);
    expect(result.expired).toBe(0);
    expect(mocks.pushReceipts.reschedule).toHaveBeenCalledWith({
      ids: ["receipt-1"],
      checkAfter: new Date(NOW.getTime() + 900 * 1000),
    });
    // Nothing to delete → still called with an empty array (repo no-ops).
    expect(mocks.pushReceipts.deleteByIds).toHaveBeenCalledWith([]);
  });

  it("gives up and deletes rows whose receipts never materialize (Expo prunes after ~24h)", async () => {
    const { deps, mocks } = createDeps({
      due: [receiptRow({ attempts: 2 })],
      receipts: [],
    });

    const result = await drainPushReceipts(deps, { maxAttempts: 3 });

    expect(result.expired).toBe(1);
    expect(result.retried).toBe(0);
    expect(mocks.pushReceipts.deleteByIds).toHaveBeenCalledWith(["receipt-1"]);
    expect(mocks.pushReceipts.reschedule).not.toHaveBeenCalled();
  });

  it("contains a device-disable failure (cascade-deleted device / overlapping run) and still retires the row", async () => {
    const { deps, mocks } = createDeps({
      due: [
        receiptRow({ id: "receipt-1", ticketId: "ticket-1" }),
        receiptRow({
          id: "receipt-2",
          ticketId: "ticket-2",
          pushDeviceId: "device-2",
        }),
      ],
      receipts: [
        invalidTokenReceipt("ticket-1"),
        invalidTokenReceipt("ticket-2"),
      ],
    });
    mocks.pushDevices.disable.mockRejectedValueOnce(
      new Error("P2025: record not found"),
    );

    const result = await drainPushReceipts(deps, {});

    // First device vanished (peer run / human cascade) — second still handled,
    // both rows retired, batch never throws.
    expect(result.invalidTokens).toBe(2);
    expect(result.disabledDevices).toBe(1);
    expect(mocks.pushReceipts.deleteByIds).toHaveBeenCalledWith([
      "receipt-1",
      "receipt-2",
    ]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "comms.push_receipts.device_disable_failed",
      expect.objectContaining({ pushDeviceId: "device-1" }),
    );
  });

  it("propagates a receipts-endpoint failure so rows stay queued for the next run", async () => {
    const { deps, mocks } = createDeps({
      due: [receiptRow()],
      checkReceiptsError: new Error("expo unavailable"),
    });

    await expect(drainPushReceipts(deps, {})).rejects.toThrow(
      "expo unavailable",
    );
    expect(mocks.pushReceipts.deleteByIds).not.toHaveBeenCalled();
    expect(mocks.pushReceipts.reschedule).not.toHaveBeenCalled();
    expect(mocks.pushDevices.disable).not.toHaveBeenCalled();
  });
});
