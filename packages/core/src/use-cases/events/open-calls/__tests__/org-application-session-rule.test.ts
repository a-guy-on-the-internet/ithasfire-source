/**
 * ONE rule for every SESSION path on an ORGANISATION's application
 * (orchestrator decision 2026-10-07): the actor must be a CURRENT member of
 * the applying org with an ORG_EDIT_ROLES role (actsForOpenCallOrg). The
 * submitter has no standing of their own. Refusals look like a miss
 * (OPEN_CALL_APPLICATION_NOT_FOUND). Person applications keep humanId.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OC_EVENT_ID, OC_OTHER_ORG_ID } from "@th/test-utils/fakes/open-calls";

import { dropOutOfOpenCall } from "../drop-out-of-open-call";
import { editOpenCallApplication } from "../edit-open-call-application";
import { getOpenCallApplicationStatus } from "../get-open-call-application-status";
import { listApplicationMessages } from "../list-application-messages";
import { listMyOpenCallApplications } from "../list-my-open-call-applications";
import { postApplicationMessage } from "../post-application-message";
import { setOpenCallApplicationPrivacy } from "../set-open-call-application-privacy";
import { withdrawOpenCallApplication } from "../withdraw-open-call-application";
import { setupApplying } from "./open-call-application-helpers";

const BAND = OC_OTHER_ORG_ID;

function orgApplication() {
  const s = setupApplying();
  s.world.addEvent();
  const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
  const departed = randomUUID(); // submitted it, then left the band
  const demoted = randomUUID(); // submitted nothing; now a VIEWER
  const editor = randomUUID(); // another current edit member
  const scanner = randomUUID();
  const stranger = randomUUID(); // an editor of ANOTHER org
  s.world.memberships.set(`${BAND}:${demoted}`, "VIEWER");
  s.world.memberships.set(`${BAND}:${editor}`, "EDITOR");
  s.world.memberships.set(`${BAND}:${scanner}`, "SCANNER");
  s.world.memberships.set(`${randomUUID()}:${stranger}`, "EDITOR");
  const row = s.world.addSubmission(call.id, "PENDING", { humanId: departed, applyingAsOrgId: BAND });
  return { ...s, call, row, departed, demoted, editor, scanner, stranger };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

type World = ReturnType<typeof orgApplication>;
const session = (w: World, actorHumanId: string) => ({
  kind: "session" as const,
  actorHumanId,
  submissionId: w.row.id,
});

const PATHS: Record<string, (w: World, actor: string) => Promise<unknown>> = {
  status: (w, actor) => getOpenCallApplicationStatus(w.deps, { auth: session(w, actor) }),
  edit: (w, actor) =>
    editOpenCallApplication(w.deps, { auth: session(w, actor), answers: {}, dateIds: [], isPrivate: true }),
  privacy: (w, actor) =>
    setOpenCallApplicationPrivacy(w.deps, { auth: session(w, actor), isPrivate: true }),
  withdraw: (w, actor) => withdrawOpenCallApplication(w.deps, { auth: session(w, actor) }),
  "thread read": (w, actor) =>
    listApplicationMessages(w.deps, { party: { side: "APPLICANT", auth: session(w, actor) } }),
  "thread post": (w, actor) =>
    postApplicationMessage(w.deps, {
      party: { side: "APPLICANT", auth: session(w, actor) },
      body: "Hi from the band",
    }),
};

describe("org application: one session rule on every applicant path", () => {
  for (const [name, run] of Object.entries(PATHS)) {
    it(`${name}: the departed submitter, a VIEWER, a SCANNER and another org's editor are refused; another edit member is allowed`, async () => {
      const w = orgApplication();
      for (const refused of [w.departed, w.demoted, w.scanner, w.stranger]) {
        expect(await code(run(w, refused))).toBe("OPEN_CALL_APPLICATION_NOT_FOUND");
      }
      expect(await code(run(w, w.editor))).toBe("ok");
    });
  }

  it("drop out follows the same rule (picked application)", async () => {
    const w = orgApplication();
    w.row.status = "APPROVED";
    for (const refused of [w.departed, w.demoted, w.stranger]) {
      expect(await code(dropOutOfOpenCall(w.deps as never, { auth: session(w, refused) }))).toBe(
        "OPEN_CALL_APPLICATION_NOT_FOUND",
      );
    }
  });

  it("a message an org member posts records THAT member as its author", async () => {
    const w = orgApplication();
    const out = await postApplicationMessage(w.deps, {
      party: { side: "APPLICANT", auth: session(w, w.editor) },
      body: "We can do 9pm",
    });
    expect(out.message.authorSide).toBe("APPLICANT");
    // The applicant-side read withholds the author id; the stored row has it.
    expect(out.message.authorHumanId).toBeNull();
    const stored = await w.world.repos.eventApplications.listApplicationMessages({
      submissionId: w.row.id,
      cursor: null,
      limit: 10,
    });
    expect(stored.items[0]).toMatchObject({ authorHumanId: w.editor, authorSide: "APPLICANT" });
  });

  it("a person's application keeps humanId: only its applicant", async () => {
    const w = orgApplication();
    const mine = w.world.addSubmission(w.call.id, "PENDING", { humanId: w.editor });
    const as = (actor: string) =>
      code(
        getOpenCallApplicationStatus(w.deps, {
          auth: { kind: "session", actorHumanId: actor, submissionId: mine.id },
        }),
      );
    expect(await as(w.editor)).toBe("ok");
    expect(await as(w.demoted)).toBe("OPEN_CALL_APPLICATION_NOT_FOUND");
  });

  it("My applications: every current edit member sees the org's application; the departed submitter and a VIEWER do not", async () => {
    const w = orgApplication();
    const ids = async (actor: string) =>
      (await listMyOpenCallApplications(w.deps, { actorHumanId: actor })).map((r) => r.submissionId);
    expect(await ids(w.editor)).toEqual([w.row.id]);
    expect(await ids(w.departed)).toEqual([]);
    expect(await ids(w.demoted)).toEqual([]);
  });
});
