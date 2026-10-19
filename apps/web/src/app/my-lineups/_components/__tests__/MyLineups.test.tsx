import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";
import esPackage from "@th/locale/messages/es.json";

import enApp from "@/i18n/messages/en";
import esApp from "@/i18n/messages/es";

/**
 * `/my-lineups`: the person's own list of lineups, and the one thing they can
 * do from it — take themselves off. Copy is the SHIPPED en catalog (real
 * `TranslationProvider`), so a key typo or a wrong argument name fails here
 * rather than rendering a raw key.
 *
 * What jsdom cannot see: layout at 320px, the Tamagui theme, or how the card
 * sits among its neighbours. Those need the real app.
 */

type LeaveVars = { eventId: string };

const mocks = vi.hoisted(() => ({
  session: { isPending: false, data: { user: { id: "u1" } } } as {
    isPending: boolean;
    data: { user: { id: string } } | null;
  },
  query: {} as Record<string, unknown>,
  leave: vi.fn<[{ eventId: string }], Promise<unknown>>(),
  invalidate: vi.fn(async () => {}),
  invalidatePublic: vi.fn(async () => {}),
  invalidateCommitments: vi.fn(async () => {}),
  invalidateMySignups: vi.fn(async () => {}),
  success: vi.fn(),
  danger: vi.fn(),
  showSignInOverlay: vi.fn(),
  push: vi.fn(),
  formatErrorMessageArgs: [] as unknown[][],
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      eventHumans: {
        listMine: { invalidate: mocks.invalidate },
        listPublic: { invalidate: mocks.invalidatePublic },
      },
      volunteer: {
        signups: {
          listMyCommitments: { invalidate: mocks.invalidateCommitments },
          listMine: { invalidate: mocks.invalidateMySignups },
        },
      },
    }),
    eventHumans: {
      listMine: { useInfiniteQuery: () => mocks.query },
      leave: {
        // Stateful like the real hook, so the pending label can be seen.
        useMutation: () => {
          const [state, setState] = React.useState<{
            isPending: boolean;
            variables: LeaveVars | undefined;
          }>({ isPending: false, variables: undefined });
          return {
            ...state,
            mutateAsync: async (vars: LeaveVars) => {
              setState({ isPending: true, variables: vars });
              try {
                return await mocks.leave(vars);
              } finally {
                setState({ isPending: false, variables: vars });
              }
            },
          };
        },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => mocks.session },
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: mocks.showSignInOverlay }),
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

// The real hook waits 200ms before showing the skeleton; the delay is not
// what these tests are about.
vi.mock("@/hooks/useDelayedFlag", () => ({
  useDelayedFlag: (flag: boolean) => flag,
}));

vi.mock("@/lib/format-error-message", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/format-error-message")>();
  return {
    ...actual,
    formatErrorMessage: (...args: unknown[]) => {
      mocks.formatErrorMessageArgs.push(args);
      return (
        actual.formatErrorMessage as (...a: unknown[]) => string
      )(...args);
    },
  };
});

/**
 * Real `@th/ui` (inside a real IthasFireProvider — Button stubs have lied
 * here before) except `useNotify`: the toast is what we assert on.
 */
vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  return {
    ...actual,
    useNotify: () => ({
      toast: { success: mocks.success, danger: mocks.danger },
    }),
  };
});

import { MyLineups } from "../MyLineups";

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
const esMessages = mergeCatalogs(esPackage as unknown as Messages, esApp);

const renderPage = (locale: "en" | "es" = "en") =>
  render(
    <IthasFireProvider>
      <TranslationProvider
        locale={locale}
        messages={locale === "es" ? esMessages : messages}
      >
        <MyLineups />
      </TranslationProvider>
    </IthasFireProvider>,
  );

// ── Fixtures ────────────────────────────────────────────────────────────────

const base = {
  endsAt: new Date("2030-06-01T04:00:00.000Z"),
  timezone: "America/Chicago",
  visibility: "PUBLIC" as const,
  customRoleLabel: null,
  roleLabel: "Performer",
  isPast: false,
  hasVolunteerSignup: false,
  organiserWillBeTold: true,
  passesBookingAct: false,
};

const published = {
  ...base,
  eventHumanId: "11111111-1111-4111-8111-111111111111",
  eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  eventTitle: "Summer Fest",
  startsAt: new Date("2030-06-01T01:00:00.000Z"),
  status: "PUBLISHED" as const,
  role: "PERFORMER" as const,
  organiserName: "Dev QA Collective",
  slug: "summer-fest",
};

const draft = {
  ...base,
  eventHumanId: "22222222-2222-4222-8222-222222222222",
  eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  eventTitle: "Basement Draft Night",
  startsAt: new Date("2030-07-01T01:00:00.000Z"),
  status: "DRAFT" as const,
  role: "DJ" as const,
  roleLabel: "DJ",
  organiserName: "Mill Collective",
  slug: null,
};

const cancelled = {
  ...base,
  eventHumanId: "33333333-3333-4333-8333-333333333333",
  eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  eventTitle: "Rained Out Picnic",
  startsAt: new Date("2030-08-01T01:00:00.000Z"),
  status: "CANCELLED" as const,
  role: "HOST" as const,
  roleLabel: "Host",
  // An ownerless community listing: nobody is told on leave.
  organiserName: null,
  organiserWillBeTold: false,
  slug: null,
};

const past = {
  ...base,
  eventHumanId: "44444444-4444-4444-8444-444444444444",
  eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  eventTitle: "Last Year's Showcase",
  startsAt: new Date("2025-06-01T01:00:00.000Z"),
  endsAt: new Date("2025-06-01T04:00:00.000Z"),
  status: "PUBLISHED" as const,
  role: "OTHER" as const,
  customRoleLabel: "Stage Manager",
  roleLabel: "Stage Manager",
  organiserName: "Dev QA Collective",
  slug: "last-years-showcase",
  isPast: true,
};

const volunteer = {
  ...base,
  eventHumanId: "55555555-5555-4555-8555-555555555555",
  eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  eventTitle: "River Cleanup",
  startsAt: new Date("2030-09-01T14:00:00.000Z"),
  status: "PUBLISHED" as const,
  role: "VOLUNTEER" as const,
  roleLabel: "Volunteer",
  organiserName: "Green Nashville",
  slug: "river-cleanup",
  hasVolunteerSignup: true,
};

// Extra fixtures, rendered only by the tests that need them.
const volunteerNoSignup = {
  ...volunteer,
  eventHumanId: "66666666-6666-4666-8666-666666666666",
  eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  eventTitle: "Hand-Added Helper",
  hasVolunteerSignup: false,
};

const ownerlessVolunteer = {
  ...volunteer,
  eventHumanId: "77777777-7777-4777-8777-777777777777",
  eventId: "abababab-abab-4bab-8bab-abababababab",
  eventTitle: "Community Garden Day",
  organiserName: null,
  organiserWillBeTold: false,
};

const toldUnnamed = {
  ...published,
  eventHumanId: "88888888-8888-4888-8888-888888888888",
  eventId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
  eventTitle: "Unnamed Host Night",
  slug: "unnamed-host-night",
  organiserName: null,
  organiserWillBeTold: true,
};

const archived = {
  ...published,
  eventHumanId: "99999999-9999-4999-8999-999999999999",
  eventId: "efefefef-efef-4fef-8fef-efefefefefef",
  eventTitle: "Shelved Series",
  status: "ARCHIVED" as const,
  slug: null,
};

// Leaving gives up the person's spot on the booking (upcoming booked show).
const booked = {
  ...published,
  eventHumanId: "12121212-1212-4121-8121-121212121212",
  eventId: "13131313-1313-4131-8131-131313131313",
  eventTitle: "Booked Friday",
  slug: "booked-friday",
  passesBookingAct: true,
};

const BOOKING_NOTE =
  "Your spot on the booking for this show is given up too — you can't rejoin that booking.";

const refetch = vi.fn();
const fetchNextPage = vi.fn();

const setItems = (
  items: unknown[],
  extra: Record<string, unknown> = {},
): void => {
  mocks.query = {
    data: { pages: [{ items, nextCursor: null }] },
    isLoading: false,
    isFetching: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch,
    fetchNextPage,
    ...extra,
  };
};

const card = (id: string) => screen.getByTestId(`lineup-card-${id}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formatErrorMessageArgs = [];
  mocks.session = { isPending: false, data: { user: { id: "u1" } } };
  mocks.leave.mockResolvedValue({ eventId: "x", eventHumanId: "y" });
  setItems([published, draft, cancelled, past, volunteer]);
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe("MyLineups — list", () => {
  it("renders the header and every lineup the person is on", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: "My lineups" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Events where an organiser has put your name on the lineup. Take yourself off any you shouldn't be on.",
      ),
    ).toBeTruthy();
    const list = screen.getByRole("list", { name: "My lineups" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
  });

  it("links a published event to its page; the link names the event", () => {
    renderPage();
    const link = within(card(published.eventHumanId)).getByRole("link", {
      name: "View event: Summer Fest",
    });
    expect(link.getAttribute("href")).toBe("/events/summer-fest");
    expect(
      within(card(published.eventHumanId)).queryByText("Not public yet"),
    ).toBeNull();
  });

  it("a draft shows 'Not public yet' and no link", () => {
    renderPage();
    const c = card(draft.eventHumanId);
    expect(within(c).getByText("Not public yet")).toBeTruthy();
    expect(within(c).queryByRole("link")).toBeNull();
  });

  it("an archived event shows 'Archived' and no link", () => {
    setItems([archived]);
    renderPage();
    const c = card(archived.eventHumanId);
    expect(within(c).getByText("Archived")).toBeTruthy();
    expect(within(c).queryByRole("link")).toBeNull();
  });

  it("es: the volunteer role reads 'Voluntariado' on this page", () => {
    setItems([volunteer]);
    renderPage("es");
    expect(
      within(card(volunteer.eventHumanId)).getByText(
        "Voluntariado · Green Nashville",
      ),
    ).toBeTruthy();
  });

  it("a cancelled event shows 'Cancelled' and no link", () => {
    renderPage();
    const c = card(cancelled.eventHumanId);
    expect(within(c).getByText("Cancelled")).toBeTruthy();
    expect(within(c).queryByRole("link")).toBeNull();
  });

  it("a past event shows 'Ended' and keeps its link", () => {
    renderPage();
    const c = card(past.eventHumanId);
    expect(within(c).getByText("Ended")).toBeTruthy();
    expect(
      within(c)
        .getByRole("link", { name: "View event: Last Year's Showcase" })
        .getAttribute("href"),
    ).toBe("/events/last-years-showcase");
  });

  it("says the role and the organiser (not who added them); a custom role uses its label", () => {
    renderPage();
    expect(
      within(card(published.eventHumanId)).getByText(
        "Performer · Dev QA Collective",
      ),
    ).toBeTruthy();
    expect(
      within(card(past.eventHumanId)).getByText(
        "Stage Manager · Dev QA Collective",
      ),
    ).toBeTruthy();
    // No organiser (a community listing): the role alone.
    expect(within(card(cancelled.eventHumanId)).getByText("Host")).toBeTruthy();
    // The name is the organiser, not the adder — never "added by".
    expect(screen.queryByText(/added by/i)).toBeNull();
  });

  it("formats the date in the EVENT's timezone, not the reader's", () => {
    renderPage();
    // 01:00Z on Jun 1 is 8:00 PM on May 31 in Chicago.
    const time = card(published.eventHumanId).querySelector("time");
    expect(time?.textContent).toContain("May 31, 2030");
    expect(time?.textContent).toContain("8:00");
    expect(time?.getAttribute("datetime")).toBe("2030-06-01T01:00:00.000Z");
  });

  it("every Remove me button has its own accessible name", () => {
    renderPage();
    const names = screen
      .getAllByRole("button", { name: /^Remove me from the lineup for / })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
  });
});

// ── Remove me ───────────────────────────────────────────────────────────────

const openConfirm = (title: string) =>
  fireEvent.click(
    screen.getByRole("button", {
      name: `Remove me from the lineup for ${title}`,
    }),
  );

describe("MyLineups — remove me", () => {
  it("opens an inline confirm in that card and focuses the question", () => {
    renderPage();
    openConfirm("Summer Fest");

    const confirm = screen.getByRole("group", {
      name: "Take yourself off this lineup? Dev QA Collective will be told. They can add you again later.",
    });
    expect(within(card(published.eventHumanId)).getByRole("group")).toBe(
      confirm,
    );
    expect(document.activeElement?.textContent).toBe(
      "Take yourself off this lineup? Dev QA Collective will be told. They can add you again later.",
    );
    // The card's own Remove me button is swapped out, not duplicated.
    expect(
      screen.queryByRole("button", {
        name: "Remove me from the lineup for Summer Fest",
      }),
    ).toBeNull();
    expect(within(confirm).getByRole("button", { name: "Remove me" })).toBeTruthy();
    expect(
      within(confirm).getByRole("button", { name: "Keep me on" }),
    ).toBeTruthy();
  });

  it("an ownerless listing tells nobody — the copy does not claim otherwise", () => {
    renderPage();
    openConfirm("Rained Out Picnic");
    const group = screen.getByRole("group", {
      name: "Take yourself off this lineup? You can be added again later.",
    });
    expect(group.textContent).not.toMatch(/told/);
  });

  it("told but no organiser name: the generic organiser line", () => {
    setItems([toldUnnamed]);
    renderPage();
    openConfirm("Unnamed Host Night");
    expect(
      screen.getByRole("group", {
        name: "Take yourself off this lineup? The organiser will be told. They can add you again later.",
      }),
    ).toBeTruthy();
  });

  it("a volunteer WITH a signup is warned it is withdrawn too", () => {
    renderPage();
    openConfirm("River Cleanup");
    expect(
      screen.getByRole("group", {
        name: "Take yourself off this lineup? Your volunteer signup will be withdrawn too. Green Nashville will be told.",
      }),
    ).toBeTruthy();
  });

  it("a volunteer WITHOUT a signup gets the normal copy", () => {
    setItems([volunteerNoSignup]);
    renderPage();
    openConfirm("Hand-Added Helper");
    expect(
      screen.getByRole("group", {
        name: "Take yourself off this lineup? Green Nashville will be told. They can add you again later.",
      }),
    ).toBeTruthy();
  });

  it("an upcoming booked show: the confirm says the booking spot is given up, for good", () => {
    setItems([booked]);
    renderPage();
    openConfirm("Booked Friday");
    expect(
      screen.getByRole("group", {
        name: `Take yourself off this lineup? Dev QA Collective will be told. They can add you again later. ${BOOKING_NOTE}`,
      }),
    ).toBeTruthy();
  });

  it("booked + nobody else to tell (e.g. you are the org's only editor): both truths, no 'told'", () => {
    setItems([{ ...booked, organiserWillBeTold: false }]);
    renderPage();
    openConfirm("Booked Friday");
    const group = screen.getByRole("group", {
      name: `Take yourself off this lineup? You can be added again later. ${BOOKING_NOTE}`,
    });
    expect(group.textContent).not.toMatch(/told/);
  });

  it("booked + a volunteer signup: the signup line and the booking line both", () => {
    setItems([{ ...volunteer, passesBookingAct: true }]);
    renderPage();
    openConfirm("River Cleanup");
    expect(
      screen.getByRole("group", {
        name: `Take yourself off this lineup? Your volunteer signup will be withdrawn too. Green Nashville will be told. ${BOOKING_NOTE}`,
      }),
    ).toBeTruthy();
  });

  it("es: the booking line is translated", () => {
    setItems([booked]);
    renderPage("es");
    fireEvent.click(
      screen.getByRole("button", { name: "Quitarme del lineup de Booked Friday" }),
    );
    expect(
      screen.getByRole("group", {
        name: "¿Quitarte de este lineup? Dev QA Collective recibirá un aviso y podrá volver a agregarte más adelante. También renuncias a tu lugar en la contratación de este espectáculo: no podrás volver a unirte a esa contratación.",
      }),
    ).toBeTruthy();
  });

  it("an ownerless volunteer listing: signup withdrawn, nobody told", () => {
    setItems([ownerlessVolunteer]);
    renderPage();
    openConfirm("Community Garden Day");
    expect(
      screen.getByRole("group", {
        name: "Take yourself off this lineup? Your volunteer signup will be withdrawn too. You can be added again later.",
      }),
    ).toBeTruthy();
  });

  it("confirming calls leave with the event id, hides the card, toasts, refetches", async () => {
    renderPage();
    openConfirm("Summer Fest");
    const confirm = screen.getByTestId(`lineup-confirm-${published.eventHumanId}`);

    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Remove me" }));
    });

    expect(mocks.leave).toHaveBeenCalledTimes(1);
    expect(mocks.leave).toHaveBeenCalledWith({ eventId: published.eventId });
    await waitFor(() =>
      expect(
        screen.queryByTestId(`lineup-card-${published.eventHumanId}`),
      ).toBeNull(),
    );
    expect(mocks.success).toHaveBeenCalledWith({
      title: "You're off the lineup for Summer Fest",
    });
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(mocks.invalidatePublic).toHaveBeenCalledWith({
      eventId: published.eventId,
    });
    // No signup was withdrawn: the volunteer reads are left alone.
    expect(mocks.invalidateCommitments).not.toHaveBeenCalled();
    expect(mocks.invalidateMySignups).not.toHaveBeenCalled();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    // The focused card is gone: focus parks on the heading, not <body>.
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "My lineups" }),
    );
  });

  it("a withdrawn volunteer signup refreshes the volunteer reads", async () => {
    mocks.leave.mockResolvedValue({
      eventId: volunteer.eventId,
      eventHumanId: volunteer.eventHumanId,
      withdrawnVolunteerSignupId: "12121212-1212-4212-8212-121212121212",
    });
    renderPage();
    openConfirm("River Cleanup");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove me" }));
    });
    expect(mocks.invalidateCommitments).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateMySignups).toHaveBeenCalledTimes(1);
    expect(mocks.invalidatePublic).toHaveBeenCalledWith({
      eventId: volunteer.eventId,
    });
  });

  it("while removing: busy label, no second request, Keep me on inert", async () => {
    let resolve!: (v: unknown) => void;
    mocks.leave.mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    renderPage();
    openConfirm("Summer Fest");
    const confirm = screen.getByTestId(`lineup-confirm-${published.eventHumanId}`);

    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Remove me" }));
    });

    const pending = within(confirm).getByRole("button", { name: "Removing…" });
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    // A second press while the first is in flight sends nothing.
    await act(async () => {
      fireEvent.click(pending);
    });
    expect(mocks.leave).toHaveBeenCalledTimes(1);
    expect(
      within(confirm)
        .getByRole("button", { name: "Keep me on" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    // Escape does not back out mid-request.
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.getByTestId(`lineup-confirm-${published.eventHumanId}`)).toBeTruthy();

    await act(async () => {
      resolve({ eventId: published.eventId, eventHumanId: published.eventHumanId });
    });
    await waitFor(() =>
      expect(
        screen.queryByTestId(`lineup-card-${published.eventHumanId}`),
      ).toBeNull(),
    );
  });

  it("Keep me on closes the confirm and returns focus to Remove me", () => {
    renderPage();
    openConfirm("Summer Fest");
    fireEvent.click(screen.getByRole("button", { name: "Keep me on" }));

    expect(
      screen.queryByTestId(`lineup-confirm-${published.eventHumanId}`),
    ).toBeNull();
    const again = screen.getByRole("button", {
      name: "Remove me from the lineup for Summer Fest",
    });
    expect(document.activeElement).toBe(again);
    expect(mocks.leave).not.toHaveBeenCalled();
  });

  it("Escape cancels the same way", () => {
    renderPage();
    openConfirm("Summer Fest");
    fireEvent.keyDown(
      screen.getByTestId(`lineup-confirm-${published.eventHumanId}`),
      { key: "Escape" },
    );
    expect(
      screen.queryByTestId(`lineup-confirm-${published.eventHumanId}`),
    ).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: "Remove me from the lineup for Summer Fest",
      }),
    );
  });

  it("only one confirm is open at a time", () => {
    renderPage();
    openConfirm("Summer Fest");
    openConfirm("River Cleanup");
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(
      screen.getByTestId(`lineup-confirm-${volunteer.eventHumanId}`),
    ).toBeTruthy();
  });

  it("a failed leave keeps the card and toasts the translated error", async () => {
    mocks.leave.mockRejectedValue(new Error("Too many requests"));
    renderPage();
    openConfirm("Summer Fest");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove me" }));
    });

    expect(mocks.danger).toHaveBeenCalledTimes(1);
    const arg = mocks.danger.mock.calls[0]?.[0] as {
      title: string;
      message: string;
    };
    expect(arg.title).toBe("Couldn't take you off this lineup");
    expect(typeof arg.message).toBe("string");
    // formatErrorMessage got the translator (without it: "Something went wrong").
    expect(typeof mocks.formatErrorMessageArgs[0]?.[1]).toBe("function");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(card(published.eventHumanId)).toBeTruthy();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});

// ── Page states ─────────────────────────────────────────────────────────────

describe("MyLineups — states", () => {
  it("empty", () => {
    setItems([]);
    renderPage();
    const empty = screen.getByTestId("my-lineups-empty");
    expect(within(empty).getByText("You're not on any lineups")).toBeTruthy();
    expect(
      within(empty).getByText(
        "When an organiser adds you to an event's lineup, it shows up here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("signed out: promo with a sign-in that returns here", () => {
    mocks.session = { isPending: false, data: null };
    renderPage();
    expect(screen.getByTestId("my-lineups-signed-out")).toBeTruthy();
    expect(screen.getByText("See where your name is listed")).toBeTruthy();
    expect(
      screen.getByText(
        "Sign in to see the events you've been added to. Only you can see this list.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("my-lineups-sign-in-cta"));
    expect(mocks.showSignInOverlay).toHaveBeenCalledWith({
      redirect: "/my-lineups",
    });
  });

  it("loading: skeleton while the session resolves", () => {
    mocks.session = { isPending: true, data: null };
    renderPage();
    expect(screen.getByTestId("my-lineups-loading")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("loading: skeleton while the first page loads", () => {
    setItems([], { data: undefined, isLoading: true, isFetching: true });
    renderPage();
    expect(screen.getByTestId("my-lineups-loading")).toBeTruthy();
  });

  it("a failed BACKGROUND refetch keeps the list and offers a retry", () => {
    setItems([published, draft], { error: new Error("boom") });
    renderPage();
    expect(screen.queryByTestId("my-lineups-error")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const notice = screen.getByTestId("my-lineups-refresh-failed");
    expect(within(notice).getByText("Couldn't refresh your lineups.")).toBeTruthy();
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("error: translated message and a retry", () => {
    setItems([], { data: undefined, error: new Error("boom") });
    renderPage();
    expect(screen.getByText("Unable to load your lineups")).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("Load more fetches the next page", () => {
    setItems([published], { hasNextPage: true });
    renderPage();
    fireEvent.click(screen.getByTestId("my-lineups-load-more"));
    expect(fetchNextPage).toHaveBeenCalled();
  });
});
