import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IthasFireProvider } from "@th/ui";

import { PlaceEditSection } from "../PlaceEditSection";
import { OwnershipStatusSection } from "../OwnershipStatusSection";

/**
 * SEMANTICS harness — the one place these components meet the REAL `@th/ui`
 * `Text` and the REAL tamagui stacks.
 *
 * Why it exists: the page-level suites mock `tamagui`'s YStack/XStack down to
 * `<div>{children}</div>` and `@th/ui`'s `Text` down to a `<span>` that
 * forwards only `data-testid`/`id`. Both stand-ins DROP the `tag` prop, so
 * every semantic claim these sections make — `tag="section"` +
 * `aria-labelledby`, `tag="h3"` on the headings, `tag="ul"`/`tag="li"` on the
 * owner list — is entirely unasserted over there, and would stay green if all
 * of it silently became `<div>`s. That is a documented failure mode in this
 * repo, not a hypothetical.
 *
 * It is deliberately NARROW: structure only. Behaviour (gating, the save
 * latch, copy, the save contract) stays in `settings/__tests__/settings-page.test.tsx`,
 * which is far cheaper to run because it mocks the design system away.
 */

// Identity translator so assertions read as keys, matching the sibling suites.
vi.mock("@th/ui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@th/ui");
  return { ...actual, useTranslations: () => (key: string) => key };
});

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} className={rest.className as string | undefined}>
      {children}
    </a>
  ),
}));

const PLACE_ID = "44444444-4444-4444-8444-444444444444";

describe("PlaceEditSection (real @th/ui, real tamagui)", () => {
  it("is a <section> LABELLED by its own <h3>", () => {
    render(
      <IthasFireProvider>
        <PlaceEditSection
          title="admin.placeEditSectionIdentity"
          headingId="identity-heading"
        >
          <span>field</span>
        </PlaceEditSection>
      </IthasFireProvider>,
    );

    const heading = screen.getByText("admin.placeEditSectionIdentity");
    // `tag="h3"` on a kicker-scaled Text: the visual scale and the document
    // outline are set independently, on purpose.
    expect(heading.tagName).toBe("H3");
    expect(heading).toHaveAttribute("id", "identity-heading");

    // A named region, not an anonymous div — that is what makes the form
    // groups reachable from a landmark rotor.
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    expect(section).toHaveAttribute("aria-labelledby", "identity-heading");
  });
});

describe("OwnershipStatusSection (real @th/ui, real tamagui)", () => {
  const renderSection = (
    overrides: Partial<
      React.ComponentProps<typeof OwnershipStatusSection>
    > = {},
  ) =>
    render(
      <IthasFireProvider>
        <OwnershipStatusSection
          placeId={PLACE_ID}
          owners={[
            {
              kind: "ORGANIZATION",
              id: "org-1",
              name: "Basement Collective",
              pageSlug: "basement-collective",
            },
            {
              kind: "HUMAN",
              id: "human-1",
              name: "Dana Reyes",
              pageSlug: null,
            },
          ]}
          status="ACTIVE"
          listedInDirectory
          {...overrides}
        />
      </IthasFireProvider>,
    );

  it("gives both of its headed regions a real <h3>", () => {
    renderSection();

    for (const key of [
      "admin.placeEditOwnersHeading",
      "admin.placeEditStatusHeading",
    ]) {
      expect(screen.getByText(key).tagName, `${key} is not an H3`).toBe("H3");
    }
  });

  it("renders the owners as a real list, one <li> per owner", () => {
    renderSection();

    // `role="list"` is explicit because `list-style: none` makes
    // Safari/VoiceOver treat a <ul> as presentational.
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("UL");
    expect(list).toHaveAttribute("role", "list");

    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Basement Collective");
    expect(items[1]).toHaveTextContent("Dana Reyes");
  });

  it("links an owner with a public page and leaves the other as plain text", () => {
    renderSection();

    expect(
      screen.getByText("Basement Collective").closest("a"),
    ).toHaveAttribute("href", "/orgs/basement-collective");
    expect(screen.getByText("Dana Reyes").closest("a")).toBeNull();
  });

  it("omits the ownership region entirely when owners were never requested", () => {
    renderSection({ owners: undefined });

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("admin.placeEditOwnersHeading")).toBeNull();
    // The rest of the section still renders.
    expect(screen.getByText("admin.placeEditStatusHeading").tagName).toBe("H3");
    expect(screen.getByTestId("place-edit-place-id")).toBeInTheDocument();
  });
});
