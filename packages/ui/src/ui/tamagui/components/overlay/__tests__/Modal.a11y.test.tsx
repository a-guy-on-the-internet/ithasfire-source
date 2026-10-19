/**
 * Modal — dialog semantics that `role="dialog" aria-modal="true"` promises.
 *
 * These cover the two things the primitive claimed but did not do: Tab
 * containment, and marking the background inert. The teardown assertions matter
 * more than the setup ones — a stuck `inert` on <body>'s children bricks the
 * whole app, and a nested dialog that forgets to un-inert its parent leaves the
 * user staring at a dead panel.
 *
 * jsdom has no layout and does not implement `inert` behaviourally, so these
 * assert the DOM contract (attributes, focus moves driven by our own handler).
 * Real browser-level proof lives in the live-QA notes for this change.
 */

import { useState } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";

import { renderWithProvider } from "../../../../../../test/utils";
import { Modal } from "../Modal";

const INERT_MARK = "data-th-modal-inert";

/** Dispatch a Tab from wherever focus currently is. */
function pressTab(options: { shift?: boolean } = {}) {
  const target = document.activeElement ?? document.body;
  return fireEvent.keyDown(target, {
    key: "Tab",
    code: "Tab",
    shiftKey: options.shift ?? false,
  });
}

function pressEscape() {
  return fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
    code: "Escape",
  });
}

/** The portal wrapper for each open dialog: the live <body> child. */
function dialogWrappers(): HTMLElement[] {
  return Array.from(document.body.children).filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement &&
      el.querySelector('[role="dialog"]') !== null &&
      !el.hasAttribute(INERT_MARK),
  );
}

function inertedBodyChildren(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${INERT_MARK}]`));
}

describe("Modal — focus containment", () => {
  it("wraps Tab from the last focusable back to the first", () => {
    renderWithProvider(
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          <button type="button">First</button>
          <button type="button">Middle</button>
          <button type="button">Last</button>
        </Modal.Panel>
      </Modal>,
    );

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    expect(document.activeElement).toBe(last);

    pressTab();

    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the first focusable back to the last", () => {
    renderWithProvider(
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          <button type="button">First</button>
          <button type="button">Middle</button>
          <button type="button">Last</button>
        </Modal.Panel>
      </Modal>,
    );

    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    first.focus();

    pressTab({ shift: true });

    expect(document.activeElement).toBe(last);
  });

  it("leaves interior Tab steps to the browser (no preventDefault)", () => {
    renderWithProvider(
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          <button type="button">First</button>
          <button type="button">Middle</button>
          <button type="button">Last</button>
        </Modal.Panel>
      </Modal>,
    );

    screen.getByRole("button", { name: "Middle" }).focus();
    const notCancelled = pressTab();

    // fireEvent returns false when the event was cancelled.
    expect(notCancelled).toBe(true);
  });

  it("never lets Tab leave the dialog when it has no focusable children", () => {
    renderWithProvider(
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          <Modal.Body>
            <span>Nothing to focus here</span>
          </Modal.Body>
        </Modal.Panel>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    dialog.focus();

    const notCancelled = pressTab();

    expect(notCancelled).toBe(false);
    expect(document.activeElement).toBe(dialog);
  });

  it("cycles a single focusable child onto itself in both directions", () => {
    renderWithProvider(
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          <button type="button">Only</button>
        </Modal.Panel>
      </Modal>,
    );

    const only = screen.getByRole("button", { name: "Only" });
    only.focus();

    pressTab();
    expect(document.activeElement).toBe(only);

    pressTab({ shift: true });
    expect(document.activeElement).toBe(only);
  });

  it("recomputes the boundary when a child is disabled while open", () => {
    const Harness = ({ disabled }: { disabled: boolean }) => (
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          <button type="button">First</button>
          <button type="button">Middle</button>
          <button type="button" disabled={disabled}>
            Last
          </button>
        </Modal.Panel>
      </Modal>
    );
    const { rerender } = renderWithProvider(<Harness disabled={false} />);

    rerender(<Harness disabled />);

    screen.getByRole("button", { name: "Middle" }).focus();
    pressTab();

    // "Middle" is now the last tabbable element, so Tab must wrap.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First" }),
    );
  });

  it("recomputes the boundary when content is added while open", () => {
    const Harness = ({ extra }: { extra: boolean }) => (
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          <button type="button">First</button>
          <button type="button">Second</button>
          {extra ? <button type="button">Third</button> : null}
        </Modal.Panel>
      </Modal>
    );
    const { rerender } = renderWithProvider(<Harness extra={false} />);

    const second = screen.getByRole("button", { name: "Second" });
    second.focus();
    pressTab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First" }),
    );

    rerender(<Harness extra />);

    second.focus();
    const notCancelled = pressTab();
    // "Second" is no longer the boundary, so we must not intercept.
    expect(notCancelled).toBe(true);
  });

  it("pulls focus back when it lands in the inerted background", () => {
    renderWithProvider(
      <>
        <button type="button">Outside</button>
        <Modal open onClose={() => {}}>
          <Modal.Panel>
            <button type="button">Inside</button>
          </Modal.Panel>
        </Modal>
      </>,
    );

    const outside = screen.getByText("Outside") as HTMLButtonElement;
    // jsdom does not implement `inert` behaviourally, so this simulates the
    // browser-less case the aria-hidden/focusin fallback exists for.
    act(() => {
      outside.focus();
      fireEvent.focusIn(outside);
    });

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Inside" }),
    );
  });
});

describe("Modal — background inertness", () => {
  it("inerts every other <body> child while open and releases on close", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <Modal.Panel>
              <button type="button">Inside</button>
            </Modal.Panel>
          </Modal>
        </>
      );
    }
    const { baseElement } = renderWithProvider(<Harness />);
    expect(baseElement).toBe(document.body);

    expect(inertedBodyChildren()).toHaveLength(0);

    act(() => {
      screen.getByRole("button", { name: "Open" }).click();
    });

    const inerted = inertedBodyChildren();
    expect(inerted.length).toBeGreaterThan(0);
    for (const el of inerted) {
      expect(el.parentElement).toBe(document.body);
      expect(el.getAttribute("aria-hidden")).toBe("true");
    }
    // The dialog's own wrapper is the one live layer.
    expect(dialogWrappers()).toHaveLength(1);
    expect(dialogWrappers()[0].hasAttribute("inert")).toBe(false);

    act(() => {
      pressEscape();
    });

    expect(inertedBodyChildren()).toHaveLength(0);
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("does not clobber an author-set aria-hidden on release", () => {
    const decoy = document.createElement("div");
    decoy.setAttribute("aria-hidden", "true");
    decoy.setAttribute("data-decoy", "");
    document.body.appendChild(decoy);

    try {
      const { unmount } = renderWithProvider(
        <Modal open onClose={() => {}}>
          <Modal.Panel>
            <button type="button">Inside</button>
          </Modal.Panel>
        </Modal>,
      );

      expect(decoy.getAttribute("aria-hidden")).toBe("true");
      expect(decoy.hasAttribute(INERT_MARK)).toBe(true);

      unmount();

      expect(decoy.hasAttribute("inert")).toBe(false);
      expect(decoy.getAttribute("aria-hidden")).toBe("true");
    } finally {
      decoy.remove();
    }
  });

  it("leaves an element that was already author-inert untouched", () => {
    const authorInert = document.createElement("div");
    authorInert.setAttribute("inert", "");
    document.body.appendChild(authorInert);

    try {
      const { unmount } = renderWithProvider(
        <Modal open onClose={() => {}}>
          <Modal.Panel>
            <button type="button">Inside</button>
          </Modal.Panel>
        </Modal>,
      );

      expect(authorInert.hasAttribute(INERT_MARK)).toBe(false);
      unmount();
      // Still the author's — we never took ownership, so we never release it.
      expect(authorInert.hasAttribute("inert")).toBe(true);
    } finally {
      authorInert.remove();
    }
  });

  it("releases the background when the modal unmounts while still open", () => {
    const { unmount } = renderWithProvider(
      <>
        <button type="button">Outside</button>
        <Modal open onClose={() => {}}>
          <Modal.Panel>
            <button type="button">Inside</button>
          </Modal.Panel>
        </Modal>
      </>,
    );

    expect(inertedBodyChildren().length).toBeGreaterThan(0);
    unmount();
    expect(inertedBodyChildren()).toHaveLength(0);
  });
});

describe("Modal — nested dialogs", () => {
  function NestedHarness({
    onParentClose = () => {},
  }: {
    onParentClose?: () => void;
  }) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    return (
      <Modal open onClose={onParentClose}>
        <Modal.Panel>
          <Modal.Header title="Place Details" />
          <Modal.Body>
            <button type="button" onClick={() => setConfirmOpen(true)}>
              Waive verification
            </button>
          </Modal.Body>
          <Modal.Footer>
            <button type="button">Cancel</button>
          </Modal.Footer>
        </Modal.Panel>
        <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)}>
          <Modal.Panel>
            <Modal.Header title="Waive verification?" />
            <Modal.Footer>
              <button type="button">Don&apos;t waive</button>
              <button type="button">Waive</button>
            </Modal.Footer>
          </Modal.Panel>
        </Modal>
      </Modal>
    );
  }

  it("exposes only the topmost dialog and inerts the parent panel", () => {
    renderWithProvider(<NestedHarness />);

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Place Details" })).toBeTruthy();

    act(() => {
      screen.getByRole("button", { name: "Waive verification" }).click();
    });

    // The parent panel is gone from the accessibility tree entirely.
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].getAttribute("aria-labelledby")).toBe(
      screen.getByText("Waive verification?").id,
    );

    // The parent's "Cancel" is no longer a competing accessible name.
    expect(screen.queryAllByRole("button", { name: "Cancel" })).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Waive" })).toBeTruthy();

    // Both wrappers exist in the raw DOM; exactly one is live.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(dialogWrappers()).toHaveLength(1);
  });

  it("restores the parent dialog — not the whole page — when the child closes", () => {
    renderWithProvider(<NestedHarness />);

    act(() => {
      screen.getByRole("button", { name: "Waive verification" }).click();
    });
    act(() => {
      screen.getByRole("button", { name: "Waive" }).click();
    });
    act(() => {
      // Child closes.
      pressEscape();
    });

    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].getAttribute("aria-labelledby")).toBe(
      screen.getByText("Place Details").id,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    // …and the page behind the parent is still inert.
    expect(inertedBodyChildren().length).toBeGreaterThan(0);
  });

  it("contains Tab inside the child while the parent stays unreachable", () => {
    renderWithProvider(<NestedHarness />);

    act(() => {
      screen.getByRole("button", { name: "Waive verification" }).click();
    });

    const waive = screen.getByRole("button", { name: "Waive" });
    const dontWaive = screen.getByRole("button", { name: "Don't waive" });
    const child = dialogWrappers()[0];

    waive.focus();
    pressTab();
    expect(document.activeElement).toBe(dontWaive);
    expect(child.contains(document.activeElement)).toBe(true);

    for (let i = 0; i < 6; i++) {
      pressTab();
      expect(child.contains(document.activeElement)).toBe(true);
    }
  });

  it("Escape closes only the topmost dialog", () => {
    const onParentClose = vi.fn();
    renderWithProvider(<NestedHarness onParentClose={onParentClose} />);

    act(() => {
      screen.getByRole("button", { name: "Waive verification" }).click();
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);

    act(() => {
      pressEscape();
    });

    // The child closed; the parent did not. (Before the topmost gate, the
    // OUTER modal's listener won and stopImmediatePropagation killed the
    // inner one's — Escape on a nested confirm closed the parent.)
    expect(onParentClose).not.toHaveBeenCalled();
    // AnimatePresence keeps the closing child mounted through its exit
    // animation, so assert on the accessibility tree rather than raw nodes.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    act(() => {
      pressEscape();
    });
    expect(onParentClose).toHaveBeenCalledTimes(1);
  });
});

describe("Modal — initial focus and restore", () => {
  it("seats focus on the panel and returns it to the opener on close", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)}>
            <Modal.Panel>
              <Modal.Body>
                <span>No controls</span>
              </Modal.Body>
            </Modal.Panel>
          </Modal>
        </>
      );
    }
    renderWithProvider(<Harness />);

    const trigger = screen.getByRole("button", { name: "Open" });
    act(() => {
      trigger.focus();
      trigger.click();
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("dialog"));
    });

    act(() => {
      pressEscape();
    });

    expect(document.activeElement).toBe(trigger);
  });

  it("does not steal focus a consumer already placed inside the dialog", async () => {
    renderWithProvider(
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus aria-label="Name" />
        </Modal.Panel>
      </Modal>,
    );

    const input = screen.getByLabelText("Name");
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });
});

describe("Modal — header close affordance", () => {
  it("exposes the close control as a keyboard-reachable button", () => {
    const onClose = vi.fn();
    renderWithProvider(
      <Modal open onClose={onClose}>
        <Modal.Panel>
          <Modal.Header title="Titled" onClose={onClose} />
        </Modal.Panel>
      </Modal>,
    );

    const close = screen.getByRole("button", { name: "Close" });
    expect(close.tabIndex).toBe(0);

    fireEvent.keyDown(close, { key: "Enter", code: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(close, { key: " ", code: "Space" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the close button inside the Tab cycle", () => {
    renderWithProvider(
      <Modal open onClose={() => {}}>
        <Modal.Panel>
          <Modal.Header title="Titled" onClose={() => {}} />
          <Modal.Footer>
            <button type="button">Save</button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>,
    );

    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save" });

    save.focus();
    pressTab();
    expect(document.activeElement).toBe(close);
  });
});
