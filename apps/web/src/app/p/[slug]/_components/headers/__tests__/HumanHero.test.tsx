import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";

/**
 * HumanHero: the at-a-glance rail derives role chips from the human's declared
 * jobs (settings) — up to two, localized via the shared `account.sJob*` keys,
 * with OTHER rendering its free-text description — and falls back to the
 * generic "Artist" chip when nothing is declared so pre-existing pages don't
 * regress. The hero also gains a secondary Booking CTA that scrolls to the
 * footer booking anchor only when the layout says booking contact exists.
 */

vi.mock("@th/ui", () => ({
  // Key-echo translator (same convention as OrgHero.test.tsx).
  useTranslations: () => (key: string) => key,
}));

vi.mock("../../FollowButton", () => ({
  FollowButton: () => <button type="button">follow</button>,
}));

vi.mock("../../ProfileShareButton", () => ({
  ProfileShareButton: () => <button type="button">share</button>,
}));

// The hero `⋯` overflow is a client island (session, overlay, report dialog,
// shared Popover) with its own test file — stubbed so these suites stay about
// the heroes' own gating logic.
vi.mock("../../EntityHeroActions", () => ({
  EntityHeroActions: () => <button type="button">more-actions</button>,
}));

// The CTA's internals (session, overlay, dialog) get their own test —
// here only the heroes' gating/replacement logic is under test.
vi.mock("../HeroPerformerBookingButton", () => ({
  HeroPerformerBookingButton: () => (
    <button type="button">request-to-book</button>
  ),
}));

import { HumanHero, deriveRoleChips } from "../HumanHero";

const PAGE: EntityPageRecord = {
  id: "page-1",
  ownerType: "HUMAN",
  ownerId: "human-1",
  slug: "jo-artist",
  displayName: "Jo Artist",
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC",
  allowFollows: true,
  showFollowerCount: true,
  category: "musician",
  templateAppliedCategories: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

type HumanEntity = Extract<EntitySummary, { type: "HUMAN" }>;

function makeEntity(overrides: Partial<HumanEntity> = {}): HumanEntity {
  return {
    type: "HUMAN",
    id: "human-1",
    name: "Jo Artist",
    jobs: [],
    genreTags: [],
    otherJobDescription: null,
    ...overrides,
  };
}

function renderHero({
  entity = makeEntity(),
  genres = [] as string[],
  hasBooking = false,
} = {}) {
  return render(
    <HumanHero
      page={PAGE}
      entity={entity}
      genres={genres}
      bookingAnchorId="human-booking"
      hasBooking={hasBooking}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HumanHero role chips", () => {
  it("keeps the generic Artist chip when no jobs are declared", () => {
    renderHero();
    expect(screen.getByText("profileStd.artistLabel")).toBeInTheDocument();
  });

  it("renders up to two localized job chips and drops the Artist fallback", () => {
    renderHero({
      entity: makeEntity({ jobs: ["MUSICIAN", "DJ", "COMEDIAN"] }),
    });
    expect(screen.getByText("account.sJobMusician")).toBeInTheDocument();
    expect(screen.getByText("account.sJobDj")).toBeInTheDocument();
    // Max two role chips.
    expect(screen.queryByText("account.sJobComedian")).not.toBeInTheDocument();
    expect(
      screen.queryByText("profileStd.artistLabel"),
    ).not.toBeInTheDocument();
  });

  it("renders OTHER as the free-text description", () => {
    renderHero({
      entity: makeEntity({
        jobs: ["OTHER"],
        otherJobDescription: "Tour manager",
      }),
    });
    expect(screen.getByText("Tour manager")).toBeInTheDocument();
  });

  it("skips OTHER without a description, letting the next job take the slot", () => {
    renderHero({
      entity: makeEntity({ jobs: ["OTHER", "MUSICIAN"] }),
    });
    expect(screen.getByText("account.sJobMusician")).toBeInTheDocument();
    expect(
      screen.queryByText("profileStd.artistLabel"),
    ).not.toBeInTheDocument();
  });

  it("still renders genre chips from the layout", () => {
    renderHero({ genres: ["Indie Rock", "Shoegaze"] });
    expect(screen.getByText("Indie Rock")).toBeInTheDocument();
    expect(screen.getByText("Shoegaze")).toBeInTheDocument();
  });
});

describe("deriveRoleChips", () => {
  it("ignores unknown job values", () => {
    expect(deriveRoleChips(["NOT_A_JOB", "DJ"], null)).toEqual([
      { key: "DJ", labelKey: "account.sJobDj" },
    ]);
  });

  it("truncates a long OTHER description with an ellipsis", () => {
    const long =
      "Session player and touring keyboard technician extraordinaire";
    const [chip] = deriveRoleChips(["OTHER"], long);
    expect(chip?.text?.endsWith("…")).toBe(true);
    expect(chip!.text!.length).toBeLessThanOrEqual(32);
  });

  it("returns an empty list when only an empty OTHER is declared", () => {
    expect(deriveRoleChips(["OTHER"], "   ")).toEqual([]);
  });
});

describe("HumanHero request-to-book CTA (organizer-booking-requests FR-009)", () => {
  it("does not render the CTA when the entity does not accept booking requests", () => {
    renderHero({ entity: makeEntity() });
    expect(
      screen.queryByRole("button", { name: "request-to-book" }),
    ).not.toBeInTheDocument();

    // Strict-true gate: an explicit false stays off too.
    renderHero({ entity: makeEntity({ acceptsBookingRequests: false }) });
    expect(
      screen.queryByRole("button", { name: "request-to-book" }),
    ).not.toBeInTheDocument();
  });

  it("renders the CTA when the entity accepts booking requests", () => {
    renderHero({ entity: makeEntity({ acceptsBookingRequests: true }) });
    expect(
      screen.getByRole("button", { name: "request-to-book" }),
    ).toBeInTheDocument();
  });

  it("replaces the scroll-to-contact Booking button when the CTA renders", () => {
    renderHero({
      entity: makeEntity({ acceptsBookingRequests: true }),
      hasBooking: true,
    });
    expect(
      screen.getByRole("button", { name: "request-to-book" }),
    ).toBeInTheDocument();
    // One primary booking affordance: the scroll button is suppressed even
    // though the page has booking contact info.
    expect(
      screen.queryByRole("button", { name: "profileStd.bookingCtaAria" }),
    ).not.toBeInTheDocument();
  });
});

describe("HumanHero booking CTA", () => {
  it("does not render the Booking button when the page has no booking contact", () => {
    renderHero({ hasBooking: false });
    expect(
      screen.queryByRole("button", { name: "profileStd.bookingCtaAria" }),
    ).not.toBeInTheDocument();
  });

  it("renders a real button that scrolls to and focuses the booking anchor", () => {
    const target = document.createElement("section");
    target.id = "human-booking";
    target.tabIndex = -1;
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    try {
      renderHero({ hasBooking: true });
      const button = screen.getByRole("button", {
        name: "profileStd.bookingCtaAria",
      });
      fireEvent.click(button);
      expect(target.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ block: "start" }),
      );
      expect(document.activeElement).toBe(target);
    } finally {
      target.remove();
    }
  });
});
