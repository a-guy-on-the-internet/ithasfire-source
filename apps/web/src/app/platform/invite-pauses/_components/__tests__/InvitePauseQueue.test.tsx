/**
 * /platform/invite-pauses (invite complaint auto-pause, W4): the staff queue.
 * Ordering, what each decision sends, KEEP needing a note, per-row unique
 * accessible names, and the focus moves copied from the reports queue.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PASS_PROP = /^(data-|aria-)|^(id|role|tabIndex|htmlFor)$/;
function domProps(rest: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (PASS_PROP.test(key)) out[key] = value;
  }
  return out;
}

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    tag,
    ref,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    ref?: unknown;
    [key: string]: unknown;
  }) => React.createElement(tag ?? "div", { ...domProps(rest), ref }, children);
  return { XStack: Stack, YStack: Stack, Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({
    children,
    tag,
    ref,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    ref?: unknown;
    [key: string]: unknown;
  }) => React.createElement(tag ?? "span", { ...domProps(rest), ref }, children);
  return {
    Text,
    Badge: Text,
    Spinner: () => <div data-testid="spinner" />,
    // Forwards aria-* so accessible-name assertions can't pass against a
    // mock that swallows them.
    Button: ({
      children,
      onPress,
      disabled,
      variant,
      ref,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      variant?: string;
      ref?: unknown;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        { type: "button", onClick: onPress, disabled, "data-variant": variant, ref, ...domProps(rest) },
        children,
      ),
    CharCountTextarea: ({
      id,
      value,
      onChange,
      maxLength,
      disabled,
      testIdBase,
    }: {
      id?: string;
      value: string;
      onChange: (v: string) => void;
      maxLength?: number;
      disabled?: boolean;
      testIdBase?: string;
    }) => (
      <textarea
        id={id}
        data-testid={testIdBase}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    ),
    NextLinkAnchor: ({ href, target, children }: { href: string; target?: string; children?: ReactNode }) => (
      <a href={href} target={target}>
        {children}
      </a>
    ),
    useFormatters: () => ({
      locale: "en",
      dateTime: (d: Date) => `D:${d.toISOString().slice(0, 10)}`,
      number: (n: number) => String(Math.round(n * 10) / 10),
    }),
    useNotify: () => ({ toast: notify }),
    useTranslations:
      () =>
      (key: string, params?: Record<string, unknown>) =>
        params
          ? `${key} ${Object.values(params).join(" ")}`
          : // errors.* come back "translated" so formatErrorMessage keeps
            // them (it falls back when a key echoes itself, i.e. is missing).
            key.startsWith("errors.")
            ? `T(${key})`
            : key,
  };
});

vi.mock("lucide-react", () => ({
  ExternalLink: () => <span data-icon="external-link" />,
  MailX: () => <span data-icon="mail-x" />,
}));

const notify = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  danger: vi.fn(),
}));

const api = vi.hoisted(() => ({
  staffRoles: ["REVIEWER"] as string[],
  listData: { items: [] as unknown[] },
  /** `dataUpdatedAt` of page 1: bump it to simulate a background refetch. */
  listUpdatedAt: 1,
  listCalls: [] as unknown[],
  decide: vi.fn(),
  invalidate: vi.fn(),
  fetchPage: vi.fn(),
  mutationOpts: null as null | {
    onSuccess?: (data: unknown, vars: { decision: string }) => void;
    onError?: (err: unknown) => void;
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      platform: { invitePauses: { list: { invalidate: api.invalidate, fetch: api.fetchPage } } },
    }),
    platform: {
      checkStaffAccess: {
        useQuery: () => ({ data: { allowed: true, roles: api.staffRoles } }),
      },
      invitePauses: {
        list: {
          useQuery: (input: unknown) => {
            api.listCalls.push(input);
            return {
              isLoading: false,
              isError: false,
              data: api.listData,
              dataUpdatedAt: api.listUpdatedAt,
              refetch: vi.fn(),
            };
          },
        },
        decide: {
          useMutation: (opts: typeof api.mutationOpts) => {
            api.mutationOpts = opts;
            return {
              isPending: false,
              mutateAsync: async (vars: { decision: string }) => {
                const result = await api.decide(vars);
                opts?.onSuccess?.(result, vars);
                return result;
              },
            };
          },
        },
      },
    },
  },
}));

vi.mock("@/components/community/use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => () => false,
}));

import { InvitePauseQueue } from "../InvitePauseQueue";
import { InvitePauseQueueView } from "../InvitePauseQueueView";
import {
  complaintRatePercent,
  invitePauseOwnerHref,
  orderInvitePauses,
  type InvitePauseQueueItem,
} from "../invite-pause-queue.helpers";

function item(overrides: Partial<InvitePauseQueueItem> = {}): InvitePauseQueueItem {
  return {
    id: "pause-1",
    ownerKind: "ORG",
    ownerId: "org-1",
    ownerName: "Basement Shows",
    ownerSlug: null,
    reason: "COMPLAINT_COUNT",
    complaintCount: 3,
    recipientCount: 120,
    pausedAt: "2026-10-01T10:00:00.000Z",
    reviewRequestedAt: null,
    reviewRequestNote: null,
    decision: null,
    decidedAt: null,
    decisionNote: null,
    liftedAt: null,
    ...overrides,
  };
}

const ASKED = item({
  id: "pause-asked",
  ownerName: "Basement Shows",
  ownerSlug: "basement-shows",
  reviewRequestedAt: "2026-10-05T10:00:00.000Z",
  reviewRequestNote: "These are all past buyers.",
});
const QUIET = item({
  id: "pause-quiet",
  ownerKind: "HUMAN",
  ownerId: "human-1",
  ownerName: "Rosa Diaz",
  reason: "COMPLAINT_RATE",
  complaintCount: 2,
  recipientCount: 150,
});

function renderView(
  items: InvitePauseQueueItem[],
  onDecide = vi.fn(() => Promise.resolve()),
  extra: Partial<Parameters<typeof InvitePauseQueueView>[0]> = {},
) {
  render(
    <InvitePauseQueueView
      items={items}
      filter="OPEN"
      onFilterChange={vi.fn()}
      waitingCount={1}
      isLoading={false}
      isError={false}
      canDecide
      isDecisionPending={false}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadMore={vi.fn()}
      onRetry={vi.fn()}
      onDecide={onDecide}
      {...extra}
    />,
  );
  return onDecide;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listData = { items: [] };
  api.listUpdatedAt = 1;
  api.listCalls = [];
  api.staffRoles = ["REVIEWER"];
});

describe("invite pause queue helpers", () => {
  it("puts review requests first (oldest ask first), then oldest pauses", () => {
    const a = item({ id: "a", pausedAt: "2026-09-01T00:00:00Z" });
    const b = item({ id: "b", pausedAt: "2026-09-10T00:00:00Z", reviewRequestedAt: "2026-10-03T00:00:00Z" });
    const c = item({ id: "c", pausedAt: "2026-09-05T00:00:00Z", reviewRequestedAt: "2026-10-01T00:00:00Z" });
    const d = item({ id: "d", pausedAt: "2026-08-01T00:00:00Z" });
    expect(orderInvitePauses([a, b, c, d], "OPEN").map((i) => i.id)).toEqual(["c", "b", "d", "a"]);
    expect(orderInvitePauses([a, b], "LIFTED").map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("links orgs to their public page by slug, people always to the humans search", () => {
    expect(
      invitePauseOwnerHref({ ownerKind: "ORG", ownerName: "Basement Shows", ownerSlug: "basement-shows" }),
    ).toBe("/orgs/basement-shows");
    expect(
      invitePauseOwnerHref({ ownerKind: "HUMAN", ownerName: "Rosa Diaz", ownerSlug: "rosa-diaz" }),
    ).toBe("/platform/humans?q=Rosa%20Diaz");
    // Even with a page slug, a person never links to /humans/<slug> (it 404s
    // while profiles are off, for private pages and for banned owners).
    expect(
      invitePauseOwnerHref({ ownerKind: "HUMAN", ownerName: "Rosa Diaz", ownerSlug: "rosa-diaz" }),
    ).not.toMatch(/^\/humans\//);
    expect(
      invitePauseOwnerHref({ ownerKind: "HUMAN", ownerName: "  ", ownerSlug: "rosa-diaz" }),
    ).toBeNull();
    expect(invitePauseOwnerHref({ ownerKind: "HUMAN", ownerName: "Rosa Diaz", ownerSlug: null })).toBe(
      "/platform/humans?q=Rosa%20Diaz",
    );
    expect(
      invitePauseOwnerHref({ ownerKind: "ORG", ownerName: "Basement Shows", ownerSlug: null }),
    ).toBeNull();
    expect(invitePauseOwnerHref({ ownerKind: "HUMAN", ownerName: null, ownerSlug: null })).toBeNull();
    // A hostile slug never becomes a javascript: link.
    expect(
      invitePauseOwnerHref({ ownerKind: "ORG", ownerName: "X", ownerSlug: "javascript:alert(1)" }),
    ).not.toMatch(/^javascript:/);
  });

  it("computes the complaint rate, null with nobody invited", () => {
    expect(complaintRatePercent(2, 150)).toBeCloseTo(1.333, 2);
    expect(complaintRatePercent(3, 0)).toBeNull();
  });
});

describe("InvitePauseQueueView", () => {
  it("shows badges, facts and the organiser's note, never complainants", () => {
    renderView([ASKED, QUIET]);
    const asked = screen.getByTestId("invite-pause-row-pause-asked");
    expect(within(asked).getByText("invitePauseQueue.badgeReviewAsked")).toBeTruthy();
    expect(within(asked).getByText("invitePauseQueue.reasonCount")).toBeTruthy();
    expect(within(asked).getByText("invitePauseQueue.factComplaintsValue 3")).toBeTruthy();
    expect(within(asked).getByText("invitePauseQueue.factInvitedValuePct 120 2.5")).toBeTruthy();
    const quote = within(asked).getByText("These are all past buyers.");
    expect(quote.closest("blockquote")).not.toBeNull();
    const orgLink = within(asked).getByRole("link");
    expect(orgLink.getAttribute("href")).toBe("/orgs/basement-shows");
    expect(orgLink.getAttribute("target")).toBe("_blank");

    const quiet = screen.getByTestId("invite-pause-row-pause-quiet");
    expect(within(quiet).getByText("invitePauseQueue.badgePaused")).toBeTruthy();
    expect(within(quiet).getByText("invitePauseQueue.reasonRate")).toBeTruthy();
    expect(within(quiet).getByRole("link").getAttribute("href")).toBe(
      "/platform/humans?q=Rosa%20Diaz",
    );
    expect(screen.getByTestId("invite-pause-waiting-count").textContent).toBe(
      "invitePauseQueue.waitingCount 1",
    );
  });

  it("gives every row's buttons a unique accessible name", () => {
    renderView([ASKED, QUIET]);
    const reviewNames = screen
      .getAllByRole("button", { name: /^invitePauseQueue\.reviewAria/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(reviewNames).toEqual([
      "invitePauseQueue.reviewAria Basement Shows (invitePauseQueue.ownerKindOrg)",
      "invitePauseQueue.reviewAria Rosa Diaz (invitePauseQueue.ownerKindHuman)",
    ]);
    expect(new Set(reviewNames).size).toBe(reviewNames.length);

    const rosa = "Rosa Diaz (invitePauseQueue.ownerKindHuman)";
    fireEvent.click(screen.getByRole("button", { name: `invitePauseQueue.reviewAria ${rosa}` }));
    expect(screen.getByRole("button", { name: `invitePauseQueue.liftAria ${rosa}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `invitePauseQueue.keepAria ${rosa}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `invitePauseQueue.closeAria ${rosa}` })).toBeTruthy();
  });

  it("keeps an organisation and a person with the same name apart", () => {
    renderView([
      item({ id: "o", ownerKind: "ORG", ownerName: "Sam Lee" }),
      item({ id: "h", ownerKind: "HUMAN", ownerName: "Sam Lee" }),
    ]);
    const names = screen
      .getAllByRole("button", { name: /^invitePauseQueue\.reviewAria/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
  });

  it("lifts with an optional note and moves focus to the heading", async () => {
    const onDecide = renderView([ASKED]);
    fireEvent.click(screen.getByTestId("invite-pause-review-pause-asked"));
    // Open → focus the note box.
    expect(document.activeElement).toBe(screen.getByTestId("invite-pause-decision-note"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-lift-pause-asked"));
    });
    expect(onDecide).toHaveBeenCalledWith("pause-asked", "LIFTED", undefined);
    expect(document.activeElement?.textContent).toBe("invitePauseQueue.title");
  });

  it("keeps Keep paused disabled until a note is written, then sends it", async () => {
    const onDecide = renderView([ASKED]);
    fireEvent.click(screen.getByTestId("invite-pause-review-pause-asked"));
    const keep = screen.getByTestId("invite-pause-keep-pause-asked") as HTMLButtonElement;
    expect(keep.disabled).toBe(true);

    const note = screen.getByLabelText("invitePauseQueue.noteLabel") as HTMLTextAreaElement;
    expect(note.maxLength).toBe(2000);
    fireEvent.change(note, { target: { value: "   " } });
    expect(keep.disabled).toBe(true);

    fireEvent.change(note, { target: { value: " Most addresses never bought a ticket. " } });
    expect(keep.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(keep);
    });
    expect(onDecide).toHaveBeenCalledWith(
      "pause-asked",
      "KEPT",
      "Most addresses never bought a ticket.",
    );
  });

  it("keeps the panel and the note when a decision fails", async () => {
    const onDecide = vi.fn((): Promise<void> => Promise.reject(new Error("nope")));
    renderView([ASKED], onDecide);
    fireEvent.click(screen.getByTestId("invite-pause-review-pause-asked"));
    fireEvent.change(screen.getByTestId("invite-pause-decision-note"), {
      target: { value: "Keep it." },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-keep-pause-asked"));
    });
    expect((screen.getByTestId("invite-pause-decision-note") as HTMLTextAreaElement).value).toBe(
      "Keep it.",
    );
  });

  it("returns focus to the row's Review button on Close", () => {
    renderView([ASKED]);
    fireEvent.click(screen.getByTestId("invite-pause-review-pause-asked"));
    fireEvent.click(screen.getByTestId("invite-pause-close-pause-asked"));
    expect(document.activeElement).toBe(screen.getByTestId("invite-pause-review-pause-asked"));
  });

  it("offers no decision on a lifted pause", () => {
    renderView(
      [item({ id: "gone", liftedAt: "2026-10-06T00:00:00Z", decision: "LIFTED", decidedAt: "2026-10-06T00:00:00Z" })],
      vi.fn(),
      { filter: "LIFTED" },
    );
    expect(screen.getByText("invitePauseQueue.badgeLifted")).toBeTruthy();
    expect(screen.queryByTestId("invite-pause-review-gone")).toBeNull();
  });

  it("marks the selected filter and switches it", () => {
    const onFilterChange = vi.fn();
    renderView([], vi.fn(), { filter: "AWAITING_REVIEW", onFilterChange });
    expect(screen.getByTestId("invite-pause-filter-AWAITING_REVIEW").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("invite-pause-filter-LIFTED"));
    expect(onFilterChange).toHaveBeenCalledWith("LIFTED");
    expect(screen.getByTestId("invite-pause-empty")).toBeTruthy();
  });
});

describe("InvitePauseQueue (container)", () => {
  const serverItem = {
    ...ASKED,
    pausedAt: new Date(ASKED.pausedAt),
    reviewRequestedAt: new Date("2026-10-05T10:00:00.000Z"),
    decidedAt: null,
    liftedAt: null,
    decidedByHumanId: null,
  };

  it("opens on all open pauses and counts waiting requests separately", () => {
    api.listData = { items: [serverItem] };
    render(<InvitePauseQueue />);
    expect(api.listCalls[0]).toEqual({ status: "OPEN", limit: 100 });
    expect(api.listCalls[1]).toEqual({ status: "AWAITING_REVIEW", limit: 100 });
    expect(screen.getByTestId("invite-pause-filter-OPEN").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("invite-pause-waiting-count").textContent).toBe(
      "invitePauseQueue.waitingCount 1",
    );
  });

  it("sends LIFTED with a null note, toasts and invalidates", async () => {
    api.listData = { items: [serverItem] };
    api.decide.mockResolvedValueOnce({ pause: serverItem });
    render(<InvitePauseQueue />);
    fireEvent.click(screen.getByTestId("invite-pause-review-pause-asked"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-lift-pause-asked"));
    });
    expect(api.decide).toHaveBeenCalledWith({ pauseId: "pause-asked", decision: "LIFTED", note: null });
    expect(notify.success).toHaveBeenCalledWith({ title: "invitePauseQueue.liftedToast" });
    expect(api.invalidate).toHaveBeenCalled();
  });

  it("sends KEPT with the note", async () => {
    api.listData = { items: [serverItem] };
    api.decide.mockResolvedValueOnce({ pause: serverItem });
    render(<InvitePauseQueue />);
    fireEvent.click(screen.getByTestId("invite-pause-review-pause-asked"));
    fireEvent.change(screen.getByTestId("invite-pause-decision-note"), {
      target: { value: "Your list was bought." },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-keep-pause-asked"));
    });
    expect(api.decide).toHaveBeenCalledWith({
      pauseId: "pause-asked",
      decision: "KEPT",
      note: "Your list was bought.",
    });
    expect(notify.success).toHaveBeenCalledWith({ title: "invitePauseQueue.keptToast" });
  });

  it("gives SUPPORT read-only cards: no Review, Lift or Keep", () => {
    api.staffRoles = ["SUPPORT"];
    api.listData = { items: [serverItem] };
    render(<InvitePauseQueue />);
    expect(screen.getByTestId("invite-pause-row-pause-asked")).toBeTruthy();
    expect(screen.getByText("These are all past buyers.")).toBeTruthy();
    expect(screen.queryByTestId("invite-pause-review-pause-asked")).toBeNull();
    expect(screen.queryByTestId("invite-pause-lift-pause-asked")).toBeNull();
    expect(screen.queryByTestId("invite-pause-keep-pause-asked")).toBeNull();
  });

  it("shows the Review button to ADMIN and REVIEWER", () => {
    api.listData = { items: [serverItem] };
    for (const role of ["ADMIN", "REVIEWER"]) {
      api.staffRoles = [role];
      const { unmount } = render(<InvitePauseQueue />);
      expect(screen.getByTestId("invite-pause-review-pause-asked")).toBeTruthy();
      unmount();
    }
  });

  it("says so and refetches when another staff member already lifted it", () => {
    render(<InvitePauseQueue />);
    api.mutationOpts?.onError?.(
      Object.assign(new Error("invite_pause_already_lifted"), {
        data: { code: "CONFLICT", appCode: "INVALID_STATUS" },
      }),
    );
    expect(notify.info).toHaveBeenCalledWith({ title: "invitePauseQueue.alreadyDecidedToast" });
    expect(api.invalidate).toHaveBeenCalled();
  });
});

describe("InvitePauseQueue (container): failures and paging", () => {
  const serverRow = (id: string, pausedAt: string) => ({
    ...item({ id, pausedAt }),
    pausedAt: new Date(pausedAt),
    decidedByHumanId: null,
  });

  it("shows a failed decision with the error translated", () => {
    render(<InvitePauseQueue />);
    api.mutationOpts?.onError?.(
      Object.assign(new Error("FORBIDDEN"), {
        data: { code: "FORBIDDEN", appCode: "FORBIDDEN", httpStatus: 403 },
      }),
    );
    expect(notify.danger).toHaveBeenCalledTimes(1);
    const arg = notify.danger.mock.calls[0]?.[0] as { title: string; message: string };
    expect(arg.title).toBe("invitePauseQueue.decisionFailedToast");
    // Went through the translator: a translated errors.* line, not raw
    // server text and not the untranslated fallback.
    expect(arg.message).toMatch(/^T\(errors\./);
  });

  it("loads the next page by offset and appends it", async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      serverRow(`p${i}`, new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString()),
    );
    api.listData = { items: first };
    api.fetchPage.mockResolvedValueOnce({
      items: [serverRow("p100", "2026-08-01T00:00:00.000Z")],
    });
    render(<InvitePauseQueue />);
    expect(screen.queryByTestId("invite-pause-row-p100")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-load-more"));
    });
    expect(api.fetchPage).toHaveBeenCalledWith({
      status: "OPEN",
      limit: 100,
      offset: 100,
    });
    expect(screen.getByTestId("invite-pause-row-p100")).toBeTruthy();
    expect(screen.getAllByTestId(/^invite-pause-row-/)).toHaveLength(101);
    // A short page means the end: no more button.
    expect(screen.queryByTestId("invite-pause-load-more")).toBeNull();
  });

  it("offers no Load more under a full page", () => {
    api.listData = { items: [serverRow("only", "2026-09-01T00:00:00.000Z")] };
    render(<InvitePauseQueue />);
    expect(screen.queryByTestId("invite-pause-load-more")).toBeNull();
  });
});

describe("InvitePauseQueue (container): one sorted list", () => {
  const row = (id: string, pausedAt: string, reviewRequestedAt: string | null = null) => ({
    ...item({ id, pausedAt, reviewRequestedAt }),
    pausedAt: new Date(pausedAt),
    reviewRequestedAt: reviewRequestedAt ? new Date(reviewRequestedAt) : null,
    decidedByHumanId: null,
  });
  const order = () =>
    screen.getAllByTestId(/^invite-pause-row-/).map((el) => el.getAttribute("data-testid"));

  it("shows review requests first (oldest ask first), then the rest oldest-paused first", () => {
    // Server order (pausedAt desc) on purpose: the client sort must fix it.
    api.listData = {
      items: [
        row("new-quiet", "2026-10-05T00:00:00.000Z"),
        row("asked-late", "2026-10-04T00:00:00.000Z", "2026-10-06T00:00:00.000Z"),
        row("old-quiet", "2026-09-01T00:00:00.000Z"),
        row("asked-early", "2026-09-20T00:00:00.000Z", "2026-10-02T00:00:00.000Z"),
      ],
    };
    render(<InvitePauseQueue />);
    expect(order()).toEqual([
      "invite-pause-row-asked-early",
      "invite-pause-row-asked-late",
      "invite-pause-row-old-quiet",
      "invite-pause-row-new-quiet",
    ]);
  });

  it("sorts the merged list after Load more, not each page", async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      row(`p${i}`, new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString()),
    );
    api.listData = { items: first };
    api.fetchPage.mockResolvedValueOnce({
      items: [
        // An ask on page 2 jumps to the top; an older pause leads the rest.
        row("late-ask", "2026-09-30T00:00:00.000Z", "2026-10-03T00:00:00.000Z"),
        row("oldest", "2026-08-01T00:00:00.000Z"),
      ],
    });
    render(<InvitePauseQueue />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-load-more"));
    });
    const rows = order();
    expect(rows).toHaveLength(102);
    expect(rows[0]).toBe("invite-pause-row-late-ask");
    expect(rows[1]).toBe("invite-pause-row-oldest");
    expect(rows[2]).toBe("invite-pause-row-p0");
    expect(rows[101]).toBe("invite-pause-row-p99");
  });
});

describe("InvitePauseQueue (container): page 1 refetches and the waiting badge", () => {
  const serverRow = (id: string, pausedAt: string, reviewRequestedAt: string | null = null) => ({
    ...item({ id, pausedAt, reviewRequestedAt }),
    pausedAt: new Date(pausedAt),
    reviewRequestedAt: reviewRequestedAt ? new Date(reviewRequestedAt) : null,
    decidedByHumanId: null,
  });
  const fullPage = (asked = false) =>
    Array.from({ length: 100 }, (_, i) => {
      const at = new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();
      return serverRow(`p${i}`, at, asked ? at : null);
    });

  it("drops the Load more pages when page 1 refetches in the background", async () => {
    api.listData = { items: fullPage() };
    api.fetchPage.mockResolvedValueOnce({
      items: [serverRow("p100", "2026-08-01T00:00:00.000Z")],
    });
    const { rerender } = render(<InvitePauseQueue />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("invite-pause-load-more"));
    });
    expect(screen.getAllByTestId(/^invite-pause-row-/)).toHaveLength(101);

    // Window focus refetched page 1: the old offsets no longer hold.
    api.listUpdatedAt = 2;
    rerender(<InvitePauseQueue />);
    expect(screen.queryByTestId("invite-pause-row-p100")).toBeNull();
    expect(screen.getAllByTestId(/^invite-pause-row-/)).toHaveLength(100);
    expect(screen.getByTestId("invite-pause-load-more")).toBeTruthy();
  });

  it("reads 100+ when the waiting count fills a whole page", () => {
    api.listData = { items: fullPage(true) };
    render(<InvitePauseQueue />);
    expect(screen.getByTestId("invite-pause-waiting-count").textContent).toBe(
      "invitePauseQueue.waitingCountAtLeast 100",
    );
  });

  it("reads the plain count under a full page", () => {
    api.listData = { items: [serverRow("one", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z")] };
    render(<InvitePauseQueue />);
    expect(screen.getByTestId("invite-pause-waiting-count").textContent).toBe(
      "invitePauseQueue.waitingCount 1",
    );
  });
});

describe("InvitePauseQueueView: a linked organiser with no name", () => {
  it("shows the kind once, then the id, like the unlinked row", () => {
    renderView([item({ id: "nameless", ownerName: null, ownerSlug: "basement-shows" })]);
    const link = screen.getByRole("link");
    expect(link.textContent).toBe("invitePauseQueue.ownerKindOrgorg-1");
  });
});
