import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Lightweight tamagui stand-in (layout only) — same discipline as
// EventEditorSheet.test.tsx.
vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { YStack: Stack, XStack: Stack };
});

// @th/ui test doubles: real DOM radios wired through a context so selection /
// disabled / close-guard behavior is assertable without the portal stack.
vi.mock("@th/ui", async () => {
  const React = await import("react");

  type GroupCtx = { value: string; onValueChange: (v: string) => void };
  const Ctx = React.createContext<GroupCtx>({
    value: "",
    onValueChange: () => {},
  });

  const Modal = ({
    open,
    children,
  }: {
    open: boolean;
    onClose: () => void;
    children?: ReactNode;
  }) => (open ? React.createElement("div", { role: "dialog" }, children) : null);
  Modal.Panel = ({ children }: { children?: ReactNode; width?: number }) =>
    React.createElement("div", null, children);
  Modal.Header = ({
    title,
    onClose,
  }: {
    title: string;
    onClose?: () => void;
  }) =>
    React.createElement(
      "div",
      null,
      React.createElement("h2", null, title),
      onClose
        ? React.createElement(
            "button",
            { "aria-label": "close-dialog", onClick: onClose },
            "x",
          )
        : null,
    );
  Modal.Body = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  Modal.Footer = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);

  const RadioGroupField = ({
    value,
    onValueChange,
    children,
    ...rest
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children?: ReactNode;
    [k: string]: unknown;
  }) =>
    React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange } },
      React.createElement(
        "div",
        { role: "radiogroup", "aria-label": rest["aria-label"] as string },
        children,
      ),
    );

  const Radio = ({
    value,
    label,
    description,
    disabled,
    testIdBase,
  }: {
    value: string;
    label?: ReactNode;
    description?: ReactNode;
    disabled?: boolean;
    testIdBase?: string;
  }) => {
    const ctx = React.useContext(Ctx);
    return React.createElement(
      "label",
      { "data-testid": testIdBase },
      React.createElement("input", {
        type: "radio",
        checked: ctx.value === value,
        disabled,
        onChange: () => ctx.onValueChange(value),
      }),
      label,
      description ?? null,
    );
  };

  const Button = ({
    children,
    onPress,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) =>
    React.createElement(
      "button",
      {
        onClick: onPress,
        disabled,
        "data-testid": rest["data-testid"] as string | undefined,
      },
      children,
    );
  const Text = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
  const Spinner = () => React.createElement("span", { "data-testid": "spinner" });
  // Recording translate: "key" or "key:{params}" so copy wiring is pinned to
  // the real message keys.
  const useTranslations =
    () => (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key;

  const Checkbox = ({
    id,
    label,
    checked,
    disabled,
    testIdBase,
    onCheckedChange,
  }: {
    id?: string;
    label?: ReactNode;
    checked?: boolean;
    disabled?: boolean;
    testIdBase?: string;
    onCheckedChange?: (v: boolean) => void;
  }) =>
    React.createElement(
      "label",
      { "data-testid": testIdBase, htmlFor: id },
      React.createElement("input", {
        id,
        type: "checkbox",
        checked: Boolean(checked),
        disabled,
        onChange: (e: { target: { checked: boolean } }) =>
          onCheckedChange?.(e.target.checked),
      }),
      label,
    );

  return {
    Modal,
    RadioGroupField,
    Radio,
    Button,
    Checkbox,
    Text,
    Spinner,
    useTranslations,
  };
});

import { SeriesEditScopeDialog } from "../SeriesEditScopeDialog";

const baseProps = {
  open: true,
  dateLabel: "FRI JUL 31",
  value: "this" as const,
  saving: false,
  onChange: vi.fn(),
  onCancel: vi.fn(),
  onConfirm: vi.fn(),
};

describe("SeriesEditScopeDialog", () => {
  it("renders the three scope options with 'this' selected and the show's date in its description", () => {
    render(<SeriesEditScopeDialog {...baseProps} />);

    const thisRadio = screen
      .getByTestId("eb-scope-this")
      .querySelector("input")!;
    const followingRadio = screen
      .getByTestId("eb-scope-following")
      .querySelector("input")!;
    const allRadio = screen.getByTestId("eb-scope-all").querySelector("input")!;

    expect(thisRadio.checked).toBe(true);
    expect(followingRadio.checked).toBe(false);
    expect(allRadio.checked).toBe(false);

    // The "this show only" description names the exact date being saved.
    expect(screen.getByTestId("eb-scope-this").textContent).toContain(
      'admin.ebScopeThisDesc:{"date":"FRI JUL 31"}',
    );
    // The schedule note keeps field propagation and schedule scope distinct.
    expect(screen.getByText("admin.ebScopeScheduleNote")).toBeTruthy();
  });

  it("reports a scope change without committing it (parent owns the value)", () => {
    const onChange = vi.fn();
    render(<SeriesEditScopeDialog {...baseProps} onChange={onChange} />);

    fireEvent.click(
      screen.getByTestId("eb-scope-all").querySelector("input")!,
    );
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("wires Save to onConfirm and Cancel to onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <SeriesEditScopeDialog
        {...baseProps}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId("eb-scope-save"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("eb-scope-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("locks the dialog while saving: busy Save label, disabled controls, no header close", () => {
    render(<SeriesEditScopeDialog {...baseProps} saving />);

    const save = screen.getByTestId<HTMLButtonElement>("eb-scope-save");
    expect(save.disabled).toBe(true);
    expect(save.textContent).toContain("admin.ebSaving");
    expect(screen.getByTestId("spinner")).toBeTruthy();
    expect(
      screen.getByTestId<HTMLButtonElement>("eb-scope-cancel").disabled,
    ).toBe(true);
    // The X is hidden mid-flight (closing would silently drop a failure).
    expect(screen.queryByLabelText("close-dialog")).toBeNull();
    for (const id of ["eb-scope-this", "eb-scope-following", "eb-scope-all"]) {
      expect(screen.getByTestId(id).querySelector("input")!.disabled).toBe(
        true,
      );
    }
  });

  // ── "Also replace parking and drop-off areas" (owner ruling Q13) ─────────
  describe("arrival-areas checkbox", () => {
    const box = () => screen.queryByTestId("eb-scope-include-arrival-areas");

    it("is hidden for 'This show only', which syncs nothing", () => {
      render(<SeriesEditScopeDialog {...baseProps} arrivalAreasGateOn />);
      expect(box()).toBeNull();
    });

    it("shows UNTICKED for 'following' and 'all' with the gate on", () => {
      for (const value of ["following", "all"] as const) {
        const { unmount } = render(
          <SeriesEditScopeDialog {...baseProps} value={value} arrivalAreasGateOn />,
        );
        expect(box()?.textContent).toContain("admin.ebScopeIncludeArrivalAreas");
        expect(box()!.querySelector("input")!.checked).toBe(false);
        unmount();
      }
    });

    it("is hidden with the arrivalAreas gate off", () => {
      render(<SeriesEditScopeDialog {...baseProps} value="all" />);
      expect(box()).toBeNull();
    });

    it("reports a tick and locks while saving", () => {
      const onIncludeArrivalAreasChange = vi.fn();
      const { rerender } = render(
        <SeriesEditScopeDialog
          {...baseProps}
          value="following"
          arrivalAreasGateOn
          onIncludeArrivalAreasChange={onIncludeArrivalAreasChange}
        />,
      );
      fireEvent.click(box()!.querySelector("input")!);
      expect(onIncludeArrivalAreasChange).toHaveBeenCalledWith(true);

      rerender(
        <SeriesEditScopeDialog
          {...baseProps}
          value="following"
          arrivalAreasGateOn
          includeArrivalAreas
          saving
        />,
      );
      expect(box()!.querySelector("input")!.disabled).toBe(true);
    });
  });
});

