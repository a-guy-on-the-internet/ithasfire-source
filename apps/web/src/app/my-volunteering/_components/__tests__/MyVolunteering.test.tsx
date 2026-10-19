import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";

import enApp from "@/i18n/messages/en";

/**
 * `/my-volunteering` rows whose ask owner is withheld (`signupsPaused`): the
 * row says sign-ups are paused, never why, and never links to the ask's
 * `/v/` page (it 404s). Claimed shifts keep their date and time. Copy is the
 * SHIPPED en catalog, so a key typo fails here instead of rendering raw.
 *
 * What jsdom cannot see: layout at 320px or the Tamagui theme. Those need the
 * real app.
 */

const commitmentsQuery = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

const sms = vi.hoisted(() => ({
  gates: undefined as { sms?: boolean } | undefined,
  mutate: vi.fn(),
  invalidate: vi.fn(),
  prefsOptions: undefined as
    | {
        onSuccess?: (
          data: { smsMayNeedStart: boolean },
          variables: { signupId: string; smsOptIn: boolean },
        ) => void;
        onError?: (err: unknown) => void;
        onSettled?: () => void;
      }
    | undefined,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      volunteer: {
        signups: { listMyCommitments: { invalidate: sms.invalidate } },
      },
    }),
    volunteer: {
      signups: {
        listMyCommitments: { useQuery: () => commitmentsQuery.current },
        updateContactPrefs: {
          useMutation: (options: typeof sms.prefsOptions) => {
            sms.prefsOptions = options;
            return { mutate: sms.mutate, isPending: false };
          },
        },
      },
    },
  },
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: sms.gates, isLoading: false }),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      isPending: false,
      data: { user: { name: "Liam Nguyen", email: "liam@example.com" } },
    }),
  },
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/useDelayedFlag", () => ({
  useDelayedFlag: (flag: boolean) => flag,
}));

import { MyVolunteering } from "../MyVolunteering";

const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }
  return result as Messages;
};

const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

const renderPage = () =>
  render(
    <IthasFireProvider>
      <TranslationProvider locale="en" messages={messages}>
        <MyVolunteering />
      </TranslationProvider>
    </IthasFireProvider>,
  );

type Row = Record<string, unknown>;

/** A claimed date of a standing ask: ask-path, no event to link to. */
const askRow = (over: Row & { signupId: string; claimId: string }): Row => ({
  status: "APPROVED",
  source: "ASK_WINDOW",
  occurrenceId: `occ-${over.claimId}`,
  cadence: "RECURRING",
  signupsPaused: false,
  title: "Thursday Door Crew",
  roleName: "Door",
  shiftLabel: null,
  startsAt: new Date("2030-06-06T23:00:00Z"),
  endsAt: new Date("2030-06-07T03:00:00Z"),
  eventId: null,
  eventSlug: null,
  eventTimezone: null,
  addressText: null,
  askId: "ask-live",
  hoursWorked: null,
  hoursCredited: null,
  checkedInAt: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  smsOptIn: false,
  hasContactPhone: false,
  textRemindersOffered: false,
  reminderAnchor: null,
  ...over,
});

const PAUSED_TITLE = "Shift sign-ups are paused";
const PAUSED_BODY =
  "The organiser can't take new volunteers right now. Shifts you already claimed still stand.";

const setRows = (rows: Row[]) => {
  commitmentsQuery.current = { data: rows, isLoading: false, error: null };
};

const askLinks = (scope: HTMLElement) =>
  Array.from(scope.querySelectorAll("a")).filter((a) =>
    (a.getAttribute("href") ?? "").startsWith("/v/"),
  );

describe("MyVolunteering — paused sign-ups", () => {
  beforeEach(() => {
    setRows([]);
  });

  it("a paused list row shows the note, keeps its date, and has no /v/ link", () => {
    setRows([
      // Soonest → "Next up" hero; the paused row is the later one.
      askRow({ signupId: "s-live", claimId: "c-live" }),
      askRow({
        signupId: "s-paused",
        claimId: "c-paused",
        title: "Saturday Bar Crew",
        askId: "ask-paused",
        signupsPaused: true,
        startsAt: new Date("2030-07-06T15:00:00Z"),
        endsAt: new Date("2030-07-06T18:00:00Z"),
      }),
    ]);
    renderPage();

    const paused = screen.getByTestId("commitment-row-c-paused");
    within(paused).getByText("Saturday Bar Crew");
    within(paused).getByText(PAUSED_TITLE);
    within(paused).getByText(PAUSED_BODY);
    expect(askLinks(document.body).map((a) => a.getAttribute("href"))).toEqual(
      ["/v/ask-live"],
    );
    // The paused row is not inside any anchor.
    expect(paused.closest("a")).toBeNull();
    // Claimed shift still shows its date line, not the windowless fallback.
    expect(within(paused).queryByText("No set shift time")).toBeNull();
    expect(within(paused).getByText(/2030|Jul/)).toBeTruthy();
  });

  it("a paused Next up hero shows the note and has no /v/ link", () => {
    setRows([
      askRow({
        signupId: "s-paused",
        claimId: "c-paused",
        askId: "ask-paused",
        signupsPaused: true,
      }),
    ]);
    renderPage();

    const hero = screen.getByTestId("commitment-next-up-c-paused");
    within(hero).getByText(PAUSED_TITLE);
    within(hero).getByText(PAUSED_BODY);
    expect(hero.closest("a")).toBeNull();
    expect(askLinks(document.body)).toHaveLength(0);
  });

  it("a paused WITHDRAWN History row shows no note and stays unlinked", () => {
    setRows([
      askRow({ signupId: "s-a", claimId: "c-a" }),
      askRow({
        signupId: "s-w",
        claimId: "c-w",
        askId: "ask-w",
        status: "WITHDRAWN",
        signupsPaused: true,
      }),
    ]);
    renderPage();

    const row = screen.getByTestId("commitment-row-c-w");
    expect(within(row).queryByText(PAUSED_TITLE)).toBeNull();
    expect(row.closest("a")).toBeNull();
    expect(screen.queryByTestId("commitment-signups-paused")).toBeNull();
  });

  it("a paused PENDING row shows no note and stays unlinked", () => {
    setRows([
      askRow({ signupId: "s-a", claimId: "c-a" }),
      askRow({
        signupId: "s-p",
        claimId: "c-p",
        askId: "ask-p",
        status: "PENDING",
        signupsPaused: true,
      }),
    ]);
    renderPage();

    const row = screen.getByTestId("commitment-row-c-p");
    expect(within(row).queryByText(PAUSED_TITLE)).toBeNull();
    expect(row.closest("a")).toBeNull();
    expect(screen.queryByTestId("commitment-signups-paused")).toBeNull();
  });

  it("a non-paused row is unchanged: linked to /v/, no note", () => {
    setRows([
      askRow({ signupId: "s-a", claimId: "c-a" }),
      askRow({
        signupId: "s-b",
        claimId: "c-b",
        askId: "ask-b",
        startsAt: new Date("2030-07-06T23:00:00Z"),
        endsAt: new Date("2030-07-07T03:00:00Z"),
      }),
    ]);
    renderPage();

    const row = screen.getByTestId("commitment-row-c-b");
    expect(row.closest("a")?.getAttribute("href")).toBe("/v/ask-b");
    expect(screen.queryByText(PAUSED_TITLE)).toBeNull();
    expect(screen.queryByTestId("commitment-signups-paused")).toBeNull();
  });
});

/** A signup on a one-time ask with a start: no occurrence, reminded. */
const oneTimeAskRow = (over: Row & { signupId: string }): Row =>
  askRow({
    claimId: null as unknown as string,
    occurrenceId: null,
    cadence: "ONE_TIME",
    textRemindersOffered: true,
    reminderAnchor: "ASK_START",
    hasContactPhone: true,
    ...over,
  });

const TEXTS_LABEL = "Text me reminders before it starts";
const STOP_HINT = "Reply STOP to any reminder text to opt out everywhere.";
const START_HINT =
  "If this number ever replied STOP, reply START from that phone to get texts again.";

describe("MyVolunteering — texts switch", () => {
  beforeEach(() => {
    sms.gates = { sms: true };
    sms.mutate.mockReset();
    sms.invalidate.mockReset();
    setRows([]);
  });

  it("shows the switch on a reminded ask row with a phone and SMS on, outside the row's link", () => {
    setRows([oneTimeAskRow({ signupId: "s-1" })]);
    renderPage();

    const box = screen.getByRole("checkbox", { name: TEXTS_LABEL });
    expect(box.closest("a")).toBeNull();
    expect(screen.getByText(STOP_HINT)).toBeTruthy();
    // The row itself still links to the ask.
    expect(askLinks(document.body).map((a) => a.getAttribute("href"))).toEqual(
      ["/v/ask-live"],
    );
  });

  for (const [label, over, gates] of [
    ["not offered", { textRemindersOffered: false }, { sms: true }],
    ["no phone", { hasContactPhone: false }, { sms: true }],
    ["SMS gate off", {}, { sms: false }],
    ["gates unknown", {}, undefined],
  ] as const) {
    it(`hides the switch on an OFF row (${label})`, () => {
      sms.gates = gates;
      setRows([oneTimeAskRow({ signupId: "s-1", ...over })]);
      renderPage();

      expect(screen.queryByRole("checkbox", { name: TEXTS_LABEL })).toBeNull();
      expect(screen.queryByTestId("commitment-sms-s-1")).toBeNull();
    });
  }

  it("keeps an ON row's switch when not offered, revoke-only", () => {
    setRows([
      oneTimeAskRow({
        signupId: "s-1",
        smsOptIn: true,
        textRemindersOffered: false,
        reminderAnchor: null,
      }),
    ]);
    renderPage();

    const box = screen.getByRole("checkbox", { name: TEXTS_LABEL });
    // Revoke-only: no STOP caption, and switching off goes through.
    expect(screen.queryByText(STOP_HINT)).toBeNull();
    fireEvent.click(box);
    expect(sms.mutate).toHaveBeenCalledWith({
      signupId: "s-1",
      smsOptIn: false,
    });
  });

  it("toggling calls the mutation with the signup id and never navigates", () => {
    setRows([oneTimeAskRow({ signupId: "s-1" })]);
    renderPage();

    const box = screen.getByRole("checkbox", { name: TEXTS_LABEL });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    box.dispatchEvent(click);

    expect(sms.mutate).toHaveBeenCalledTimes(1);
    expect(sms.mutate).toHaveBeenCalledWith({ signupId: "s-1", smsOptIn: true });
    // No anchor between the control and the document: nothing to follow.
    expect(box.closest("a")).toBeNull();
    act(() => sms.prefsOptions?.onSettled?.());
    expect(sms.invalidate).toHaveBeenCalledTimes(1);
  });

  it("shows the START hint when switching on returns it", () => {
    setRows([oneTimeAskRow({ signupId: "s-1", smsOptIn: true })]);
    renderPage();
    expect(screen.getByText(STOP_HINT)).toBeTruthy();

    act(() => {
      sms.prefsOptions?.onSuccess?.(
        { smsMayNeedStart: true },
        { signupId: "s-1", smsOptIn: true },
      );
    });

    expect(screen.getByText(START_HINT)).toBeTruthy();
    expect(screen.queryByText(STOP_HINT)).toBeNull();
  });

  it("a non-US number refused says we only text US numbers", () => {
    setRows([oneTimeAskRow({ signupId: "s-1" })]);
    renderPage();

    act(() => {
      sms.prefsOptions?.onError?.({ message: "sms_requires_us_phone" });
    });

    expect(
      screen.getByText(
        "We can only text US numbers, and the number on this signup isn't one.",
      ),
    ).toBeTruthy();
  });

  it("shows one switch per signup across its claimed dates", () => {
    setRows([
      askRow({
        signupId: "s-standing",
        claimId: "c-1",
        smsOptIn: true,
        hasContactPhone: true,
      }),
      askRow({
        signupId: "s-standing",
        claimId: "c-2",
        smsOptIn: true,
        hasContactPhone: true,
        startsAt: new Date("2030-06-13T23:00:00Z"),
        endsAt: new Date("2030-06-14T03:00:00Z"),
      }),
      askRow({
        signupId: "s-standing",
        claimId: "c-3",
        smsOptIn: true,
        hasContactPhone: true,
        startsAt: new Date("2030-06-20T23:00:00Z"),
        endsAt: new Date("2030-06-21T03:00:00Z"),
      }),
    ]);
    renderPage();

    expect(
      screen.getAllByRole("checkbox", { name: TEXTS_LABEL }),
    ).toHaveLength(1);
    expect(screen.getAllByTestId("commitment-sms-s-standing")).toHaveLength(1);
  });

  it("labels a shift row and a shiftless event row by what they come before", () => {
    const eventRow = (over: Row & { signupId: string }) =>
      askRow({
        claimId: null as unknown as string,
        occurrenceId: null,
        cadence: null,
        askId: null,
        source: "EVENT_SHIFT",
        eventId: "evt-1",
        eventSlug: "a-show",
        textRemindersOffered: true,
        reminderAnchor: "SHIFT",
        hasContactPhone: true,
        ...over,
      });
    setRows([
      eventRow({ signupId: "s-shift" }),
      eventRow({
        signupId: "s-role",
        startsAt: null,
        endsAt: null,
        source: "ASK_WINDOW",
        reminderAnchor: "EVENT_START",
      }),
    ]);
    renderPage();

    expect(
      screen.getByRole("checkbox", { name: "Text me shift reminders" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", {
        name: "Text me reminders before the event starts",
      }),
    ).toBeTruthy();
  });

  it("puts no switch on a History row", () => {
    setRows([
      oneTimeAskRow({ signupId: "s-w", status: "WITHDRAWN", smsOptIn: true }),
    ]);
    renderPage();

    expect(screen.queryByTestId("commitment-sms-s-w")).toBeNull();
  });
});
