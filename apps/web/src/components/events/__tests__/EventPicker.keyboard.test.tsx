import type { ReactNode } from "react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * EventPicker — keyboard operability.
 *
 * The defect this locks down: the trigger was a `styled(XStack)` (a plain
 * <div>) with only `cursor: pointer` + `onPress`. With nothing selected its
 * only children are two non-focusable icons, so a keyboard-only organiser
 * tabbed straight past the picker and could NEVER open it — meaning they could
 * never create an event-subject embed at all.
 *
 * These tests drive the REAL key handlers rather than asserting that aria
 * attributes exist: an aria attribute on an unfocusable element proves nothing.
 *
 * Mirrors EventContent.test.tsx's mocking approach (render Tamagui/@th/ui as
 * plain DOM, no TamaguiProvider needed) — but deliberately FORWARDS the
 * interaction props (tabIndex/onKeyDown/role/aria-*, onPress→onClick), since
 * those are exactly what is under test.
 */

vi.mock("tamagui", async () => {
  const { forwardRef } = await import("react");
  // forwardRef matters: the component focus()es the trigger through a ref on a
  // styled() component. Real Tamagui forwards refs, so a mock that drops them
  // would fail the Escape-refocus test for a reason the product doesn't have.
  const Stack = forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
    const { children, onPress, ...rest } = props;
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (
        key.startsWith("data-") ||
        key.startsWith("aria-") ||
        key === "role" ||
        key === "id" ||
        key === "tabIndex" ||
        key === "onKeyDown"
      ) {
        domProps[key] = value;
      }
    }
    return (
      <div ref={ref} {...domProps} onClick={onPress as (() => void) | undefined}>
        {children as ReactNode}
      </div>
    );
  });
  Stack.displayName = "MockStack";
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
  } & Record<string, unknown>) => (
    <button
      type="button"
      onClick={onPress}
      aria-label={rest["aria-label"] as string | undefined}
    >
      {children}
    </button>
  ),
}));

const pushSpy = vi.fn();
vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: pushSpy }),
}));

const useQuerySpy = vi.fn();
vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      listMine: {
        useQuery: (input: unknown, opts: unknown) => useQuerySpy(input, opts),
      },
    },
  },
}));

import { EventPicker, type EventPickerItem } from "../EventPicker";

const EVENTS = [
  {
    id: "evt-1",
    title: "Basement Show",
    startsAt: new Date("2027-03-04T02:00:00.000Z"),
    placeName: "The Blue Room",
    slug: "basement-show",
  },
  // `title: null` is real — the schema allows it. Must never render "null".
  { id: "evt-2", title: null, startsAt: null, placeName: null, slug: null },
];

function Harness() {
  const [value, setValue] = useState<EventPickerItem | null>(null);
  return (
    <EventPicker
      value={value}
      onChange={setValue}
      ownerType="ORGANIZATION"
      ownerId="org-1"
      adminSlug="dev-qa"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useQuerySpy.mockReturnValue({
    data: { items: EVENTS },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
});

const getTrigger = () => screen.getByRole("combobox");

describe("EventPicker keyboard operability", () => {
  it("exposes the trigger as a focusable combobox", () => {
    render(<Harness />);
    const trigger = getTrigger();
    // The actual regression: without tabIndex this element is unreachable.
    expect(trigger).toHaveAttribute("tabIndex", "0");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("receives DOM focus (proving it is genuinely reachable)", () => {
    render(<Harness />);
    const trigger = getTrigger();
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
    ["ArrowDown", "ArrowDown"],
  ])("opens the listbox on %s", (_label, key) => {
    render(<Harness />);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(getTrigger(), { key });
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(getTrigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("closes again on Enter (toggle) and on Escape", () => {
    render(<Harness />);
    fireEvent.keyDown(getTrigger(), { key: "Enter" });
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(getTrigger(), { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.keyDown(getTrigger(), { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(getTrigger(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ArrowDown never CLOSES an open list", () => {
    render(<Harness />);
    fireEvent.keyDown(getTrigger(), { key: "ArrowDown" });
    fireEvent.keyDown(getTrigger(), { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("returns focus to the trigger when Escape dismisses the panel", () => {
    render(<Harness />);
    const trigger = getTrigger();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    // Escape from INSIDE the panel (where focus lands on the search input).
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("selects an option with the keyboard — the full create-embed path", () => {
    render(<Harness />);
    fireEvent.keyDown(getTrigger(), { key: "Enter" });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(options[0]!, { key: "Enter" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("Basement Show")).toBeTruthy();
  });

  it("marks the chosen option aria-selected on reopen", () => {
    render(<Harness />);
    fireEvent.keyDown(getTrigger(), { key: "Enter" });
    fireEvent.keyDown(screen.getAllByRole("option")[0]!, { key: " " });
    fireEvent.keyDown(getTrigger(), { key: "Enter" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("never renders the string 'null' for a titleless event", () => {
    render(<Harness />);
    fireEvent.keyDown(getTrigger(), { key: "Enter" });
    expect(screen.queryByText("null")).toBeNull();
    expect(screen.getByText("Untitled event")).toBeTruthy();
  });

  it("keeps the footer action keyboard-reachable", () => {
    render(<Harness />);
    fireEvent.keyDown(getTrigger(), { key: "Enter" });
    const manage = screen.getByText("Manage events").closest("[role='button']");
    expect(manage).toHaveAttribute("tabIndex", "0");
    fireEvent.keyDown(manage!, { key: "Enter" });
    expect(pushSpy).toHaveBeenCalledWith("/admin/dev-qa/events");
  });

  it("only queries once opened (lazy)", () => {
    render(<Harness />);
    expect(useQuerySpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["PUBLISHED"], ownerId: "org-1" }),
      expect.objectContaining({ enabled: false }),
    );
    fireEvent.keyDown(getTrigger(), { key: "Enter" });
    expect(useQuerySpy).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });
});
