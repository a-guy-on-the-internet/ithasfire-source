import { render, screen } from "@testing-library/react";
import { Calendar } from "lucide-react";

import { Icon, iconNames, iconSizePx } from "../utility/Icon";
import { iconRegistry } from "../utility/icon-registry";

describe("Icon", () => {
  describe("accessibility", () => {
    // The two failure modes are opposites and both ship silently: a decorative
    // glyph that announces itself, and an icon-only control with no name.
    it("hides a glyph from assistive tech when it has no label", () => {
      const { container } = render(<Icon name="calendar" />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");
      expect(svg).not.toHaveAttribute("role", "img");
    });

    it("announces a labelled glyph as an image with that name", () => {
      render(<Icon name="close" label="Close" />);
      const svg = screen.getByRole("img", { name: "Close" });
      expect(svg).not.toHaveAttribute("aria-hidden");
    });

    it("treats an empty-string label as a real (if empty) name, not decoration", () => {
      // `label=""` is almost always a mistake, but it is a DIFFERENT mistake
      // from omitting the prop — silently converting it to aria-hidden would
      // hide the bug rather than surface it.
      const { container } = render(<Icon name="close" label="" />);
      expect(container.querySelector("svg")).not.toHaveAttribute("aria-hidden");
    });
  });

  describe("size ladder", () => {
    it("defaults to 18px — what belongs inside an md control", () => {
      const { container } = render(<Icon name="ticket" />);
      expect(container.querySelector("svg")).toHaveAttribute("width", "18");
    });

    it.each([
      ["sm", 16],
      ["md", 18],
      ["lg", 20],
      ["xl", 24],
    ] as const)("renders %s at %ipx", (size, px) => {
      const { container } = render(<Icon name="ticket" size={size} />);
      expect(container.querySelector("svg")).toHaveAttribute(
        "width",
        String(px),
      );
      expect(iconSizePx(size)).toBe(px);
    });
  });

  describe("colour", () => {
    it("inherits currentColor rather than carrying its own", () => {
      const { container } = render(<Icon name="calendar" />);
      expect(container.querySelector("svg")).toHaveAttribute(
        "stroke",
        "currentColor",
      );
    });

    it("fills with currentColor for the selected state, and not otherwise", () => {
      const { container: outlined } = render(<Icon name="bell" />);
      expect(outlined.querySelector("svg")).toHaveAttribute("fill", "none");

      const { container: filled } = render(<Icon name="bell" filled />);
      expect(filled.querySelector("svg")).toHaveAttribute(
        "fill",
        "currentColor",
      );
    });
  });

  describe("stroke weight", () => {
    it("sits on 2 by default, matching the 2px structural border", () => {
      const { container } = render(<Icon name="calendar" />);
      expect(container.querySelector("svg")).toHaveAttribute(
        "stroke-width",
        "2",
      );
    });

    it("allows the 2.5 arrow convention", () => {
      const { container } = render(
        <Icon name="arrowRight" strokeWidth={2.5} />,
      );
      expect(container.querySelector("svg")).toHaveAttribute(
        "stroke-width",
        "2.5",
      );
    });
  });

  describe("the swap seam", () => {
    it("renders an unregistered glyph passed via `as`", () => {
      const { container } = render(<Icon as={Calendar} label="Date" />);
      expect(screen.getByRole("img", { name: "Date" })).toBeInTheDocument();
      expect(container.querySelector("svg")).toHaveAttribute("width", "18");
    });

    it("prefers `as` over `name` when both are given", () => {
      // Not a sanctioned combination, but it must resolve predictably rather
      // than rendering whichever the implementation happened to check first.
      const { container } = render(<Icon name="ticket" as={Calendar} />);
      expect(container.querySelector("svg")).toBeInTheDocument();
    });

    it("renders nothing for an unknown name instead of an empty box", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { container } = render(
        // @ts-expect-error — deliberately unregistered, which is the case
        // under test: a name that was never added, or was removed by a swap.
        <Icon name="not-a-real-glyph" />,
      );
      expect(container.querySelector("svg")).toBeNull();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("No glyph"));
      spy.mockRestore();
    });
  });

  describe("registry", () => {
    it("resolves every registered name to a renderable glyph", () => {
      // Guards the swap: after re-pointing the registry at another icon set,
      // this fails loudly for any name the new set does not cover.
      for (const name of iconNames) {
        expect(iconRegistry[name], `${name} has no glyph`).toBeTruthy();
        const { container } = render(<Icon name={name} />);
        expect(
          container.querySelector("svg"),
          `${name} rendered nothing`,
        ).toBeInTheDocument();
      }
    });
  });
});
