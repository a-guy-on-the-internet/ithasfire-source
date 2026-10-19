import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { TicketRecord } from "@th/ports/repos/tickets";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { initiateEmailTransfer } from "../initiate-email-transfer";
import type {
  InitiateEmailTransferDeps,
  InitiateEmailTransferInput,
} from "../initiate-email-transfer";

const SENDER_ID = "66666666-6666-4666-8666-666666666666";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const TICKET: TicketRecord = {
  id: "44444444-4444-4444-8444-444444444444",
  eventId: EVENT_ID,
  ticketTypeId: "55555555-5555-4555-8555-555555555555",
  ownerHumanId: SENDER_ID,
  orderId: "77777777-7777-4777-8777-777777777777",
  orderItemId: "88888888-8888-4888-8888-888888888888",
  seatId: null,
  code: "TK123456",
  status: "VALID",
  issuedAt: new Date("2026-09-01T12:00:00Z"),
  scannedAt: null,
};

type Row = {
  id: string;
  ticketId: string;
  status: string;
  expiresAt: Date;
} & Record<string, unknown>;

function makeContext() {
  const eventsGetById = vi.fn();
  // A tiny stateful table, so "the old row is EXPIRED and exactly one PENDING
  // row is left" is asserted on state, not on call shapes.
  const rows: Row[] = [];
  const calls: string[] = [];
  const pendingCreate = vi.fn(async (input: Record<string, unknown>) => {
    calls.push("create");
    const row = {
      id: "99999999-9999-4999-8999-999999999999",
      status: "PENDING",
      createdAt: NOW,
      claimedAt: null,
      claimedByHumanId: null,
      cancelledAt: null,
      ...input,
    } as Row;
    rows.push(row);
    return row;
  });
  const expireLapsedForTicket = vi.fn(async (ticketId: string, now: Date) => {
    calls.push("expireLapsed");
    let n = 0;
    for (const r of rows) {
      if (r.ticketId === ticketId && r.status === "PENDING" && r.expiresAt < now) {
        r.status = "EXPIRED";
        n += 1;
      }
    }
    return n;
  });
  const findPendingByTicketId = vi.fn(async (ticketId: string) => {
    calls.push("findPending");
    return (
      rows.find((r) => r.ticketId === ticketId && r.status === "PENDING") ??
      null
    );
  });
  const auditLog = vi.fn();
  const clockNow = vi.fn(() => NOW);
  const claimsLockOrderItem = vi.fn(async (): Promise<void> => undefined);
  const claimsGetByOrderItemId = vi.fn(async (): Promise<unknown> => null);
  // The resale order behind an approved claim: the freeze holds until it
  // is REFUNDED (owner ruling 2026-10-05).
  const ordersGetById = vi.fn(async (): Promise<unknown> => null);
  const ticketsGetById = vi.fn(async (): Promise<TicketRecord> => ({ ...TICKET }));
  // Pre-tx lookup that picks the ticket's order refund mutex (owner ruling
  // 2026-10-05).
  const orderItemsGetById = vi.fn(async (id: string): Promise<unknown> => ({
    id,
    orderId: TICKET.orderId,
  }));

  const tx = {
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        human: { id: SENDER_ID },
        identity: { email: "sender@example.com", emailVerified: true },
      })),
      getByEmail: vi.fn(async () => null),
    },
    tickets: { getById: ticketsGetById },
    pendingTicketTransfers: {
      findPendingByTicketId,
      expireLapsedForTicket,
      create: pendingCreate,
    },
    events: { getById: eventsGetById },
    claims: {
      lockOrderItem: claimsLockOrderItem,
      getByOrderItemId: claimsGetByOrderItemId,
    },
    orders: {
      getById: ordersGetById,
    },
    audit: { log: auditLog },
  } as unknown as TxRepos;

  const idempotency = createFakeIdempotencyPort();
  const deps: InitiateEmailTransferDeps = {
    repos: {
      tx: async <T>(fn: (t: TxRepos) => Promise<T>) => fn(tx),
      tickets: { getById: ticketsGetById },
      orderItems: { getById: orderItemsGetById },
    } as unknown as Repos,
    idempotency,
    clock: { now: clockNow },
  };

  return {
    deps,
    rows,
    calls,
    idempotency,
    mocks: {
      orderItemsGetById,
      eventsGetById,
      pendingCreate,
      expireLapsedForTicket,
      auditLog,
      clockNow,
      claimsLockOrderItem,
      claimsGetByOrderItemId,
      ordersGetById,
      ticketsGetById,
      idempotencyFail: idempotency.fail,
    },
  };
}

function input(): InitiateEmailTransferInput {
  return {
    actorHumanId: SENDER_ID,
    ticketId: TICKET.id,
    recipientEmail: "friend@example.com",
    reason: "gift",
    clientKey: "email-transfer-key-1",
  };
}

function event(startsAt: Date, endsAt: Date | null) {
  return { id: EVENT_ID, startsAt, endsAt };
}

describe("initiateEmailTransfer — past events (owner rule 2026-09-28)", () => {
  let ctx: ReturnType<typeof makeContext>;

  beforeEach(() => {
    ctx = makeContext();
  });

  async function expectRefused() {
    await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toMatchObject(
      { code: "TICKET_TRANSFER_EVENT_PAST" },
    );
    expect(ctx.mocks.pendingCreate).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  }

  it("refuses once the event has ended", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue(
      event(new Date(NOW.getTime() - 4 * 3600_000), new Date(NOW.getTime() - 1)),
    );
    await expectRefused();
  });

  it("refuses at the exact end instant", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue(
      event(new Date(NOW.getTime() - 4 * 3600_000), new Date(NOW.getTime())),
    );
    await expectRefused();
  });

  it("uses the start when the event has no end", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue(event(new Date(NOW.getTime()), null));
    await expectRefused();
  });

  it("keeps the 7-day expiry for an event further out than that", async () => {
    const start = new Date(NOW.getTime() + 30 * DAY_MS);
    ctx.mocks.eventsGetById.mockResolvedValue(
      event(start, new Date(start.getTime() + 4 * 3600_000)),
    );
    const out = await initiateEmailTransfer(ctx.deps, input());
    expect(out.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
  });

  it("caps the invite's expiry at the event's end when that comes sooner", async () => {
    const end = new Date(NOW.getTime() + 6 * 3600_000);
    ctx.mocks.eventsGetById.mockResolvedValue(
      event(new Date(NOW.getTime() + 2 * 3600_000), end),
    );
    const out = await initiateEmailTransfer(ctx.deps, input());
    expect(out.expiresAt).toEqual(end);
    expect(ctx.mocks.pendingCreate).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: end }),
    );
  });

  it("reads the injected clock", async () => {
    const end = new Date(NOW.getTime() + 60_000);
    ctx.mocks.eventsGetById.mockResolvedValue(event(NOW, end));
    ctx.mocks.clockNow.mockReturnValue(end);
    await expectRefused();
  });
});

// A lapsed invite used to block every new invite for its ticket forever
// (nothing expires PENDING rows in the background), and the end-of-event cap
// makes invites lapse sooner. `expiresAt < now` is lapsed; AT `expiresAt` the
// invite is still claimable, so it still blocks.
describe("initiateEmailTransfer — lapsed invites", () => {
  let ctx: ReturnType<typeof makeContext>;
  const OLD_ID = "77777777-0000-4000-8000-000000000001";

  beforeEach(() => {
    ctx = makeContext();
    const start = new Date(NOW.getTime() + 30 * DAY_MS);
    ctx.mocks.eventsGetById.mockResolvedValue(
      event(start, new Date(start.getTime() + 4 * 3600_000)),
    );
  });

  function seedOld(expiresAt: Date) {
    ctx.rows.push({
      id: OLD_ID,
      ticketId: TICKET.id,
      status: "PENDING",
      expiresAt,
      token: "old-token",
    });
  }

  it("a lapsed invite no longer blocks: the new one is created and the old row is EXPIRED", async () => {
    seedOld(new Date(NOW.getTime() - 1));

    const out = await initiateEmailTransfer(ctx.deps, input());

    expect(out.ticketId).toBe(TICKET.id);
    expect(ctx.rows.find((r) => r.id === OLD_ID)?.status).toBe("EXPIRED");
    expect(ctx.rows.filter((r) => r.status === "PENDING")).toHaveLength(1);
    // Retire first, then look for a live one, then insert.
    expect(ctx.calls).toEqual(["expireLapsed", "findPending", "create"]);
    expect(ctx.mocks.expireLapsedForTicket).toHaveBeenCalledWith(TICKET.id, NOW);
  });

  it("a live invite still blocks with PENDING_TRANSFER_ALREADY_EXISTS", async () => {
    seedOld(new Date(NOW.getTime() + 3600_000));

    await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toMatchObject(
      { code: "PENDING_TRANSFER_ALREADY_EXISTS" },
    );
    expect(ctx.rows.find((r) => r.id === OLD_ID)?.status).toBe("PENDING");
    expect(ctx.mocks.pendingCreate).not.toHaveBeenCalled();
  });

  it("an invite AT its expiresAt is still live and still blocks", async () => {
    seedOld(new Date(NOW.getTime()));

    await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toMatchObject(
      { code: "PENDING_TRANSFER_ALREADY_EXISTS" },
    );
    expect(ctx.rows.find((r) => r.id === OLD_ID)?.status).toBe("PENDING");
  });
});

// Owner ruling 2026-10-04: "transfers should be frozen". A ticket whose order
// item carries an `open` / `under_review` resale claim cannot be sent; the
// claim lock is taken before the first write (`expireLapsedForTicket`).
describe("initiateEmailTransfer — frozen while a resale claim is unresolved", () => {
  let ctx: ReturnType<typeof makeContext>;

  beforeEach(() => {
    ctx = makeContext();
    const start = new Date(NOW.getTime() + 30 * DAY_MS);
    ctx.mocks.eventsGetById.mockResolvedValue(
      event(start, new Date(start.getTime() + 4 * 3600_000)),
    );
  });

  function claimWithStatus(status: string) {
    ctx.mocks.claimsGetByOrderItemId.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      orderItemId: TICKET.orderItemId,
      orderId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      status,
    });
  }

  for (const status of ["open", "under_review"]) {
    it(`refuses while the claim is ${status}, before any write`, async () => {
      claimWithStatus(status);

      await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toMatchObject(
        { code: "TICKET_UNDER_CLAIM" },
      );
      expect(ctx.mocks.claimsLockOrderItem).toHaveBeenCalledWith(
        TICKET.orderItemId,
      );
      expect(ctx.mocks.expireLapsedForTicket).not.toHaveBeenCalled();
      expect(ctx.mocks.pendingCreate).not.toHaveBeenCalled();
      expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
      // The refusal frees the key: a retry once the claim closes is not
      // locked out.
      expect(ctx.mocks.idempotencyFail).toHaveBeenCalledWith(
        `pending-transfer:${TICKET.id}:${input().clientKey}`,
        expect.any(String),
      );
    });
  }

  for (const status of ["denied", "expired"]) {
    it(`sends the invite once the claim is ${status}`, async () => {
      claimWithStatus(status);

      const out = await initiateEmailTransfer(ctx.deps, input());

      expect(out.ticketId).toBe(TICKET.id);
      expect(ctx.mocks.pendingCreate).toHaveBeenCalledTimes(1);
    });
  }

  // Owner ruling 2026-10-05: approval commits before its refund lands, and a
  // pending refund or a retry still unwinds the ticket, so an approved claim
  // keeps the freeze until the resale order is REFUNDED.
  it("refuses while the claim is approved and its refund has not landed", async () => {
    claimWithStatus("approved");
    ctx.mocks.ordersGetById.mockResolvedValue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "SUCCEEDED" });

    await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toMatchObject(
      { code: "TICKET_UNDER_CLAIM" },
    );
    expect(ctx.mocks.pendingCreate).not.toHaveBeenCalled();
    expect(ctx.mocks.ordersGetById).toHaveBeenCalledWith("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });

  it("frees the ticket once the approved claim's order is REFUNDED", async () => {
    claimWithStatus("approved");
    ctx.mocks.ordersGetById.mockResolvedValue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "REFUNDED" });

    const out = await initiateEmailTransfer(ctx.deps, input());
    expect(out.ticketId).toBe(TICKET.id);
  });

  it("takes the claim lock before reading the claim and before the first write", async () => {
    await initiateEmailTransfer(ctx.deps, input());

    const lockAt = ctx.mocks.claimsLockOrderItem.mock.invocationCallOrder[0]!;
    expect(lockAt).toBeLessThan(
      ctx.mocks.claimsGetByOrderItemId.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(
      ctx.mocks.expireLapsedForTicket.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(
      ctx.mocks.pendingCreate.mock.invocationCallOrder[0]!,
    );
  });

  it("skips the claim check (and the lock) for a ticket with no order item", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...TICKET, orderItemId: null });

    await initiateEmailTransfer(ctx.deps, input());

    expect(ctx.mocks.claimsLockOrderItem).not.toHaveBeenCalled();
    expect(ctx.mocks.pendingCreate).toHaveBeenCalledTimes(1);
  });
});

// Owner ruling 2026-10-05: "when the refund is in process nothing can happen
// to the ticket". The invite holds the refund paths' own per-order mutex.
describe("initiateEmailTransfer — locked out while a refund is in flight", () => {
  let ctx: ReturnType<typeof makeContext>;
  const REFUND_KEY = `refund-op:${TICKET.orderId}`;
  const SITE_KEY = `pending-transfer:${TICKET.id}:${input().clientKey}`;

  beforeEach(() => {
    ctx = makeContext();
    const start = new Date(NOW.getTime() + 30 * DAY_MS);
    ctx.mocks.eventsGetById.mockResolvedValue(
      event(start, new Date(start.getTime() + 4 * 3600_000)),
    );
  });

  it("holds refund-op:<the ticket's order> after the site claim and frees it after the tx commits", async () => {
    await initiateEmailTransfer(ctx.deps, input());

    const begin = ctx.idempotency.__mocks.begin;
    expect(ctx.mocks.orderItemsGetById).toHaveBeenCalledWith(TICKET.orderItemId);
    expect(begin).toHaveBeenCalledWith(REFUND_KEY, 60, expect.any(String));
    const siteAt =
      begin.mock.invocationCallOrder[
        begin.mock.calls.findIndex(([k]) => k === SITE_KEY)
      ]!;
    const refundIdx = begin.mock.calls.findIndex(([k]) => k === REFUND_KEY);
    expect(siteAt).toBeLessThan(begin.mock.invocationCallOrder[refundIdx]!);

    const release = ctx.idempotency.__mocks.release;
    expect(release).toHaveBeenCalledWith(
      REFUND_KEY,
      begin.mock.calls[refundIdx]![2],
    );
    expect(release.mock.invocationCallOrder[0]!).toBeGreaterThan(
      ctx.mocks.auditLog.mock.invocationCallOrder[0]!,
    );
    // Free again: the next refund acquires at once.
    expect(await ctx.idempotency.begin(REFUND_KEY, 600, "refund")).toBe(true);
  });

  it("refuses with TICKET_REFUND_IN_PROGRESS while a refund holds the order, before any write", async () => {
    expect(await ctx.idempotency.begin(REFUND_KEY, 600, "refund")).toBe(true);

    await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toMatchObject(
      { code: "TICKET_REFUND_IN_PROGRESS" },
    );
    expect(ctx.mocks.claimsLockOrderItem).not.toHaveBeenCalled();
    expect(ctx.mocks.expireLapsedForTicket).not.toHaveBeenCalled();
    expect(ctx.mocks.pendingCreate).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
    // Same site-key handling as TICKET_UNDER_CLAIM.
    expect(ctx.mocks.idempotencyFail).toHaveBeenCalledWith(
      SITE_KEY,
      expect.any(String),
    );
    // The refund's lock is untouched.
    expect(ctx.idempotency.__mocks.release).not.toHaveBeenCalled();
    expect(ctx.idempotency.__tokens.get(REFUND_KEY)).toBe("refund");
  });

  it("tells a caller who does not own the ticket NOT_RESOURCE_OWNER, not that a refund is running", async () => {
    await ctx.idempotency.begin(REFUND_KEY, 600, "refund");
    ctx.idempotency.__mocks.begin.mockClear();
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...TICKET,
      ownerHumanId: "00000000-0000-4000-8000-000000000000",
    });

    await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toMatchObject(
      { code: "NOT_RESOURCE_OWNER" },
    );
    // Review round 1: a non-holder never touches the order's mutex.
    expect(
      ctx.idempotency.__mocks.begin.mock.calls.filter(([k]) =>
        String(k).startsWith("refund-op:"),
      ),
    ).toHaveLength(0);
  });

  it("frees the lock when the move fails", async () => {
    ctx.mocks.pendingCreate.mockRejectedValueOnce(new Error("db down"));

    await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toThrow();

    expect(ctx.idempotency.__mocks.release).toHaveBeenCalledWith(
      REFUND_KEY,
      expect.any(String),
    );
    expect(await ctx.idempotency.begin(REFUND_KEY, 600, "refund")).toBe(true);
  });

  it("refuses when the ticket moved to another order item after the lock was picked", async () => {
    const OTHER_ITEM = "99999999-9999-4999-8999-999999999999";
    ctx.mocks.ticketsGetById.mockResolvedValueOnce({
      ...TICKET,
      orderItemId: OTHER_ITEM,
    });

    await expect(initiateEmailTransfer(ctx.deps, input())).rejects.toMatchObject(
      { code: "TICKET_REFUND_IN_PROGRESS" },
    );
    expect(ctx.mocks.orderItemsGetById).toHaveBeenCalledWith(OTHER_ITEM);
    expect(ctx.mocks.pendingCreate).not.toHaveBeenCalled();
  });

  it("takes no refund lock for a ticket with no order item", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...TICKET, orderItemId: null });

    await initiateEmailTransfer(ctx.deps, input());

    expect(
      ctx.idempotency.__mocks.begin.mock.calls.filter(([k]) =>
        String(k).startsWith("refund-op:"),
      ),
    ).toHaveLength(0);
    expect(ctx.mocks.pendingCreate).toHaveBeenCalledTimes(1);
  });
});

// The claim email's "This link expires on <day>" used the server's zone (UTC
// on Cloud Run): an invite capped at an evening show's end read a day late.
describe("initiateEmailTransfer — claim email expiry date", () => {
  let ctx: ReturnType<typeof makeContext>;
  const send = vi.fn(async (): Promise<unknown> => ({}));

  beforeEach(() => {
    ctx = makeContext();
    send.mockReset();
    send.mockResolvedValue({});
    ctx.deps.mailer = { send } as unknown as InitiateEmailTransferDeps["mailer"];
    ctx.deps.claimBaseUrl = "https://ithasfire.com/claim-transfer";
  });

  function sentMail(): { text: string; html: string } {
    expect(send).toHaveBeenCalledTimes(1);
    return (send.mock.calls[0] as unknown as [{ text: string; html: string }])[0];
  }

  it("dates the expiry in the event's zone", async () => {
    // A Los Angeles show ending 22:30 PDT Thu Oct 1 = 05:30Z Fri Oct 2. The
    // invite caps at that end; UTC and Chicago both read Friday.
    const end = new Date("2026-10-02T05:30:00.000Z");
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...event(new Date("2026-10-02T02:30:00.000Z"), end),
      timezone: "America/Los_Angeles",
    });

    const out = await initiateEmailTransfer(ctx.deps, input());

    expect(out.expiresAt).toEqual(end);
    const mail = sentMail();
    expect(mail.text).toContain("This link expires on Thursday, October 1, 2026.");
    expect(mail.html).toContain("This link expires on Thursday, October 1, 2026.");
  });

  it("an event with no usable zone reads in the platform default, not UTC", async () => {
    // 04:30Z Fri Oct 2 = 23:30 CDT Thu Oct 1.
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...event(
        new Date("2026-10-02T01:30:00.000Z"),
        new Date("2026-10-02T04:30:00.000Z"),
      ),
      timezone: "Not/AZone",
    });

    await initiateEmailTransfer(ctx.deps, input());

    expect(sentMail().text).toContain(
      "This link expires on Thursday, October 1, 2026.",
    );
  });

  it("reports a claim email that failed to send, and the invite stands", async () => {
    const boom = new Error("ses down");
    send.mockRejectedValue(boom);
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    ctx.deps.reportError = reportError;
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...event(
        new Date(NOW.getTime() + 2 * 3600_000),
        new Date(NOW.getTime() + 6 * 3600_000),
      ),
      timezone: "America/Chicago",
    });

    const out = await initiateEmailTransfer(ctx.deps, input());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(out.pendingTransferId).toBeDefined();
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ branch: "claim_email_failed" }),
      }),
    );
  });
});
