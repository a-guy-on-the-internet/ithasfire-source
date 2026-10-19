import { screen } from "@testing-library/react";
import { renderWithProvider } from "../../../../../test/utils";
import { Link } from "../navigation/Link";

describe("Link", () => {
  it("renders internal links using an anchor with the correct href", () => {
    renderWithProvider(<Link href="/privacy">Privacy</Link>);

    const el = screen.getByText("Privacy");
    const anchor = el.closest("a");
    expect(anchor).toBeInTheDocument();
    // JSDOM may expand to an absolute URL, but path should be present
    expect(anchor).toHaveAttribute("href");
    expect(anchor?.getAttribute("href")).toContain("/privacy");
  });

  it("adds noopener noreferrer when target is _blank on external links", () => {
    renderWithProvider(
      <Link href="https://example.com" target="_blank">
        External
      </Link>,
    );

    const el = screen.getByText("External");
    const anchor = el.closest("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
  });
});
