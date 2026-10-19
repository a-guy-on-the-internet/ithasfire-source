/**
 * The event editor's Category picker in the organiser's language
 * (category-translations FR-007, FR-009): names shown in the UI language,
 * the typeahead matching a name in any language, the saved category
 * hydrating in that language, and a category request carrying the
 * organiser's UI language.
 *
 * The design system is mocked down to bare DOM. The AutocompleteField
 * stand-in lists every suggestion as a button and submits the query through
 * a separate button, which is all the section's own logic needs.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Props = { children?: ReactNode; [key: string]: unknown };

const state = vi.hoisted(() => ({
  locale: "es",
  categories: [] as Array<Record<string, unknown>>,
  eventForEdit: null as Record<string, unknown> | null,
  requestOption: vi.fn(),
  setEventCategory: vi.fn(),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const { pickDomProps } = await import("@/test-support/pick-dom-props");
  const Stack = ({ children, ...rest }: Props) =>
    React.createElement("div", pickDomProps(rest), children);
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return { Check: Icon, ChevronDown: Icon, Hash: Icon, Plus: Icon, X: Icon };
});

vi.mock("../_form-bits", () => ({
  Field: ({ children }: Props) => <div>{children}</div>,
  FieldLabel: ({ children }: Props) => <span>{children}</span>,
}));

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const { pickDomProps } = await import("@/test-support/pick-dom-props");
  type Item = { type: string; id: string; name: string };
  return {
    Text: ({ children, ...rest }: Props) => (
      <span {...pickDomProps(rest)}>{children}</span>
    ),
    Button: ({ children, onPress }: Props) => (
      <button type="button" onClick={onPress as () => void}>
        {children}
      </button>
    ),
    AutocompleteField: ({
      query,
      onQueryChange,
      data,
      onSelectSuggestion,
      onSubmitQuery,
      testIdBase,
    }: {
      query: string;
      onQueryChange: (next: string) => void;
      data: { sections: Array<{ items: Item[] }> };
      onSelectSuggestion: (item: Item) => void;
      onSubmitQuery: (query: string) => void;
      testIdBase: string;
    }) =>
      React.createElement(
        "div",
        { "data-testid": `${testIdBase}-field` },
        <input
          data-testid={`${testIdBase}-input`}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />,
        <button
          type="button"
          data-testid={`${testIdBase}-submit`}
          onClick={() => onSubmitQuery(query)}
        >
          submit
        </button>,
        ...data.sections.flatMap((section) =>
          section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`${testIdBase}-option`}
              onClick={() => onSelectSuggestion(item)}
            >
              {item.type === "request" ? `request:${item.name}` : item.name}
            </button>
          )),
        ),
      ),
    useLocale: () => state.locale,
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { getEventForEdit: { invalidate: vi.fn() } },
      tags: { getEventTags: { invalidate: vi.fn() } },
      categories: { listRequests: { invalidate: vi.fn() } },
    }),
    categories: {
      list: {
        useQuery: () => ({
          data: { categories: state.categories },
          isLoading: false,
        }),
      },
      setEventCategory: {
        useMutation: () => ({
          mutateAsync: state.setEventCategory,
          isPending: false,
        }),
      },
      requestOption: {
        useMutation: () => ({
          mutateAsync: state.requestOption,
          isPending: false,
        }),
      },
    },
    events: {
      getEventForEdit: {
        useQuery: () => ({ data: state.eventForEdit ?? undefined }),
      },
    },
    tags: {
      getEventTags: { useQuery: () => ({ data: undefined }) },
      search: { useQuery: () => ({ data: undefined, isFetching: false }) },
      setEventTags: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
  },
}));

import { CategoryTagsSection } from "../CategoryTagsSection";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const MUSIC = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "music",
  name: "Music",
  names: { en: "Music", es: "Música" },
  sortOrder: 0,
};
const TRIVIA = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "trivia",
  name: "Trivia",
  names: { en: "Trivia" },
  sortOrder: 1,
};

const input = () =>
  screen.getByTestId("event-category-picker-input") as HTMLInputElement;
const optionLabels = () =>
  screen
    .queryAllByTestId("event-category-picker-option")
    .map((option) => option.textContent);

describe("CategoryTagsSection: category names by language", () => {
  beforeEach(() => {
    state.locale = "es";
    state.categories = [MUSIC, TRIVIA];
    state.eventForEdit = null;
    state.requestOption.mockReset();
    state.requestOption.mockResolvedValue({ request: {} });
    state.setEventCategory.mockReset();
    state.setEventCategory.mockResolvedValue({});
  });

  it("lists names in the organiser's language, English where there is none", () => {
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    expect(optionLabels()).toEqual(["Música", "Trivia"]);
  });

  it("finds a category by its English name for a Spanish reader", () => {
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    fireEvent.change(input(), { target: { value: "music" } });
    expect(optionLabels()).toEqual(["Música"]);
  });

  it("finds a category by its Spanish name for an English reader", () => {
    state.locale = "en";
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    fireEvent.change(input(), { target: { value: "músi" } });
    // A partial name still offers the request row, as it always has.
    expect(optionLabels()).toEqual(["Music", "request:músi"]);
  });

  it("never offers to request a category that exists under another language's name", () => {
    state.locale = "en";
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    fireEvent.change(input(), { target: { value: "Música" } });
    expect(optionLabels()).toEqual(["Music"]);
  });

  it("hydrates the saved category in the organiser's language", () => {
    state.eventForEdit = {
      categoryId: MUSIC.id,
      category: { id: MUSIC.id, slug: "music", name: "Music", active: true },
    };
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    expect(input().value).toBe("Música");
  });

  it("hydrates an INACTIVE saved category in the organiser's language", () => {
    // Deactivated: absent from categories.list, so the server join is the
    // only source of its name.
    state.categories = [TRIVIA];
    state.eventForEdit = {
      categoryId: MUSIC.id,
      category: {
        id: MUSIC.id,
        slug: "music",
        name: "Music",
        names: { en: "Music", es: "Música" },
        active: false,
      },
    };
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    expect(input().value).toBe("Música");
  });

  it("saves a picked category by slug, whatever language it is shown in", async () => {
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Música"));
    });
    expect(state.setEventCategory).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      categorySlug: "music",
    });
  });

  it("sends the UI language with a category request", async () => {
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    fireEvent.change(input(), { target: { value: "Cumbia" } });
    await act(async () => {
      fireEvent.click(screen.getByText("request:Cumbia"));
    });
    expect(state.requestOption).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      kind: "CATEGORY",
      name: "Cumbia",
      locale: "es",
    });
  });

  it("sends English as the request's language when the UI is in English", async () => {
    state.locale = "en";
    render(<CategoryTagsSection eventId={EVENT_ID} />);
    fireEvent.change(input(), { target: { value: "Cumbia" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("event-category-picker-submit"));
    });
    expect(state.requestOption).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Cumbia", locale: "en" }),
    );
  });
});
