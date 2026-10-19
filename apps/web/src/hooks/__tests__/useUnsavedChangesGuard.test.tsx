import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push }) }));

import {
  guardedLinkTarget,
  useUnsavedChangesGuard,
  type GuardedClick,
} from "../useUnsavedChangesGuard";

const HERE = "https://app.test/admin/acme/events/e1/edit";
const click = (over: Partial<GuardedClick> = {}): GuardedClick => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  href: "https://app.test/admin/acme/events",
  target: null,
  download: false,
  ...over,
});

describe("guardedLinkTarget", () => {
  it("returns the path of a same-origin link to another page", () => {
    expect(guardedLinkTarget(click(), HERE)).toBe("/admin/acme/events");
    expect(
      guardedLinkTarget(click({ href: "https://app.test/a?b=1#c" }), HERE),
    ).toBe("/a?b=1#c");
  });

  it.each([
    ["no link", { href: null }],
    ["modified click", { metaKey: true }],
    ["ctrl click", { ctrlKey: true }],
    ["middle button", { button: 1 }],
    ["new tab", { target: "_blank" }],
    ["download", { download: true }],
    ["already handled", { defaultPrevented: true }],
    ["other origin", { href: "https://other.test/x" }],
    ["same page", { href: HERE }],
    ["hash jump on this page", { href: `${HERE}#section` }],
    // The event rail's section anchors scroll in place on the same route.
    ["a ?section= link on this page", { href: `${HERE}?section=tickets` }],
  ] as const)("lets %s through", (_n, over) => {
    expect(guardedLinkTarget(click(over), HERE)).toBeNull();
  });
});

describe("useUnsavedChangesGuard", () => {
  afterEach(() => {
    push.mockClear();
    document.body.innerHTML = "";
  });

  const unload = () => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const link = (href: string, parent: HTMLElement = document.body) => {
    const a = document.createElement("a");
    a.href = href;
    parent.appendChild(a);
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    // Read the verdict after the guard (same capture phase), then cancel so jsdom
    // does not try to navigate for the clicks the guard lets through.
    let prevented = false;
    const probe = (ev: Event) => {
      prevented = ev.defaultPrevented;
      ev.preventDefault();
    };
    document.addEventListener("click", probe, true);
    a.dispatchEvent(e);
    document.removeEventListener("click", probe, true);
    return prevented;
  };

  it("does nothing while the form is clean", () => {
    renderHook(() => useUnsavedChangesGuard(false));
    expect(unload()).toBe(false);
    expect(link("/elsewhere")).toBe(false);
  });

  it("blocks unload and holds an in-app link while dirty", () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    expect(unload()).toBe(true);
    let prevented = false;
    act(() => {
      prevented = link("/elsewhere");
    });
    expect(prevented).toBe(true);
    expect(result.current.pendingHref).toBe("/elsewhere");
    expect(push).not.toHaveBeenCalled();
  });

  it("lets a ?section= link on the same route through, so the rail still scrolls", () => {
    window.history.replaceState({}, "", "/admin/acme/events/e1/edit");
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    let prevented = true;
    act(() => {
      prevented = link("/admin/acme/events/e1/edit?section=tickets");
    });
    expect(prevented).toBe(false);
    expect(result.current.prompting).toBe(false);
  });

  it("ignores links inside an editable description", () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.appendChild(editor);
    let prevented = true;
    act(() => {
      prevented = link("/elsewhere", editor);
    });
    expect(prevented).toBe(false);
    expect(result.current.prompting).toBe(false);
  });

  it("stay clears the pending link; leave follows it without a second prompt", () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => {
      link("/elsewhere");
    });
    act(() => result.current.stay());
    expect(result.current.pendingHref).toBeNull();
    act(() => {
      link("/elsewhere");
    });
    act(() => result.current.leave());
    expect(push).toHaveBeenCalledWith("/elsewhere");
    expect(unload()).toBe(false);
  });

  it("the discard covers one navigation only", () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => {
      link("/elsewhere");
    });
    act(() => result.current.leave());
    // The confirmed navigation's own unload passes once...
    expect(unload()).toBe(false);
    // ...and a later tab close while still dirty is warned again.
    expect(unload()).toBe(true);
  });

  it("a fresh prompt after a discard re-arms the unload warning", () => {
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => {
      link("/elsewhere");
    });
    act(() => result.current.leave());
    act(() => {
      link("/other");
    });
    expect(result.current.pendingHref).toBe("/other");
    expect(unload()).toBe(true);
  });

  it("going clean clears the discard", () => {
    const { result, rerender } = renderHook(
      ({ d }) => useUnsavedChangesGuard(d),
      { initialProps: { d: true } },
    );
    act(() => {
      link("/elsewhere");
    });
    act(() => result.current.leave());
    rerender({ d: false });
    rerender({ d: true });
    expect(unload()).toBe(true);
  });

  it("requestNavigation goes straight through while clean", () => {
    const run = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(false));
    act(() => result.current.requestNavigation("/admin/acme/events"));
    expect(push).toHaveBeenCalledWith("/admin/acme/events");
    act(() => result.current.requestNavigation(run));
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.prompting).toBe(false);
  });

  it("requestNavigation is held behind the prompt while dirty", () => {
    const run = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    act(() => result.current.requestNavigation(run));
    expect(result.current.prompting).toBe(true);
    expect(result.current.pendingHref).toBeNull();
    expect(run).not.toHaveBeenCalled();
    act(() => result.current.stay());
    expect(run).not.toHaveBeenCalled();
    act(() => result.current.requestNavigation(run));
    act(() => result.current.leave());
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.prompting).toBe(false);
  });

  it("removes its listeners when the form goes clean", () => {
    const { rerender } = renderHook(({ d }) => useUnsavedChangesGuard(d), {
      initialProps: { d: true },
    });
    rerender({ d: false });
    expect(unload()).toBe(false);
  });
});

describe("useUnsavedChangesGuard: browser Back", () => {
  const PREV = "/admin/acme/events";
  const PAGE = "/admin/acme/events/e1/edit";
  type Mark = { kind: string; first?: boolean } | undefined;
  const markOf = (): Mark =>
    (window.history.state as { __thLeaveGuard?: Mark } | null)?.__thLeaveGuard;
  const mark = () => markOf()?.kind ?? null;

  /** A fresh `[…, prev, page]` tail; returns the page entry's length. */
  const openPage = () => {
    window.history.pushState({ page: "prev" }, "", PREV);
    window.history.pushState({ page: "edit" }, "", PAGE);
    return window.history.length;
  };

  /** Waits out queued traversals (jsdom runs them as tasks) and their echoes. */
  const settle = () =>
    act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  /**
   * Traverses like the browser buttons do: jsdom queues the move and fires
   * `popstate` on window. Not awaited through a listener, because the guard
   * stops propagation on the pops it holds.
   */
  const traverse = async (delta: number) => {
    window.history.go(delta);
    await settle();
  };

  it("touches no history while the form stays clean", async () => {
    const length = openPage();
    const { rerender } = renderHook(() => useUnsavedChangesGuard(false));
    rerender();
    expect(window.history.length).toBe(length);
    expect(mark()).toBeNull();
    await traverse(-1);
    expect(window.location.pathname).toBe(PREV);
  });

  it("pushes one sentinel on going dirty, even under a replayed effect", () => {
    const length = openPage();
    const { result, rerender } = renderHook(
      ({ d }) => useUnsavedChangesGuard(d),
      { initialProps: { d: true }, wrapper: StrictMode },
    );
    expect(window.history.length).toBe(length + 1);
    expect(mark()).toBe("sentinel");
    expect(window.location.pathname).toBe(PAGE);
    // Flipping clean and dirty again (type, undo, type) does not churn.
    rerender({ d: false });
    rerender({ d: true });
    expect(window.history.length).toBe(length + 1);
    expect(result.current.prompting).toBe(false);
  });

  it("keeps Next's own history state on both entries", () => {
    window.history.pushState({ page: "prev" }, "", PREV);
    window.history.pushState({ __NA: true, tree: "t" }, "", PAGE);
    renderHook(() => useUnsavedChangesGuard(true));
    expect(window.history.state).toEqual({
      __NA: true,
      tree: "t",
      __thLeaveGuard: { kind: "sentinel", first: false },
    });
  });

  it("Back while dirty stays on the page and prompts", async () => {
    const length = openPage();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
    expect(result.current.pendingHref).toBeNull();
    expect(window.location.pathname).toBe(PAGE);
    expect(mark()).toBe("sentinel");
    expect(window.history.length).toBe(length + 1);
    // Stay keeps the page, still guarded.
    act(() => result.current.stay());
    expect(result.current.prompting).toBe(false);
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
    expect(window.location.pathname).toBe(PAGE);
  });

  it("Leave goes back once, to the page before, without the unload prompt", async () => {
    openPage();
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    await traverse(-1);
    act(() => result.current.leave());
    await settle();
    expect(window.location.pathname).toBe(PREV);
    expect(window.history.state).toEqual({ page: "prev" });
    expect(result.current.prompting).toBe(false);
    expect(unload()).toBe(false);
  });

  it("a Back that jumps straight off the page is held before Next sees it", async () => {
    openPage();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    // Next's listener and the page's own sit after the guard's capture one.
    const seen: string[] = [];
    const later = () => seen.push(window.location.href);
    window.addEventListener("popstate", later);
    await traverse(-2);
    window.removeEventListener("popstate", later);
    // The real pop (onto PREV) never reached them; only the synthetic one
    // announcing the restored sentinel did.
    expect(seen).toEqual([`${window.location.origin}${PAGE}`]);
    expect(window.location.pathname).toBe(PAGE);
    expect(mark()).toBe("sentinel");
    expect(result.current.prompting).toBe(true);
    act(() => result.current.leave());
    await settle();
    expect(window.location.pathname).toBe(PREV);
  });

  it("query-only moves on the page (preview, ?section=) never prompt", async () => {
    openPage();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    window.history.pushState({ thPreview: true }, "", `${PAGE}?view=preview`);
    window.history.pushState({}, "", `${PAGE}?section=tickets`);
    await traverse(-1);
    expect(result.current.prompting).toBe(false);
    await traverse(-1);
    expect(result.current.prompting).toBe(false);
    expect(mark()).toBe("sentinel");
    // Forward over the same entries is the page's own too.
    await traverse(1);
    expect(result.current.prompting).toBe(false);
    await traverse(-1);
    // Below the sentinel is leaving.
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
  });

  it("after going clean, one Back still reaches the page before", async () => {
    openPage();
    const { result, rerender } = renderHook(
      ({ d }) => useUnsavedChangesGuard(d),
      { initialProps: { d: true } },
    );
    rerender({ d: false });
    await traverse(-1);
    await settle();
    expect(result.current.prompting).toBe(false);
    expect(window.location.pathname).toBe(PREV);
  });

  it("a remount onto the sentinel adopts it instead of stacking another", async () => {
    const length = openPage();
    const first = renderHook(() => useUnsavedChangesGuard(true));
    first.unmount();
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    expect(window.history.length).toBe(length + 1);
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
  });

  it("removes its popstate listener on unmount", async () => {
    openPage();
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true));
    unmount();
    await traverse(-1);
    expect(mark()).toBe("base");
    await traverse(-1);
    expect(window.location.pathname).toBe(PREV);
  });

  describe("where the tab's history starts", () => {
    let navIndex: number | null = null;
    let lengthSpy: { mockRestore: () => void } | null = null;
    beforeEach(() => {
      Object.defineProperty(window, "navigation", {
        configurable: true,
        get: () =>
          navIndex === null ? undefined : { currentEntry: { index: navIndex } },
      });
    });
    afterEach(() => {
      navIndex = null;
      lengthSpy?.mockRestore();
      lengthSpy = null;
      delete (window as { navigation?: unknown }).navigation;
    });
    const stubLength = (n: number) => {
      lengthSpy = vi
        .spyOn(History.prototype, "length", "get")
        .mockReturnValue(n);
    };

    it("prompts on Back when earlier entries are on another origin", async () => {
      // The Navigation API counts only the same-origin run: index 0 here
      // even though the tab came from another site.
      navIndex = 0;
      openPage();
      const { result } = renderHook(() => useUnsavedChangesGuard(true));
      expect(markOf()).toEqual({ kind: "sentinel", first: false });
      await traverse(-1);
      expect(result.current.prompting).toBe(true);
      act(() => result.current.leave());
      await settle();
      expect(window.location.pathname).toBe(PREV);
    });

    it("arms nothing when this page is the tab's only entry", () => {
      openPage();
      stubLength(1);
      const push = vi.spyOn(window.history, "pushState");
      renderHook(() => useUnsavedChangesGuard(true));
      expect(push).not.toHaveBeenCalled();
      expect(mark()).toBeNull();
      push.mockRestore();
    });

    it("a first base takes one Back and rests there, no prompt", async () => {
      openPage();
      stubLength(2);
      const { result, rerender } = renderHook(
        ({ d }) => useUnsavedChangesGuard(d),
        { initialProps: { d: true } },
      );
      expect(markOf()).toEqual({ kind: "sentinel", first: true });
      const push = vi.spyOn(window.history, "pushState");
      await traverse(-1);
      // On the base, which the browser treats as the tab's start: Back is
      // disabled again rather than enabled and inert.
      expect(result.current.prompting).toBe(false);
      expect(mark()).toBe("base");
      expect(push).not.toHaveBeenCalled();
      await settle();
      expect(mark()).toBe("base");
      expect(window.location.pathname).toBe(PAGE);
      // Forward reaches the sentinel again; clean, a Back rests the same way.
      await traverse(1);
      expect(mark()).toBe("sentinel");
      rerender({ d: false });
      await traverse(-1);
      expect(mark()).toBe("base");
      expect(window.location.pathname).toBe(PAGE);
      push.mockRestore();
    });

    it("a Forward from an entry below the base is not taken for a Back", async () => {
      // [prev, page?section=a, page(base), page(sentinel)]
      window.history.pushState({ page: "prev" }, "", PREV);
      window.history.pushState({}, "", `${PAGE}?section=a`);
      window.history.pushState({ page: "edit" }, "", PAGE);
      navIndex = 3;
      const { result } = renderHook(() => useUnsavedChangesGuard(true));
      // Long-press jump past the base onto the older entry of the page.
      navIndex = 1;
      await traverse(-2);
      expect(result.current.prompting).toBe(false);
      navIndex = 2;
      await traverse(1);
      expect(mark()).toBe("base");
      expect(result.current.prompting).toBe(false);
    });
  });

  it("Leave keeps going past an older entry of the same page", async () => {
    window.history.pushState({ page: "prev" }, "", PREV);
    window.history.pushState({}, "", `${PAGE}?section=a`);
    window.history.pushState({ page: "edit" }, "", PAGE);
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    await traverse(-1);
    act(() => result.current.leave());
    await settle();
    await settle();
    expect(window.location.pathname).toBe(PREV);
  });

  it("does not base the sentinel on an entry the page pops itself", async () => {
    const isPreview = (url: URL) => url.searchParams.get("view") === "preview";
    const length = openPage();
    window.history.pushState({ thPreview: true }, "", `${PAGE}?view=preview`);
    const { result } = renderHook(() =>
      useUnsavedChangesGuard(true, { deferBackGuardOn: isPreview }),
    );
    expect(window.history.length).toBe(length + 1);
    expect(mark()).toBeNull();
    // The page's own pop off the preview entry: no prompt, and it arms here.
    await traverse(-1);
    expect(result.current.prompting).toBe(false);
    expect(window.location.search).toBe("");
    expect(mark()).toBe("sentinel");
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
  });

  const unloadBlocked = () => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("a Leave that cannot get off the page gives up and re-arms", async () => {
    // [prev, page?section=a, page(base), page(sentinel)], where the
    // ?section=a entry is the start of the tab: its back() does nothing.
    window.history.pushState({ page: "prev" }, "", PREV);
    window.history.pushState({}, "", `${PAGE}?section=a`);
    window.history.pushState({ page: "edit" }, "", PAGE);
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
    const back = vi
      .spyOn(History.prototype, "back")
      .mockImplementation(() => {});
    act(() => result.current.leave());
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    back.mockRestore();
    expect(window.location.search).toBe("?section=a");
    expect(result.current.prompting).toBe(false);
    // The discard is withdrawn: closing the tab warns again...
    expect(unloadBlocked()).toBe(true);
    // ...and Back is guarded again from here.
    expect(mark()).toBe("sentinel");
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
  });

  it("without the Navigation API, a Forward back onto the base is not a Back", async () => {
    window.history.pushState({ page: "prev" }, "", PREV);
    window.history.pushState({}, "", `${PAGE}?section=a`);
    window.history.pushState({ page: "edit" }, "", PAGE);
    const { result } = renderHook(() => useUnsavedChangesGuard(true));
    await traverse(-2);
    expect(window.location.search).toBe("?section=a");
    await traverse(1);
    expect(mark()).toBe("base");
    expect(result.current.prompting).toBe(false);
    // Forward again to the sentinel, and Back from it is guarded as usual.
    await traverse(1);
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
  });

  it("arms after the page leaves a deferred entry by replaceState", async () => {
    const isPreview = (url: URL) => url.searchParams.get("view") === "preview";
    openPage();
    // Deep-linked straight into preview: no edit entry under it.
    window.history.replaceState({}, "", `${PAGE}?view=preview`);
    const { result, rerender } = renderHook(() =>
      useUnsavedChangesGuard(true, { deferBackGuardOn: isPreview }),
    );
    expect(mark()).toBeNull();
    // The builder's exit: rewrite the URL in place, then re-render.
    window.history.replaceState({}, "", PAGE);
    rerender();
    expect(mark()).toBe("sentinel");
    await traverse(-1);
    expect(result.current.prompting).toBe(true);
  });
});
