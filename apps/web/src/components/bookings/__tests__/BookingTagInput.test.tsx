import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The type-to-create tag picker (booking-holds FR-017). Controlled: it never
 * writes the row, only reports the next id list. Pins select-existing (case
 * insensitive, no duplicate mint), create-on-submit, and that `disabled`
 * keeps the field MOUNTED so a write in flight does not drop focus.
 */

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  listInvalidate: vi.fn(),
  toastDanger: vi.fn(),
}));

let tags: { id: string; name: string; color: string }[] = [];

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({ bookingTags: { list: { invalidate: mocks.listInvalidate } } }),
    bookingTags: {
      list: { useQuery: () => ({ data: { tags }, isLoading: false, isError: false, error: null }) },
      create: { useMutation: () => ({ mutate: mocks.create, isPending: false }) },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = (props: Record<string, unknown>) => (
    <div data-testid={(props.testID ?? props["data-testid"]) as string | undefined}>
      {props.children as ReactNode}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack, useTheme: () => ({}) };
});

vi.mock("@th/ui", () => ({
  AutocompleteField: ({
    query,
    onQueryChange,
    onSubmitQuery,
    onSelectSuggestion,
    data,
    inputProps,
    testIdBase,
  }: {
    query: string;
    onQueryChange: (v: string) => void;
    onSubmitQuery?: (raw: string) => void;
    onSelectSuggestion: (s: unknown) => void;
    data: { sections: { id: string; items: unknown[] }[] };
    inputProps?: { disabled?: boolean; "aria-label"?: string };
    testIdBase?: string;
  }) => (
    <div>
      <input
        data-testid={`${testIdBase}-input`}
        value={query}
        disabled={inputProps?.disabled}
        aria-label={inputProps?.["aria-label"]}
        onChange={(e) => onQueryChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmitQuery?.(query);
        }}
      />
      <ul data-testid={`${testIdBase}-suggestions`}>
        {data.sections.flatMap((s) =>
          s.items.map((item) => {
            const it = item as { id: string };
            return (
              <li key={it.id}>
                <button type="button" data-testid={`suggest-${it.id}`} onClick={() => onSelectSuggestion(item)}>
                  {it.id}
                </button>
              </li>
            );
          }),
        )}
      </ul>
    </div>
  ),
  // The suggestion row is `styled(Button)`; the tamagui `styled` mock returns
  // a plain stack, so this only needs to exist for the import.
  Button: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useNotify: () => ({ toast: { danger: mocks.toastDanger } }),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return { Plus: Icon, Tag: Icon, X: Icon };
});

vi.mock("../BookingTagChip", () => ({
  BookingTagChip: ({
    name,
    onRemove,
    testId,
  }: {
    name: string;
    onRemove?: () => void;
    testId?: string;
  }) => (
    <span data-testid={testId}>
      {name}
      {onRemove ? (
        <button type="button" data-testid={`${testId}-remove`} onClick={onRemove}>
          x
        </button>
      ) : null}
    </span>
  ),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => `fmt:${(err as Error)?.message}`,
}));

import { BookingTagInput } from "../BookingTagInput";

type Props = Parameters<typeof BookingTagInput>[0];

function renderInput(props: Partial<Props> = {}) {
  const onChange = vi.fn();
  const base: Props = {
    orgId: "org-1",
    value: [],
    onChange,
    allowCreate: true,
    testIdBase: "tags",
    ...props,
  };
  const utils = render(<BookingTagInput {...base} />);
  return { ...utils, onChange };
}

const type = (text: string) =>
  fireEvent.change(screen.getByTestId("tags-field-input"), { target: { value: text } });
const submit = () => fireEvent.keyDown(screen.getByTestId("tags-field-input"), { key: "Enter" });

beforeEach(() => {
  vi.clearAllMocks();
  tags = [
    { id: "t-rock", name: "Rock", color: "neutral" },
    { id: "t-jazz", name: "Jazz", color: "sky" },
  ];
});

describe("BookingTagInput", () => {
  it("renders the selected ids as chips, each removable", () => {
    const { onChange } = renderInput({ value: ["t-rock", "t-jazz"] });
    expect(screen.getByTestId("tags-chip-t-rock").textContent).toContain("Rock");
    fireEvent.click(screen.getByTestId("tags-chip-t-jazz-remove"));
    expect(onChange).toHaveBeenCalledWith(["t-rock"]);
  });

  it("submitting an existing name (any case) selects it — never mints a duplicate", () => {
    const { onChange } = renderInput({ value: ["t-jazz"] });
    type("  rock ");
    submit();
    expect(onChange).toHaveBeenCalledWith(["t-jazz", "t-rock"]);
    expect(mocks.create).not.toHaveBeenCalled();
    // The box is cleared once the pick lands.
    expect((screen.getByTestId("tags-field-input") as HTMLInputElement).value).toBe("");
  });

  it("offers a create row only for a name that does not exist yet", () => {
    renderInput();
    type("Ro");
    expect(screen.getByTestId("suggest-tag-t-rock")).toBeTruthy();
    expect(screen.getByTestId("suggest-tag-create-ro")).toBeTruthy();
    type("rock");
    expect(screen.queryByTestId("suggest-tag-create-rock")).toBeNull();
  });

  it("submitting a new name creates it with the neutral colour, then selects the minted id", () => {
    const { onChange } = renderInput({ value: ["t-rock"] });
    type("Folk");
    submit();
    expect(mocks.create).toHaveBeenCalledWith(
      { orgId: "org-1", name: "Folk", color: "neutral" },
      expect.anything(),
    );
    const opts = mocks.create.mock.calls[0]![1] as { onSuccess: (r: unknown) => void };
    act(() => opts.onSuccess({ tag: { id: "t-folk" } }));
    expect(mocks.listInvalidate).toHaveBeenCalledWith({ orgId: "org-1" });
    expect(onChange).toHaveBeenCalledWith(["t-rock", "t-folk"]);
  });

  it("re-picking a tag already on the row clears the box and reports nothing", () => {
    const { onChange } = renderInput({ value: ["t-rock"] });
    type("rock");
    submit();
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByTestId("tags-field-input") as HTMLInputElement).value).toBe("");
  });

  it("without allowCreate, an unknown name is not created", () => {
    const { onChange } = renderInput({ allowCreate: false });
    type("Folk");
    expect(screen.queryByTestId("suggest-tag-create-folk")).toBeNull();
    submit();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled keeps the field MOUNTED (and disabled) — a write in flight must not drop focus", () => {
    const { rerender } = renderInput({ value: ["t-rock"] });
    const input = screen.getByTestId("tags-field-input") as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    rerender(
      <BookingTagInput orgId="org-1" value={["t-rock"]} onChange={vi.fn()} allowCreate testIdBase="tags" disabled />,
    );
    const still = screen.getByTestId("tags-field-input") as HTMLInputElement;
    expect(still).toBe(input);
    expect(still).toBeDisabled();
    // Chips lose their remove control while locked.
    expect(screen.queryByTestId("tags-chip-t-rock-remove")).toBeNull();
  });
});
