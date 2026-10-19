import { z } from "zod";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "./_shared/booking-hold-intents";
import {
  bookingHoldOutputSchema,
  loadStaffHoldContext,
  toBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import { recordMovers, renumberLine } from "./_shared/hold-line";
import { settleLine } from "./_shared/settle-lapsed-holds";

// ─────────────────────────────────────────────────────────────────────────────
// reorderBookingHold (FR-003): move one hold within its line. The whole line
// is renumbered from the settled read; every act whose position changed is
// recorded (`booking_hold.reordered`) and notified. Idempotent: moving a hold
// to the position it already holds writes nothing.
// ─────────────────────────────────────────────────────────────────────────────

export const reorderBookingHoldInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    holdId: z.uuid(),
    /** 1-based; values past the end of the line clamp to the last slot. */
    toPosition: z.number().int().min(1),
  })
  .strict();

export const reorderBookingHoldOutputSchema = z
  .object({
    line: z.array(bookingHoldOutputSchema),
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
  })
  .strict();

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const reorderBookingHoldWireOutputSchema = z.object(
  reorderBookingHoldOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type ReorderBookingHoldInput = z.infer<
  typeof reorderBookingHoldInputSchema
>;
export type ReorderBookingHoldOutput = z.infer<
  typeof reorderBookingHoldOutputSchema
>;
export type ReorderBookingHoldWireOutput = z.infer<
  typeof reorderBookingHoldWireOutputSchema
>;
export type ReorderBookingHoldDeps = BookingHoldDeps;

export async function reorderBookingHold(
  deps: ReorderBookingHoldDeps,
  rawInput: unknown,
): Promise<ReorderBookingHoldOutput> {
  const input = parseInput(reorderBookingHoldInputSchema, rawInput);
  const now = deps.clock.now();
  const ctx = await loadStaffHoldContext(
    deps.repos,
    input.holdId,
    input.actorHumanId,
  );
  const key = { calendarId: ctx.hold.calendarId, date: ctx.hold.date };

  const outcome = await deps.repos.tx(async (tx) => {
    const { line, intents } = await settleLine(tx, {
      ...key,
      now,
      placeTz: ctx.placeTz,
    });

    const index = line.findIndex((h) => h.id === ctx.hold.id);
    if (index === -1) {
      // Released / confirmed / just settled as lapsed — nothing to move.
      throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: ctx.hold.id } });
    }

    // FR-004 promised the challenged act (and the act at position 2) a fixed
    // picture until the deadline — "you are first, keep or release by X".
    // Reordering under an open challenge would silently break it.
    const challenged = line.find((h) => h.status === "CHALLENGED");
    if (challenged) {
      throw fail("HOLD_LINE_HAS_OPEN_CHALLENGE", {
        meta: {
          holdId: ctx.hold.id,
          challengedHoldId: challenged.id,
          calendarId: key.calendarId,
          date: key.date,
        },
      });
    }

    const target = Math.min(input.toPosition, line.length) - 1;
    if (target === index) {
      return { line, intents };
    }

    const order = line.map((h) => h.id);
    const [moving] = order.splice(index, 1);
    order.splice(target, 0, moving!);

    const { line: renumbered, moved } = await renumberLine(tx, key, order);
    intents.push(
      ...(await recordMovers(
        tx,
        moved,
        { humanId: input.actorHumanId, kind: "staff" },
        now,
      )),
    );

    await tx.audit.log({
      entity: "booking_hold",
      entityId: ctx.hold.id,
      action: "booking_hold.reordered",
      data: {
        actorHumanId: input.actorHumanId,
        // Null for a request-less hold (holds-without-a-request FR-001).
        ownerKind: ctx.hold.ownerKind,
        bookingRequestId: ctx.request?.id ?? null,
        calendarId: key.calendarId,
        date: key.date,
        from: index + 1,
        to: target + 1,
        orderedIds: order,
      },
      at: now,
    });

    return { line: renumbered, intents };
  });

  deps.logger?.info("booking_holds.reordered", {
    holdId: ctx.hold.id,
    toPosition: input.toPosition,
    actorHumanId: input.actorHumanId,
  });

  return reorderBookingHoldOutputSchema.parse({
    line: outcome.line.map((h) => toBookingHoldOutput(h, now, ctx.placeTz)),
    notificationIntents: outcome.intents,
    staffRecipientHint: ctx.staffRecipientHint,
  });
}
