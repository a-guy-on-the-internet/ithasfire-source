import { Prisma } from "@prisma/client";
import type { PushDevicesRepo } from "@th/ports/repos/push-devices";
import type {
  DisablePushDeviceInput,
  DisablePushDevicesByHumanInput,
  DisablePushDevicesByTokenInput,
  EnforceActiveDeviceCapInput,
  FindActiveDevicesByHumanInput,
  FindDevicesByIdsInput,
  MarkPushDeviceSeenInput,
  UpsertPushDeviceInput,
} from "@th/ports/repos/push-devices";

import type { PrismaClientOrTx } from "./types";

const pushDeviceSelect = {
  id: true,
  humanId: true,
  provider: true,
  token: true,
  platform: true,
  appId: true,
  enabled: true,
  lastSeenAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PushDeviceSelect = typeof pushDeviceSelect;

type PushDevicePayload = Prisma.PushDeviceGetPayload<{
  select: PushDeviceSelect;
}>;

type PushDeviceRecord = PushDevicePayload;

export function makePushDevicesRepo(p: PrismaClientOrTx): PushDevicesRepo {
  return {
    async upsert(input: UpsertPushDeviceInput): Promise<PushDeviceRecord> {
      const seenAt = new Date();
      const updateData: Prisma.PushDeviceUncheckedUpdateInput = {
        humanId: input.humanId,
        enabled: true,
        lastSeenAt: seenAt,
      };

      if (input.platform) {
        updateData.platform = input.platform;
      }
      if (input.appId !== undefined) {
        updateData.appId = input.appId ?? null;
      }

      return p.pushDevice.upsert({
        where: {
          provider_token: {
            provider: input.provider,
            token: input.token,
          },
        },
        create: {
          humanId: input.humanId,
          provider: input.provider,
          token: input.token,
          platform: input.platform ?? "unknown",
          appId: input.appId ?? null,
          enabled: true,
          lastSeenAt: seenAt,
        },
        update: updateData,
        select: pushDeviceSelect,
      });
    },

    async markSeen(input: MarkPushDeviceSeenInput): Promise<void> {
      if (!input.id) return;
      const seenAt = input.seenAt ?? new Date();
      await p.pushDevice.update({
        where: { id: input.id },
        data: { lastSeenAt: seenAt },
      });
    },

    async disable(input: DisablePushDeviceInput): Promise<void> {
      await p.pushDevice.update({
        where: { id: input.id },
        data: { enabled: false },
      });
    },

    async disableByToken(
      input: DisablePushDevicesByTokenInput,
    ): Promise<number> {
      const result = await p.pushDevice.updateMany({
        where: {
          provider: input.provider,
          token: input.token,
        },
        data: { enabled: false },
      });
      return result.count;
    },

    async disableByHumanToken(
      input: DisablePushDevicesByHumanInput,
    ): Promise<number> {
      const result = await p.pushDevice.updateMany({
        where: {
          humanId: input.humanId,
          token: input.token,
        },
        data: { enabled: false },
      });
      return result.count;
    },

    async findActiveByHuman(input: FindActiveDevicesByHumanInput) {
      return p.pushDevice.findMany({
        where: {
          humanId: input.humanId,
          enabled: true,
        },
        orderBy: { updatedAt: "desc" },
        select: pushDeviceSelect,
      });
    },

    async findByIds(input: FindDevicesByIdsInput) {
      if (input.ids.length === 0) {
        return [];
      }
      return p.pushDevice.findMany({
        where: {
          id: { in: input.ids },
        },
        select: pushDeviceSelect,
      });
    },

    async enforceActiveDeviceCap(
      input: EnforceActiveDeviceCapInput,
    ): Promise<string[]> {
      // Fetch active devices newest-seen first (NULL lastSeenAt = never seen
      // → oldest, createdAt tiebreak) and disable everything beyond the cap.
      // Device counts per human are tiny (cap is ~10), so the read is cheap.
      const active = await p.pushDevice.findMany({
        where: { humanId: input.humanId, enabled: true },
        orderBy: [
          { lastSeenAt: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        select: { id: true },
      });
      const evictIds = active
        .slice(Math.max(1, input.maxActive))
        .map((device) => device.id);
      if (evictIds.length === 0) {
        return [];
      }
      await p.pushDevice.updateMany({
        where: { id: { in: evictIds } },
        data: { enabled: false },
      });
      return evictIds;
    },
  };
}
