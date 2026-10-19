/**
 * Open calls v1 step 4 — the applicant switches "Keep my application
 * private" (owner ruling (a)): never locked by opening, a decision or a
 * closed call; refused once withdrawn, and on a row that is no longer its
 * identity's latest (SUPERSEDED).
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OC_EVENT_ID, OC_ORG_ID } from "@th/test-utils/fakes/open-calls";

import { getOpenCallApplicationStatus } from "../get-open-call-application-status";
import { setOpenCallApplicationPrivacy } from "../set-open-call-application-privacy";
import { submitOpenCallApplication } from "../submit-open-call-application";
import { withdrawOpenCallApplication } from "../withdraw-open-call-application";
import { DAY, setupApplying } from "./open-call-application-helpers";

const ME = "30000000-0000-4000-8000-0000000000f1";
const OTHER = "30000000-0000-4000-8000-0000000000f2";

async function applied() {
  const s = setupApplying();
  s.world.addEvent();
  const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
  const mine = await submitOpenCallApplication(s.deps, {
    publicId: call.publicId,
    viewerHumanId: ME,
    answers: {},
  });
  const submissionId = mine.submissionId!;
  const row = () => s.world.submissions.find((x) => x.id === submissionId)!;
  return { ...s, call, token: mine.statusToken!, submissionId, row };
}

describe("setOpenCallApplicationPrivacy", () => {
  it("session path: the submitting human sets it; audited once; anyone else gets NOT_FOUND", async () => {
    const { world, deps, submissionId, row } = await applied();
    const out = await setOpenCallApplicationPrivacy(deps, {
      auth: { kind: "session", actorHumanId: ME, submissionId },
      isPrivate: true,
    });
    expect(out).toEqual({ submissionId, isPrivate: true, changed: true });
    expect(row().isPrivate).toBe(true);
    expect(world.audit.filter((a) => a.action === "open_call_application_privacy_set")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ submissionId, via: "session", isPrivate: true }),
      }),
    ]);
    await expect(
      setOpenCallApplicationPrivacy(deps, {
        auth: { kind: "session", actorHumanId: OTHER, submissionId },
        isPrivate: false,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
    expect(row().isPrivate).toBe(true);
  });

  it("token path; idempotent: the same value again is a success with changed false, not re-audited", async () => {
    const { world, deps, token, submissionId, row } = await applied();
    const auth = { kind: "token" as const, token };
    await setOpenCallApplicationPrivacy(deps, { auth, isPrivate: true });
    const again = await setOpenCallApplicationPrivacy(deps, { auth, isPrivate: true });
    expect(again).toEqual({ submissionId, isPrivate: true, changed: false });
    expect(world.audit.filter((a) => a.action === "open_call_application_privacy_set")).toHaveLength(1);
    const off = await setOpenCallApplicationPrivacy(deps, { auth, isPrivate: false });
    expect(off).toMatchObject({ isPrivate: false, changed: true });
    expect(row().isPrivate).toBe(false);
  });

  it("an expired token is refused; the session keeps working", async () => {
    const { world, deps, setNow, token, submissionId, row } = await applied();
    const eventStart = world.events.get(OC_EVENT_ID)!.startsAt;
    setNow(new Date(eventStart.getTime() + 30 * DAY + 1));
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token }, isPrivate: true }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_LINK_EXPIRED" });
    expect(row().isPrivate).toBe(false);
    await expect(
      setOpenCallApplicationPrivacy(deps, {
        auth: { kind: "session", actorHumanId: ME, submissionId },
        isPrivate: true,
      }),
    ).resolves.toMatchObject({ isPrivate: true });
  });

  it("refused once withdrawn", async () => {
    const { deps, token, row } = await applied();
    const auth = { kind: "token" as const, token };
    await withdrawOpenCallApplication(deps, { auth });
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth, isPrivate: true }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_DECIDED" });
    expect(row().isPrivate).toBe(false);
  });

  it("a withdraw that lands between the read and the write wins (guarded write)", async () => {
    const { world, deps, token, row } = await applied();
    const real = world.repos.eventApplications.setOpenCallSubmissionPrivacy.bind(
      world.repos.eventApplications,
    );
    world.repos.eventApplications.setOpenCallSubmissionPrivacy = async (input) => {
      row().status = "WITHDRAWN";
      return real(input);
    };
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token }, isPrivate: true }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_DECIDED" });
    expect(row().isPrivate).toBe(false);
  });

  it("allowed after the organizer side opened it (edit is locked then; privacy is not)", async () => {
    const { deps, token, row } = await applied();
    row().openedAt = new Date();
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token }, isPrivate: true }),
    ).resolves.toMatchObject({ isPrivate: true, changed: true });
    expect(row().isPrivate).toBe(true);
  });

  it.each(["APPROVED", "REJECTED", "WAITLISTED"] as const)(
    "allowed once decided (%s)",
    async (status) => {
      const { deps, token, row } = await applied();
      row().openedAt = new Date();
      row().status = status;
      await expect(
        setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token }, isPrivate: true }),
      ).resolves.toMatchObject({ isPrivate: true });
      expect(row().isPrivate).toBe(true);
    },
  );

  it("allowed after the call closed and after the deadline", async () => {
    const { world, deps, call, token, row } = await applied();
    const form = world.forms.find((f) => f.id === call.id)!;
    form.closedAt = world.now;
    form.closesAt = new Date(world.now.getTime() - 1);
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token }, isPrivate: true }),
    ).resolves.toMatchObject({ isPrivate: true });
    expect(row().isPrivate).toBe(true);
  });

  it("wrong purpose: an ATTEND submission is invisible to both auth paths", async () => {
    const { world, deps } = setupApplying();
    world.addEvent({ gateType: "APPLICATION" });
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    const token = "C".repeat(43);
    const row = world.addSubmission(attend.id, "PENDING", {
      humanId: ME,
      statusTokenHash: createHash("sha256").update(token).digest("hex"),
    });
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token }, isPrivate: true }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
    await expect(
      setOpenCallApplicationPrivacy(deps, {
        auth: { kind: "session", actorHumanId: ME, submissionId: row.id },
        isPrivate: true,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_NOT_FOUND" });
    expect(row.isPrivate).toBe(false);
  });

  it("rejects unknown input keys", async () => {
    const { deps, token } = await applied();
    await expect(
      setOpenCallApplicationPrivacy(deps, {
        auth: { kind: "token", token },
        isPrivate: true,
        status: "APPROVED",
      }),
    ).rejects.toBeDefined();
  });

  it("turning it on after a public 'not this time' hides the identity from other applicants (latest row decides)", async () => {
    const { world, deps, call, row } = await applied();
    // OTHER (the viewer here) applied publicly.
    const other = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: OTHER,
      answers: {},
    });
    const peersOfOther = async () =>
      (
        await getOpenCallApplicationStatus(deps, {
          auth: { kind: "token", token: other.statusToken! },
        })
      ).peers;
    expect(await peersOfOther()).toHaveLength(1);

    // ME was publicly told "not this time", then re-applied ... and the
    // re-application is what ME makes private.
    row().status = "REJECTED";
    const again = world.addSubmission(call.id, "PENDING", {
      humanId: ME,
      createdAt: new Date(world.now.getTime() + 3600_000),
    });
    expect(await peersOfOther()).toHaveLength(1);
    again.statusTokenHash = createHash("sha256").update("D".repeat(43)).digest("hex");
    await setOpenCallApplicationPrivacy(deps, {
      auth: { kind: "token", token: "D".repeat(43) },
      isPrivate: true,
    });
    expect(await peersOfOther()).toEqual([]);
  });

  it("SUPERSEDED: a row with a later same-identity row is refused, in either direction, on both auth paths", async () => {
    const { world, deps, call, token, submissionId, row } = await applied();
    // Row A (mine) told "not this time"; then a public re-application (B).
    row().status = "REJECTED";
    const tokenB = "E".repeat(43);
    const b = world.addSubmission(call.id, "PENDING", {
      humanId: ME,
      createdAt: new Date(world.now.getTime() + 3600_000),
      statusTokenHash: createHash("sha256").update(tokenB).digest("hex"),
    });
    for (const auth of [
      { kind: "token" as const, token },
      { kind: "session" as const, actorHumanId: ME, submissionId },
    ]) {
      for (const isPrivate of [true, false]) {
        await expect(setOpenCallApplicationPrivacy(deps, { auth, isPrivate })).rejects.toMatchObject({
          code: "OPEN_CALL_APPLICATION_SUPERSEDED",
        });
      }
    }
    expect(row().isPrivate).toBe(false);
    expect(b.isPrivate).toBe(false);
    expect(world.audit.filter((a) => a.action === "open_call_application_privacy_set")).toEqual([]);
    // The latest row (B) works.
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token: tokenB }, isPrivate: true }),
    ).resolves.toMatchObject({ isPrivate: true, changed: true });
  });

  it("SUPERSEDED for an org: member A can't toggle an older org row once member B re-applied; B's row is untouched", async () => {
    const s = setupApplying();
    s.world.addEvent();
    const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    // Member A still holds an edit role (the org-application session rule).
    s.world.memberships.set(`${OC_ORG_ID}:${ME}`, "EDITOR");
    const tokenA = "F".repeat(43);
    const a = s.world.addSubmission(call.id, "REJECTED", {
      humanId: ME,
      applyingAsOrgId: OC_ORG_ID,
      statusTokenHash: createHash("sha256").update(tokenA).digest("hex"),
    });
    const b = s.world.addSubmission(call.id, "PENDING", {
      humanId: OTHER,
      applyingAsOrgId: OC_ORG_ID,
      createdAt: new Date(s.world.now.getTime() + 3600_000),
    });
    await expect(
      setOpenCallApplicationPrivacy(s.deps, {
        auth: { kind: "session", actorHumanId: ME, submissionId: a.id },
        isPrivate: true,
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_SUPERSEDED" });
    await expect(
      setOpenCallApplicationPrivacy(s.deps, { auth: { kind: "token", token: tokenA }, isPrivate: true }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_SUPERSEDED" });
    expect([a.isPrivate, b.isPrivate]).toEqual([false, false]);
  });

  it("a newer row that lands between the read and the write wins (guarded write -> SUPERSEDED)", async () => {
    const { world, deps, call, token, row } = await applied();
    const real = world.repos.eventApplications.setOpenCallSubmissionPrivacy.bind(
      world.repos.eventApplications,
    );
    world.repos.eventApplications.setOpenCallSubmissionPrivacy = async (input) => {
      row().status = "REJECTED";
      world.addSubmission(call.id, "PENDING", {
        humanId: ME,
        createdAt: new Date(world.now.getTime() + 3600_000),
      });
      return real(input);
    };
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token }, isPrivate: true }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_APPLICATION_SUPERSEDED" });
    expect(row().isPrivate).toBe(false);
  });

  it("changed comes from the LOCKED pre-image: a concurrent toggle that committed first means no change, no audit", async () => {
    const { world, deps, token, row } = await applied();
    const real = world.repos.eventApplications.setOpenCallSubmissionPrivacy.bind(
      world.repos.eventApplications,
    );
    world.repos.eventApplications.setOpenCallSubmissionPrivacy = async (input) => {
      // The other toggle committed after our snapshot read (isPrivate false).
      row().isPrivate = true;
      return real(input);
    };
    await expect(
      setOpenCallApplicationPrivacy(deps, { auth: { kind: "token", token }, isPrivate: true }),
    ).resolves.toMatchObject({ isPrivate: true, changed: false });
    expect(world.audit.filter((a) => a.action === "open_call_application_privacy_set")).toEqual([]);
  });

  it("canSetPrivacy on the status page: true on the latest row (opened or decided), false once withdrawn or superseded", async () => {
    const { world, deps, call, token, row } = await applied();
    const auth = { kind: "token" as const, token };
    const can = async () => (await getOpenCallApplicationStatus(deps, { auth })).canSetPrivacy;
    expect(await can()).toBe(true);
    row().openedAt = new Date();
    row().status = "REJECTED";
    expect(await can()).toBe(true);
    // A later row of the same identity supersedes it.
    const later = world.addSubmission(call.id, "PENDING", {
      humanId: ME,
      createdAt: new Date(world.now.getTime() + 3600_000),
    });
    expect(await can()).toBe(false);
    later.formId = "30000000-0000-4000-8000-00000000dead"; // another call: no longer competes
    expect(await can()).toBe(true);
    row().status = "WITHDRAWN";
    expect(await can()).toBe(false);
  });
});
