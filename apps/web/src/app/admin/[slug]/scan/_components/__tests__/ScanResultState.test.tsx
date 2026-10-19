/**
 * What the verdict states actually RENDER.
 *
 * Phase A shipped two blockers that survived hundreds of green tests because
 * the suite was all pure functions and the JSX branch logic was untested —
 * including a `hasDetail = !!children` that was permanently true. So these
 * assert the DOM: which channels are present, which affordances exist, and
 * (critically) which do NOT.
 *
 * The structure under test is the Design System's `ScanResult` (D-122…D-126):
 * a small mono STATE line (`ALREADY USED · 8:14 PM`), then the huge WORD (the
 * instruction), then WHO, then the DETAIL that carries the why.
 */
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SCAN_VERDICTS } from "@th/types";
import { IthasFireProvider, tokens } from "@th/ui";
import type {
  ResolveScanPayloadOutput,
  ResolveScanPayloadVolunteerResult,
} from "@th/core/use-cases/scanning";

import {
  FullBleedBand,
  SHELL_CONTENT_GUTTER,
  ScanResultState,
  useScanVerdict,
} from "../ScanResultState";
import {
  verdictWordFontSize,
  verdictWordFontSizeWide,
} from "../ToneResultState";
import { SCAN_ACTION_LABELS } from "../scan-action-labels";
import { SCAN_FAILURE_COPY } from "../scan-failure-copy";
import type { ScanResultDescriptor } from "../scan-result-presentation";

/**
 * Matched against the shared label table rather than a copy of the string, so a
 * width fix that shortens a label cannot silently stop these from matching the
 * button they are meant to be asserting on.
 */
const DISMISS_LABEL_RE = new RegExp(`^${SCAN_ACTION_LABELS.dismiss}$`, "i");
const CHECK_IN_LABEL_RE = new RegExp(`^${SCAN_ACTION_LABELS.checkIn}$`, "i");

// ── Fixtures ────────────────────────────────────────────────────────────────

const candidate = (
  over: Partial<ResolveScanPayloadVolunteerResult["candidates"][number]> = {},
): ResolveScanPayloadVolunteerResult["candidates"][number] => ({
  signupId: "sg_1",
  humanId: "hu_1",
  humanDisplayName: "Marisol Delgado-Rivera",
  humanContactMasked: "m•••@example.com",
  eventId: "ev_1",
  eventTitle: "Autumn Showcase",
  roleId: "ro_1",
  roleLabel: "Door",
  shiftId: "sh_1",
  shiftLabel: "19:00–23:00",
  shiftStartAt: "2026-08-06T19:00:00.000Z",
  shiftEndAt: "2026-08-06T23:00:00.000Z",
  status: "APPROVED",
  checkedInAt: null,
  checkedInByHumanId: null,
  window: "within",
  scanWindowNote: "Shift starts in 20 minutes.",
  alsoHoldsTicket: false,
  ...over,
});

const ticket = (
  over: Record<string, unknown> = {},
): ResolveScanPayloadOutput =>
  ({
    kind: "ticket",
    ticketId: "tk_id",
    ticketCode: "tk_9f3a2b7c1d4e",
    status: "VALID",
    scannedAt: null,
    holderHumanId: "hu_1",
    holderDisplay: "Marisol Delgado-Rivera",
    ticketTypeName: "General Admission",
    alsoVolunteering: [],
    ...over,
  }) as ResolveScanPayloadOutput;

const volunteer = (
  over: Partial<ResolveScanPayloadVolunteerResult> = {},
): ResolveScanPayloadOutput => ({
  kind: "volunteer",
  humanId: "hu_1",
  displayName: "Marisol Delgado-Rivera",
  candidates: [candidate()],
  alsoHoldsTicket: [],
  ...over,
});

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * The REAL @th/ui + Tamagui stack, deliberately unmocked: the tone fills and
 * the `$token` lookups only exist once a theme is resolved, and a mocked design
 * system would render the exact class of defect this suite is here to catch as
 * plain, passing DOM.
 */
const render = (ui: ReactElement) =>
  rtlRender(<IthasFireProvider>{ui}</IthasFireProvider>);

const noop = () => {};

function Harness({
  result = null,
  override = null,
  canCheckInVolunteer = true,
  onDismiss = noop,
  onAdmitTicket = noop,
  onCheckInVolunteer = noop,
  onScanCrossTicket = noop,
  admitPending = false,
}: {
  result?: ResolveScanPayloadOutput | null;
  override?: ScanResultDescriptor | null;
  canCheckInVolunteer?: boolean;
  onDismiss?: () => void;
  onAdmitTicket?: (code: string) => void;
  onCheckInVolunteer?: (id: string) => void;
  onScanCrossTicket?: (code: string) => void;
  admitPending?: boolean;
}) {
  const verdict = useScanVerdict({
    result,
    override,
    selectedEventName: "Autumn Showcase",
    canCheckInVolunteer,
  });
  if (!verdict) return <div data-testid="no-verdict" />;
  return (
    <ScanResultState
      verdict={verdict}
      onDismiss={onDismiss}
      onAdmitTicket={onAdmitTicket}
      admitPending={admitPending}
      onCheckInVolunteer={onCheckInVolunteer}
      checkInPending={false}
      onScanCrossTicket={onScanCrossTicket}
      resolvePending={false}
    />
  );
}

// ── VALID ───────────────────────────────────────────────────────────────────

describe("VALID ticket", () => {
  it("renders every redundancy channel, in DS zone order", () => {
    render(<Harness result={ticket()} />);
    // ① what it IS, ② what to DO — the split that lets two tones carry
    // nineteen outcomes. "Valid" still requires a decision; "LET THEM IN"
    // does not.
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "VALID",
    );
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent(
      "LET THEM IN",
    );
    expect(screen.getByTestId("tone-result-name")).toHaveTextContent(
      "Marisol Delgado-Rivera",
    );
    expect(screen.getByTestId("tone-result-type")).toHaveTextContent(
      "General Admission",
    );
    expect(screen.getByTestId("tone-result-code")).toHaveTextContent(
      "tk_9f3a2b7c1d4e",
    );
    // The glyph is the channel a deuteranope reads; it must actually be there.
    expect(screen.getByTestId("tone-result-glyph")).toBeInTheDocument();
  });

  it("has NO tap-to-dismiss target — a tap would silently skip an admission", () => {
    render(<Harness result={ticket()} />);
    expect(screen.queryByTestId("tone-result-dismiss-target")).toBeNull();
  });

  it("offers Admit and Skip, and admits with the ticket code", () => {
    const onAdmitTicket = vi.fn();
    render(<Harness result={ticket()} onAdmitTicket={onAdmitTicket} />);
    fireEvent.click(screen.getByRole("button", { name: /admit/i }));
    expect(onAdmitTicket).toHaveBeenCalledWith("tk_9f3a2b7c1d4e");
    expect(screen.getByRole("button", { name: /skip/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: DISMISS_LABEL_RE })).toBeNull();
  });

  it("says nothing under the verdict — the ADMIT button is the copy", () => {
    render(<Harness result={ticket()} />);
    expect(screen.queryByTestId("tone-result-detail-line")).toBeNull();
  });

  it("is the page's ONE assertive live region, announced exactly once", () => {
    // DS D-125: the verdict is the one sanctioned `role="alert"` in the system.
    // The page used to carry a second, polite `role="status"` span mirroring
    // the same text — running both reads every verdict twice.
    render(<Harness result={ticket()} />);
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveAttribute("aria-live", "assertive");
    // It carries the whole verdict, in reading order.
    expect(alerts[0]).toHaveTextContent(/VALID/);
    expect(alerts[0]).toHaveTextContent(/LET THEM IN/);
    expect(alerts[0]).toHaveTextContent(/Marisol Delgado-Rivera/);
  });

  it("gives the word real heading semantics, at level 1", () => {
    // Door mode takes the page chrome out of the document and neither the shell
    // nor this page renders any other heading, so the verdict IS the page's
    // heading. An `h2` here would be an orphan skipped level.
    render(<Harness result={ticket()} />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("LET THEM IN");
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("keeps the detail panel OUT of the live region", () => {
    // It holds its own buttons; shouting them assertively is not what an alert
    // is for.
    render(<Harness result={volunteer()} />);
    expect(screen.getByRole("alert")).not.toContainElement(
      screen.getByTestId("tone-result-detail"),
    );
  });

  it("renders NO empty detail band (the `!!children` regression)", () => {
    render(<Harness result={ticket()} />);
    expect(screen.queryByTestId("tone-result-detail")).toBeNull();
  });
});

// ── SCANNED ─────────────────────────────────────────────────────────────────

describe("SCANNED ticket", () => {
  const scanned = ticket({
    status: "SCANNED",
    scannedAt: new Date("2026-08-06T21:14:00Z"),
  });

  it("reads ALREADY USED · <time>, then STOP", () => {
    render(<Harness result={scanned} />);
    // The DS appends the scan time to the STATE line — the fact that settles an
    // argument with a stranger — and the WORD stays the instruction.
    const state = screen.getByTestId("tone-result-state-line");
    expect(state).toHaveTextContent(/^ALREADY USED · /);
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("STOP");
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      /already admitted/i,
    );
  });

  it("dismisses on a tap anywhere on the band, and from the button", () => {
    const onDismiss = vi.fn();
    render(<Harness result={scanned} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("tone-result-dismiss-target"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: DISMISS_LABEL_RE }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("never offers ADMIT for a used pass", () => {
    render(<Harness result={scanned} />);
    expect(screen.queryByRole("button", { name: /^admit$/i })).toBeNull();
  });
});

// ── The FR-008 drift bugs ───────────────────────────────────────────────────

describe("statuses that used to be wrong on the web (FR-008)", () => {
  it("labels INVALID as Not a ticket — not 'Voided'", () => {
    render(<Harness result={ticket({ status: "INVALID" })} />);
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "NOT A TICKET",
    );
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      "Invalid ticket — do not admit.",
    );
    expect(screen.queryByText(/voided/i)).toBeNull();
  });

  it("has copy for VOID at all, which it previously did not", () => {
    // The resolver's TS union does not yet carry VOID; the DB enum does, and a
    // client that shipped before a status exists is exactly the case the shared
    // map fails closed for. Cast deliberately.
    render(<Harness result={ticket({ status: "VOID" })} />);
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "VOIDED",
    );
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("STOP");
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      "Voided — do not admit.",
    );
  });

  it("renders the FR-008 resale line verbatim for LISTED", () => {
    render(<Harness result={ticket({ status: "LISTED" })} />);
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      "Listed for resale — do not admit.",
    );
  });

  it("fails closed on a status it has never heard of", () => {
    render(<Harness result={ticket({ status: "TELEPORTED" })} />);
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "UNRECOGNISED",
    );
    // Never NOT A TICKET's line: a status this client has not shipped support
    // for is not evidence against the person holding the pass.
    expect(screen.queryByText(/not a ticket/i)).toBeNull();
  });
});

// ── wrong_event / unknown ───────────────────────────────────────────────────

describe("wrong event and unreadable payloads", () => {
  it("names the selected event in the wrong-show guidance", () => {
    render(
      <Harness
        result={{
          kind: "wrong_event",
          payloadKind: "ticket",
          scannedEventId: "ev_2",
        }}
      />,
    );
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "WRONG EVENT",
    );
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      "Autumn Showcase",
    );
    expect(screen.queryByTestId("tone-result-detail")).toBeNull();
  });

  it("distinguishes a no-match from an unreadable QR", () => {
    const { unmount } = render(
      <Harness result={{ kind: "unknown", reason: "ticket_not_found" }} />,
    );
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "NO MATCH",
    );
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("STOP");
    unmount();

    render(<Harness result={{ kind: "unknown", reason: "malformed" }} />);
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "UNREADABLE",
    );
    // A claim about the QR, not about the holder — so the instruction is to
    // scan again, not to turn someone away.
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent(
      "TRY AGAIN",
    );
  });
});

// ── Volunteer ───────────────────────────────────────────────────────────────

describe("volunteer pass", () => {
  it("shows the role beside the person and the shift below the fold", () => {
    render(<Harness result={volunteer()} />);
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "VOLUNTEER",
    );
    // A volunteer is a PASS, and the instruction is check-in — not admission.
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent(
      "CHECK THEM IN",
    );
    // The role rides the DS's `tier` slot: "Marisol · Door".
    expect(screen.getByTestId("tone-result-who")).toHaveTextContent(
      "Marisol Delgado-Rivera · Door",
    );
    const detail = screen.getByTestId("tone-result-detail");
    expect(detail).toHaveTextContent("Door — 19:00–23:00");
    expect(detail).toHaveTextContent("Shift starts in 20 minutes.");
  });

  it("puts CHECK IN under the operator's thumb, not below the fold", () => {
    const onCheckInVolunteer = vi.fn();
    render(<Harness result={volunteer()} onCheckInVolunteer={onCheckInVolunteer} />);
    fireEvent.click(screen.getByRole("button", { name: CHECK_IN_LABEL_RE }));
    expect(onCheckInVolunteer).toHaveBeenCalledWith("sg_1");
  });

  it("locks — not hides — check-in without the role, and says why", () => {
    const onCheckInVolunteer = vi.fn();
    render(
      <Harness
        result={volunteer()}
        canCheckInVolunteer={false}
        onCheckInVolunteer={onCheckInVolunteer}
      />,
    );
    const button = screen.getByRole("button", { name: CHECK_IN_LABEL_RE });
    // The Button atom renders `aria-disabled` rather than the DOM `disabled`
    // attribute (it is a Tamagui frame, not a bare <button>), so assert the
    // BEHAVIOUR as well as the semantics — the affordance must be inert, and a
    // markup-only assertion would not have noticed if it were not.
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(onCheckInVolunteer).not.toHaveBeenCalled();
    expect(
      screen.getByText(/edit role required to check in volunteers/i),
    ).toBeInTheDocument();
  });

  it("still renders a detail band when there are no eligible signups", () => {
    render(<Harness result={volunteer({ candidates: [] })} />);
    expect(screen.getByTestId("tone-result-detail")).toHaveTextContent(
      "No eligible signups for this event.",
    );
    expect(
      screen.getByRole("button", { name: DISMISS_LABEL_RE }),
    ).toBeInTheDocument();
  });

  it("offers the volunteer's other ticket for this event", () => {
    const onScanCrossTicket = vi.fn();
    render(
      <Harness
        result={volunteer({
          alsoHoldsTicket: [
            {
              ticketId: "t1",
              ticketCode: "tk_other",
              status: "VALID",
              scannedAt: null,
            },
          ],
        })}
        onScanCrossTicket={onScanCrossTicket}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open this ticket/i }));
    expect(onScanCrossTicket).toHaveBeenCalledWith("tk_other");
  });
});

// ── Ticket with cross-context rows ──────────────────────────────────────────

describe("ticket that is also volunteering", () => {
  it("keeps the shift below the fold, under the verdict", () => {
    render(<Harness result={ticket({ alsoVolunteering: [candidate()] })} />);
    const detail = screen.getByTestId("tone-result-detail");
    expect(detail).toHaveTextContent("Also volunteering");
    expect(detail).toHaveTextContent("Door — 19:00–23:00");
  });
});

// ── Error ───────────────────────────────────────────────────────────────────

describe("a failed round trip", () => {
  it("renders as a STOP verdict and outranks a stale result", () => {
    render(
      <Harness
        result={ticket()}
        override={{
          kind: "failure",
          stage: "record",
          detail: SCAN_FAILURE_COPY.offline.guidance,
          supportRef: null,
        }}
      />,
    );
    // The dangerous case: a failed admit under a still-green VALID state. The
    // error wins the screen.
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "NOT RECORDED",
    );
    // TRY AGAIN, not STOP: the admission did not happen and we are not claiming
    // the pass is bad.
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent(
      "TRY AGAIN",
    );
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      SCAN_FAILURE_COPY.offline.guidance,
    );
    expect(screen.queryByRole("button", { name: /^admit$/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: DISMISS_LABEL_RE }),
    ).toBeInTheDocument();
  });

  it("NEVER shows a raw server code as the operator's guidance", () => {
    // The live defect this suite exists to stop coming back: an operator at a
    // door was shown `volunteer_scan_token_not_configured` as the instruction
    // under a full-bleed red SCAN FAILED.
    render(
      <Harness
        override={{
          kind: "failure",
          stage: "record",
          detail: SCAN_FAILURE_COPY.server.guidance,
          supportRef: "volunteer_scan_token_not_configured",
        }}
      />,
    );
    const detailLine = screen.getByTestId("tone-result-detail-line");
    expect(detailLine).toHaveTextContent(SCAN_FAILURE_COPY.server.guidance);
    expect(detailLine.textContent ?? "").not.toContain(
      "volunteer_scan_token_not_configured",
    );
    // The code survives, but as a labelled support reference — smaller, below
    // the detail, and clearly not an instruction.
    expect(screen.getByTestId("tone-result-ref")).toHaveTextContent(
      "volunteer_scan_token_not_configured",
    );
  });

  it("keeps the support ref OUT of the live region, so it is never read aloud", () => {
    // Inside `role="alert"`, a screen reader announced
    // "Ref: volunteer_scan_token_not_configured" as part of the verdict.
    render(
      <Harness
        override={{
          kind: "failure",
          stage: "lookup",
          detail: SCAN_FAILURE_COPY.server.guidance,
          supportRef: "volunteer_scan_token_not_configured",
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    const ref = screen.getByTestId("tone-result-ref");
    expect(alert).not.toContainElement(ref);
    expect(alert.textContent ?? "").not.toContain(
      "volunteer_scan_token_not_configured",
    );
    // …while the verdict itself is still announced.
    expect(alert).toContainElement(screen.getByTestId("tone-result-word"));
    expect(alert).toContainElement(
      screen.getByTestId("tone-result-detail-line"),
    );
    // A lookup that threw reads SCAN FAILED, not NOT RECORDED.
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "SCAN FAILED",
    );
  });

  it("shows no support line at all when there is no code to quote", () => {
    render(
      <Harness
        override={{
          kind: "failure",
          stage: "record",
          detail: SCAN_FAILURE_COPY.unknown.guidance,
          supportRef: null,
        }}
      />,
    );
    expect(screen.queryByTestId("tone-result-ref")).toBeNull();
  });
});

// ── A rejected admit ────────────────────────────────────────────────────────

describe("an admit the server REJECTED", () => {
  it("tells the operator the door is shut instead of doing nothing", () => {
    // `scanTicket` returns REJECTED as a 200. It used to be dropped: no
    // message, no tally change, the button simply re-enabled, so an operator
    // outside the check-in window tapped ADMIT forever with no feedback.
    render(
      <Harness
        result={ticket()}
        override={{ kind: "admit_rejected", reason: "event_not_active" }}
      />,
    );
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      "DOORS NOT OPEN",
    );
    // HOLD, never STOP — nothing is wrong with the person.
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("HOLD");
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      /check-in/i,
    );
    // The ADMIT affordance is gone — tapping it again cannot help.
    expect(screen.queryByRole("button", { name: /^admit$/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: DISMISS_LABEL_RE }),
    ).toBeInTheDocument();
  });
});

// ── Action labels (320px width budget) ──────────────────────────────────────

describe("the action row renders the guarded labels", () => {
  /**
   * The width budget is asserted in `scan-action-labels.test.ts`, which can only
   * guard the strings in that table. These tie the RENDERED buttons to it — a
   * hardcoded label in the JSX would fit the budget on paper and clip on a
   * phone, which is exactly the shape of the defect being fixed.
   */
  it("uses the table's label on the primary dismiss", () => {
    render(<Harness result={ticket({ status: "REFUNDED" })} />);
    const button = screen.getByTestId("scan-dismiss-action");
    expect(button).toHaveTextContent(
      new RegExp(`^${SCAN_ACTION_LABELS.dismiss}$`, "i"),
    );
    // The old label, observed clipped to "DISMISS AND …" at 320.
    expect(button.textContent ?? "").not.toMatch(/dismiss and scan next/i);
  });

  it("uses the table's labels on ADMIT / SKIP", () => {
    render(<Harness result={ticket()} />);
    expect(
      screen.getByRole("button", {
        name: new RegExp(`^${SCAN_ACTION_LABELS.admit}$`, "i"),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: new RegExp(`^${SCAN_ACTION_LABELS.skip}$`, "i"),
      }),
    ).toBeInTheDocument();
  });

  it("uses the table's labels on CHECK IN / DISMISS", () => {
    render(<Harness result={volunteer()} />);
    const button = screen.getByRole("button", { name: CHECK_IN_LABEL_RE });
    expect(button).toBeInTheDocument();
    expect(button.textContent ?? "").not.toMatch(/check in volunteer/i);
    expect(
      screen.getByRole("button", {
        name: new RegExp(`^${SCAN_ACTION_LABELS.dismissSecondary}$`, "i"),
      }),
    ).toBeInTheDocument();
  });

  it("every REJECTED verdict lands on the same short primary", () => {
    // The rejection states all take the dismiss branch, so they inherit the fix
    // — but only as long as they keep taking it.
    for (const reason of [
      "event_not_active",
      "event_mismatch",
      "ticket_not_found",
      "ticket_not_valid",
    ]) {
      const { unmount } = render(
        <Harness override={{ kind: "admit_rejected", reason }} />,
      );
      expect(screen.getByTestId("scan-dismiss-action")).toHaveTextContent(
        new RegExp(`^${SCAN_ACTION_LABELS.dismiss}$`, "i"),
      );
      unmount();
    }
  });
});

// ── Focus (door mode replaces the page) ─────────────────────────────────────

describe("focus", () => {
  it("puts the keyboard on the primary action when a verdict arrives", () => {
    // Door mode takes the page chrome OUT of the document, so focus otherwise
    // resets to <body> on every scan and a keyboard or switch-control operator
    // re-traverses the whole admin shell between people.
    render(<Harness result={ticket()} />);
    const row = screen.getByTestId("scan-action-row");
    expect(row).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toHaveTextContent(/admit/i);
  });

  it("does not yank focus away from an operator already inside the state", () => {
    render(<Harness result={ticket()} />);
    const skip = screen.getByRole("button", { name: /skip/i });
    skip.focus();
    // A re-render that does not change the subject (e.g. a pending flag
    // flipping) must not drag focus back to ADMIT mid-tap.
    fireEvent.mouseOver(skip);
    expect(document.activeElement).toBe(skip);
  });
});

// ── Full bleed (design §1) ──────────────────────────────────────────────────

describe("the verdict band breaks out of the shell gutter", () => {
  it("cancels EXACTLY the admin shell's content padding", () => {
    // The containment assertions below would stay green with the margin set to
    // zero — they guard the structure, not the bleed. This one guards the
    // number, and guards it against the shell's own token rather than against a
    // transcribed 24, so the two cannot drift apart silently.
    expect(SHELL_CONTENT_GUTTER).toBe(tokens.space.$5);
    const applied = (
      FullBleedBand as unknown as {
        staticConfig?: { defaultProps?: Record<string, unknown> };
      }
    ).staticConfig?.defaultProps;
    expect(
      applied,
      "Tamagui no longer exposes staticConfig.defaultProps — this guard needs " +
        "rewriting, not deleting: without it the band can silently stop bleeding",
    ).toBeTruthy();
    expect(applied!.marginHorizontal).toBe(-tokens.space.$5);
  });

  it("wraps the tone fill, and ONLY the tone fill", () => {
    // Design §1: "a full-bleed verdict with a 16pt cream gutter around it is
    // not full-bleed; it is a big card, which is the thing this FR is
    // replacing." The admin shell pads every route 24px, so the band cancels
    // that — and the CONTROLS deliberately do not, because a primary button
    // flush to the edge of a phone screen is a mis-tap.
    render(<Harness result={ticket()} />);
    const bleed = screen.getByTestId("scan-verdict-bleed");
    expect(bleed).toContainElement(screen.getByTestId("scan-result-state"));
    expect(bleed).not.toContainElement(screen.getByTestId("scan-action-row"));
  });

  it("bleeds the detail band too — it is part of the verdict, not a sibling card", () => {
    render(<Harness result={volunteer()} />);
    expect(screen.getByTestId("scan-verdict-bleed")).toContainElement(
      screen.getByTestId("tone-result-detail"),
    );
  });
});

// ── The word fits the smallest phone ────────────────────────────────────────

/**
 * The DS sets the word with `clamp(52px, 13vw, 88px)`, which is authored
 * against its own five words — the longest is "Let them in". Ours ships
 * nineteen outcomes and eight distinct words, up to "CHECK THEM IN", and a
 * viewport-derived clamp does not know that. `verdictWordFontSize` sizes by
 * LENGTH instead, and this is the guard on it.
 *
 * ## The estimate, and why it is trustworthy
 *
 * jsdom has no layout engine, so a rendered measurement is not available to
 * this suite at all. The per-character advance below is not invented: it is
 * calibrated against real measurements taken in headless Chromium with the
 * repo's own self-hosted `Montserrat-roman.var.woff2` at weight 900, uppercase,
 * at the tracking this component applies (`-0.045em`):
 *
 * ```
 *   "SEARCH" @48px = 188px   (0.653 em/char)
 *   "THEM"   @48px = 139px   (0.724 em/char)   ← the widest ratio observed
 *   "CHECK"  @48px = 166px   (0.692 em/char)
 *   "HOLD"   @64px = 177px   (0.691 em/char)
 *   "DONE"   @64px = 174px   (0.680 em/char)
 *   "STOP"   @64px = 155px   (0.606 em/char)
 * ```
 *
 * 0.75 em/char is therefore a deliberate OVER-estimate — the guard errs toward
 * failing early. Measured in the same run: at 320px every word either fits on
 * one line or wraps to two, none breaks mid-word, and nothing overflows; from
 * 375px up every word is a single line.
 */
const BAND_TEXT_WIDTH_320 = 286;
const UPPERCASE_BLACK_ADVANCE_EM = 0.75;
const estimateTokenWidth = (token: string, px: number) =>
  token.length * px * UPPERCASE_BLACK_ADVANCE_EM;

describe("the verdict word at 320px", () => {
  const words = [...new Set(Object.values(SCAN_VERDICTS).map((v) => v.word))];

  it("guards a word that would break mid-token", () => {
    // Anchor first: a guard that cannot fail is worse than none. A word long
    // enough to break inside itself must be rejected by this arithmetic.
    expect(
      estimateTokenWidth("ABSOLUTELYNOTPERMITTED", verdictWordFontSize("STOP")),
    ).toBeGreaterThan(BAND_TEXT_WIDTH_320);
  });

  it.each(words)("%s never breaks inside a token at 320px", (word) => {
    const px = verdictWordFontSize(word);
    for (const token of word.split(" ")) {
      expect(
        estimateTokenWidth(token, px),
        `"${token}" at ${px}px needs ~${Math.round(
          estimateTokenWidth(token, px),
        )}px of ${BAND_TEXT_WIDTH_320}px`,
      ).toBeLessThanOrEqual(BAND_TEXT_WIDTH_320);
    }
  });

  it("gives the shortest words the biggest rung", () => {
    // The instruction has to be readable at arm's length in 300ms; a four-letter
    // STOP earning the same size as CHECK THEM IN would waste the whole point.
    expect(verdictWordFontSize("STOP")).toBeGreaterThan(
      verdictWordFontSize("CHECK THEM IN"),
    );
    expect(verdictWordFontSizeWide("STOP")).toBe(86);
  });

  it("scales up above 640px, never down", () => {
    for (const word of words) {
      expect(verdictWordFontSizeWide(word)).toBeGreaterThan(
        verdictWordFontSize(word),
      );
    }
  });
});

// ── Nothing to show ─────────────────────────────────────────────────────────

describe("no result", () => {
  it("renders nothing at all", () => {
    render(<Harness />);
    expect(screen.getByTestId("no-verdict")).toBeInTheDocument();
  });
});
