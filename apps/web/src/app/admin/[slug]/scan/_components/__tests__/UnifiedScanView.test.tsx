/**
 * FR-011 / FR-013 / FR-014 — the ORCHESTRATION, which had no test at all.
 *
 * Every defect this file guards against lived in the ~170 lines that wire the
 * resolver, the admit and the camera gate together, and every one of them
 * survived a suite of hundreds of green tests because those tests stopped one
 * layer down. `ScanResultState.test.tsx` opens by naming that exact failure
 * mode — and then leaves this layer untested.
 *
 * The four it pins:
 *
 *   1. A successful admit whose follow-up work fails must STILL render the
 *      admission. (Observed at a door: admitted, recorded in the database,
 *      tally at 1 — and a full-bleed fail verdict on screen.)
 *   2. A raw server identifier is never an operator's instructions.
 *   3. A resolve is never served from the 60s query cache — a screenshot of a
 *      just-admitted QR must not read LET THEM IN for the rest of the minute.
 *   4. A `REJECTED` admit (a 200, not a throw) must say something.
 *
 * ## Harness policy
 *
 * The REAL `@th/ui` + Tamagui stack, deliberately unmocked. Only the network
 * edge (`@/trpc`), the session and the router are replaced. Mocking the design
 * system away is how a component test renders the class of defect it is
 * supposed to catch as plain, passing DOM.
 */
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider } from "@th/ui";

import { UnifiedScanView } from "../UnifiedScanView";
import { SCAN_ACTION_LABELS } from "../scan-action-labels";

// ── Network edge ────────────────────────────────────────────────────────────

const net = vi.hoisted(() => ({
  resolveFetch: vi.fn(),
  scanTicket: vi.fn(),
  checkIn: vi.fn(),
  mintScanToken: vi.fn(),
  ownerRole: "OWNER" as string,
  captureException: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "dev-collective" }),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "hu_operator" } } }) },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => net.captureException(...args),
}));

vi.mock("@/trpc", () => {
  // Stable across renders so the callbacks that close over it are not rebuilt
  // on every paint (which is also how the real `useUtils` behaves).
  const utils = { scan: { resolvePayload: { fetch: net.resolveFetch } } };
  return {
    trpc: {
      useUtils: () => utils,
      events: {
        listEventOwnerEntities: {
          useQuery: () => ({
            data: {
              owners: [
                {
                  kind: "org",
                  orgId: "org_1",
                  orgName: "Dev Collective",
                  orgSlug: "dev-collective",
                  role: net.ownerRole,
                  avatarUrl: null,
                },
              ],
            },
            isLoading: false,
          }),
        },
        listMine: {
          useQuery: () => ({
            data: {
              items: [
                {
                  id: "ev_1",
                  title: "[STRIPE] SOMA Warehouse Rave",
                  startsAt: new Date("2099-01-01T00:00:00.000Z"),
                },
              ],
            },
            isLoading: false,
          }),
        },
      },
      scan: {
        searchUnified: {
          useQuery: () => ({ data: undefined, isFetching: false }),
        },
      },
      tickets: {
        scanTicket: {
          useMutation: () => ({
            mutateAsync: net.scanTicket,
            isPending: false,
          }),
        },
      },
      volunteer: {
        signups: {
          mintScanToken: {
            useMutation: () => ({
              mutateAsync: net.mintScanToken,
              isPending: false,
            }),
          },
          checkIn: {
            useMutation: () => ({ mutateAsync: net.checkIn, isPending: false }),
          },
        },
      },
    },
  };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Read from the shared table so a width fix cannot desync these matchers. */
const DISMISS_LABEL_RE = new RegExp(`^${SCAN_ACTION_LABELS.dismiss}$`, "i");
const CHECK_IN_LABEL_RE = new RegExp(`^${SCAN_ACTION_LABELS.checkIn}$`, "i");

const TICKET_CODE = "SEED-E00-002-0";

const validTicket = () => ({
  kind: "ticket" as const,
  ticketId: "tk_id",
  ticketCode: TICKET_CODE,
  status: "VALID" as const,
  scannedAt: null,
  holderHumanId: "hu_1",
  holderDisplay: "Mason L.",
  ticketTypeName: "General Admission",
  alsoVolunteering: [],
});

const render = (ui: ReactElement) =>
  rtlRender(<IthasFireProvider>{ui}</IthasFireProvider>);

/** Paste a payload and resolve it, the way the reproduction did. */
const pasteAndResolve = (raw: string) => {
  fireEvent.change(screen.getByLabelText("Paste a code"), {
    target: { value: raw },
  });
  fireEvent.click(screen.getByRole("button", { name: /^resolve$/i }));
};

const admit = () =>
  fireEvent.click(screen.getByRole("button", { name: /^admit$/i }));

beforeEach(() => {
  net.resolveFetch.mockReset();
  net.scanTicket.mockReset();
  net.checkIn.mockReset();
  net.mintScanToken.mockReset();
  net.captureException.mockReset();
  net.ownerRole = "OWNER";
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. The admit outcome wins ───────────────────────────────────────────────

describe("a successful admit", () => {
  it("keeps the admission on screen even if every later call fails", async () => {
    // THE blocker. The old code re-resolved after admitting, purely to repaint
    // the card; when that decorative call failed it replaced the confirmation
    // with a full-bleed fail verdict — for a person the server had already
    // let in.
    net.resolveFetch
      .mockResolvedValueOnce(validTicket())
      .mockRejectedValue(
        Object.assign(new Error("volunteer_scan_token_not_configured"), {
          data: { code: "INTERNAL_SERVER_ERROR" },
        }),
      );
    net.scanTicket.mockResolvedValue({
      outcome: "ACCEPTED",
      ticketId: "tk_id",
      eventId: "ev_1",
      ownerHumanId: "hu_1",
      scannedAt: new Date("2026-08-08T03:10:37.000Z"),
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");

    admit();

    await waitFor(() =>
      expect(screen.getByTestId("scan-tally-admitted")).toHaveTextContent("1"),
    );
    // The verdict confirms the admission…
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      /^ADMITTED/,
    );
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("DONE");
    // …and is emphatically NOT a failure.
    expect(screen.queryByText("NOT RECORDED")).toBeNull();
    expect(screen.queryByTestId("tone-result-ref")).toBeNull();
  });

  it("makes no round trip at all after admitting", async () => {
    // The strongest form of "the admit outcome wins": there is nothing left in
    // flight that COULD overwrite it.
    net.resolveFetch.mockResolvedValue(validTicket());
    net.scanTicket.mockResolvedValue({
      outcome: "ACCEPTED",
      scannedAt: new Date("2026-08-08T03:10:37.000Z"),
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");
    expect(net.resolveFetch).toHaveBeenCalledTimes(1);

    admit();
    await waitFor(() =>
      expect(screen.getByTestId("scan-tally-admitted")).toHaveTextContent("1"),
    );
    expect(net.resolveFetch).toHaveBeenCalledTimes(1);
  });

  it("counts one admission however many times ADMIT is tapped", async () => {
    net.resolveFetch.mockResolvedValue(validTicket());
    net.scanTicket.mockResolvedValue({
      outcome: "ACCEPTED",
      scannedAt: new Date("2026-08-08T03:10:37.000Z"),
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");

    // A double tap: `scanTicket`'s 10s idempotency window replays the cached
    // ACCEPTED, and the tally used to increment for each replay.
    admit();
    admit();

    await waitFor(() =>
      expect(screen.getByTestId("scan-tally-admitted")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("scan-tally-admitted")).not.toHaveTextContent("2");
  });

  it("mints a fresh idempotency key per card, not one per session", async () => {
    net.resolveFetch.mockResolvedValue(validTicket());
    net.scanTicket.mockResolvedValue({
      outcome: "ACCEPTED",
      scannedAt: new Date(),
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");
    admit();
    await waitFor(() => expect(net.scanTicket).toHaveBeenCalledTimes(1));
    const first = net.scanTicket.mock.calls[0]![0].clientKey;

    fireEvent.click(
      screen.getByRole("button", { name: DISMISS_LABEL_RE }),
    );
    net.resolveFetch.mockResolvedValue({
      ...validTicket(),
      ticketCode: "SEED-E00-003-0",
    });
    pasteAndResolve("SEED-E00-003-0");
    await screen.findByText("LET THEM IN");
    admit();
    await waitFor(() => expect(net.scanTicket).toHaveBeenCalledTimes(2));

    // A session-constant key made two different tickets inside one 10s window
    // collide on one idempotency record with different payloads.
    expect(net.scanTicket.mock.calls[1]![0].clientKey).not.toBe(first);
  });
});

// ── The verdict announces exactly ONCE ──────────────────────────────────────

describe("screen-reader announcement", () => {
  it("has exactly one live region on the page, and it is the verdict", async () => {
    /**
     * DS D-125: the verdict is the one sanctioned `role="alert"` +
     * `aria-live="assertive"` in the system. The page used to carry a SECOND,
     * polite `role="status"` span mirroring the same composed text — running
     * both reads every verdict twice, and double-announcing was already fixed
     * here once, in the other direction.
     *
     * `getAllByRole("alert")` would not catch a reintroduced `role="status"`
     * span, so this queries live regions by attribute instead.
     */
    net.resolveFetch.mockResolvedValue(validTicket());
    const { container } = render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");

    const live = [...container.querySelectorAll("[aria-live]")];
    expect(
      live.map((n) => `${n.getAttribute("role")}/${n.getAttribute("aria-live")}`),
    ).toEqual(["alert/assertive"]);
    // …and it is the verdict itself, not a mirror of it.
    expect(live[0]).toHaveTextContent("VALID");
    expect(live[0]).toHaveTextContent("LET THEM IN");
    expect(live[0]).toHaveTextContent("Mason L.");
  });

  it("mounts no live region at all before the first scan", async () => {
    // A region that appears with its content is unreliable on some screen
    // readers, which is why the old build kept an always-mounted span. The DS
    // answer is different: `role="alert"` is announced ON INSERTION, which is
    // exactly the behaviour wanted at a door.
    const { container } = render(<UnifiedScanView />);
    await screen.findByLabelText("Paste a code");
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
  });
});

// ── ADMITTED vs ALREADY USED, end to end ────────────────────────────────────

/**
 * The pair the coordinator asked to be pinned: the same ticket status, reached
 * two ways, must not look the same. Asserted through the REAL component and the
 * real design system, because the whole defect was that one code path fed the
 * other's presentation.
 */
describe("the two ways a ticket becomes SCANNED", () => {
  it("admitting shows the PASS confirmation — ADMITTED / DONE", async () => {
    net.resolveFetch.mockResolvedValue(validTicket());
    net.scanTicket.mockResolvedValue({
      outcome: "ACCEPTED",
      scannedAt: new Date("2026-08-08T03:10:37.000Z"),
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");
    admit();

    expect(await screen.findByText("DONE")).toBeInTheDocument();
    expect(screen.getByTestId("tone-result-state-line")).toHaveTextContent(
      /^ADMITTED/,
    );
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      /^Admitted at /,
    );
    // The holder is still on screen — the operator has to be able to confirm
    // they admitted the right person.
    expect(screen.getByTestId("tone-result-name")).toHaveTextContent("Mason L.");
    expect(screen.queryByText(/^ALREADY USED/)).toBeNull();
  });

  it("presenting an already-used pass still shows the FAIL warning", async () => {
    // The case ALREADY USED exists for, and it must stay reachable.
    net.resolveFetch.mockResolvedValue({
      ...validTicket(),
      status: "SCANNED",
      scannedAt: new Date("2026-08-08T02:00:00.000Z"),
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);

    expect(
      await screen.findByText(/^ALREADY USED/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("STOP");
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      /already admitted/i,
    );
    expect(screen.queryByText("DONE")).toBeNull();
    // Nobody new walked in; the repeat is what gets counted.
    expect(screen.getByTestId("scan-tally-admitted")).toHaveTextContent("0");
    expect(screen.getByTestId("scan-tally-already-in")).toHaveTextContent("1");
  });

  it("a REPLAY admit is ALREADY USED, not a confirmation", async () => {
    // The server is telling us the ticket was ALREADY scanned. Painting that
    // green would be the same lie in the other direction.
    net.resolveFetch.mockResolvedValue(validTicket());
    net.scanTicket.mockResolvedValue({
      outcome: "REPLAY",
      scannedAt: new Date("2026-08-08T03:10:37.000Z"),
      previousScannedAt: new Date("2026-08-08T02:00:00.000Z"),
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");
    admit();

    expect(await screen.findByText(/^ALREADY USED/)).toBeInTheDocument();
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("STOP");
    expect(screen.getByTestId("scan-tally-admitted")).toHaveTextContent("0");
  });

  it("dismissing clears the confirmation before the NEXT person", async () => {
    /**
     * `admitted` is card-scoped: the next pass presented must not inherit a
     * confirmed ADMITTED that nobody admitted.
     *
     * Honest scope, checked by planting: `showCard` and `clearCard` BOTH reset
     * the flag on this path, so removing either one alone leaves this green —
     * it goes red only when neither does. That is the invariant worth pinning
     * (the flag is retired *somewhere* between two people); the belt-and-braces
     * second reset is documented in `showCard` as deliberate redundancy rather
     * than as something this test proves.
     */
    net.resolveFetch.mockResolvedValue(validTicket());
    net.scanTicket.mockResolvedValue({
      outcome: "ACCEPTED",
      scannedAt: new Date("2026-08-08T03:10:37.000Z"),
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");
    admit();
    await screen.findByText("DONE");

    fireEvent.click(screen.getByRole("button", { name: DISMISS_LABEL_RE }));
    net.resolveFetch.mockResolvedValue({
      ...validTicket(),
      ticketCode: "SEED-E00-003-0",
      status: "SCANNED",
      scannedAt: new Date("2026-08-08T02:00:00.000Z"),
    });
    pasteAndResolve("SEED-E00-003-0");

    expect(await screen.findByText(/^ALREADY USED/)).toBeInTheDocument();
    expect(screen.queryByText("DONE")).toBeNull();
  });
});

// ── 2. No raw codes ─────────────────────────────────────────────────────────

describe("a failed round trip", () => {
  it("never shows the server's identifier as the operator's guidance", async () => {
    net.resolveFetch.mockRejectedValue(
      Object.assign(new Error("volunteer_scan_token_not_configured"), {
        data: { code: "INTERNAL_SERVER_ERROR" },
      }),
    );

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);

    const guidance = await screen.findByTestId("tone-result-detail-line");
    expect(guidance.textContent ?? "").not.toContain(
      "volunteer_scan_token_not_configured",
    );
    expect(guidance).toHaveTextContent(/try again|dismiss and use Search/i);
    // It survives as a labelled support reference.
    expect(screen.getByTestId("tone-result-ref")).toHaveTextContent(
      "volunteer_scan_token_not_configured",
    );
  });

  it("still reports to Sentry, which silencing the toast would otherwise skip", async () => {
    // `GlobalQueryErrorLogger` returns on `meta.silent` BEFORE its capture, so
    // silencing the duplicate toast without capturing here would have
    // un-Sentried the whole scan surface.
    net.resolveFetch.mockRejectedValue(new Error("boom"));
    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByTestId("tone-result-detail-line");
    expect(net.captureException).toHaveBeenCalled();
  });
});

// ── 3. Never from cache ─────────────────────────────────────────────────────

describe("resolver caching", () => {
  it("opts out of the 60s query default on every resolve", async () => {
    // `makeQueryClient` sets `staleTime: 60_000` for all queries and
    // `utils.*.fetch` merges those defaults, so the same payload inside a
    // minute never reached the server: a screenshot of a just-admitted QR read
    // a pass verdict, with a live Admit button, for the rest of that minute.
    net.resolveFetch.mockResolvedValue(validTicket());
    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");

    expect(net.resolveFetch).toHaveBeenCalledWith(
      { eventId: "ev_1", raw: TICKET_CODE },
      expect.objectContaining({ staleTime: 0, gcTime: 0 }),
    );
  });

  it("hits the server again for the SAME payload seconds later", async () => {
    net.resolveFetch.mockResolvedValue(validTicket());
    render(<UnifiedScanView />);

    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));

    pasteAndResolve(TICKET_CODE);
    await waitFor(() => expect(net.resolveFetch).toHaveBeenCalledTimes(2));
  });
});

// ── 4. REJECTED is not silence ──────────────────────────────────────────────

describe("an admit the server REJECTED", () => {
  it("renders a verdict instead of doing nothing at all", async () => {
    // `scanTicket` enforces the event's check-in window; `resolveScanPayload`
    // does not. The card therefore reads a pass VALID and every tap on ADMIT
    // used to change precisely nothing — no message, no tally, button
    // re-enabled — forever.
    net.resolveFetch.mockResolvedValue(validTicket());
    net.scanTicket.mockResolvedValue({
      outcome: "REJECTED",
      reason: "event_not_active",
    });

    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");
    admit();

    expect(await screen.findByText("DOORS NOT OPEN")).toBeInTheDocument();
    // HOLD, never STOP — nothing is wrong with the person.
    expect(screen.getByTestId("tone-result-word")).toHaveTextContent("HOLD");
    expect(screen.getByTestId("tone-result-detail-line")).toHaveTextContent(
      /check-in/i,
    );
    // Nobody was admitted, so nothing is counted.
    expect(screen.getByTestId("scan-tally-admitted")).toHaveTextContent("0");
    expect(screen.queryByRole("button", { name: /^admit$/i })).toBeNull();
  });
});

// ── Focus after dismiss ─────────────────────────────────────────────────────

describe("dismissing a verdict", () => {
  it("gives the keyboard somewhere to land", async () => {
    // The page chrome does not exist while a verdict is up, so on dismiss the
    // browser drops focus to <body> and a keyboard operator traverses the whole
    // admin shell again — between every single scan.
    net.resolveFetch.mockResolvedValue(validTicket());
    render(<UnifiedScanView />);
    pasteAndResolve(TICKET_CODE);
    await screen.findByText("LET THEM IN");

    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Paste a code")),
    );
  });
});

// ── Role gate ───────────────────────────────────────────────────────────────

describe("volunteer check-in role gate", () => {
  it("locks check-in for a SCANNER-role operator", async () => {
    // This was a KIND check (`owner.kind === "org"`), true for every role, so
    // the design's "this is the action and it is not yours" state could never
    // render and a scanner-only operator tapped a live button into a 403.
    net.ownerRole = "SCANNER";
    net.resolveFetch.mockResolvedValue({
      kind: "volunteer",
      humanId: "hu_1",
      displayName: "Mason L.",
      candidates: [
        {
          signupId: "sg_1",
          humanId: "hu_1",
          humanDisplayName: "Mason L.",
          humanContactMasked: "m•••@example.com",
          eventId: "ev_1",
          eventTitle: "[STRIPE] SOMA Warehouse Rave",
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
        },
      ],
      alsoHoldsTicket: [],
    });

    render(<UnifiedScanView />);
    pasteAndResolve("volunteer-jwt-payload");

    const button = await screen.findByRole("button", {
      name: CHECK_IN_LABEL_RE,
    });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(/edit role required to check in volunteers/i),
    ).toBeInTheDocument();
  });
});
