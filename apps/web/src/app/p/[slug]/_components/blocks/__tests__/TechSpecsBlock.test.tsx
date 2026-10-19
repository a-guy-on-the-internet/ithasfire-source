import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

vi.mock("@th/ui", () => ({
  // Key-echo translator (same convention as VenueStatsBlock.test.tsx).
  useTranslations: () => (key: string) => key,
}));

import { TechSpecsBlock } from "../TechSpecsBlock";

/**
 * TechSpecsBlock (venue tech-spec sheet — the venue-side rider): pins
 *  - label/value rows render as a semantic <dl> spec sheet,
 *  - empty/malformed rows are skipped,
 *  - the block renders NOTHING when no usable rows and no notes exist
 *    (matching the other venue-fact blocks' empty behaviour), and
 *  - the optional notes paragraph renders below the sheet (or alone).
 */

function makeBlock(data: unknown): PageBlockRecord {
  return {
    id: "block-1",
    pageId: "page-1",
    kind: "tech_specs",
    orderIndex: 0,
    data,
    visible: true,
  };
}

describe("TechSpecsBlock", () => {
  it("renders label/value rows and the default (translated) heading", () => {
    render(
      <TechSpecsBlock
        block={makeBlock({
          specs: [
            { label: "PA", value: "d&b line array + subs" },
            { label: "Monitors", value: "10 mixes, wedges + fills" },
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "techSpecs.heading" }),
    ).toBeInTheDocument();
    expect(screen.getByText("PA")).toBeInTheDocument();
    expect(screen.getByText("d&b line array + subs")).toBeInTheDocument();
    expect(screen.getByText("Monitors")).toBeInTheDocument();
    expect(screen.getByText("10 mixes, wedges + fills")).toBeInTheDocument();
    // Semantic spec sheet: dt/dd pairs inside a definition list. (The "term"
    // role prohibits name-from-content, so assert by count + tag.)
    expect(screen.getAllByRole("term")).toHaveLength(2);
    expect(screen.getAllByRole("definition")).toHaveLength(2);
    expect(screen.getByText("PA").tagName).toBe("DT");
    expect(screen.getByText("d&b line array + subs").tagName).toBe("DD");
  });

  it("uses the stored heading when present and renders notes below the sheet", () => {
    render(
      <TechSpecsBlock
        block={makeBlock({
          heading: "Production specs",
          specs: [{ label: "Power", value: "200A three-phase" }],
          notes: "Full stage plot on advance.",
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Production specs" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Full stage plot on advance.")).toBeInTheDocument();
  });

  it("skips empty and malformed rows", () => {
    render(
      <TechSpecsBlock
        block={makeBlock({
          specs: [
            { label: "PA", value: "House rig" },
            {}, // stray "Add item" row
            { label: "Console" }, // value missing
            { label: "   ", value: "orphan value" }, // blank label
            { label: 42, value: ["not", "a", "string"] }, // malformed types
          ],
        })}
      />,
    );

    expect(screen.getAllByRole("definition")).toHaveLength(1);
    expect(screen.getByText("House rig")).toBeInTheDocument();
    expect(screen.queryByText("Console")).not.toBeInTheDocument();
    expect(screen.queryByText("orphan value")).not.toBeInTheDocument();
  });

  it("renders nothing when there are no usable rows and no notes", () => {
    const { container: empty } = render(
      <TechSpecsBlock block={makeBlock({ specs: [] })} />,
    );
    expect(empty).toBeEmptyDOMElement();

    const { container: allBlank } = render(
      <TechSpecsBlock block={makeBlock({ specs: [{}, { label: "PA" }] })} />,
    );
    expect(allBlank).toBeEmptyDOMElement();

    const { container: noData } = render(
      <TechSpecsBlock block={makeBlock(undefined)} />,
    );
    expect(noData).toBeEmptyDOMElement();
  });

  it("renders notes alone when no rows survive", () => {
    render(
      <TechSpecsBlock
        block={makeBlock({ notes: "Specs available on request." })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "techSpecs.heading" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Specs available on request."),
    ).toBeInTheDocument();
  });
});
