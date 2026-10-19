import { describe, expect, it, vi } from "vitest";

import type { JobTriggerPort } from "@th/ports/job-trigger";
import type { Repos, TxRepos } from "@th/ports/repos";

import { withOutboxDrainTriggers } from "../with-outbox-drain-triggers";

/**
 * Minimal fake Repos: three outbox repos plus an unrelated one, and a `tx`
 * that runs `fn` against a tx-scoped copy and throws through (rollback) when
 * `fn` throws. `events` records the order of commit vs publish.
 */
function makeRepos() {
  const events: string[] = [];
  const makeOutboxes = (scope: string) => ({
    rsvpNotices: {
      create: vi.fn(async () => {
        events.push(`${scope}:rsvp.create`);
        return { id: "n1" };
      }),
      createDateCancelled: vi.fn(async (input: { humanIds: string[] }) => {
        events.push(`${scope}:rsvp.createDateCancelled`);
        return input.humanIds.length;
      }),
      listUndispatched: vi.fn(async () => []),
    },
    eventChangeNotices: {
      create: vi.fn(async () => {
        events.push(`${scope}:change.create`);
        return { id: "c1" };
      }),
      markDispatched: vi.fn(async () => undefined),
    },
    imageModerationRecords: {
      create: vi.fn(async () => ({ id: "m1" })),
      requeueForRescan: vi.fn(async () => 0),
      requeueDegraded: vi.fn(async () => 2),
    },
    events: { getById: vi.fn(async () => null) },
  });
  const root = makeOutboxes("root");
  const txScoped = makeOutboxes("tx");
  const repos = {
    ...root,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => {
      events.push("tx:begin");
      const result = await fn(txScoped as unknown as TxRepos);
      events.push("tx:commit");
      return result;
    }),
  } as unknown as Repos;
  return { repos, root, txScoped, events };
}

function makeTrigger(events: string[], impl?: () => Promise<void>) {
  const trigger = vi.fn(async (job: string) => {
    events.push(`publish:${job}`);
    if (impl) await impl();
  });
  return { port: { trigger } as unknown as JobTriggerPort, trigger };
}

describe("withOutboxDrainTriggers", () => {
  it("publishes AFTER the transaction commits, once per drain however many rows", async () => {
    const { repos, events } = makeRepos();
    const { port, trigger } = makeTrigger(events);
    const wrapped = withOutboxDrainTriggers(repos, { trigger: port });

    await wrapped.tx(async (tx) => {
      await tx.rsvpNotices.create({ eventId: "e", humanId: "h" });
      await tx.rsvpNotices.createDateCancelled({
        eventId: "e",
        eventDateId: "d",
        humanIds: ["a", "b"],
      });
      await tx.eventChangeNotices.create({} as never);
    });

    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger).toHaveBeenCalledWith("community.dispatch-rsvp-confirmations");
    expect(trigger).toHaveBeenCalledWith("events.dispatch-change-notifications");
    // Nothing published before COMMIT.
    const commitAt = events.indexOf("tx:commit");
    for (const [i, e] of events.entries()) {
      if (e.startsWith("publish:")) expect(i).toBeGreaterThan(commitAt);
    }
  });

  it("publishes nothing when the transaction rolls back", async () => {
    const { repos, events } = makeRepos();
    const { port, trigger } = makeTrigger(events);
    const wrapped = withOutboxDrainTriggers(repos, { trigger: port });

    await expect(
      wrapped.tx(async (tx) => {
        await tx.eventChangeNotices.create({} as never);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("publishes immediately for an autocommit write on the root repos", async () => {
    const { repos, events } = makeRepos();
    const { port, trigger } = makeTrigger(events);
    const wrapped = withOutboxDrainTriggers(repos, { trigger: port });

    await wrapped.rsvpNotices.create({ eventId: "e", humanId: "h" });
    expect(trigger).toHaveBeenCalledWith("community.dispatch-rsvp-confirmations");
    expect(events).toEqual([
      "root:rsvp.create",
      "publish:community.dispatch-rsvp-confirmations",
    ]);
  });

  it("does not wake a drain for a bulk write that queued nothing", async () => {
    const { repos, events } = makeRepos();
    const { port, trigger } = makeTrigger(events);
    const wrapped = withOutboxDrainTriggers(repos, { trigger: port });

    await wrapped.rsvpNotices.createDateCancelled({
      eventId: "e",
      eventDateId: "d",
      humanIds: [],
    });
    await wrapped.imageModerationRecords.requeueForRescan({} as never); // → 0
    expect(trigger).not.toHaveBeenCalled();

    await wrapped.imageModerationRecords.requeueDegraded({} as never); // → 2
    expect(trigger).toHaveBeenCalledWith("moderation.drain-image-moderations");
  });

  it("ignores reads and non-outbox repos", async () => {
    const { repos, events } = makeRepos();
    const { port, trigger } = makeTrigger(events);
    const wrapped = withOutboxDrainTriggers(repos, { trigger: port });

    await wrapped.rsvpNotices.listUndispatched({ limit: 5 });
    await wrapped.eventChangeNotices.markDispatched([], new Date());
    await (wrapped as unknown as { events: { getById: (id: string) => Promise<unknown> } }).events.getById("x");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("a failed publish is REPORTED, never thrown, and the write's result is returned (row stays for the safety net)", async () => {
    const { repos, events, txScoped } = makeRepos();
    const { port } = makeTrigger(events, async () => {
      throw new Error("pubsub 503");
    });
    const reportError = vi.fn();
    const logger = { error: vi.fn() } as never;
    const wrapped = withOutboxDrainTriggers(repos, {
      trigger: port,
      reportError,
      logger,
    });

    const result = await wrapped.tx(async (tx) => {
      await tx.eventChangeNotices.create({} as never);
      return "cancelled";
    });

    expect(result).toBe("cancelled");
    // The row was written (committed) and nothing deleted it.
    expect(txScoped.eventChangeNotices.create).toHaveBeenCalledTimes(1);
    expect(events).toContain("tx:commit");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "pubsub 503" }),
      expect.objectContaining({
        tags: { area: "job-trigger", job: "events.dispatch-change-notifications" },
      }),
    );
  });

  it("a hung publish is cut off by the timeout and reported, so it cannot hang the request", async () => {
    const { repos, events } = makeRepos();
    const { port } = makeTrigger(events, () => new Promise(() => {}));
    const reportError = vi.fn();
    const wrapped = withOutboxDrainTriggers(repos, {
      trigger: port,
      reportError,
      timeoutMs: 20,
    });

    await wrapped.imageModerationRecords.create({} as never);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "job_trigger_timeout" }),
      expect.anything(),
    );
  });

  it("a throwing reporter still never fails the write", async () => {
    const { repos, events } = makeRepos();
    const { port } = makeTrigger(events, async () => {
      throw new Error("down");
    });
    const wrapped = withOutboxDrainTriggers(repos, {
      trigger: port,
      reportError: () => {
        throw new Error("sentry down");
      },
    });

    await expect(
      wrapped.rsvpNotices.create({ eventId: "e", humanId: "h" }),
    ).resolves.toEqual({ id: "n1" });
  });
});
