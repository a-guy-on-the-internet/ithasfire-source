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
 * The badge sheet produces CREDENTIAL STOCK, so the assertions that matter are
 * about who gets one and whose code lands on it:
 *  - only APPROVED signups reach the paper,
 *  - one badge per human, carrying every shift they're approved for,
 *  - every badge's QR carries THAT volunteer's token and no one else's,
 *  - Print does not exist until badges have actually been issued,
 *  - a partial run prints what it has and names who is missing, ON SCREEN.
 *
 * Note what a jsdom test CANNOT see: `@media print`, `@page`, the forced
 * six-per-page break, the dashed cut frames, or whether the scan panel renders
 * white under a dark ACCOUNT theme. Those are verified in a real browser with
 * `page.emulateMedia({ media: "print" })` and real PDFs at Letter and A4.
 */

const eventQuery = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const rolesQuery = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const signupsQuery = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const owner = vi.hoisted(() => ({ current: null as unknown }));
const mint = vi.hoisted(() => ({ fn: vi.fn() }));
const listFetch = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      volunteer: { signups: { list: { fetch: listFetch.fn } } },
    }),
    events: {
      getEventForEdit: { useQuery: () => eventQuery.current },
    },
    volunteer: {
      roles: { list: { useQuery: () => rolesQuery.current } },
      signups: {
        list: { useQuery: () => signupsQuery.current },
        mintScanToken: {
          useMutation: () => ({ mutateAsync: mint.fn }),
        },
      },
    },
  },
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({ currentOwner: owner.current }),
}));

/**
 * Real `@th/ui` except the Tamagui `Button`, which needs a TamaguiProvider and
 * a theme jsdom has no business booting. `useTranslations` / `useFormatters`
 * stay REAL, so the copy and the ICU plurals under test are the shipped ones.
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

import { VolunteerBadgeSheet } from "../VolunteerBadgeSheet";

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

const renderSheet = () =>
  render(
    <TranslationProvider locale="en" messages={messages}>
      <VolunteerBadgeSheet slug="east-side" eventId="evt-1" />
    </TranslationProvider>,
  );

type SignupRow = Record<string, unknown>;

const signup = (over: SignupRow & { id: string }): SignupRow => ({
  humanId: "h-alex",
  roleId: "role-door",
  shiftId: "shift-evening",
  contactName: "Alex Martinez",
  contactEmail: "alex@example.com",
  status: "APPROVED",
  ...over,
});

const setSignups = (items: SignupRow[]) => {
  signupsQuery.current = {
    data: { items, pageInfo: { total: items.length } },
    isLoading: false,
    error: null,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  owner.current = { kind: "org", orgName: "East Side Collective" };
  eventQuery.current = {
    data: {
      title: "Sunset Sessions Vol. 3",
      timezone: "America/Chicago",
      place: { name: "The Basement East" },
      locationLabel: null,
      addressText: null,
      locality: null,
    },
    isLoading: false,
    error: null,
  };
  rolesQuery.current = {
    data: [
      {
        id: "role-door",
        name: "Door",
        shifts: [
          {
            id: "shift-evening",
            label: "Evening",
            startsAt: new Date("2026-08-14T22:00:00Z"),
            endsAt: new Date("2026-08-15T02:00:00Z"),
          },
        ],
      },
      {
        id: "role-stage",
        name: "Stage Crew",
        shifts: [
          {
            id: "shift-load-in",
            label: "Load-in",
            startsAt: new Date("2026-08-14T18:00:00Z"),
            endsAt: new Date("2026-08-14T21:00:00Z"),
          },
        ],
      },
    ],
    isLoading: false,
    error: null,
  };
  setSignups([signup({ id: "s-alex" })]);
  mint.fn.mockImplementation(({ signupId }: { signupId: string }) =>
    Promise.resolve({
      token: `token-for-${signupId}`,
      expiresAt: new Date("2026-08-16T00:00:00Z"),
    }),
  );
});

/**
 * Press Issue and settle.
 *
 * The whole click is wrapped in `act` because `runIssue` keeps updating state
 * (`{ phase: "issuing", done }`) after the click's own act scope has closed —
 * `userEvent.click` only covers the synchronous handler, and the mint waves
 * resolve on later microtask turns.
 */
const issueBadges = async () => {
  const user = userEvent.setup();
  await act(async () => {
    await user.click(screen.getByTestId("volunteer-badges-issue-action"));
  });
  await waitFor(() =>
    expect(screen.getByTestId("volunteer-badges-run")).toBeInTheDocument(),
  );
  return user;
};

describe("VolunteerBadgeSheet", () => {
  it("does not offer Print until badges have actually been issued", () => {
    // A badge sheet whose scan panels are empty is credential stock that
    // admits nobody. The affordance must not exist before the codes do.
    renderSheet();

    expect(screen.getByTestId("volunteer-badges-manifest")).toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-badges-print-action")).toBeNull();
    expect(
      screen.getByTestId("volunteer-badges-issue-action"),
    ).toBeInTheDocument();
  });

  it("mints nothing on mount — issuing is an explicit act", () => {
    // Minting writes the audit row that is the ONLY record of a printed
    // credential's provenance. A page load must never forge one.
    renderSheet();

    expect(mint.fn).not.toHaveBeenCalled();
  });

  it("issues one PRINT-kind token per volunteer and prints their code on their badge", async () => {
    setSignups([
      signup({ id: "s-alex", humanId: "h-alex", contactName: "Alex Martinez" }),
      signup({
        id: "s-jules",
        humanId: "h-jules",
        contactName: "Jules Okafor",
        contactEmail: "jules@example.com",
      }),
    ]);

    renderSheet();
    await issueBadges();

    expect(mint.fn).toHaveBeenCalledTimes(2);
    for (const call of mint.fn.mock.calls) {
      expect(call[0].kind).toBe("print");
    }

    // THE mis-pairing regression: a badge carrying somebody else's code is a
    // credential in the wrong name. `Promise.allSettled` preserves positional
    // order; this asserts the code actually relies on that.
    const alex = screen.getByTestId("volunteer-badge-h-alex");
    const jules = screen.getByTestId("volunteer-badge-h-jules");
    expect(
      within(alex).getByLabelText("Volunteer check-in code for Alex Martinez"),
    ).toBeInTheDocument();
    expect(
      within(jules).getByLabelText("Volunteer check-in code for Jules Okafor"),
    ).toBeInTheDocument();
  });

  it("puts one badge — not two — in front of a volunteer working two shifts", async () => {
    setSignups([
      signup({ id: "s-door", roleId: "role-door", shiftId: "shift-evening" }),
      signup({ id: "s-stage", roleId: "role-stage", shiftId: "shift-load-in" }),
    ]);

    renderSheet();
    await issueBadges();

    // `-h-` and not a bare `volunteer-badge-` prefix: the sheet's own hooks
    // (`volunteer-badges-run`, `-meta`) would otherwise be counted as badges.
    expect(screen.getAllByTestId(/^volunteer-badge-h-/)).toHaveLength(1);
    const badge = screen.getByTestId("volunteer-badge-h-alex");
    expect(within(badge).getByText("Stage Crew")).toBeInTheDocument();
    expect(within(badge).getByText("Door")).toBeInTheDocument();
    // Human+event scoped: one token covers both shifts, so only one mint.
    expect(mint.fn).toHaveBeenCalledTimes(1);
  });

  it("keeps every non-APPROVED status off the paper", async () => {
    setSignups([
      signup({ id: "s-ok", humanId: "h-ok", status: "APPROVED" }),
      signup({ id: "s-pending", humanId: "h-pending", status: "PENDING" }),
      signup({ id: "s-in", humanId: "h-in", status: "CHECKED_IN" }),
      signup({ id: "s-no", humanId: "h-no", status: "NO_SHOW" }),
    ]);

    renderSheet();
    await issueBadges();

    expect(screen.getByTestId("volunteer-badge-h-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-badge-h-pending")).toBeNull();
    expect(screen.queryByTestId("volunteer-badge-h-in")).toBeNull();
    expect(screen.queryByTestId("volunteer-badge-h-no")).toBeNull();
  });

  it("hands the keyboard to Print once the badges exist", async () => {
    // Issuing unmounts the button the operator just pressed, so without this
    // focus falls to <body> and a keyboard or switch-control user is dropped
    // to the top of a document that just changed under them. Caught by
    // tabbing through the real page, not by any assertion here first.
    renderSheet();
    await issueBadges();

    expect(document.activeElement).toBe(
      screen.getByTestId("volunteer-badges-print-action"),
    );
  });

  it("gives the back link a single tab stop, not two with the same name", () => {
    // Tamagui's Button renders a focusable span even under `tag="span"`, so
    // the anchor and its own label were two consecutive tab stops reading
    // "Back to signups" both times.
    renderSheet();

    const link = screen.getByRole("link", { name: /back to signups/i });
    expect(link.querySelector("[tabindex]")?.getAttribute("tabindex")).toBe(
      "-1",
    );
  });

  it("names the issuing organisation on every badge", async () => {
    renderSheet();
    await issueBadges();

    expect(
      within(screen.getByTestId("volunteer-badge-h-alex")).getByText(
        "Issued by East Side Collective",
      ),
    ).toBeInTheDocument();
  });

  it("renders the shift window in the VENUE's zone, and names the zone", async () => {
    // 22:00–02:00 UTC is one evening in Chicago. Printing it as two dates (or
    // in the operator's zone) tells a volunteer the wrong day; paper cannot
    // re-render when the reader is somewhere else, so the zone is named.
    renderSheet();
    await issueBadges();

    const badge = screen.getByTestId("volunteer-badge-h-alex");
    expect(
      within(badge).getByText(/Fri, Aug 14 · 5:00\s?PM – 9:00\s?PM CDT/),
    ).toBeInTheDocument();
  });

  it("prints what it has and names who is missing when some mints fail", async () => {
    setSignups([
      signup({ id: "s-alex", humanId: "h-alex", contactName: "Alex Martinez" }),
      signup({
        id: "s-jules",
        humanId: "h-jules",
        contactName: "Jules Okafor",
        contactEmail: "jules@example.com",
      }),
    ]);
    mint.fn.mockImplementation(({ signupId }: { signupId: string }) =>
      signupId === "s-jules"
        ? Promise.reject(new Error("nope"))
        : Promise.resolve({
            token: `token-for-${signupId}`,
            expiresAt: new Date(),
          }),
    );

    renderSheet();
    await issueBadges();

    // One volunteer's badge survives — a show night cannot lose fifty-nine
    // badges to one bad row.
    expect(screen.getByTestId("volunteer-badge-h-alex")).toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-badge-h-jules")).toBeNull();

    // And the operator is told, on screen, that the stack is short. The
    // warning is `data-print-hide`: the paper is credential stock and carries
    // no operational error text.
    const warning = screen.getByTestId("volunteer-badges-partial");
    expect(warning).toHaveAttribute("data-print-hide");
    expect(within(warning).getByText("Jules Okafor")).toBeInTheDocument();
  });

  it("offers a retry, not a blank sheet, when every mint fails", async () => {
    mint.fn.mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();

    renderSheet();
    await act(async () => {
      await user.click(screen.getByTestId("volunteer-badges-issue-action"));
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("volunteer-badges-issue-failed"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("volunteer-badges-run")).toBeNull();
    expect(
      screen.getByTestId("volunteer-badges-retry-action"),
    ).toBeInTheDocument();
  });

  it("says the roster failed rather than claiming there are no volunteers", () => {
    // Checked BEFORE the empty branch. "No approved volunteers" is a specific,
    // confident and wrong claim when the read simply failed — and it is the
    // kind an organiser acts on by not printing badges for people already on
    // their way.
    signupsQuery.current = {
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    };

    renderSheet();

    expect(screen.getByTestId("volunteer-badges-error")).toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-badges-empty")).toBeNull();
  });

  it("explains an empty roster in terms of approval, not absence", () => {
    setSignups([signup({ id: "s-pending", status: "PENDING" })]);

    renderSheet();

    const empty = screen.getByTestId("volunteer-badges-empty");
    expect(empty).toBeInTheDocument();
    expect(
      screen.getByTestId("volunteer-badges-issue-action"),
    ).toBeDisabled();
  });

  it("reports approved signups that have no linked account", () => {
    setSignups([
      signup({ id: "s-ok", humanId: "h-ok" }),
      signup({ id: "s-orphan", humanId: null }),
    ]);

    renderSheet();

    expect(
      screen.getByText(
        /1 approved signup has no linked account and cannot be issued a badge/,
      ),
    ).toBeInTheDocument();
  });

  it("holds Issue closed until the whole roster has loaded", () => {
    // The server caps a page at 200. A run that silently stopped there would
    // leave volunteer 201 at a door with no credential and no explanation, so
    // the button waits for the tail.
    signupsQuery.current = {
      data: {
        items: [signup({ id: "s-alex" })],
        pageInfo: { total: 250 },
      },
      isLoading: false,
      error: null,
    };
    listFetch.fn.mockReturnValue(new Promise(() => {}));

    renderSheet();

    expect(screen.getByTestId("volunteer-badges-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("volunteer-badges-manifest")).toBeNull();
  });
});
