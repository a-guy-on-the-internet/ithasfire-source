import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import {
  lineupNoticeOwedKey,
  makeLineupNoticeHooks,
} from "../../event-humans/notify-lineup-notices";
import {
  inviteLineupHumanToRegister,
  type InviteLineupHumanToRegisterDeps,
} from "../invite-lineup-human-to-register";

// `inviteLineupHumanToRegister` promised "the transport layer sends a
// transactional email" and nothing ever did. Now the post-commit hook sends
// the payout invite, and the person gets the lineup notice by the lineup
// timing rules — in-app/push only, so one event mails them once.

const ACTOR = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000002";
const ROW = "00000000-0000-4000-8000-000000000003";
const PERSON = "00000000-0000-4000-8000-000000000004";
const ORG_ID = "00000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-09-30T12:00:00.000Z");

function makeHarness(options: {
  status?: "DRAFT" | "PUBLISHED";
  hook?: "real" | "throwing";
  personIsActor?: boolean;
} = {}) {
  const linkedHumanId = options.personIsActor ? ACTOR : PERSON;
  const row = {
    id: ROW,
    eventId: EVENT_ID,
    humanId: null as string | null,
    externalName: "The Sundowners",
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    profileSlug: null,
    humanDisplayName: null,
  };
  const state = { status: options.status ?? "PUBLISHED" };
  const event = () => ({
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Friday Night Sessions",
    status: state.status,
    startsAt: new Date("2026-10-04T22:00:00.000Z"),
    endsAt: new Date("2026-10-05T02:00:00.000Z"),
    timezone: "America/Chicago",
  });
  const eventHumans = {
    getById: vi.fn(async () => ({ ...row })),
    listByEvent: vi.fn(async () => [{ ...row }]),
    linkHuman: vi.fn(async ({ humanId }: { humanId: string }) => {
      row.humanId = humanId;
      return { ...row };
    }),
  };
  const events = {
    getById: vi.fn(async () => event()),
    listTicketTypes: vi.fn(async () => [{ priceCents: 2000, pricingMode: "FIXED" }]),
  };
  const humans = {
    ensureGuestHuman: vi.fn(async () => ({ humanId: linkedHumanId, created: true })),
    update: vi.fn(async () => ({})),
    getById: vi.fn(async (id: string) => ({ id, name: id === ACTOR ? "Sam Rivera" : null })),
    getByIdWithIdentity: vi.fn(async () => ({
      human: {},
      identity: { email: "band@example.org", emailVerified: false, username: null },
    })),
    listAuthAccounts: vi.fn(async () => []),
    listEmailVerifiedIds: vi.fn(async (ids: readonly string[]) => [...ids]),
  };
  const tx = {
    eventHumans,
    events,
    // Inert stand-ins for tx repos a concurrent workstream writes here.
    entityPages: { getByOwner: vi.fn(async () => null) },
    entityEventNotices: { enqueue: vi.fn() },
  };
  const notify = vi.fn(async () => ({ ok: true, email: { status: "skipped" } })) as any;
  const mailer = {
    send: vi.fn(async (_input: any) => ({ result: { success: true } })),
    sendBatch: vi.fn(),
    health: vi.fn(),
  };
  const reportError = vi.fn();
  const idempotency = createFakeIdempotencyPort();
  const realHooks = makeLineupNoticeHooks({
    repos: {
      events,
      eventHumans,
      humans,
      organizations: { getById: vi.fn(async () => ({ name: "Acme", slug: "acme" })) },
      entityPages: { getByOwner: vi.fn(async () => null) },
    } as any,
    idempotency,
    notify,
    mailer: mailer as any,
    publicAppUrl: "https://ithasfire.com",
    reportError,
  });
  const realHook = realHooks.dispatch;
  const linkOrder: string[] = [];
  const recordOwed = vi.fn(async (args: any) => {
    linkOrder.push("owed");
    return realHooks.recordOwed(args);
  });
  const origLink = eventHumans.linkHuman;
  eventHumans.linkHuman = vi.fn(async (a: any) => {
    linkOrder.push("link");
    return origLink(a);
  }) as any;
  const hook = vi.fn(
    options.hook === "throwing"
      ? async () => {
          throw new Error("hook exploded");
        }
      : realHook,
  );
  const deps = {
    repos: {
      eventHumans,
      humans,
      audit: { log: vi.fn(async () => undefined) },
      tx: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    },
    authz: { canEditEvent: vi.fn(async () => ({ allowed: true })) },
    clock: { now: () => NOW },
    lineupNotices: { recordOwed, dispatch: hook },
    reportError,
  } as unknown as InviteLineupHumanToRegisterDeps;
  return { deps, hook, recordOwed, notify, mailer, reportError, state, realHook, idempotency, linkOrder };
}

const invite = { actorHumanId: ACTOR, eventHumanId: ROW, email: "band@example.org" };

describe("inviteLineupHumanToRegister — invite email + lineup notice", () => {
  it("fires the hook once with the typed address, post-commit", async () => {
    const h = makeHarness();
    await inviteLineupHumanToRegister(h.deps, invite);
    expect(h.hook).toHaveBeenCalledTimes(1);
    expect(h.hook).toHaveBeenCalledWith({
      kind: "invited",
      eventId: EVENT_ID,
      eventHumanId: ROW,
      addedByHumanId: ACTOR,
      humanId: PERSON,
      email: "band@example.org",
    });
  });

  it("writes the OWED fact BEFORE the link's tx", async () => {
    const h = makeHarness({ status: "DRAFT" });
    await inviteLineupHumanToRegister(h.deps, invite);
    expect(h.linkOrder).toEqual(["owed", "link"]);
    expect(await h.idempotency.get(lineupNoticeOwedKey(ROW))).toEqual({
      addedByHumanId: ACTOR,
      via: "invite",
    });
  });

  it("PUBLISHED: the invite is mailed once and the lineup notice goes in-app only", async () => {
    const h = makeHarness({ status: "PUBLISHED" });
    await inviteLineupHumanToRegister(h.deps, invite);

    expect(h.mailer.send).toHaveBeenCalledTimes(1);
    expect(h.mailer.send.mock.calls[0][0]).toMatchObject({
      to: { to: "band@example.org" },
      template: {
        key: "event.lineup_payout_invite",
        variables: {
          inviterName: "Sam Rivera",
          accountCompletionUrl:
            "https://ithasfire.com/auth/complete?email=band%40example.org&src=lineup-invite",
        },
      },
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({
      humanId: PERSON,
      variant: "event.lineup-added",
      channels: { email: { enabled: false } },
    });
  });

  it("DRAFT: the invite is mailed now; the lineup notice waits for publish", async () => {
    const h = makeHarness({ status: "DRAFT" });
    await inviteLineupHumanToRegister(h.deps, invite);
    expect(h.mailer.send).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();

    h.state.status = "PUBLISHED";
    await h.realHook({ kind: "published", eventId: EVENT_ID });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].channels.email).toEqual({ enabled: false });
    // Still exactly one email.
    expect(h.mailer.send).toHaveBeenCalledTimes(1);
  });

  it("the typed address resolving to the actor's own account mails nobody", async () => {
    const h = makeHarness({ personIsActor: true });
    await inviteLineupHumanToRegister(h.deps, invite);
    expect(h.recordOwed).not.toHaveBeenCalled();
    expect(h.hook).not.toHaveBeenCalled();
    expect(h.mailer.send).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a throwing hook never fails the link — it is reported", async () => {
    const h = makeHarness({ hook: "throwing" });
    await expect(inviteLineupHumanToRegister(h.deps, invite)).resolves.toEqual({
      eventHumanId: ROW,
    });
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0][1]).toMatchObject({
      tags: { useCase: "inviteLineupHumanToRegister", stage: "lineup_notice" },
    });
  });
});
