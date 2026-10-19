import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { NativeThemeProvider } from "@th/ui-native";

import type { ScannerSessionContext } from "../../src/features/auth/use-scanner-session";
import type { NetworkState } from "../../src/features/network/network-state";
import {
  __setFeedbackChannelsForTests,
  setFeedbackPrefs,
} from "../../src/lib/feedback";
import {
  FEEDBACK_KINDS,
  FEEDBACK_SIGNATURES,
  type FeedbackKind,
} from "../../src/lib/feedback-signatures";
import type { PeopleSearchResult } from "../../src/lib/use-people-search";
import type { TicketResult } from "../../src/lib/scan-result-types";
import { UnifiedScanScreen } from "../../src/screens/unified-scan-screen";
import { camera, resetCamera } from "../stubs/expo-camera";
import { announcements as announced } from "../stubs/react-native";
import { captureException } from "../stubs/sentry";
import {
  networkStore,
  peopleStore,
  screenReaderStore,
} from "./fake-device-hooks";
import { device, type FakeTicket } from "./fake-local-db";
import {
  server,
  type AdmitInput,
  type AdmitResponse,
  type Endpoint,
  type LookupInput,
} from "./fake-server";

/**
 * # Scan-screen harness
 *
 * Renders the REAL `UnifiedScanScreen` in jsdom and hands the test the four
 * things a door scenario is made of:
 *
 *   - the CAMERA — `scan(code)`;
 *   - the SERVER — `lookup` / `admit` / `revert`, each call a deferred the
 *     test settles by hand, in any order;
 *   - the CLOCK — `advance(ms)` (vitest fake timers; `Date` is faked too);
 *   - the DEVICE — `device` (in-memory SQLite with a failure switch),
 *     `setNetwork`, `setScreenReader`, the people index.
 *
 * And reads back only what the OPERATOR gets: `verdict()` / `screenText()`,
 * `railNotice()`, `recentRow(name)`, `haptics()`, `sounds()`,
 * `announcements()`, plus `reports()` (the Sentry branch tags) for the
 * things nobody at the door sees but somebody must.
 *
 * Every call that can change the screen is `act`-wrapped and drains pending
 * promise callbacks before returning, so an assertion on the next line sees
 * the committed result.
 *
 * ## Two things that are easy to get wrong
 *
 * - The recent-scans strip POLLS the store every 1000ms (as on the device). A
 *   row write is not on screen until the next tick: `await h.advance(1000)`
 *   before `recentRow`, and remember that tick also moves any express dwell.
 * - `scan()` throws if the camera is paused. That is the point: the screen
 *   withholds the barcode callback while a verdict is up, so a scan the
 *   operator cannot make is a scan the test cannot make either.
 */

export const EVENT_ID = "11111111-1111-4111-8111-111111111111";
export const EVENT_NAME = "Friday Night Show";
/** Fixed wall clock for every test. */
export const NOW = new Date("2026-10-06T21:00:00.000Z");

// ── Feedback capture ────────────────────────────────────────────────────────

type Cue = { channel: "haptic" | "tone"; kind: FeedbackKind | "unknown" };
const cues: Cue[] = [];

/** Map a played haptic pattern back to its signature, by identity. */
const hapticKind = (pattern: unknown): FeedbackKind | "unknown" =>
  FEEDBACK_KINDS.find((k) => FEEDBACK_SIGNATURES[k].haptic === pattern) ??
  "unknown";

export function resetHarness(): void {
  device.reset();
  server.reset();
  networkStore.reset();
  screenReaderStore.reset();
  peopleStore.reset();
  announced.length = 0;
  cues.length = 0;
  captureException.mockClear();
  resetCamera();
  setFeedbackPrefs({ soundEnabled: true, hapticsEnabled: true });
  __setFeedbackChannelsForTests({
    playTone: async (tone) => {
      cues.push({ channel: "tone", kind: tone });
    },
    playHaptic: async (pattern) => {
      cues.push({ channel: "haptic", kind: hapticKind(pattern) });
    },
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** What `scan.resolvePayload` answers for a ticket. */
export const ticket = (
  code: string,
  holderDisplay: string,
  overrides: Partial<TicketResult> = {},
): TicketResult => ({
  kind: "ticket",
  ticketId: `tid-${code}`,
  ticketCode: code,
  status: "VALID",
  scannedAt: null,
  holderHumanId: `h-${code}`,
  holderDisplay,
  ticketTypeName: "General admission",
  alsoVolunteering: [],
  ...overrides,
});

/** A search row for an attendee holding `code`. */
export const attendeeRow = (
  code: string,
  displayName: string,
): PeopleSearchResult => ({
  kind: "attendee",
  humanId: `h-${code}`,
  displayName,
  email: null,
  ticket: {
    ticketId: `tid-${code}`,
    ticketCode: code,
    status: "VALID",
    eventId: EVENT_ID,
    eventTitle: EVENT_NAME,
    ticketTypeName: "General admission",
    ownerHumanId: `h-${code}`,
    ownerName: displayName,
    ownerEmail: null,
    issuedAt: NOW,
    scannedAt: null,
    seatLabel: null,
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Let promise chains (mutateAsync → .then → feedback …) run to completion. */
const drain = async () => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

/** Visible text of an element, one space between text nodes. */
const textOf = (el: Element | null): string => {
  if (!el) return "";
  const parts: string[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t) parts.push(t);
  }
  return parts.join(" ");
};

const byTestId = (id: string, root: ParentNode = document) =>
  root.querySelector(`[data-testid="${id}"]`);

/** Every full-bleed or inline verdict on screen right now. */
const VERDICT_SELECTOR = [
  '[data-testid="unified-scan-error"]',
  '[data-testid^="scan-result-kind-"]',
  '[data-testid="unified-search-refusal"]',
].join(", ");

export type Verdict = {
  /** Which surface: the camera's error/result layer or the search card. */
  testId: string;
  state: string;
  word: string;
  name: string;
  detail: string;
  /** Everything visible inside the verdict, for loose matching. */
  text: string;
};

type Match<I> = string | ((input: I) => boolean);

type Settler<I, O> = {
  /** Settle the oldest pending call (or the oldest matching `match`). */
  resolve: (value: O, match?: Match<I>) => Promise<void>;
  reject: (error: unknown, match?: Match<I>) => Promise<void>;
  /** Inputs of calls still in flight, oldest first. */
  pending: () => I[];
  /** Inputs of every call made, oldest first. */
  calls: () => I[];
};

const settler = <I, O>(
  endpoint: Endpoint<I, O>,
  byString: (input: I, s: string) => boolean,
): Settler<I, O> => {
  const pick = (match?: Match<I>) =>
    endpoint.take(
      match === undefined
        ? undefined
        : typeof match === "string"
          ? (input) => byString(input, match)
          : match,
    );
  return {
    resolve: async (value, match) => {
      const call = pick(match);
      await act(async () => {
        call.resolve(value);
        await drain();
      });
    },
    reject: async (error, match) => {
      const call = pick(match);
      await act(async () => {
        call.reject(error);
        await drain();
      });
    },
    pending: () => endpoint.pending().map((c) => c.input),
    calls: () => endpoint.calls.map((c) => c.input),
  };
};

// ── Render ──────────────────────────────────────────────────────────────────

export type RenderScanScreenOptions = {
  express?: boolean;
  network?: NetworkState;
  screenReader?: boolean;
  /** Synced manifest rows (the offline path and same-order lookups read these). */
  manifest?: FakeTicket[];
  /** People index rows the manual search returns. */
  people?: PeopleSearchResult[];
  role?: string;
};

export function renderScanScreen(opts: RenderScanScreenOptions = {}) {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  vi.setSystemTime(NOW);

  networkStore.set(opts.network ?? "online");
  screenReaderStore.set(opts.screenReader ?? false);
  peopleStore.set(opts.people ?? []);
  if (opts.manifest) device.seedTickets(EVENT_ID, opts.manifest);

  const sessionContext = {
    operator: { humanId: "op-1", displayName: "Door Op", email: "op@example.com" },
    orgs: [{ orgId: "org-1", orgName: "Org", role: "ADMIN" }],
    currentEvent: {
      eventId: EVENT_ID,
      orgId: "org-1",
      eventName: EVENT_NAME,
      role: opts.role ?? "ADMIN",
      startAt: null,
      endAt: null,
      status: "PUBLISHED",
    },
  } as unknown as ScannerSessionContext;

  render(
    <NativeThemeProvider enabledThemes={["stub"]} defaultTheme="stub">
      <UnifiedScanScreen
        eventId={EVENT_ID}
        eventName={EVENT_NAME}
        sessionContext={sessionContext}
        expressModeEnabled={opts.express ?? false}
        onBack={() => {}}
      />
    </NativeThemeProvider>,
  );

  const verdicts = (): Verdict[] =>
    Array.from(document.querySelectorAll(VERDICT_SELECTOR)).map((el) => ({
      testId: el.getAttribute("data-testid") ?? "",
      state: textOf(byTestId("tone-result-state-line", el)),
      word: textOf(byTestId("tone-result-word", el)),
      name: textOf(byTestId("tone-result-who", el)),
      detail: textOf(byTestId("tone-result-detail-line", el)),
      text: textOf(el),
    }));

  const h = {
    // ── camera ──
    /** Is the camera live and accepting a barcode? */
    cameraArmed: () => !!camera.onBarcodeScanned,
    scan: async (raw: string) => {
      const fire = camera.onBarcodeScanned;
      if (!fire) {
        throw new Error(
          `scan(${raw}): the camera is paused — a verdict is on screen or a resolve is in flight`,
        );
      }
      await act(async () => {
        fire({ data: raw, type: "qr" });
        await drain();
      });
    },

    // ── server ──
    lookup: settler<LookupInput, unknown>(server.lookup, (i, s) => i.raw === s),
    admit: settler<AdmitInput, AdmitResponse>(
      server.admit,
      (i, s) => i.ticketCode === s,
    ),
    revert: settler<{ ticketId: string }, unknown>(
      server.revert,
      (i, s) => i.ticketId === s,
    ),

    // ── clock ──
    advance: async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
        await drain();
      });
    },

    // ── device ──
    device,
    setNetwork: async (next: NetworkState) => {
      await act(async () => {
        networkStore.set(next);
        await drain();
      });
    },
    setScreenReader: async (on: boolean) => {
      await act(async () => {
        screenReaderStore.set(on);
        await drain();
      });
    },

    // ── operator input ──
    /**
     * Press the ONE button whose accessible name is `name` (exact string, or
     * a RegExp). Throws when it is missing, ambiguous, or disabled: an
     * operator cannot press a disabled control, and two controls with the
     * same name is a defect in itself.
     */
    tap: async (name: string | RegExp) => {
      const button = screen.getByRole("button", { name });
      if (
        button.hasAttribute("disabled") ||
        button.getAttribute("aria-disabled") === "true"
      ) {
        throw new Error(`tap(${String(name)}): the button is disabled`);
      }
      await act(async () => {
        fireEvent.click(button);
        await drain();
      });
    },
    /** Is there an enabled button with this name? */
    canTap: (name: string | RegExp): boolean => {
      const button = screen.queryByRole("button", { name });
      return (
        !!button &&
        !button.hasAttribute("disabled") &&
        button.getAttribute("aria-disabled") !== "true"
      );
    },
    /** Type into the manual search box (search mode must be open). */
    search: async (query: string) => {
      const input = byTestId("unified-search-input") as HTMLInputElement | null;
      if (!input) throw new Error("search(): the search screen is not open");
      await act(async () => {
        fireEvent.change(input, { target: { value: query } });
        await drain();
      });
    },
    /** Press the search result row for this person. */
    pickResult: async (displayName: string) => {
      const row = Array.from(
        document.querySelectorAll('[data-testid^="unified-search-row-"]'),
      ).find((el) => textOf(el).includes(displayName));
      if (!row) throw new Error(`pickResult(${displayName}): no such row`);
      await act(async () => {
        fireEvent.click(row);
        await drain();
      });
    },
    inSearch: () => !!byTestId("unified-search-screen"),

    // ── what the operator sees ──
    /** Every verdict on screen (should never be more than one). */
    verdicts,
    /** THE verdict on screen, or null. Throws if two are up at once. */
    verdict: (): Verdict | null => {
      const all = verdicts();
      if (all.length > 1) {
        throw new Error(
          `two verdicts on screen at once: ${all.map((v) => v.testId).join(", ")}`,
        );
      }
      return all[0] ?? null;
    },
    /** Visible text of the verdict layer ("" when the camera is clear). */
    screenText: (): string => verdicts().map((v) => v.text).join(" | "),
    /** The late-refusal notice (camera rail or search), or null. */
    railNotice: (): string | null => {
      const el =
        byTestId("unified-scan-late-refusal") ??
        byTestId("unified-search-late-refusal");
      return el ? textOf(el) : null;
    },
    undoNotice: (): string | null => {
      const el = byTestId("unified-scan-undo-notice");
      return el ? textOf(el) : null;
    },
    /**
     * The recent-scans row showing `label` (holder name, or code when the row
     * has no name), as the operator reads it. Null when no such row is shown.
     * The strip polls every 1000ms — see the header.
     */
    recentRow: (label: string) => {
      const strip = byTestId("recent-scans-strip");
      if (!strip) return null;
      const nameSpan = Array.from(strip.querySelectorAll("span")).find(
        (s) => s.textContent?.trim() === label,
      );
      if (!nameSpan) return null;
      let group: Element | null = nameSpan;
      while (group && group.parentElement?.parentElement !== strip) {
        group = group.parentElement;
      }
      if (!group) return null;
      const refused = group.querySelector('[data-testid^="refused-scan-"]');
      const undo = group.querySelector('[data-testid^="undo-scan-"]');
      const text = textOf(group);
      return {
        text,
        /** e.g. "NOT ADMITTED · Doors not open", or null when admitted. */
        refused: refused ? textOf(refused) : null,
        /** The undo control's visible text ("UNDO 29s"), or null when none. */
        undo: undo ? textOf(undo) : null,
        queued: text.includes("· queued"),
      };
    },

    // ── what the operator feels and hears ──
    haptics: (): Array<FeedbackKind | "unknown"> =>
      cues.filter((c) => c.channel === "haptic").map((c) => c.kind),
    sounds: (): Array<FeedbackKind | "unknown"> =>
      cues.filter((c) => c.channel === "tone").map((c) => c.kind),
    announcements: (): string[] => [...announced],
    /** Sentry `branch` tags reported so far, in order. */
    reports: (): string[] =>
      captureException.mock.calls.map(
        (call) =>
          ((call[1] as { tags?: { branch?: string } } | undefined)?.tags
            ?.branch ?? "(no branch)") as string,
      ),
    /**
     * Forget the cues, announcements and reports so far, so the assertions
     * that follow are about what happens NEXT.
     */
    observeFromHere: () => {
      cues.length = 0;
      announced.length = 0;
      captureException.mockClear();
    },
  };
  return h;
}

export type ScanHarness = ReturnType<typeof renderScanScreen>;
