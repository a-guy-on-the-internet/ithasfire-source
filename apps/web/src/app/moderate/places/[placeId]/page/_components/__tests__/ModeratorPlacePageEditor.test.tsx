import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The moderator editor route's gate (moderator-place-page D8, FR-008): the
 * probe decides between the editor, an owner redirect, and one refusal state
 * per reason; a claim landing mid-edit leaves a standing notice.
 */

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <div data-testid={rest["data-testid"] as string | undefined}>
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => ({
  Alert: ({
    title,
    description,
    testID,
  }: {
    title?: string;
    description?: string;
    testID?: string;
  }) => (
    <div role="alert" data-testid={testID}>
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  ),
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  NextLinkAnchor: ({
    href,
    children,
    "aria-label": ariaLabel,
  }: {
    href: string;
    children?: ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={href} aria-label={ariaLabel}>
      {children}
    </a>
  ),
  Spinner: () => <span>spinner</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/moderate/places/p1/page",
}));

const replace = vi.fn();
vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ replace }) }));

const editorLink = vi.hoisted(() => ({ href: null as string | null }));
vi.mock("@/app/p/[slug]/_components/useVenueEditorLink", () => ({
  useVenueEditorLink: () => ({ href: editorLink.href }),
}));

const editorProps = vi.hoisted(() => ({
  last: null as null | Record<string, unknown>,
}));
vi.mock("@/components/entity-pages", () => ({
  PageEditorView: (props: Record<string, unknown>) => {
    editorProps.last = props;
    return <div data-testid="page-editor" />;
  },
}));

const facts = vi.hoisted(() => ({
  editable: "editable" as "loading" | "editable" | "locked",
}));
vi.mock("../ModeratorPlaceFactsControl", () => ({
  usePlaceFactsEditable: () => facts.editable,
  ModeratorPlaceFactsControl: ({ placeId }: { placeId: string }) => (
    <button type="button" data-testid="facts-control" data-place={placeId} />
  ),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "translated error",
}));

const probe = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
}));
// Getting there (arrival-areas FR-016): the editor is a props recorder behind
// the `arrivalAreas` gate. The pin comes from the editor's own list, so this
// page reads no place for it.
const arrivalAreas = vi.hoisted(() => ({ gate: false }));
vi.mock("@/components/maps/ArrivalAreasEditor", () => ({
  useArrivalAreasEditorEnabled: () => arrivalAreas.gate,
  ArrivalAreasEditor: (props: Record<string, unknown>) => (
    <div data-testid="arrival-areas-editor" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("@/trpc", () => ({
  trpc: {
    entityPages: {
      placePageEditAccess: { useQuery: () => probe.result },
    },
  },
}));

import {
  ModeratorPlacePageEditor,
  toLostAccess,
} from "../ModeratorPlacePageEditor";

function answer(
  canEditPage: boolean,
  editorKind: "owner" | "community_moderator" | null,
  reason: string | null,
) {
  probe.result = {
    isLoading: false,
    isError: false,
    data: { placeId: "p1", canEditPage, editorKind, reason },
    refetch: vi.fn(),
  };
}

let queryClient: QueryClient;
function renderEditor() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ModeratorPlacePageEditor placeId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient();
  editorProps.last = null;
  editorLink.href = null;
  facts.editable = "editable";
  arrivalAreas.gate = false;
  replace.mockClear();
});

describe("ModeratorPlacePageEditor — the gate", () => {
  it("opens the shared editor for a community moderator, settings on", () => {
    answer(true, "community_moderator", null);
    renderEditor();
    expect(screen.getByTestId("page-editor")).toBeInTheDocument();
    expect(editorProps.last).toMatchObject({
      ownerType: "PLACE",
      ownerId: "p1",
      title: "communityPlacePage.editorTitle",
    });
    // Default `showSettings` (true): bio, images, theme are page content.
    expect(editorProps.last?.showSettings).toBeUndefined();
    // Place facts: the header carries "Edit place details" for this place.
    const actions = render(<>{editorProps.last?.headerActions as ReactNode}</>);
    expect(
      actions.getByTestId("facts-control").getAttribute("data-place"),
    ).toBe("p1");
    expect(editorProps.last?.placeNameHint).toBe(
      "communityPlacePage.nameHintFacts",
    );
  });

  it("adds Getting there under the page editor when the arrivalAreas gate is on", () => {
    arrivalAreas.gate = true;
    answer(true, "community_moderator", null);
    renderEditor();
    const editor = screen.getByTestId("arrival-areas-editor");
    expect(JSON.parse(editor.getAttribute("data-props") ?? "{}")).toEqual({
      parent: { placeId: "p1" },
      formHeadingLevel: 3,
    });
  });

  it("has no Getting there with the gate off", () => {
    answer(true, "community_moderator", null);
    renderEditor();
    expect(screen.queryByTestId("arrival-areas-editor")).toBeNull();
  });

  it("shows no name sentence while the editability check is loading", () => {
    facts.editable = "loading";
    answer(true, "community_moderator", null);
    renderEditor();
    expect(editorProps.last?.placeNameHint).toBe("");
  });

  it("says the name can't change here while the facts edit is not offered", () => {
    facts.editable = "locked";
    answer(true, "community_moderator", null);
    renderEditor();
    expect(editorProps.last?.placeNameHint).toBe(
      "communityPlacePage.nameHintLocked",
    );
  });

  it("sends an owner to their admin editor", () => {
    answer(true, "owner", null);
    editorLink.href = "/admin/acme/places/p1/page";
    renderEditor();
    expect(replace).toHaveBeenCalledWith("/admin/acme/places/p1/page");
    expect(screen.queryByTestId("page-editor")).toBeNull();
  });

  it.each([
    ["OWNED", "communityPlacePage.refusedOwnedTitle"],
    ["CLAIM_PENDING", "communityCreate.pfRefusedClaimTitle"],
    ["ARCHIVED", "communityPlacePage.refusedArchivedTitle"],
    ["NOT_ACTIVE", "communityCreate.pfRefusedNotActiveTitle"],
    ["NOT_ALLOWED", "communityPlacePage.refusedNotAllowedTitle"],
  ])("refuses %s with its own state and no editor", (reason, title) => {
    answer(false, null, reason);
    renderEditor();
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByTestId("page-editor")).toBeNull();
  });

  it("SECOND_FACTOR_REQUIRED links to the 2FA setup with a way back", () => {
    answer(false, null, "SECOND_FACTOR_REQUIRED");
    renderEditor();
    const link = screen.getByRole("link", {
      name: "communityPlacePage.secondFactorLink",
    });
    expect(link.getAttribute("href")).toMatch(/^\/enroll-2fa\?/);
    expect(link.getAttribute("href")).toContain(
      encodeURIComponent("/moderate/places/p1/page"),
    );
  });

  it("a failed probe says so and offers a retry", () => {
    probe.result = {
      isLoading: false,
      isError: true,
      error: new Error("x"),
      data: undefined,
      refetch: vi.fn(),
    };
    renderEditor();
    expect(
      screen.getByText("communityPlacePage.checkFailed"),
    ).toBeInTheDocument();
    expect(screen.getByText("translated error")).toBeInTheDocument();
    screen.getByRole("button", { name: "communityPlacePage.tryAgain" }).click();
    expect(probe.result.refetch).toHaveBeenCalled();
  });
});

describe("ModeratorPlacePageEditor — background refetch", () => {
  it("a failed refetch with a previous answer keeps the editor mounted", () => {
    answer(true, "community_moderator", null);
    probe.result = { ...probe.result, isError: true, error: new Error("x") };
    renderEditor();
    expect(screen.getByTestId("page-editor")).toBeInTheDocument();
    expect(screen.queryByText("communityPlacePage.checkFailed")).toBeNull();
  });
});

describe("ModeratorPlacePageEditor — a claim lands mid-edit", () => {
  it("a PLACE_HAS_OWNER save leaves a standing notice above the editor", async () => {
    answer(true, "community_moderator", null);
    renderEditor();
    expect(screen.queryByTestId("moderator-place-page-lost-access")).toBeNull();

    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: [["entityPages", "updatePage"], { type: "mutation" }],
      mutationFn: () =>
        Promise.reject(
          Object.assign(new Error("PLACE_HAS_OWNER"), {
            data: { appCode: "PLACE_HAS_OWNER", meta: { reason: "OWNED" } },
          }),
        ),
      retry: false,
    });
    await act(async () => {
      await mutation.execute(undefined).catch(() => undefined);
    });

    const notice = screen.getByTestId("moderator-place-page-lost-access");
    expect(notice).toHaveTextContent("communityPlacePage.lostOwnedTitle");
    expect(notice).toHaveTextContent("communityPlacePage.lostOwnedBody");
    expect(screen.getByTestId("page-editor")).toBeInTheDocument();
  });

  it("ignores failures from other routers", async () => {
    answer(true, "community_moderator", null);
    renderEditor();
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: [["places", "updatePlace"], { type: "mutation" }],
      mutationFn: () =>
        Promise.reject(
          Object.assign(new Error("PLACE_HAS_OWNER"), {
            data: { appCode: "PLACE_HAS_OWNER" },
          }),
        ),
      retry: false,
    });
    await act(async () => {
      await mutation.execute(undefined).catch(() => undefined);
    });
    expect(screen.queryByTestId("moderator-place-page-lost-access")).toBeNull();
  });
});

describe("toLostAccess", () => {
  it("maps the refusals a page write can meet after the editor opened", () => {
    expect(
      toLostAccess({
        data: { appCode: "PLACE_HAS_OWNER", meta: { reason: "CLAIM_PENDING" } },
      }),
    ).toBe("CLAIM_PENDING");
    expect(toLostAccess({ data: { appCode: "PLACE_HAS_OWNER" } })).toBe(
      "OWNED",
    );
    expect(toLostAccess({ data: { appCode: "PLACE_ARCHIVED" } })).toBe(
      "ARCHIVED",
    );
    expect(toLostAccess({ data: { appCode: "VALIDATION_FAILED" } })).toBeNull();
  });
});
