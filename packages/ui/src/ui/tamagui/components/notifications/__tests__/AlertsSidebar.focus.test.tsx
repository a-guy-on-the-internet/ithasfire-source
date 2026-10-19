/**
 * The web bell panel is `role="dialog"` + `aria-modal`, and before 2026-09-30
 * it did none of what that promises: focus stayed on the bell when it opened,
 * Tab walked straight out into the page behind the overlay, and closing left
 * focus on a node that was about to unmount. These pin the dialog contract —
 * focus in on open, Tab contained, Escape closes, focus back on the bell — and
 * the close hook the inbox uses to shut the panel when a row navigates away.
 */
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";

import { AlertsSidebar, useAlertsSidebarClose } from "../AlertsSidebar";
import { NotificationProvider } from "../NotificationProvider";

function InboxStub({ onRender }: { onRender?: (close: unknown) => void }) {
  const close = useAlertsSidebarClose();
  onRender?.(close);
  return (
    <div>
      <a href="/first">First row link</a>
      <a
        href="/last"
        onClick={(e) => {
          e.preventDefault();
          close?.();
        }}
      >
        Last row link
      </a>
    </div>
  );
}

function renderSidebar(onRender?: (close: unknown) => void) {
  return renderWithProvider(
    <NotificationProvider>
      <button type="button">Before</button>
      <AlertsSidebar
        platformOverride="web"
        renderInbox={() => <InboxStub onRender={onRender} />}
      />
      <button type="button">After</button>
    </NotificationProvider>,
  );
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  const bell = screen.getByRole("button", { name: /open alerts/i });
  await user.click(bell);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog).toHaveFocus());
  return { bell, dialog };
}

describe("AlertsSidebar (web) dialog focus", () => {
  it("moves focus to the panel on open and names it by its heading", async () => {
    const user = userEvent.setup();
    renderSidebar();

    const { dialog } = await openPanel(user);

    expect(dialog).toHaveAttribute("aria-modal");
    expect(dialog).toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("dialog", { name: "Notifications" }),
    ).toBeInTheDocument();
  });

  it("keeps Tab inside the panel in both directions", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const { dialog } = await openPanel(user);

    const close = within(dialog).getByRole("button", { name: /close/i });
    const lastLink = within(dialog).getByRole("link", {
      name: "Last row link",
    });

    // From the panel container, Tab goes to the first control inside.
    await user.tab();
    expect(close).toHaveFocus();

    // Shift+Tab from the first control wraps to the last, not to the page.
    await user.tab({ shift: true });
    expect(lastLink).toHaveFocus();

    // Tab from the last control wraps to the first.
    await user.tab();
    expect(close).toHaveFocus();

    expect(screen.getByRole("button", { name: "Before" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "After" })).not.toHaveFocus();
  });

  it("Escape closes the panel and returns focus to the bell", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const { bell } = await openPanel(user);

    await user.tab();
    await user.keyboard("{Escape}");

    expect(bell).toHaveFocus();
    expect(bell).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the Close button returns focus to the bell", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const { bell, dialog } = await openPanel(user);

    await user.click(within(dialog).getByRole("button", { name: /close/i }));

    expect(bell).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders the panel in its own <body> child, clear of the trigger's tree", async () => {
    // The panel used to render where the bell renders. In apps/web that is
    // inside ScrollAwareNavbar's wrapper, which sets a transform (so the
    // panel's `position: fixed` offsets resolved against the NAVBAR and its
    // z-index became local) and `pointer-events: none` once the navbar
    // auto-hides (so an open panel could not be tapped at all). A <body>
    // child inherits none of that.
    const user = userEvent.setup();
    const { container } = renderSidebar();
    const { dialog } = await openPanel(user);

    expect(container.contains(dialog)).toBe(false);
    const wrapper = dialog.parentElement!;
    expect(wrapper.parentElement).toBe(document.body);
    expect(wrapper.style.zIndex).toBe("1600");
    // The backdrop rides along, still painted one level under the panel.
    expect(wrapper.childElementCount).toBe(2);
    expect(wrapper.firstElementChild).not.toBe(dialog);
  });

  it("locks page scroll while open and restores the previous value on close", async () => {
    // A backdrop + a focus trap over a page that still scrolls is incoherent,
    // and in apps/web the scroll took the bell with it (the navbar auto-hides),
    // so focus-restore on close landed on an invisible trigger. Same four lines
    // as Modal and SlidePanel, including restoring the PREVIOUS value rather
    // than clearing to "" — an author-set overflow has to survive the panel.
    const user = userEvent.setup();
    document.body.style.overflow = "scroll";
    try {
      renderSidebar();
      expect(document.body.style.overflow).toBe("scroll");

      const { bell } = await openPanel(user);
      expect(document.body.style.overflow).toBe("hidden");

      await user.keyboard("{Escape}");
      expect(bell).toHaveFocus();
      expect(document.body.style.overflow).toBe("scroll");
    } finally {
      document.body.style.overflow = "";
    }
  });

  it("releases the lock if it unmounts while still open", async () => {
    const user = userEvent.setup();
    const { unmount } = renderSidebar();
    await openPanel(user);
    expect(document.body.style.overflow).toBe("hidden");

    unmount();

    expect(document.body.style.overflow).toBe("");
  });

  it("stops trapping once closed", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await openPanel(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Bell has focus; Tab now leaves it for the page as normal.
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });
});

describe("AlertsSidebar (web) trap leaves live layers above it alone", () => {
  /**
   * A body-level layer, like a portal, with one button in it. `placement`
   * decides whether it lands after the panel's own <body> ancestor (the
   * default, what appending gives) or before it.
   */
  function mountLayer(
    attrs: Record<string, string>,
    zIndex?: number,
    placement: "append" | "prepend" = "append",
  ) {
    const layer = document.createElement("div");
    for (const [k, v] of Object.entries(attrs)) layer.setAttribute(k, v);
    if (zIndex !== undefined) layer.style.zIndex = String(zIndex);
    const button = document.createElement("button");
    button.textContent = "Layer action";
    layer.appendChild(button);
    if (placement === "prepend") {
      document.body.insertBefore(layer, document.body.firstChild);
    } else {
      document.body.appendChild(layer);
    }
    return { button, remove: () => layer.remove() };
  }

  it("Tab from a toast is left to the browser", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const { dialog } = await openPanel(user);
    const toast = mountLayer({ "data-sonner-toaster": "" });
    try {
      toast.button.focus();
      const notPrevented = fireEvent.keyDown(toast.button, { key: "Tab" });

      expect(notPrevented).toBe(true);
      expect(toast.button).toHaveFocus();
      expect(dialog.contains(document.activeElement)).toBe(false);
    } finally {
      toast.remove();
    }
  });

  it("Tab from a portal stacked above the panel is left alone too", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await openPanel(user);
    const portal = mountLayer({}, 2000);
    try {
      portal.button.focus();
      const notPrevented = fireEvent.keyDown(portal.button, { key: "Tab" });

      expect(notPrevented).toBe(true);
      expect(portal.button).toHaveFocus();
    } finally {
      portal.remove();
    }
  });

  it("Tab from a shadow-root host (Next's dev error overlay) is left alone", async () => {
    // Regression for the dev-only but real case. `<nextjs-portal>` is a <body>
    // child that is `display: inline; z-index: auto` and creates no stacking
    // context; what paints above everything is its `position: fixed` content
    // inside the shadow root, which this code cannot see from the host. Focus
    // retargeting is the tell: with focus in a shadow root,
    // `document.activeElement` is the HOST, so that is what the trap is handed
    // — and reclaiming it made the overlay's own controls unreachable without
    // closing the panel first.
    const user = userEvent.setup();
    renderSidebar();
    const { dialog } = await openPanel(user);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const inner = document.createElement("button");
    inner.textContent = "Overlay action";
    shadow.appendChild(inner);
    try {
      inner.focus();
      expect(document.activeElement).toBe(host);
      const notPrevented = fireEvent.keyDown(inner, { key: "Tab" });

      expect(notPrevented).toBe(true);
      expect(dialog.contains(document.activeElement)).toBe(false);
    } finally {
      host.remove();
    }
  });

  it("Tab from a `z-index: auto` layer is pulled back in, either side of the panel", async () => {
    // `auto` creates no stacking context, so the layer paints at level 0 —
    // below the panel's 1600 wherever it sits in DOM order. That is only a
    // sound read because the panel portals to <body> and 1600 is its real
    // root-level z-index; while it rendered inside the navbar (painting at 50)
    // this had to be guessed from sibling order, and the guess decided the
    // Next-overlay case above.
    const user = userEvent.setup();
    renderSidebar();
    const { dialog } = await openPanel(user);
    for (const placement of ["append", "prepend"] as const) {
      const layer = mountLayer({}, undefined, placement);
      try {
        layer.button.focus();
        const notPrevented = fireEvent.keyDown(layer.button, { key: "Tab" });

        expect(notPrevented).toBe(false);
        expect(dialog.contains(document.activeElement)).toBe(true);
      } finally {
        layer.remove();
      }
    }
  });

  it("Tab from the page behind (or a layer BELOW the panel) is pulled back in", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const { dialog } = await openPanel(user);
    const low = mountLayer({}, 1);
    try {
      for (const from of [
        screen.getByRole("button", { name: "Before" }),
        low.button,
      ]) {
        from.focus();
        const notPrevented = fireEvent.keyDown(from, { key: "Tab" });

        expect(notPrevented).toBe(false);
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
    } finally {
      low.remove();
    }
  });
});

describe("useAlertsSidebarClose", () => {
  it("lets inbox content close the panel, and focus goes back to the bell", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const { bell, dialog } = await openPanel(user);

    within(dialog).getByRole("link", { name: "Last row link" }).focus();
    await user.keyboard("{Enter}");

    expect(bell).toHaveAttribute("aria-expanded", "false");
    expect(bell).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("is null outside a sidebar", () => {
    const seen = vi.fn();
    renderWithProvider(<InboxStub onRender={seen} />);

    expect(seen).toHaveBeenLastCalledWith(null);
  });

  it("is a function inside the open sidebar", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    renderSidebar(seen);
    await openPanel(user);

    await act(async () => {});
    expect(typeof seen.mock.lastCall?.[0]).toBe("function");
  });
});

/**
 * `onOpenChange` exists so a host can react to the panel owning the viewport —
 * apps/web holds its scroll-aware navbar SHOWN while the panel is open, because
 * a navbar that slid away leaves focus-restore landing on an off-screen bell.
 * The notification therefore has to fire on EVERY transition (there are five
 * places that write `isOpen`) and on none of the non-transitions.
 */
describe("AlertsSidebar onOpenChange", () => {
  function renderWithOnOpenChange(onOpenChange: (open: boolean) => void) {
    return renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="web"
          onOpenChange={onOpenChange}
          renderInbox={() => <InboxStub />}
        />
      </NotificationProvider>,
    );
  }

  it("fires true on open and false on close", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithOnOpenChange(onOpenChange);

    // Mounting closed is not a transition.
    expect(onOpenChange).not.toHaveBeenCalled();

    const { dialog } = await openPanel(user);
    expect(onOpenChange.mock.calls).toEqual([[true]]);

    await user.click(within(dialog).getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it("fires false when Escape closes the panel", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithOnOpenChange(onOpenChange);

    await openPanel(user);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it("does not re-fire while the panel just sits open", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithOnOpenChange(onOpenChange);

    const { dialog } = await openPanel(user);
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    // A re-render from unrelated state inside the panel is not a transition.
    await user.click(within(dialog).getByRole("tab", { name: /^Activity/ }));
    await act(async () => {});

    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("adopts a new callback identity without notifying it", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const view = renderWithOnOpenChange(first);

    await openPanel(user);
    expect(first.mock.calls).toEqual([[true]]);

    // A host that passes an inline closure hands us a new function on every
    // render; that must not read as an open/close transition.
    view.rerender(
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="web"
          onOpenChange={second}
          renderInbox={() => <InboxStub />}
        />
      </NotificationProvider>,
    );
    await act(async () => {});
    expect(second).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(second.mock.calls).toEqual([[false]]);
    expect(first.mock.calls).toEqual([[true]]);
  });
});

/**
 * The host's hold (apps/web's navbar) is released by `onOpenChange(false)`.
 * Unmounting while open used to skip it, so a remount across the navbar's
 * breakpoint branches, or a sign-out, pinned the navbar shown for good.
 */
describe("AlertsSidebar onOpenChange across mount and unmount", () => {
  const flushMicrotasks = () => act(async () => {});

  function sidebar(
    onOpenChange: (open: boolean) => void,
    props: { defaultOpen?: boolean } = {},
  ) {
    return (
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="web"
          onOpenChange={onOpenChange}
          renderInbox={() => <InboxStub />}
          {...props}
        />
      </NotificationProvider>
    );
  }

  it("reports false when it unmounts while open", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const view = renderWithProvider(sidebar(onOpenChange));

    await openPanel(user);
    expect(onOpenChange.mock.calls).toEqual([[true]]);

    view.unmount();
    await flushMicrotasks();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it("stays silent when it unmounts closed", async () => {
    const onOpenChange = vi.fn();
    const view = renderWithProvider(sidebar(onOpenChange));

    view.unmount();
    await flushMicrotasks();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not report the close twice when it was already closed before unmounting", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const view = renderWithProvider(sidebar(onOpenChange));

    await openPanel(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    view.unmount();
    await flushMicrotasks();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it("tells the host a defaultOpen panel is open", async () => {
    const onOpenChange = vi.fn();
    renderWithProvider(sidebar(onOpenChange, { defaultOpen: true }));
    await flushMicrotasks();
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("StrictMode's effect replay adds no spurious calls (closed mount)", async () => {
    const onOpenChange = vi.fn();
    renderWithProvider(<StrictMode>{sidebar(onOpenChange)}</StrictMode>);
    await flushMicrotasks();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("StrictMode's effect replay adds no spurious calls (defaultOpen mount)", async () => {
    const onOpenChange = vi.fn();
    const view = renderWithProvider(
      <StrictMode>{sidebar(onOpenChange, { defaultOpen: true })}</StrictMode>,
    );
    await flushMicrotasks();
    expect(onOpenChange.mock.calls).toEqual([[true]]);

    view.unmount();
    await flushMicrotasks();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });
});

/**
 * Spotlight (apps/web) closes on a `document` Escape listener, which runs
 * before the panel's `window` one, and marks the event handled. One Escape
 * must close only the layer on top.
 */
describe("AlertsSidebar Escape and layers above it", () => {
  it("ignores an Escape another layer already handled", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const { bell } = await openPanel(user);

    const consume = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", consume);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
      await act(async () => {});
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(bell).toHaveAttribute("aria-expanded", "true");
    } finally {
      document.removeEventListener("keydown", consume);
    }

    // The next, unclaimed Escape is the panel's.
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bell).toHaveAttribute("aria-expanded", "false");
  });
});

describe("AlertsSidebar host-supplied labels", () => {
  it("names the dialog, its Close button and its view tabs from `labels`", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="web"
          formatButtonLabel={() => "Abrir notificaciones"}
          labels={{
            heading: "Notificaciones",
            close: "Cerrar",
            closeAriaLabel: "Cerrar notificaciones",
            viewTabs: "Vistas de notificaciones",
          }}
          renderInbox={() => <InboxStub />}
        />
      </NotificationProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: "Abrir notificaciones" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Notificaciones",
    });
    expect(
      within(dialog).getByRole("button", { name: "Cerrar notificaciones" }),
    ).toHaveTextContent("Cerrar");
    expect(
      within(dialog).getByRole("tablist", { name: "Vistas de notificaciones" }),
    ).toBeInTheDocument();
  });

  it("keeps the English defaults for a label the host leaves out", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="web"
          labels={{ heading: "Notificaciones" }}
          renderInbox={() => <InboxStub />}
        />
      </NotificationProvider>,
    );
    await user.click(screen.getByRole("button", { name: /open alerts/i }));
    const dialog = await screen.findByRole("dialog", {
      name: "Notificaciones",
    });
    expect(
      within(dialog).getByRole("button", { name: "Close notifications" }),
    ).toBeInTheDocument();
  });

  it("an explicitly undefined label keeps its default", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="web"
          labels={{ heading: undefined, closeAriaLabel: undefined }}
          renderInbox={() => <InboxStub />}
        />
      </NotificationProvider>,
    );
    await user.click(screen.getByRole("button", { name: /open alerts/i }));
    const dialog = await screen.findByRole("dialog", {
      name: "Notifications",
    });
    expect(
      within(dialog).getByRole("button", { name: "Close notifications" }),
    ).toBeInTheDocument();
  });
});
