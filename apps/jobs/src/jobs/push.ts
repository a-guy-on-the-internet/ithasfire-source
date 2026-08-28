/**
 * Push Pipeline Jobs
 *
 * Expo's send API acknowledges messages with *tickets*, but many dead installs
 * (DeviceNotRegistered) are only reported in the *receipt* phase ~15 minutes
 * later. The ExpoPushAdapter persists one PushReceipt row per ok-ticket; this
 * scheduled drain polls the due rows against Expo's receipt endpoint and
 * disables devices whose receipts report an invalid token, so dead devices
 * stop receiving doomed sends on every notify().
 */
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import {
  drainPushReceipts,
  drainPushReceiptsInputSchema,
} from "@th/core/use-cases/comms";

// ─────────────────────────────────────────────────────────────────────────────
// push.drain-receipts
// Every 15 minutes: poll Expo receipts for due tickets, disable dead devices,
// delete resolved/expired rows (the outbox drains to empty).
// ─────────────────────────────────────────────────────────────────────────────

export const drainPushReceiptsJob = defineScheduledTask({
  name: "push.drain-receipts",
  description:
    "Poll Expo push receipts for recently sent notifications, disable devices " +
    "whose receipts report DeviceNotRegistered/InvalidCredentials, and delete " +
    "resolved/expired pending-receipt rows.",
  input: drainPushReceiptsInputSchema,
  schedule: getSchedule("push.drain-receipts"),
  handler: async ({ input, ctx }) => {
    const result = await drainPushReceipts(
      {
        repos: {
          pushReceipts: ctx.repos.pushReceipts,
          pushDevices: ctx.repos.pushDevices,
        },
        push: ctx.push,
        logger: ctx.logger,
        clock: ctx.clock,
      },
      input,
    );
    ctx.logger.info("push.drain-receipts.completed", result);
    return result;
  },
});

export const pushJobs = [drainPushReceiptsJob];
