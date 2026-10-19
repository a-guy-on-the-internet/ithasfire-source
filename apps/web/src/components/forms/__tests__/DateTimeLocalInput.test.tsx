import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DATE_INPUT_MAX, DATETIME_LOCAL_MAX } from "@/lib/datetime-local";

import { DateTimeLocalInput, useIncompleteField } from "../DateTimeLocalInput";

/** jsdom has no PointerEvent: dispatch a plain event carrying `pointerType`. */
function pointerDown(el: HTMLElement, pointerType: string) {
  const event = new Event("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  el.dispatchEvent(event);
}

function stubBadInput(el: HTMLInputElement, read: () => boolean) {
  Object.defineProperty(el, "validity", {
    configurable: true,
    get: () => ({ badInput: read() }),
  });
}

/** Lay the field out 200px wide with 1px border and 8px right padding. */
function layOut(el: HTMLInputElement) {
  el.style.paddingRight = "8px";
  el.style.borderRightWidth = "1px";
  el.getBoundingClientRect = () =>
    ({ left: 0, right: 200, width: 200, top: 0, bottom: 36, height: 36 }) as DOMRect;
}

function renderField(props: Partial<Parameters<typeof DateTimeLocalInput>[0]> = {}) {
  render(
    <DateTimeLocalInput
      type="datetime-local"
      data-testid="field"
      value=""
      onChange={() => {}}
      {...props}
    />,
  );
  const input = screen.getByTestId("field") as HTMLInputElement;
  const focus = vi.spyOn(input, "focus");
  return { input, focus };
}

describe("DateTimeLocalInput — first-segment fix", () => {
  it("a mouse press into an empty, unfocused field is cancelled and focuses it", () => {
    const { input, focus } = renderField();
    pointerDown(input, "mouse");
    // dispatchEvent returns false when the default was prevented.
    expect(fireEvent.mouseDown(input, { button: 0, clientX: 40 })).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("leaves a touch or pen press alone (phones open the native picker)", () => {
    const { input, focus } = renderField();
    pointerDown(input, "touch");
    expect(fireEvent.mouseDown(input, { button: 0, clientX: 40 })).toBe(true);
    pointerDown(input, "pen");
    expect(fireEvent.mouseDown(input, { button: 0, clientX: 40 })).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it("leaves a filled field alone, so a click still picks the segment", () => {
    const { input, focus } = renderField({ value: "2026-10-24T18:00" });
    pointerDown(input, "mouse");
    expect(fireEvent.mouseDown(input, { button: 0, clientX: 40 })).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it("leaves a half-typed field alone", () => {
    const { input, focus } = renderField();
    stubBadInput(input, () => true);
    pointerDown(input, "mouse");
    expect(fireEvent.mouseDown(input, { button: 0, clientX: 40 })).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it("leaves an already-focused field alone", () => {
    const { input, focus } = renderField();
    input.focus();
    focus.mockClear();
    pointerDown(input, "mouse");
    expect(fireEvent.mouseDown(input, { button: 0, clientX: 40 })).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it("leaves a press on the calendar picker indicator alone", () => {
    const { input, focus } = renderField();
    layOut(input);
    pointerDown(input, "mouse");
    // Zone starts at 200 - 1 border - 8 padding - 24 indicator = 167.
    expect(fireEvent.mouseDown(input, { button: 0, clientX: 180 })).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(fireEvent.mouseDown(input, { button: 0, clientX: 160 })).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("still calls the caller's own mousedown handler", () => {
    const onMouseDown = vi.fn();
    const { input } = renderField({ onMouseDown });
    fireEvent.mouseDown(input, { button: 0 });
    expect(onMouseDown).toHaveBeenCalledTimes(1);
  });
});

describe("DateTimeLocalInput — onIncompleteChange", () => {
  it("reports every check with the touched flag, never deduped", () => {
    const onIncompleteChange = vi.fn();
    const onKeyUp = vi.fn();
    const { input } = renderField({ onIncompleteChange, onKeyUp });
    let bad = false;
    stubBadInput(input, () => bad);

    fireEvent.keyUp(input, { key: "1" });
    expect(onIncompleteChange).toHaveBeenLastCalledWith(false, false);

    bad = true;
    fireEvent.keyUp(input, { key: "0" });
    expect(onIncompleteChange).toHaveBeenLastCalledWith(true, false);
    fireEvent.keyUp(input, { key: "2" });
    expect(onIncompleteChange).toHaveBeenCalledTimes(3);

    bad = false;
    fireEvent.blur(input);
    expect(onIncompleteChange).toHaveBeenLastCalledWith(false, true);
    expect(onIncompleteChange).toHaveBeenCalledTimes(4);
    expect(onKeyUp).toHaveBeenCalledTimes(3);
  });

  it("reports false on change even when nothing reported true before", () => {
    const onIncompleteChange = vi.fn();
    const { input } = renderField({ onIncompleteChange });
    stubBadInput(input, () => false);
    fireEvent.change(input, { target: { value: "2026-10-24T18:00" } });
    expect(onIncompleteChange).toHaveBeenCalledWith(false, false);
  });
});

function IncompleteProbe() {
  const field = useIncompleteField();
  return (
    <>
      <DateTimeLocalInput
        type="datetime-local"
        data-testid="probe"
        value=""
        onChange={() => {}}
        onIncompleteChange={field.onIncompleteChange}
        aria-invalid={field.shown ? true : undefined}
      />
      <button type="button" onClick={() => field.refuse(true)}>
        refuse
      </button>
      <output data-testid="flags">
        {String(field.incomplete)}/{String(field.shown)}
      </output>
    </>
  );
}

describe("useIncompleteField", () => {
  it("gates on keyup but shows only after blur", () => {
    render(<IncompleteProbe />);
    const input = screen.getByTestId("probe") as HTMLInputElement;
    stubBadInput(input, () => true);
    fireEvent.keyUp(input, { key: "1" });
    expect(screen.getByTestId("flags").textContent).toBe("true/false");
    expect(input).not.toHaveAttribute("aria-invalid");
    fireEvent.blur(input);
    expect(screen.getByTestId("flags").textContent).toBe("true/true");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("shows after a refused submit, and a change clears it", () => {
    render(<IncompleteProbe />);
    const input = screen.getByTestId("probe") as HTMLInputElement;
    let bad = true;
    stubBadInput(input, () => bad);
    fireEvent.click(screen.getByText("refuse"));
    expect(screen.getByTestId("flags").textContent).toBe("true/true");
    bad = false;
    fireEvent.change(input, { target: { value: "2026-10-24T18:00" } });
    expect(screen.getByTestId("flags").textContent).toBe("false/false");
  });
});

describe("DateTimeLocalInput — attributes", () => {
  it("defaults max by type, lets the caller's max win, and forwards the ref", () => {
    const ref = createRef<HTMLInputElement>();
    render(
      <>
        <DateTimeLocalInput ref={ref} type="datetime-local" data-testid="dt" />
        <DateTimeLocalInput type="date" data-testid="d" />
        <DateTimeLocalInput type="date" max="2030-01-01" data-testid="own" />
      </>,
    );
    expect(screen.getByTestId("dt").getAttribute("max")).toBe(DATETIME_LOCAL_MAX);
    expect(screen.getByTestId("d").getAttribute("max")).toBe(DATE_INPUT_MAX);
    expect(screen.getByTestId("own").getAttribute("max")).toBe("2030-01-01");
    expect(ref.current).toBe(screen.getByTestId("dt"));
  });
});
