import React from "react";
import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";

import enApp from "@/i18n/messages/en";

/**
 * The volunteer's OWN check-in code. The assertions that matter are the ones
 * that keep it from becoming a badge, plus the ones that stop it printing
 * something a door will reject:
 *  - it never names an issuer and never presents as venue-issued,
 *  - it says on the paper that it admits nobody on its own,
 *  - only APPROVED event shifts can produce one,
 *  - a link naming an event the volunteer has no approved shift at prints
 *    NOTHING rather than a code for a different event,
 *  - minting is an explicit act, never a page load.
 *
 * Note what a jsdom test CANNOT see: `@media print`, `@page`, the 70mm symbol,
 * or whether it renders dark-on-white under a dark ACCOUNT theme. Those are
 * verified in a real browser with `page.emulateMedia({ media: "print" })` and
 * a real PDF.
 */

const commitmentsQuery = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const session = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const mint = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      signups: {
        listMyCommitments: { useQuery: () => commitmentsQuery.current },
        mintScanToken: { useMutation: () => ({ mutateAsync: mint.fn }) },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => session.current },
}));

/**
 * Real `@th/ui` except the Tamagui `Button`, which needs a TamaguiProvider and
 * a theme jsdom has no business booting. `useTranslations` / `useFormatters`
 * stay REAL, so the copy under test is the shipped copy.
 */
vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  const Button = ({
    children,
    onPress,
    disabled,
    tabIndex,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    tabIndex?: number;
  } & Record<string, unknown>) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-") || key.startsWith("aria-")) {
        domProps[key] = value;
      }
    }
    // `tabIndex` is forwarded explicitly, unlike the rest of the Tamagui
    // surface: the back link's second tab stop is a real defect this file
    // guards, and a stub that swallowed the prop would report it fixed.
    return (
      <button
        {...domProps}
        tabIndex={tabIndex}
        disabled={disabled}
        onClick={onPress}
      >
        {children}
      </button>
    );
  };
  return {
    ...actual,
    Button,
    NextLinkAnchor: ({
      children,
      href,
    }: {
      children?: ReactNode;
      href: string;
    }) => <a href={href}>{children}</a>,
  };
});

import { VolunteerQrSheet } from "../VolunteerQrSheet";

/** Shared catalog + the app's overrides — the same merge the stories use. */
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

const renderSheet = (eventId: string | null = null) =>
  render(
    <TranslationProvider locale="en" messages={messages}>
      <VolunteerQrSheet eventId={eventId} />
    </TranslationProvider>,
  );

type Row = Record<string, unknown>;

const row = (over: Row & { signupId: string }): Row => ({
  claimId: null,
  occurrenceId: null,
  status: "APPROVED",
  source: "EVENT_SHIFT",
  cadence: null,
  title: "SOMA Warehouse Rave",
  roleName: "Bar Staff",
  shiftLabel: "During Event",
  startsAt: new Date("2026-08-15T23:00:00Z"),
  endsAt: new Date("2026-08-16T03:00:00Z"),
  eventId: "evt-soma",
  eventSlug: "soma-warehouse-rave",
  eventTimezone: "America/Chicago",
  addressText: "SOMA Warehouse",
  askId: null,
  hoursWorked: null,
  hoursCredited: null,
  checkedInAt: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  smsOptIn: false,
  hasContactPhone: false,
  textRemindersOffered: false,
  reminderAnchor: null,
  ...over,
});

const setRows = (rows: Row[]) => {
  commitmentsQuery.current = { data: rows, isLoading: false, error: null };
};

const createCode = async () => {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(screen.getByTestId("volunteer-qr-create-action"));
  });
  await waitFor(() =>
    expect(screen.getByTestId("volunteer-qr-facts")).toBeInTheDocument(),
  );
  return user;
};

beforeEach(() => {
  vi.clearAllMocks();
  session.current = {
    isPending: false,
    data: { user: { name: "Liam Nguyen", email: "liam.nguyen@example.com" } },
  };
  setRows([row({ signupId: "s-liam" })]);
  mint.fn.mockImplementation(({ signupId }: { signupId: string }) =>
    Promise.resolve({
      token: `token-for-${signupId}`,
      expiresAt: new Date("2026-08-17T00:00:00Z"),
    }),
  );
});

describe("VolunteerQrSheet", () => {
  it("mints nothing on mount — creating the code is an explicit act", () => {
    // Every mint writes a `scan_token_minted` audit row. A page load must
    // never forge one, and StrictMode would forge two.
    renderSheet();

    expect(mint.fn).not.toHaveBeenCalled();
    expect(screen.getByTestId("volunteer-qr-manifest")).toBeInTheDocument();
  });

  it("does not offer Print until a code exists", () => {
    renderSheet();

    expect(screen.queryByTestId("volunteer-qr-print-action")).toBeNull();
    expect(
      screen.getByTestId("volunteer-qr-create-action"),
    ).toBeInTheDocument();
  });

  it("mints a PRINT-kind token for the volunteer's own signup", async () => {
    renderSheet();
    await createCode();

    expect(mint.fn).toHaveBeenCalledTimes(1);
    expect(mint.fn).toHaveBeenCalledWith({
      signupId: "s-liam",
      kind: "print",
    });
  });

  it("is a CODE, not a badge — no issuer, no credential designation", async () => {
    // The whole boundary between this document and the organizer's badge
    // sheet. A regression here is not cosmetic: it would put something that
    // reads as venue-issued authorization in a volunteer's own hands.
    renderSheet();
    await createCode();

    const sheet = screen.getByTestId("volunteer-qr-sheet");
    expect(sheet.textContent).not.toMatch(/issued by/i);
    expect(sheet.textContent).not.toMatch(/\bbadge\b/i);
    // The designation the badge sheet stamps in accent must not appear as a
    // standalone credential label here.
    expect(within(sheet).queryByText("Volunteer")).toBeNull();
  });

  it("says on the paper that it admits nobody on its own", async () => {
    renderSheet();
    await createCode();

    const note = screen.getByTestId("volunteer-qr-note");
    expect(note.textContent).toMatch(/does not admit you on its own/i);
    // NOT `data-print-hide` — this sentence is the point and has to print.
    expect(note).not.toHaveAttribute("data-print-hide");
  });

  it("puts every approved shift at the event under one code", async () => {
    setRows([
      row({ signupId: "s-bar", roleName: "Bar Staff" }),
      row({
        signupId: "s-teardown",
        roleName: "Teardown",
        startsAt: new Date("2026-08-16T05:00:00Z"),
        endsAt: new Date("2026-08-16T07:00:00Z"),
      }),
    ]);

    renderSheet();
    await createCode();

    const facts = screen.getByTestId("volunteer-qr-facts");
    expect(within(facts).getByText("Bar Staff")).toBeInTheDocument();
    expect(within(facts).getByText("Teardown")).toBeInTheDocument();
    // Human+event scoped: one token covers both shifts.
    expect(mint.fn).toHaveBeenCalledTimes(1);
  });

  it("renders the shift window in the VENUE's zone, naming the zone", async () => {
    // 23:00–03:00 UTC is one evening in Chicago. Rendering it in the viewer's
    // zone — or splitting it across two dates — tells a volunteer the wrong
    // day, and paper cannot re-render when they travel.
    renderSheet();
    await createCode();

    expect(
      within(screen.getByTestId("volunteer-qr-facts")).getByText(
        /Sat, Aug 15 · 6:00\s?PM – 10:00\s?PM CDT/,
      ),
    ).toBeInTheDocument();
  });

  it("offers nothing for a PENDING application", () => {
    setRows([row({ signupId: "s-pending", status: "PENDING" })]);

    renderSheet();

    expect(screen.getByTestId("volunteer-qr-empty")).toBeInTheDocument();
    expect(screen.getByTestId("volunteer-qr-create-action")).toBeDisabled();
  });

  it("prints nothing — never another event's code — for an unmatched event link", () => {
    setRows([row({ signupId: "s-liam", eventId: "evt-soma" })]);

    renderSheet("evt-somewhere-else");

    // A code for the wrong event scans as `volunteer_qr_wrong_event` at the
    // door with nothing on the paper to explain it.
    expect(screen.getByTestId("volunteer-qr-wrong-event")).toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-qr-facts")).toBeNull();
    expect(mint.fn).not.toHaveBeenCalled();
  });

  it("says the read failed rather than claiming there are no shifts", () => {
    // Checked BEFORE the empty branch: "no approved shifts" is a confident,
    // specific and wrong claim about a volunteer's own record when the read
    // simply failed — and one they might act on by not turning up.
    commitmentsQuery.current = {
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    };

    renderSheet();

    expect(screen.getByTestId("volunteer-qr-error")).toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-qr-empty")).toBeNull();
  });

  it("offers a retry, and a fallback plan, when the mint fails", async () => {
    mint.fn.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();

    renderSheet();
    await act(async () => {
      await user.click(screen.getByTestId("volunteer-qr-create-action"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("volunteer-qr-failed")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("volunteer-qr-facts")).toBeNull();
    expect(
      screen.getByTestId("volunteer-qr-retry-action"),
    ).toBeInTheDocument();
    // A volunteer whose code won't mint still has a way in on the day.
    expect(
      screen.getByTestId("volunteer-qr-failed").textContent,
    ).toMatch(/find you by name/i);
  });

  it("handles its own signed-out case, since the print route bypasses the gate", () => {
    session.current = { isPending: false, data: null };

    renderSheet("evt-soma");

    expect(screen.getByTestId("volunteer-qr-signed-out")).toBeInTheDocument();
    // And the way back is a real link, not a dead end on a chrome-less route.
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link.getAttribute("href")).toContain(
      encodeURIComponent("/my-volunteering/qr/print?event=evt-soma"),
    );
  });

  it("hands the keyboard to Print once the code exists", async () => {
    renderSheet();
    await createCode();

    expect(document.activeElement).toBe(
      screen.getByTestId("volunteer-qr-print-action"),
    );
  });

  it("gives the back link a single tab stop, not two with the same name", () => {
    renderSheet();

    const link = screen.getByRole("link", { name: /back to my volunteering/i });
    expect(link.querySelector("[tabindex]")?.getAttribute("tabindex")).toBe(
      "-1",
    );
  });
});
