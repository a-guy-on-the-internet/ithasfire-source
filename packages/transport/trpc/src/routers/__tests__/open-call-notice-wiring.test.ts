import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Composition-root wiring of the open-call notice seams (open calls v1,
// step 7, LAUNCH GATE). Each core seam is OPTIONAL, so a procedure that forgets
// to pass one still works, and its applicants or editors are silently not told
// (or fall back with a report). These tests pin that every procedure that
// runs an open-call path passes a DEFINED notifier.
//
// Step 9 adds the open-call router: extend this file with one case per
// procedure (submit → notifyOpenCallApplicationReceived, pick →
// notifyOpenCallPicked, notThisTime and close → notifyOpenCallNotThisTime,
// dropOut → notifyOpenCallDroppedOut, messages → notifyApplicationMessagePosted).
// ─────────────────────────────────────────────────────────────────────────────

const leaveDeps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@th/core/use-cases/event-humans/leave-event-lineup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/core/use-cases/event-humans/leave-event-lineup")>();
  return {
    ...actual,
    leaveEventLineup: vi.fn(async (deps: Record<string, unknown>, input: { eventId: string }) => {
      leaveDeps.last = deps;
      return {
        eventId: input.eventId,
        eventHumanId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
        withdrawnVolunteerSignupId: null,
      };
    }),
  };
});

// Step 8: events.deleteEvent pulls a posted call on the draft before the
// cascade (FR-022), so it must carry the pulled notifier.
const deleteDeps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@th/core/use-cases/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/core/use-cases/events")>();
  return {
    ...actual,
    deleteEvent: vi.fn(async (deps: Record<string, unknown>, input: { eventId: string }) => {
      deleteDeps.last = deps;
      return { eventId: input.eventId, deleted: true as const };
    }),
  };
});

import type { Ctx } from "../../context";
import { eventHumansRouter } from "../event-humans";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

const ME = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";

describe("eventHumans.leave → open-call dropped-out seam", () => {
  beforeEach(() => {
    leaveDeps.last = null;
  });

  it("passes a DEFINED notifyOpenCallDroppedOut to leaveEventLineup", async () => {
    const { caller } = createCaller(eventHumansRouter, {
      // `leave` needs a verified email (B2); the caller has proved theirs.
      repos: {
        humans: {
          getByIdWithIdentity: vi.fn(async (id: string) => ({
            human: { id },
            identity: { emailVerified: true },
          })),
        },
      } as unknown as Ctx["repos"],
      actorHumanId: ME,
      publicAppUrl: "https://ithasfire.com",
    });

    await caller.leave({ eventId: EVENT_ID });

    expect(leaveDeps.last).not.toBeNull();
    expect(typeof leaveDeps.last!.notifyOpenCallDroppedOut).toBe("function");
  });
});

describe("events.deleteEvent → open-call pulled seam", () => {
  beforeEach(() => {
    deleteDeps.last = null;
  });

  it("passes DEFINED pulled + not-this-time notifiers and the notifier's own ledger to deleteEvent", async () => {
    const { caller, ctx } = createCaller(eventsRouter, {
      repos: {} as Ctx["repos"],
      actorHumanId: ME,
      publicAppUrl: "https://ithasfire.com",
    });

    await caller.deleteEvent({ eventId: EVENT_ID });

    expect(deleteDeps.last).not.toBeNull();
    expect(typeof deleteDeps.last!.notifyOpenCallPulled).toBe("function");
    expect(typeof deleteDeps.last!.notifyOpenCallNotThisTime).toBe("function");
    // The ledger the delete reads MUST be the store the notifier writes.
    expect(deleteDeps.last!.openCallNoticeLedger).toBe(ctx.idempotency);
  });
});
