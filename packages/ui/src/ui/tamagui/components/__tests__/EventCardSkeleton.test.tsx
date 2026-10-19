import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import { EventCardSkeleton } from "../event-grid";

describe("EventCardSkeleton", () => {
  it("does not forward animationDelay attributes in web mode", () => {
    const { container } = renderWithProvider(
      <EventCardSkeleton animate loading />,
    );

    expect(container.querySelector("[animationdelay]")).toBeNull();
  });

  it("does not fix its width when no width prop is provided", () => {
    renderWithProvider(<EventCardSkeleton animate loading />);

    const skeleton = screen.getByTestId("event-card-skeleton");
    expect((skeleton as HTMLElement).style.width).toBe("");
    expect((skeleton as HTMLElement).style.maxWidth).toBe("");
  });
});
