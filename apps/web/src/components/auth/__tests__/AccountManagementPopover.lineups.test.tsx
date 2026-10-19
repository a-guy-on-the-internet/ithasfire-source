import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";

import enApp from "@/i18n/messages/en";

import {
  AccountManagementPopover,
  type AccountManagementPopoverProps,
  type AccountMenuNextNight,
  type AccountMenuOrganization,
} from "../AccountManagementPopover";

/**
 * The account menu, Option B: identity, then Going / Playing / Organizing,
 * Platform for staff, and a Settings | Sign out footer. An optional
 * next-night block (Option A) sits between the identity header and Going.
 */

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

const org = (n: number): AccountMenuOrganization => ({
  slug: `org-${n}`,
  name: `Organisation ${n}`,
  role: "OWNER",
  avatarUrl: null,
  href: `/admin/org-${n}`,
});

const renderPopover = (
  props: Partial<AccountManagementPopoverProps> = {},
) =>
  render(
    <IthasFireProvider>
      <TranslationProvider locale="en" messages={messages}>
        <AccountManagementPopover
          defaultOpen
          trigger={<button type="button">account</button>}
          hub={{ href: "/admin/@me" }}
          onSignOutAction={() => {}}
          {...props}
        />
      </TranslationProvider>
    </IthasFireProvider>,
  );

describe("AccountManagementPopover — identity", () => {
  it("shows the name and @handle", () => {
    renderPopover({
      identity: { name: "Ada Lovelace", handle: "ada", avatarUrl: null },
    });
    const header = screen.getByTestId("account-popover-identity");
    expect(header.textContent).toContain("Ada Lovelace");
    expect(header.textContent).toContain("@ada");
    // Initials fallback when there is no avatar.
    expect(header.textContent).toContain("AL");
  });

  it("swaps a failed identity avatar image for initials", () => {
    renderPopover({
      identity: {
        name: "Ada Lovelace",
        handle: "ada",
        avatarUrl: "https://x.test/broken.png",
      },
    });
    const header = screen.getByTestId("account-popover-identity");
    const img = header.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(header.querySelector("img")).toBeNull();
    expect(header.textContent).toContain("AL");
  });

  it("omits the handle line when the person has no username", () => {
    renderPopover({
      identity: { name: "Ada Lovelace", handle: null, avatarUrl: null },
    });
    const header = screen.getByTestId("account-popover-identity");
    expect(header.textContent).not.toContain("@");
  });
});

describe("AccountManagementPopover — Going", () => {
  it("always shows tickets and RSVPs, and no separate saved row", () => {
    renderPopover();
    expect(
      screen.getByTestId("account-popover-tickets").getAttribute("href"),
    ).toBe("/my-tickets");
    expect(
      screen.getByTestId("account-popover-rsvps").getAttribute("href"),
    ).toBe("/my-rsvps");
    expect(screen.queryByTestId("account-popover-saved")).toBeNull();
  });
});

describe("AccountManagementPopover — focus on open", () => {
  // Opening by mouse must not paint a focus ring on the first row: the panel
  // itself takes focus, and Tab moves on to the rows.
  it("focuses the labelled panel, not the first row", async () => {
    renderPopover();
    const dialog = screen.getByRole("dialog");
    expect(dialog.tabIndex).toBe(-1);
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });
});

describe("AccountManagementPopover — Playing", () => {
  it("links to /my-lineups when performer mode is on", () => {
    renderPopover({ myLineups: { href: "/my-lineups" } });
    const link = screen.getByTestId("account-popover-lineups");
    expect(link.getAttribute("href")).toBe("/my-lineups");
    expect(link.textContent).toContain("My lineups");
    expect(screen.getByText("Playing")).toBeTruthy();
  });

  it("renders no Playing section when the prop is omitted", () => {
    renderPopover();
    expect(screen.queryByTestId("account-popover-lineups")).toBeNull();
    expect(screen.queryByText("Playing")).toBeNull();
  });
});

describe("AccountManagementPopover — Organizing", () => {
  it("keeps the hub and New event with zero organisations", () => {
    const onCreateEvent = vi.fn();
    renderPopover({ onCreateEvent });
    expect(
      screen.getByTestId("account-popover-dashboard").getAttribute("href"),
    ).toBe("/admin/@me");
    expect(screen.getByTestId("account-popover-dashboard").textContent).toBe(
      "Your hub",
    );
    fireEvent.click(screen.getByTestId("account-popover-create-event"));
    expect(onCreateEvent).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("account-popover-all-orgs")).toBeNull();
  });

  it("hides New event when no create action is given", () => {
    renderPopover();
    expect(screen.queryByTestId("account-popover-create-event")).toBeNull();
  });

  it("lists an organisation with its role", () => {
    renderPopover({
      organizations: [{ ...org(1), role: "FINANCE" }],
    });
    const row = screen.getByTestId("account-popover-org-org-1");
    expect(row.getAttribute("href")).toBe("/admin/org-1");
    expect(row.textContent).toContain("Organisation 1");
    expect(row.textContent).toContain("Finance");
  });

  it("gives the org link an accessible name with a separator", () => {
    renderPopover({ organizations: [{ ...org(1), role: "FINANCE" }] });
    expect(
      screen.getByRole("link", { name: "Organisation 1, Finance" }),
    ).toBeTruthy();
  });

  it("puts the role on its own line under the name, inside the one link", () => {
    renderPopover({ organizations: [{ ...org(1), role: "FINANCE" }] });
    const row = screen.getByTestId("account-popover-org-org-1");
    const name = screen.getByText("Organisation 1");
    const role = screen.getByText("Finance");
    expect(row.contains(role)).toBe(true);
    // Same text column as the name, not a right-aligned sibling of the row.
    expect(role.parentElement).toBe(name.parentElement);
    expect(row.querySelectorAll("a").length).toBe(0);
  });

  it("swaps a failed org avatar image for initials", () => {
    renderPopover({
      organizations: [{ ...org(1), avatarUrl: "https://x.test/broken.png" }],
    });
    const row = screen.getByTestId("account-popover-org-org-1");
    const img = row.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(row.querySelector("img")).toBeNull();
    expect(row.textContent).toContain("O1");
  });

  it("shows three organisations, then All organisations", () => {
    renderPopover({ organizations: [org(1), org(2), org(3), org(4)] });
    expect(screen.getByTestId("account-popover-org-org-3")).toBeTruthy();
    expect(screen.queryByTestId("account-popover-org-org-4")).toBeNull();
    const all = screen.getByTestId("account-popover-all-orgs");
    expect(all.getAttribute("href")).toBe("/admin");
  });

  it("shows no All organisations row at exactly three", () => {
    renderPopover({ organizations: [org(1), org(2), org(3)] });
    expect(screen.queryByTestId("account-popover-all-orgs")).toBeNull();
  });

  it("no longer offers Manage events", () => {
    renderPopover();
    expect(screen.queryByTestId("account-popover-events")).toBeNull();
  });
});

describe("AccountManagementPopover — platform and footer", () => {
  it("shows Platform only for staff", () => {
    renderPopover();
    expect(screen.queryByTestId("account-popover-platform")).toBeNull();
  });

  it("puts Settings and Sign out in the footer", () => {
    const onSignOutAction = vi.fn();
    renderPopover({ platform: { href: "/platform" }, onSignOutAction });
    expect(
      screen.getByTestId("account-popover-platform").getAttribute("href"),
    ).toBe("/platform");
    expect(
      screen.getByTestId("account-popover-manage").getAttribute("href"),
    ).toBe("/account/settings");
    const signOut = screen.getByTestId("account-popover-signout");
    // Same row: the footer cells are siblings around the vertical rule.
    expect(signOut.parentElement).toBe(
      screen.getByTestId("account-popover-manage").parentElement,
    );
    // No icons: the labels need the room (Spanish "Cerrar sesión").
    expect(signOut.querySelector("svg")).toBeNull();
    expect(
      screen.getByTestId("account-popover-manage").querySelector("svg"),
    ).toBeNull();
    fireEvent.click(signOut);
    expect(onSignOutAction).toHaveBeenCalledTimes(1);
  });
});

describe("AccountManagementPopover — next night", () => {
  const night = (
    over: Partial<AccountMenuNextNight> = {},
  ): AccountMenuNextNight => ({
    kind: "ticket",
    title: "Low Lights at the Turf",
    // 8:00 PM in Chicago on Friday 10 October 2025.
    startsAt: "2025-10-11T01:00:00.000Z",
    timezone: "America/Chicago",
    placeLabel: "Turf Club, St Paul",
    ticketCount: 2,
    href: "/my-tickets/order-1",
    ...over,
  });

  it("renders nothing when the prop is absent or null", () => {
    const { unmount } = renderPopover();
    expect(screen.queryByTestId("account-popover-next-night")).toBeNull();
    expect(screen.queryByTestId("account-popover-next-night-open")).toBeNull();
    unmount();
    renderPopover({ nextNight: null });
    expect(screen.queryByTestId("account-popover-next-night")).toBeNull();
  });

  it.each([
    ["ticket", "Next up", "Show my tickets"],
    ["lineup", "You\u2019re playing", "Open event"],
    ["rsvp", "You\u2019re going", "Open event"],
  ] as const)("kind %s shows its kicker and button", (kind, kicker, label) => {
    renderPopover({ nextNight: night({ kind }) });
    const block = screen.getByTestId("account-popover-next-night");
    expect(block.getAttribute("role")).toBe("group");
    expect(block.getAttribute("aria-label")).toBe(kicker);
    expect(block.textContent).toContain(kicker);
    const link = screen.getByTestId("account-popover-next-night-open");
    expect(link.textContent).toBe(label);
    expect(link.getAttribute("aria-label")).toBe(
      `${label}: Low Lights at the Turf`,
    );
  });

  it("shows the venue-local date, time and ticket count for a ticket", () => {
    renderPopover({ nextNight: night() });
    const block = screen.getByTestId("account-popover-next-night");
    expect(block.textContent).toContain("Fri, Oct 10 · 8:00 PM · 2 tickets");
  });

  it("accepts a Date for startsAt", () => {
    renderPopover({
      nextNight: night({ startsAt: new Date("2025-10-11T01:00:00.000Z") }),
    });
    expect(
      screen.getByTestId("account-popover-next-night").textContent,
    ).toContain("Fri, Oct 10 · 8:00 PM");
  });

  it("labels the zone when the venue zone is invalid", () => {
    renderPopover({
      nextNight: night({ timezone: "Not/AZone", ticketCount: null }),
    });
    const text =
      screen.getByTestId("account-popover-next-night").textContent ?? "";
    // The viewer's clock, labelled: "… 8:00 PM CDT", "… 2:00 AM GMT+1".
    expect(text).toMatch(/\d{1,2}:\d{2}\s?[AP]M [A-Z][A-Za-z0-9+:-]+/);
  });

  it("says 1 ticket for a single ticket", () => {
    renderPopover({ nextNight: night({ ticketCount: 1 }) });
    // Exact match on the count span: a substring check would pass "1 tickets".
    expect(screen.getByText("· 1 ticket")).toBeTruthy();
  });

  it.each([0, null])("shows no count when ticketCount is %s", (ticketCount) => {
    renderPopover({ nextNight: night({ ticketCount }) });
    expect(
      screen.getByTestId("account-popover-next-night").textContent,
    ).not.toMatch(/\d+ tickets?/i);
  });

  it("keeps the count and its separator together on one line", () => {
    renderPopover({ nextNight: night() });
    const count = screen.getByText("· 2 tickets");
    expect(count.style.whiteSpace).toBe("nowrap");
  });

  it("shows no count for an RSVP", () => {
    renderPopover({ nextNight: night({ kind: "rsvp", ticketCount: 2 }) });
    const block = screen.getByTestId("account-popover-next-night");
    expect(block.textContent).not.toMatch(/\d+ tickets?/i);
  });

  it("puts the caller's href on the link", () => {
    renderPopover({
      nextNight: night({ kind: "rsvp", href: "/events/low-lights" }),
    });
    expect(
      screen
        .getByTestId("account-popover-next-night-open")
        .getAttribute("href"),
    ).toBe("/events/low-lights");
  });

  it("omits the place line when there is no place label", () => {
    renderPopover({ nextNight: night({ placeLabel: null }) });
    const block = screen.getByTestId("account-popover-next-night");
    expect(block.textContent).not.toContain("Turf Club");
  });

  it("closes the menu when the link is clicked", async () => {
    renderPopover({ nextNight: night() });
    const link = screen.getByTestId("account-popover-next-night-open");
    // jsdom cannot navigate; stop the anchor's default so only onClick runs.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() =>
      expect(screen.queryByTestId("account-popover-panel")).toBeNull(),
    );
  });
});
