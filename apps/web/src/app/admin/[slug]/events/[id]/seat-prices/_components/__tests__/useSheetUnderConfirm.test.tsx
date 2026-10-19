import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useSheetUnderConfirm } from "../useSheetUnderConfirm";

/**
 * Stands in for the editor: a sheet and a confirm that each close on a
 * window Escape listener, registered in the order the real ones are
 * (`BottomSheet` when the sheet opens, `Modal` when the confirm opens).
 */
function Harness({ startWithConfirm }: { startWithConfirm: boolean }) {
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const closeSheet = useSheetUnderConfirm({
    scopeRef,
    sheetOpen,
    confirmOpen,
    closeSheet: () => setSheetOpen(false),
  });

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen, closeSheet]);

  useEffect(() => {
    if (startWithConfirm) setConfirmOpen(true);
  }, [startWithConfirm]);

  useEffect(() => {
    if (!confirmOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen]);

  return (
    <>
      {sheetOpen ? (
        <div ref={scopeRef} data-testid="sheet">
          <button type="button">first in sheet</button>
          <button type="button">last in sheet</button>
        </div>
      ) : null}
      {confirmOpen ? (
        <div data-testid="confirm">
          <button type="button">cancel</button>
          <button type="button">confirm</button>
        </div>
      ) : null}
    </>
  );
}

afterEach(cleanup);

describe("useSheetUnderConfirm", () => {
  it("traps Tab in the sheet while no confirm is open", () => {
    const view = render(<Harness startWithConfirm={false} />);
    const last = view.getByText("last in sheet");
    last.focus();
    const notPrevented = fireEvent.keyDown(document, { key: "Tab" });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(view.getByText("first in sheet"));
  });

  it("leaves Tab alone while the confirm is open over the sheet", () => {
    const view = render(<Harness startWithConfirm />);
    const cancel = view.getByText("cancel");
    cancel.focus();
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(
      true,
    );
    expect(document.activeElement).toBe(cancel);
  });

  it("closes only the confirm on Escape, and the sheet on the next one", async () => {
    const view = render(<Harness startWithConfirm />);
    expect(view.queryByTestId("confirm")).not.toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(view.queryByTestId("confirm")).toBeNull();
    expect(view.queryByTestId("sheet")).not.toBeNull();

    // The swallow lasts for that one key press only.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(view.queryByTestId("sheet")).toBeNull();
  });
});
