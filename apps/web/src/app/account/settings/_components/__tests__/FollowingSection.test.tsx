import type { ReactNode } from "react";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  update: vi.fn(),
  unfollow: vi.fn(),
  invalidate: vi.fn(async () => {}),
  success: vi.fn(),
  pending: false,
}));
vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      follows: {
        listFollowedEntities: { invalidate: mocks.invalidate },
        isFollowing: { invalidate: mocks.invalidate },
        getFollowerCount: { invalidate: mocks.invalidate },
      },
    }),
    follows: {
      listFollowedEntities: { useInfiniteQuery: mocks.query },
      updateFollowPrefs: {
        useMutation: () => ({ mutate: mocks.update, isPending: mocks.pending }),
      },
      unfollowEntity: {
        useMutation: () => ({ mutate: mocks.unfollow, isPending: false }),
      },
    },
  },
}));
vi.mock("tamagui", () => ({
  XStack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  YStack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../settings-primitives", () => ({
  SectionCard: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock("@th/ui", () => ({
  Text: ({ children, role }: { children: ReactNode; role?: string }) => (
    <span role={role}>{children}</span>
  ),
  Button: ({
    children,
    onPress,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
    "aria-label"?: string;
  }) => (
    <button onClick={onPress} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  NextLinkAnchor: ({
    children,
    href,
  }: {
    children: ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
  Spinner: () => <span>Loading</span>,
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    "aria-label": label,
  }: {
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (v: boolean) => void;
    "aria-label": string;
  }) => (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
  LabeledTextInput: ({
    label,
    value,
    onChangeText,
    onBlur,
    helperText,
    "aria-label": ariaLabel,
  }: {
    label: string;
    value: string;
    onChangeText: (v: string) => void;
    onBlur: () => void;
    helperText?: string;
    "aria-label"?: string;
  }) => (
    <label>
      {label}
      <input
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChangeText(e.target.value)}
        onBlur={onBlur}
      />
      <span>{helperText}</span>
    </label>
  ),
  useTranslations: () => (key: string, values?: { name: string }) =>
    values ? `${key} ${values.name}` : key,
  useNotify: () => ({ toast: { success: mocks.success } }),
}));
import { FollowingSection } from "../FollowingSection";
const follow = {
  followId: "f1",
  entityPageId: "p1",
  slug: "band",
  displayName: "The Band",
  notifyNewEvents: true,
  notifyNearby: false,
  radiusKm: null,
};
const refetch = vi.fn();
const fetchNextPage = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = false;
  mocks.query.mockReturnValue({
    data: { pages: [{ items: [follow] }] },
    refetch,
    fetchNextPage,
  });
});

describe("FollowingSection", () => {
  it("shows loading and empty states separately", () => {
    mocks.query.mockReturnValue({ isLoading: true });
    const { rerender } = render(<FollowingSection />);
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(
      screen.queryByText("account.sFollowingEmpty"),
    ).not.toBeInTheDocument();
    mocks.query.mockReturnValue({ data: { pages: [{ items: [] }] } });
    rerender(<FollowingSection />);
    expect(screen.getByText("account.sFollowingEmpty")).toBeInTheDocument();
  });
  it("offers retry for query errors", () => {
    mocks.query.mockReturnValue({ isError: true, refetch });
    render(<FollowingSection />);
    fireEvent.click(
      screen.getByRole("button", { name: "account.sFollowingRetry" }),
    );
    expect(refetch).toHaveBeenCalled();
  });
  it("renders pages, links and pagination", () => {
    mocks.query.mockReturnValue({
      data: {
        pages: [
          { items: [follow] },
          {
            items: [
              {
                ...follow,
                followId: "f2",
                entityPageId: "p2",
                displayName: "Venue",
              },
            ],
          },
        ],
      },
      hasNextPage: true,
      fetchNextPage,
    });
    render(<FollowingSection />);
    expect(screen.getByRole("link", { name: "The Band" })).toHaveAttribute(
      "href",
      "/p/band",
    );
    expect(screen.getByRole("link", { name: "Venue" })).toBeInTheDocument();
    for (const name of ["The Band", "Venue"]) {
      expect(
        screen.getByRole("button", { name: `account.sFollowingSave: ${name}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: `account.sFollowingUnfollow: ${name}`,
        }),
      ).toBeInTheDocument();
    }

    fireEvent.click(
      screen.getByRole("button", { name: "account.sFollowingMore" }),
    );
    expect(fetchNextPage).toHaveBeenCalled();
  });
  it("validates radius then saves and refreshes preferences", async () => {
    render(<FollowingSection />);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "account.sFollowingNearbyAria The Band",
      }),
    );
    const radius = screen.getByRole("textbox", {
      name: "account.sFollowingRadius: The Band",
    });
    expect(radius).toHaveValue("100");
    fireEvent.change(radius, { target: { value: "501" } });
    fireEvent.click(
      screen.getByRole("button", { name: "account.sFollowingSave: The Band" }),
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(
      screen.getByText("account.sFollowingRadiusError"),
    ).toBeInTheDocument();
    fireEvent.change(radius, { target: { value: "50" } });
    expect(
      screen.queryByText("account.sFollowingRadiusError"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "account.sFollowingSave: The Band" }),
    );
    expect(mocks.update).toHaveBeenCalledWith(
      {
        entityPageId: "p1",
        notifyNewEvents: true,
        notifyNearby: true,
        radiusKm: 50,
      },
      expect.any(Object),
    );
    await act(async () => {
      await mocks.update.mock.calls[0][1].onSuccess();
    });
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalled();
  });
  it("leaves the stored radius alone when an invalid radius is hidden before saving", () => {
    mocks.query.mockReturnValue({
      data: {
        pages: [{ items: [{ ...follow, notifyNearby: true, radiusKm: 75 }] }],
      },
      refetch,
      fetchNextPage,
    });
    render(<FollowingSection />);
    const radius = screen.getByRole("textbox", {
      name: "account.sFollowingRadius: The Band",
    });
    expect(radius).toHaveValue("75");
    fireEvent.change(radius, { target: { value: "abc" } });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "account.sFollowingEventsAria The Band",
      }),
    );
    expect(
      screen.queryByRole("textbox", {
        name: "account.sFollowingRadius: The Band",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "account.sFollowingSave: The Band" }),
    );
    expect(mocks.update).toHaveBeenCalledOnce();
    const sent = mocks.update.mock.calls[0][0];
    expect(sent).toEqual({
      entityPageId: "p1",
      notifyNewEvents: false,
      notifyNearby: true,
    });
    expect(sent).not.toHaveProperty("radiusKm");
  });
  it("retains the draft and displays a save failure", () => {
    mocks.update.mockImplementation((_input, opts) => opts.onError());
    render(<FollowingSection />);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "account.sFollowingEventsAria The Band",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "account.sFollowingSave: The Band" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "account.sFollowingSaveError",
    );
    expect(
      screen.getByRole("checkbox", {
        name: "account.sFollowingEventsAria The Band",
      }),
    ).not.toBeChecked();
  });
  it("disables controls while saving", () => {
    mocks.pending = true;
    render(<FollowingSection />);
    expect(
      screen.getByRole("button", {
        name: "account.sFollowingUnfollow: The Band",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", {
        name: "account.sFollowingEventsAria The Band",
      }),
    ).toBeDisabled();
  });
  it("reports unfollow failure and refreshes all relevant caches on success", async () => {
    render(<FollowingSection />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "account.sFollowingUnfollow: The Band",
      }),
    );
    expect(mocks.unfollow).toHaveBeenCalledWith(
      { entityPageId: "p1" },
      expect.any(Object),
    );
    act(() => {
      mocks.unfollow.mock.calls[0][1].onError();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "account.sFollowingUnfollowError",
    );
    await act(async () => {
      await mocks.unfollow.mock.calls[0][1].onSuccess();
    });
    expect(mocks.invalidate).toHaveBeenCalledTimes(3);
  });
});
