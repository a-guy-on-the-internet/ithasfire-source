import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * CommunityListingNotice — the "Suggest an edit" affordance.
 *
 * `event-suggest-edit-btn` is the ONLY route to suggest-edit on a community
 * listing. It used to live in the floating contextual action bar, whose
 * config was the last machine-checked statement that the action existed; the
 * bar was removed 2026-08-27 and the config was retired into a prose comment
 * (`bar-configs.ts`) rather than a test. The same migration already shipped
 * this exact bug once — inlined entity-hero actions silently vanished from the
 * `stack`/`grid` venue layouts because grep-level confidence replaced a test.
 * This suite is the guard for the event-detail half.
 */

// ── DOM-level stand-ins for the styling layer ────────────────────────────────
// Mirrors EventContent.test.tsx: forward only DOM-safe attributes so
// `data-testid` markers survive Tamagui's styled() wrappers.

const pickDomProps = (rest: Record<string, unknown>) => {
  const domProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") {
      domProps[key] = value;
    }
  }
  return domProps;
};

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  );
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

const MESSAGES: Record<string, string> = {
  "communityListing.byline": "Maintained by the community",
  "communityListing.infoAria": "How community listings work",
  "communityListing.howItWorks": "How this works",
  "communityListing.title": "Community listing",
  "communityListing.body": "Anyone can suggest changes.",
  "pageActions.suggestEdit": "Suggest an edit",
  "communityPlacePage.byline":
    "Community-maintained · moderators keep this page until the place is claimed",
  "communityPlacePage.infoAria": "About community-maintained pages",
  "communityPlacePage.title": "Community-maintained page",
  "communityPlacePage.body": "Nobody has claimed this place yet.",
  "communityPlacePage.lastChanged": "Last changed {date}",
  "communityPlacePage.bylineUnreviewed":
    "Community-maintained · written by moderators",
  "communityPlacePage.bodyUnreviewed":
    "Community moderators wrote this page. Nobody who runs the place has reviewed it yet.",
};

vi.mock("@th/ui", () => ({
  // The real `@th/ui` Link forwards `data-*` to its anchor; keep that here so
  // the testid assertion below is a real assertion and not a mock artifact.
  Link: ({
    href,
    children,
    ...rest
  }: { href?: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...pickDomProps(rest)}>
      {children}
    </a>
  ),
  Text: ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <span {...pickDomProps(rest)}>{children}</span>
  ),
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      let out = MESSAGES[key] ?? key;
      for (const [k, v] of Object.entries(values ?? {})) {
        out = out.replace(`{${k}}`, String(v));
      }
      return out;
    },
  useLocale: () => "en-US",
  DateTime: { format: (value: string) => `DATE(${value})` },
}));

import {
  CommunityListingNotice,
  placeClaimableFrom,
} from "../CommunityListingNotice";

describe("CommunityListingNotice — suggest-edit affordance", () => {
  it("renders `event-suggest-edit-btn` pointing at suggestEditHref", () => {
    render(<CommunityListingNotice suggestEditHref="/events/foo/suggest" />);

    const link = screen.getByTestId("event-suggest-edit-btn");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/events/foo/suggest");
    expect(link).toHaveTextContent("Suggest an edit");
  });

  it("renders exactly one suggest-edit control", () => {
    render(<CommunityListingNotice suggestEditHref="/events/foo/suggest" />);

    expect(screen.getAllByTestId("event-suggest-edit-btn")).toHaveLength(1);
  });

  it("omits the control when no suggestEditHref is passed", () => {
    render(<CommunityListingNotice />);

    expect(
      screen.queryByTestId("event-suggest-edit-btn"),
    ).not.toBeInTheDocument();
    // The rest of the notice still renders — the absence is scoped to the
    // action, not the whole byline.
    expect(screen.getByTestId("community-listing-notice")).toBeInTheDocument();
  });
});

describe("CommunityListingNotice — a moderator-kept PLACE page (moderator-place-page D7)", () => {
  it("says moderators keep the page, and never 'anyone can suggest edits'", () => {
    render(
      <CommunityListingNotice
        subject="place"
        placeClaimable
        lastChangedAt="2026-10-12T15:00:00.000Z"
      />,
    );

    const notice = screen.getByTestId("community-place-notice");
    expect(notice).toHaveTextContent(
      "Community-maintained · moderators keep this page until the place is claimed",
    );
    expect(notice).not.toHaveTextContent(/anyone can suggest/i);
    expect(screen.queryByTestId("event-suggest-edit-btn")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "How this works: About community-maintained pages",
      }),
    ).toBeInTheDocument();
  });

  it("renders the date only inside the popover, never in the server-rendered byline", () => {
    render(
      <CommunityListingNotice
        subject="place"
        placeClaimable
        lastChangedAt="2026-10-12T15:00:00.000Z"
      />,
    );
    expect(screen.queryByText(/Last changed/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "How this works: About community-maintained pages",
      }),
    );
    expect(
      screen.getByText("Last changed DATE(2026-10-12T15:00:00.000Z)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Community-maintained page")).toBeInTheDocument();
  });
});

describe("CommunityListingNotice — a claimed place the owner hasn't reviewed", () => {
  it("drops 'until the place is claimed' and 'Nobody has claimed'", () => {
    render(
      <CommunityListingNotice
        subject="place"
        placeClaimable={false}
        lastChangedAt="2026-10-12T15:00:00.000Z"
      />,
    );
    const notice = screen.getByTestId("community-place-notice");
    expect(notice).toHaveTextContent(
      "Community-maintained · written by moderators",
    );
    expect(notice).not.toHaveTextContent(/until the place is claimed/);

    fireEvent.click(
      screen.getByRole("button", {
        name: "How this works: About community-maintained pages",
      }),
    );
    expect(
      screen.getByText(
        "Community moderators wrote this page. Nobody who runs the place has reviewed it yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nobody has claimed/)).toBeNull();
  });

  it("the info button's name starts with its visible label, for listings too", () => {
    render(<CommunityListingNotice />);
    expect(
      screen.getByRole("button", {
        name: "How this works: How community listings work",
      }),
    ).toHaveTextContent("How this works");
  });
});

describe("placeClaimableFrom", () => {
  it("is true only when the summary says the place is claimable", () => {
    expect(placeClaimableFrom({ claimable: true })).toBe(true);
    expect(placeClaimableFrom({ claimable: false })).toBe(false);
  });

  it("is false when the summary carries no claimable flag", () => {
    expect(placeClaimableFrom({ id: "place-1" })).toBe(false);
  });
});
