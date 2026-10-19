import { describe, expect, it } from "vitest";

import {
  attendeeRow,
  NOW,
  renderScanScreen,
  ticket,
  type ScanHarness,
} from "../../../test/harness/render-scan-screen";
import { trpcError } from "../../../test/harness/fake-server";

/**
 * Admit / refusal RACES on the door scanner, driven through the real
 * `UnifiedScanScreen`.
 *
 * Every test is a door scenario and asserts only what the operator gets: the
 * words on the verdict, the late-refusal notice, the recent-scans row, the
 * haptic signature, the screen-reader announcement, and (for the things
 * nobody at the door sees) the Sentry branch. The pure planners these flows
 * call are tested in `src/lib/`; this file is about the WIRING between them,
 * which is where three review rounds found every bug.
 */

const A = { code: "TK-AAA111", name: "Ada Lovelace" };
const B = { code: "TK-BBB222", name: "Ben Okri" };

const EXPRESS_DWELL_MS = 1200;
/** The strip polls the store on this cadence. */
const STRIP_TICK_MS = 1000;
const EARLIER = new Date(NOW.getTime() - 5 * 60_000).toISOString();

/** Scan `who` and have the server answer VALID. */
const scanValid = async (h: ScanHarness, who: typeof A) => {
  await h.scan(who.code);
  await h.lookup.resolve(ticket(who.code, who.name), who.code);
};

/** The announcement says what the screen says: state, word, detail. */
const expectAnnouncementMatchesVerdict = (h: ScanHarness) => {
  const v = h.verdict();
  expect(v).not.toBeNull();
  const said = h.announcements().at(-1) ?? "";
  expect(said).toContain(v!.state);
  expect(said).toContain(v!.word);
  if (v!.detail) expect(said).toContain(v!.detail);
};

describe("manual admit, answered while the person is still on screen", () => {
  it("1. VALID → Admit → ACCEPTED: ADMITTED · DONE, one admit cue, row admitted with UNDO", async () => {
    const h = renderScanScreen();
    await scanValid(h, A);
    expect(h.verdict()).toMatchObject({ state: "VALID", word: "LET THEM IN" });

    h.observeFromHere();
    await h.tap("Admit");
    expect(h.admit.pending()).toEqual([
      expect.objectContaining({ ticketCode: A.code }),
    ]);

    await h.admit.resolve({ outcome: "ACCEPTED", scannedAt: NOW }, A.code);
    // Manual admit re-resolves to show the now-SCANNED ticket.
    await h.lookup.resolve(
      ticket(A.code, A.name, { status: "SCANNED", scannedAt: NOW }),
      A.code,
    );

    const v = h.verdict();
    expect(v?.state).toMatch(/^ADMITTED/);
    expect(v?.word).toBe("DONE");
    expect(h.haptics()).toEqual(["valid"]);
    expect(h.sounds()).toEqual(["valid"]);

    await h.advance(STRIP_TICK_MS);
    const row = h.recentRow(A.name);
    expect(row).not.toBeNull();
    expect(row?.refused).toBeNull();
    expect(row?.undo).toMatch(/^UNDO \d+s$/);
    expect(h.device.queue()).toEqual([]);
  });

  it("1b. ACCEPTED, then the follow-up re-resolve fails: the confirmation stands, silently", async () => {
    // The admission HAPPENED. A SCAN FAILED / rejected buzz here invites the
    // operator to turn away someone who is already in.
    const h = renderScanScreen();
    await scanValid(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.resolve({ outcome: "ACCEPTED", scannedAt: NOW }, A.code);
    await h.lookup.reject(new TypeError("Network request failed"), A.code);

    const v = h.verdict();
    expect(v?.state).toMatch(/^ADMITTED/);
    expect(v?.word).toBe("DONE");
    expect(h.screenText()).not.toMatch(/SCAN FAILED|CHECK FIRST/i);
    expect(h.canTap("Admit")).toBe(false);
    expect(h.haptics()).toEqual(["valid"]);
    expect(h.reports()).toContain("post_admit_reresolve_failed");
  });

  it("1c. ACCEPTED, operator dismisses, THEN the re-resolve lands: A does not come back", async () => {
    const h = renderScanScreen();
    await scanValid(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.resolve({ outcome: "ACCEPTED", scannedAt: NOW }, A.code);
    expect(h.verdict()?.word).toBe("DONE");
    await h.tap("Dismiss and scan next");
    expect(h.verdict()).toBeNull();

    await h.lookup.resolve(
      ticket(A.code, A.name, { status: "SCANNED", scannedAt: NOW }),
      A.code,
    );

    // Not ALREADY USED · STOP for a person who has walked through.
    expect(h.verdict()).toBeNull();
    expect(h.haptics()).toEqual(["valid"]);
    expect(h.reports()).toContain("post_admit_reresolve_failed");
  });

  it("1c-B. ACCEPTED, dismiss, B found in search, THEN A's re-resolve lands: B stays, A never returns", async () => {
    // The camera cannot scan B here — it is paused while A's re-resolve is in
    // flight — so B arrives the other way an operator can reach the next
    // person: manual search, which has its own lookup.
    const h = renderScanScreen({
      people: [attendeeRow(A.code, A.name), attendeeRow(B.code, B.name)],
    });
    await scanValid(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.resolve({ outcome: "ACCEPTED", scannedAt: NOW }, A.code);
    await h.tap("Dismiss and scan next");
    expect(h.cameraArmed()).toBe(false);

    await h.tap("Manual search");
    await h.search(B.name.slice(0, 3));
    await h.pickResult(B.name);
    await h.lookup.resolve(ticket(B.code, B.name), B.code);
    await h.lookup.resolve(
      ticket(A.code, A.name, { status: "SCANNED", scannedAt: NOW }),
      A.code,
    );
    expect(h.verdict()?.name).toContain(B.name);
    expect(h.verdict()?.word).toBe("LET THEM IN");
    // A's stale re-resolve was DROPPED (reported), not written into the
    // hidden camera layer to resurface later.
    expect(h.reports()).toContain("post_admit_reresolve_failed");

    await h.tap("Dismiss result");
    await h.tap("Back to camera");
    expect(h.verdict()).toBeNull();
    expect(h.haptics()).not.toContain("already_scanned");
  });

  it("2. Admit → REJECTED event_not_active: HOLD, never ADMITTED, row NOT ADMITTED, nothing queued", async () => {
    const h = renderScanScreen();
    await scanValid(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.resolve(
      { outcome: "REJECTED", reason: "event_not_active" },
      A.code,
    );

    const v = h.verdict();
    expect(v?.state).toMatch(/doors not open/i);
    expect(v?.word).toBe("HOLD");
    expect(h.screenText()).not.toMatch(/ADMITTED|DONE|LET THEM IN/);
    // "Wrong path, nothing wrong with the pass" — the planner's signature for
    // event_not_active. Above all: never the admit cue.
    expect(h.haptics()).toEqual(["wrong_event"]);
    expect(h.sounds()).not.toContain("valid");
    expectAnnouncementMatchesVerdict(h);
    // No re-resolve over the refusal.
    expect(h.lookup.pending()).toEqual([]);
    expect(h.canTap("Undo this admission")).toBe(false);

    await h.advance(STRIP_TICK_MS);
    const row = h.recentRow(A.name);
    expect(row?.refused).toMatch(/^NOT ADMITTED/);
    expect(row?.undo).toBeNull();
    expect(h.device.queue()).toEqual([]);
  });

  it("3. Admit → REPLAY: ALREADY USED · STOP, already-scanned cue, row NOT ADMITTED", async () => {
    const h = renderScanScreen();
    await scanValid(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.resolve(
      { outcome: "REPLAY", previousScannedAt: EARLIER },
      A.code,
    );

    const v = h.verdict();
    expect(v?.state).toMatch(/already used/i);
    expect(v?.word).toBe("STOP");
    expect(h.screenText()).not.toMatch(/DONE|LET THEM IN/);
    expect(h.haptics()).toEqual(["already_scanned"]);
    expectAnnouncementMatchesVerdict(h);

    await h.advance(STRIP_TICK_MS);
    const row = h.recentRow(A.name);
    expect(row?.refused).toMatch(/^NOT ADMITTED/);
    expect(row?.undo).toBeNull();
    expect(h.device.queue()).toEqual([]);
  });
});

describe("express mode: the answer outlives the 1.2s dwell", () => {
  it("4. REPLAY for A after A's dwell ended, screen free: the verdict says it is about an EARLIER scan", async () => {
    const h = renderScanScreen({ express: true });
    await scanValid(h, A);
    expect(h.admit.pending()).toHaveLength(1); // auto-admitted
    await h.advance(EXPRESS_DWELL_MS);
    expect(h.verdict()).toBeNull();
    expect(h.cameraArmed()).toBe(true);

    h.observeFromHere();
    await h.admit.resolve(
      { outcome: "REPLAY", previousScannedAt: EARLIER },
      A.code,
    );

    const v = h.verdict();
    expect(v).not.toBeNull();
    expect(v?.word).toBe("STOP");
    expect(v?.detail).toMatch(
      /^EARLIER SCAN \(Ada Lovelace\) — not the person in front of you\./,
    );
    expect(h.haptics()).toEqual(["already_scanned"]);
    expectAnnouncementMatchesVerdict(h);

    // Sticky: nothing auto-clears the one message saying A did not get in.
    await h.advance(EXPRESS_DWELL_MS);
    expect(h.verdict()?.detail).toMatch(/^EARLIER SCAN/);
    const row = h.recentRow(A.name);
    expect(row?.refused).toMatch(/^NOT ADMITTED/);
    expect(row?.undo).toBeNull();
  });

  it("5. A's REPLAY lands while B's verdict is up: B stays, a rail notice names A and survives B's dwell", async () => {
    const h = renderScanScreen({ express: true });
    await scanValid(h, A);
    await h.advance(EXPRESS_DWELL_MS);
    await scanValid(h, B);
    expect(h.verdict()?.name).toContain(B.name);
    expect(h.canTap("Undo this admission")).toBe(true);

    await h.admit.resolve(
      { outcome: "REPLAY", previousScannedAt: EARLIER },
      A.code,
    );

    // B's verdict is untouched.
    const v = h.verdict();
    expect(v?.name).toContain(B.name);
    expect(v?.word).toBe("LET THEM IN");
    expect(h.screenText()).not.toMatch(/EARLIER SCAN|STOP/);
    expect(h.canTap("Undo this admission")).toBe(true);
    // A's refusal is on the rail, by name.
    const notice = h.railNotice();
    expect(notice).toMatch(/An earlier scan for Ada Lovelace was NOT ADMITTED/);
    expect(h.announcements().at(-1)).toBe(notice);
    expect(h.haptics()).toEqual(["valid", "valid", "already_scanned"]);

    // B's dwell ends; the notice is still there to read.
    await h.advance(EXPRESS_DWELL_MS);
    expect(h.verdict()).toBeNull();
    expect(h.railNotice()).toBe(notice);
    expect(h.recentRow(A.name)?.refused).toMatch(/^NOT ADMITTED/);
    expect(h.recentRow(B.name)?.refused).toBeNull();
  });

  it("12. REJECTED while A's own dwell is still running: refusal replaces the green and is never auto-dismissed", async () => {
    const h = renderScanScreen({ express: true });
    await scanValid(h, A);
    await h.advance(400);
    h.observeFromHere();
    await h.admit.resolve(
      { outcome: "REJECTED", reason: "ticket_not_valid" },
      A.code,
    );

    expect(h.verdict()?.word).toBe("STOP");
    expect(h.verdict()?.detail).not.toMatch(/EARLIER SCAN/);
    expect(h.haptics()).toEqual(["rejected"]);
    expect(h.canTap("Undo this admission")).toBe(false);

    await h.advance(EXPRESS_DWELL_MS * 3);
    expect(h.verdict()?.word).toBe("STOP");
    expect(h.cameraArmed()).toBe(false);
  });

  it("13. a LATE ACCEPTED for A is silent: no chime and no re-resolve over B", async () => {
    const h = renderScanScreen({ express: true });
    await scanValid(h, A);
    await h.advance(EXPRESS_DWELL_MS);
    await scanValid(h, B);
    h.observeFromHere();
    await h.admit.resolve({ outcome: "ACCEPTED", scannedAt: NOW }, A.code);

    expect(h.haptics()).toEqual([]);
    expect(h.lookup.pending()).toEqual([]);
    expect(h.verdict()?.name).toContain(B.name);
    expect(h.railNotice()).toBeNull();
  });
});

describe("the admit round trip itself fails", () => {
  it.each(["markTicketValidLocally", "markRecentScanRefused"] as const)(
    "6. REJECTED while %s throws (SQLITE_BUSY): refusal still shown, nothing queued, no admit cue, reported",
    async (failing) => {
      const h = renderScanScreen();
      await scanValid(h, A);
      h.observeFromHere();
      await h.tap("Admit");
      h.device.failOn(failing);
      await h.admit.resolve(
        { outcome: "REJECTED", reason: "ticket_not_valid" },
        A.code,
      );

      const v = h.verdict();
      expect(v?.state).toMatch(/not a ticket/i);
      expect(v?.word).toBe("STOP");
      expect(h.screenText()).not.toMatch(/ADMITTED|DONE/);
      expect(h.device.queue()).toEqual([]);
      expect(h.haptics()).toEqual(["rejected"]);
      expect(h.sounds()).not.toContain("valid");
      expect(h.lookup.pending()).toEqual([]);
      expect(h.reports()).toContain("admit_refusal_rollback_failed");
      expect(h.reports()).not.toContain("admit_settlement_handler_failed");
      expectAnnouncementMatchesVerdict(h);
    },
  );

  it("7a. transient network error while on screen: queued, admit cue, re-resolves to ADMITTED", async () => {
    const h = renderScanScreen();
    await scanValid(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.reject(new TypeError("Network request failed"), A.code);

    expect(h.device.queue()).toEqual([
      expect.objectContaining({ ticketCode: A.code }),
    ]);
    expect(h.haptics()).toEqual(["valid"]);
    expect(h.lookup.pending()).toEqual([
      expect.objectContaining({ raw: A.code }),
    ]);
    await h.lookup.resolve(
      ticket(A.code, A.name, { status: "SCANNED", scannedAt: NOW }),
      A.code,
    );
    expect(h.verdict()?.word).toBe("DONE");

    await h.advance(STRIP_TICK_MS);
    const row = h.recentRow(A.name);
    expect(row?.queued).toBe(true);
    expect(row?.refused).toBeNull();
    expect(row?.undo).toMatch(/^UNDO/);
  });

  it("7b. transient error for A arriving after B is up: queued, but no cue and no re-resolve over B", async () => {
    const h = renderScanScreen({ express: true });
    await scanValid(h, A);
    await h.advance(EXPRESS_DWELL_MS);
    await scanValid(h, B);
    h.observeFromHere();
    await h.admit.reject(new TypeError("Network request failed"), A.code);

    expect(h.device.queue()).toEqual([
      expect.objectContaining({ ticketCode: A.code }),
    ]);
    expect(h.haptics()).toEqual([]);
    expect(h.lookup.pending()).toEqual([]);
    expect(h.verdict()?.name).toContain(B.name);
    expect(h.railNotice()).toBeNull();
  });

  it("8a. permanent error (FORBIDDEN) while on screen: NOT RECORDED, row NOT ADMITTED, refusal cue", async () => {
    const h = renderScanScreen();
    await scanValid(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.reject(
      trpcError("FORBIDDEN", "You can't scan for this event."),
      A.code,
    );

    const v = h.verdict();
    expect(v?.state).toMatch(/not recorded/i);
    expect(v?.word).toBe("TRY AGAIN");
    expect(v?.detail).toContain("You can't scan for this event.");
    expect(h.haptics()).toEqual(["rejected"]);
    expect(h.device.queue()).toEqual([]);
    expect(h.reports()).toContain("admit_permanent_rejection");
    expectAnnouncementMatchesVerdict(h);

    await h.advance(STRIP_TICK_MS);
    expect(h.recentRow(A.name)?.refused).toMatch(/^NOT ADMITTED/);
    expect(h.recentRow(A.name)?.undo).toBeNull();
  });

  it("8b. permanent error for A after A's dwell ended, screen free: NOT RECORDED marked EARLIER SCAN", async () => {
    const h = renderScanScreen({ express: true });
    await scanValid(h, A);
    await h.advance(EXPRESS_DWELL_MS);
    h.observeFromHere();
    await h.admit.reject(trpcError("FORBIDDEN"), A.code);

    const v = h.verdict();
    expect(v?.state).toMatch(/not recorded/i);
    expect(v?.detail).toMatch(/^EARLIER SCAN \(Ada Lovelace\)/);
    expect(h.haptics()).toEqual(["rejected"]);
    expectAnnouncementMatchesVerdict(h);
  });

  it("8c. permanent error for A while B is up: B stays, rail notice names A", async () => {
    const h = renderScanScreen({ express: true });
    await scanValid(h, A);
    await h.advance(EXPRESS_DWELL_MS);
    await scanValid(h, B);
    h.observeFromHere();
    await h.admit.reject(trpcError("FORBIDDEN"), A.code);

    expect(h.verdict()?.name).toContain(B.name);
    expect(h.screenText()).not.toMatch(/NOT RECORDED|EARLIER SCAN/i);
    expect(h.railNotice()).toMatch(/Ada Lovelace was NOT ADMITTED/);
    expect(h.haptics()).toEqual(["rejected"]);
    await h.advance(EXPRESS_DWELL_MS);
    expect(h.railNotice()).toMatch(/Ada Lovelace/);
  });
});

describe("manual search", () => {
  const people = [attendeeRow(A.code, A.name), attendeeRow(B.code, B.name)];

  const findAndResolve = async (h: ScanHarness, who: typeof A) => {
    await h.search(who.name.slice(0, 3));
    await h.pickResult(who.name);
    await h.lookup.resolve(ticket(who.code, who.name), who.code);
  };

  it("9. admit A, dismiss, resolve B, then A's late REJECTED: B's card stays visible and uncovered", async () => {
    const h = renderScanScreen({ people });
    await h.tap("Manual search");
    expect(h.inSearch()).toBe(true);
    await findAndResolve(h, A);
    await h.tap("Admit");
    await h.tap("Dismiss result");
    await findAndResolve(h, B);
    expect(h.verdict()?.name).toContain(B.name);

    h.observeFromHere();
    await h.admit.resolve(
      { outcome: "REJECTED", reason: "ticket_not_valid" },
      A.code,
    );

    const v = h.verdict();
    expect(v?.testId).toBe("scan-result-kind-ticket");
    expect(v?.name).toContain(B.name);
    expect(v?.word).toBe("LET THEM IN");
    expect(h.railNotice()).toMatch(/Ada Lovelace was NOT ADMITTED/);
    expect(h.haptics()).toEqual(["rejected"]);
    expect(h.canTap("Admit")).toBe(true);
  });

  it("14. admit A from search → ACCEPTED: the card confirms it and stops offering a second Admit", async () => {
    const h = renderScanScreen({ people });
    await h.tap("Manual search");
    await findAndResolve(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.resolve({ outcome: "ACCEPTED", scannedAt: NOW }, A.code);
    // Search does NOT re-resolve: the card is patched from the ACCEPTED answer.
    expect(h.lookup.pending()).toEqual([]);

    expect(h.verdict()?.word).toBe("DONE");
    expect(h.canTap("Admit")).toBe(false);
    expect(h.haptics()).toEqual(["valid"]);

    // The recent-scans row was written against the SEARCH card: it carries
    // the holder's name and the ticket id, so it can be undone.
    await h.tap("Dismiss result");
    await h.tap("Back to camera");
    await h.advance(STRIP_TICK_MS);
    const row = h.recentRow(A.name);
    expect(row).not.toBeNull();
    expect(row?.refused).toBeNull();
    expect(row?.undo).toMatch(/^UNDO \d+s$/);
  });

  it("10. A's refusal is showing; resolving B clears it and shows B", async () => {
    const h = renderScanScreen({ people });
    await h.tap("Manual search");
    await findAndResolve(h, A);
    await h.tap("Admit");
    await h.admit.resolve(
      { outcome: "REJECTED", reason: "ticket_not_valid" },
      A.code,
    );
    expect(h.verdict()).toMatchObject({
      testId: "unified-search-refusal",
      word: "STOP",
    });

    await findAndResolve(h, B);
    const v = h.verdict();
    expect(v?.testId).toBe("scan-result-kind-ticket");
    expect(v?.name).toContain(B.name);
    expect(h.screenText()).not.toMatch(/not a ticket/i);
  });

  it("7a-search. search admit, transient network error: queued once, the card confirms, no second Admit", async () => {
    const h = renderScanScreen({ people });
    await h.tap("Manual search");
    await findAndResolve(h, A);
    h.observeFromHere();
    await h.tap("Admit");
    await h.admit.reject(new TypeError("Network request failed"), A.code);

    expect(h.device.queue()).toEqual([
      expect.objectContaining({ ticketCode: A.code }),
    ]);
    expect(h.admit.calls()).toHaveLength(1);
    expect(h.verdict()?.word).toBe("DONE");
    expect(h.canTap("Admit")).toBe(false);
    expect(h.haptics()).toEqual(["valid"]);
  });

  it("11-search. search admit while offline: queued once, the card confirms, no second Admit", async () => {
    const h = renderScanScreen({ people });
    await h.tap("Manual search");
    await findAndResolve(h, A);
    await h.setNetwork("offline");
    h.observeFromHere();
    await h.tap("Admit");

    expect(h.admit.calls()).toEqual([]);
    expect(h.device.queue()).toEqual([
      expect.objectContaining({ ticketCode: A.code }),
    ]);
    expect(h.verdict()?.word).toBe("DONE");
    expect(h.canTap("Admit")).toBe(false);
    expect(h.haptics()).toEqual(["valid"]);
  });

  it("D. a refusal in search does not follow the operator back to the camera", async () => {
    const h = renderScanScreen({ people });
    await h.tap("Manual search");
    await findAndResolve(h, A);
    await h.tap("Admit");
    await h.admit.resolve(
      { outcome: "REJECTED", reason: "ticket_not_valid" },
      A.code,
    );
    expect(h.verdict()?.testId).toBe("unified-search-refusal");

    await h.tap("Back");
    expect(h.inSearch()).toBe(false);
    expect(h.verdict()).toBeNull();
    expect(h.cameraArmed()).toBe(true);
  });
});

describe("offline", () => {
  it("11. admit while offline: queued, optimistic ADMITTED, no network call", async () => {
    const h = renderScanScreen({
      network: "offline",
      manifest: [{ code: A.code, ownerHuman: `h-${A.code}` }],
    });
    h.device.seedPerson(`h-${A.code}`, A.name);

    await h.scan(A.code);
    const before = h.verdict();
    expect(before?.word).toBe("LET THEM IN");
    expect(before?.name).toContain(A.name);
    expect(before?.text).toMatch(/OFFLINE/i);

    h.observeFromHere();
    await h.tap("Admit");

    expect(h.admit.calls()).toEqual([]);
    expect(h.lookup.calls()).toEqual([]);
    expect(h.device.queue()).toEqual([
      expect.objectContaining({ ticketCode: A.code }),
    ]);
    expect(h.verdict()?.word).toBe("DONE");
    expect(h.haptics()[0]).toBe("valid");
    expect(h.haptics()).not.toContain("already_scanned");

    await h.advance(STRIP_TICK_MS);
    const row = h.recentRow(A.name);
    expect(row?.queued).toBe(true);
    expect(row?.refused).toBeNull();
    expect(row?.undo).toMatch(/^UNDO/);
  });
});

describe("bulk admit", () => {
  it("F. same-order bulk admit: one admit cue, the follow-up re-resolve is silent", async () => {
    const A2 = { code: "TK-AAA112", name: "Ada Lovelace" };
    const h = renderScanScreen({
      manifest: [
        { code: A.code, ownerHuman: `h-${A.code}`, orderId: "ord-1" },
        { code: A2.code, ownerHuman: `h-${A.code}`, orderId: "ord-1" },
      ],
    });
    await scanValid(h, A);
    h.observeFromHere();
    await h.tap(/^Admit all 2 tickets$/);
    for (const call of h.admit.pending()) {
      await h.admit.resolve(
        { outcome: "ACCEPTED", scannedAt: NOW },
        call.ticketCode,
      );
    }
    for (const call of h.lookup.pending()) {
      await h.lookup.resolve(
        ticket(call.raw, A.name, { status: "SCANNED", scannedAt: NOW }),
        call.raw,
      );
    }
    expect(h.haptics()).toEqual(["valid"]);
  });
});
