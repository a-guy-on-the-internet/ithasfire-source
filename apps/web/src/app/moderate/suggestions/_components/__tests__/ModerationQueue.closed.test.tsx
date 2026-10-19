import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A suggestion on a taken-down or ended listing can only be rejected: it is
 * labelled in the list, Approve is gone from the panel, and a CONFLICT on
 * approve (status changed after the list loaded) explains itself.
 */

const { toastMock, items, capturedMutationOptions, invalidateMock, pending } = vi.hoisted(
  () => ({
    toastMock: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      danger: vi.fn(),
      neutral: vi.fn(),
    },
    items: [] as Array<Record<string, any>>,
    pending: { value: false },
    capturedMutationOptions: [] as Array<Record<string, any>>,
    invalidateMock: vi.fn(),
  }),
);

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough };
});

vi.mock("@th/ui", async () => {
  const { forwardRef } = await vi.importActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Button: forwardRef<
      HTMLButtonElement,
      { children?: ReactNode; onPress?: () => void }
    >(({ children, onPress }, ref) => (
      <button ref={ref} onClick={onPress}>
        {children}
      </button>
    )),
    CharCountTextarea: passthrough,
    NextLinkAnchor: passthrough,
    Spinner: () => <div />,
    Text: passthrough,
    useFormatters: () => ({ dateTime: (d: Date) => d.toISOString() }),
    useNotify: () => ({ toast: toastMock }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("lucide-react", () => {
  const icon = () => null;
  return { Check: icon, ClipboardList: icon, ExternalLink: icon, X: icon };
});

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "formatted",
}));
vi.mock("@/components/community/SuggestionDiffCard", () => ({
  SuggestionDiffCard: () => null,
}));
vi.mock("@/components/community/use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => () => false,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      eventSuggestions: { listForModeration: { invalidate: invalidateMock } },
    }),
    eventSuggestions: {
      review: {
        useMutation: (opts: Record<string, any>) => {
          capturedMutationOptions.push(opts);
          return { mutate: vi.fn(), isPending: pending.value };
        },
      },
      listForModeration: {
        useInfiniteQuery: () => ({
          isLoading: false,
          isError: false,
          data: { pages: [{ items, nextCursor: null }] },
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

import { ModerationQueue } from "../ModerationQueue";

const item = (status: string) => ({
  suggestion: {
    id: "s1",
    fields: {},
    baseVersion: {},
    note: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    submitterHumanId: null,
  },
  event: { title: "Open Mic", slug: "open-mic", status },
  submitterName: "Sam",
});

const open = () => fireEvent.click(screen.getAllByRole("button")[0]!);

beforeEach(() => {
  items.length = 0;
  capturedMutationOptions.length = 0;
  pending.value = false;
  vi.clearAllMocks();
});

describe("ModerationQueue on closed listings", () => {
  it.each([
    ["CANCELLED", "moderation.listingTakenDownBadge"],
    ["ARCHIVED", "moderation.listingTakenDownBadge"],
    ["COMPLETED", "moderation.listingEndedBadge"],
  ])("%s: labelled, Reject only, with the hint", (status, label) => {
    const hint =
      label === "moderation.listingEndedBadge"
        ? "moderation.suggestionHintEnded"
        : "moderation.suggestionHintTakenDown";
    items.push(item(status));
    render(<ModerationQueue />);
    expect(screen.getByText(label.toUpperCase())).toBeTruthy();
    open();
    expect(screen.queryByText("moderation.approve")).toBeNull();
    expect(screen.getByText("moderation.reject")).toBeTruthy();
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it("PUBLISHED: no label, Approve and Reject both offered", () => {
    items.push(item("PUBLISHED"));
    render(<ModerationQueue />);
    expect(screen.queryByText(/LISTINGTAKENDOWNBADGE|LISTINGENDEDBADGE/)).toBeNull();
    open();
    expect(screen.getByText("moderation.approve")).toBeTruthy();
    expect(screen.getByText("moderation.reject")).toBeTruthy();
    expect(screen.queryByText(/moderation\.suggestionHint/)).toBeNull();
  });

  it.each([
    ["EVENT_ALREADY_CANCELLED", "moderation.suggestionToastTakenDown"],
    ["EVENT_ARCHIVED", "moderation.suggestionToastTakenDown"],
    ["EVENT_ALREADY_COMPLETED", "moderation.suggestionToastEnded"],
  ])(
    "approve refused with %s: toast names why and the list refreshes",
    (appCode, copy) => {
      items.push(item("PUBLISHED"));
      render(<ModerationQueue />);
      act(() => {
        capturedMutationOptions[0]!.onError({
          message: appCode,
          data: { code: "CONFLICT", appCode, meta: { appCode } },
        });
      });
      expect(toastMock.warning).toHaveBeenCalledWith(
        expect.objectContaining({
          message: copy,
        }),
      );
      expect(toastMock.danger).not.toHaveBeenCalled();
      expect(invalidateMock).toHaveBeenCalled();
    },
  );

  it("approve refused on a closed listing: focus moves to Reject", () => {
    items.push(item("PUBLISHED"));
    const { rerender } = render(<ModerationQueue />);
    open();
    const approve = screen.getByText("moderation.approve");
    approve.focus();
    // The write is in flight until onError fires; the mutation settles after.
    pending.value = true;
    rerender(<ModerationQueue />);
    act(() => {
      capturedMutationOptions.at(-1)!.onError({
        message: "EVENT_ARCHIVED",
        data: { code: "CONFLICT", appCode: "EVENT_ARCHIVED" },
      });
    });
    expect(document.activeElement).not.toBe(screen.getByText("moderation.reject"));
    pending.value = false;
    rerender(<ModerationQueue />);
    expect(document.activeElement).toBe(screen.getByText("moderation.reject"));
  });
});
