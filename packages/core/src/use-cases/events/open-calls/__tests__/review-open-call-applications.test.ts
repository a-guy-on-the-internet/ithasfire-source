/**
 * Open calls v1 step 5 — the ORGANIZER side: who is on it (FR-014), the
 * review queue (FR-012/FR-013) with its trust traces, the first-open stamp
 * (FR-010), votes and notes (FR-014), and that applicant reads never see
 * votes or notes (NFR-002).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import {
  OC_EDITOR_ID,
  OC_EVENT_ID,
  OC_NOW,
  OC_ORG_ID,
  OC_OTHER_ORG_ID,
  OC_PLACE_ID,
  OC_SERIES_ID,
  OC_STRANGER_ID,
  OC_VIEWER_ID,
  createOpenCallWorld,
  type OpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { addApplicationNote } from "../add-application-note";
import { castApplicationVote } from "../cast-application-vote";
import { editOpenCallApplication } from "../edit-open-call-application";
import { getOpenCallApplicationStatus } from "../get-open-call-application-status";
import { listApplicationNotes } from "../list-application-notes";
import { listOpenCallApplications } from "../list-open-call-applications";
import { openOpenCallApplication } from "../open-open-call-application";
import { postApplicationMessage } from "../post-application-message";
import { hashStatusToken } from "../_shared/status-token";
import { isOnOrganizerSide } from "../_shared/organizer-side";
import { toDisplayTraces } from "../_shared/review-card";
import { addEventDate, DAY } from "./open-call-application-helpers";

const HOUR = 60 * 60 * 1000;
/** A second organizer-side reviewer: an EDITOR of the event's org (setup). */
const SECOND_EDITOR_ID = "30000000-0000-4000-8000-0000000000b4";

const at = (offsetMinutes: number) => new Date(OC_NOW.getTime() - 10 * DAY + offsetMinutes * 60_000);

function setup() {
  const world = createOpenCallWorld();
  const clock = { now: () => world.now } as unknown as ClockPort;
  const deps = { repos: world.repos, clock };
  world.memberships.set(`${OC_ORG_ID}:${SECOND_EDITOR_ID}`, "EDITOR");
  const event = world.addEvent({ placeId: OC_PLACE_ID });
  const call = world.addForm({ purpose: "PERFORM", eventId: event.id });
  return { world, deps, event, call };
}

/** A past, published event, optionally with a lineup credit. */
function pastEvent(
  world: OpenCallWorld,
  overrides: Parameters<OpenCallWorld["addEvent"]>[0] = {},
) {
  const startsAt = new Date(OC_NOW.getTime() - 30 * DAY);
  return world.addEvent({
    id: randomUUID(),
    orgId: OC_OTHER_ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3 * HOUR),
    ...overrides,
  });
}

function credit(
  world: OpenCallWorld,
  eventId: string,
  who: { humanId?: string; orgId?: string },
  role = "PERFORMER",
) {
  world.lineup.push({
    id: randomUUID(),
    eventId,
    humanId: who.humanId ?? null,
    orgId: who.orgId ?? null,
    externalName: null,
    externalUrl: null,
    role,
    customRoleLabel: null,
    sortOrder: world.lineup.length,
    createdAt: OC_NOW,
    updatedAt: OC_NOW,
    profileSlug: null,
  } as OpenCallWorld["lineup"][number]);
}

describe("isOnOrganizerSide (FR-014 as amended 2026-10-06: event edit rights)", () => {
  it("org event: OWNER/ADMIN/EDITOR count; SCANNER, VIEWER, FINANCE and another org's member do not", async () => {
    const { world, event } = setup();
    const anchor = { kind: "event" as const, event };
    const owner = randomUUID();
    world.memberships.set(`${OC_ORG_ID}:${owner}`, "OWNER");
    const scanner = randomUUID();
    world.memberships.set(`${OC_ORG_ID}:${scanner}`, "SCANNER");
    const finance = randomUUID();
    world.memberships.set(`${OC_ORG_ID}:${finance}`, "FINANCE");
    const otherOrgMember = randomUUID();
    world.memberships.set(`${OC_OTHER_ORG_ID}:${otherOrgMember}`, "OWNER");

    const authz = world.repos.authz;
    expect(await isOnOrganizerSide(authz, anchor, owner)).toBe(true);
    expect(await isOnOrganizerSide(authz, anchor, OC_EDITOR_ID)).toBe(true); // ADMIN
    expect(await isOnOrganizerSide(authz, anchor, SECOND_EDITOR_ID)).toBe(true); // EDITOR
    expect(await isOnOrganizerSide(authz, anchor, OC_VIEWER_ID)).toBe(false);
    expect(await isOnOrganizerSide(authz, anchor, scanner)).toBe(false);
    expect(await isOnOrganizerSide(authz, anchor, finance)).toBe(false);
    expect(await isOnOrganizerSide(authz, anchor, otherOrgMember)).toBe(false);
    expect(await isOnOrganizerSide(authz, anchor, OC_STRANGER_ID)).toBe(false);
  });

  it("personal event: the owner and an edit-role delegate; a VIEWER/SCANNER delegate and a stranger do not", async () => {
    const { world } = setup();
    const owner = randomUUID();
    const editorDelegate = randomUUID();
    const viewerDelegate = randomUUID();
    const scannerDelegate = randomUUID();
    world.delegations.set(`${owner}:${editorDelegate}`, "EDITOR");
    world.delegations.set(`${owner}:${viewerDelegate}`, "VIEWER");
    world.delegations.set(`${owner}:${scannerDelegate}`, "SCANNER");
    const event = world.addEvent({ id: randomUUID(), orgId: null, humanId: owner });
    const anchor = { kind: "event" as const, event };
    const authz = world.repos.authz;
    expect(await isOnOrganizerSide(authz, anchor, owner)).toBe(true);
    expect(await isOnOrganizerSide(authz, anchor, editorDelegate)).toBe(true);
    expect(await isOnOrganizerSide(authz, anchor, viewerDelegate)).toBe(false);
    expect(await isOnOrganizerSide(authz, anchor, scannerDelegate)).toBe(false);
    expect(await isOnOrganizerSide(authz, anchor, OC_EDITOR_ID)).toBe(false);
  });

  it("series: org series → its edit-role members; personal series → owner + edit delegates; ownerless event → nobody", async () => {
    const { world } = setup();
    const authz = world.repos.authz;
    const orgSeries = world.addSeries();
    expect(await isOnOrganizerSide(authz, { kind: "series", series: orgSeries }, OC_EDITOR_ID)).toBe(true);
    expect(await isOnOrganizerSide(authz, { kind: "series", series: orgSeries }, OC_VIEWER_ID)).toBe(false);
    expect(await isOnOrganizerSide(authz, { kind: "series", series: orgSeries }, OC_STRANGER_ID)).toBe(false);

    const owner = randomUUID();
    const delegate = randomUUID();
    const viewerDelegate = randomUUID();
    world.delegations.set(`${owner}:${delegate}`, "EDITOR");
    world.delegations.set(`${owner}:${viewerDelegate}`, "VIEWER");
    const mine = world.addSeries({ id: randomUUID(), ownerScope: "HUMAN", ownerId: owner });
    expect(await isOnOrganizerSide(authz, { kind: "series", series: mine }, owner)).toBe(true);
    expect(await isOnOrganizerSide(authz, { kind: "series", series: mine }, delegate)).toBe(true);
    expect(await isOnOrganizerSide(authz, { kind: "series", series: mine }, viewerDelegate)).toBe(false);
    expect(await isOnOrganizerSide(authz, { kind: "series", series: mine }, OC_EDITOR_ID)).toBe(false);

    const community = world.addEvent({ id: randomUUID(), orgId: null, humanId: null, stewardship: "COMMUNITY" });
    expect(await isOnOrganizerSide(authz, { kind: "event", event: community }, OC_EDITOR_ID)).toBe(false);
  });
});

describe("listOpenCallApplications (FR-012/FR-013)", () => {
  it("edit rights only: stranger, other-org member, VIEWER, SCANNER and unknown call all get OPEN_CALL_NOT_FOUND", async () => {
    const { world, deps, call } = setup();
    world.addSubmission(call.id, "PENDING");
    const otherOrgMember = randomUUID();
    world.memberships.set(`${OC_OTHER_ORG_ID}:${otherOrgMember}`, "ADMIN");
    const scanner = randomUUID();
    world.memberships.set(`${OC_ORG_ID}:${scanner}`, "SCANNER");

    for (const actor of [OC_STRANGER_ID, otherOrgMember, OC_VIEWER_ID, scanner]) {
      await expect(
        listOpenCallApplications(deps, { actorHumanId: actor, formId: call.id }),
      ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
    }
    await expect(
      listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: randomUUID() }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
    // An ATTEND form is not a call.
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    await expect(
      listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: attend.id }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });

    const editorList = await listOpenCallApplications(deps, {
      actorHumanId: SECOND_EDITOR_ID,
      formId: call.id,
    });
    expect(editorList.items).toHaveLength(1);
  });

  it("an EDITOR delegate of a personal event's owner reviews it; a VIEWER delegate gets OPEN_CALL_NOT_FOUND", async () => {
    const { world, deps } = setup();
    const owner = randomUUID();
    const delegate = randomUUID();
    const viewerDelegate = randomUUID();
    world.delegations.set(`${owner}:${delegate}`, "EDITOR");
    world.delegations.set(`${owner}:${viewerDelegate}`, "VIEWER");
    const event = world.addEvent({ id: randomUUID(), orgId: null, humanId: owner });
    const call = world.addForm({ purpose: "PERFORM", eventId: event.id });
    world.addSubmission(call.id, "PENDING");
    const out = await listOpenCallApplications(deps, { actorHumanId: delegate, formId: call.id });
    expect(out.items).toHaveLength(1);
    await expect(
      listOpenCallApplications(deps, { actorHumanId: viewerDelegate, formId: call.id }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
  });

  it("oldest first, stable (createdAt, id) cursor; there is no sort input", async () => {
    const { world, deps, call } = setup();
    const ids = [3, 1, 2, 5, 4].map(
      (m) => world.addSubmission(call.id, "PENDING", { createdAt: at(m) }).id,
    );
    // Two rows applied in the same instant tie-break on id.
    const tieA = world.addSubmission(call.id, "PENDING", { id: "ffffffff-0000-4000-8000-000000000001", createdAt: at(6) });
    const tieB = world.addSubmission(call.id, "PENDING", { id: "00000000-0000-4000-8000-000000000001", createdAt: at(6) });

    const p1 = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, limit: 3 });
    const p2 = await listOpenCallApplications(deps, {
      actorHumanId: OC_EDITOR_ID,
      formId: call.id,
      limit: 3,
      cursor: p1.nextCursor,
    });
    const p3 = await listOpenCallApplications(deps, {
      actorHumanId: OC_EDITOR_ID,
      formId: call.id,
      limit: 3,
      cursor: p2.nextCursor,
    });
    const order = [...p1.items, ...p2.items, ...p3.items].map((c) => c.submissionId);
    expect(order).toEqual([ids[1], ids[2], ids[0], ids[4], ids[3], tieB.id, tieA.id]);
    expect(p3.nextCursor).toBeNull();

    await expect(
      listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, sort: "votes" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("WITHDRAWN only when the status filter asks; status filter; date filter; my-vote filter", async () => {
    const { world, deps, call } = setup();
    const d1 = addEventDate(world, new Date(OC_NOW.getTime() + 5 * DAY));
    const d2 = addEventDate(world, new Date(OC_NOW.getTime() + 6 * DAY));
    const a = world.addSubmission(call.id, "PENDING", { createdAt: at(1), dateChoices: [{ eventDateId: d1.id }] });
    const b = world.addSubmission(call.id, "REJECTED", { createdAt: at(2), dateChoices: [{ eventDateId: d2.id }] });
    const w = world.addSubmission(call.id, "WITHDRAWN", { createdAt: at(3) });
    const c = world.addSubmission(call.id, "APPROVED", {
      createdAt: at(4),
      dateChoices: [{ eventDateId: d1.id }, { eventDateId: d2.id }],
    });
    const base = { actorHumanId: OC_EDITOR_ID, formId: call.id };
    const ids = async (filter: Record<string, unknown>) =>
      (await listOpenCallApplications(deps, { ...base, filter })).items.map((x) => x.submissionId);

    expect(await ids({})).toEqual([a.id, b.id, c.id]);
    expect(await ids({ statuses: ["WITHDRAWN"] })).toEqual([w.id]);
    expect(await ids({ statuses: ["PENDING", "APPROVED"] })).toEqual([a.id, c.id]);
    expect(await ids({ dateId: d2.id })).toEqual([b.id, c.id]);

    await castApplicationVote(deps, { ...base, submissionId: a.id, vote: "YES" });
    await castApplicationVote(deps, { ...base, submissionId: c.id, vote: "NO" });
    // Another member's vote doesn't count as "mine".
    await castApplicationVote(deps, { actorHumanId: SECOND_EDITOR_ID, formId: call.id, submissionId: b.id, vote: "YES" });
    expect(await ids({ myVote: "YES" })).toEqual([a.id]);
    expect(await ids({ myVote: "NO" })).toEqual([c.id]);
    expect(await ids({ myVote: "MAYBE" })).toEqual([]);
    expect(await ids({ myVote: "NONE" })).toEqual([b.id]);
  });

  it("cards: applied-as, name/photo/link, tally + my vote, notes, unread", async () => {
    const { world, deps, call } = setup();
    const person = randomUUID();
    world.publicPages.set(person, { slug: "ana", avatarUrl: "https://img/ana.png", displayName: "Ana" });
    const s1 = world.addSubmission(call.id, "PENDING", { humanId: person, createdAt: at(1) });
    const s2 = world.addSubmission(call.id, "PENDING", {
      humanId: randomUUID(),
      applyingAsOrgId: OC_OTHER_ORG_ID,
      createdAt: at(2),
    });
    const s3 = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "The Moths",
      guestUrl: "https://moths.example.com",
      contactEmail: "moths@example.com",
      createdAt: at(3),
    });
    const base = { formId: call.id, submissionId: s1.id };
    await castApplicationVote(deps, { ...base, actorHumanId: OC_EDITOR_ID, vote: "YES" });
    await castApplicationVote(deps, { ...base, actorHumanId: SECOND_EDITOR_ID, vote: "MAYBE" });
    await addApplicationNote(deps, { ...base, actorHumanId: SECOND_EDITOR_ID, body: "Saw them last year" });
    world.messages.push({
      id: randomUUID(),
      submissionId: s1.id,
      authorSide: "APPLICANT",
      authorHumanId: person,
      body: "hi",
      readAt: null,
      createdAt: OC_NOW,
    });

    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    const [c1, c2, c3] = out.items;
    expect(c1).toMatchObject({
      submissionId: s1.id,
      appliedAs: "person",
      name: "Ana",
      photoUrl: "https://img/ana.png",
      pageSlug: "ana",
      url: null,
      votes: { yes: 1, maybe: 1, no: 0 },
      myVote: "YES",
      noteCount: 1,
      unreadMessages: 1,
      // The first vote opened it (FR-010).
      openedAt: world.now,
    });
    expect(c2).toMatchObject({ submissionId: s2.id, appliedAs: "org", url: null });
    expect(c3).toMatchObject({
      submissionId: s3.id,
      appliedAs: "guest",
      name: "The Moths",
      url: "https://moths.example.com",
      traces: { newHere: true },
    });
    // The organizer card never carries the guest's email or token hash.
    expect(JSON.stringify(out)).not.toContain("moths@example.com");
    expect(c3).not.toHaveProperty("contactEmail");
    expect(c3).not.toHaveProperty("statusTokenHash");
  });

  it("list cards carry NO answers or questions (FR-010 shape test)", async () => {
    const { world, deps, call } = setup();
    world.addSubmission(call.id, "PENDING", {
      answers: { q: "ANSWER-STILL-EDITABLE" },
      questionsSnapshot: { q: { label: "Q-LABEL", type: "TEXT", order: 0 } } as never,
    });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(Object.keys(out.items[0]!).sort()).toEqual(
      [
        "appliedAs",
        "appliedAt",
        "dateChoices",
        "myVote",
        "name",
        "noteCount",
        "openedAt",
        "pageSlug",
        "photoUrl",
        "status",
        "submissionId",
        "traces",
        "unreadMessages",
        "url",
        "votes",
      ].sort(),
    );
    expect(JSON.stringify(out)).not.toContain("ANSWER-STILL-EDITABLE");
    expect(JSON.stringify(out)).not.toContain("Q-LABEL");
    // The repo card itself has no answers either (the fake mirrors the adapter's select).
    const repoCard = (
      await world.repos.eventApplications.listOpenCallReviewCards(world.reviewQueries[0]!)
    ).items[0]!;
    expect(repoCard.submission).not.toHaveProperty("answers");
    expect(repoCard.submission).not.toHaveProperty("questionsSnapshot");
  });

  it("listing never stamps openedAt", async () => {
    const { world, deps, call } = setup();
    const s = world.addSubmission(call.id, "PENDING");
    await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(s.openedAt).toBeNull();
  });

  it("series call: the queue works and the date filter takes an occurrence id", async () => {
    const { world, deps } = setup();
    world.addSeries();
    const o1 = world.addOccurrence({ startsAt: new Date(OC_NOW.getTime() + 3 * DAY) });
    const o2 = world.addOccurrence({ startsAt: new Date(OC_NOW.getTime() + 10 * DAY) });
    const call = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const a = world.addSubmission(call.id, "PENDING", { createdAt: at(1), dateChoices: [{ occurrenceId: o1.id }] });
    world.addSubmission(call.id, "PENDING", { createdAt: at(2), dateChoices: [{ occurrenceId: o2.id }] });
    const out = await listOpenCallApplications(deps, {
      actorHumanId: SECOND_EDITOR_ID,
      formId: call.id,
      filter: { dateId: o1.id },
    });
    expect(out.items.map((c) => c.submissionId)).toEqual([a.id]);
    expect(out.items[0]!.dateChoices).toEqual([{ id: o1.id, startsAt: o1.startsAt }]);
  });
});

describe("trust traces (FR-013): display only, New here, did-not-organise rule", () => {
  it("toDisplayTraces: null or no nights → New here; zeros become null, never 0", () => {
    expect(toDisplayTraces(null)).toEqual({ newHere: true });
    expect(toDisplayTraces({ playedNights: 0, playedHereNights: 0, ranNights: 0 })).toEqual({ newHere: true });
    expect(toDisplayTraces({ playedNights: 0, playedHereNights: 0, ranNights: 4 })).toEqual({
      newHere: false,
      playedHereNights: null,
      playedNights: null,
      ranNights: 4,
    });
  });

  it("played counts other people's published past nights; own events count as ran, not played", async () => {
    const { world, deps, call } = setup();
    const act = randomUUID();
    // Played twice elsewhere, once here (the call's place).
    credit(world, pastEvent(world).id, { humanId: act });
    credit(world, pastEvent(world, { placeId: OC_PLACE_ID }).id, { humanId: act });
    // Multi-date past event: 2 ended dates + 1 cancelled + 1 future → 2 nights.
    const multi = pastEvent(world);
    addEventDate(world, new Date(OC_NOW.getTime() - 20 * DAY), "SCHEDULED", multi.id);
    addEventDate(world, new Date(OC_NOW.getTime() - 19 * DAY), "SCHEDULED", multi.id);
    addEventDate(world, new Date(OC_NOW.getTime() - 18 * DAY), "CANCELLED", multi.id);
    addEventDate(world, new Date(OC_NOW.getTime() + 2 * DAY), "SCHEDULED", multi.id);
    credit(world, multi.id, { humanId: act });
    // Never count: cancelled, draft, future, a volunteer credit.
    credit(world, pastEvent(world, { status: "CANCELLED" }).id, { humanId: act });
    credit(world, pastEvent(world, { status: "DRAFT" }).id, { humanId: act });
    credit(
      world,
      pastEvent(world, {
        startsAt: new Date(OC_NOW.getTime() + 2 * DAY),
        endsAt: new Date(OC_NOW.getTime() + 2 * DAY + HOUR),
      }).id,
      { humanId: act },
    );
    credit(world, pastEvent(world).id, { humanId: act }, "VOLUNTEER");
    // The act's OWN personal event, with themselves on its lineup: ran, not played.
    const own = pastEvent(world, { orgId: null, humanId: act, placeId: OC_PLACE_ID });
    credit(world, own.id, { humanId: act });

    world.addSubmission(call.id, "PENDING", { humanId: act });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.items[0]!.traces).toEqual({
      newHere: false,
      playedHereNights: 1,
      playedNights: 4,
      ranNights: 1,
    });
  });

  it("a new EDITOR of a venue org, on none of its lineups, is New here (never 'ran' the org's history)", async () => {
    const { world, deps, call } = setup();
    const editor = randomUUID();
    const venueOrg = randomUUID();
    world.memberships.set(`${venueOrg}:${editor}`, "EDITOR");
    for (let i = 0; i < 3; i += 1) {
      credit(world, pastEvent(world, { orgId: venueOrg }).id, { humanId: randomUUID() });
    }
    world.addSubmission(call.id, "PENDING", { humanId: editor });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.items[0]!.traces).toEqual({ newHere: true });
  });

  it("a PRIVATE past published night counts nowhere (played, here or ran)", async () => {
    const { world, deps, call } = setup();
    const act = randomUUID();
    credit(world, pastEvent(world, { visibility: "PRIVATE", placeId: OC_PLACE_ID }).id, { humanId: act });
    pastEvent(world, { visibility: "PRIVATE", orgId: null, humanId: act });
    credit(world, pastEvent(world).id, { humanId: act });
    world.addSubmission(call.id, "PENDING", { humanId: act });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.items[0]!.traces).toEqual({
      newHere: false,
      playedHereNights: null,
      playedNights: 1,
      ranNights: null,
    });
  });

  it("self-booking through your own org is ran, not played; the org's other nights are not hers; a plain member still played", async () => {
    const { world, deps, call } = setup();
    const alice = randomUUID();
    const alicePresents = randomUUID();
    world.memberships.set(`${alicePresents}:${alice}`, "OWNER");
    credit(world, pastEvent(world, { orgId: alicePresents }).id, { humanId: alice });
    // Nights of her org she is NOT on the lineup of are not hers: neither ran nor played.
    pastEvent(world, { orgId: alicePresents });
    credit(world, pastEvent(world, { orgId: alicePresents }).id, { humanId: randomUUID() });
    // Bob is only a VIEWER of another org whose night he played.
    const bob = randomUUID();
    const venueCrew = randomUUID();
    world.memberships.set(`${venueCrew}:${bob}`, "VIEWER");
    credit(world, pastEvent(world, { orgId: venueCrew }).id, { humanId: bob });
    world.addSubmission(call.id, "PENDING", { humanId: alice, createdAt: at(1) });
    world.addSubmission(call.id, "PENDING", { humanId: bob, createdAt: at(2) });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.items[0]!.traces).toEqual({
      newHere: false,
      playedHereNights: null,
      playedNights: null,
      ranNights: 1,
    });
    expect(out.items[1]!.traces).toEqual({
      newHere: false,
      playedHereNights: null,
      playedNights: 1,
      ranNights: null,
    });
    expect(world.reviewQueries.at(-1)!.organiserOrgRoles).toEqual(["OWNER", "ADMIN", "EDITOR"]);
  });

  it("an org applicant: lineups of OTHER orgs' events are played; the org's own events are ran", async () => {
    const { world, deps, call } = setup();
    const band = randomUUID();
    credit(world, pastEvent(world).id, { orgId: band });
    const bandsOwn = pastEvent(world, { orgId: band });
    credit(world, bandsOwn.id, { orgId: band });
    world.addSubmission(call.id, "PENDING", { humanId: randomUUID(), applyingAsOrgId: band });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.items[0]!.traces).toEqual({
      newHere: false,
      playedHereNights: null,
      playedNights: 1,
      ranNights: 1,
    });
  });

  it("an org applicant's own past event counts as ran even with no lineup row for the org", async () => {
    const { world, deps, call } = setup();
    const band = randomUUID();
    // The org organised this night but never put itself on the lineup.
    pastEvent(world, { orgId: band });
    world.addSubmission(call.id, "PENDING", { humanId: randomUUID(), applyingAsOrgId: band });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.items[0]!.traces).toEqual({
      newHere: false,
      playedHereNights: null,
      playedNights: null,
      ranNights: 1,
    });
  });

  it("a signed-in newcomer is New here, never zeros", async () => {
    const { world, deps, call } = setup();
    world.addSubmission(call.id, "PENDING", { humanId: randomUUID() });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.items[0]!.traces).toEqual({ newHere: true });
  });

  it("traces never change the order: a veteran applying later stays after a newcomer", async () => {
    const { world, deps, call } = setup();
    const veteran = randomUUID();
    for (let i = 0; i < 5; i += 1) credit(world, pastEvent(world).id, { humanId: veteran });
    const newcomer = world.addSubmission(call.id, "PENDING", { humanId: randomUUID(), createdAt: at(1) });
    const vet = world.addSubmission(call.id, "PENDING", { humanId: veteran, createdAt: at(2) });
    const out = await listOpenCallApplications(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.items.map((c) => c.submissionId)).toEqual([newcomer.id, vet.id]);
    // Core asks the repo for the public-lineup roles (no VOLUNTEER).
    expect(world.reviewQueries.at(-1)!.lineupRoles).not.toContain("VOLUNTEER");
  });
});

describe("openOpenCallApplication (FR-010)", () => {
  it("first open stamps openedAt once and locks the applicant's edit; later opens change nothing", async () => {
    const { world, deps, call } = setup();
    const token = "T".repeat(43);
    const s = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "Guest",
      contactEmail: "g@example.com",
      statusTokenHash: hashStatusToken(token),
    });
    const first = await openOpenCallApplication(deps, {
      actorHumanId: SECOND_EDITOR_ID,
      formId: call.id,
      submissionId: s.id,
    });
    expect(first.firstOpen).toBe(true);
    expect(first.card.openedAt).toEqual(world.now);
    expect(first.answers).toEqual({ q: "private answer text" });
    expect(s.openedAt).toEqual(world.now);
    expect(world.audit.filter((a) => a.action === "open_call_application_opened")).toHaveLength(1);

    const again = await openOpenCallApplication(deps, {
      actorHumanId: OC_EDITOR_ID,
      formId: call.id,
      submissionId: s.id,
    });
    expect(again.firstOpen).toBe(false);
    expect(world.audit.filter((a) => a.action === "open_call_application_opened")).toHaveLength(1);

    // Step 4's edit is now locked.
    await expect(
      editOpenCallApplication(deps, {
        auth: { kind: "token", token },
        answers: {},
        dateIds: [],
        isPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_LOCKED" });
  });

  it("opens a WITHDRAWN card too (any status) and returns its notes", async () => {
    const { world, deps, call } = setup();
    const s = world.addSubmission(call.id, "WITHDRAWN");
    await addApplicationNote(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: s.id, body: "n1" });
    const out = await openOpenCallApplication(deps, {
      actorHumanId: OC_EDITOR_ID,
      formId: call.id,
      submissionId: s.id,
    });
    expect(out.card.status).toBe("WITHDRAWN");
    expect(out.notes.map((n) => n.body)).toEqual(["n1"]);
  });

  it("stranger, VIEWER, SCANNER, other org, and cross-call ids all get OPEN_CALL_APPLICATION_NOT_FOUND; nothing stamped", async () => {
    const { world, deps, call } = setup();
    const s = world.addSubmission(call.id, "PENDING");
    const scanner = randomUUID();
    world.memberships.set(`${OC_ORG_ID}:${scanner}`, "SCANNER");
    // Call Y: another org's event, whose organizer tries call X's submission.
    const yOwner = randomUUID();
    world.memberships.set(`${OC_OTHER_ORG_ID}:${yOwner}`, "OWNER");
    const yEvent = world.addEvent({ id: randomUUID(), orgId: OC_OTHER_ORG_ID });
    const callY = world.addForm({ purpose: "PERFORM", eventId: yEvent.id });

    for (const attempt of [
      { actorHumanId: OC_STRANGER_ID, formId: call.id, submissionId: s.id },
      // Members of the event's own org without edit rights (FR-014 as amended).
      { actorHumanId: OC_VIEWER_ID, formId: call.id, submissionId: s.id },
      { actorHumanId: scanner, formId: call.id, submissionId: s.id },
      { actorHumanId: yOwner, formId: call.id, submissionId: s.id },
      { actorHumanId: yOwner, formId: callY.id, submissionId: s.id },
      // Even X's own organizer can't reach it through Y's id.
      { actorHumanId: OC_EDITOR_ID, formId: callY.id, submissionId: s.id },
      { actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: randomUUID() },
    ]) {
      await expect(openOpenCallApplication(deps, attempt)).rejects.toMatchObject({
        code: "OPEN_CALL_APPLICATION_NOT_FOUND",
      });
    }
    expect(s.openedAt).toBeNull();
  });
});

describe("FR-010: a vote or a note locks the edit; a message does not", () => {
  function tokenApplicant() {
    const s = setup();
    const token = "L".repeat(43);
    const sub = s.world.addSubmission(s.call.id, "PENDING", {
      humanId: null,
      guestName: "Guest",
      contactEmail: "lock@example.com",
      statusTokenHash: hashStatusToken(token),
    });
    const edit = () =>
      editOpenCallApplication(s.deps, {
        auth: { kind: "token", token },
        answers: {},
        dateIds: [],
        isPrivate: false,
      });
    return { ...s, sub, edit };
  }

  it("edit after a vote → OPEN_CALL_APPLICATION_LOCKED (and the stamp is audited as a first open)", async () => {
    const { deps, world, call, sub, edit } = tokenApplicant();
    await castApplicationVote(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: sub.id, vote: "YES" });
    expect(sub.openedAt).toEqual(world.now);
    const opened = world.audit.filter((a) => a.action === "open_call_application_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.data).toMatchObject({ via: "vote" });
    await expect(edit()).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_LOCKED" });
  });

  it("clearing a vote does not stamp", async () => {
    const { deps, call, sub, edit } = tokenApplicant();
    await castApplicationVote(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: sub.id, vote: null });
    expect(sub.openedAt).toBeNull();
    await expect(edit()).resolves.toBeTruthy();
  });

  it("edit after a note → OPEN_CALL_APPLICATION_LOCKED", async () => {
    const { deps, world, call, sub, edit } = tokenApplicant();
    await addApplicationNote(deps, { actorHumanId: SECOND_EDITOR_ID, formId: call.id, submissionId: sub.id, body: "hmm" });
    expect(world.audit.find((a) => a.action === "open_call_application_opened")?.data).toMatchObject({ via: "note" });
    await expect(edit()).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_LOCKED" });
  });

  it("edit after an organizer MESSAGE is still allowed", async () => {
    const { deps, call, sub, edit } = tokenApplicant();
    await postApplicationMessage(deps, {
      party: { side: "ORGANIZER", actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: sub.id },
      body: "Please add your link",
    });
    expect(sub.openedAt).toBeNull();
    await expect(edit()).resolves.toBeTruthy();
  });
});

describe("castApplicationVote (FR-014)", () => {
  it("refuses a vote on your own application (as yourself, or as an org you belong to); others may vote", async () => {
    const { world, deps, call } = setup();
    // A second EDITOR (organizer side) applied as themselves...
    const own = world.addSubmission(call.id, "PENDING", { humanId: SECOND_EDITOR_ID });
    await expect(
      castApplicationVote(deps, { actorHumanId: SECOND_EDITOR_ID, formId: call.id, submissionId: own.id, vote: "YES" }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_VOTE_OWN_APPLICATION" });
    // ...and a band's application, sent by someone else, where that EDITOR is a member (any role in the BAND counts).
    const band = randomUUID();
    world.memberships.set(`${band}:${SECOND_EDITOR_ID}`, "SCANNER");
    const bandApp = world.addSubmission(call.id, "PENDING", { humanId: randomUUID(), applyingAsOrgId: band });
    await expect(
      castApplicationVote(deps, { actorHumanId: SECOND_EDITOR_ID, formId: call.id, submissionId: bandApp.id, vote: "NO" }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_VOTE_OWN_APPLICATION" });
    expect(world.votes).toHaveLength(0);
    expect(own.openedAt).toBeNull();
    // An unrelated organizer votes on both.
    await castApplicationVote(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: own.id, vote: "YES" });
    await castApplicationVote(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: bandApp.id, vote: "YES" });
    expect(world.votes).toHaveLength(2);
    // Notes on your own application are unchanged (allowed).
    await expect(
      addApplicationNote(deps, { actorHumanId: SECOND_EDITOR_ID, formId: call.id, submissionId: own.id, body: "fyi" }),
    ).resolves.toBeTruthy();
  });

  it("one vote per human, changeable, clearable; tally counts each member once", async () => {
    const { world, deps, call } = setup();
    const s = world.addSubmission(call.id, "PENDING");
    const base = { formId: call.id, submissionId: s.id };

    let out = await castApplicationVote(deps, { ...base, actorHumanId: OC_EDITOR_ID, vote: "YES" });
    expect(out).toEqual({ myVote: "YES", votes: { yes: 1, maybe: 0, no: 0 } });
    out = await castApplicationVote(deps, { ...base, actorHumanId: OC_EDITOR_ID, vote: "NO" });
    expect(out).toEqual({ myVote: "NO", votes: { yes: 0, maybe: 0, no: 1 } });
    out = await castApplicationVote(deps, { ...base, actorHumanId: SECOND_EDITOR_ID, vote: "MAYBE" });
    expect(out).toEqual({ myVote: "MAYBE", votes: { yes: 0, maybe: 1, no: 1 } });
    out = await castApplicationVote(deps, { ...base, actorHumanId: OC_EDITOR_ID, vote: null });
    expect(out).toEqual({ myVote: null, votes: { yes: 0, maybe: 1, no: 0 } });
    expect(world.votes).toHaveLength(1);
    expect(world.audit.filter((a) => a.action === "open_call_application_vote_cast")).toHaveLength(4);
  });

  it("refuses non-organizers (stranger, VIEWER, SCANNER) and cross-call ids; rejects a bad vote value", async () => {
    const { world, deps, call } = setup();
    const s = world.addSubmission(call.id, "PENDING");
    const scanner = randomUUID();
    world.memberships.set(`${OC_ORG_ID}:${scanner}`, "SCANNER");
    for (const actor of [OC_STRANGER_ID, OC_VIEWER_ID, scanner]) {
      await expect(
        castApplicationVote(deps, { actorHumanId: actor, formId: call.id, submissionId: s.id, vote: "YES" }),
      ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
    }
    const other = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    world.addSeries();
    await expect(
      castApplicationVote(deps, { actorHumanId: OC_EDITOR_ID, formId: other.id, submissionId: s.id, vote: "YES" }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
    await expect(
      castApplicationVote(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: s.id, vote: "STRONG_YES" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(world.votes).toHaveLength(0);
  });
});

describe("notes (FR-014): add + list, organizer side only", () => {
  it("adds a sanitized note and lists them oldest first", async () => {
    const { world, deps, call } = setup();
    const s = world.addSubmission(call.id, "PENDING");
    const base = { formId: call.id, submissionId: s.id };
    const out = await addApplicationNote(deps, { ...base, actorHumanId: SECOND_EDITOR_ID, body: "  Great set <b>live</b>  " });
    expect(out.note.authorHumanId).toBe(SECOND_EDITOR_ID);
    expect(out.note.body).not.toContain("<b>");
    expect(out.note.body.startsWith(" ")).toBe(false);
    const listed = await listApplicationNotes(deps, { ...base, actorHumanId: OC_EDITOR_ID });
    expect(listed.notes.map((n) => n.id)).toEqual([out.note.id]);
    expect(world.audit.find((a) => a.action === "open_call_application_note_added")?.data).not.toHaveProperty("body");
  });

  it("rejects an empty or oversized note and non-organizers", async () => {
    const { world, deps, call } = setup();
    const s = world.addSubmission(call.id, "PENDING");
    const base = { formId: call.id, submissionId: s.id, actorHumanId: OC_EDITOR_ID };
    await expect(addApplicationNote(deps, { ...base, body: "   " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addApplicationNote(deps, { ...base, body: "x".repeat(4001) })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      addApplicationNote(deps, { ...base, actorHumanId: OC_STRANGER_ID, body: "hi" }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
    await expect(
      listApplicationNotes(deps, { formId: call.id, submissionId: s.id, actorHumanId: OC_STRANGER_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
  });
});

describe("NFR-002: applicant-facing reads never expose votes or notes", () => {
  it("the status page and its peer list carry no vote, tally or note", async () => {
    const { world, deps, call } = setup();
    const tokenA = "A".repeat(43);
    const a = world.addSubmission(call.id, "PENDING", {
      humanId: null,
      guestName: "A",
      contactEmail: "a@example.com",
      statusTokenHash: hashStatusToken(tokenA),
      createdAt: at(1),
    });
    const b = world.addSubmission(call.id, "PENDING", { createdAt: at(2) });
    for (const s of [a, b]) {
      await castApplicationVote(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id, submissionId: s.id, vote: "NO" });
      await addApplicationNote(deps, {
        actorHumanId: OC_EDITOR_ID,
        formId: call.id,
        submissionId: s.id,
        body: "SECRET-NOTE-TEXT",
      });
    }
    const view = await getOpenCallApplicationStatus(deps, { auth: { kind: "token", token: tokenA } });
    const json = JSON.stringify(view);
    expect(json).not.toContain("SECRET-NOTE-TEXT");
    expect(json).not.toMatch(/vote|tally|note/i);
    expect(view.peers).toHaveLength(1);
    expect(Object.keys(view.peers![0]!).sort()).toEqual(["kind", "name", "pageSlug", "photoUrl", "url"]);
  });
});
