import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The new owner's keep-or-clear notice (moderator-place-page D6, FR-008):
 * shows only while a handover is pending, names writers ("A moderator" when
 * the name is missing), confirms Clear, refetches after either choice, and
 * says what to do about `handover_draft_pending`.
 */

const pick = (rest: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k.startsWith("data-") || k.startsWith("aria-") || k === "role") {
      out[k] = v;
    }
  }
  return out;
};

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pick(rest)}>{children}</div>
  );
  return { XStack: Stack, YStack: Stack };
});

const MESSAGES: Record<string, string> = {
  "communityPlacePage.handoverTitle": "Moderators wrote parts of this page",
  "communityPlacePage.handoverBody": "Keep their work or clear it.",
  "communityPlacePage.handoverWriter": "{name} · {count} · last {date}",
  "communityPlacePage.handoverWriterUnknown": "A moderator",
  "communityPlacePage.handoverMoreWriters": "and {count} more",
  "communityPlacePage.handoverKeep": "Keep it",
  "communityPlacePage.handoverClear": "Clear it",
  "communityPlacePage.handoverConfirmTitle": "Clear what moderators wrote?",
  "communityPlacePage.handoverConfirmBody": "This empties the bio.",
  "communityPlacePage.handoverCancel": "Cancel",
  "communityPlacePage.handoverWorking": "Saving…",
  "communityPlacePage.handoverKeptToast": "Kept.",
  "communityPlacePage.handoverClearedToast": "Cleared.",
  "communityPlacePage.handoverDraftPending":
    "This page has unpublished changes, so it can’t be cleared yet.",
  "communityPlacePage.handoverContactSupport": "Contact support",
};

const toastSuccess = vi.fn();

vi.mock("@th/ui", () => ({
  Alert: ({
    title,
    description,
    children,
    testID,
  }: {
    title?: string;
    description?: string;
    children?: ReactNode;
    testID?: string;
  }) => (
    <section data-testid={testID}>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </section>
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
  } & Record<string, unknown>) => (
    <button type="button" onClick={onPress} disabled={disabled} {...pick(rest)}>
      {children}
    </button>
  ),
  Text: ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <span {...pick(rest)}>{children}</span>
  ),
  DateTime: { format: (value: string) => `DATE(${value})` },
  NextLinkAnchor: ({
    href,
    children,
  }: {
    href: string;
    children?: ReactNode;
  }) => <a href={href}>{children}</a>,
  useLocale: () => "en-US",
  useNotify: () => ({ toast: { success: toastSuccess } }),
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      let out = MESSAGES[key] ?? key;
      for (const [k, v] of Object.entries(values ?? {})) {
        out = out.replace(`{${k}}`, String(v));
      }
      return out;
    },
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{description}</p>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (_err: unknown, t?: unknown) =>
    t ? "translated error" : "Something went wrong",
}));

type Pending = {
  writers: {
    humanId: string;
    name: string | null;
    updateCount: number;
    firstUpdatedAt: string;
    lastUpdatedAt: string;
  }[];
} | null;

const state = vi.hoisted(() => ({
  pending: null as unknown,
  mutate: null as null | ((input: unknown) => void),
  onSuccess: null as null | ((r: unknown) => Promise<void> | void),
  onError: null as null | ((e: unknown) => void),
  invalidated: [] as string[],
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      entityPages: {
        communityHandover: {
          invalidate: () => {
            state.invalidated.push("communityHandover");
            return Promise.resolve();
          },
        },
        getMyPage: {
          invalidate: (input: unknown) => {
            state.invalidated.push(`getMyPage:${JSON.stringify(input)}`);
            return Promise.resolve();
          },
        },
      },
    }),
    entityPages: {
      communityHandover: {
        useQuery: () => ({ data: { pending: state.pending } }),
      },
      resolveCommunityHandover: {
        useMutation: (opts: {
          onSuccess: (r: unknown) => Promise<void> | void;
          onError: (e: unknown) => void;
        }) => {
          state.onSuccess = opts.onSuccess;
          state.onError = opts.onError;
          return {
            isPending: false,
            mutate: (input: unknown) => state.mutate?.(input),
          };
        },
      },
    },
  },
}));

import { CommunityHandoverNotice } from "../CommunityHandoverNotice";

const writer = (name: string | null, updateCount = 2) => ({
  humanId: `human-${name ?? "gone"}`,
  name,
  updateCount,
  firstUpdatedAt: "2026-10-01T10:00:00.000Z",
  lastUpdatedAt: "2026-10-12T10:00:00.000Z",
});

function setPending(pending: Pending) {
  state.pending = pending;
}

beforeEach(() => {
  state.pending = null;
  state.mutate = null;
  state.invalidated = [];
  toastSuccess.mockClear();
});

describe("CommunityHandoverNotice", () => {
  it("renders nothing when no handover is pending", () => {
    const { container } = render(<CommunityHandoverNotice placeId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists writers, says 'A moderator' for a missing name, and caps the list", () => {
    setPending({
      writers: [
        writer("Ada", 3),
        writer(null, 1),
        writer("Bo"),
        writer("Cy"),
        writer("Di"),
      ],
    });
    render(<CommunityHandoverNotice placeId="p1" />);

    expect(
      screen.getByText("Moderators wrote parts of this page"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ada · 3 · last DATE(2026-10-12T10:00:00.000Z)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("A moderator · 1 · last DATE(2026-10-12T10:00:00.000Z)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Cy ·/)).toBeNull();
    expect(screen.getByText("and 2 more")).toBeInTheDocument();
    // The account id keys the list; it is never shown.
    expect(screen.queryByText(/human-/)).toBeNull();
  });

  it("Keep it resolves 'keep', refetches the handover and the page, then calls onResolved", async () => {
    setPending({ writers: [writer("Ada")] });
    const onResolved = vi.fn();
    state.mutate = (input) => {
      expect(input).toEqual({ placeId: "p1", choice: "keep" });
      void state.onSuccess?.({ outcome: "kept" });
    };
    render(<CommunityHandoverNotice placeId="p1" onResolved={onResolved} />);

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(state.invalidated).toEqual([
      "communityHandover",
      'getMyPage:{"ownerType":"PLACE","ownerId":"p1"}',
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("Kept.");
  });

  it("Clear it asks first, and only the confirm sends 'clear'", async () => {
    setPending({ writers: [writer("Ada")] });
    const sent: unknown[] = [];
    state.mutate = (input) => {
      sent.push(input);
      void state.onSuccess?.({ outcome: "cleared" });
    };
    render(<CommunityHandoverNotice placeId="p1" />);

    fireEvent.click(screen.getByRole("button", { name: "Clear it" }));
    expect(sent).toEqual([]);
    const dialog = screen.getByRole("dialog", {
      name: "Clear what moderators wrote?",
    });
    expect(dialog).toHaveTextContent("This empties the bio.");

    fireEvent.click(
      screen
        .getAllByRole("button", { name: "Clear it" })
        .find((b) => dialog.contains(b))!,
    );
    expect(sent).toEqual([{ placeId: "p1", choice: "clear" }]);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Cleared."));
  });

  it("handover_draft_pending says to publish or discard the draft", () => {
    setPending({ writers: [writer("Ada")] });
    state.mutate = () => {
      state.onError?.({
        data: {
          code: "BAD_REQUEST",
          appCode: "INVALID_INPUT",
          meta: { reason: "handover_draft_pending" },
        },
      });
    };
    render(<CommunityHandoverNotice placeId="p1" />);

    fireEvent.click(screen.getByRole("button", { name: "Clear it" }));
    fireEvent.click(
      screen
        .getAllByRole("button", { name: "Clear it" })
        .find((b) => screen.getByRole("dialog").contains(b))!,
    );

    expect(screen.getByTestId("community-handover-error")).toHaveTextContent(
      "This page has unpublished changes, so it can’t be cleared yet.",
    );
    expect(
      screen.getByRole("link", { name: "Contact support" }),
    ).toHaveAttribute("href", "/support");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("any other failure goes through formatErrorMessage WITH the translator", () => {
    setPending({ writers: [writer("Ada")] });
    state.mutate = () => state.onError?.({ data: { appCode: "FORBIDDEN" } });
    render(<CommunityHandoverNotice placeId="p1" />);

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(screen.getByTestId("community-handover-error")).toHaveTextContent(
      "translated error",
    );
  });
});

describe("CommunityHandoverNotice — live regions", () => {
  it("is a standing section, and only the refusal line is a live region", () => {
    setPending({ writers: [writer("Ada")] });
    state.mutate = () => state.onError?.({ data: { appCode: "FORBIDDEN" } });
    render(<CommunityHandoverNotice placeId="p1" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.querySelector("button")).toBeNull();
  });
});
