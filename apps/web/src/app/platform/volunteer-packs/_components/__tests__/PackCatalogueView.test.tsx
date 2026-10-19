import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * FR-014 — the staff pack list.
 *
 * The two things the list exists to answer: what is LIVE, and which packs
 * organizers actually adopt. Both are asserted here because both are trivially
 * lost in a refactor (a status that renders as text only, a fork count quietly
 * dropped from the row).
 */

const PACKS = vi.hoisted(() => [
  {
    id: "11111111-1111-4111-8111-111111111111",
    key: "house-show",
    name: "House show",
    blurb: "Six roles for a living-room gig.",
    status: "LIVE" as const,
    targetCategoryIds: ["cat-music"],
    rankFirst: true,
    sortOrder: 0,
    curatedByHumanId: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    roleCount: 6,
    forkCount: 12,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    key: "club-night",
    name: "Club night",
    blurb: null,
    status: "DRAFT" as const,
    targetCategoryIds: [],
    rankFirst: false,
    sortOrder: 1,
    curatedByHumanId: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    roleCount: 8,
    forkCount: 0,
  },
]);

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-")) {
        safe[key] = value;
      }
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({
    children,
    tone,
    variant,
    ...rest
  }: {
    children?: ReactNode;
    tone?: string;
    variant?: string;
    "data-testid"?: string;
  }) => (
    <span
      data-testid={rest["data-testid"]}
      data-tone={tone}
      data-variant={variant}
    >
      {children}
    </span>
  ),
  Button: ({
    children,
    onPress,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={rest["data-testid"]}
      aria-label={rest["aria-label"]}
    >
      {children}
    </button>
  ),
  Spinner: () => <span />,
  StyledSelect: () => <select />,
  Text: ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={rest["data-testid"]}>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    testId,
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    testId?: string;
  }) => (
    <input
      data-testid={testId}
      value={value ?? ""}
      onChange={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  // Category names are picked by locale (category-display-name).
  useLocale: () => "en",
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.values(params).join(" ")}` : key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteerPacks: {
      admin: {
        list: {
          useQuery: () => ({
            data: { packs: PACKS },
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        upsert: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
      },
    },
    categories: {
      list: {
        useQuery: () => ({
          data: {
            categories: [{ id: "cat-music", name: "Music", slug: "music" }],
          },
        }),
      },
    },
    useUtils: () => ({
      volunteerPacks: { admin: { list: { invalidate: vi.fn() } } },
    }),
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

vi.mock("../volunteer-packs.module.css", () => ({
  default: { catalogueRow: "catalogueRow", metric: "metric" },
}));

import { PackCatalogueView } from "../PackCatalogueView";

describe("PackCatalogueView", () => {
  it("encodes each pack's status in form as well as text", () => {
    render(<PackCatalogueView />);

    const live = screen.getByTestId("volunteer-pack-status-house-show");
    const draft = screen.getByTestId("volunteer-pack-status-club-night");

    expect(live.textContent).toContain("volunteerPackStatusLive");
    expect(draft.textContent).toContain("volunteerPackStatusDraft");

    // Colour alone is not a status. Fill-vs-outline survives a monochrome
    // screenshot and a red/green-blind reader; the tones stay semantic and
    // deliberately off the brand accent.
    expect(live.getAttribute("data-tone")).toBe("success");
    expect(live.getAttribute("data-variant")).toBe("solid");
    expect(draft.getAttribute("data-tone")).toBe("warning");
    expect(draft.getAttribute("data-variant")).toBe("outline");
  });

  it("surfaces the adoption count for every pack, zero included", () => {
    render(<PackCatalogueView />);

    // The number that says whether a pack earns its place in the catalogue.
    expect(
      screen.getByTestId("volunteer-pack-fork-count-house-show").textContent,
    ).toContain("12");
    // A 0 must RENDER, not vanish — "no org has ever taken this pack" is the
    // single most actionable thing the list can say.
    expect(
      screen.getByTestId("volunteer-pack-fork-count-club-night").textContent,
    ).toContain("0");

    expect(
      screen.getByTestId("volunteer-pack-role-count-house-show").textContent,
    ).toContain("6");
  });

  it("resolves target category ids to names", () => {
    render(<PackCatalogueView />);
    const row = screen.getByTestId("volunteer-pack-row-house-show");
    expect(row.textContent).toContain("volunteerPackTargetsValue Music");
    const untargeted = screen.getByTestId("volunteer-pack-row-club-night");
    expect(untargeted.textContent).toContain("volunteerPackTargetsNone");
  });
});
