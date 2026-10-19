/**
 * Edit | Preview toggle for the entity page editor.
 *
 * Preview swaps the main column to the real page render fed with the CURRENT
 * in-memory page/blocks/theme, so unsaved edits preview live. The authoring
 * surface stays MOUNTED (display:none) so the settings disclosure, open
 * block-settings panels, and the live undo/redo history survive the trip.
 *
 * The editor's heavy children and data layer are stubbed; the toggle, the
 * mode plumbing, the display:none preservation, and the device selector's
 * move into Preview are exercised for real.
 */
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// ── DOM-level stand-ins for the styling layer ─────────────────────────────

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: (_base: unknown, config?: { tag?: string }) =>
      makeStack(config?.tag === "button" ? "button" : "div"),
    useMedia: () => ({ lg: false }),
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)/;
  const pick = (rest: Record<string, unknown>) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (PASS_PROP.test(key)) domProps[key] = value;
    }
    return domProps;
  };
  return {
    Text: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => React.createElement("span", pick(rest), children),
    Spinner: () => null,
    Tooltip: ({ anchor }: { anchor?: ReactNode }) => anchor ?? null,
    // Mirrors the real `Button`: a disabled one forwards BOTH the native
    // attribute (so nothing fires) AND `aria-disabled` (so assistive tech
    // reports it). The mock used to set only the native one, which made every
    // `aria-disabled` assertion against a `disabled` button read as null.
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          onClick: onPress,
          disabled,
          ...(disabled ? { "aria-disabled": true } : {}),
          ...pick(rest),
        },
        children,
      ),
    useTranslations: () => (key: string) => key,
  };
});

// ── Heavy child surfaces → cheap stubs ────────────────────────────────────

// The profile form is a stub, but a stub that still REGISTERS with the save
// registry — the toolbar's Save is driven entirely by what the forms publish,
// so a stub that registered nothing would make every Save assertion vacuous.
const { saveRef } = vi.hoisted(() => ({
  saveRef: {
    current: { isDirty: false, isPending: false, blocked: false, save: () => {} },
  },
}));

vi.mock("../PageFieldsEditor", async () => {
  const React = await import("react");
  const { useRegisterPageSettingsSave } = await import("../page-settings-save");
  return {
    PageFieldsEditor: () => {
      useRegisterPageSettingsSave({
        id: "profile",
        isDirty: saveRef.current.isDirty,
        isPending: saveRef.current.isPending,
        blocked: saveRef.current.blocked,
        save: () => saveRef.current.save(),
      });
      return React.createElement("div", { "data-testid": "mock-fields-editor" });
    },
  };
});
vi.mock("../PageThemeEditor", async () => {
  const React = await import("react");
  return {
    PageThemeEditor: () =>
      React.createElement("div", { "data-testid": "mock-theme-editor" }),
  };
});
vi.mock("../EditorHeader", () => ({ EditorHeader: () => null }));
const { historyRef } = vi.hoisted(() => ({
  historyRef: {
    current: {
      canUndo: false,
      canRedo: false,
      isBusy: false,
      undo: () => undefined as void,
      redo: () => undefined as void,
      undoLabel: null as string | null,
      redoLabel: null as string | null,
    },
  },
}));
vi.mock("../useBlockHistory", () => ({
  useBlockHistory: () => historyRef.current,
}));

// Render-prop stub: hands the canvas the blocks it was given, unchanged, so
// the canvas's own `selectCanvasBlocks` filtering still runs for real.
vi.mock("../PageBlocksEditor", async () => {
  const React = await import("react");
  return {
    PageBlocksEditor: ({
      blocks,
      children,
    }: {
      blocks: unknown[];
      children?: unknown;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "mock-blocks-editor" },
        typeof children === "function"
          ? (children as (b: unknown[]) => ReactNode)(blocks)
          : (children as ReactNode),
      ),
  };
});

// The public page renderer. Emits one marker per block it was handed, so a
// test can assert WHICH blocks reached each surface.
vi.mock("@/app/p/[slug]/_components/EntityPageContent", async () => {
  const React = await import("react");
  return {
    EntityPageContent: ({
      data,
    }: {
      data: { blocks: { id: string; kind: string }[] };
    }) =>
      React.createElement(
        "div",
        { "data-testid": "mock-entity-page-content" },
        data.blocks.map((block) =>
          React.createElement(
            "span",
            { key: block.id, "data-testid": `rendered-block-${block.id}` },
            block.kind,
          ),
        ),
      ),
  };
});

// ── App-level hooks / chrome ──────────────────────────────────────────────


const { gateRef, humanGateRef } = vi.hoisted(() => ({
  gateRef: { current: false },
  humanGateRef: { current: true },
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({
    gates: {
      entityPageEditor: gateRef.current,
      humanProfilesPublic: humanGateRef.current,
    },
  }),
}));

// ── Data layer ────────────────────────────────────────────────────────────

const { layoutRef, visibilityRef, PAGE, BLOCKS, ENTITY } = vi.hoisted(() => {
  const PAGE = {
    id: "page-1",
    ownerType: "ORGANIZATION" as const,
    ownerId: "org-1",
    slug: "acme-co",
    displayName: "Acme Co",
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    visibility: "PUBLIC" as const,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const BLOCKS = [
    {
      id: "blk-about",
      pageId: "page-1",
      kind: "about",
      orderIndex: 0,
      data: {},
      visible: true,
      section: "main",
    },
    {
      id: "blk-hidden",
      pageId: "page-1",
      kind: "links",
      orderIndex: 1,
      data: {},
      visible: false,
      section: "main",
    },
  ];
  const ENTITY = {
    type: "ORGANIZATION" as const,
    id: "org-1",
    name: "Acme Co",
    slug: "acme-co",
    trustTier: "UNVERIFIED" as const,
    trustBadgeLabel: null,
  };
  // Mutable so a test can pick the editor mode: "standard" → edit-only,
  // "grid" (with the gate on) → full.
  const layoutRef = { current: "standard" };
  // Mutable so a test can make the page non-public (the mobile check is an
  // iframe of /p/<slug>, which 404s for a PRIVATE page).
  const visibilityRef = { current: "PUBLIC" };
  return { layoutRef, visibilityRef, PAGE, BLOCKS, ENTITY };
});

vi.mock("@/trpc", () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : chain),
    apply: () => undefined,
  });
  // Cached PER (layout, visibility) so a re-render never hands React a fresh
  // data object (which would retrigger the editor's identity-keyed memos every
  // keystroke).
  const byLayout = new Map<string, unknown>();
  const getMyPageResult = () => {
    const layoutKey = layoutRef.current;
    const visibility = visibilityRef.current;
    const cacheKey = `${layoutKey}|${visibility}`;
    if (!byLayout.has(cacheKey)) {
      byLayout.set(cacheKey, {
        data: {
          page: { ...PAGE, visibility },
          blocks: BLOCKS,
          theme: {
            colorPrimary: null,
            colorBg: null,
            colorText: null,
            fontKey: "montserrat",
            layoutKey,
          },
          entity: ENTITY,
        },
        isLoading: false,
        isError: false,
        isSuccess: true,
      });
    }
    return byLayout.get(cacheKey);
  };
  const mutationResult = { mutate: () => undefined, isPending: false };
  return {
    trpc: {
      useUtils: () => chain,
      entityPages: {
        getMyPage: { useQuery: () => getMyPageResult() },
        managePageBlocks: { useMutation: () => mutationResult },
      },
    },
  };
});

import { PageEditorView } from "../PageEditorView";

const renderEditor = () =>
  render(<PageEditorView ownerType="ORGANIZATION" ownerId="org-1" />);

const previewSurface = () => screen.queryByTestId("entity-page-preview-surface");

describe("entity page editor — Edit | Preview toggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    saveRef.current = {
      isDirty: false,
      isPending: false,
      blocked: false,
      save: () => {},
    };
    gateRef.current = false;
    humanGateRef.current = true;
    historyRef.current = {
      canUndo: false,
      canRedo: false,
      isBusy: false,
      undo: () => undefined,
      redo: () => undefined,
      undoLabel: null,
      redoLabel: null,
    };
    layoutRef.current = "standard";
    visibilityRef.current = "PUBLIC";
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    window.history.replaceState({}, "", "/admin/acme-co/page");
  });

  it("renders the toggle in the edit-only mode (the default standard template)", () => {
    renderEditor();

    expect(screen.getByTestId("entity-page-view-mode-toggle")).toBeTruthy();
    expect(screen.getByTestId("entity-page-view-mode-edit")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("entity-page-view-mode-preview")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("renders the toggle in the full editor mode too", () => {
    gateRef.current = true;
    layoutRef.current = "grid";
    renderEditor();

    // Sanity: this really is the gated structural editor (palette present).
    expect(screen.getByTestId("entity-page-add-block-palette")).toBeTruthy();
    expect(screen.getByTestId("entity-page-view-mode-toggle")).toBeTruthy();
  });

  it("swaps the main column to the preview and keeps the edit surface MOUNTED", () => {
    renderEditor();

    const editSurface = screen.getByTestId("entity-page-edit-surface");
    expect(editSurface).not.toHaveStyle({ display: "none" });
    expect(previewSurface()).toBeNull();

    fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));

    // Preview is up, edit chrome is hidden — not unmounted.
    expect(previewSurface()).not.toBeNull();
    expect(screen.getByTestId("entity-page-edit-surface")).toHaveStyle({
      display: "none",
    });
    // The settings disclosure is edit chrome: still in the DOM (state
    // preserved) but inside the hidden surface.
    const hidden = screen.getByTestId("entity-page-edit-surface");
    expect(
      within(hidden).getByTestId("entity-page-settings-disclosure"),
    ).toBeTruthy();
    // Undo/redo live on the toolbar row (outside the hidden surface) and are
    // UNMOUNTED in preview — they are editing chrome, and the history state
    // they act on lives in the hook, not in these buttons.
    expect(screen.queryByTestId("entity-page-history-controls")).toBeNull();

    expect(
      screen.getByTestId("entity-page-view-mode-preview"),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("restores the edit surface when toggling back", async () => {
    renderEditor();

    fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));
    expect(previewSurface()).not.toBeNull();

    fireEvent.click(screen.getByTestId("entity-page-view-mode-edit"));

    expect(screen.getByTestId("entity-page-edit-surface")).not.toHaveStyle({
      display: "none",
    });
    expect(previewSurface()).toBeNull();
    await waitFor(() =>
      expect(window.location.search).not.toContain("view=preview"),
    );
  });

  it("shows the device selector ONLY in preview", () => {
    renderEditor();

    // Edit mode is authoring only — no viewport switch on the canvas.
    expect(screen.queryByTestId("entity-page-preview-desktop")).toBeNull();
    expect(screen.queryByTestId("entity-page-preview-mobile")).toBeNull();
    expect(screen.getByTestId("entity-page-edit-canvas")).toBeTruthy();

    fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));

    expect(screen.getByTestId("entity-page-preview-desktop")).toBeTruthy();
    expect(screen.getByTestId("entity-page-preview-mobile")).toBeTruthy();
    expect(screen.getByTestId("entity-page-preview-frame-desktop")).toBeTruthy();

    fireEvent.click(screen.getByTestId("entity-page-view-mode-edit"));
    expect(screen.queryByTestId("entity-page-preview-desktop")).toBeNull();
  });

  it("drops hidden blocks from the preview while the canvas keeps them", () => {
    renderEditor();

    // Canvas: both blocks, so a hidden one can be switched back on.
    const canvas = screen.getByTestId("entity-page-edit-canvas");
    expect(within(canvas).getByTestId("rendered-block-blk-about")).toBeTruthy();
    expect(within(canvas).getByTestId("rendered-block-blk-hidden")).toBeTruthy();

    fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));

    // Preview is the published render: `getPublicPage` returns visible blocks
    // only, so the hidden one must be absent.
    const preview = screen.getByTestId("entity-page-preview-surface");
    expect(within(preview).getByTestId("rendered-block-blk-about")).toBeTruthy();
    expect(
      within(preview).queryByTestId("rendered-block-blk-hidden"),
    ).toBeNull();
  });

  it("pushes a marked ?view=preview entry so browser Back exits preview in place", async () => {
    renderEditor();

    const pushSpy = vi.spyOn(window.history, "pushState");
    fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));

    expect(window.location.search).toContain("view=preview");
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0]?.[0]).toEqual({ thPreview: true });

    // Browser Back lands on the editor entry: preview closes IN PLACE.
    window.history.back();

    await waitFor(() =>
      expect(window.location.search).not.toContain("view=preview"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("entity-page-edit-surface")).not.toHaveStyle({
        display: "none",
      }),
    );
    expect(previewSurface()).toBeNull();
  });

  it("pops its own pushed entry (history.back) when exiting via the toggle", async () => {
    renderEditor();

    fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));

    const backSpy = vi.spyOn(window.history, "back");
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    fireEvent.click(screen.getByTestId("entity-page-view-mode-edit"));

    // Toggle-exit pops the entry we pushed — never replaceState, which would
    // strand the stale preview entry behind the editor.
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(window.location.search).not.toContain("view=preview"),
    );
    // The pop is swallowed by the re-entrancy guard: still in edit mode.
    expect(screen.getByTestId("entity-page-edit-surface")).not.toHaveStyle({
      display: "none",
    });
  });

  it("falls back to replaceState when the URL no longer says preview (Back+toggle race)", () => {
    renderEditor();

    fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));
    // A queued Back traversal already moved location off our entry, but its
    // popstate has not reached the listener yet.
    window.history.replaceState({}, "", "/admin/acme-co/page");

    const backSpy = vi.spyOn(window.history, "back");
    fireEvent.click(screen.getByTestId("entity-page-view-mode-edit"));

    // A second history.back() would land one entry too far — outside the editor.
    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("view=preview");
    expect(screen.getByTestId("entity-page-edit-surface")).not.toHaveStyle({
      display: "none",
    });
  });

  it("opens in preview when deep-linked to ?view=preview, and exits in place", () => {
    window.history.replaceState({}, "", "/admin/acme-co/page?view=preview");
    renderEditor();

    expect(previewSurface()).not.toBeNull();
    expect(screen.getByTestId("entity-page-edit-surface")).toHaveStyle({
      display: "none",
    });

    // Nothing of ours sits behind a deep link, so exit rewrites in place.
    const backSpy = vi.spyOn(window.history, "back");
    fireEvent.click(screen.getByTestId("entity-page-view-mode-edit"));

    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("view=preview");
  });

  it("SEEDS preview from the URL rather than swapping after paint", () => {
    window.history.replaceState({}, "", "/admin/acme-co/page?view=preview");
    renderEditor();

    // `switchViewMode` is what scrolls to top on entering preview. A deep link
    // that arrived via the mount EFFECT would have gone through it (and so
    // painted the whole authoring surface first). Seeded state never does.
    expect(previewSurface()).not.toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  // ── Blocker 3: a fragment link pushes an entry on top of ours ────────────
  it("does NOT history.back() when a fragment entry sits on top of the preview entry", () => {
    renderEditor();

    // A → B: our marked preview entry.
    fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));
    expect(window.history.state).toEqual({ thPreview: true });

    // B → C: an in-preview anchor CTA ("#org-contact") — the browser pushes a
    // same-document entry with null state, still on the ?view=preview URL.
    window.history.pushState(
      null,
      "",
      "/admin/acme-co/page?view=preview#org-contact",
    );

    const backSpy = vi.spyOn(window.history, "back");
    fireEvent.click(screen.getByTestId("entity-page-view-mode-edit"));

    // history.back() would land on B — URL still saying ?view=preview while
    // the UI says Edit, and a reload would reopen in the wrong mode.
    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("view=preview");
    expect(screen.getByTestId("entity-page-view-mode-edit")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("entity-page-edit-surface")).not.toHaveStyle({
      display: "none",
    });
  });

  // ── Blocker 2: the mobile check is the PUBLISHED page ────────────────────
  describe("mobile check", () => {
    it("labels the frame as the published version, not a live preview", () => {
      renderEditor();
      fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));
      fireEvent.click(screen.getByTestId("entity-page-preview-mobile"));

      const frame = screen.getByTestId("entity-page-preview-frame-mobile");
      expect(frame).toBeTruthy();
      expect(
        screen.getByTestId("entity-page-preview-mobile-notice"),
      ).toHaveTextContent("admin.pePreviewMobilePublishedNotice");
      // The iframe's accessible name says the same thing. It used to be
      // "Live preview of your published page" over saved content — the two
      // halves of one control asserting opposite things.
      expect(frame.querySelector("iframe")).toHaveAttribute(
        "title",
        "admin.pePreviewMobilePublishedNotice",
      );
    });

    it("loads the PUBLIC view, never the manager's own (arrival areas)", () => {
      renderEditor();
      fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));
      fireEvent.click(screen.getByTestId("entity-page-preview-mobile"));

      // The iframe carries the manager's cookies; `?preview=public` is what
      // stops the page probing for their load-in / withheld-place areas.
      const src = screen
        .getByTestId("entity-page-preview-frame-mobile")
        .querySelector("iframe")
        ?.getAttribute("src");
      expect(src).toMatch(/^\/p\/[^?]+\?preview=public$/);
    });

    it("is not offered for a PRIVATE page (/p/<slug> 404s)", () => {
      visibilityRef.current = "PRIVATE";
      renderEditor();
      fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));

      // No device toggle at all — desktop-only is the whole choice.
      expect(screen.queryByTestId("entity-page-preview-mobile")).toBeNull();
      expect(
        screen.queryByTestId("entity-page-preview-device-toggle"),
      ).toBeNull();
      expect(
        screen.getByTestId("entity-page-preview-frame-desktop"),
      ).toBeTruthy();
    });

    it("is still offered for an UNLISTED page (which renders publicly)", () => {
      visibilityRef.current = "UNLISTED";
      renderEditor();
      fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));

      expect(screen.getByTestId("entity-page-preview-mobile")).toBeTruthy();
    });
  });

  describe("keyboard shortcuts", () => {
    it("toggles preview with Cmd/Ctrl+Shift+P", () => {
      renderEditor();

      fireEvent.keyDown(window, { key: "P", metaKey: true, shiftKey: true });
      expect(previewSurface()).not.toBeNull();

      fireEvent.keyDown(window, { key: "P", metaKey: true, shiftKey: true });
      expect(previewSurface()).toBeNull();
    });

    it("exits preview with Escape", () => {
      renderEditor();

      fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));
      expect(previewSurface()).not.toBeNull();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(previewSurface()).toBeNull();
    });

    it("leaves Escape to an open dialog", () => {
      renderEditor();
      fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));

      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.appendChild(dialog);
      try {
        fireEvent.keyDown(window, { key: "Escape" });
        expect(previewSurface()).not.toBeNull();
      } finally {
        dialog.remove();
      }
    });
  });
  // ── Undo/redo: named scope, real buttons, honest shortcut signalling ─────
  describe("block history controls", () => {
    const withUndo = (undoLabel: string | null, canUndo = undoLabel !== null) => {
      historyRef.current = {
        ...historyRef.current,
        canUndo,
        undoLabel,
      };
    };

    it("names the pending action in the label and the tooltip", () => {
      const undo = vi.fn();
      withUndo("hide \u2018Upcoming events\u2019");
      historyRef.current = { ...historyRef.current, undo };
      renderEditor();

      const button = screen.getByTestId("entity-page-undo");
      // A bare "Undo" would read as "take back my typing"; this publishes an
      // inverse mutation to a live page, so the name states the scope.
      expect(button).toHaveAttribute(
        "aria-label",
        "admin.peUndoAction",
      );
      expect(button).toHaveAttribute("aria-keyshortcuts", "Meta+Z Control+Z");
      expect(button).not.toHaveAttribute("aria-disabled");

      fireEvent.click(button);
      expect(undo).toHaveBeenCalledTimes(1);
    });

    it("reads as disabled — but focusable — with nothing to undo", () => {
      renderEditor();

      const button = screen.getByTestId("entity-page-undo");
      expect(button).toHaveAttribute("aria-disabled", "true");
      // NOT the native `disabled` attribute: the button must stay reachable so
      // the "nothing to undo yet" tooltip can actually be read.
      expect(button).not.toHaveAttribute("disabled");
      expect(button).toHaveAttribute("aria-label", "admin.peUndoNothing");
    });

    it("does not fire undo while inactive", () => {
      const undo = vi.fn();
      historyRef.current = { ...historyRef.current, undo, canUndo: false };
      renderEditor();

      fireEvent.click(screen.getByTestId("entity-page-undo"));
      expect(undo).not.toHaveBeenCalled();
    });

    it("is hidden in preview mode (it is editing chrome)", () => {
      withUndo("hide \u2018Upcoming events\u2019");
      renderEditor();
      expect(screen.getByTestId("entity-page-history-controls")).toBeTruthy();

      fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));
      expect(screen.queryByTestId("entity-page-history-controls")).toBeNull();
      expect(screen.queryByTestId("entity-page-undo")).toBeNull();
    });

    describe("which Cmd/Ctrl+Z is live", () => {
      it("advertises the shortcut while no field has focus", () => {
        withUndo("edit \u2018About\u2019");
        renderEditor();

        expect(screen.getByTestId("entity-page-undo")).toHaveAttribute(
          "aria-keyshortcuts",
          "Meta+Z Control+Z",
        );
      });

      it("drops the shortcut, but stays clickable, while a field has focus", () => {
        const undo = vi.fn();
        withUndo("edit \u2018About\u2019");
        historyRef.current = { ...historyRef.current, undo };
        renderEditor();

        const field = document.createElement("input");
        document.body.appendChild(field);
        try {
          fireEvent.focusIn(field, { target: field });

          const button = screen.getByTestId("entity-page-undo");
          // The window keydown handler bails for an editable target, so the
          // key genuinely will not reach this button — do not claim it does.
          expect(button).not.toHaveAttribute("aria-keyshortcuts");
          // But the BUTTON still works. Disabling it here would be a lie in
          // the other direction.
          expect(button).not.toHaveAttribute("aria-disabled");
          fireEvent.click(button);
          expect(undo).toHaveBeenCalledTimes(1);

          // Focus leaves the field → the shortcut is live again.
          fireEvent.focusOut(field, { relatedTarget: null });
          expect(screen.getByTestId("entity-page-undo")).toHaveAttribute(
            "aria-keyshortcuts",
            "Meta+Z Control+Z",
          );
        } finally {
          field.remove();
        }
      });
    });
  });
  // ── The settings panel's one Save, lifted into the toolbar (2026-08-30) ──
  // Profile and Theme each used to carry a Save INSIDE the collapsed
  // disclosure, so saving meant noticing the panel, opening it, and finding
  // the right subsection. The toolbar now renders one Save, driven by what the
  // forms register.
  describe("toolbar Save", () => {
    const saveButton = () => screen.queryByTestId("entity-page-save");

    /**
     * The forms only exist while the disclosure is open, so nothing registers
     * until it is. Every "Save is live" assertion has to open it first — a
     * test that skipped this would pass because the registry was EMPTY, which
     * is the opposite of what it claims to check.
     */
    const openSettings = () => {
      const toggle = screen.getByTestId("entity-page-settings-toggle");
      if (toggle.getAttribute("aria-expanded") !== "true") {
        fireEvent.click(toggle);
      }
    };

    it("is present but inert while nothing is dirty", () => {
      renderEditor();
      openSettings();

      const button = saveButton();
      expect(button).toBeTruthy();
      // `aria-disabled`, mirroring the real Button — the same convention the
      // undo control uses.
      expect(button).toHaveAttribute("aria-disabled", "true");
    });

    it("stays inert while the panel has never been opened", () => {
      // Nothing can be dirty if the forms were never mounted, so an enabled
      // Save here would be a lie.
      saveRef.current = { ...saveRef.current, isDirty: true };
      renderEditor();

      expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    });

    it("wakes up when a form registers unsaved input", () => {
      saveRef.current = { ...saveRef.current, isDirty: true };
      renderEditor();
      openSettings();

      // An enabled Button carries no `aria-disabled` at all.
      expect(saveButton()).not.toHaveAttribute("aria-disabled");
    });

    it("commits every dirty form when pressed", () => {
      const save = vi.fn();
      saveRef.current = { ...saveRef.current, isDirty: true, save };
      renderEditor();
      openSettings();

      fireEvent.click(saveButton()!);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("refuses a dirty form that is failing its own validation", () => {
      // A slug someone else already owns: dirty, but not savable. The form
      // owns that rule; the toolbar only has to honour it.
      const save = vi.fn();
      saveRef.current = {
        ...saveRef.current,
        isDirty: true,
        blocked: true,
        save,
      };
      renderEditor();
      openSettings();

      expect(saveButton()).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(saveButton()!);
      expect(save).not.toHaveBeenCalled();
    });

    it("stays inert while a save is already in flight", () => {
      saveRef.current = { ...saveRef.current, isDirty: true, isPending: true };
      renderEditor();
      openSettings();

      expect(saveButton()).toHaveAttribute("aria-disabled", "true");
    });

    it("is hidden in preview, where its targets are off screen", () => {
      saveRef.current = { ...saveRef.current, isDirty: true };
      renderEditor();
      openSettings();
      expect(saveButton()).toBeTruthy();

      fireEvent.click(screen.getByTestId("entity-page-view-mode-preview"));
      expect(saveButton()).toBeNull();
    });

    it("leaves no second Save inside the settings panel", () => {
      saveRef.current = { ...saveRef.current, isDirty: true };
      renderEditor();
      openSettings();

      // One `data-entity-page-save` on the page, and it is the toolbar's.
      const saves = document.querySelectorAll('[data-entity-page-save="true"]');
      expect(saves).toHaveLength(1);
      expect(saves[0]).toBe(saveButton());
    });
  });
});
