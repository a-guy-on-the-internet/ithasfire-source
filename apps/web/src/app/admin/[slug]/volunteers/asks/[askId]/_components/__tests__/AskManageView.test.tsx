import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRosterQuery = vi.fn();
const mockBroadcastsQuery = vi.fn();
const mockListByAskQuery = vi.fn();
const mockPlaceTitleQuery = vi.fn();
const mockAskFormProps = vi.fn();

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

vi.mock("@th/ui", () => {
  const Modal = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  Modal.Panel = Modal;
  Modal.Header = Modal;
  Modal.Body = Modal;
  Modal.Footer = Modal;
  return {
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
    Modal,
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
      testId,
    }: {
      value: string;
      options: { value: string; label: string }[];
      onChange: (value: string) => void;
      testId?: string;
    }) => (
      <select
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    TextInput: () => <input />,
    useFormatters: () => ({ dateTime: () => "date" }),
    useNotify: () => ({
      toast: { success: vi.fn(), danger: vi.fn() },
    }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      volunteer: {
        roster: { ask: { invalidate: vi.fn() } },
        broadcasts: { list: { invalidate: vi.fn() } },
        signups: {
          listByAsk: { invalidate: vi.fn(), fetch: vi.fn() },
        },
      },
    }),
    places: {
      getPlaceTitle: {
        useQuery: (input: unknown, opts: unknown) =>
          mockPlaceTitleQuery(input, opts),
      },
    },
    volunteer: {
      roster: { ask: { useInfiniteQuery: () => mockRosterQuery() } },
      broadcasts: { list: { useQuery: () => mockBroadcastsQuery() } },
      asks: {
        update: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
      askRoles: {
        add: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        update: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
      groups: {
        create: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
      signups: {
        listByAsk: {
          useQuery: (input: unknown, opts: unknown) =>
            mockListByAskQuery(input, opts),
        },
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  // Uppercase codes fall back to the generic string without the translator.
  formatErrorMessage: (
    err: { message?: string } | null,
    t?: (key: string) => string,
  ) => (t ? t(`errors.${err?.message}`) : "Something went wrong"),
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="confirm-dialog" /> : null,
}));

vi.mock("@/components/AdminTableParts", () => ({
  AdminTableErrorState: ({
    testId,
    message,
  }: {
    testId?: string;
    message?: string;
  }) => <div data-testid={testId}>{message}</div>,
}));

vi.mock("@/components/volunteering/VolunteerAskForm", () => ({
  VolunteerAskForm: (props: unknown) => {
    mockAskFormProps(props);
    return null;
  },
}));

vi.mock("@/components/volunteering/AskWaiverSection", () => ({
  AskWaiverSection: (props: {
    subjectType: string;
    orgId: string | null;
    humanId: string | null;
  }) => (
    <div
      data-testid="ask-waiver-section"
      data-org-id={props.orgId ?? ""}
      data-human-id={props.humanId ?? ""}
    >
      {props.subjectType}
    </div>
  ),
}));

vi.mock("@/components/volunteering/VolunteerGroupCard", () => ({
  VolunteerGroupCard: ({ group }: { group: { id: string; name: string } }) => (
    <div data-testid={`group-card-${group.id}`}>{group.name}</div>
  ),
}));

vi.mock("@/components/volunteering/SignupReviewRow", () => ({
  SignupReviewRow: ({
    signup,
  }: {
    signup: { id: string; contactEmail: string };
  }) => (
    <div data-testid={`review-row-${signup.id}`}>{signup.contactEmail}</div>
  ),
}));

vi.mock("@/components/volunteering/BroadcastComposer", () => ({
  BroadcastComposer: ({ open }: { open: boolean }) =>
    open ? <div data-testid="broadcast-composer" /> : null,
}));

import { AskManageView } from "../AskManageView";

const baseRole = {
  id: "r1",
  name: "Door",
  description: null,
  capacity: null,
  defaultHours: null,
  acceptedCount: 0,
  pendingCount: 1,
};

const rosterData = {
  ask: {
    id: "ask-1",
    subjectType: "ORG",
    subjectId: "org-1",
    // Widened: HUMAN-subject fixtures spread this with `orgId: null`.
    orgId: "org-1" as string | null,
    title: "Standing crew",
    status: "OPEN",
    cadence: "ONGOING",
    description: null,
    startsAt: null,
    endsAt: null,
    capacity: null,
    autoApprove: false,
    waiverRequired: false,
    waiverTemplateId: null,
    smsOptInEnabled: false,
    // Every ask read returns its zone; null = an ask made before zones.
    timezone: null as string | null,
  },
  roles: [baseRole],
  groups: [],
  generalPool: [] as unknown[],
};

const pendingSignup = {
  id: "s-pending",
  contactName: "Pat",
  contactEmail: "pat@example.org",
  status: "PENDING",
  groupId: null,
  roleId: "r1",
  createdAt: new Date().toISOString(),
};

function page(items: unknown[]) {
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
    isPending: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

/**
 * The roster read is a cursor-paginated infinite query now: `data.pages`
 * is the array of pages, each carrying the metadata + a pool slice.
 */
function infiniteOk(
  pages: (typeof rosterData & { nextCursor?: string | null })[],
  extra: Record<string, unknown> = {},
) {
  return {
    data: {
      pages: pages.map((p) => ({ nextCursor: null, ...p })),
      pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
    },
    isLoading: false,
    isPending: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    hasNextPage: pages[pages.length - 1]?.nextCursor != null,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    ...extra,
  };
}

describe("AskManageView pending queue", () => {
  beforeEach(() => {
    mockRosterQuery.mockReset();
    mockBroadcastsQuery.mockReset();
    mockListByAskQuery.mockReset();
    mockPlaceTitleQuery.mockReset();
    mockAskFormProps.mockReset();
    mockPlaceTitleQuery.mockReturnValue({ data: undefined });
    mockRosterQuery.mockReturnValue(infiniteOk([rosterData]));
    mockBroadcastsQuery.mockReturnValue(ok({ broadcasts: [] }));
  });

  it("queries listByAsk with ALL scope + PENDING and renders the rows", () => {
    mockListByAskQuery.mockReturnValue(ok(page([pendingSignup])));

    render(<AskManageView slug="org" askId="ask-1" />);

    expect(screen.getByTestId("volunteer-pending-queue")).toBeInTheDocument();
    expect(screen.getByTestId("review-row-s-pending")).toHaveTextContent(
      "pat@example.org",
    );
    expect(mockListByAskQuery).toHaveBeenCalledWith(
      { askId: "ask-1", scope: { kind: "ALL" }, status: "PENDING" },
      expect.anything(),
    );
  });

  it("re-queries with a roleId when the role filter changes", () => {
    mockListByAskQuery.mockReturnValue(ok(page([])));
    mockRosterQuery.mockReturnValue(
      infiniteOk([
        {
          ...rosterData,
          roles: [baseRole, { ...baseRole, id: "r2", name: "Bar" }],
        },
      ]),
    );

    render(<AskManageView slug="org" askId="ask-1" />);

    fireEvent.change(screen.getByTestId("volunteer-pending-role-filter"), {
      target: { value: "r2" },
    });

    expect(mockListByAskQuery).toHaveBeenCalledWith(
      {
        askId: "ask-1",
        scope: { kind: "ALL" },
        status: "PENDING",
        roleId: "r2",
      },
      expect.anything(),
    );
  });

  it("shows the translated message, not the generic one, when the pending queue fails", () => {
    mockListByAskQuery.mockReturnValue({
      ...ok(undefined),
      isError: true,
      error: { message: "ASK_NOT_FOUND" },
    });

    render(<AskManageView slug="org" askId="ask-1" />);

    expect(screen.getByText("errors.ASK_NOT_FOUND")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("shows the translated message, not the generic one, when the roster fails", () => {
    mockListByAskQuery.mockReturnValue(ok(page([])));
    mockRosterQuery.mockReturnValue(
      infiniteOk([rosterData], {
        isError: true,
        error: { message: "ASK_NOT_FOUND" },
      }),
    );

    render(<AskManageView slug="org" askId="ask-1" />);

    expect(screen.getByText("errors.ASK_NOT_FOUND")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("shows the empty state when nothing is pending", () => {
    mockListByAskQuery.mockReturnValue(ok(page([])));

    render(<AskManageView slug="org" askId="ask-1" />);

    expect(
      screen.getByText("volunteering.pendingQueueEmpty"),
    ).toBeInTheDocument();
  });

  it("renders the waiver section for a non-EVENT ask (ORG → org owner)", () => {
    mockListByAskQuery.mockReturnValue(ok(page([])));

    render(<AskManageView slug="org" askId="ask-1" />);

    expect(
      screen.getByTestId("volunteer-ask-waiver-section"),
    ).toBeInTheDocument();
    const section = screen.getByTestId("ask-waiver-section");
    expect(section).toHaveTextContent("ORG");
    // ORG subject → templates scoped to the org itself (subjectId).
    expect(section).toHaveAttribute("data-org-id", "org-1");
    expect(section).toHaveAttribute("data-human-id", "");
  });

  // Cross-owner template assignment is a HIGH-risk axis (a wrong owner would
  // list/assign another org's or human's liability document). These pin the
  // client-side owner derivation per subject type; the server independently
  // enforces ownership in assignWaiverToAsk.
  it("scopes the waiver picker to the denormalized owning org for a PLACE ask", () => {
    mockListByAskQuery.mockReturnValue(ok(page([])));
    mockRosterQuery.mockReturnValue(
      infiniteOk([
        {
          ...rosterData,
          ask: {
            ...rosterData.ask,
            subjectType: "PLACE",
            subjectId: "place-1",
            orgId: "org-7",
          },
        },
      ]),
    );

    render(<AskManageView slug="org" askId="ask-1" />);

    const section = screen.getByTestId("ask-waiver-section");
    expect(section).toHaveTextContent("PLACE");
    expect(section).toHaveAttribute("data-org-id", "org-7");
    expect(section).toHaveAttribute("data-human-id", "");
  });

  it("scopes the waiver picker to the subject human for a HUMAN ask", () => {
    mockListByAskQuery.mockReturnValue(ok(page([])));
    mockRosterQuery.mockReturnValue(
      infiniteOk([
        {
          ...rosterData,
          ask: {
            ...rosterData.ask,
            subjectType: "HUMAN",
            subjectId: "human-9",
            orgId: null,
          },
        },
      ]),
    );

    render(<AskManageView slug="org" askId="ask-1" />);

    const section = screen.getByTestId("ask-waiver-section");
    expect(section).toHaveTextContent("HUMAN");
    expect(section).toHaveAttribute("data-human-id", "human-9");
    expect(section).toHaveAttribute("data-org-id", "");
  });
});

describe("AskManageView general pool (cursor pagination)", () => {
  const poolMember = (id: string) => ({
    id,
    contactName: null,
    contactEmail: `${id}@example.org`,
    status: "APPROVED",
    groupId: null,
    roleId: "r1",
    createdAt: new Date().toISOString(),
  });

  beforeEach(() => {
    mockRosterQuery.mockReset();
    mockBroadcastsQuery.mockReset();
    mockListByAskQuery.mockReset();
    mockBroadcastsQuery.mockReturnValue(ok({ broadcasts: [] }));
    mockListByAskQuery.mockReturnValue(ok(page([])));
  });

  it("concatenates the pool across loaded pages, deduped by id", () => {
    mockRosterQuery.mockReturnValue(
      infiniteOk([
        { ...rosterData, generalPool: [poolMember("p1"), poolMember("p2")] },
        // Page 2 re-carries p2 (boundary shift) — must not render twice.
        { ...rosterData, generalPool: [poolMember("p2"), poolMember("p3")] },
      ]),
    );

    render(<AskManageView slug="org" askId="ask-1" />);

    expect(screen.getByTestId("review-row-p1")).toBeInTheDocument();
    expect(screen.getAllByTestId("review-row-p2")).toHaveLength(1);
    expect(screen.getByTestId("review-row-p3")).toBeInTheDocument();
  });

  it("shows Load more while nextCursor exists and fetches the next page on press", () => {
    const query = infiniteOk([
      {
        ...rosterData,
        generalPool: [poolMember("p1")],
        nextCursor: "2026-07-01T00:00:00.000Z|p1",
      },
    ]);
    mockRosterQuery.mockReturnValue(query);

    render(<AskManageView slug="org" askId="ask-1" />);

    const button = screen.getByTestId("volunteer-pool-load-more");
    fireEvent.click(button);
    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("hides Load more when the pool is exhausted", () => {
    mockRosterQuery.mockReturnValue(
      infiniteOk([{ ...rosterData, generalPool: [poolMember("p1")] }]),
    );

    render(<AskManageView slug="org" askId="ask-1" />);

    expect(
      screen.queryByTestId("volunteer-pool-load-more"),
    ).not.toBeInTheDocument();
  });
});

describe("AskManageView — the place's zone for the edit form", () => {
  beforeEach(() => {
    mockRosterQuery.mockReset();
    mockBroadcastsQuery.mockReset();
    mockListByAskQuery.mockReset();
    mockPlaceTitleQuery.mockReset();
    mockAskFormProps.mockReset();
    mockBroadcastsQuery.mockReturnValue(ok({ broadcasts: [] }));
    mockListByAskQuery.mockReturnValue(ok(page([])));
  });

  const lastFormProps = () =>
    mockAskFormProps.mock.calls.at(-1)?.[0] as
      | { defaultTimezone?: string | null; initial: { timezone: unknown } }
      | undefined;

  it("asks for the place's zone on a PLACE ask and hands it to the edit form", () => {
    mockPlaceTitleQuery.mockReturnValue({
      data: { name: "Room", timezone: "Asia/Kolkata" },
    });
    mockRosterQuery.mockReturnValue(
      infiniteOk([
        {
          ...rosterData,
          ask: {
            ...rosterData.ask,
            subjectType: "PLACE",
            subjectId: "place-1",
            timezone: null,
          },
        },
      ]),
    );

    render(<AskManageView slug="org" askId="ask-1" />);
    expect(mockPlaceTitleQuery).toHaveBeenLastCalledWith(
      { placeId: "place-1" },
      expect.objectContaining({ enabled: true }),
    );

    fireEvent.click(screen.getByTestId("volunteer-ask-edit"));
    expect(lastFormProps()?.defaultTimezone).toBe("Asia/Kolkata");
    expect(lastFormProps()?.initial.timezone).toBeNull();
  });

  it("does not ask for a place on an ORG ask", () => {
    mockPlaceTitleQuery.mockReturnValue({ data: undefined });
    mockRosterQuery.mockReturnValue(infiniteOk([rosterData]));

    render(<AskManageView slug="org" askId="ask-1" />);
    expect(mockPlaceTitleQuery).toHaveBeenLastCalledWith(
      { placeId: "" },
      expect.objectContaining({ enabled: false }),
    );

    fireEvent.click(screen.getByTestId("volunteer-ask-edit"));
    expect(lastFormProps()?.defaultTimezone).toBeUndefined();
  });
});
