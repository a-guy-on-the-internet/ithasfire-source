import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * FR-016 — the staff "preview as an organizer" is the ORGANIZER'S component.
 *
 * The only difference between the two callers is the per-role action: the
 * organizer gets "Customise", staff get nothing (they are looking, not
 * forking). Everything else — the pack card, the blurb, the shift counts — has
 * to come out of one renderer, or the preview stops previewing.
 */

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-")) {
        safe[key] = value;
      }
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={rest["data-testid"]}>{children}</span>,
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.values(params).join(" ")}` : key,
}));

import { PackRoleCatalogue } from "../PackRoleCatalogue";

const PACK = {
  id: "11111111-1111-4111-8111-111111111111",
  key: "house-show",
  name: "House show",
  blurb: "Six roles for a living-room gig.",
  roles: [
    {
      id: "role-1",
      name: "Door",
      packId: "11111111-1111-4111-8111-111111111111",
      shifts: [{}, {}],
    },
    {
      id: "role-2",
      name: "Sound",
      packId: "11111111-1111-4111-8111-111111111111",
      shifts: [],
    },
  ],
};

describe("PackRoleCatalogue", () => {
  it("renders the pack read-only when no role action is supplied", () => {
    render(<PackRoleCatalogue packs={[PACK]} testId="preview" />);

    const card = screen.getByTestId("volunteer-pack-house-show");
    expect(card.textContent).toContain("House show");
    expect(card.textContent).toContain("Six roles for a living-room gig.");
    expect(card.textContent).toContain("Door");
    expect(card.textContent).toContain("Sound");
    // Two shifts on one role, none on the other — the difference the staff
    // curator is checking before publishing.
    expect(card.textContent).toContain("admin.volunteerShiftCount 2");
    expect(card.textContent).toContain("admin.volunteerShiftEmpty");
    // Staff preview offers nothing to click: no fork, no edit.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the caller's action once per role", () => {
    render(
      <PackRoleCatalogue
        packs={[PACK]}
        renderRoleAction={(role) => (
          <button type="button" data-testid={`customise-${role.id}`}>
            Customise
          </button>
        )}
      />,
    );

    expect(screen.getByTestId("customise-role-1")).toBeTruthy();
    expect(screen.getByTestId("customise-role-2")).toBeTruthy();
  });

  it("renders a staff-authored blurb as text, never as markup", () => {
    render(
      <PackRoleCatalogue
        packs={[
          {
            ...PACK,
            blurb: "<script>alert(1)</script> Bring your own gaffer.",
          },
        ]}
      />,
    );

    const card = screen.getByTestId("volunteer-pack-house-show");
    // NFR-004: escaped on output, no HTML passthrough.
    expect(card.querySelector("script")).toBeNull();
    expect(card.textContent).toContain("<script>alert(1)</script>");
  });
});
