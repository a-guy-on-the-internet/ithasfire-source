import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { Card } from "../display/Card";

describe("Card", () => {
  it("renders headline content, stats, and call to action", () => {
    renderWithProvider(
      <Card
        eyebrow="Spotlight playbook"
        title="Bundle VIP access with on-site perks"
        description="Give superfans a reason to convert early. Combine merch, guaranteed check-in, and rapid pickup to lift margin without surprise fees."
        stats={[
          { label: "Attachment rate", value: "38%" },
          {
            label: "Average margin",
            value: "$64.20",
            helperText: "+$23 vs baseline",
          },
        ]}
        primaryMetricLabel="Projected uplift"
        primaryMetricValue="+$12,640"
        ctaLabel="Plan the bundle"
      />,
    );

    expect(screen.getByText("Spotlight playbook")).toBeVisible();
    expect(
      screen.getByText("Bundle VIP access with on-site perks"),
    ).toBeVisible();
    expect(screen.getByText("Attachment rate")).toBeVisible();
    expect(screen.getByText("38%")).toBeVisible();
    expect(screen.getByText("Projected uplift")).toBeVisible();
    expect(screen.getByText("+$12,640")).toBeVisible();
    expect(screen.getByText("Plan the bundle")).toBeVisible();
  });

  it("omits optional sections when data is absent", () => {
    renderWithProvider(
      <Card
        eyebrow="Crew briefing"
        title="Streamline doors-open check-in"
        description="Use scanner roles and offline QR fallbacks to cut queues in half and keep staff calm."
      />,
    );

    expect(screen.queryByText("Projected uplift")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Plan the bundle" }),
    ).not.toBeInTheDocument();
  });
});
