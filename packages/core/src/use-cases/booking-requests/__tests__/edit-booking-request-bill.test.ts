import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";

import {
  BOOKING_LINEUP_REINVITE_EMAIL_COOLDOWN_MS,
  editBookingRequestBill,
  type EditBookingRequestBillDeps,
} from "../edit-booking-request-bill";
import {
  bookingLineupInvitedIdempotencyKey,
  notifyBookingLineupInvited,
} from "../notify-booking-lineup-invited";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  EVENT_ID,
  NOW,
  ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildPerformerProfile,
  buildStageEventRecord,
  systemEntriesFor,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// editBookingRequestBill (lineup-booking-requests v3, FR-009 / L5 / L13 /
// L14): the SENDER changes the bill until an event exists. ACTOR_ID is the
// human sender; DELLA / MAREN are taggable people, MOTH a taggable group.
// ─────────────────────────────────────────────────────────────────────────────

const DELLA = "d1d1d1d1-0000-4000-8000-000000000001";
const MAREN = "d1d1d1d1-0000-4000-8000-000000000002";
const PRIVATE_PAT = "d1d1d1d1-0000-4000-8000-000000000003";
const STRANGER = "d1d1d1d1-0000-4000-8000-000000000004";
const ORG_EDITOR = "d1d1d1d1-0000-4000-8000-000000000005";
const ORG_VIEWER = "d1d1d1d1-0000-4000-8000-000000000006";
const MOTH = "6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a";

const NAMES: Record<string, string> = {
  [ACTOR_ID]: "Sam Sender",
  [DELLA]: "Della",
  [MAREN]: "Maren Sky",
  [PRIVATE_PAT]: "Private Pat",
  [ORG_EDITOR]: "Edie Editor",
};
const PUBLIC_HUMAN_PAGES = new Set([ACTOR_ID, DELLA, MAREN]);

type Options = {
  request?: BookingRequestRecord;
  agreement?: AgreementRecord | null;
  events?: EventRecord[];
  performerEnabled?: boolean;
  rateLimitAllowed?: boolean;
  notifyInvitedFails?: boolean;
  notifyRemovedFails?: boolean;
  reporterThrows?: boolean;
};

function buildDeps(options: Options = {}) {
  let request = options.request ?? buildBookingRequestRecord({ billRecorded: true });
  const agreement = options.agreement ?? null;
  const events = options.events ?? [];

  const bookingRequests = {
    getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
    setActName: vi.fn(async ({ actName }: { id: string; actName: string | null }) => {
      request = { ...request, actName } as BookingRequestRecord;
      return request;
    }),
  };
  const repos = withTx({
    bookingRequests,
    agreements: {
      getById: vi.fn(async (id: string) => (agreement?.id === id ? agreement : null)),
    },
    events: {
      getById: vi.fn(async (id: string) => events.find((event) => event.id === id) ?? null),
    },
    authz: {
      getOrgMembership: vi.fn(
        async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
          orgId === ORG_ID && humanId === ORG_EDITOR
            ? { orgId, humanId, role: "EDITOR" }
            : orgId === ORG_ID && humanId === ORG_VIEWER
              ? { orgId, humanId, role: "VIEWER" }
              : null,
      ),
    },
    audit: { log: vi.fn(async () => {}) },
    humans: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: NAMES[id] ?? "Someone", status: "ACTIVE" })),
      ),
    },
    organizations: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name: id === MOTH ? "Paper Moth" : "Org",
          status: "ACTIVE",
        })),
      ),
    },
    entityPages: {
      getByOwners: vi.fn(async (ownerType: string, ids: string[]) =>
        ownerType === "HUMAN"
          ? ids
              .filter((id) => PUBLIC_HUMAN_PAGES.has(id))
              .map((id) => ({
                id: `page-${id}`,
                ownerType: "HUMAN",
                ownerId: id,
                slug: `slug-${id.slice(0, 4)}`,
                displayName: null,
                visibility: "PUBLIC",
              }))
          : [],
      ),
    },
    performerProfiles: {
      getByOwner: vi.fn(async () =>
        options.performerEnabled ? buildPerformerProfile() : null,
      ),
    },
  });

  const notifyBookingLineupInvited = vi.fn(async () => {
    if (options.notifyInvitedFails) throw new Error("notify down");
  });
  const notifyBookingLineupRemoved = vi.fn(async () => {
    if (options.notifyRemovedFails) throw new Error("removed notice down");
  });
  const reportError = vi.fn(() => {
    if (options.reporterThrows) throw new Error("reporter down");
  });
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const consume = vi.fn(async () => ({
    allowed: options.rateLimitAllowed ?? true,
    remaining: options.rateLimitAllowed === false ? 0 : 29,
    retryAfterSeconds: 60,
  }));

  const deps = {
    repos: repos as unknown as EditBookingRequestBillDeps["repos"],
    clock: { now: () => NOW },
    logger: logger as unknown as EditBookingRequestBillDeps["logger"],
    rateLimit: { consume },
    notifyBookingLineupInvited,
    notifyBookingLineupRemoved,
    reportError,
  } satisfies EditBookingRequestBillDeps;

  return {
    deps,
    repos,
    acts: repos.bookingRequests as unknown as EditBookingRequestBillDeps["repos"]["bookingRequests"],
    audit: (repos as unknown as { audit: { log: ReturnType<typeof vi.fn> } }).audit,
    notifyBookingLineupInvited,
    notifyBookingLineupRemoved,
    reportError,
    logger,
    consume,
    current: () => request,
  };
}

type Acts = EditBookingRequestBillDeps["repos"]["bookingRequests"];

/** SELF at 0, DELLA invited at 1, "Junco" by name at 2. */
async function seedBill(acts: Acts, extra: Parameters<Acts["addActs"]>[1] = []) {
  return acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: DELLA, sortOrder: 1, invitedAt: NOW },
    { source: "EXTERNAL", externalName: "Junco", sortOrder: 2 },
    ...extra,
  ]);
}

const live = async (acts: Acts) => acts.listActsForRequests([REQUEST_ID]);
const all = async (acts: Acts) =>
  acts.listActsForRequests([REQUEST_ID], { includeRemoved: true });

const edit = (ops: unknown[], actorHumanId = ACTOR_ID) => ({
  actorHumanId,
  bookingRequestId: REQUEST_ID,
  ops,
});

const tag = (humanId: string, extra: Record<string, unknown> = {}) => ({
  kind: "add",
  act: { kind: "tagged", humanId, ...extra },
});

function billEntries(repos: unknown) {
  return systemEntriesFor(repos, REQUEST_ID).filter(
    (row) => row.systemKind === "booking_request.bill_changed",
  );
}

async function answer(
  acts: Acts,
  humanId: string,
  to: "CONFIRMED" | "DECLINED",
) {
  await acts.setActConfirmation({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "human",
    actOwnerId: humanId,
    expectedFrom: "PENDING",
    to,
    respondedAt: NOW,
  });
}

describe("editBookingRequestBill — writes", () => {
  it("adds a tagged person and a by-name act: rows, ONE venue-safe entry, the audit, and an invite post-commit", async () => {
    const { deps, repos, acts, audit, notifyBookingLineupInvited, consume } = buildDeps();
    await seedBill(acts);

    const out = await editBookingRequestBill(
      deps,
      edit([
        tag(MAREN, { role: "DJ" }),
        { kind: "add", act: { kind: "external", name: "Paper Kite", url: "https://kite.example" }, position: 1 },
      ]),
    );

    expect(out.changed).toBe(true);
    expect(out.entryWritten).toBe(true);
    const bill = await live(acts);
    expect(bill.map((act) => act.externalName ?? act.actOwnerId)).toEqual([
      ACTOR_ID, "Paper Kite", DELLA, "Junco", MAREN,
    ]);
    const maren = bill.find((act) => act.actOwnerId === MAREN)!;
    expect(maren).toMatchObject({ confirmation: "PENDING", role: "DJ", invitedAt: NOW, sortOrder: 4 });
    expect(bill.map((act) => act.sortOrder)).toEqual([0, 1, 2, 3, 4]);

    const entries = billEntries(repos);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      authorHumanId: ACTOR_ID,
      authorSide: "SYSTEM",
      systemData: {
        added: [
          { name: "Paper Kite", source: "EXTERNAL", state: "by_name" },
          { name: "Maren Sky", source: "TAGGED", state: "invited" },
        ],
        removed: [],
        otherRemovedCount: 0,
        reordered: false,
        roleChanged: false,
      },
    });
    // A by-name act is never linked: no URL, no owner id on the entry.
    expect(JSON.stringify(entries[0]!.systemData)).not.toContain("kite.example");

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.bill_changed", entityId: REQUEST_ID }),
    );
    // One tag → one token of the sender's daily budget.
    expect(consume).toHaveBeenCalledTimes(1);
    expect(notifyBookingLineupInvited).toHaveBeenCalledWith(
      expect.objectContaining({
        taggedHumanIds: [MAREN],
        taggedOrgIds: [],
        inviteGenerations: {},
        actorHumanId: ACTOR_ID,
      }),
    );
    // The sender's own view comes back, passed acts kept.
    expect(out.bill.map((item) => item.displayName)).toEqual([
      "Sam Sender", "Paper Kite", "Della", "Junco", "Maren Sky",
    ]);
  });

  it("takes the bill lock on the TX before the reads it decides on", async () => {
    const { deps, acts, repos } = buildDeps();
    await seedBill(acts);
    const order: string[] = [];
    const lock = acts.lockBill.bind(acts);
    acts.lockBill = vi.fn(async (id: string) => {
      order.push("lock");
      return lock(id);
    });
    const getById = (repos as unknown as { bookingRequests: { getById: ReturnType<typeof vi.fn> } })
      .bookingRequests.getById;
    getById.mockImplementation(async (id: string) => {
      order.push("read");
      return id === REQUEST_ID ? buildBookingRequestRecord({ billRecorded: true }) : null;
    });

    await editBookingRequestBill(deps, edit([{ kind: "removeSelf" }]));
    // pre-flight read, then lock, then the in-tx re-read.
    expect(order).toEqual(["read", "lock", "read"]);
    expect(acts.lockBill).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("removing a JOINED act names it on the entry and tells it; removing an INVITED act is only counted", async () => {
    const { deps, repos, acts, notifyBookingLineupRemoved } = buildDeps();
    await seedBill(acts, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: MAREN, sortOrder: 3, invitedAt: NOW },
    ]);
    await answer(acts, MAREN, "CONFIRMED");
    const bill = await live(acts);
    const della = bill.find((act) => act.actOwnerId === DELLA)!;
    const maren = bill.find((act) => act.actOwnerId === MAREN)!;

    await editBookingRequestBill(
      deps,
      edit([{ kind: "remove", actId: della.id }, { kind: "remove", actId: maren.id }]),
    );

    expect(billEntries(repos)[0]!.systemData).toEqual({
      added: [],
      removed: [{ name: "Maren Sky", wasState: "joined" }],
      otherRemovedCount: 1,
      reordered: false,
      roleChanged: false,
    });
    expect(JSON.stringify(billEntries(repos)[0]!.systemData)).not.toContain("Della");
    // Soft remove: the rows stay, with removedAt.
    const removed = (await all(acts)).filter((act) => act.removedAt);
    expect(removed.map((act) => act.actOwnerId).sort()).toEqual([DELLA, MAREN].sort());
    // Only the JOINED act is told.
    expect(notifyBookingLineupRemoved).toHaveBeenCalledTimes(1);
    expect(notifyBookingLineupRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        acts: [expect.objectContaining({ id: maren.id, confirmation: "CONFIRMED" })],
        actorHumanId: ACTOR_ID,
      }),
    );
  });

  it("removing ONLY a passed act changes the bill but writes NO entry (the venue never saw it)", async () => {
    const { deps, repos, acts, audit, notifyBookingLineupRemoved } = buildDeps();
    await seedBill(acts);
    await answer(acts, DELLA, "DECLINED");
    const della = (await live(acts)).find((act) => act.actOwnerId === DELLA)!;

    const out = await editBookingRequestBill(deps, edit([{ kind: "remove", actId: della.id }]));

    expect(out).toMatchObject({ changed: true, entryWritten: false });
    expect(billEntries(repos)).toEqual([]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entryWritten: false }) }),
    );
    expect(notifyBookingLineupRemoved).not.toHaveBeenCalled();
  });

  it("a role-only edit is recordable: one entry with roleChanged", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    const della = (await live(acts)).find((act) => act.actOwnerId === DELLA)!;

    await editBookingRequestBill(
      deps,
      edit([{ kind: "setRole", actId: della.id, role: "OTHER", customRoleLabel: "  Hype <b>MC</b> " }]),
    );

    expect((await live(acts)).find((act) => act.id === della.id)).toMatchObject({
      role: "OTHER",
      customRoleLabel: "Hype MC",
    });
    expect(billEntries(repos)[0]!.systemData).toEqual({
      added: [],
      removed: [],
      otherRemovedCount: 0,
      reordered: false,
      roleChanged: true,
    });
  });

  it("a passed act's role change writes no entry", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    await answer(acts, DELLA, "DECLINED");
    const della = (await live(acts)).find((act) => act.actOwnerId === DELLA)!;
    await editBookingRequestBill(deps, edit([{ kind: "setRole", actId: della.id, role: "HOST" }]));
    expect(billEntries(repos)).toEqual([]);
  });

  it("moves an act: dense positions, reordered on the entry", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    const junco = (await live(acts)).find((act) => act.externalName === "Junco")!;

    await editBookingRequestBill(deps, edit([{ kind: "move", actId: junco.id, toIndex: 0 }]));

    expect((await live(acts)).map((act) => [act.externalName ?? act.actOwnerId, act.sortOrder])).toEqual([
      ["Junco", 0],
      [ACTOR_ID, 1],
      [DELLA, 2],
    ]);
    expect(billEntries(repos)[0]!.systemData).toMatchObject({ reordered: true, added: [] });
  });

  it("a restored act is asked AGAIN: back to PENDING, a fresh invitedAt, and an invite with a NEW generation key", async () => {
    const { deps, acts, notifyBookingLineupInvited, repos } = buildDeps();
    await seedBill(acts);
    await answer(acts, DELLA, "CONFIRMED");
    const della = (await live(acts)).find((act) => act.actOwnerId === DELLA)!;
    await editBookingRequestBill(deps, edit([{ kind: "remove", actId: della.id }]));

    const later = new Date(NOW.getTime() + 60_000);
    deps.clock = { now: () => later };
    await editBookingRequestBill(deps, edit([tag(DELLA)]));

    const restored = (await all(acts)).filter((act) => act.actOwnerId === DELLA);
    expect(restored).toHaveLength(1); // the SAME row, not a second one
    expect(restored[0]).toMatchObject({
      id: della.id,
      removedAt: null,
      confirmation: "PENDING",
      respondedAt: null,
      invitedAt: later,
    });
    expect(billEntries(repos).at(-1)!.systemData).toMatchObject({
      added: [{ actId: della.id, source: "TAGGED", state: "invited" }],
    });
    const call = notifyBookingLineupInvited.mock.calls.at(-1)![0] as {
      inviteGenerations: Record<string, number>;
    };
    expect(call.inviteGenerations).toEqual({ [`human:${DELLA}`]: later.getTime() });

    // Through the real notifier the key carries the generation — it cannot
    // collide with the first invite's v2 key.
    const notify = vi.fn(async () => ({ ok: true }));
    await notifyBookingLineupInvitedReal(notify, call);
    const key = (notify.mock.calls[0] as unknown as [{ idempotencyKey: string }])[0].idempotencyKey;
    expect(key).toBe(bookingLineupInvitedIdempotencyKey(REQUEST_ID, DELLA, null, later.getTime()));
    expect(key).not.toBe(bookingLineupInvitedIdempotencyKey(REQUEST_ID, DELLA));
  });

  it("the sender goes on and off the bill: removeSelf, then addSelf restores the SAME row at the top", async () => {
    const { deps, acts } = buildDeps({ performerEnabled: true });
    await seedBill(acts);
    const selfRow = (await live(acts)).find((act) => act.source === "SELF")!;

    await editBookingRequestBill(deps, edit([{ kind: "removeSelf" }]));
    expect((await live(acts)).some((act) => act.source === "SELF")).toBe(false);

    await editBookingRequestBill(deps, edit([{ kind: "addSelf" }]));
    const bill = await live(acts);
    expect(bill[0]).toMatchObject({ id: selfRow.id, source: "SELF", sortOrder: 0 });
  });

  it("putting the sender on needs performer mode, as at create", async () => {
    const { deps, acts } = buildDeps({ performerEnabled: false });
    await acts.addActs(REQUEST_ID, [{ source: "EXTERNAL", externalName: "Junco", sortOrder: 0 }]);
    await expect(editBookingRequestBill(deps, edit([{ kind: "addSelf" }]))).rejects.toMatchObject({
      code: "PERFORMER_MODE_REQUIRED",
    });
    expect((await live(acts)).map((act) => act.source)).toEqual(["EXTERNAL"]);
  });

  it("NFR-002: a by-name act's name defaulted as the request's actName gives way to the sender once they go on", async () => {
    const { deps, acts, current } = buildDeps({
      performerEnabled: true,
      request: buildBookingRequestRecord({ billRecorded: true, actName: "Junco" }),
    });
    // Created with "I'm on the bill" off: actName defaulted to the first by-name act.
    await acts.addActs(REQUEST_ID, [
      { source: "EXTERNAL", externalName: "Junco", sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: DELLA, sortOrder: 1, invitedAt: NOW },
    ]);

    await editBookingRequestBill(deps, edit([{ kind: "addSelf" }]));
    expect(current().actName).toBeNull();
  });

  it("NFR-002: with the sender still off, removing the defaulted by-name act moves actName to the next by-name act — never a tagged one", async () => {
    const { deps, acts, current } = buildDeps({
      request: buildBookingRequestRecord({ billRecorded: true, actName: "Junco" }),
    });
    const rows = await acts.addActs(REQUEST_ID, [
      { source: "EXTERNAL", externalName: "Junco", sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: DELLA, sortOrder: 1, invitedAt: NOW },
      { source: "EXTERNAL", externalName: "Paper Kite", sortOrder: 2 },
    ]);

    await editBookingRequestBill(deps, edit([{ kind: "remove", actId: rows[0]!.id }]));
    expect(current().actName).toBe("Paper Kite");
  });

  it("a name the sender typed (they were on the bill) is never touched", async () => {
    const { deps, acts, repos } = buildDeps({
      request: buildBookingRequestRecord({ billRecorded: true, actName: "Junco" }),
    });
    await seedBill(acts);
    await editBookingRequestBill(deps, edit([{ kind: "removeSelf" }]));
    expect(
      (repos as unknown as { bookingRequests: { setActName: ReturnType<typeof vi.fn> } })
        .bookingRequests.setActName,
    ).not.toHaveBeenCalled();
  });

  it("a request from before bills gets its implied SELF row written first, so the edit (and the mint) read a real bill", async () => {
    const { deps, acts, repos } = buildDeps({
      request: buildBookingRequestRecord({ billRecorded: false }),
    });

    await editBookingRequestBill(deps, edit([tag(MAREN)]));

    expect((await live(acts)).map((act) => [act.source, act.sortOrder])).toEqual([
      ["SELF", 0],
      ["TAGGED", 1],
    ]);
    // The venue already saw the sender as the act: only Maren is "added".
    expect(billEntries(repos)[0]!.systemData).toMatchObject({
      added: [{ name: "Maren Sky", state: "invited" }],
    });
  });

  it("ops that change nothing write nothing and open no transaction", async () => {
    const { deps, acts, repos } = buildDeps();
    await acts.addActs(REQUEST_ID, [{ source: "EXTERNAL", externalName: "Junco", sortOrder: 0 }]);
    const out = await editBookingRequestBill(deps, edit([{ kind: "removeSelf" }]));
    expect(out).toMatchObject({ changed: false, entryWritten: false });
    expect((repos as unknown as { tx: ReturnType<typeof vi.fn> }).tx).not.toHaveBeenCalled();
  });
});

/** The real invite notifier over a fake notify, for the key assertion. */
async function notifyBookingLineupInvitedReal(
  notify: ReturnType<typeof vi.fn>,
  args: unknown,
) {
  await notifyBookingLineupInvited(
    {
      repos: {
        humans: { getByIds: vi.fn(async () => []) },
        organizations: { getByIds: vi.fn(async () => []), listMembers: vi.fn() },
      },
      notify,
      publicAppUrl: "https://ithasfire.test",
    } as never,
    args as never,
  );
}

describe("editBookingRequestBill — gates", () => {
  it("only the sender pair: a stranger is NOT_RESOURCE_OWNER; nothing is written", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    await expect(editBookingRequestBill(deps, edit([tag(MAREN)], STRANGER))).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(await live(acts)).toHaveLength(3);
  });

  it("an org sender: edit roles may edit, a VIEWER may not", async () => {
    const orgRequest = buildBookingRequestRecord({
      billRecorded: true,
      performerOwnerType: "organization",
      performerOwnerId: ORG_ID,
    });
    const viewer = buildDeps({ request: orgRequest });
    await expect(
      editBookingRequestBill(viewer.deps, edit([tag(MAREN)], ORG_VIEWER)),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    const editor = buildDeps({ request: orgRequest });
    await expect(
      editBookingRequestBill(editor.deps, edit([tag(MAREN)], ORG_EDITOR)),
    ).resolves.toMatchObject({ changed: true });
  });

  it("an unclaimed anonymous inquiry has no sender to edit as", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "Anon",
        contactEmail: "anon@example.com",
        source: "EMBED",
      }),
    });
    await expect(editBookingRequestBill(deps, edit([tag(MAREN)]))).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  it("a closed request refuses with INVALID_STATUS request_closed", async () => {
    for (const status of ["DECLINED", "WITHDRAWN", "EXPIRED"] as const) {
      const { deps, acts } = buildDeps({
        request: buildBookingRequestRecord({ billRecorded: true, status }),
      });
      await seedBill(acts);
      await expect(editBookingRequestBill(deps, edit([tag(MAREN)]))).rejects.toMatchObject({
        code: "INVALID_STATUS",
        meta: { reason: "request_closed" },
      });
    }
  });

  it("ACCEPTED is editable; once an event exists the bill is LOCKED (the event's lineup is the record)", async () => {
    const accepted = buildDeps({
      request: buildBookingRequestRecord({ billRecorded: true, status: "ACCEPTED", agreementId: AGREEMENT_ID }),
      agreement: buildAgreementRecord(),
    });
    await seedBill(accepted.acts);
    await expect(editBookingRequestBill(accepted.deps, edit([tag(MAREN)]))).resolves.toMatchObject({
      changed: true,
    });

    const minted = buildDeps({
      request: buildBookingRequestRecord({ billRecorded: true, status: "ACCEPTED", agreementId: AGREEMENT_ID }),
      agreement: buildAgreementRecord({ draftEventId: EVENT_ID }),
      events: [buildStageEventRecord({ id: EVENT_ID, status: "DRAFT" })],
    });
    await seedBill(minted.acts);
    await expect(editBookingRequestBill(minted.deps, edit([tag(MAREN)]))).rejects.toMatchObject({
      code: "BILL_LOCKED",
    });
    expect(await live(minted.acts)).toHaveLength(3);
  });

  it("an event-first request is locked from the start", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({ billRecorded: true, originEventId: EVENT_ID }),
    });
    await expect(editBookingRequestBill(deps, edit([tag(MAREN)]))).rejects.toMatchObject({
      code: "BILL_LOCKED",
    });
  });

  it("RENT / USE requests carry no bill", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({ intent: "RENT" }),
    });
    await expect(editBookingRequestBill(deps, edit([tag(MAREN)]))).rejects.toMatchObject({
      code: "BILL_NOT_ALLOWED",
    });
  });

  it("the sender is never a tag; a live act twice is a duplicate; a non-taggable person is refused", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    await expect(editBookingRequestBill(deps, edit([tag(ACTOR_ID)]))).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "self" },
    });
    await expect(editBookingRequestBill(deps, edit([tag(DELLA)]))).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "duplicate" },
    });
    await expect(editBookingRequestBill(deps, edit([tag(MAREN), tag(MAREN)]))).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "duplicate" },
    });
    await expect(editBookingRequestBill(deps, edit([tag(PRIVATE_PAT)]))).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "not_taggable", humanId: PRIVATE_PAT },
    });
    expect(await live(acts)).toHaveLength(3);
  });

  it("an act that passed is never re-added — live or removed (L14)", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    await answer(acts, DELLA, "DECLINED");
    await expect(editBookingRequestBill(deps, edit([tag(DELLA)]))).rejects.toMatchObject({
      code: "ACT_ALREADY_DECLINED",
    });
    const della = (await live(acts)).find((act) => act.actOwnerId === DELLA)!;
    await editBookingRequestBill(deps, edit([{ kind: "remove", actId: della.id }]));
    await expect(editBookingRequestBill(deps, edit([tag(DELLA)]))).rejects.toMatchObject({
      code: "ACT_ALREADY_DECLINED",
    });
  });

  it("no more than 12 live rows", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    const ops = Array.from({ length: 10 }, (_, i) => ({
      kind: "add",
      act: { kind: "external", name: `Act ${i}` },
    }));
    await expect(editBookingRequestBill(deps, edit(ops))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "bill_too_long",
    });
    expect(await live(acts)).toHaveLength(3);
  });

  it("the sender's daily tag budget: refused before any write", async () => {
    const { deps, acts } = buildDeps({ rateLimitAllowed: false });
    await seedBill(acts);
    await expect(editBookingRequestBill(deps, edit([tag(MAREN)]))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      meta: { scope: "lineup_tag_budget" },
    });
    expect(await live(acts)).toHaveLength(3);
  });

  it("an act id the bill no longer holds is a stale edit (CONFLICT); nothing is written", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    await expect(
      editBookingRequestBill(deps, edit([{ kind: "remove", actId: "99999999-0000-4000-8000-000000000000" }])),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "booking_request_bill_stale" });
  });

  it("re-planned UNDER the lock: an act removed by a concurrent edit makes this one stale", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    const della = (await live(acts)).find((act) => act.actOwnerId === DELLA)!;
    const lock = acts.lockBill.bind(acts);
    acts.lockBill = vi.fn(async (id: string) => {
      // Another edit committed between our pre-flight and the lock.
      await acts.softRemoveAct({ bookingRequestId: REQUEST_ID, actId: della.id, at: NOW });
      return lock(id);
    });
    await expect(
      editBookingRequestBill(deps, edit([{ kind: "move", actId: della.id, toIndex: 0 }])),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("editBookingRequestBill — post-commit notices are a deliberate swallow", () => {
  it("a failing invite notifier never fails the committed edit: logger.error + reportError", async () => {
    const { deps, acts, logger, reportError } = buildDeps({ notifyInvitedFails: true });
    await seedBill(acts);

    await expect(editBookingRequestBill(deps, edit([tag(MAREN)]))).resolves.toMatchObject({
      changed: true,
    });
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.edit_bill.notify_invited_failed",
      expect.objectContaining({ bookingRequestId: REQUEST_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "editBookingRequestBill", step: "lineup_invited" },
      }),
    );
  });

  it("a throwing reporter changes nothing", async () => {
    const { deps, acts } = buildDeps({ notifyInvitedFails: true, reporterThrows: true });
    await seedBill(acts);
    await expect(editBookingRequestBill(deps, edit([tag(MAREN)]))).resolves.toMatchObject({
      changed: true,
    });
  });

  it("a failing removal notice never fails the committed edit: logger.error + reportError (step lineup_removed); a throwing reporter is contained", async () => {
    for (const reporterThrows of [false, true]) {
      const { deps, acts, logger, reportError } = buildDeps({
        notifyRemovedFails: true,
        reporterThrows,
      });
      await seedBill(acts);
      await answer(acts, DELLA, "CONFIRMED");
      const della = (await live(acts)).find((act) => act.actOwnerId === DELLA)!;

      await expect(
        editBookingRequestBill(deps, edit([{ kind: "remove", actId: della.id }])),
      ).resolves.toMatchObject({ changed: true, entryWritten: true });
      expect((await all(acts)).find((act) => act.id === della.id)?.removedAt).toEqual(NOW);
      expect(logger.error).toHaveBeenCalledWith(
        "booking_requests.edit_bill.notify_removed_failed",
        expect.objectContaining({ bookingRequestId: REQUEST_ID, removed: 1 }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "editBookingRequestBill", step: "lineup_removed" },
        }),
      );
    }
  });
});

describe("editBookingRequestBill — the re-invite email cooldown (7 days)", () => {
  async function removeAndRestoreAfter(elapsedMs: number) {
    const harness = buildDeps();
    const { deps, acts } = harness;
    await seedBill(acts); // Della invited at NOW
    const della = (await live(acts)).find((act) => act.actOwnerId === DELLA)!;
    await editBookingRequestBill(deps, edit([{ kind: "remove", actId: della.id }]));
    const later = new Date(NOW.getTime() + elapsedMs);
    deps.clock = { now: () => later };
    await editBookingRequestBill(deps, edit([tag(DELLA)]));
    const call = harness.notifyBookingLineupInvited.mock.calls.at(-1)![0] as unknown as {
      inviteInAppOnly: Record<string, true>;
      inviteGenerations: Record<string, number>;
    };
    return { call, later, ...harness };
  }

  it("a re-invite inside 7 days of the act's last invite is IN-APP ONLY", async () => {
    const { call } = await removeAndRestoreAfter(60_000);
    expect(call.inviteInAppOnly).toEqual({ [`human:${DELLA}`]: true });

    // Through the real notifier: no email, no push — still a fresh key.
    const notify = vi.fn(async () => ({ ok: true }));
    await notifyBookingLineupInvitedReal(notify, call);
    expect((notify.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      channels: { sms: { enabled: false }, email: { enabled: false }, push: { enabled: false } },
    });
  });

  it("once 7 days have passed since the last invite, the re-invite emails again", async () => {
    const { call } = await removeAndRestoreAfter(BOOKING_LINEUP_REINVITE_EMAIL_COOLDOWN_MS + 1);
    expect(call.inviteInAppOnly).toEqual({});
    const notify = vi.fn(async () => ({ ok: true }));
    await notifyBookingLineupInvitedReal(notify, call);
    expect((notify.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      channels: { sms: { enabled: false } },
    });
  });

  it("a first invite is never held back; the cooldown reads the PREVIOUS invitedAt, so a loop stays in-app", async () => {
    const harness = buildDeps();
    await seedBill(harness.acts);
    await editBookingRequestBill(harness.deps, edit([tag(MAREN)]));
    expect(
      (harness.notifyBookingLineupInvited.mock.calls[0]![0] as unknown as {
        inviteInAppOnly: Record<string, true>;
      }).inviteInAppOnly,
    ).toEqual({});

    // Remove → restore three times inside a week: never an email.
    const maren = (await live(harness.acts)).find((act) => act.actOwnerId === MAREN)!;
    for (let day = 1; day <= 3; day += 1) {
      harness.deps.clock = { now: () => new Date(NOW.getTime() + day * 2 * 24 * 3600 * 1000) };
      await editBookingRequestBill(harness.deps, edit([{ kind: "remove", actId: maren.id }]));
      await editBookingRequestBill(harness.deps, edit([tag(MAREN)]));
      const call = harness.notifyBookingLineupInvited.mock.calls.at(-1)![0] as unknown as {
        inviteInAppOnly: Record<string, true>;
      };
      expect(call.inviteInAppOnly).toEqual({ [`human:${MAREN}`]: true });
    }
  });
});

describe("editBookingRequestBill — authority re-checked under the lock", () => {
  it("an org editor whose role is revoked between the pre-read and the lock is refused; nothing is written", async () => {
    const orgRequest = buildBookingRequestRecord({
      billRecorded: true,
      performerOwnerType: "organization",
      performerOwnerId: ORG_ID,
    });
    const { deps, acts, repos } = buildDeps({ request: orgRequest });
    await acts.addActs(REQUEST_ID, [{ source: "EXTERNAL", externalName: "Junco", sortOrder: 0 }]);
    const authz = (repos as unknown as {
      authz: { getOrgMembership: ReturnType<typeof vi.fn> };
    }).authz;
    const lock = acts.lockBill.bind(acts);
    acts.lockBill = vi.fn(async (id: string) => {
      // Demoted to VIEWER while the edit waited for the lock.
      authz.getOrgMembership.mockImplementation(async ({ orgId, humanId }) => ({
        orgId,
        humanId,
        role: "VIEWER",
      }));
      return lock(id);
    });

    await expect(
      editBookingRequestBill(deps, edit([tag(MAREN)], ORG_EDITOR)),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect((await live(acts)).map((act) => act.externalName)).toEqual(["Junco"]);
    expect(billEntries(repos)).toEqual([]);
  });
});
