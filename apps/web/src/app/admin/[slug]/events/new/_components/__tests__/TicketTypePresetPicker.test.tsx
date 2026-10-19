import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en";

/**
 * Render Tamagui stacks to real DOM, forwarding the props the picker relies on
 * (ARIA, id, tabIndex, keyboard + press handlers, refs). Same approach as the
 * sibling EditorCard/EventEditorSheet tests: the styling is Tamagui's problem,
 * the SEMANTICS are ours and must be assertable.
 */
vi.mock("tamagui", async () => {
  const React = await import("react");
  type StackMockProps = {
    children?: unknown;
    id?: string;
    role?: string;
    tabIndex?: number;
    onPress?: () => void;
    onKeyDown?: (event: unknown) => void;
    onMouseEnter?: () => void;
    [key: string]: unknown;
  };
  const Stack = React.forwardRef<HTMLDivElement, StackMockProps>(
    function Stack(props, ref) {
      const forwarded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (key.startsWith("aria-") || key.startsWith("data-")) {
          forwarded[key] = value;
        }
      }
      return React.createElement(
        "div",
        {
          ref,
          id: props.id,
          role: props.role,
          tabIndex: props.tabIndex,
          onClick: props.onPress,
          onKeyDown: props.onKeyDown,
          onMouseEnter: props.onMouseEnter,
          ...forwarded,
        } as never,
        props.children as never,
      );
    },
  );
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({ colorMuted: { val: "#5C544A" } }),
  };
});

vi.mock("lucide-react", () => ({
  ChevronDown: () => null,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) =>
    `$${(cents / 100).toFixed(2)}`,
}));

/** Naive ICU-ish `{token}` substitution against the real en catalog. */
const adminCatalog = (enMessages as unknown as { admin: Record<string, string> })
  .admin;

const translate = (key: string, values?: Record<string, unknown>) => {
  const raw = adminCatalog[key.replace(/^admin\./, "")] ?? key;
  if (!values) return raw;
  return raw.replace(/\{(\w+)\}/g, (_m, token: string) =>
    String(values[token] ?? `{${token}}`),
  );
};

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children, id }: { children?: unknown; id?: string }) =>
      React.createElement("span", { id }, children as never),
    useTranslations: () => translate,
    useFormatters: () => ({ currency: (v: number) => `$${v.toFixed(2)}` }),
  };
});

const { TicketTypePresetPicker } = await import("../TicketTypePresetPicker");

const setup = (overrides?: { value?: string }) => {
  const onSelect = vi.fn();
  render(
    <TicketTypePresetPicker
      value={(overrides?.value ?? "custom") as never}
      onSelect={onSelect}
    />,
  );
  return { onSelect, trigger: screen.getByTestId("ticket-type-preset-trigger") };
};

describe("TicketTypePresetPicker", () => {
  it("renders a collapsed combobox defaulting to Custom (blank)", () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute("role", "combobox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveTextContent("Custom (blank)");
    expect(
      screen.queryByTestId("ticket-type-preset-listbox"),
    ).not.toBeInTheDocument();
  });

  it("labels the trigger with the 'Start from' field label", () => {
    const { trigger } = setup();
    const labelId = trigger.getAttribute("aria-labelledby")?.split(" ")[0];
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent("Start from");
  });

  it("opens on click and lists every preset with a two-line row", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);

    const listbox = screen.getByTestId("ticket-type-preset-listbox");
    expect(listbox).toHaveAttribute("role", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(9);

    const ga = screen.getByTestId("ticket-type-preset-option-ga");
    expect(ga).toHaveTextContent("General Admission");
    expect(ga).toHaveTextContent("$15.00 · 100 cap");

    expect(
      screen.getByTestId("ticket-type-preset-option-industry"),
    ).toHaveTextContent("Free · 10 cap");
    expect(
      screen.getByTestId("ticket-type-preset-option-pwyw"),
    ).toHaveTextContent("min $0.00 · suggested $10.00 · 100 cap");
  });

  it("marks only the selected row aria-selected", () => {
    const { trigger } = setup({ value: "vip" });
    expect(trigger).toHaveTextContent("VIP");
    fireEvent.click(trigger);
    expect(
      screen.getByTestId("ticket-type-preset-option-vip"),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByTestId("ticket-type-preset-option-ga"),
    ).toHaveAttribute("aria-selected", "false");
  });

  it("opens with ArrowDown and roves aria-activedescendant", () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Opening lands on the current selection (custom), not blindly on row 0+1.
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(
      /-option-custom$/,
    );

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(/-option-ga$/);

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(
      /-option-custom$/,
    );

    // Wraps past the top to the last entry.
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(
      /-option-industry$/,
    );
  });

  it("jumps to first/last with Home and End", () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "End" });
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(
      /-option-industry$/,
    );
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(trigger.getAttribute("aria-activedescendant")).toMatch(
      /-option-custom$/,
    );
  });

  it("selects the active row with Enter and closes", () => {
    const { trigger, onSelect } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({
      id: "ga",
      priceDollars: "15.00",
      capacity: "100",
      pricingMode: "FIXED",
    });
    expect(
      screen.queryByTestId("ticket-type-preset-listbox"),
    ).not.toBeInTheDocument();
  });

  it("opens with Space when closed and selects with Space when open", () => {
    const { trigger, onSelect } = setup();
    fireEvent.keyDown(trigger, { key: " " });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(trigger, { key: "End" });
    fireEvent.keyDown(trigger, { key: " " });
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ id: "industry" });
  });

  it("closes on Escape without selecting", () => {
    const { trigger, onSelect } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("swallows Escape only while open, so a closed picker still lets the sheet close", () => {
    const onWindowEscape = vi.fn();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") onWindowEscape();
    };
    window.addEventListener("keydown", listener);
    try {
      const { trigger } = setup();

      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      fireEvent.keyDown(trigger, { key: "Escape" });
      // Listbox closed; the surrounding BottomSheet must NOT have seen it.
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(onWindowEscape).not.toHaveBeenCalled();

      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(onWindowEscape).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });

  it("closes on Tab so focus can leave the field", () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("selects on row click", () => {
    const { trigger, onSelect } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("ticket-type-preset-option-sliding"));
    expect(onSelect.mock.calls[0]![0]).toMatchObject({
      id: "sliding",
      pricingMode: "ADJUSTABLE",
      minimumDollars: "10.00",
      suggestedDollars: "20.00",
      priceDollars: "",
    });
  });

  it("does NOT re-fire onSelect when the already-selected row is re-picked", () => {
    // An organiser who picked GA, then edited name/price/capacity, then opened
    // the picker just to check where they started must not have those edits
    // silently reset. A native <select> fires no change here either.
    const { trigger, onSelect } = setup({ value: "ga" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("ticket-type-preset-option-ga"));

    expect(onSelect).not.toHaveBeenCalled();
    // Still closes and hands focus back, so it isn't a dead click.
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does not re-fire onSelect when the current row is chosen with Enter", () => {
    const { trigger, onSelect } = setup({ value: "custom" });
    // Opening lands on the current selection, so Enter re-picks it.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("still fires onSelect when a DIFFERENT row is picked", () => {
    const { trigger, onSelect } = setup({ value: "ga" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("ticket-type-preset-option-vip"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ id: "vip" });
  });

  it("points the trigger at the 'nothing is saved yet' help text", () => {
    const { trigger } = setup();
    const helpId = trigger.getAttribute("aria-describedby");
    expect(helpId).toBeTruthy();
    expect(document.getElementById(helpId!)).toHaveTextContent(
      "Nothing is saved until you press Add",
    );
  });

  it("closes on an outside press but not on a press inside the listbox", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);

    fireEvent.pointerDown(
      screen.getByTestId("ticket-type-preset-option-door"),
    );
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
