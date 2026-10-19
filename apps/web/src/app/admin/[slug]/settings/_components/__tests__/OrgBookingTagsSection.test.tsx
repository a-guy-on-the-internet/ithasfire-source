import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Org settings → Booking tags (booking-holds FR-017): rename on blur / Enter,
 * recolour on change, reorder by renumbering the whole list, delete through
 * the confirm. Each edit is its own write; the list is re-read after.
 */

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  updateAsync: vi.fn(),
  del: vi.fn(),
  tagsInvalidate: vi.fn(),
  listInvalidate: vi.fn(),
  toastDanger: vi.fn(),
}));

let tags: { id: string; name: string; color: string; sortOrder: number }[] = [];

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingTags: { list: { invalidate: mocks.tagsInvalidate } },
      bookingRequests: { list: { invalidate: mocks.listInvalidate } },
    }),
    bookingTags: {
      list: {
        useQuery: () => ({ data: { tags }, isLoading: false, error: null, refetch: vi.fn() }),
      },
      create: { useMutation: () => ({ mutate: mocks.create, isPending: false }) },
      update: {
        useMutation: () => ({ mutate: mocks.update, mutateAsync: mocks.updateAsync, isPending: false }),
      },
      delete: { useMutation: () => ({ mutate: mocks.del, isPending: false }) },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = (props: Record<string, unknown>) => (
    <div
      data-testid={(props.testID ?? props["data-testid"]) as string | undefined}
      role={props.role as string | undefined}
    >
      {props.children as ReactNode}
    </div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    disabled,
    onPress,
    testID,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
    "aria-label"?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  Spinner: () => <span>loading…</span>,
  StyledSelect: ({
    value,
    options,
    onChange,
    testId,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
    testId?: string;
  }) => (
    <select data-testid={testId} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  Text: ({
    children,
    role,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    role?: string;
    "data-testid"?: string;
  }) => (
    <span role={role} data-testid={testId}>
      {children}
    </span>
  ),
  TextInput: ({
    value,
    onChangeText,
    onBlur,
    onSubmitEditing,
    testId,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
    onBlur?: () => void;
    onSubmitEditing?: () => void;
    testId?: string;
  }) => (
    <input
      data-testid={testId}
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.currentTarget.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmitEditing?.();
      }}
    />
  ),
  useNotify: () => ({ toast: { danger: mocks.toastDanger } }),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return { ArrowDown: Icon, ArrowUp: Icon, Plus: Icon, Trash2: Icon };
});

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    description,
    onConfirm,
  }: {
    open: boolean;
    description: ReactNode;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <div data-testid="dialog-description">{description}</div>
        <button type="button" data-testid="dialog-confirm" onClick={onConfirm}>
          confirm
        </button>
      </div>
    ) : null,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => `fmt:${(err as Error)?.message}`,
}));

vi.mock("@/components/bookings/BookingTagChip", () => ({
  BookingTagChip: ({ name }: { name: string }) => <span data-testid="chip">{name}</span>,
}));

vi.mock("../org-settings-primitives", () => ({
  SectionHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

import { OrgBookingTagsSection } from "../OrgBookingTagsSection";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateAsync.mockResolvedValue({});
  tags = [
    { id: "t-a", name: "Rock", color: "neutral", sortOrder: 0 },
    { id: "t-b", name: "Jazz", color: "info", sortOrder: 1 },
    { id: "t-c", name: "Folk", color: "success", sortOrder: 2 },
  ];
});

describe("OrgBookingTagsSection", () => {
  it("lists tags in sort order and shows the empty state when there are none", () => {
    const { unmount } = render(<OrgBookingTagsSection orgId="org-1" />);
    expect(screen.getAllByTestId("chip").map((c) => c.textContent)).toEqual(["Rock", "Jazz", "Folk"]);
    unmount();
    tags = [];
    render(<OrgBookingTagsSection orgId="org-1" />);
    expect(screen.getByTestId("org-booking-tags-empty")).toBeTruthy();
  });

  it("renames on blur — and not when the name is unchanged or blank", () => {
    render(<OrgBookingTagsSection orgId="org-1" />);
    const input = screen.getByTestId("org-booking-tag-t-a-name");
    fireEvent.change(input, { target: { value: "Indie Rock " } });
    // The chip previews the draft live.
    expect(screen.getAllByTestId("chip")[0]!.textContent).toBe("Indie Rock ");
    fireEvent.blur(input);
    expect(mocks.update).toHaveBeenCalledWith(
      { orgId: "org-1", tagId: "t-a", name: "Indie Rock" },
      expect.anything(),
    );
    mocks.update.mockClear();
    fireEvent.change(input, { target: { value: "Rock" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("recolours on change with a colour from the theme set only", () => {
    render(<OrgBookingTagsSection orgId="org-1" />);
    fireEvent.change(screen.getByTestId("org-booking-tag-t-b-color"), { target: { value: "success" } });
    expect(mocks.update).toHaveBeenCalledWith(
      { orgId: "org-1", tagId: "t-b", color: "success" },
      expect.anything(),
    );
  });

  it("reorders by renumbering every row whose order changed, then re-reads", async () => {
    render(<OrgBookingTagsSection orgId="org-1" />);
    const up = screen.getByLabelText('admin.bkTagMoveUp {"name":"Folk"}');
    await act(async () => {
      fireEvent.click(up);
    });
    await waitFor(() => expect(mocks.tagsInvalidate).toHaveBeenCalledWith({ orgId: "org-1" }));
    // Folk moves to index 1, Jazz to index 2; Rock stays at 0 and is not rewritten.
    expect(mocks.updateAsync.mock.calls.map((c) => c[0])).toEqual([
      { orgId: "org-1", tagId: "t-c", sortOrder: 1 },
      { orgId: "org-1", tagId: "t-b", sortOrder: 2 },
    ]);
    expect(screen.getByLabelText('admin.bkTagMoveUp {"name":"Rock"}')).toBeDisabled();
    expect(screen.getByLabelText('admin.bkTagMoveDown {"name":"Folk"}')).toBeDisabled();
  });

  it("deletes through the confirm, which names the tag", () => {
    render(<OrgBookingTagsSection orgId="org-1" />);
    fireEvent.click(screen.getByTestId("org-booking-tag-t-b-delete"));
    expect(screen.getByTestId("dialog-description").textContent).toContain("Jazz");
    fireEvent.click(screen.getByTestId("dialog-confirm"));
    expect(mocks.del).toHaveBeenCalledWith({ orgId: "org-1", tagId: "t-b" }, expect.anything());
  });

  it("adds a tag from the dashed form and clears it on success", () => {
    render(<OrgBookingTagsSection orgId="org-1" />);
    expect(screen.getByTestId("org-booking-tags-add-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("org-booking-tags-add-name"), { target: { value: " Punk " } });
    fireEvent.change(screen.getByTestId("org-booking-tags-add-color"), { target: { value: "info" } });
    fireEvent.click(screen.getByTestId("org-booking-tags-add-submit"));
    expect(mocks.create).toHaveBeenCalledWith(
      { orgId: "org-1", name: "Punk", color: "info" },
      expect.anything(),
    );
    const opts = mocks.create.mock.calls[0]![1] as { onSuccess: () => void };
    act(() => opts.onSuccess());
    expect((screen.getByTestId("org-booking-tags-add-name") as HTMLInputElement).value).toBe("");
    expect(mocks.listInvalidate).toHaveBeenCalled();
  });

  it("a failed write toasts the translated copy and re-reads", () => {
    render(<OrgBookingTagsSection orgId="org-1" />);
    fireEvent.change(screen.getByTestId("org-booking-tag-t-b-color"), { target: { value: "success" } });
    const opts = mocks.update.mock.calls[0]![1] as { onError: (e: unknown) => void };
    act(() => opts.onError(new Error("BOOKING_TAG_NAME_TAKEN")));
    expect(mocks.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({ message: "fmt:BOOKING_TAG_NAME_TAKEN" }),
    );
    expect(mocks.tagsInvalidate).toHaveBeenCalled();
  });
});
