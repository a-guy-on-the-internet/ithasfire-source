import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MembershipTierCard } from "../MembershipTierCard";

/**
 * The ONE tier-card presentation shared by the entity-page pitch
 * (MembershipsPanel) and the membership embed widget
 * (/embed/memberships/[embedId]). Pins the shared contract: every display
 * field renders, the two optional prose fields are each independently
 * optional, and the `action` slot carries whatever CTA the surface supplies
 * (in-page join button vs link-out anchor).
 */

const tier = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Sustaining Member",
  description: "Keep the lights on.",
  benefitsDescription: "Two free drinks a month.",
};

function renderCard(ui: React.ReactElement) {
  // The card is an <li> — render inside a list so the DOM stays valid.
  return render(<ul>{ui}</ul>);
}

describe("MembershipTierCard", () => {
  it("renders name, price, interval, both prose fields and the tax note", () => {
    renderCard(
      <MembershipTierCard
        tier={tier}
        priceLabel="$10.00"
        intervalLabel="per month"
        taxNote="Plus applicable sales tax"
      />,
    );
    expect(screen.getByText("Sustaining Member")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText("per month")).toBeInTheDocument();
    expect(screen.getByText("Keep the lights on.")).toBeInTheDocument();
    // The owner's claim about what members get is ADDITIVE to the pitch —
    // both render, and neither replaces the other.
    expect(screen.getByText("Two free drinks a month.")).toBeInTheDocument();
    expect(screen.getByText("Plus applicable sales tax")).toBeInTheDocument();
  });

  it("omits the benefits node when the tier has none", () => {
    renderCard(
      <MembershipTierCard
        tier={{ ...tier, benefitsDescription: null }}
        priceLabel="$10.00"
        intervalLabel="per month"
        taxNote="Plus applicable sales tax"
      />,
    );
    expect(
      screen.queryByText("Two free drinks a month."),
    ).not.toBeInTheDocument();
    // The pitch survives independently.
    expect(screen.getByText("Keep the lights on.")).toBeInTheDocument();
  });

  it("omits the description node when the tier has none", () => {
    renderCard(
      <MembershipTierCard
        tier={{ ...tier, description: null }}
        priceLabel="$10.00"
        intervalLabel="per month"
        taxNote="Plus applicable sales tax"
      />,
    );
    expect(screen.queryByText("Keep the lights on.")).not.toBeInTheDocument();
  });

  it("renders the caller's action slot (the embed's link-out anchor shape)", () => {
    renderCard(
      <MembershipTierCard
        tier={tier}
        priceLabel="$10.00"
        intervalLabel="per month"
        taxNote="Plus applicable sales tax"
        action={
          <a
            href="https://ithasfire.com/p/demo?tab=memberships"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Join Sustaining Member on Ithas Fire (opens in a new tab)"
          >
            Join
          </a>
        }
      />,
    );
    const link = screen.getByRole("link", {
      name: "Join Sustaining Member on Ithas Fire (opens in a new tab)",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://ithasfire.com/p/demo?tab=memberships",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
