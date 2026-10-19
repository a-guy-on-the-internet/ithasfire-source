import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { resolveOrCreateEventAsk } from "./resolve-event-ask";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ASK_ID = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const baseEvent = {
  id: EVENT_ID,
  orgId: ORG_ID,
  title: "Summer Fest",
  volunteeringEnabled: true,
  volunteerAutoApprove: true,
  volunteerWaiverRequired: false,
  volunteerIntroText: "Come help!",
} as EventRecord;

const existingAsk = {
  id: ASK_ID,
  subjectType: "EVENT" as const,
  subjectId: EVENT_ID,
  orgId: ORG_ID,
  title: "Summer Fest",
  description: null,
  status: "OPEN" as const,
  cadence: "ONE_TIME" as const,
  startsAt: null,
  endsAt: null,
  capacity: null,
  autoApprove: true,
  waiverRequired: false,
  smsOptInEnabled: true,
  formSchema: {},
  createdAt: NOW,
  updatedAt: NOW,
};

function makeTx(volunteering: Record<string, unknown>): TxRepos {
  return { volunteering } as unknown as TxRepos;
}

describe("resolveOrCreateEventAsk", () => {
  it("returns the existing EVENT-subject ask without creating", async () => {
    const createAskIfAbsent = vi.fn();
    const tx = makeTx({
      listAsksBySubject: vi.fn(async () => [existingAsk]),
      createAskIfAbsent,
    });

    const ask = await resolveOrCreateEventAsk(tx, baseEvent);

    expect(ask.id).toBe(ASK_ID);
    expect(createAskIfAbsent).not.toHaveBeenCalled();
  });

  it("lazily creates the ask mirroring the A1 backfill mapping, then re-reads it", async () => {
    const listAsksBySubject = vi
      .fn()
      .mockResolvedValueOnce([]) // first read: nothing yet
      .mockResolvedValueOnce([existingAsk]); // re-read after insert
    const createAskIfAbsent = vi.fn(async () => undefined);
    const tx = makeTx({ listAsksBySubject, createAskIfAbsent });

    const ask = await resolveOrCreateEventAsk(tx, baseEvent);

    expect(ask.id).toBe(ASK_ID);
    expect(createAskIfAbsent).toHaveBeenCalledWith({
      subjectType: "EVENT",
      subjectId: EVENT_ID,
      orgId: ORG_ID,
      title: "Summer Fest",
      description: "Come help!",
      status: "OPEN",
      cadence: "ONE_TIME",
      autoApprove: true,
      waiverRequired: false,
      smsOptInEnabled: true,
      formSchema: {},
    });
    expect(listAsksBySubject).toHaveBeenCalledTimes(2);
  });

  it("creates a CLOSED ask when volunteering is disabled (backfill parity)", async () => {
    const listAsksBySubject = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...existingAsk, status: "CLOSED" }]);
    const createAskIfAbsent = vi.fn(async () => undefined);
    const tx = makeTx({ listAsksBySubject, createAskIfAbsent });

    await resolveOrCreateEventAsk(tx, {
      ...baseEvent,
      volunteeringEnabled: false,
    } as EventRecord);

    expect(createAskIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CLOSED" }),
    );
  });

  it("survives an insert race: skipped insert (ON CONFLICT DO NOTHING) still resolves the winner", async () => {
    const listAsksBySubject = vi
      .fn()
      .mockResolvedValueOnce([]) // first read: nothing yet
      .mockResolvedValueOnce([existingAsk]); // re-read finds the race winner
    // A race loser's createAskIfAbsent resolves normally (no P2002, tx
    // stays healthy) — it just inserted nothing.
    const createAskIfAbsent = vi.fn(async () => undefined);
    const tx = makeTx({ listAsksBySubject, createAskIfAbsent });

    const ask = await resolveOrCreateEventAsk(tx, baseEvent);

    expect(ask.id).toBe(ASK_ID);
    expect(createAskIfAbsent).toHaveBeenCalledTimes(1);
    expect(listAsksBySubject).toHaveBeenCalledTimes(2);
  });

  it("rethrows insert errors untouched", async () => {
    const tx = makeTx({
      listAsksBySubject: vi.fn(async () => []),
      createAskIfAbsent: vi.fn(async () => {
        throw new Error("db down");
      }),
    });

    await expect(resolveOrCreateEventAsk(tx, baseEvent)).rejects.toThrow(
      "db down",
    );
  });

  it("throws INTERNAL when the re-read finds nothing (corrupt state)", async () => {
    const tx = makeTx({
      listAsksBySubject: vi.fn(async () => []),
      createAskIfAbsent: vi.fn(async () => undefined),
    });

    await expect(resolveOrCreateEventAsk(tx, baseEvent)).rejects.toMatchObject(
      { code: "INTERNAL" },
    );
  });
});
