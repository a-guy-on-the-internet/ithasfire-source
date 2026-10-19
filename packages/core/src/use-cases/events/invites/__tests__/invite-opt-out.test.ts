import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import {
  createInviteWorld,
  INVITE_APP_BASE_URL,
  INVITE_EVENT_ID,
  INVITE_OPT_OUT_SECRET,
  INVITE_ORG_ID,
  INVITE_ORGANIZER_ID,
  INVITE_SECRET,
  makeInviteEvent,
  type InviteWorld,
} from "@th/test-utils/fakes/event-invites";

import { mintInviteToken } from "../../../../lib/security/invite-token";
import {
  canonicalInviteEmail,
  deriveInviteOptOutSecret,
  hashInviteOptOutEmail,
  INVITE_OPT_OUT_EMAIL_KEY_LABEL,
  INVITE_OPT_OUT_KEY_LABEL,
  INVITE_OPT_OUT_TOKEN_MAX_LENGTH,
  mintInviteOptOutToken,
  verifyInviteOptOutToken,
} from "../../../../lib/security/invite-optout-token";
import {
  createEventGuestInvites,
  resendEventGuestInvite,
} from "../create-event-guest-invites";
import {
  optOutOfAllInvites,
  optOutOfOrganiserInvites,
  peekInviteOptOut,
} from "../invite-opt-out";
import { peekEventInvite } from "../peek-event-invite";
import { redeemEventInvite } from "../redeem-event-invite";

/**
 * "Stop invites from this organiser" (owner ruling 2026-10-05): a signed,
 * stateless opt-out token per (organiser, address); peek is read-only;
 * confirm is idempotent; every invite send skips opted-out addresses for
 * that organiser only; every invite email carries the link and the
 * RFC 8058 one-click headers.
 */

const ORG_OWNER = { kind: "ORG" as const, orgId: INVITE_ORG_ID };
const OTHER_ORG = "80000000-0000-4000-8000-000000000008";
const OTHER_EVENT = "90000000-0000-4000-8000-000000000009";

const makeMailer = () => ({
  send: vi.fn(async (_input: Record<string, unknown>) => ({
    result: { id: "m", status: "queued" },
  })),
});

const sendDeps = (world: InviteWorld, mailer = makeMailer()) => ({
  repos: world.repos,
  clock: world.clock,
  inviteTokenSecret: INVITE_SECRET,
  appBaseUrl: INVITE_APP_BASE_URL,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
  mailer: mailer as never,
});

const optOutDeps = (world: InviteWorld) => ({
  repos: world.repos,
  inviteOptOutSecret: INVITE_OPT_OUT_SECRET,
});

const tokenFor = (email: string, owner: Parameters<typeof mintInviteOptOutToken>[0]["owner"] = ORG_OWNER) =>
  mintInviteOptOutToken({ owner, email }, INVITE_OPT_OUT_SECRET);

describe("invite opt-out token", () => {
  it("round-trips owner and the keyed hash of the canonical email, and fits the transport bound", () => {
    const token = tokenFor("  Ana@Example.COM ");
    expect(token.startsWith("iso_")).toBe(true);
    expect(verifyInviteOptOutToken(token, INVITE_OPT_OUT_SECRET)).toEqual({
      owner: ORG_OWNER,
      emailHash: hashInviteOptOutEmail("ana@example.com", INVITE_OPT_OUT_SECRET),
    });
    const human = mintInviteOptOutToken(
      { owner: { kind: "HUMAN", humanId: INVITE_ORGANIZER_ID }, email: "b@x.io" },
      INVITE_OPT_OUT_SECRET,
    );
    expect(verifyInviteOptOutToken(human, INVITE_OPT_OUT_SECRET)?.owner).toEqual({
      kind: "HUMAN",
      humanId: INVITE_ORGANIZER_ID,
    });
    const longest = tokenFor(`${"a".repeat(240)}@example.com`);
    expect(longest.length).toBe(INVITE_OPT_OUT_TOKEN_MAX_LENGTH);
    expect(token.length).toBe(INVITE_OPT_OUT_TOKEN_MAX_LENGTH);
  });

  it("never carries the address, readable or base64-decoded (security W3)", () => {
    const token = tokenFor("ana.secret@example.com");
    const decoded = Buffer.from(
      token.slice(4, token.length - 44),
      "base64url",
    ).toString("utf8");
    expect(decoded).toMatch(new RegExp(`^o:${INVITE_ORG_ID}:[A-Za-z0-9_-]{43}$`));
    expect(token + decoded).not.toContain("ana");
    expect(token + decoded).not.toContain("example");
  });

  it("the email hash is keyed by its own HKDF label: another secret gives another hash", () => {
    expect(INVITE_OPT_OUT_EMAIL_KEY_LABEL).toBe("th-invite-optout-email.v1");
    const h = hashInviteOptOutEmail("ana@example.com", INVITE_OPT_OUT_SECRET);
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashInviteOptOutEmail("ana@example.com", "z".repeat(48))).not.toBe(h);
    expect(hashInviteOptOutEmail("bo@example.com", INVITE_OPT_OUT_SECRET)).not.toBe(h);
  });

  it("rejects a forged, tampered, re-keyed or malformed token", () => {
    const token = tokenFor("ana@example.com");
    const other = "x".repeat(48);
    expect(verifyInviteOptOutToken(token, other)).toBeNull();
    // Swap the payload for another address, keep the MAC.
    const mac = token.slice(-43);
    const forgedPayload = Buffer.from(
      `o:${INVITE_ORG_ID}:${hashInviteOptOutEmail("eve@example.com", INVITE_OPT_OUT_SECRET)}`,
    ).toString("base64url");
    expect(
      verifyInviteOptOutToken(`iso_${forgedPayload}_${mac}`, INVITE_OPT_OUT_SECRET),
    ).toBeNull();
    // Flip one MAC char.
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyInviteOptOutToken(flipped, INVITE_OPT_OUT_SECRET)).toBeNull();
    for (const bad of ["", "iso_", "inv_x", 42, null, `iso_${"a".repeat(2000)}`]) {
      expect(verifyInviteOptOutToken(bad, INVITE_OPT_OUT_SECRET)).toBeNull();
    }
    // An invite token is not an opt-out token.
    expect(
      verifyInviteOptOutToken(
        mintInviteToken("90000000-0000-4000-8000-000000000009", INVITE_SECRET),
        INVITE_OPT_OUT_SECRET,
      ),
    ).toBeNull();
  });

  it("derives its own HKDF key, distinct from the root and the invite key", () => {
    const root = "r".repeat(40);
    const key = deriveInviteOptOutSecret(root);
    expect(INVITE_OPT_OUT_KEY_LABEL).toBe("th-invite-optout.v1");
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toBe(root);
    expect(deriveInviteOptOutSecret("short")).toBeNull();
    expect(deriveInviteOptOutSecret(null)).toBeNull();
  });
});

describe("canonicalInviteEmail (security N6: no alias dodge)", () => {
  it.each([
    ["  Ana@Example.COM ", "ana@example.com"],
    ["ana+promo@example.com", "ana@example.com"],
    ["a.n.a@example.com", "a.n.a@example.com"],
    ["a.n.a+x@gmail.com", "ana@gmail.com"],
    ["A.N.A@GoogleMail.com", "ana@gmail.com"],
    ["ana+tag+more@googlemail.com", "ana@gmail.com"],
    ["+only@example.com", "+only@example.com"],
    ["no-at-sign", "no-at-sign"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalInviteEmail(input)).toBe(expected);
  });

  it("aliases hash the same, so they match one opt-out", () => {
    const h = (e: string) => hashInviteOptOutEmail(e, INVITE_OPT_OUT_SECRET);
    expect(h("a.na+news@googlemail.com")).toBe(h("ana@gmail.com"));
    expect(h("bo+x@example.com")).toBe(h("BO@example.com"));
    expect(h("b.o@example.com")).not.toBe(h("bo@example.com"));
  });
});

describe("peekInviteOptOut / optOutOfOrganiserInvites", () => {
  it("peek names the organiser and writes nothing", async () => {
    const world = createInviteWorld();
    const out = await peekInviteOptOut(optOutDeps(world), {
      token: tokenFor("ana@example.com"),
    });
    expect(out).toEqual({
      ok: true,
      organiserName: "Stub Collective",
      organiserGone: false,
      alreadyStopped: null,
    });
    expect(world.optOuts.size).toBe(0);
  });

  it("returns INVALID everywhere for a bad token, writing nothing", async () => {
    const world = createInviteWorld();
    const token = "iso_garbage_" + "a".repeat(43);
    for (const run of [peekInviteOptOut, optOutOfOrganiserInvites, optOutOfAllInvites]) {
      expect(await run(optOutDeps(world), { token })).toEqual({
        ok: false,
        reason: "INVALID",
      });
    }
    expect(world.optOuts.size).toBe(0);
  });

  it("a VALID token whose organiser is gone: peek offers stop-all only, per-organiser stop is INVALID, stop-all works", async () => {
    const world = createInviteWorld();
    const token = tokenFor("ana@example.com", { kind: "ORG", orgId: OTHER_ORG });

    await expect(peekInviteOptOut(optOutDeps(world), { token })).resolves.toEqual({
      ok: true,
      organiserName: null,
      organiserGone: true,
      alreadyStopped: null,
    });
    expect(world.optOuts.size).toBe(0);

    await expect(optOutOfOrganiserInvites(optOutDeps(world), { token })).resolves.toEqual({
      ok: false,
      reason: "INVALID",
    });
    expect(world.optOuts.size).toBe(0);

    await expect(optOutOfAllInvites(optOutDeps(world), { token })).resolves.toEqual({
      ok: true,
      organiserName: null,
      organiserGone: true,
      alreadyStopped: null,
    });
    expect([...world.optOuts]).toEqual([world.optOutAllKey("ana@example.com")]);

    // Peek now shows it, still read-only.
    await expect(peekInviteOptOut(optOutDeps(world), { token })).resolves.toMatchObject({
      ok: true,
      organiserGone: true,
      alreadyStopped: "ALL",
    });
    await expect(optOutOfAllInvites(optOutDeps(world), { token })).resolves.toMatchObject({
      alreadyStopped: "ALL",
    });
    expect(world.optOuts.size).toBe(1);

    // A gone HUMAN organiser behaves the same.
    const humanGone = tokenFor("bo@example.com", {
      kind: "HUMAN",
      humanId: "a0000000-0000-4000-8000-00000000000a",
    });
    const humans = (world.repos as unknown as {
      humans: { getById: (id: string) => Promise<unknown> };
    }).humans;
    const getById = vi.spyOn(humans, "getById").mockResolvedValue(null);
    await expect(optOutOfAllInvites(optOutDeps(world), { token: humanGone })).resolves.toMatchObject({
      ok: true,
      organiserGone: true,
    });
    await expect(
      optOutOfOrganiserInvites(optOutDeps(world), { token: humanGone }),
    ).resolves.toEqual({ ok: false, reason: "INVALID" });
    getById.mockRestore();
  });

  it("confirm records the opt-out, idempotently, and never echoes the address", async () => {
    const world = createInviteWorld();
    const token = tokenFor("Ana@Example.com");
    const first = await optOutOfOrganiserInvites(optOutDeps(world), { token });
    const again = await optOutOfOrganiserInvites(optOutDeps(world), { token });
    expect(first).toEqual({
      ok: true,
      organiserName: "Stub Collective",
      organiserGone: false,
      alreadyStopped: null,
    });
    // The second tap says it was already in place.
    expect(again).toEqual({ ...first, alreadyStopped: "ORGANISER" });
    expect([...world.optOuts]).toEqual([world.optOutKey(ORG_OWNER, "ana@example.com")]);
    // Stored as the hash only.
    expect([...world.optOuts].join()).not.toContain("ana");
    expect(JSON.stringify(first)).not.toContain("ana@");
  });
});

describe("optOutOfAllInvites (\"Stop all event invites\", ruling 3(b))", () => {
  it("records one ownerless row by hash, idempotently, and says so on the second tap", async () => {
    const world = createInviteWorld();
    const token = tokenFor("Ana+news@Example.com");
    const first = await optOutOfAllInvites(optOutDeps(world), { token });
    const again = await optOutOfAllInvites(optOutDeps(world), { token });
    expect(first).toEqual({
      ok: true,
      organiserName: "Stub Collective",
      organiserGone: false,
      alreadyStopped: null,
    });
    expect(again).toEqual({ ...first, alreadyStopped: "ALL" });
    expect([...world.optOuts]).toEqual([world.optOutAllKey("ana@example.com")]);
    expect([...world.optOuts].join()).not.toContain("ana");
    expect(JSON.stringify(again)).not.toContain("ana@");
  });

  it("a per-organiser stop after stop-all reports ALL (the broader one)", async () => {
    const world = createInviteWorld();
    const token = tokenFor("ana@example.com");
    await optOutOfAllInvites(optOutDeps(world), { token });
    await expect(
      optOutOfOrganiserInvites(optOutDeps(world), { token }),
    ).resolves.toMatchObject({ ok: true, alreadyStopped: "ALL" });
  });

  it("stop-all after a per-organiser stop is NOT 'already': it widens it", async () => {
    const world = createInviteWorld();
    const token = tokenFor("ana@example.com");
    await optOutOfOrganiserInvites(optOutDeps(world), { token });
    await expect(optOutOfAllInvites(optOutDeps(world), { token })).resolves.toMatchObject({
      ok: true,
      alreadyStopped: null,
    });
  });

  it("works for a person-owned organiser's token too", async () => {
    const world = createInviteWorld({
      event: { orgId: null, humanId: INVITE_ORGANIZER_ID },
    });
    const out = await optOutOfAllInvites(optOutDeps(world), {
      token: tokenFor("ana@example.com", { kind: "HUMAN", humanId: INVITE_ORGANIZER_ID }),
    });
    expect(out).toEqual({
      ok: true,
      organiserName: "Org Person",
      organiserGone: false,
      alreadyStopped: null,
    });
    expect(world.optOuts.has(world.optOutAllKey("ana@example.com"))).toBe(true);
  });

  it("logs the organiser, never the address", async () => {
    const world = createInviteWorld();
    const info = vi.fn();
    await optOutOfAllInvites(
      { ...optOutDeps(world), logger: { info } as never },
      { token: tokenFor("ana@example.com") },
    );
    expect(info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({
        action: "invite_opt_out_all",
        result: "success",
        metadata: { orgId: INVITE_ORG_ID },
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("ana");
  });
});

describe("peekInviteOptOut alreadyStopped (read-only, own address only)", () => {
  it("reports ORGANISER, then ALL once stop-all lands, and never writes", async () => {
    const world = createInviteWorld();
    const token = tokenFor("ana@example.com");
    world.optOuts.add(world.optOutKey(ORG_OWNER, "ana@example.com"));
    const peekOnce = () => peekInviteOptOut(optOutDeps(world), { token });

    const before = JSON.stringify([...world.optOuts]);
    await expect(peekOnce()).resolves.toMatchObject({ alreadyStopped: "ORGANISER" });
    expect(JSON.stringify([...world.optOuts])).toBe(before);

    world.optOuts.add(world.optOutAllKey("ana@example.com"));
    const after = JSON.stringify([...world.optOuts]);
    await expect(peekOnce()).resolves.toMatchObject({ alreadyStopped: "ALL" });
    await expect(peekOnce()).resolves.toMatchObject({ alreadyStopped: "ALL" });
    expect(JSON.stringify([...world.optOuts])).toBe(after);
  });

  it("calls no write on the repo", async () => {
    const world = createInviteWorld();
    const repo = (world.repos as unknown as {
      eventInviteOptOuts: Record<string, (...a: never[]) => unknown>;
    }).eventInviteOptOuts;
    const add = vi.spyOn(repo, "add");
    const addAll = vi.spyOn(repo, "addForAllOrganisers");
    await peekInviteOptOut(optOutDeps(world), { token: tokenFor("ana@example.com") });
    expect(add).not.toHaveBeenCalled();
    expect(addAll).not.toHaveBeenCalled();
  });

  it("says nothing about other addresses or other organisers", async () => {
    const world = createInviteWorld();
    // Bo stopped everything; Ana stopped another organiser only.
    world.optOuts.add(world.optOutAllKey("bo@example.com"));
    world.optOuts.add(
      world.optOutKey({ kind: "ORG", orgId: OTHER_ORG }, "ana@example.com"),
    );
    await expect(
      peekInviteOptOut(optOutDeps(world), { token: tokenFor("ana@example.com") }),
    ).resolves.toEqual({
      ok: true,
      organiserName: "Stub Collective",
      organiserGone: false,
      alreadyStopped: null,
    });
  });
});

describe("stop-all blocks new sends from EVERY organiser, never old invites", () => {
  const stopAll = (world: InviteWorld, email: string) =>
    optOutOfAllInvites(optOutDeps(world), { token: tokenFor(email) });

  it("a single send from any organiser (org or person) is skipped, counted like any opt-out", async () => {
    const world = createInviteWorld();
    world.events.set(
      OTHER_EVENT,
      makeInviteEvent({ id: OTHER_EVENT, orgId: OTHER_ORG } as Partial<EventRecord>),
    );
    world.memberships.set(`${OTHER_ORG}:${INVITE_ORGANIZER_ID}`, "ADMIN");
    // The link came from THIS organiser's email; it covers the other too.
    await stopAll(world, "ana@example.com");

    for (const eventId of [INVITE_EVENT_ID, OTHER_EVENT]) {
      const mailer = makeMailer();
      const out = await createEventGuestInvites(sendDeps(world, mailer), {
        eventId,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: [{ name: "Ana", email: "Ana+x@Example.com" }],
      });
      expect(out).toMatchObject({ created: 0, sent: 0, skippedOptedOut: 1 });
      expect(mailer.send).not.toHaveBeenCalled();
    }

    const personWorld = createInviteWorld({
      event: { orgId: null, humanId: INVITE_ORGANIZER_ID },
    });
    await stopAll(personWorld, "ana@example.com");
    await expect(
      createEventGuestInvites(sendDeps(personWorld), {
        eventId: INVITE_EVENT_ID,
        actorHumanId: INVITE_ORGANIZER_ID,
        guests: [{ name: "Ana", email: "ana@example.com" }],
      }),
    ).resolves.toMatchObject({ created: 0, skippedOptedOut: 1 });
  });

  it("a list send skips the address in the same opted-out count; others still go", async () => {
    const world = createInviteWorld();
    world.optOuts.add(world.optOutAllKey("listed@example.com"));
    world.optOuts.add(world.optOutKey(ORG_OWNER, "orgonly@example.com"));
    const list = world.addList(undefined, [
      { contactEmail: "listed@example.com" },
      { contactEmail: "orgonly@example.com" },
      { contactEmail: "fine@example.com" },
    ]);
    const out = await createEventGuestInvites(sendDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      contactListId: list.id,
    });
    // Both kinds land in one number: the organiser can't tell them apart.
    expect(out).toMatchObject({ created: 1, skippedOptedOut: 2, skippedUnsubscribed: 0 });
    expect(world.invites.map((i) => i.inviteeEmail)).toEqual(["fine@example.com"]);
  });

  it("a single Resend after stop-all sends nothing and reports optedOut", async () => {
    const world = createInviteWorld();
    await createEventGuestInvites(sendDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    await stopAll(world, "ana@example.com");
    // Past the resend cooldown: it is checked before the opt-out answer.
    world.invites[0]!.sentAt = new Date(world.now.getTime() - 11 * 60_000);
    const mailer = makeMailer();
    const out = await resendEventGuestInvite(sendDeps(world, mailer), {
      eventId: INVITE_EVENT_ID,
      inviteId: world.invites[0]!.id,
      actorHumanId: INVITE_ORGANIZER_ID,
    });
    expect(out).toMatchObject({ sent: false, optedOut: true });
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("an invite sent BEFORE the stop still peeks and redeems", async () => {
    const world = createInviteWorld();
    await createEventGuestInvites(sendDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    const inviteToken = mintInviteToken(world.invites[0]!.id, INVITE_SECRET);
    await stopAll(world, "ana@example.com");

    await expect(
      peekEventInvite(
        { repos: world.repos, clock: world.clock, inviteTokenSecret: INVITE_SECRET },
        { token: inviteToken },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      redeemEventInvite(
        { repos: world.repos, clock: world.clock, inviteTokenSecret: INVITE_SECRET },
        { token: inviteToken, viewerHumanId: null, currentInviteGrantId: null },
      ),
    ).resolves.toMatchObject({ ok: true, eventId: INVITE_EVENT_ID });
  });
});

describe("sends honour the opt-out", () => {
  it("an opted-out hand-typed guest gets no row and no email; others are sent; only a count comes back", async () => {
    const world = createInviteWorld();
    await optOutOfOrganiserInvites(optOutDeps(world), {
      token: tokenFor("ana@example.com"),
    });
    const mailer = makeMailer();
    const out = await createEventGuestInvites(sendDeps(world, mailer), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [
        { name: "Ana", email: "ANA@example.com" },
        { name: "Bo", email: "bo@example.com" },
      ],
    });
    expect(out).toMatchObject({ created: 1, sent: 1, skippedOptedOut: 1 });
    expect(world.invites.map((i) => i.inviteeEmail)).toEqual(["bo@example.com"]);
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it("applies to contact-list sends too", async () => {
    const world = createInviteWorld();
    world.optOuts.add(world.optOutKey(ORG_OWNER, "listed@example.com"));
    const list = world.addList(undefined, [
      { contactEmail: "listed@example.com" },
      { contactEmail: "fine@example.com" },
    ]);
    const out = await createEventGuestInvites(sendDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      contactListId: list.id,
    });
    expect(out).toMatchObject({ created: 1, skippedOptedOut: 1, skippedUnsubscribed: 0 });
  });

  it("applies on a person-owned event, keyed on the owning human", async () => {
    const world = createInviteWorld({
      event: { orgId: null, humanId: INVITE_ORGANIZER_ID },
    });
    world.optOuts.add(
      world.optOutKey({ kind: "HUMAN", humanId: INVITE_ORGANIZER_ID }, "ana@example.com"),
    );
    const out = await createEventGuestInvites(sendDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    expect(out).toMatchObject({ created: 0, sent: 0, skippedOptedOut: 1 });
  });

  it("is scoped to ONE organiser: another org's event still invites the address", async () => {
    const world = createInviteWorld();
    world.optOuts.add(
      world.optOutKey({ kind: "ORG", orgId: OTHER_ORG }, "ana@example.com"),
    );
    world.events.set(
      OTHER_EVENT,
      makeInviteEvent({ id: OTHER_EVENT, orgId: OTHER_ORG } as Partial<EventRecord>),
    );
    world.memberships.set(`${OTHER_ORG}:${INVITE_ORGANIZER_ID}`, "ADMIN");

    const here = await createEventGuestInvites(sendDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    expect(here).toMatchObject({ created: 1, skippedOptedOut: 0 });
    const there = await createEventGuestInvites(sendDeps(world), {
      eventId: OTHER_EVENT,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    expect(there).toMatchObject({ created: 0, skippedOptedOut: 1 });
  });

  it("an alias of an opted-out address (+tag, Gmail dots, googlemail) is skipped too", async () => {
    const world = createInviteWorld();
    await optOutOfOrganiserInvites(optOutDeps(world), {
      token: tokenFor("ana@gmail.com"),
    });
    const mailer = makeMailer();
    const out = await createEventGuestInvites(sendDeps(world, mailer), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [
        { name: "Ana", email: "a.na+again@googlemail.com" },
        { name: "Bo", email: "bo@gmail.com" },
      ],
    });
    expect(out).toMatchObject({ created: 1, sent: 1, skippedOptedOut: 1 });
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it("resendExisting skips a reused invite whose guest opted out since", async () => {
    const world = createInviteWorld();
    const deps = sendDeps(world);
    await createEventGuestInvites(deps, {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    world.optOuts.add(world.optOutKey(ORG_OWNER, "ana@example.com"));
    const mailer = makeMailer();
    const out = await createEventGuestInvites(sendDeps(world, mailer), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
      resendExisting: true,
    });
    expect(out).toMatchObject({ reused: 0, sent: 0, skippedOptedOut: 1 });
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("a single Resend to a guest who opted out sends nothing and says so", async () => {
    const world = createInviteWorld();
    await createEventGuestInvites(sendDeps(world), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "ana@example.com" }],
    });
    const invite = world.invites[0]!;
    // Past the resend cooldown: it is checked before the opt-out answer.
    invite.sentAt = new Date(world.now.getTime() - 11 * 60_000);
    world.suppressed.add("ana@example.com");
    const mailer = makeMailer();
    const out = await resendEventGuestInvite(sendDeps(world, mailer), {
      eventId: INVITE_EVENT_ID,
      inviteId: invite.id,
      actorHumanId: INVITE_ORGANIZER_ID,
    });
    expect(out).toMatchObject({ sent: false, optedOut: true });
    expect(mailer.send).not.toHaveBeenCalled();
  });
});

describe("the invite email carries the opt-out", () => {
  it("footer link + RFC 8058 one-click headers, with the OPT-OUT token only", async () => {
    const world = createInviteWorld();
    const mailer = makeMailer();
    await createEventGuestInvites(sendDeps(world, mailer), {
      eventId: INVITE_EVENT_ID,
      actorHumanId: INVITE_ORGANIZER_ID,
      guests: [{ name: "Ana", email: "Ana@Example.com" }],
    });
    const call = mailer.send.mock.calls[0]![0] as {
      headers: Record<string, string>;
      template: { variables: Record<string, unknown> };
    };
    const optOut = encodeURIComponent(tokenFor("ana@example.com"));
    expect(call.template.variables.stopInvitesUrl).toBe(
      `${INVITE_APP_BASE_URL}/invites/stop?token=${optOut}`,
    );
    expect(call.headers).toEqual({
      "List-Unsubscribe": `<${INVITE_APP_BASE_URL}/api/invites/stop?token=${optOut}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    const inviteToken = mintInviteToken(world.invites[0]!.id, INVITE_SECRET);
    expect(JSON.stringify(call.headers)).not.toContain(inviteToken);
    expect(String(call.template.variables.stopInvitesUrl)).not.toContain(inviteToken);
  });

  it("refuses to send at all without the opt-out key (NOT_CONFIGURED)", async () => {
    const world = createInviteWorld();
    const mailer = makeMailer();
    await expect(
      createEventGuestInvites(
        { ...sendDeps(world, mailer), inviteOptOutSecret: null },
        {
          eventId: INVITE_EVENT_ID,
          actorHumanId: INVITE_ORGANIZER_ID,
          guests: [{ name: "Ana", email: "ana@example.com" }],
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(world.invites).toHaveLength(0);
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
