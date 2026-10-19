import { beforeEach, describe, expect, it, vi } from "vitest";

import { claimPendingTransfer } from "../claim-pending-transfer";
import type {
  ClaimPendingTransferDeps,
  ClaimPendingTransferInput,
} from "../claim-pending-transfer";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PendingTicketTransferRecord } from "@th/ports/repos/pending-ticket-transfers";
import type { TicketRecord } from "@th/ports/repos/tickets";

const SENDER_HUMAN_ID = "66666666-6666-4666-8666-666666666666";
const CLAIMANT_HUMAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECIPIENT_EMAIL = "Recipient@Example.com";

const DEFAULT_TICKET: TicketRecord = {
  id: "44444444-4444-4444-8444-444444444444",
  eventId: "11111111-1111-4111-8111-111111111111",
  ticketTypeId: "55555555-5555-4555-8555-555555555555",
  ownerHumanId: SENDER_HUMAN_ID,
  orderId: "77777777-7777-4777-8777-777777777777",
  orderItemId: "88888888-8888-4888-8888-888888888888",
  seatId: null,
  code: "TK123456",
  status: "VALID",
  issuedAt: new Date("2024-04-15T12:00:00Z"),
  scannedAt: null,
};

const DEFAULT_PENDING: PendingTicketTransferRecord = {
  id: "99999999-9999-4999-8999-999999999999",
  ticketId: DEFAULT_TICKET.id,
  fromHumanId: SENDER_HUMAN_ID,
  recipientEmail: RECIPIENT_EMAIL,
  reason: "gift",
  token: "claim-token-abc",
  status: "PENDING",
  expiresAt: new Date("2024-05-08T18:00:00Z"),
  createdAt: new Date("2024-05-01T12:00:00Z"),
  claimedAt: null,
  claimedByHumanId: null,
  cancelledAt: null,
};

// The ticket's event: it runs across the injected clock (2024-05-01T18:00Z),
// so it is live, not past, unless a test says otherwise.
const LIVE_EVENT = {
  id: DEFAULT_TICKET.eventId,
  startsAt: new Date("2024-05-01T17:00:00Z"),
  endsAt: new Date("2024-05-01T21:00:00Z"),
};

type TestContext = ReturnType<typeof makeContext>;

describe("claimPendingTransfer", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeContext();
    // Both writes are compare-and-swaps; the default is "this claim won".
    ctx.mocks.ticketsTransfer.mockResolvedValue(true);
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(true);
    ctx.mocks.pendingGetByToken.mockResolvedValue({ ...DEFAULT_PENDING });
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...DEFAULT_TICKET });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...LIVE_EVENT });
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: CLAIMANT_HUMAN_ID,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: CLAIMANT_HUMAN_ID,
        email: RECIPIENT_EMAIL.toLowerCase(),
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });
  });

  it("transfers the ticket, marks the pending transfer claimed, and audits", async () => {
    const input = baseInput();

    const result = await claimPendingTransfer(ctx.deps, input);

    expect(result).toEqual({
      ticketId: DEFAULT_TICKET.id,
      eventId: DEFAULT_TICKET.eventId,
      fromHumanId: SENDER_HUMAN_ID,
      toHumanId: CLAIMANT_HUMAN_ID,
      reason: "gift",
      transferredAt: ctx.now,
    });

    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledWith({
      ticketId: DEFAULT_TICKET.id,
      fromHumanId: SENDER_HUMAN_ID,
      toHumanId: CLAIMANT_HUMAN_ID,
      reason: "gift",
      // Compare-and-swap: only a ticket STILL VALID moves, so a refund that
      // landed between the read above and this write makes the claim lose.
      expectedStatus: "VALID",
    });

    expect(ctx.mocks.pendingMarkClaimed).toHaveBeenCalledWith(
      DEFAULT_PENDING.id,
      CLAIMANT_HUMAN_ID,
      ctx.now,
    );

    expect(ctx.mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket",
        entityId: DEFAULT_TICKET.id,
        action: "transfer.email_claimed",
        at: ctx.now,
      }),
    );

    expect(ctx.mocks.metricsIncrement).toHaveBeenCalledWith(
      "ticket.transfer",
      expect.objectContaining({
        eventId: DEFAULT_TICKET.eventId,
        outcome: "success",
        reason: "gift",
        source: "email_claim",
      }),
    );
  });

  it("marks the sender's order item transferred inside the claim tx", async () => {
    await claimPendingTransfer(ctx.deps, baseInput());

    expect(ctx.mocks.orderItemsUpdateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.orderItemsUpdateStatus).toHaveBeenCalledWith(
      DEFAULT_TICKET.orderItemId,
      "transferred",
      ctx.now,
      undefined,
      undefined,
      { expectedStatus: "active" },
    );
    // Same tx as the ownership change: the tx-scoped spy is the one that fired.
    expect(ctx.mocks.txEntered).toHaveBeenCalledTimes(1);
  });

  // ── Money audit 2026-09-08 #19 ────────────────────────────────────────────
  // Same race as `transferTicket`: the owner/status checks above are a READ,
  // the writes below are the WRITE, and nothing holds the row in between under
  // READ COMMITTED. A refund landing in that window used to leave the sender
  // refunded AND the claimant holding a live pass.
  it("refuses when the ticket leaves VALID between the read and the write", async () => {
    ctx.mocks.ticketsTransfer.mockResolvedValue(false);

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_NOT_TRANSFERABLE" });

    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  });

  it("refuses when the order item leaves 'active' between the read and the write", async () => {
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(false);

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_NOT_TRANSFERABLE" });

    expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  });

  it("skips orderItems.updateStatus when ticket has no orderItemId", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...DEFAULT_TICKET,
      orderItemId: null,
    });

    await claimPendingTransfer(ctx.deps, baseInput());

    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
  });

  it("rejects when the claimant's email does not match the recipient", async () => {
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: CLAIMANT_HUMAN_ID,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: CLAIMANT_HUMAN_ID,
        email: "someone-else@example.com",
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "EMAIL_MISMATCH" });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
  });

  it("rejects an UNVERIFIED claimant even when the address matches, writing nothing", async () => {
    // Money audit 2026-09-08 #17. Matching the recipient address is not
    // proof of controlling it: an account can be created with someone else's
    // email and never verified. `transferTicket` already requires
    // `ensureEmailVerified`; the claim path is the other door to the same
    // ownership change and must refuse with the same error.
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: CLAIMANT_HUMAN_ID,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: CLAIMANT_HUMAN_ID,
        email: RECIPIENT_EMAIL.toLowerCase(),
        emailVerified: false,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  });

  it("a VERIFIED claimant with a matching address claims the ticket", async () => {
    // The beforeEach identity is verified; restated here so the pair with the
    // refusal above reads as one contract.
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: CLAIMANT_HUMAN_ID,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: CLAIMANT_HUMAN_ID,
        email: RECIPIENT_EMAIL.toLowerCase(),
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });

    const result = await claimPendingTransfer(ctx.deps, baseInput());

    expect(result.toHumanId).toBe(CLAIMANT_HUMAN_ID);
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.pendingMarkClaimed).toHaveBeenCalledTimes(1);
  });

  it("rejects when the ticket is no longer owned by the sender", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...DEFAULT_TICKET,
      ownerHumanId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_NO_LONGER_OWNED_BY_SENDER" });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
  });

  it("returns cached result on idempotent replay without re-running the tx", async () => {
    const input = baseInput();

    const first = await claimPendingTransfer(ctx.deps, input);
    const replay = await claimPendingTransfer(ctx.deps, input);

    expect(replay).toEqual(first);
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.orderItemsUpdateStatus).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.pendingMarkClaimed).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.txEntered).toHaveBeenCalledTimes(1);
  });

  it("propagates an orderItems.updateStatus failure, writes nothing after it, and frees the idempotency lock", async () => {
    ctx.mocks.orderItemsUpdateStatus.mockRejectedValue(new Error("boom"));
    const input = baseInput();

    await expect(claimPendingTransfer(ctx.deps, input)).rejects.toMatchObject({
      code: "dependency_failed",
      message: "claim_pending_transfer",
      cause: expect.objectContaining({ message: "boom" }),
    });

    // The status write sits between tickets.transfer and markClaimed: the tx
    // callback must abort there so the rollback covers the ownership change.
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
    expect(ctx.mocks.metricsIncrement).toHaveBeenCalledWith(
      "ticket.transfer",
      expect.objectContaining({ outcome: "error", source: "email_claim" }),
    );

    // Lock released via idempotency.fail: a retry re-enters the tx instead of
    // hitting IDEMPOTENCY_LOCK_IN_PROGRESS or a cached result.
    await expect(claimPendingTransfer(ctx.deps, input)).rejects.toMatchObject({
      code: "dependency_failed",
    });
    expect(ctx.mocks.txEntered).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  });
});

// ── Owner rule 2026-09-28: an invite sent before the show is not claimable
// after it. Unless a test says otherwise the invite itself has not expired
// (expiresAt is a week out).
describe("claimPendingTransfer — past events", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeContext();
    ctx.mocks.ticketsTransfer.mockResolvedValue(true);
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(true);
    ctx.mocks.pendingGetByToken.mockResolvedValue({ ...DEFAULT_PENDING });
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...DEFAULT_TICKET });
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: CLAIMANT_HUMAN_ID,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: CLAIMANT_HUMAN_ID,
        email: RECIPIENT_EMAIL.toLowerCase(),
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });
  });

  async function expectRefused() {
    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_TRANSFER_EVENT_PAST" });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
    // The row is left PENDING — not claimed, not silently expired.
    expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  }

  it("refuses a claim after the event has ended", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...LIVE_EVENT,
      endsAt: new Date(ctx.now.getTime() - 60_000),
    });
    await expectRefused();
  });

  it("refuses at the exact end instant", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...LIVE_EVENT,
      endsAt: new Date(ctx.now.getTime()),
    });
    await expectRefused();
  });

  it("uses the start when the event has no end", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...LIVE_EVENT,
      startsAt: new Date(ctx.now.getTime() - 60_000),
      endsAt: null,
    });
    await expectRefused();
  });

  it("still claims while the event is running", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue({ ...LIVE_EVENT });
    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).resolves.toMatchObject({ toHumanId: CLAIMANT_HUMAN_ID });
    expect(ctx.mocks.pendingMarkClaimed).toHaveBeenCalled();
  });

  it("an invite that expired AT the event end reads as event-over, not expired", async () => {
    // The shape every post-show claim now has: initiate caps expiresAt at the
    // event end, so after the show the invite is expired AND the event past.
    const end = new Date(ctx.now.getTime() - 60_000);
    ctx.mocks.pendingGetByToken.mockResolvedValue({
      ...DEFAULT_PENDING,
      expiresAt: end,
    });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...LIVE_EVENT, endsAt: end });
    await expectRefused();
  });

  it("an invite that expired before a still-future event stays PENDING_TRANSFER_EXPIRED", async () => {
    ctx.mocks.pendingGetByToken.mockResolvedValue({
      ...DEFAULT_PENDING,
      expiresAt: new Date(ctx.now.getTime() - 60_000),
    });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...LIVE_EVENT });
    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "PENDING_TRANSFER_EXPIRED" });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
  });

  it("a row already marked EXPIRED (retired by a newer invite) reads as expired before the show", async () => {
    ctx.mocks.pendingGetByToken.mockResolvedValue({
      ...DEFAULT_PENDING,
      status: "EXPIRED",
    });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...LIVE_EVENT });
    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "PENDING_TRANSFER_EXPIRED" });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
  });

  it("a row already marked EXPIRED reads as event-over after the show", async () => {
    ctx.mocks.pendingGetByToken.mockResolvedValue({
      ...DEFAULT_PENDING,
      status: "EXPIRED",
    });
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...LIVE_EVENT,
      endsAt: new Date(ctx.now.getTime() - 60_000),
    });
    await expectRefused();
  });

  it.each([
    ["lapsed, event over", "PENDING", -60_000, true],
    ["lapsed, event ahead", "PENDING", -60_000, false],
    ["retired EXPIRED row, event over", "EXPIRED", 7 * 24 * 3600_000, true],
    ["already CLAIMED", "CLAIMED", 7 * 24 * 3600_000, false],
  ] as const)(
    "a wrong-account caller on a %s invite learns only EMAIL_MISMATCH",
    async (_label, status, expiresInMs, eventOver) => {
      ctx.mocks.pendingGetByToken.mockResolvedValue({
        ...DEFAULT_PENDING,
        status,
        expiresAt: new Date(ctx.now.getTime() + expiresInMs),
      });
      ctx.mocks.eventsGetById.mockResolvedValue(
        eventOver
          ? { ...LIVE_EVENT, endsAt: new Date(ctx.now.getTime() - 60_000) }
          : { ...LIVE_EVENT },
      );
      ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
        human: { id: CLAIMANT_HUMAN_ID },
        identity: { email: "someone-else@example.com", emailVerified: true },
      });

      await expect(
        claimPendingTransfer(ctx.deps, baseInput()),
      ).rejects.toMatchObject({ code: "EMAIL_MISMATCH" });
      // The invite's state was never consulted for this caller.
      expect(ctx.mocks.eventsGetById).not.toHaveBeenCalled();
      expect(ctx.mocks.ticketsGetById).not.toHaveBeenCalled();
      expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    },
  );

  it("refuses when the ticket's event row is gone", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue(null);
    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
  });
});

function baseInput(): ClaimPendingTransferInput {
  return {
    actorHumanId: CLAIMANT_HUMAN_ID,
    token: DEFAULT_PENDING.token,
    clientKey: "claim-key-123456",
  };
}

function makeContext() {
  const pendingGetByToken = vi.fn();
  const pendingMarkClaimed = vi.fn();
  const ticketsGetById = vi.fn();
  const ticketsTransfer = vi.fn();
  const eventsGetById = vi.fn();
  const humansGetByIdWithIdentity = vi.fn();
  const orderItemsUpdateStatus = vi.fn();
  const auditLog = vi.fn();
  const metricsIncrement = vi.fn();
  const txEntered = vi.fn();
  const claimsLockOrderItem = vi.fn(async (): Promise<void> => undefined);
  const claimsGetByOrderItemId = vi.fn(async (): Promise<unknown> => null);
  // The resale order behind an approved claim: the freeze holds until it
  // is REFUNDED (owner ruling 2026-10-05).
  const ordersGetById = vi.fn(async (): Promise<unknown> => null);
  // Pre-tx lookup that picks the ticket's order refund mutex (owner ruling
  // 2026-10-05).
  const orderItemsGetById = vi.fn(async (id: string): Promise<unknown> => ({
    id,
    orderId: DEFAULT_TICKET.orderId,
  }));

  const preTxPendingGetByToken = vi.fn(async (token: string) =>
    pendingGetByToken.getMockImplementation()?.(token),
  );
  const preTxTicketsGetById = vi.fn(async (id: string) =>
    ticketsGetById.getMockImplementation()?.(id),
  );
  // The `mayLock` pre-filter's recipient check (same comparison as the tx).
  const preTxHumansGetByIdWithIdentity = vi.fn(async (id: string) =>
    humansGetByIdWithIdentity.getMockImplementation()?.(id),
  );

  const idempotencyStore = new Map<string, unknown>();
  const idempotencyLocks = new Set<string>();

  const idempotencyTokens = new Map<string, string | undefined>();
  const begin = vi.fn(
    async (key: string, _ttlSec?: number, ownerToken?: string) => {
      if (idempotencyLocks.has(key)) return false;
      idempotencyLocks.add(key);
      idempotencyTokens.set(key, ownerToken);
      return true;
    },
  );
  // Owner-checked, like both real adapters.
  const release = vi.fn(async (key: string, ownerToken: string) => {
    if (!idempotencyLocks.has(key) || idempotencyTokens.get(key) !== ownerToken)
      return false;
    idempotencyLocks.delete(key);
    return true;
  });

  async function commit<T>(key: string, value: T): Promise<void> {
    idempotencyStore.set(key, value);
    idempotencyLocks.delete(key);
  }

  const fail = vi.fn(async (key: string, _error?: string): Promise<void> => {
    idempotencyLocks.delete(key);
  });

  async function get<T>(key: string): Promise<T | null> {
    if (!idempotencyStore.has(key)) {
      return null;
    }
    return idempotencyStore.get(key) as T;
  }

  async function run<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>,
  ): Promise<{ fresh: boolean; result: T }> {
    if (!(await begin(key, ttlSec))) {
      const cached = await get<T>(key);
      if (cached !== null) {
        return { fresh: false, result: cached };
      }
    }
    const result = await fn();
    await commit(key, result);
    return { fresh: true, result };
  }

  const idempotency: IdempotencyPort = {
    begin,
    commit,
    fail,
    get,
    run,
    release,
    purgeExpired: async () => 0,
  };

  const now = new Date("2024-05-01T18:00:00Z");

  // Only the tx-scoped surface carries these spies: the use case must do all
  // of its writes inside repos.tx, so a call routed anywhere else fails loudly.
  // The pre-tx READS that pick the refund lock (invite → ticket → order item)
  // have their own spies, which answer with whatever the tx spy's current
  // fixture is, so "the tx never consulted X" assertions stay about the tx.
  const tx = {
    pendingTicketTransfers: {
      getByToken: pendingGetByToken,
      markClaimed: pendingMarkClaimed,
    },
    tickets: {
      getById: ticketsGetById,
      transfer: ticketsTransfer,
    },
    events: {
      getById: eventsGetById,
    },
    humans: {
      getByIdWithIdentity: humansGetByIdWithIdentity,
    },
    orderItems: {
      updateStatus: orderItemsUpdateStatus,
    },
    claims: {
      lockOrderItem: claimsLockOrderItem,
      getByOrderItemId: claimsGetByOrderItemId,
    },
    orders: {
      getById: ordersGetById,
    },
    audit: {
      log: auditLog,
    },
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => {
      txEntered();
      return fn(tx);
    },
    pendingTicketTransfers: { getByToken: preTxPendingGetByToken },
    tickets: { getById: preTxTicketsGetById },
    humans: { getByIdWithIdentity: preTxHumansGetByIdWithIdentity },
    orderItems: { getById: orderItemsGetById },
  } as unknown as Repos;

  const deps: ClaimPendingTransferDeps = {
    repos,
    idempotency,
    clock: {
      now: vi.fn(() => now),
    },
    metrics: {
      increment: metricsIncrement,
      record: vi.fn(),
    },
    logger: {
      child: vi.fn(() => ({
        warn: vi.fn(),
        withTime: vi.fn(async (_name, runner) => runner()),
      })) as any,
      withTime: vi.fn(async (_name, runner) => runner()),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
    } as any,
  };

  return {
    deps,
    mocks: {
      pendingGetByToken,
      pendingMarkClaimed,
      ticketsGetById,
      ticketsTransfer,
      eventsGetById,
      humansGetByIdWithIdentity,
      orderItemsUpdateStatus,
      auditLog,
      metricsIncrement,
      txEntered,
      claimsLockOrderItem,
      claimsGetByOrderItemId,
      ordersGetById,
      idempotencyFail: fail,
      idempotencyBegin: begin,
      idempotencyRelease: release,
      idempotencyLocks,
      orderItemsGetById,
      preTxTicketsGetById,
      preTxHumansGetByIdWithIdentity,
    },
    now,
  };
}

// ── Owner ruling 2026-10-04: "transfers should be frozen". The sender can
// open a resale claim on the ticket AFTER sending the invite, so acceptance
// re-checks under the same claim lock `createClaim` takes.
describe("claimPendingTransfer — frozen while a resale claim is unresolved", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeContext();
    ctx.mocks.ticketsTransfer.mockResolvedValue(true);
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(true);
    ctx.mocks.pendingGetByToken.mockResolvedValue({ ...DEFAULT_PENDING });
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...DEFAULT_TICKET });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...LIVE_EVENT });
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: CLAIMANT_HUMAN_ID,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: CLAIMANT_HUMAN_ID,
        email: RECIPIENT_EMAIL.toLowerCase(),
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });
  });

  function claimWithStatus(status: string) {
    ctx.mocks.claimsGetByOrderItemId.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      orderItemId: DEFAULT_TICKET.orderItemId,
      orderId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      status,
    });
  }

  for (const status of ["open", "under_review"]) {
    it(`refuses acceptance while the claim is ${status}`, async () => {
      claimWithStatus(status);

      await expect(
        claimPendingTransfer(ctx.deps, baseInput()),
      ).rejects.toMatchObject({ code: "TICKET_UNDER_CLAIM" });

      expect(ctx.mocks.claimsLockOrderItem).toHaveBeenCalledWith(
        DEFAULT_TICKET.orderItemId,
      );
      expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
      expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
      expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
      expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
      // The refusal frees the key: a retry once the claim closes is not
      // locked out.
      expect(ctx.mocks.idempotencyFail).toHaveBeenCalledWith(
        `claim-transfer:${baseInput().token}:${baseInput().clientKey}`,
        expect.any(String),
      );
    });
  }

  for (const status of ["denied", "expired"]) {
    it(`accepts once the claim is ${status}`, async () => {
      claimWithStatus(status);

      const result = await claimPendingTransfer(ctx.deps, baseInput());

      expect(result.toHumanId).toBe(CLAIMANT_HUMAN_ID);
      expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.pendingMarkClaimed).toHaveBeenCalledTimes(1);
    });
  }

  // Owner ruling 2026-10-05: approval commits before its refund lands, and a
  // pending refund or a retry still unwinds the ticket, so an approved claim
  // keeps the freeze until the resale order is REFUNDED.
  it("refuses acceptance while the claim is approved and its refund has not landed", async () => {
    claimWithStatus("approved");
    ctx.mocks.ordersGetById.mockResolvedValue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "SUCCEEDED" });

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_UNDER_CLAIM" });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.ordersGetById).toHaveBeenCalledWith("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });

  it("accepts once the approved claim's order is REFUNDED", async () => {
    claimWithStatus("approved");
    ctx.mocks.ordersGetById.mockResolvedValue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "REFUNDED" });

    const result = await claimPendingTransfer(ctx.deps, baseInput());
    expect(result.toHumanId).toBe(CLAIMANT_HUMAN_ID);
  });

  it("takes the claim lock before reading the claim and before any write", async () => {
    await claimPendingTransfer(ctx.deps, baseInput());

    const lockAt = ctx.mocks.claimsLockOrderItem.mock.invocationCallOrder[0]!;
    expect(lockAt).toBeLessThan(
      ctx.mocks.claimsGetByOrderItemId.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(
      ctx.mocks.ticketsTransfer.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(
      ctx.mocks.orderItemsUpdateStatus.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(
      ctx.mocks.pendingMarkClaimed.mock.invocationCallOrder[0]!,
    );
  });

  it("skips the claim check (and the lock) for a ticket with no order item", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...DEFAULT_TICKET,
      orderItemId: null,
    });

    await claimPendingTransfer(ctx.deps, baseInput());

    expect(ctx.mocks.claimsLockOrderItem).not.toHaveBeenCalled();
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
  });
});

// Owner ruling 2026-10-05: "when the refund is in process nothing can happen
// to the ticket". Accepting an invite holds the refund paths' own per-order
// mutex, keyed by the sender's ticket's order.
describe("claimPendingTransfer — locked out while a refund is in flight", () => {
  let ctx: TestContext;
  const REFUND_KEY = `refund-op:${DEFAULT_TICKET.orderId}`;
  const SITE_KEY = `claim-transfer:${DEFAULT_PENDING.token}:${baseInput().clientKey}`;

  beforeEach(() => {
    ctx = makeContext();
    ctx.mocks.ticketsTransfer.mockResolvedValue(true);
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(true);
    ctx.mocks.pendingGetByToken.mockResolvedValue({ ...DEFAULT_PENDING });
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...DEFAULT_TICKET });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...LIVE_EVENT });
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: { id: CLAIMANT_HUMAN_ID },
      identity: {
        email: RECIPIENT_EMAIL.toLowerCase(),
        emailVerified: true,
      },
    });
  });

  it("holds refund-op:<the ticket's order> after the site claim and frees it after the tx commits", async () => {
    await claimPendingTransfer(ctx.deps, baseInput());

    expect(ctx.mocks.preTxTicketsGetById).toHaveBeenCalledWith(
      DEFAULT_TICKET.id,
    );
    expect(ctx.mocks.orderItemsGetById).toHaveBeenCalledWith(
      DEFAULT_TICKET.orderItemId,
    );
    const begin = ctx.mocks.idempotencyBegin;
    expect(begin).toHaveBeenCalledWith(REFUND_KEY, 60, expect.any(String));
    const siteIdx = begin.mock.calls.findIndex(([k]) => k === SITE_KEY);
    const refundIdx = begin.mock.calls.findIndex(([k]) => k === REFUND_KEY);
    expect(begin.mock.invocationCallOrder[siteIdx]!).toBeLessThan(
      begin.mock.invocationCallOrder[refundIdx]!,
    );
    expect(ctx.mocks.idempotencyRelease).toHaveBeenCalledWith(
      REFUND_KEY,
      begin.mock.calls[refundIdx]![2],
    );
    expect(
      ctx.mocks.idempotencyRelease.mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(ctx.mocks.auditLog.mock.invocationCallOrder[0]!);
    expect(ctx.mocks.idempotencyLocks.has(REFUND_KEY)).toBe(false);
  });

  it("refuses with TICKET_REFUND_IN_PROGRESS while a refund holds the order, writes nothing", async () => {
    ctx.mocks.idempotencyLocks.add(REFUND_KEY);

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_REFUND_IN_PROGRESS" });

    expect(ctx.mocks.claimsLockOrderItem).not.toHaveBeenCalled();
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.pendingMarkClaimed).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
    // Same site-key handling as TICKET_UNDER_CLAIM.
    expect(ctx.mocks.idempotencyFail).toHaveBeenCalledWith(
      SITE_KEY,
      expect.any(String),
    );
    expect(ctx.mocks.idempotencyRelease).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotencyLocks.has(REFUND_KEY)).toBe(true);
  });

  it("a wrong-account caller learns only EMAIL_MISMATCH, not that a refund is running", async () => {
    ctx.mocks.idempotencyLocks.add(REFUND_KEY);
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: { id: CLAIMANT_HUMAN_ID },
      identity: { email: "someone-else@example.com", emailVerified: true },
    });

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "EMAIL_MISMATCH" });
    // Review round 1: a wrong account never touches the order's mutex, and
    // the lock's ticket/order-item reads never run for it.
    expect(
      ctx.mocks.idempotencyBegin.mock.calls.filter(([k]) =>
        String(k).startsWith("refund-op:"),
      ),
    ).toHaveLength(0);
    expect(ctx.mocks.orderItemsGetById).not.toHaveBeenCalled();
  });

  it("frees the lock when the move fails", async () => {
    ctx.mocks.ticketsTransfer.mockResolvedValue(false);

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_NOT_TRANSFERABLE" });

    expect(ctx.mocks.idempotencyRelease).toHaveBeenCalledWith(
      REFUND_KEY,
      expect.any(String),
    );
    expect(ctx.mocks.idempotencyLocks.has(REFUND_KEY)).toBe(false);
  });

  it("refuses when the ticket moved to another order item after the lock was picked", async () => {
    const OTHER_ITEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    ctx.mocks.preTxTicketsGetById.mockResolvedValueOnce({
      ...DEFAULT_TICKET,
      orderItemId: OTHER_ITEM,
    });

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_REFUND_IN_PROGRESS" });
    expect(ctx.mocks.orderItemsGetById).toHaveBeenCalledWith(OTHER_ITEM);
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
  });

  it("takes no refund lock for an unknown token (the tx reports not-found)", async () => {
    ctx.mocks.pendingGetByToken.mockResolvedValue(null);

    await expect(
      claimPendingTransfer(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "PENDING_TRANSFER_NOT_FOUND" });
    expect(
      ctx.mocks.idempotencyBegin.mock.calls.filter(([k]) =>
        String(k).startsWith("refund-op:"),
      ),
    ).toHaveLength(0);
  });
});
