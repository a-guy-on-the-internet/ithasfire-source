/**
 * Open calls v1 step 4 — applying (FR-006, FR-007, FR-008, FR-011, NFR-001).
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  OC_EDITOR_ID,
  OC_EVENT_ID,
  OC_ORG_ID,
  OC_OTHER_ORG_ID,
  OC_SERIES_ID,
  OC_STRANGER_ID,
  OC_VIEWER_ID,
} from "@th/test-utils/fakes/open-calls";

import { submitOpenCallApplication } from "../submit-open-call-application";
import { deriveStatusToken } from "../_shared/status-token";
import {
  DAY,
  TEST_STATUS_TOKEN_SECRET,
  addEventDate,
  guest,
  setupApplying,
} from "./open-call-application-helpers";

const APPLICANT_ID = "30000000-0000-4000-8000-0000000000f1";

function eventCall(opts: Record<string, unknown> = {}) {
  const s = setupApplying();
  s.world.addEvent();
  const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, ...opts });
  return { ...s, call };
}

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

describe("submitOpenCallApplication — the call must be open", () => {
  it("a signed-in applicant applies to a posted event call; reads the call FOR KEY SHARE first", async () => {
    const { world, deps, call } = eventCall();
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
      answers: {},
    });
    expect(out.outcome).toBe("created");
    const row = world.submissions.find((s) => s.id === out.submissionId)!;
    expect(row).toMatchObject({
      formId: call.id,
      eventId: OC_EVENT_ID,
      humanId: APPLICANT_ID,
      applyingAsOrgId: null,
      contactEmail: null,
      isPrivate: false,
      status: "PENDING",
      dateChoices: [],
    });
    expect(world.locks).toEqual([{ kind: "form_for_share", id: call.id }]);
    expect(world.audit).toContainEqual(
      expect.objectContaining({ action: "open_call_application_submitted", entityId: OC_EVENT_ID }),
    );
    expect(out.notice).toMatchObject({
      kind: "application_received",
      submissionId: out.submissionId,
      anchor: { kind: "event", eventId: OC_EVENT_ID },
      title: "Basement Show",
    });
    // The notice carries no token: the notifier re-derives a guest's link.
    expect(JSON.stringify(out.notice)).not.toContain(out.statusToken!);
    expect(out.notice).not.toHaveProperty("statusPath");
  });

  it("a draft call (postedAt null, Q41) is not found; nothing is written", async () => {
    const { world, deps, call } = eventCall({ postedAt: null, postedByHumanId: null });
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
    expect(world.submissions).toEqual([]);
  });

  it("refuses when the LOCKED row is a draft or closed, even if the first read said open", async () => {
    // The pre-read happens outside the transaction; a close (or a draft
    // state) seen only through the locked row must still refuse.
    const { world, deps, call } = eventCall();
    const real = world.repos.eventApplications.lockOpenCallForSubmit.bind(
      world.repos.eventApplications,
    );
    world.repos.eventApplications.lockOpenCallForSubmit = async (formId: string) => {
      const row = await real(formId);
      return row ? { ...row, closedAt: world.now } : null;
    };
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_CLOSED" });
    world.repos.eventApplications.lockOpenCallForSubmit = async (formId: string) => {
      const row = await real(formId);
      return row ? { ...row, postedAt: null } : null;
    };
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
    expect(world.submissions).toEqual([]);
  });

  it("a closed call refuses", async () => {
    const { deps, call } = eventCall({ closedAt: new Date("2026-10-04T00:00:00Z") });
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_CLOSED" });
  });

  it("the deadline stops new applications (FR-004); opensAt in the future refuses too", async () => {
    const past = eventCall({ closesAt: new Date("2026-10-05T11:59:59Z") });
    await expect(
      submitOpenCallApplication(past.deps, { publicId: past.call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "APPLICATION_WINDOW_CLOSED" });
    const future = eventCall({ opensAt: new Date("2026-10-06T00:00:00Z") });
    await expect(
      submitOpenCallApplication(future.deps, {
        publicId: future.call.publicId,
        viewerHumanId: APPLICANT_ID,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_WINDOW_NOT_OPEN" });
  });

  it("an ended call refuses: event started, or event cancelled", async () => {
    const started = setupApplying();
    started.world.addEvent({ startsAt: new Date(started.world.now.getTime() - 60_000) });
    const c1 = started.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    await expect(
      submitOpenCallApplication(started.deps, { publicId: c1.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_CLOSED" });

    const cancelled = setupApplying();
    cancelled.world.addEvent({ status: "CANCELLED" });
    const c2 = cancelled.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    await expect(
      submitOpenCallApplication(cancelled.deps, { publicId: c2.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_CLOSED" });
  });

  it("a DRAFT event's posted call takes applications (Q11)", async () => {
    const s = setupApplying();
    s.world.addEvent({ status: "DRAFT" });
    const call = s.world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const out = await submitOpenCallApplication(s.deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
    });
    expect(out.outcome).toBe("created");
  });

  it("an ATTEND form's publicId and a banned owner's call are not found", async () => {
    const { world, deps } = setupApplying();
    world.addEvent({ gateType: "APPLICATION" });
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    await expect(
      submitOpenCallApplication(deps, { publicId: attend.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    world.bannedOwnerIds.add(OC_ORG_ID);
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
  });
});

describe("submitOpenCallApplication — who applies (FR-006, Q33)", () => {
  it("an ORG_EDIT_ROLES member applies as the org", async () => {
    const { world, deps, call } = eventCall();
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: OC_EDITOR_ID,
      applyingAsOrgId: OC_ORG_ID,
    });
    expect(world.submissions.find((s) => s.id === out.submissionId)).toMatchObject({
      humanId: OC_EDITOR_ID,
      applyingAsOrgId: OC_ORG_ID,
    });
  });

  it("a VIEWER member, or a non-member, can't apply as the org", async () => {
    const { world, deps, call } = eventCall();
    await expect(
      submitOpenCallApplication(deps, {
        publicId: call.publicId,
        viewerHumanId: OC_VIEWER_ID,
        applyingAsOrgId: OC_ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      submitOpenCallApplication(deps, {
        publicId: call.publicId,
        viewerHumanId: OC_STRANGER_ID,
        applyingAsOrgId: OC_OTHER_ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(world.submissions).toEqual([]);
  });

  it("a banned person, or an org withheld for its owners' ban, can't apply (E)", async () => {
    const { world, deps, call } = eventCall();
    world.bannedOwnerIds.add(OC_OTHER_ORG_ID);
    world.memberships.set(`${OC_OTHER_ORG_ID}:${OC_EDITOR_ID}`, "OWNER");
    await expect(
      submitOpenCallApplication(deps, {
        publicId: call.publicId,
        viewerHumanId: OC_EDITOR_ID,
        applyingAsOrgId: OC_OTHER_ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    world.bannedOwnerIds.add(APPLICANT_ID);
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(world.submissions).toEqual([]);
    // The same person, unbanned org: fine.
    const ok = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: OC_EDITOR_ID,
      applyingAsOrgId: OC_ORG_ID,
    });
    expect(ok.outcome).toBe("created");
  });

  it("a guest applies with name + email (+ link); the email is lowercased, never an org", async () => {
    const { world, deps, call } = eventCall();
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: guest({ name: "  <b>The Moths</b>\u0007 " }),
    });
    expect(world.submissions.find((s) => s.id === out.submissionId)).toMatchObject({
      humanId: null,
      applyingAsOrgId: null,
      guestName: "The Moths",
      guestUrl: "https://moths.example.com",
      contactEmail: "moths@example.com",
    });
  });

  it("a guest without details, a guest as an org, a guest with a javascript: link, and a session with guest details are rejected", async () => {
    const { world, deps, call } = eventCall();
    const bad = [
      { publicId: call.publicId },
      { publicId: call.publicId, guest: guest(), applyingAsOrgId: OC_ORG_ID },
      { publicId: call.publicId, guest: guest({ url: "javascript:alert(1)" }) },
      { publicId: call.publicId, guest: guest({ email: undefined }) },
      { publicId: call.publicId, viewerHumanId: APPLICANT_ID, guest: guest() },
    ];
    for (const input of bad) {
      await expect(submitOpenCallApplication(deps, input)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(world.submissions).toEqual([]);
  });
});

describe("submitOpenCallApplication — answers, privacy, token", () => {
  it("validates answers exactly as the attendee gate does and snapshots the questions", async () => {
    const { world, deps, call } = eventCall();
    const q = await world.repos.eventApplications.upsertQuestion({
      formId: call.id,
      type: "SHORT_TEXT",
      label: "Link to your music",
      isRequired: true,
    });
    await expect(
      submitOpenCallApplication(deps, {
        publicId: call.publicId,
        viewerHumanId: APPLICANT_ID,
        answers: { [q.id]: "   " },
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_ANSWERS_INCOMPLETE" });

    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
      answers: { [q.id]: "<script>x</script>https://band.example" },
      isPrivate: true,
    });
    const row = world.submissions.find((s) => s.id === out.submissionId)!;
    expect(row.answers[q.id]).not.toContain("<script>");
    expect(row.isPrivate).toBe(true);
    expect(row.questionsSnapshot[q.id]).toMatchObject({ label: "Link to your music", type: "SHORT_TEXT" });
  });

  it("mints a 32-byte base64url token, returns it once, stores only its SHA-256 (signed-in too)", async () => {
    const { world, deps, call } = eventCall();
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
    });
    expect(out.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(out.statusToken!, "base64url")).toHaveLength(32);
    expect(out.statusPath).toBe(`/call/${call.publicId}/application/${out.statusToken}`);
    const row = world.submissions.find((s) => s.id === out.submissionId)!;
    expect(row.statusTokenHash).toBe(sha256(out.statusToken!));
    expect(JSON.stringify(world.submissions)).not.toContain(out.statusToken!);
    expect(JSON.stringify(world.audit)).not.toContain(out.statusToken!);

    const second = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: guest(),
    });
    expect(second.statusToken).not.toBe(out.statusToken);
  });

  it("derives the token from the submission id and the secret (owner ruling 2026-10-07)", async () => {
    const { world, deps, call } = eventCall();
    const out = await submitOpenCallApplication(deps, { publicId: call.publicId, guest: guest() });
    // Deterministic: the same (secret, id) re-derives the same token.
    const again = deriveStatusToken(TEST_STATUS_TOKEN_SECRET, out.submissionId!);
    expect(again.token).toBe(out.statusToken);
    expect(world.submissions.find((s) => s.id === out.submissionId)!.statusTokenHash).toBe(again.hash);
    // Another secret gives another token.
    const other = deriveStatusToken("another-secret-that-is-long-enough-0123456789", out.submissionId!);
    expect(other.token).not.toBe(out.statusToken);
    expect(other.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The raw token is persisted nowhere.
    expect(JSON.stringify(world.submissions)).not.toContain(out.statusToken!);
    expect(JSON.stringify(world.audit)).not.toContain(out.statusToken!);
  });

  it("refuses NOT_CONFIGURED without a usable secret; nothing is written", async () => {
    const { world, deps, call } = eventCall();
    for (const statusTokenSecret of [null, "too-short"]) {
      await expect(
        submitOpenCallApplication(
          { ...deps, statusTokenSecret },
          { publicId: call.publicId, viewerHumanId: APPLICANT_ID },
        ),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    }
    expect(world.submissions).toEqual([]);
  });

  it("stores the applicant's language when given (contactLocale), null otherwise", async () => {
    const { world, deps, call } = eventCall();
    const es = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: guest(),
      contactLocale: "es",
    });
    const none = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
    });
    expect(world.submissions.find((s) => s.id === es.submissionId)!.contactLocale).toBe("es");
    expect(world.submissions.find((s) => s.id === none.submissionId)!.contactLocale).toBeNull();
    await expect(
      submitOpenCallApplication(deps, {
        publicId: call.publicId,
        guest: guest({ email: "other@example.com" }),
        contactLocale: "fr",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("respects maxSubmissions (WITHDRAWN frees a place); a capped call upgrades to FOR NO KEY UPDATE", async () => {
    const { world, deps, call } = eventCall({ maxSubmissions: 1 });
    world.addSubmission(call.id, "WITHDRAWN");
    await submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID });
    expect(world.locks).toEqual([
      { kind: "form_for_share", id: call.id },
      { kind: "form_for_no_key_update", id: call.id },
    ]);
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, guest: guest() }),
    ).rejects.toMatchObject({ code: "APPLICATION_CAP_REACHED" });
  });
});

describe("submitOpenCallApplication — one open application per call (FR-011)", () => {
  it("Q42: one person applies as self AND as each of two orgs (three open rows)", async () => {
    const { world, deps, call } = eventCall();
    world.memberships.set(`${OC_OTHER_ORG_ID}:${OC_EDITOR_ID}`, "EDITOR");
    for (const applyingAsOrgId of [null, OC_ORG_ID, OC_OTHER_ORG_ID]) {
      const out = await submitOpenCallApplication(deps, {
        publicId: call.publicId,
        viewerHumanId: OC_EDITOR_ID,
        applyingAsOrgId,
      });
      expect(out.outcome).toBe("created");
    }
    expect(
      world.submissions.filter((s) => s.humanId === OC_EDITOR_ID && s.status === "PENDING"),
    ).toHaveLength(3);
    // Each entity still holds only one: self again, or the same org again.
    for (const applyingAsOrgId of [null, OC_ORG_ID]) {
      await expect(
        submitOpenCallApplication(deps, {
          publicId: call.publicId,
          viewerHumanId: OC_EDITOR_ID,
          applyingAsOrgId,
        }),
      ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });
    }
  });

  it("Q42: a second member applying as the same org gets the duplicate, whoever submitted first", async () => {
    const { world, deps, call } = eventCall();
    const SECOND = "30000000-0000-4000-8000-0000000000b9";
    world.memberships.set(`${OC_ORG_ID}:${SECOND}`, "EDITOR");
    await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: OC_EDITOR_ID,
      applyingAsOrgId: OC_ORG_ID,
    });
    await expect(
      submitOpenCallApplication(deps, {
        publicId: call.publicId,
        viewerHumanId: SECOND,
        applyingAsOrgId: OC_ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_ALREADY_SUBMITTED" });
    // ...but may still apply as themselves.
    const self = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: SECOND,
    });
    expect(self.outcome).toBe("created");
  });

  it("a guest duplicate (any email case) returns guest_duplicate with no id and no token", async () => {
    const { world, deps, call } = eventCall();
    await submitOpenCallApplication(deps, { publicId: call.publicId, guest: guest() });
    const dup = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      guest: guest({ email: "MOTHS@example.COM" }),
    });
    expect(dup).toEqual({
      outcome: "guest_duplicate",
      publicId: call.publicId,
      submissionId: null,
      statusToken: null,
      statusPath: null,
      notice: {
        kind: "guest_duplicate",
        contactEmail: "moths@example.com",
        publicId: call.publicId,
        title: "Basement Show",
      },
    });
    expect(world.submissions).toHaveLength(1);
  });

  it("re-applying after WITHDRAWN or REJECTED is allowed", async () => {
    const { world, deps, call } = eventCall();
    world.addSubmission(call.id, "WITHDRAWN", { humanId: APPLICANT_ID });
    world.addSubmission(call.id, "REJECTED", { humanId: APPLICANT_ID });
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
    });
    expect(out.outcome).toBe("created");
  });

  it("an open ATTEND application on the same event doesn't block applying to its call", async () => {
    const { world, deps, call } = eventCall();
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    world.addSubmission(attend.id, "PENDING", { humanId: APPLICANT_ID });
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
    });
    expect(out.outcome).toBe("created");
  });
});

describe("submitOpenCallApplication — date choices (FR-007)", () => {
  it("an event with several upcoming dates requires ≥1, stores one EventDate row per date", async () => {
    const { world, deps, call } = eventCall();
    const d1 = addEventDate(world, new Date(world.now.getTime() + 3 * DAY));
    const d2 = addEventDate(world, new Date(world.now.getTime() + 4 * DAY));
    await expect(
      submitOpenCallApplication(deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_DATES_REQUIRED" });
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
      dateIds: [d2.id, d1.id, d2.id],
    });
    expect(world.submissions.find((s) => s.id === out.submissionId)!.dateChoices).toEqual([
      { eventDateId: d2.id },
      { eventDateId: d1.id },
    ]);
  });

  it("rejects a past, cancelled or foreign date", async () => {
    const { world, deps, call } = eventCall();
    addEventDate(world, new Date(world.now.getTime() + 3 * DAY));
    addEventDate(world, new Date(world.now.getTime() + 4 * DAY));
    const past = addEventDate(world, new Date(world.now.getTime() - DAY));
    const cancelled = addEventDate(world, new Date(world.now.getTime() + 5 * DAY), "CANCELLED");
    const foreign = addEventDate(
      world,
      new Date(world.now.getTime() + 3 * DAY),
      "SCHEDULED",
      "20000000-0000-4000-8000-0000000000c9",
    );
    for (const id of [past.id, cancelled.id, foreign.id, OC_EVENT_ID]) {
      await expect(
        submitOpenCallApplication(deps, {
          publicId: call.publicId,
          viewerHumanId: APPLICANT_ID,
          dateIds: [id],
        }),
      ).rejects.toMatchObject({ code: "OPEN_CALL_DATE_INVALID" });
    }
  });

  it("a single-date event call stores no choice (the night is implied)", async () => {
    const { world, deps, call } = eventCall();
    const out = await submitOpenCallApplication(deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
    });
    expect(world.submissions.find((s) => s.id === out.submissionId)!.dateChoices).toEqual([]);
    await expect(
      submitOpenCallApplication(deps, {
        publicId: call.publicId,
        guest: guest(),
        dateIds: ["20000000-0000-4000-8000-0000000000aa"],
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_DATE_INVALID" });
  });

  it("a series call stores occurrences; the materialised event id is not a choice; no night twice", async () => {
    const s = setupApplying();
    s.world.addSeries();
    const materialisedEventId = "20000000-0000-4000-8000-0000000000c7";
    const o1 = s.world.addOccurrence({
      startsAt: new Date(s.world.now.getTime() + 2 * DAY),
      eventId: materialisedEventId,
    });
    const o2 = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + 9 * DAY) });
    s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() - DAY) });
    const call = s.world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });

    await expect(
      submitOpenCallApplication(s.deps, { publicId: call.publicId, viewerHumanId: APPLICANT_ID }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_DATES_REQUIRED" });
    await expect(
      submitOpenCallApplication(s.deps, {
        publicId: call.publicId,
        viewerHumanId: APPLICANT_ID,
        dateIds: [o1.id, materialisedEventId],
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_DATE_INVALID" });

    const out = await submitOpenCallApplication(s.deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
      dateIds: [o1.id, o2.id, o1.id],
    });
    const row = s.world.submissions.find((x) => x.id === out.submissionId)!;
    expect(row.eventId).toBeNull();
    expect(row.dateChoices).toEqual([{ occurrenceId: o1.id }, { occurrenceId: o2.id }]);
    expect(out.notice).toMatchObject({ anchor: { kind: "series", seriesId: OC_SERIES_ID } });
  });

  it("a series with one upcoming night stores that night for the applicant", async () => {
    const s = setupApplying();
    s.world.addSeries();
    const only = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + 2 * DAY) });
    const call = s.world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const out = await submitOpenCallApplication(s.deps, {
      publicId: call.publicId,
      viewerHumanId: APPLICANT_ID,
    });
    expect(s.world.submissions.find((x) => x.id === out.submissionId)!.dateChoices).toEqual([
      { occurrenceId: only.id },
    ]);
  });
});
