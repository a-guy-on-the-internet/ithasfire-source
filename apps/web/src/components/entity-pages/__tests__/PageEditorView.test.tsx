import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AccountPageEditor from "@/app/account/page/page";

const pageEditorViewMock = vi.fn((_: unknown) => (
  <div data-testid="page-editor-view" />
));

vi.mock("@/components/entity-pages", () => ({
  PageEditorView: (props: unknown) => pageEditorViewMock(props),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      isPending: false,
      data: {
        user: {
          id: "user_1",
        },
      },
    }),
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    isLoading: false,
    ownersWithSlugs: [{ kind: "human", humanId: "human_1" }],
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ── DOM-level stand-ins for the styling layer ─────────────────────────────
// Rich enough to render the REAL `PageEditorView` in the second describe
// below; the first describe only needs YStack/Text/Spinner out of them.

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
  const dictionary: Record<string, string> = {
    "account.myPage": "My Page",
    "account.overview": "Overview",
  };
  return {
    Text: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => React.createElement("span", pick(rest), children),
    Spinner: () => React.createElement("span", null, "loading"),
    Tooltip: ({ anchor }: { anchor?: ReactNode }) => anchor ?? null,
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
    useTranslations: () => (key: string) => dictionary[key] ?? key,
  };
});

describe("AccountPageEditor", () => {
  it("renders the account page editor for the signed-in human", () => {
    render(<AccountPageEditor />);

    expect(screen.getByTestId("page-editor-view")).toBeTruthy();
    expect(pageEditorViewMock).toHaveBeenCalledTimes(1);
    expect(pageEditorViewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "HUMAN",
        ownerId: "human_1",
      }),
    );

    // The editor has exactly ONE layout now — the WYSIWYG canvas. The legacy
    // `tabbed` / stacked render paths and the `liveEditor` switch that selected
    // between them are gone, so no consumer may resurrect them by prop.
    const props = pageEditorViewMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(props).not.toHaveProperty("tabbed");
    expect(props).not.toHaveProperty("showTabbedHeader");
    expect(props).not.toHaveProperty("liveEditor");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `showSettings` — the editor without its settings disclosure
//
// A venue settings route will host the Profile and Theme forms itself and
// leave `/page` with only the block canvas. `showSettings={false}` must hide
// BOTH the disclosure and the toolbar's aggregate Save: the Save exists only
// to commit what those two forms register, so leaving it behind would give
// the route a button that saves nothing.
//
// The editor's heavy children and data layer are stubbed; the gating, and the
// canvas that must SURVIVE it, are exercised for real.
// ─────────────────────────────────────────────────────────────────────────────

// The profile form is a stub, but one that still REGISTERS with the save
// registry — the toolbar's Save is driven entirely by what the forms publish,
// so a stub registering nothing would make the Save assertions vacuous.
vi.mock("../PageFieldsEditor", async () => {
  const React = await import("react");
  const { useRegisterPageSettingsSave } = await import("../page-settings-save");
  return {
    PageFieldsEditor: () => {
      useRegisterPageSettingsSave({
        id: "profile",
        isDirty: true,
        isPending: false,
        blocked: false,
        save: () => {},
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

vi.mock("../useBlockHistory", () => ({
  useBlockHistory: () => ({
    canUndo: false,
    canRedo: false,
    isBusy: false,
    undo: () => undefined,
    redo: () => undefined,
    undoLabel: null,
    redoLabel: null,
  }),
}));

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

vi.mock("@/app/p/[slug]/_components/EntityPageContent", async () => {
  const React = await import("react");
  return {
    EntityPageContent: () =>
      React.createElement("div", { "data-testid": "mock-entity-page-content" }),
  };
});

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({
    gates: { entityPageEditor: false, humanProfilesPublic: true },
  }),
}));

const { PAGE, BLOCKS, ENTITY } = vi.hoisted(() => ({
  PAGE: {
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
  },
  BLOCKS: [
    {
      id: "blk-about",
      pageId: "page-1",
      kind: "about",
      orderIndex: 0,
      data: {},
      visible: true,
      section: "main",
    },
  ],
  ENTITY: {
    type: "ORGANIZATION" as const,
    id: "org-1",
    name: "Acme Co",
    slug: "acme-co",
    trustTier: "UNVERIFIED" as const,
    trustBadgeLabel: null,
  },
}));

vi.mock("@/trpc", () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : chain),
    apply: () => undefined,
  });
  // Cached so a re-render never hands React a fresh data object.
  const result = {
    data: {
      page: PAGE,
      blocks: BLOCKS,
      theme: {
        colorPrimary: null,
        colorBg: null,
        colorText: null,
        fontKey: "montserrat",
        layoutKey: "standard",
      },
      entity: ENTITY,
    },
    isLoading: false,
    isError: false,
    isSuccess: true,
  };
  const mutationResult = { mutate: () => undefined, isPending: false };
  return {
    trpc: {
      useUtils: () => chain,
      entityPages: {
        getMyPage: { useQuery: () => result },
        managePageBlocks: { useMutation: () => mutationResult },
      },
    },
  };
});

import { PageEditorView } from "../PageEditorView";

const disclosure = () =>
  screen.queryByTestId("entity-page-settings-disclosure");
const settingsSave = () => screen.queryByTestId("entity-page-save");

describe("PageEditorView — showSettings", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    window.history.replaceState({}, "", "/admin/acme-co/page");
  });

  it("renders BOTH the disclosure and the toolbar settings-save by default", () => {
    render(<PageEditorView ownerType="ORGANIZATION" ownerId="org-1" />);

    expect(disclosure()).not.toBeNull();
    expect(settingsSave()).not.toBeNull();
    // Sanity that the Save is genuinely WIRED to the disclosure's forms, not
    // just present: it starts disabled (the panel is collapsed, so nothing has
    // registered) and goes live once the panel opens and the stub Profile form
    // mounts and registers as dirty. Without this, "the button disappears"
    // could be an assertion about an inert node.
    expect(settingsSave()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("entity-page-settings-toggle"));
    expect(screen.getByTestId("mock-fields-editor")).toBeTruthy();
    expect(settingsSave()).not.toHaveAttribute("aria-disabled");
  });

  it("renders both when showSettings is explicitly true", () => {
    render(
      <PageEditorView ownerType="ORGANIZATION" ownerId="org-1" showSettings />,
    );

    expect(disclosure()).not.toBeNull();
    expect(settingsSave()).not.toBeNull();
  });

  it("hides the disclosure AND the toolbar settings-save when showSettings is false", () => {
    render(
      <PageEditorView
        ownerType="ORGANIZATION"
        ownerId="org-1"
        showSettings={false}
      />,
    );

    expect(disclosure()).toBeNull();
    // The Save exists only to commit the disclosure's forms. Hiding one
    // without the other leaves a button that saves nothing registered.
    expect(settingsSave()).toBeNull();
  });

  it("keeps the block canvas and the rest of the toolbar when showSettings is false", () => {
    render(
      <PageEditorView
        ownerType="ORGANIZATION"
        ownerId="org-1"
        showSettings={false}
      />,
    );

    // The canvas persists through `managePageBlocks`, NOT through the settings
    // Save — gating the Save must not take the canvas with it.
    expect(screen.getByTestId("entity-page-edit-surface")).toBeTruthy();
    expect(screen.getByTestId("mock-blocks-editor")).toBeTruthy();
    expect(screen.getByTestId("entity-page-view-mode-toggle")).toBeTruthy();
    expect(screen.getByTestId("entity-page-view-live")).toBeTruthy();
  });
});
