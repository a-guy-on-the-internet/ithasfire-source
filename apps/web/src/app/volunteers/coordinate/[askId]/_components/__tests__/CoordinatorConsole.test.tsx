import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCoordinatorQuery = vi.fn();
const mockPoolQuery = vi.fn();
const mockAssignMutate = vi.fn();
let mockSession: { data: unknown; isPending: boolean } = {
  data: { user: { id: "u1", email: "coord@example.org" } },
  isPending: false,
};

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>;
  return { YStack: passthrough, XStack: passthrough, styled: () => passthrough };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    "data-testid"?: string;
  }) => (
    <button type="button" data-testid={testId} onClick={() => onPress?.()}>
      {children}
    </button>
  ),
  NextLinkAnchor: ({
    children,
    href,
  }: {
    children?: ReactNode;
    href?: string;
  }) => <a href={href}>{children}</a>,
  StyledSelect: ({
    value,
    options,
    onChange,
    placeholder,
    testId,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    placeholder?: string;
    testId?: string;
  }) => (
    <select
      data-testid={testId}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({ dateTime: () => "date" }),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn() },
  }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      volunteer: {
        roster: {
          coordinator: { invalidate: vi.fn() },
        },
        signups: {
          listByAsk: { invalidate: vi.fn() },
        },
      },
    }),
    volunteer: {
      roster: {
        coordinator: { useInfiniteQuery: () => mockCoordinatorQuery() },
      },
      signups: {
        listByAsk: {
          useQuery: (input: unknown) => mockPoolQuery(input),
        },
        assignToGroup: {
          useMutation: () => ({
            mutate: mockAssignMutate,
            isPending: false,
          }),
        },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => mockSession,
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "err",
}));

vi.mock("@/components/volunteering/VolunteerGroupCard", () => ({
  VolunteerGroupCard: ({
    group,
    signups,
  }: {
    group: { id: string; name: string };
    signups?: { id: string }[];
  }) => (
    <div data-testid={`group-card-${group.id}`}>
      {group.name} ({signups?.length ?? 0})
    </div>
  ),
}));

vi.mock("@/components/volunteering/BroadcastComposer", () => ({
  BroadcastComposer: ({
    open,
    scopes,
  }: {
    open: boolean;
    scopes: { id: string; label: string }[];
  }) =>
    open ? (
      <div data-testid="broadcast-composer">
        {scopes.map((s) => s.label).join("|")}
      </div>
    ) : null,
}));

import { CoordinatorConsole } from "../CoordinatorConsole";

const barCrew = {
  id: "g1",
  askId: "ask-1",
  name: "Bar crew",
  description: null,
  capacity: 6,
  coordinatorHumanId: "u1",
  memberCount: 2,
  coordinator: { humanId: "u1", name: "Coord" },
  signups: [
    {
      id: "s1",
      contactName: "A",
      contactEmail: "a@example.org",
      status: "APPROVED",
      groupId: "g1",
      roleId: "r1",
      createdAt: new Date().toISOString(),
    },
  ],
};

const ownGroups = { groups: [barCrew] };

const poolSignup = {
  id: "s9",
  contactName: null,
  contactEmail: "pool@example.org",
  status: "APPROVED",
  groupId: null,
  roleId: "r1",
  createdAt: new Date().toISOString(),
};

function emptyPage() {
  return {
    items: [],
    pageInfo: {
      total: 0,
      count: 0,
      limit: 200,
      offset: 0,
      hasNextPage: false,
      nextOffset: null,
    },
  };
}

function poolPage(items: unknown[]) {
  return {
    items,
    pageInfo: {
      total: items.length,
      count: items.length,
      limit: 200,
      offset: 0,
      hasNextPage: false,
      nextOffset: null,
    },
  };
}

function ok(data: unknown) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

/**
 * The roster read is an infinite query now: `data.pages` is the array of
 * cursor pages, each `{ groups, nextCursor }`.
 */
function infiniteOk(
  pages: { groups: unknown[]; nextCursor?: string | null }[],
  extra: Record<string, unknown> = {},
) {
  return {
    data: {
      pages: pages.map((p) => ({ nextCursor: null, ...p })),
      pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    hasNextPage: pages[pages.length - 1]?.nextCursor != null,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    ...extra,
  };
}

function forbidden() {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    error: { data: { code: "FORBIDDEN" } },
    refetch: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
}

describe("CoordinatorConsole", () => {
  beforeEach(() => {
    mockCoordinatorQuery.mockReset();
    mockPoolQuery.mockReset();
    mockAssignMutate.mockReset();
    mockSession = {
      data: { user: { id: "u1", email: "coord@example.org" } },
      isPending: false,
    };
  });

  it("renders only the coordinator's own groups", () => {
    mockCoordinatorQuery.mockReturnValue(infiniteOk([ownGroups]));
    mockPoolQuery.mockReturnValue(ok(emptyPage()));

    render(<CoordinatorConsole askId="ask-1" />);

    expect(screen.getByTestId("coordinator-console")).toBeInTheDocument();
    expect(screen.getByTestId("group-card-g1")).toHaveTextContent(
      "Bar crew (1)",
    );
  });

  it("renders the pool panel from the coordinator-scoped POOL read", () => {
    mockCoordinatorQuery.mockReturnValue(infiniteOk([ownGroups]));
    mockPoolQuery.mockReturnValue(ok(poolPage([poolSignup])));

    render(<CoordinatorConsole askId="ask-1" />);

    expect(screen.getByTestId("coordinator-pool")).toBeInTheDocument();
    expect(screen.getByTestId("coordinator-pool-row-s9")).toHaveTextContent(
      "pool@example.org",
    );
    expect(mockPoolQuery).toHaveBeenCalledWith({
      askId: "ask-1",
      scope: { kind: "POOL" },
    });
  });

  it("pulls a pool signup into the single coordinated group", () => {
    mockCoordinatorQuery.mockReturnValue(infiniteOk([ownGroups]));
    mockPoolQuery.mockReturnValue(ok(poolPage([poolSignup])));

    render(<CoordinatorConsole askId="ask-1" />);

    fireEvent.click(screen.getByTestId("coordinator-pool-pull-s9"));
    expect(mockAssignMutate).toHaveBeenCalledWith({
      signupId: "s9",
      groupId: "g1",
    });
  });

  it("pulls into a chosen group when coordinating several", () => {
    mockCoordinatorQuery.mockReturnValue(
      infiniteOk([
        {
          groups: [
            barCrew,
            { ...barCrew, id: "g2", name: "Door crew", signups: [] },
          ],
        },
      ]),
    );
    mockPoolQuery.mockReturnValue(ok(poolPage([poolSignup])));

    render(<CoordinatorConsole askId="ask-1" />);

    fireEvent.change(screen.getByTestId("coordinator-pool-pull-s9"), {
      target: { value: "g2" },
    });
    expect(mockAssignMutate).toHaveBeenCalledWith({
      signupId: "s9",
      groupId: "g2",
    });
  });

  it("merges a group split across cursor pages (signups concatenated, deduped)", () => {
    const page2Member = {
      id: "s2",
      contactName: "B",
      contactEmail: "b@example.org",
      status: "APPROVED",
      groupId: "g1",
      roleId: "r1",
      createdAt: new Date().toISOString(),
    };
    mockCoordinatorQuery.mockReturnValue(
      infiniteOk([
        { groups: [barCrew], nextCursor: "g1|cursor" },
        // Page 2 re-carries g1 with the continuation, including a duplicate
        // of s1 (boundary shift) that must be dropped.
        {
          groups: [
            { ...barCrew, signups: [barCrew.signups[0], page2Member] },
          ],
        },
      ]),
    );
    mockPoolQuery.mockReturnValue(ok(emptyPage()));

    render(<CoordinatorConsole askId="ask-1" />);

    // One card, s1 + s2 merged (duplicate s1 not double-counted).
    expect(screen.getByTestId("group-card-g1")).toHaveTextContent(
      "Bar crew (2)",
    );
  });

  it("shows Load more while a next page exists and fetches it on press", () => {
    const query = infiniteOk([{ groups: [barCrew], nextCursor: "g1|cursor" }]);
    mockCoordinatorQuery.mockReturnValue(query);
    mockPoolQuery.mockReturnValue(ok(emptyPage()));

    render(<CoordinatorConsole askId="ask-1" />);

    const button = screen.getByTestId("coordinator-roster-load-more");
    expect(button).toHaveTextContent("volunteering.loadMoreCta");
    fireEvent.click(button);
    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("hides Load more when the roster is exhausted", () => {
    mockCoordinatorQuery.mockReturnValue(infiniteOk([ownGroups]));
    mockPoolQuery.mockReturnValue(ok(emptyPage()));

    render(<CoordinatorConsole askId="ask-1" />);
    expect(
      screen.queryByTestId("coordinator-roster-load-more"),
    ).not.toBeInTheDocument();
  });

  it("hides the pool panel when the POOL read is forbidden", () => {
    mockCoordinatorQuery.mockReturnValue(infiniteOk([ownGroups]));
    mockPoolQuery.mockReturnValue(forbidden());

    render(<CoordinatorConsole askId="ask-1" />);
    expect(screen.queryByTestId("coordinator-pool")).not.toBeInTheDocument();
  });

  it("renders the forbidden state for a non-coordinator", () => {
    mockCoordinatorQuery.mockReturnValue(forbidden());
    mockPoolQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<CoordinatorConsole askId="ask-1" />);
    expect(screen.getByTestId("coordinator-forbidden")).toBeInTheDocument();
  });

  it("prompts sign-in when logged out", () => {
    mockSession = { data: null, isPending: false };
    mockCoordinatorQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    mockPoolQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<CoordinatorConsole askId="ask-1" />);
    expect(
      screen.getByText("volunteering.coordinateSignInTitle"),
    ).toBeInTheDocument();
  });
});
