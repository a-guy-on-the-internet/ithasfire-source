import type {
  DisablePushDeviceInput,
  DisablePushDevicesByHumanInput,
  DisablePushDevicesByTokenInput,
  EnforceActiveDeviceCapInput,
  FindActiveDevicesByHumanInput,
  FindDevicesByIdsInput,
  MarkPushDeviceSeenInput,
  PushDeviceRecord,
  UpsertPushDeviceInput,
} from "@th/types/repos/push-devices";

export interface PushDevicesRepo {
  upsert(input: UpsertPushDeviceInput): Promise<PushDeviceRecord>;
  markSeen(input: MarkPushDeviceSeenInput): Promise<void>;
  disable(input: DisablePushDeviceInput): Promise<void>;
  disableByToken(input: DisablePushDevicesByTokenInput): Promise<number>;
  disableByHumanToken(input: DisablePushDevicesByHumanInput): Promise<number>;
  findActiveByHuman(
    input: FindActiveDevicesByHumanInput,
  ): Promise<PushDeviceRecord[]>;
  findByIds(input: FindDevicesByIdsInput): Promise<PushDeviceRecord[]>;
  /**
   * Enforce the per-human ACTIVE device cap by disabling everything beyond
   * the `maxActive` most-recently-seen enabled devices (evict-oldest, never
   * reject — a real user cycling phones should never hit a wall). Ordering:
   * `lastSeenAt` DESC with NULLs last, `createdAt` DESC as tiebreak, so the
   * device that was just upserted (its `lastSeenAt` is bumped to now) always
   * survives. Idempotent — a human at/under the cap is a no-op. Returns the
   * ids of the devices that were disabled.
   */
  enforceActiveDeviceCap(input: EnforceActiveDeviceCapInput): Promise<string[]>;
}

export type {
  DisablePushDeviceInput,
  DisablePushDevicesByHumanInput,
  DisablePushDevicesByTokenInput,
  EnforceActiveDeviceCapInput,
  FindActiveDevicesByHumanInput,
  FindDevicesByIdsInput,
  MarkPushDeviceSeenInput,
  PushDeviceRecord,
  UpsertPushDeviceInput,
} from "@th/types/repos/push-devices";
