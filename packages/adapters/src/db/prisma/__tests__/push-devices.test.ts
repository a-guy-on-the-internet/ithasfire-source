import { describe, expect, it, vi } from "vitest";

import { makePushDevicesRepo } from "../push-devices";
import type { PrismaClientOrTx } from "../types";
import type { PushDeviceRecord } from "@th/ports/repos/push-devices";

describe("makePushDevicesRepo", () => {
  const createPrisma = () => {
    const upsert = vi.fn();
    const update = vi.fn();
    const updateMany = vi.fn();
    const findMany = vi.fn();

    const prisma = {
      pushDevice: {
        upsert,
        update,
        updateMany,
        findMany,
      },
    } as unknown as PrismaClientOrTx;

    return { prisma, upsert, update, updateMany, findMany };
  };

  const createRecord = (
    overrides: Partial<PushDeviceRecord> = {},
  ): PushDeviceRecord => ({
    id: "dev-1",
    humanId: "human-1",
    provider: "expo",
    token: "ExponentPushToken[testtoken]",
    platform: "ios",
    appId: null,
    enabled: true,
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it("upserts with defaults and returns record", async () => {
    const { prisma, upsert } = createPrisma();
    const repo = makePushDevicesRepo(prisma);
    upsert.mockResolvedValue(createRecord({ platform: "ios" }));

    const record = await repo.upsert({
      humanId: "human-1",
      provider: "expo",
      token: "ExponentPushToken[testtoken]",
      platform: "ios",
      appId: "app-1",
    });

    expect(record.id).toBe("dev-1");

    const args = upsert.mock.calls[0]![0];
    expect(args.where).toEqual({
      provider_token: {
        provider: "expo",
        token: "ExponentPushToken[testtoken]",
      },
    });
    expect(args.create).toMatchObject({
      humanId: "human-1",
      provider: "expo",
      token: "ExponentPushToken[testtoken]",
      platform: "ios",
      appId: "app-1",
      enabled: true,
    });
    expect(args.create.lastSeenAt).toBeInstanceOf(Date);
    expect(args.update).toMatchObject({
      humanId: "human-1",
      enabled: true,
    });
    expect(args.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it("defaults platform to unknown when not provided", async () => {
    const { prisma, upsert } = createPrisma();
    const repo = makePushDevicesRepo(prisma);

    upsert.mockResolvedValue(createRecord({ platform: "unknown" }));

    await repo.upsert({
      humanId: "human-1",
      provider: "expo",
      token: "ExponentPushToken[othertoken]",
    });

    const args = upsert.mock.calls[0]![0];
    expect(args.create.platform).toBe("unknown");
  });

  it("disables devices by token", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makePushDevicesRepo(prisma);

    updateMany.mockResolvedValue({ count: 2 });

    const count = await repo.disableByToken({ provider: "expo", token: "tok" });

    expect(count).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { provider: "expo", token: "tok" },
      data: { enabled: false },
    });
  });

  it("finds active devices by human", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makePushDevicesRepo(prisma);

    const device = createRecord();
    findMany.mockResolvedValue([device]);

    const results = await repo.findActiveByHuman({ humanId: "human-1" });
    expect(results).toEqual([device]);
    expect(findMany).toHaveBeenCalledWith({
      where: { humanId: "human-1", enabled: true },
      orderBy: { updatedAt: "desc" },
      select: expect.any(Object),
    });
  });

  it("returns empty array for findByIds when no ids provided", async () => {
    const { prisma, findMany } = createPrisma();
    const repo = makePushDevicesRepo(prisma);

    const results = await repo.findByIds({ ids: [] });
    expect(results).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  describe("enforceActiveDeviceCap", () => {
    it("disables everything beyond the newest-seen maxActive devices", async () => {
      const { prisma, findMany, updateMany } = createPrisma();
      const repo = makePushDevicesRepo(prisma);

      // 11 active devices, returned newest-seen first (mirrors the orderBy).
      const ids = Array.from({ length: 11 }, (_, i) => ({ id: `dev-${i}` }));
      findMany.mockResolvedValue(ids);
      updateMany.mockResolvedValue({ count: 1 });

      const evicted = await repo.enforceActiveDeviceCap({
        humanId: "human-1",
        maxActive: 10,
      });

      // The 11th (oldest-seen) device gets evicted; the 10 newest survive.
      expect(evicted).toEqual(["dev-10"]);
      expect(findMany).toHaveBeenCalledWith({
        where: { humanId: "human-1", enabled: true },
        orderBy: [
          { lastSeenAt: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        select: { id: true },
      });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["dev-10"] } },
        data: { enabled: false },
      });
    });

    it("no-ops at or under the cap (re-registering an existing token never evicts)", async () => {
      const { prisma, findMany, updateMany } = createPrisma();
      const repo = makePushDevicesRepo(prisma);

      // Re-registering an existing token upserts in place, so the active
      // count stays at the cap — nothing to evict.
      const ids = Array.from({ length: 10 }, (_, i) => ({ id: `dev-${i}` }));
      findMany.mockResolvedValue(ids);

      const evicted = await repo.enforceActiveDeviceCap({
        humanId: "human-1",
        maxActive: 10,
      });

      expect(evicted).toEqual([]);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it("never evicts below one active device even with a degenerate cap", async () => {
      const { prisma, findMany, updateMany } = createPrisma();
      const repo = makePushDevicesRepo(prisma);

      findMany.mockResolvedValue([{ id: "dev-0" }, { id: "dev-1" }]);
      updateMany.mockResolvedValue({ count: 1 });

      const evicted = await repo.enforceActiveDeviceCap({
        humanId: "human-1",
        maxActive: 0,
      });

      // maxActive is clamped to >= 1 — the just-registered device survives.
      expect(evicted).toEqual(["dev-1"]);
    });
  });
});
