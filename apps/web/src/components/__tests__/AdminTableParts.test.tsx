import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  Button: ({ children, onPress, ...rest }: any) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (
        k === "data-testid" ||
        k === "disabled" ||
        k === "type" ||
        k.startsWith("aria-") ||
        k.startsWith("on")
      )
        safe[k] = v;
    }
    // Surface the two style inputs the chip grammar depends on so a revert to
    // the deprecated accent outline fails a test instead of passing silently.
    if (rest.variant !== undefined) safe["data-variant"] = rest.variant;
    if (rest.borderColor !== undefined)
      safe["data-border-color"] = rest.borderColor;
    if (rest.backgroundColor !== undefined)
      safe["data-bg"] = rest.backgroundColor;
    if (rest.hoverStyle?.borderColor !== undefined)
      safe["data-hover-border-color"] = rest.hoverStyle.borderColor;
    return (
      <button onClick={onPress} {...safe}>
        {children}
      </button>
    );
  },
  Text: ({ children, ...rest }: any) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k === "data-testid" || k === "id" || k.startsWith("aria-"))
        safe[k] = v;
    }
    return <span {...safe}>{children}</span>;
  },
  TextInput: (props: any) => <input {...props} />,
  Popover: ({ anchor, open, children }: any) => (
    <>
      {anchor}
      {open ? children : null}
    </>
  ),
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

vi.mock("tamagui", () => {
  const passthrough = (tag: string) => (props: any) => {
    // Strip tamagui style props so React doesn't warn about unknown DOM attrs.
    const { children, testID, ...rest } = props;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (
        k === "data-testid" ||
        k === "data-dt-frame" ||
        k === "data-dt-pager" ||
        k === "id" ||
        k === "role" ||
        k === "aria-hidden" ||
        k.startsWith("aria-") ||
        k.startsWith("on")
      ) {
        cleaned[k] = v;
      }
    }
    // Flex props are stripped above (React would warn on unknown DOM attrs),
    // but the wrap fix lives entirely in them — surface them as data-* so the
    // constraint is assertable.
    if (rest.flexShrink !== undefined)
      cleaned["data-flex-shrink"] = String(rest.flexShrink);
    if (rest.flexWrap !== undefined) cleaned["data-flex-wrap"] = rest.flexWrap;
    // The TableContainer frame lives in its per-side border widths.
    for (const side of ["Top", "Bottom", "Left", "Right"] as const) {
      const v = rest[`border${side}Width`];
      if (v !== undefined)
        cleaned[`data-border-${side.toLowerCase()}-width`] = String(v);
    }
    if (rest.borderWidth !== undefined)
      cleaned["data-border-width"] = String(rest.borderWidth);
    return tag === "div" ? (
      <div {...cleaned}>{children}</div>
    ) : (
      <span {...cleaned}>{children}</span>
    );
  };
  return {
    YStack: passthrough("div"),
    XStack: passthrough("div"),
  };
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (node: any) => node };
});

import {
  AdminTableErrorState,
  BulkActionBar,
  FilterChips,
  FilterRow,
  NoResults,
  Pagination,
  TableContainer,
} from "../AdminTableParts";

describe("TableContainer", () => {
  it("draws an open-ledger frame: 2px rules above and below, no side borders", () => {
    render(
      <TableContainer>
        <span data-testid="table-child">table</span>
      </TableContainer>,
    );

    const frame = screen.getByTestId("table-child").parentElement!;
    expect(frame).toHaveAttribute("data-border-top-width", "2");
    expect(frame).toHaveAttribute("data-border-bottom-width", "2");
    expect(frame).toHaveAttribute("data-border-left-width", "0");
    expect(frame).toHaveAttribute("data-border-right-width", "0");
    // A shorthand would redraw the full box over the per-side widths.
    expect(frame).not.toHaveAttribute("data-border-width");
  });

  it("marks itself as the frame owner so DataTable's card list drops its own rules", () => {
    render(
      <TableContainer>
        <span data-testid="table-child">table</span>
      </TableContainer>,
    );
    const frame = screen.getByTestId("table-child").parentElement!;
    // DataTable's injected CSS keys on `[data-dt-frame] .dt-card-list`.
    expect(frame).toHaveAttribute("data-dt-frame", "");
  });
});

describe("FilterChips", () => {
  const options = [
    { value: "DRAFT", label: "Draft" },
    { value: "PUBLISHED", label: "Published" },
  ];

  it("can shrink below its content width so the wrap actually engages", () => {
    // Tamagui's web Stack defaults to `flex-shrink: 0`, so `flex-wrap: wrap`
    // alone never fired: at 320px the container measured 583px inside a 206px
    // parent and the last three chips sat off-screen.
    render(
      <FilterChips options={options} selected={undefined} onSelect={() => {}} />,
    );

    const group = screen.getByRole("group", { name: "Filters" });
    expect(group).toHaveAttribute("data-flex-shrink", "1");
    expect(group).toHaveAttribute("data-flex-wrap", "wrap");
  });

  it("announces the set as a named group, overridable per row", () => {
    const { unmount } = render(
      <FilterChips options={options} selected={undefined} onSelect={() => {}} />,
    );
    expect(screen.getByRole("group", { name: "Filters" })).toBeInTheDocument();
    unmount();

    // Rows carrying two groups must not announce both as "Filters".
    render(
      <FilterChips
        options={options}
        selected={undefined}
        onSelect={() => {}}
        ariaLabel="Verification filter"
      />,
    );
    expect(
      screen.getByRole("group", { name: "Verification filter" }),
    ).toBeInTheDocument();
  });

  it("exposes selection state via aria-pressed, not colour alone", () => {
    const { unmount } = render(
      <FilterChips options={options} selected={undefined} onSelect={() => {}} />,
    );
    for (const label of ["Draft", "Published"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
    unmount();

    render(
      <FilterChips options={options} selected="DRAFT" onSelect={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Draft" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Published" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("marks selection with the v2 .chip.on wash, never the reserved accent fill", () => {
    render(
      <FilterChips options={options} selected="DRAFT" onSelect={() => {}} />,
    );

    const on = screen.getByRole("button", { name: "Draft" });
    const off = screen.getByRole("button", { name: "Published" });

    // Both ride `secondary` (ink label). NOT "outlined" — the DEPRECATED v2
    // accent outline, which painted accent border + accent label on every
    // RESTING chip. NOT "primary" — the full accent fill, reserved by v2 §03
    // for the one primary action per viewport (CREATE EVENT already has it).
    for (const chip of [on, off]) {
      expect(chip).toHaveAttribute("data-variant", "secondary");
    }

    // ON: $accentSoft wash + $accent border, matching the DS's SegmentedControl.
    expect(on).toHaveAttribute("data-bg", "$accentSoft");
    expect(on).toHaveAttribute("data-border-color", "$accent");

    // OFF: transparent + $borderColor — not secondary's own `$structure`,
    // which is 2.25–2.46:1 on ember (under WCAG 1.4.11's 3:1 for a control
    // boundary, and an unfilled chip's border IS its boundary).
    expect(off).toHaveAttribute("data-border-color", "$borderColor");
    expect(off).not.toHaveAttribute("data-bg");

    // The ON chip HOLDS its accent border through hover. Without it, hovering
    // the selected chip made it pixel-identical to a hovered unselected one
    // (both take secondary's $structure fill + $onStructure label), so the row
    // read as "nothing selected" and the next click silently deselected.
    expect(on).toHaveAttribute("data-hover-border-color", "$accent");
    expect(off).not.toHaveAttribute("data-hover-border-color");
  });

  it("toggles the active chip off and reports undefined", () => {
    const onSelect = vi.fn();
    render(
      <FilterChips options={options} selected="DRAFT" onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    expect(onSelect).toHaveBeenCalledWith(undefined);

    fireEvent.click(screen.getByRole("button", { name: "Published" }));
    expect(onSelect).toHaveBeenCalledWith("PUBLISHED");
  });
});

describe("NoResults", () => {
  it("labels its clear button distinctly from FilterRow's, which is on screen at the same time", () => {
    render(
      <>
        <FilterRow hasActiveFilters onClearAll={() => {}}>
          <span />
        </FilterRow>
        <NoResults title="No matching events" onClearFilters={() => {}} />
      </>,
    );

    // Two controls sharing one accessible name is ambiguous for screen-reader
    // and voice-control users — this is the passkey-rename defect class.
    const names = screen
      .getAllByRole("button")
      .map((b) => b.textContent?.trim());
    expect(new Set(names).size).toBe(names.length);
    // Both labels come from the catalogs — several NoResults consumers are
    // seller-facing, so a hardcoded English default would regress es users.
    expect(
      screen.getByRole("button", { name: "admin.atClearFiltersShowAll" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "admin.atClearFilters" }),
    ).toBeInTheDocument();
  });

  it("accepts a caller override for the clear label", () => {
    render(
      <NoResults
        title="Nope"
        onClearFilters={() => {}}
        clearLabel="Show every order"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Show every order" }),
    ).toBeInTheDocument();
  });

  it("renders no clear button when onClearFilters is omitted", () => {
    render(<NoResults title="Nothing here" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("AdminTableErrorState", () => {
  it("renders the message and a retry button labelled with admin.retryLoad by default", () => {
    const onRetry = vi.fn();
    render(
      <AdminTableErrorState message="Something broke" onRetry={onRetry} />,
    );

    expect(screen.getByText("Something broke")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /admin\.retryLoad/i });
    expect(retry).toBeInTheDocument();
  });

  it("invokes onRetry when the retry button is pressed", () => {
    const onRetry = vi.fn();
    render(<AdminTableErrorState message="Boom" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("uses a custom retry label when provided", () => {
    render(
      <AdminTableErrorState
        message="Network down"
        onRetry={() => {}}
        retryLabel="Try again"
      />,
    );
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("applies the supplied test id to the wrapper and retry button", () => {
    render(
      <AdminTableErrorState
        message="oh no"
        onRetry={() => {}}
        testId="events-error"
      />,
    );
    expect(
      document.querySelector('[data-testid="events-error"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-testid="events-error-retry"]'),
    ).toBeInTheDocument();
  });
});

describe("BulkActionBar", () => {
  it("renders nothing when count is zero", () => {
    render(
      <BulkActionBar count={0} onClear={() => {}} testId="bulk-bar">
        <button type="button">Approve</button>
      </BulkActionBar>,
    );
    expect(
      document.querySelector('[data-testid="bulk-bar"]'),
    ).not.toBeInTheDocument();
  });

  it("announces the selection count in a polite live region", () => {
    render(<BulkActionBar count={3} onClear={() => {}} testId="bulk-bar" />);

    const region = document.querySelector('[data-testid="bulk-bar"]');
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("role", "region");

    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent("3 selected");
  });

  it("keeps the live region mounted at zero count, empty until first selection", () => {
    render(<BulkActionBar count={0} onClear={() => {}} />);

    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent("");
  });

  it("announces 'Selection cleared' when the count drops to zero", () => {
    const { rerender } = render(<BulkActionBar count={2} onClear={() => {}} />);

    rerender(<BulkActionBar count={0} onClear={() => {}} />);

    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent("Selection cleared");
  });

  it("renders the actions slot", () => {
    render(
      <BulkActionBar count={2} onClear={() => {}}>
        <button type="button">Approve selected</button>
      </BulkActionBar>,
    );
    expect(
      screen.getByRole("button", { name: /approve selected/i }),
    ).toBeInTheDocument();
  });

  it("clears the selection via the dismiss button", () => {
    const onClear = vi.fn();
    render(<BulkActionBar count={2} onClear={onClear} testId="bulk-bar" />);

    fireEvent.click(screen.getByRole("button", { name: /clear selection/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("clears the selection on Escape", () => {
    const onClear = vi.fn();
    render(<BulkActionBar count={2} onClear={onClear} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear on Escape while a MODAL dialog is open", () => {
    const onClear = vi.fn();
    render(
      <>
        <div role="dialog" aria-modal="true" />
        <BulkActionBar count={2} onClear={onClear} />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClear).not.toHaveBeenCalled();
  });

  it("still clears on Escape when only a NON-modal dialog (support chat) is open", () => {
    const onClear = vi.fn();
    render(
      <>
        <div role="dialog" aria-modal="false" />
        <BulkActionBar count={2} onClear={onClear} />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("restores focus to restoreFocusRef after clearing", () => {
    const onClear = vi.fn();
    const target = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={target} type="button">
          Table region
        </button>
        <BulkActionBar count={2} onClear={onClear} restoreFocusRef={target} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: /clear selection/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(target.current).toHaveFocus();
  });

  it("removes the Escape listener when count drops to zero", () => {
    const onClear = vi.fn();
    const { rerender } = render(<BulkActionBar count={2} onClear={onClear} />);

    rerender(<BulkActionBar count={0} onClear={onClear} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClear).not.toHaveBeenCalled();
  });
});

describe("Pagination", () => {
  const baseProps = {
    page: 0,
    totalPages: 6,
    onPageChange: () => {},
    pageSize: 25,
    onPageSizeChange: () => {},
  };

  it("stands its top rule down directly under a TableContainer (one rule, not two)", () => {
    render(
      <div>
        <TableContainer>
          <span data-testid="table-child">table</span>
        </TableContainer>
        <Pagination {...baseProps} />
      </div>,
    );
    const frame = screen.getByTestId("table-child").parentElement!;
    const pager = screen.getByRole("combobox").closest("[data-dt-pager]");
    expect(pager).not.toBeNull();
    // The CSS hook is an adjacent-sibling selector, so the pager must be the
    // frame's very next element.
    expect(frame.nextElementSibling).toBe(pager);
    expect(pager!.matches("[data-dt-frame] + [data-dt-pager]")).toBe(true);

    // The rule itself lives in globals.css (unit tests mock Tamagui's
    // styles away, so assert the source).
    const css = readFileSync(
      join(__dirname, "..", "..", "app", "globals.css"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(css).toContain(
      "[data-dt-frame] + [data-dt-pager] { border-top-width: 0 !important; }",
    );
  });

  it("keeps its own top rule when no table frame precedes it", () => {
    render(
      <div>
        <ul data-testid="plain-list" />
        <Pagination {...baseProps} />
      </div>,
    );
    const pager = screen.getByRole("combobox").closest("[data-dt-pager]");
    expect(pager).not.toBeNull();
    expect(pager!.matches("[data-dt-frame] + [data-dt-pager]")).toBe(false);
  });

  // The i18n mock echoes `key:{vars}`. Asserting on the KEY (not on English
  // copy) is the point: Pagination is reused by SELLER-facing pages
  // (sell/listings, sell/claims, sell/payouts), so a hardcoded English range
  // label would be a Spanish regression. A revert to the literal fails here.
  it("renders the range label from a translated key when total is provided", () => {
    render(<Pagination {...baseProps} total={128} />);
    expect(
      screen.getByText('admin.atRowsRange:{"start":1,"end":25,"total":128}'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Rows /)).not.toBeInTheDocument();
  });

  it("computes the range for later pages and clamps the final page", () => {
    render(<Pagination {...baseProps} page={5} total={128} />);
    expect(
      screen.getByText('admin.atRowsRange:{"start":126,"end":128,"total":128}'),
    ).toBeInTheDocument();
  });

  it("hides the range label when total is absent (falls back to page-of)", () => {
    render(<Pagination {...baseProps} />);
    expect(screen.queryByText(/admin\.atRowsRange/)).not.toBeInTheDocument();
    // Existing i18n page-of label still renders (mock echoes the key+vars).
    expect(screen.getByText(/admin\.atPageOf/)).toBeInTheDocument();
  });

  it("hides the range label when there are zero rows", () => {
    render(<Pagination {...baseProps} totalPages={1} total={0} />);
    expect(screen.queryByText(/admin\.atRowsRange/)).not.toBeInTheDocument();
  });

  it("hides the range label when a stale page is out of range", () => {
    // Stale ?p=9 with 30 rows @ 25/page: rangeStart 201 > total 30.
    render(<Pagination {...baseProps} page={8} totalPages={2} total={30} />);
    expect(screen.queryByText(/admin\.atRowsRange/)).not.toBeInTheDocument();
  });

  // The three sell/* pages now render Pagination unconditionally, so the
  // rows-per-page selector must survive a single-page dataset.
  it("keeps the rows-per-page selector on a single page while hiding prev/next", () => {
    render(<Pagination {...baseProps} totalPages={1} total={7} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /admin\.atNext/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /admin\.atPrevious/ }),
    ).not.toBeInTheDocument();
  });

  it("renders icon-only prev/next with the localized accessible names and disables at bounds", () => {
    const onPageChange = vi.fn();
    render(
      <Pagination {...baseProps} onPageChange={onPageChange} total={128} />,
    );

    // The i18n mock echoes keys — proves the existing localized keys are
    // wired (not hardcoded English).
    const prev = screen.getByRole("button", { name: /admin\.atPrevious/ });
    const next = screen.getByRole("button", { name: /admin\.atNext/ });
    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();

    fireEvent.click(next);
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("fires onPageSizeChange with a number from the select", () => {
    const onPageSizeChange = vi.fn();
    render(
      <Pagination {...baseProps} onPageSizeChange={onPageSizeChange} />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "50" } });
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it("renders nothing with a single page and no page-size selector", () => {
    const { container } = render(
      <Pagination page={0} totalPages={1} onPageChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
