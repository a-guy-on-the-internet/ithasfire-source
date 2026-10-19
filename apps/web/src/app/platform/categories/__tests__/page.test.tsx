/**
 * /platform/categories: the create form and each tile's lifecycle controls
 * (rename, deactivate / reactivate, reorder, delete). Who sees them, what
 * they send, and where a refusal lands.
 *
 * The design system is mocked down to bare DOM (stand-ins forward `aria-*`,
 * `id`, `role` and `disabled` through `pickDomProps`), so this covers the
 * page's own logic. The Button stand-in copies the real one's inert shape:
 * `aria-disabled` + `tabIndex=-1` and a dead press, never a native `disabled`. Layout, hydration and how the form sits among the tiles
 * are checked in the running app. Assertions use plain DOM reads, not
 * jest-dom matchers.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Props = { children?: ReactNode; [key: string]: unknown };

interface CreateOptions {
  meta?: Record<string, unknown>;
  onSuccess?: (data: {
    category: { name: string; slug: string };
    resolvedRequestCount: number;
  }) => void;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
}

interface CapturedOptions {
  meta?: Record<string, unknown>;
  onSuccess?: (data: unknown, variables: unknown) => void;
  onError?: (error: unknown, variables: unknown) => void;
  onSettled?: () => void;
}

const state = vi.hoisted(() => {
  // One per mutation: the `mutate` spy and the options the page passed, so a
  // test can play the server's reply through `onSuccess` / `onError`.
  // `pending` and `variables` are what the hook reports on the next render,
  // so a test can put a request "out" and look at the page meanwhile.
  const captured = () => ({
    mutate: vi.fn(),
    options: null as CapturedOptions | null,
    pending: false,
    variables: undefined as Record<string, unknown> | undefined,
  });
  return {
    roles: [] as string[],
    // True while `checkStaffAccess` has not answered: `data` is undefined.
    rolesLoading: false,
    categories: [] as Array<Record<string, unknown>>,
    createMutate: vi.fn(),
    createOptions: null as CreateOptions | null,
    createPending: false,
    rename: captured(),
    setActive: captured(),
    reorder: captured(),
    remove: captured(),
    setSeoType: captured(),
    reviewRequest: captured(),
    setTranslations: captured(),
    suggestTranslations: captured(),
    changeSlug: captured(),
    requests: [] as Array<Record<string, unknown>>,
    invalidateList: vi.fn(),
    invalidateListAll: vi.fn(),
    invalidateRequests: vi.fn(),
    refetchListAll: vi.fn(),
    toastSuccess: vi.fn(),
    toastDanger: vi.fn(),
    toastWarning: vi.fn(),
    routerPush: vi.fn(),
  };
});

// The real second-factor hook runs (it is the page's first answer to a
// failure); only the router it navigates with is a stand-in.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.routerPush }),
  usePathname: () => "/platform/categories",
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
  return {
    AlertTriangle: Icon,
    ExternalLink: Icon,
    ArrowDown: Icon,
    ArrowUp: Icon,
    Check: Icon,
    Plus: Icon,
    RefreshCw: Icon,
    Tag: Icon,
    Trash2: Icon,
    X: Icon,
  };
});

vi.mock("../../_components/PlatformPageParts", () => {
  const Part = ({ children }: Props) => <div>{children}</div>;
  return {
    PlatformContainer: Part,
    PlatformFilterBar: Part,
    PlatformPageTitle: Part,
    PlatformSectionTitle: Part,
    PlatformSubtitle: Part,
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const { pickDomProps } = await import("@/test-support/pick-dom-props");
  const Text = ({ children, tag, ...rest }: Props) =>
    React.createElement(
      typeof tag === "string" ? tag : "span",
      pickDomProps(rest),
      children,
    );
  return {
    Text,
    Badge: Text,
    Spinner: () => <span data-testid="spinner" />,
    // The real Button (packages/ui Button.tsx) never emits a native
    // `disabled`: an inert one is `aria-disabled="true" tabindex="-1"` and its
    // press does nothing.
    Button: ({ children, onPress, type, disabled, ...rest }: Props) => (
      <button
        {...pickDomProps(rest)}
        type={type === "submit" ? "submit" : "button"}
        aria-disabled={disabled ? true : undefined}
        tabIndex={disabled ? -1 : undefined}
        onClick={disabled ? undefined : (onPress as () => void)}
      >
        {children}
      </button>
    ),
    TextInput: ({
      value,
      onChangeText,
      onBlur,
      onSubmitEditing,
      testId,
      maxLength,
      readOnly,
      ...rest
    }: Props) => (
      <input
        {...pickDomProps(rest)}
        onBlur={onBlur as (() => void) | undefined}
        // react-native-web's TextInput calls `onSubmitEditing` on Enter.
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            (onSubmitEditing as (() => void) | undefined)?.();
          }
        }}
        data-testid={testId as string | undefined}
        maxLength={maxLength as number | undefined}
        readOnly={readOnly === true}
        value={value as string}
        onChange={(event) =>
          (onChangeText as (next: string) => void)(event.target.value)
        }
      />
    ),
    StyledSelect: ({
      value,
      options,
      onChange,
      testId,
      selectId,
      ariaLabel,
      disabled,
    }: {
      value: string;
      options: Array<{ value: string; label: string }>;
      onChange: (next: string) => void;
      testId?: string;
      selectId?: string;
      ariaLabel?: string;
      disabled?: boolean;
    }) => (
      <select
        data-testid={testId}
        id={selectId}
        aria-label={ariaLabel}
        disabled={disabled}
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
    useNotify: () => ({
      toast: {
        success: state.toastSuccess,
        danger: state.toastDanger,
        warning: state.toastWarning,
      },
    }),
    // Returns the key, with any variables appended, so a test can tell which
    // message rendered and with what.
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key,
  };
});

vi.mock("@/trpc", () => {
  const capturing =
    (slot: {
      mutate: unknown;
      options: unknown;
      pending: boolean;
      variables: unknown;
    }) =>
    (options: unknown) => {
      slot.options = options;
      return {
        mutate: slot.mutate,
        isPending: slot.pending,
        variables: slot.variables,
      };
    };
  return {
    trpc: {
      useUtils: () => ({
        categories: {
          list: { invalidate: state.invalidateList },
          listAll: {
            invalidate: state.invalidateListAll,
            // The page shows a reorder's or a URL change's reply at once; the
            // stand-in does too. Takes the data or an updater, like tRPC.
            setData: (
              _input: undefined,
              data:
                | { categories: Array<Record<string, unknown>> }
                | ((previous: {
                    categories: Array<Record<string, unknown>>;
                  }) => { categories: Array<Record<string, unknown>> }),
            ) => {
              state.categories = (
                typeof data === "function"
                  ? data({ categories: state.categories })
                  : data
              ).categories;
            },
          },
          listRequests: { invalidate: state.invalidateRequests },
        },
      }),
      platform: {
        checkStaffAccess: {
          useQuery: () => ({
            data: state.rolesLoading ? undefined : { roles: state.roles },
          }),
        },
      },
      categories: {
        listAll: {
          useQuery: () => ({
            data: { categories: state.categories },
            error: null,
            isLoading: false,
            refetch: state.refetchListAll,
          }),
        },
        listRequests: {
          useQuery: () => ({
            data: { requests: state.requests, total: state.requests.length },
            error: null,
            isLoading: false,
            refetch: vi.fn(),
          }),
        },
        reviewRequest: { useMutation: capturing(state.reviewRequest) },
        setTranslations: { useMutation: capturing(state.setTranslations) },
        suggestTranslations: {
          useMutation: capturing(state.suggestTranslations),
        },
        setSeoType: { useMutation: capturing(state.setSeoType) },
        delete: { useMutation: capturing(state.remove) },
        rename: { useMutation: capturing(state.rename) },
        setActive: { useMutation: capturing(state.setActive) },
        reorder: { useMutation: capturing(state.reorder) },
        changeSlug: { useMutation: capturing(state.changeSlug) },
        create: {
          useMutation: (options: CreateOptions) => {
            state.createOptions = options;
            return {
              mutate: state.createMutate,
              isPending: state.createPending,
              variables: undefined,
            };
          },
        },
      },
    },
  };
});

import PlatformCategoriesPage from "../page";
import { movedCategoryIds } from "../_components/CategoryTile";

const nameInput = () =>
  screen.getByTestId("category-create-name") as HTMLInputElement;
const submitButton = () =>
  screen.getByTestId("category-create-submit") as HTMLButtonElement;

function typeName(value: string) {
  fireEvent.change(nameInput(), { target: { value } });
}

/** Pick a language in the Add form's language selector. */
function showCreateLanguage(locale: string) {
  fireEvent.change(screen.getByTestId("category-create-language"), {
    target: { value: locale },
  });
}

/** Pick a language in a tile's language selector. */
function showTileLanguage(slug: string, locale: string) {
  fireEvent.change(screen.getByTestId(`category-language-${slug}`), {
    target: { value: locale },
  });
}

/** Pick a language in a request's approval form. */
function showApprovalLanguage(requestId: string, locale: string) {
  fireEvent.change(screen.getByTestId(`category-approve-language-${requestId}`), {
    target: { value: locale },
  });
}

/** The option labels of a language selector, in order. */
function languageOptions(testId: string) {
  return Array.from(
    (screen.getByTestId(testId) as HTMLSelectElement).options,
  ).map((option) => option.textContent);
}

/** Inert the way the real Button is: announced, out of the Tab order. */
function submitIsInert() {
  const button = submitButton();
  // Guards the stand-in itself: a native `disabled` is not what ships.
  expect(button.disabled).toBe(false);
  const inert = button.getAttribute("aria-disabled") === "true";
  expect(button.getAttribute("tabindex")).toBe(inert ? "-1" : null);
  return inert;
}

/** What a screen reader calls a select: its aria-label, else its <label>. */
function accessibleName(select: HTMLSelectElement) {
  return (
    select.getAttribute("aria-label") ??
    (select.id
      ? document.querySelector(`label[for="${select.id}"]`)?.textContent
      : null) ??
    null
  );
}

const SECOND_FACTOR_ERROR = {
  message: "SECOND_FACTOR_REQUIRED",
  data: { code: "FORBIDDEN", appCode: "SECOND_FACTOR_REQUIRED" },
};

const appError = (appCode: string) => ({
  message: appCode,
  data: { appCode },
});

function resetState() {
  for (const slot of [
    state.rename,
    state.setActive,
    state.reorder,
    state.remove,
    state.setSeoType,
    state.reviewRequest,
    state.setTranslations,
    state.suggestTranslations,
    state.changeSlug,
  ]) {
    slot.mutate.mockReset();
    slot.options = null;
    slot.pending = false;
    slot.variables = undefined;
  }
  state.rolesLoading = false;
  state.invalidateListAll.mockReset();
  state.refetchListAll.mockReset();
}

describe("platform categories: create form", () => {
  beforeEach(() => {
    resetState();
    state.roles = ["ADMIN"];
    state.categories = [];
    state.createOptions = null;
    state.createPending = false;
    state.createMutate.mockReset();
    state.invalidateList.mockReset();
    state.invalidateRequests.mockReset();
    state.toastSuccess.mockReset();
    state.toastDanger.mockReset();
    state.toastWarning.mockReset();
    state.routerPush.mockReset();
  });

  it("is hidden from a REVIEWER", () => {
    state.roles = ["REVIEWER"];
    render(<PlatformCategoriesPage />);
    expect(screen.queryByTestId("category-create-form")).toBeNull();
    expect(screen.queryByTestId("category-create-name")).toBeNull();
  });

  it("is shown to an ADMIN, in the empty taxonomy state too", () => {
    render(<PlatformCategoriesPage />);
    expect(screen.queryByTestId("category-create-form")).not.toBeNull();
    // The page lists inactive categories too, so the empty state does not
    // say "active".
    expect(screen.queryByText("admin.pcNoCategoriesYet")).not.toBeNull();
    expect(screen.queryByText("admin.pcNoCategories")).toBeNull();
    // Both fields are named by a real <label for>.
    expect(
      document.querySelector(`label[for="${nameInput().id}"]`)?.textContent,
    ).toBe("admin.pcNameEnLabel");
    const seoSelect = screen.getByTestId(
      "category-create-seo-type",
    ) as HTMLSelectElement;
    expect(seoSelect.id).not.toBe("");
    expect(seoSelect.getAttribute("aria-label")).toBeNull();
    expect(accessibleName(seoSelect)).toBe("admin.pcAddSeoTypeLabel");
  });

  it("gives the new-category select and each tile select their own names", () => {
    state.categories = [
      {
        id: "c1",
        slug: "music",
        name: "Music",
        seoType: "MusicEvent",
        active: true,
        sortOrder: 1,
      },
      {
        id: "c2",
        slug: "comedy",
        name: "Comedy",
        seoType: "ComedyEvent",
        active: true,
        sortOrder: 2,
      },
    ];
    render(<PlatformCategoriesPage />);
    const names = Array.from(document.querySelectorAll("select")).map(
      accessibleName,
    );
    // Three SEO selects, three language selects and the queue's status
    // filter: all seven are named, each differently.
    expect(names).toHaveLength(7);
    const labelled = names.filter((name): name is string => name !== null);
    expect(labelled).toHaveLength(7);
    expect(new Set(labelled).size).toBe(7);
    expect(labelled).toContain("admin.pcAddSeoTypeLabel");
    expect(labelled).toContain("admin.pcLanguageLabel");
    expect(labelled).toContain('admin.pcLanguageFor {"name":"Music"}');
    expect(labelled).toContain("admin.pcStatusFilter");
  });

  it("keeps submit disabled until the name has a character that is not a space", () => {
    render(<PlatformCategoriesPage />);
    expect(submitIsInert()).toBe(true);
    typeName("   ");
    expect(submitIsInert()).toBe(true);
    fireEvent.click(submitButton());
    expect(state.createMutate).not.toHaveBeenCalled();
    typeName("Jazz");
    expect(submitIsInert()).toBe(false);
  });

  it("makes the name read-only, not disabled, while the request is out", () => {
    render(<PlatformCategoriesPage />);
    expect(nameInput().readOnly).toBe(false);
    state.createPending = true;
    typeName("Jazz");
    expect(nameInput().readOnly).toBe(true);
    expect(nameInput().disabled).toBe(false);
    expect(submitIsInert()).toBe(true);
  });

  it("sends the trimmed name and the chosen SEO type", () => {
    render(<PlatformCategoriesPage />);
    typeName("  Live   Music  ");
    fireEvent.change(screen.getByTestId("category-create-seo-type"), {
      target: { value: "MusicEvent" },
    });
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledTimes(1);
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Live Music",
      seoType: "MusicEvent",
    });
  });

  it("submits once when the form is submitted (Enter in the name field)", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    const form = screen.getByTestId("category-create-form");
    fireEvent.submit(form);
    // A second submit before the first settles is dropped.
    fireEvent.submit(form);
    expect(state.createMutate).toHaveBeenCalledTimes(1);
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Jazz",
      seoType: "Event",
    });
  });

  it("shows a one-character name the inline error without calling the server", () => {
    render(<PlatformCategoriesPage />);
    typeName("a");
    fireEvent.click(submitButton());
    expect(state.createMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "admin.pcAddErrorInvalidName",
    );
  });

  it("sends a corrected name after the client check refused the first one", () => {
    render(<PlatformCategoriesPage />);
    typeName("a");
    fireEvent.click(submitButton());
    expect(state.createMutate).not.toHaveBeenCalled();
    typeName("ab");
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledTimes(1);
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "ab",
      seoType: "Event",
    });
  });

  it("sends again once a refused request has settled", () => {
    render(<PlatformCategoriesPage />);
    typeName("Music");
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledTimes(1);
    act(() => {
      state.createOptions?.onError?.({
        message: "CATEGORY_ALREADY_EXISTS",
        data: { appCode: "CATEGORY_ALREADY_EXISTS" },
      });
      state.createOptions?.onSettled?.();
    });
    typeName("Music Hall");
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledTimes(2);
    expect(state.createMutate).toHaveBeenLastCalledWith({
      name: "Music Hall",
      seoType: "Event",
    });
  });

  it("opts out of the global error toast, since it answers every failure itself", () => {
    render(<PlatformCategoriesPage />);
    expect(state.createOptions?.meta).toEqual({ silent: true });
  });

  it("renders a duplicate refusal inline, keeps the name, and clears it on edit", () => {
    render(<PlatformCategoriesPage />);
    typeName("Music");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.({
        message: "CATEGORY_ALREADY_EXISTS",
        data: { appCode: "CATEGORY_ALREADY_EXISTS" },
      });
      state.createOptions?.onSettled?.();
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("admin.pcAddErrorExists");
    expect(nameInput().value).toBe("Music");
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(nameInput().getAttribute("aria-describedby")).toBe(alert.id);
    expect(state.toastDanger).not.toHaveBeenCalled();

    typeName("Music!");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nameInput().getAttribute("aria-invalid")).toBeNull();
  });

  it("renders an invalid-name refusal inline", () => {
    render(<PlatformCategoriesPage />);
    typeName("@@@@");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.({
        message: "INVALID_CATEGORY_REQUEST_NAME",
        data: { appCode: "INVALID_CATEGORY_REQUEST_NAME" },
      });
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "admin.pcAddErrorInvalidName",
    );
  });

  it("renders an input-schema refusal of the name (BAD_REQUEST, no app code) inline, not as raw Zod text", () => {
    render(<PlatformCategoriesPage />);
    typeName("<b>x");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.({
        message: '[{"code":"custom","path":["name"],"message":"Invalid"}]',
        data: { code: "BAD_REQUEST" },
      });
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "admin.pcAddErrorInvalidName",
    );
    expect(state.toastDanger).not.toHaveBeenCalled();
  });

  it("sends an input-schema refusal of another field to the toast, not under the name", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.({
        message:
          '[{"code":"invalid_value","path":["seoType"],"message":"Invalid option"}]',
        data: { code: "BAD_REQUEST" },
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nameInput().getAttribute("aria-invalid")).toBeNull();
    expect(state.toastDanger).toHaveBeenCalledTimes(1);
    expect(state.toastDanger.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcAddFailed",
    );
  });

  it("sends a refusal that names both the name and another field to the toast", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.({
        message:
          '[{"code":"custom","path":["name"],"message":"Invalid"},{"code":"invalid_value","path":["seoType"],"message":"Invalid option"}]',
        data: { code: "BAD_REQUEST" },
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.toastDanger).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["text that is not JSON", "Unexpected token in request body"],
    ["an empty issue list", "[]"],
    ["JSON that is not an issue list", '{"name":"bad"}'],
  ])("sends a BAD_REQUEST whose message is %s to the toast", (_label, message) => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.({
        message,
        data: { code: "BAD_REQUEST" },
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.toastDanger).toHaveBeenCalledTimes(1);
    expect(state.toastDanger.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcAddFailed",
    );
  });

  it("answers a missing second factor with the enrolment prompt alone", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.({
        message: "SECOND_FACTOR_REQUIRED",
        data: { code: "FORBIDDEN", appCode: "SECOND_FACTOR_REQUIRED" },
      });
      state.createOptions?.onSettled?.();
    });

    expect(state.toastWarning).toHaveBeenCalledTimes(1);
    const prompt = state.toastWarning.mock.calls[0]?.[0];
    expect(prompt?.title).toBe("moderation.secondFactorRequiredToast");
    prompt?.action?.onPress?.();
    expect(state.routerPush).toHaveBeenCalledTimes(1);
    expect(String(state.routerPush.mock.calls[0]?.[0])).toMatch(
      /^\/enroll-2fa\?/,
    );
    // Neither of the page's own answers.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.toastDanger).not.toHaveBeenCalled();
    expect(nameInput().value).toBe("Jazz");
  });

  it("sends any other refusal to a danger toast", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.(new Error("STAFF_ONLY"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.toastDanger).toHaveBeenCalledTimes(1);
    expect(state.toastDanger.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcAddFailed",
    );
    expect(nameInput().value).toBe("Jazz");
    expect(state.toastWarning).not.toHaveBeenCalled();
  });

  it("on success clears the form, refocuses the name, toasts, and refreshes both lists", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.change(screen.getByTestId("category-create-seo-type"), {
      target: { value: "MusicEvent" },
    });
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onSuccess?.({
        category: { name: "Jazz", slug: "jazz" },
        resolvedRequestCount: 1,
      });
      state.createOptions?.onSettled?.();
    });

    expect(nameInput().value).toBe("");
    expect(
      (screen.getByTestId("category-create-seo-type") as HTMLSelectElement)
        .value,
    ).toBe("Event");
    expect(document.activeElement).toBe(nameInput());
    expect(state.invalidateList).toHaveBeenCalledTimes(1);
    expect(state.invalidateListAll).toHaveBeenCalledTimes(1);
    expect(state.invalidateRequests).toHaveBeenCalledTimes(1);
    const toast = state.toastSuccess.mock.calls[0]?.[0];
    expect(toast?.title).toBe("admin.pcAddedToast");
    expect(toast?.message).toBe(
      'admin.pcAddedToastMessageWithRequests {"name":"Jazz","slug":"jazz","count":1}',
    );
  });

  it("leaves the request line out of the toast when no request matched", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onSuccess?.({
        category: { name: "Jazz", slug: "jazz" },
        resolvedRequestCount: 0,
      });
    });
    expect(state.toastSuccess.mock.calls[0]?.[0]?.message).toBe(
      'admin.pcAddedToastMessage {"name":"Jazz","slug":"jazz"}',
    );
  });
});

const MUSIC = {
  id: "c1",
  slug: "music",
  name: "Music",
  seoType: "MusicEvent",
  active: true,
  sortOrder: 1,
};
const COMEDY = {
  id: "c2",
  slug: "comedy",
  name: "Comedy",
  seoType: "ComedyEvent",
  active: true,
  sortOrder: 2,
};
const RETIRED = {
  id: "c3",
  slug: "retired",
  name: "Retired",
  seoType: "Event",
  active: false,
  sortOrder: 3,
};

const tile = (slug: string) => screen.getByTestId(`category-tile-${slug}`);
const button = (testId: string) =>
  screen.getByTestId(testId) as HTMLButtonElement;
const isInert = (element: HTMLElement) =>
  element.getAttribute("aria-disabled") === "true";
const renameInput = (slug: string) =>
  screen.getByTestId(`category-rename-input-${slug}`) as HTMLInputElement;

function openRename(slug: string) {
  fireEvent.click(button(`category-rename-${slug}`));
  return renameInput(slug);
}

const OPENER_PREFIXES = [
  "category-rename-",
  "category-active-toggle-",
  "category-delete-",
] as const;

/** Every tile's Rename, Deactivate / Reactivate and Delete that is on screen. */
const openers = () =>
  OPENER_PREFIXES.flatMap((prefix) =>
    Array.from(
      document.querySelectorAll<HTMLElement>(`button[data-testid^="${prefix}"]`),
    ),
  ).filter((element) => {
    const id = element.getAttribute("data-testid") ?? "";
    return !/-(save|cancel|confirm|input|form)-/.test(id);
  });

const moveButtons = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      'button[data-testid^="category-move-"]',
    ),
  );

/** What a browser does to focus when the focused node leaves the document. */
function dropFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
  expect(document.activeElement).toBe(document.body);
}

describe("movedCategoryIds", () => {
  const ids = ["c1", "c2", "c3"];

  it("moves one id a place up or down and keeps every other id", () => {
    expect(movedCategoryIds(ids, "c3", "up")).toEqual(["c1", "c3", "c2"]);
    expect(movedCategoryIds(ids, "c1", "down")).toEqual(["c2", "c1", "c3"]);
    // The caller's list is left as it was.
    expect(ids).toEqual(["c1", "c2", "c3"]);
  });

  it("has nowhere to move the first id up, the last id down, or an unknown id", () => {
    expect(movedCategoryIds(ids, "c1", "up")).toBeNull();
    expect(movedCategoryIds(ids, "c3", "down")).toBeNull();
    expect(movedCategoryIds(ids, "gone", "up")).toBeNull();
    expect(movedCategoryIds(ids, "gone", "down")).toBeNull();
    expect(movedCategoryIds(["only"], "only", "up")).toBeNull();
    expect(movedCategoryIds(["only"], "only", "down")).toBeNull();
  });
});

describe("platform categories: lifecycle controls", () => {
  beforeEach(() => {
    resetState();
    state.roles = ["ADMIN"];
    state.categories = [MUSIC, COMEDY, RETIRED];
    state.invalidateList.mockReset();
    state.invalidateRequests.mockReset();
    state.toastSuccess.mockReset();
    state.toastDanger.mockReset();
    state.toastWarning.mockReset();
    state.routerPush.mockReset();
  });

  it("shows an inactive category, with its own badge", () => {
    render(<PlatformCategoriesPage />);
    expect(within(tile("retired")).queryByText("admin.pcInactive")).not.toBeNull();
    expect(within(tile("retired")).queryByText("admin.pcActive")).toBeNull();
    expect(within(tile("music")).queryByText("admin.pcActive")).not.toBeNull();
  });

  it("shows a REVIEWER every category and none of the controls", () => {
    state.roles = ["REVIEWER"];
    render(<PlatformCategoriesPage />);
    expect(screen.queryByTestId("category-tile-retired")).not.toBeNull();
    expect(screen.queryByTestId("category-tile-music")).not.toBeNull();
    for (const prefix of [
      "category-rename-",
      "category-active-toggle-",
      "category-move-up-",
      "category-move-down-",
      "category-delete-",
      "category-seo-type-",
    ]) {
      expect(document.querySelector(`[data-testid^="${prefix}"]`)).toBeNull();
    }
  });

  it("shows no control and no form while the roles are still loading", () => {
    state.rolesLoading = true;
    render(<PlatformCategoriesPage />);
    expect(screen.queryByTestId("category-tile-music")).not.toBeNull();
    expect(screen.queryByTestId("category-create-form")).toBeNull();
    expect(openers()).toHaveLength(0);
    expect(moveButtons()).toHaveLength(0);
    expect(
      document.querySelector('[data-testid^="category-seo-type-"]'),
    ).toBeNull();
  });

  it("labels a tile's select with the form's wording, so its name contains its label", () => {
    render(<PlatformCategoriesPage />);
    expect(
      within(tile("music")).queryByText("admin.pcAddSeoTypeLabel"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("category-seo-type-music").getAttribute("aria-label"),
    ).toBe('admin.pcSeoTypeFor {"name":"Music"}');
  });

  it("gives every control on two tiles its own accessible name", () => {
    render(<PlatformCategoriesPage />);
    const names = [tile("music"), tile("comedy")].flatMap((element) =>
      Array.from(element.querySelectorAll("button, select")).map((control) =>
        control.getAttribute("aria-label"),
      ),
    );
    // Rename, toggle, up, down, delete, Change URL and the two selects
    // (language, SEO type), per tile.
    expect(names).toHaveLength(16);
    expect(names.every((name) => name !== null)).toBe(true);
    expect(new Set(names).size).toBe(16);
    expect(names).toContain(
      'admin.pcChangeUrlNamed {"language":"admin.pcLanguageEn","name":"Music"}',
    );
    for (const key of [
      "pcLanguageFor",
      "pcEditNamesNamed",
      "pcDeactivateNamed",
      "pcMoveUpNamed",
      "pcMoveDownNamed",
      "pcDeleteNamed",
    ]) {
      expect(names).toContain(`admin.${key} {"name":"Music"}`);
      expect(names).toContain(`admin.${key} {"name":"Comedy"}`);
    }
    expect(
      button("category-active-toggle-retired").getAttribute("aria-label"),
    ).toBe('admin.pcReactivateNamed {"name":"Retired"}');
  });

  it("renames: focus into the field, trimmed name sent, both lists refreshed, focus back", () => {
    render(<PlatformCategoriesPage />);
    const input = openRename("music");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Music");
    // The URL is said to stay, and the field points at that note.
    const note = within(tile("music")).getByText(
      'admin.pcRenameSlugNote {"slug":"/events/category/music"}',
    );
    expect(input.getAttribute("aria-describedby")).toBe(note.id);
    // The title's other controls step aside while it is being edited.
    expect(screen.queryByTestId("category-rename-music")).toBeNull();
    expect(screen.queryByTestId("category-move-up-music")).toBeNull();

    fireEvent.change(input, { target: { value: "  Live   Music " } });
    fireEvent.click(button("category-rename-save-music"));
    expect(state.rename.mutate).toHaveBeenCalledTimes(1);
    expect(state.rename.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      name: "Live Music",
    });

    act(() => {
      state.rename.options?.onSuccess?.(
        { category: { ...MUSIC, name: "Live Music" } },
        { categoryId: "c1", name: "Live Music" },
      );
      state.rename.options?.onSettled?.();
    });
    expect(state.invalidateList).toHaveBeenCalledTimes(1);
    expect(state.invalidateListAll).toHaveBeenCalledTimes(1);
    expect(state.toastSuccess.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcRenamedToast",
    );
    expect(screen.queryByTestId("category-rename-input-music")).toBeNull();
    expect(document.activeElement).toBe(button("category-rename-music"));
  });

  it("saves once on Enter (form submit), dropping a repeat before the reply", () => {
    render(<PlatformCategoriesPage />);
    const input = openRename("music");
    fireEvent.change(input, { target: { value: "Jazz" } });
    const form = screen.getByTestId("category-rename-form-music");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(state.rename.mutate).toHaveBeenCalledTimes(1);
  });

  it("cancels a rename on Escape without a call, and returns focus", () => {
    render(<PlatformCategoriesPage />);
    const input = openRename("music");
    fireEvent.change(input, { target: { value: "Jazz" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(state.rename.mutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("category-rename-input-music")).toBeNull();
    expect(document.activeElement).toBe(button("category-rename-music"));
    // The draft is gone: reopening starts from the stored name.
    expect(openRename("music").value).toBe("Music");
  });

  it("closes without a call when the name is unchanged", () => {
    render(<PlatformCategoriesPage />);
    const input = openRename("music");
    fireEvent.change(input, { target: { value: " Music " } });
    fireEvent.click(button("category-rename-save-music"));
    expect(state.rename.mutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("category-rename-input-music")).toBeNull();
  });

  it("keeps one tile in rename mode at a time", () => {
    render(<PlatformCategoriesPage />);
    openRename("music");
    const second = openRename("comedy");
    expect(screen.queryByTestId("category-rename-input-music")).toBeNull();
    expect(second.value).toBe("Comedy");
    expect(document.activeElement).toBe(second);
  });

  it("holds the name read-only and ignores Escape while its rename is out", () => {
    const view = render(<PlatformCategoriesPage />);
    const input = openRename("music");
    fireEvent.change(input, { target: { value: "Jazz" } });
    expect(input.readOnly).toBe(false);

    state.rename.pending = true;
    state.rename.variables = { categoryId: "c1", name: "Jazz" };
    view.rerender(<PlatformCategoriesPage />);
    expect(renameInput("music").readOnly).toBe(true);
    expect(renameInput("music").disabled).toBe(false);
    expect(isInert(button("category-rename-save-music"))).toBe(true);
    expect(isInert(button("category-rename-cancel-music"))).toBe(true);
    fireEvent.keyDown(renameInput("music"), { key: "Escape" });
    expect(screen.queryByTestId("category-rename-input-music")).not.toBeNull();
    expect(renameInput("music").value).toBe("Jazz");

    // Settled: Escape closes it again.
    state.rename.pending = false;
    state.rename.variables = undefined;
    view.rerender(<PlatformCategoriesPage />);
    fireEvent.keyDown(renameInput("music"), { key: "Escape" });
    expect(screen.queryByTestId("category-rename-input-music")).toBeNull();
  });

  it.each([
    ["rename", () => state.rename],
    ["setActive", () => state.setActive],
    ["delete", () => state.remove],
  ] as const)(
    "makes every tile's Rename, Deactivate / Reactivate and Delete inert while a %s is out",
    (_name, slot) => {
      const view = render(<PlatformCategoriesPage />);
      // Three tiles, three openers each, all live when nothing is out.
      expect(openers()).toHaveLength(9);
      expect(openers().filter(isInert)).toHaveLength(0);

      slot().pending = true;
      slot().variables = { categoryId: "c1" };
      view.rerender(<PlatformCategoriesPage />);
      expect(openers()).toHaveLength(9);
      expect(openers().filter(isInert)).toHaveLength(9);
      for (const opener of openers()) {
        expect(opener.getAttribute("tabindex")).toBe("-1");
      }
      // Moving is its own request and stays available.
      expect(isInert(button("category-move-down-music"))).toBe(false);

      slot().pending = false;
      slot().variables = undefined;
      view.rerender(<PlatformCategoriesPage />);
      expect(openers().filter(isInert)).toHaveLength(0);
    },
  );

  it("leaves the openers live while a reorder or an SEO-type change is out", () => {
    const view = render(<PlatformCategoriesPage />);
    state.reorder.pending = true;
    state.setSeoType.pending = true;
    state.setSeoType.variables = { categoryId: "c1" };
    view.rerender(<PlatformCategoriesPage />);
    expect(openers().filter(isInert)).toHaveLength(0);
  });

  it("makes every move button inert while a reorder is out", () => {
    const view = render(<PlatformCategoriesPage />);
    expect(moveButtons()).toHaveLength(6);
    // At rest only the two edge buttons are inert.
    expect(moveButtons().filter(isInert)).toHaveLength(2);

    state.reorder.pending = true;
    view.rerender(<PlatformCategoriesPage />);
    expect(moveButtons()).toHaveLength(6);
    expect(moveButtons().filter(isInert)).toHaveLength(6);
  });

  it("sends a rename refusal to a toast when its editor has closed before the reply", () => {
    render(<PlatformCategoriesPage />);
    const input = openRename("comedy");
    fireEvent.change(input, { target: { value: "music" } });
    fireEvent.click(button("category-rename-save-comedy"));
    expect(state.rename.mutate).toHaveBeenCalledTimes(1);
    // Another tile's confirm takes the page's one open slot.
    fireEvent.click(button("category-delete-music"));
    expect(screen.queryByTestId("category-rename-input-comedy")).toBeNull();

    act(() => {
      state.rename.options?.onError?.(appError("CATEGORY_ALREADY_EXISTS"), {
        categoryId: "c2",
        name: "music",
      });
      state.rename.options?.onSettled?.();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.toastDanger).toHaveBeenCalledTimes(1);
    expect(state.toastDanger.mock.calls[0]?.[0]).toEqual({
      title: "admin.pcRenameFailed",
      message: "admin.pcAddErrorExists",
    });
    // The confirm that was opened meanwhile is still there.
    expect(
      screen.queryByTestId("category-delete-confirm-music"),
    ).not.toBeNull();
  });

  it("never shows one tile's rename refusal under another tile's field", () => {
    render(<PlatformCategoriesPage />);
    const comedy = openRename("comedy");
    fireEvent.change(comedy, { target: { value: "music" } });
    fireEvent.click(button("category-rename-save-comedy"));
    // The reader moves on to Music's editor before Comedy's reply.
    const music = openRename("music");
    fireEvent.change(music, { target: { value: "Live Music" } });

    act(() => {
      state.rename.options?.onError?.(appError("CATEGORY_ALREADY_EXISTS"), {
        categoryId: "c2",
        name: "music",
      });
      state.rename.options?.onSettled?.();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(renameInput("music").getAttribute("aria-invalid")).toBeNull();
    expect(renameInput("music").value).toBe("Live Music");
    expect(state.toastDanger).toHaveBeenCalledTimes(1);
    expect(state.toastDanger.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcRenameFailed",
    );
  });

  it("keeps another tile's editor and its draft when a rename succeeds", () => {
    render(<PlatformCategoriesPage />);
    const comedy = openRename("comedy");
    fireEvent.change(comedy, { target: { value: "Stand-up" } });
    fireEvent.click(button("category-rename-save-comedy"));
    const music = openRename("music");
    fireEvent.change(music, { target: { value: "Live Music" } });

    act(() => {
      state.rename.options?.onSuccess?.(
        { category: { ...COMEDY, name: "Stand-up" } },
        { categoryId: "c2", name: "Stand-up" },
      );
      state.rename.options?.onSettled?.();
    });
    expect(state.toastSuccess.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcRenamedToast",
    );
    expect(renameInput("music").value).toBe("Live Music");
    expect(document.activeElement).toBe(renameInput("music"));
  });

  it.each([
    [
      "a delete",
      () => state.remove,
      () => ({}),
      "category-delete-comedy",
      "category-delete-confirm-comedy",
    ],
    [
      "a deactivation",
      () => state.setActive,
      () => ({ category: { ...MUSIC, active: false } }),
      "category-active-toggle-comedy",
      "category-deactivate-confirm-comedy",
    ],
  ] as const)(
    "leaves another tile's confirm open when %s is answered, either way",
    (_label, slot, data, openerId, confirmId) => {
      render(<PlatformCategoriesPage />);
      fireEvent.click(button(openerId));
      expect(screen.queryByTestId(confirmId)).not.toBeNull();

      // Replies about Music (c1), while Comedy's confirm of that kind is open.
      act(() => {
        slot().options?.onSuccess?.(data(), { categoryId: "c1" });
      });
      expect(screen.queryByTestId(confirmId)).not.toBeNull();
      act(() => {
        slot().options?.onError?.(new Error("STAFF_ONLY"), {
          categoryId: "c1",
        });
      });
      expect(screen.queryByTestId(confirmId)).not.toBeNull();

      // Its own reply closes it.
      act(() => {
        slot().options?.onError?.(new Error("STAFF_ONLY"), {
          categoryId: "c2",
        });
      });
      expect(screen.queryByTestId(confirmId)).toBeNull();
    },
  );

  it("moves focus straight to the next tile's field when one editor replaces another", () => {
    render(<PlatformCategoriesPage />);
    openRename("music");
    const focused: string[] = [];
    const record = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      focused.push(target.getAttribute("data-testid") ?? target.tagName);
    };
    document.addEventListener("focusin", record);
    try {
      // The click itself does not focus in jsdom, and Music's field unmounts.
      openRename("comedy");
    } finally {
      document.removeEventListener("focusin", record);
    }
    // No stop on Music's Rename button on the way.
    expect(focused).toEqual(["category-rename-input-comedy"]);
  });

  it("renders a duplicate rename inline, keeps the draft, and clears it on edit", () => {
    render(<PlatformCategoriesPage />);
    const input = openRename("comedy");
    fireEvent.change(input, { target: { value: "music" } });
    fireEvent.click(button("category-rename-save-comedy"));
    act(() => {
      state.rename.options?.onError?.(appError("CATEGORY_ALREADY_EXISTS"), {
        categoryId: "c2",
        name: "music",
      });
      state.rename.options?.onSettled?.();
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("admin.pcAddErrorExists");
    expect(renameInput("comedy").value).toBe("music");
    expect(renameInput("comedy").getAttribute("aria-invalid")).toBe("true");
    expect(
      renameInput("comedy").getAttribute("aria-describedby")?.split(" "),
    ).toContain(alert.id);
    expect(document.activeElement).toBe(renameInput("comedy"));
    expect(state.toastDanger).not.toHaveBeenCalled();

    fireEvent.change(renameInput("comedy"), { target: { value: "musica" } });
    expect(screen.queryByRole("alert")).toBeNull();
    // Settled, so the corrected name goes out.
    fireEvent.click(button("category-rename-save-comedy"));
    expect(state.rename.mutate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the server's name rule", appError("INVALID_CATEGORY_REQUEST_NAME")],
    [
      "the input schema, over the name",
      {
        message: '[{"code":"custom","path":["name"],"message":"Invalid"}]',
        data: { code: "BAD_REQUEST" },
      },
    ],
  ])("renders a rename refused by %s inline", (_label, error) => {
    render(<PlatformCategoriesPage />);
    openRename("music");
    act(() => {
      state.rename.options?.onError?.(error, { categoryId: "c1", name: "@@" });
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "admin.pcAddErrorInvalidName",
    );
    expect(state.toastDanger).not.toHaveBeenCalled();
  });

  it("shows a one-character rename the inline error without calling the server", () => {
    render(<PlatformCategoriesPage />);
    const input = openRename("music");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.click(button("category-rename-save-music"));
    expect(state.rename.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "admin.pcAddErrorInvalidName",
    );
  });

  it("asks before deactivating, and says what deactivating does", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-active-toggle-music"));
    expect(state.setActive.mutate).not.toHaveBeenCalled();
    // The confirm opens with focus on its safe answer.
    expect(document.activeElement?.textContent).toBe("admin.pcCancel");
    expect(tile("music").contains(document.activeElement)).toBe(true);
    expect(
      within(tile("music")).queryByText(
        'admin.pcConfirmDeactivate {"name":"Music"}',
      ),
    ).not.toBeNull();
    expect(
      within(tile("music")).queryByText("admin.pcConfirmDeactivateDescription"),
    ).not.toBeNull();

    fireEvent.click(button("category-deactivate-confirm-music"));
    expect(state.setActive.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      active: false,
    });
    act(() => {
      state.setActive.options?.onSuccess?.(
        { category: { ...MUSIC, active: false } },
        { categoryId: "c1", active: false },
      );
    });
    expect(state.toastSuccess.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcDeactivatedToast",
    );
    expect(state.invalidateList).toHaveBeenCalledTimes(1);
    expect(state.invalidateListAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("category-deactivate-confirm-music")).toBeNull();
    expect(document.activeElement).toBe(button("category-active-toggle-music"));
  });

  it("cancels a deactivation without a call", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-active-toggle-music"));
    fireEvent.click(within(tile("music")).getByText("admin.pcCancel"));
    expect(state.setActive.mutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("category-deactivate-confirm-music")).toBeNull();
  });

  it("reactivates at once, with no confirm", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-active-toggle-retired"));
    expect(state.setActive.mutate).toHaveBeenCalledTimes(1);
    expect(state.setActive.mutate).toHaveBeenCalledWith({
      categoryId: "c3",
      active: true,
    });
    act(() => {
      state.setActive.options?.onSuccess?.(
        { category: { ...RETIRED, active: true } },
        { categoryId: "c3", active: true },
      );
    });
    expect(state.toastSuccess.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcReactivatedToast",
    );
  });

  it("moves a tile up by sending every id, inactive ones included, in the new order", () => {
    render(<PlatformCategoriesPage />);
    button("category-move-up-retired").focus();
    fireEvent.click(button("category-move-up-retired"));
    // The browser drops focus when the tile's node is re-inserted.
    dropFocus();
    expect(state.reorder.mutate).toHaveBeenCalledTimes(1);
    expect(state.reorder.mutate).toHaveBeenCalledWith({
      orderedCategoryIds: ["c1", "c3", "c2"],
    });

    act(() => {
      state.reorder.options?.onSuccess?.(
        { categories: [MUSIC, RETIRED, COMEDY] },
        { orderedCategoryIds: ["c1", "c3", "c2"] },
      );
    });
    const tiles = Array.from(
      document.querySelectorAll('[data-testid^="category-tile-"]'),
    )
      .map((element) => element.getAttribute("data-testid"))
      .filter((id) => id !== "category-tile-grid");
    expect(tiles).toEqual([
      "category-tile-music",
      "category-tile-retired",
      "category-tile-comedy",
    ]);
    // Focus is back on the button that was pressed, and the result is
    // announced.
    expect(document.activeElement).toBe(button("category-move-up-retired"));
    expect(screen.getByRole("status").textContent).toBe(
      'admin.pcMovedAnnouncement {"name":"Retired","position":2,"total":3}',
    );
    expect(state.invalidateList).toHaveBeenCalledTimes(1);
    expect(state.invalidateListAll).toHaveBeenCalledTimes(1);
  });

  it("leaves focus where the reader put it while the move was out", () => {
    render(<PlatformCategoriesPage />);
    button("category-move-up-retired").focus();
    fireEvent.click(button("category-move-up-retired"));
    const elsewhere = screen.getByTestId("category-create-name");
    elsewhere.focus();
    act(() => {
      state.reorder.options?.onSuccess?.(
        { categories: [MUSIC, RETIRED, COMEDY] },
        { orderedCategoryIds: ["c1", "c3", "c2"] },
      );
    });
    expect(document.activeElement).toBe(elsewhere);
  });

  it.each([
    ["dropped", true],
    ["still on the pressed button", false],
  ] as const)(
    "puts focus on the tile's other move button when a move ends at the edge (focus %s)",
    (_label, dropped) => {
      render(<PlatformCategoriesPage />);
      button("category-move-up-comedy").focus();
      fireEvent.click(button("category-move-up-comedy"));
      if (dropped) dropFocus();
      act(() => {
        state.reorder.options?.onSuccess?.(
          { categories: [COMEDY, MUSIC, RETIRED] },
          { orderedCategoryIds: ["c2", "c1", "c3"] },
        );
      });
      // Comedy is first now: its "up" is inert and out of the Tab order.
      expect(isInert(button("category-move-up-comedy"))).toBe(true);
      expect(document.activeElement).toBe(button("category-move-down-comedy"));
    },
  );

  it("moves a tile down past an inactive one", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-move-down-comedy"));
    expect(state.reorder.mutate).toHaveBeenCalledWith({
      orderedCategoryIds: ["c1", "c3", "c2"],
    });
  });

  it("makes the first tile's up and the last tile's down inert", () => {
    render(<PlatformCategoriesPage />);
    expect(isInert(button("category-move-up-music"))).toBe(true);
    expect(isInert(button("category-move-down-music"))).toBe(false);
    expect(isInert(button("category-move-up-retired"))).toBe(false);
    expect(isInert(button("category-move-down-retired"))).toBe(true);
    // Out of the Tab order too. What a press at the edge would compute is
    // `movedCategoryIds`' own test: an inert stand-in has no press to send.
    expect(button("category-move-up-music").getAttribute("tabindex")).toBe("-1");
    expect(
      button("category-move-down-retired").getAttribute("tabindex"),
    ).toBe("-1");
    expect(
      button("category-move-down-music").getAttribute("tabindex"),
    ).toBeNull();
  });

  it.each(["INVALID_INPUT", "CATEGORY_NOT_FOUND"])(
    "reloads the list and says so once when a move is refused with %s",
    (code) => {
      render(<PlatformCategoriesPage />);
      fireEvent.click(button("category-move-up-comedy"));
      act(() => {
        state.reorder.options?.onError?.(appError(code), {
          orderedCategoryIds: ["c2", "c1", "c3"],
        });
      });
      expect(state.refetchListAll).toHaveBeenCalledTimes(1);
      expect(state.toastWarning).toHaveBeenCalledTimes(1);
      expect(state.toastWarning.mock.calls[0]?.[0]?.title).toBe(
        "admin.pcListChangedToast",
      );
      expect(state.toastDanger).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["rename", () => state.rename],
    ["setActive", () => state.setActive],
    ["setSeoType", () => state.setSeoType],
    ["delete", () => state.remove],
  ] as const)(
    "%s: reloads the list and says so once when the category is already gone",
    (_name, slot) => {
      render(<PlatformCategoriesPage />);
      act(() => {
        slot().options?.onError?.(appError("CATEGORY_NOT_FOUND"), {
          categoryId: "c1",
        });
      });
      expect(state.refetchListAll).toHaveBeenCalledTimes(1);
      expect(state.invalidateList).toHaveBeenCalledTimes(1);
      expect(state.toastWarning).toHaveBeenCalledTimes(1);
      expect(state.toastWarning.mock.calls[0]?.[0]?.title).toBe(
        "admin.pcListChangedToast",
      );
      expect(state.toastDanger).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["rename", state.rename, "admin.pcRenameFailed"],
    ["setActive", state.setActive, "admin.pcSetActiveFailed"],
    ["reorder", state.reorder, "admin.pcMoveFailed"],
    ["reviewRequest", state.reviewRequest, "admin.pcReviewFailed"],
    ["setSeoType", state.setSeoType, "Failed to update SEO type"],
    ["delete", state.remove, "admin.pcDeleteFailed"],
  ] as const)(
    "%s: a missing second factor gets the enrolment prompt alone, anything else one toast, and the global toast is off",
    (_name, slot, failureTitle) => {
      render(<PlatformCategoriesPage />);
      expect(slot.options?.meta).toEqual({ silent: true });
      // Music's editor is open, so an inline message has a place to appear:
      // the "no alert" lines below can fail.
      openRename("music");

      act(() => {
        slot.options?.onError?.(SECOND_FACTOR_ERROR, { categoryId: "c1" });
      });
      expect(state.toastWarning).toHaveBeenCalledTimes(1);
      expect(state.toastWarning.mock.calls[0]?.[0]?.title).toBe(
        "moderation.secondFactorRequiredToast",
      );
      expect(state.toastDanger).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();

      act(() => {
        slot.options?.onError?.(new Error("STAFF_ONLY"), { categoryId: "c1" });
      });
      expect(state.toastWarning).toHaveBeenCalledTimes(1);
      expect(state.toastDanger).toHaveBeenCalledTimes(1);
      expect(state.toastDanger.mock.calls[0]?.[0]?.title).toBe(failureTitle);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("category-rename-input-music")).not.toBeNull();
    },
  );

  it.each([
    ["the tile that took its place", [MUSIC, RETIRED], "category-move-up-retired"],
    ["the last tile, when it was the last", [MUSIC, COMEDY], "category-move-up-comedy"],
  ] as const)(
    "after a delete, puts focus on the first live control of %s",
    (_label, remaining, expectedTestId) => {
      const deleted = remaining.some((category) => category.id === "c2")
        ? RETIRED
        : COMEDY;
      const view = render(<PlatformCategoriesPage />);
      fireEvent.click(button(`category-delete-${deleted.slug}`));
      fireEvent.click(button(`category-delete-confirm-${deleted.slug}`));
      act(() => {
        state.remove.options?.onSuccess?.({}, { categoryId: deleted.id });
      });
      // The refetch lands: the tile, and the focus it held, are gone.
      state.categories = [...remaining];
      dropFocus();
      view.rerender(<PlatformCategoriesPage />);
      expect(document.activeElement).toBe(button(expectedTestId));
    },
  );

  it("after deleting the only category, puts focus on the Add form's name", () => {
    state.categories = [MUSIC];
    const view = render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-delete-music"));
    fireEvent.click(button("category-delete-confirm-music"));
    act(() => {
      state.remove.options?.onSuccess?.({}, { categoryId: "c1" });
    });
    state.categories = [];
    dropFocus();
    view.rerender(<PlatformCategoriesPage />);
    expect(document.activeElement).toBe(
      screen.getByTestId("category-create-name"),
    );
  });

  it("after a delete, leaves focus alone when the reader has moved it", () => {
    const view = render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-delete-comedy"));
    fireEvent.click(button("category-delete-confirm-comedy"));
    act(() => {
      state.remove.options?.onSuccess?.({}, { categoryId: "c2" });
    });
    const elsewhere = screen.getByTestId("category-create-name");
    elsewhere.focus();
    state.categories = [MUSIC, RETIRED];
    view.rerender(<PlatformCategoriesPage />);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("asks before deleting, then sends the id and refreshes both lists", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-delete-music"));
    expect(state.remove.mutate).not.toHaveBeenCalled();
    fireEvent.click(button("category-delete-confirm-music"));
    expect(state.remove.mutate).toHaveBeenCalledWith({ categoryId: "c1" });
    act(() => {
      state.remove.options?.onSuccess?.({}, { categoryId: "c1" });
    });
    expect(state.invalidateList).toHaveBeenCalledTimes(1);
    expect(state.invalidateListAll).toHaveBeenCalledTimes(1);
  });
});

// ── Names in more than one language (category-translations FR-004–FR-007) ──

type SuggestCall = [
  { text: string; sourceLocale: string; targetLocales: string[] },
  { onSuccess?: (data: unknown) => void; onError?: (error: unknown) => void },
];

/** Play the server's answer to the latest suggestion request. */
function answerSuggestion(suggestions: Record<string, string>) {
  const calls = state.suggestTranslations.mutate.mock.calls as SuggestCall[];
  const last = calls[calls.length - 1];
  if (!last) throw new Error("no suggestion was asked for");
  act(() => {
    last[1].onSuccess?.({ suggestions });
  });
}

describe("platform categories: Spanish names", () => {
  beforeEach(() => {
    resetState();
    state.roles = ["ADMIN"];
    state.categories = [];
    state.requests = [];
    state.createOptions = null;
    state.createPending = false;
    state.createMutate.mockReset();
    state.toastSuccess.mockReset();
    state.toastDanger.mockReset();
  });

  const spanishInput = () =>
    screen.getByTestId("category-create-name-es") as HTMLInputElement;

  it("labels the Add form's Spanish field and keeps the Translate link out until there is English", () => {
    render(<PlatformCategoriesPage />);
    // English first: the Spanish field waits behind the language selector.
    expect(screen.queryByTestId("category-create-name-es")).toBeNull();
    expect(languageOptions("category-create-language")).toEqual([
      "English",
      "Español",
    ]);
    showCreateLanguage("es");
    expect(screen.queryByTestId("category-create-name")).toBeNull();
    expect(
      document.querySelector(`label[for="${spanishInput().id}"]`)?.textContent,
    ).toBe("admin.pcNameEsLabel");
    expect(screen.queryByTestId("category-create-name-es-translate")).toBeNull();
    // In its place an inert label holds the row's shape: no href, no tab
    // stop, hidden from assistive tech.
    const inert = screen.getByTestId("category-create-name-es-translate-inert");
    expect(inert.tagName).toBe("SPAN");
    expect(inert.getAttribute("aria-hidden")).toBe("true");
    expect(inert.hasAttribute("href")).toBe(false);
    showCreateLanguage("en");
    typeName("Jazz");
    showCreateLanguage("es");
    expect(
      screen.queryByTestId("category-create-name-es-translate-inert"),
    ).toBeNull();
    expect(
      screen.queryByTestId("category-create-name-es-translate"),
    ).not.toBeNull();
  });

  it("prefills the Spanish name when the English one is left, marked as a suggestion", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    fireEvent.blur(nameInput());
    expect(state.suggestTranslations.mutate).toHaveBeenCalledTimes(1);
    expect(state.suggestTranslations.mutate.mock.calls[0]?.[0]).toEqual({
      text: "Live Jazz",
      sourceLocale: "en",
      targetLocales: ["es"],
    });
    // Its failures are answered by a blank field, never the global toast.
    expect(state.suggestTranslations.options?.meta).toEqual({ silent: true });

    answerSuggestion({ es: "Jazz en vivo" });
    // A suggestion behind the selector is never silent: a line under it says
    // so, and the selector's options stay plain language names.
    expect(languageOptions("category-create-language")).toEqual([
      "English",
      "Español",
    ]);
    expect(
      screen.getByTestId("category-create-suggestion-notice-es").textContent,
    ).toBe('admin.pcSuggestionToReview {"language":"Español"}');
    showCreateLanguage("es");
    expect(spanishInput().value).toBe("Jazz en vivo");
    const marker = screen.getByTestId("category-create-name-es-suggested");
    expect(marker.textContent).toBe("admin.pcSuggested");
    expect(spanishInput().getAttribute("aria-describedby")).toContain(
      marker.id,
    );

    const link = screen.getByTestId(
      "category-create-name-es-translate",
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "https://translate.google.com/?sl=en&tl=es&text=Live%20Jazz",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("aria-label")).toBe(
      'admin.pcTranslateTo {"language":"admin.pcLanguageEs"}',
    );
  });

  it("drops the marker once the suggestion is edited, and sends the edited name", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({ es: "Jazz en vivo" });

    showCreateLanguage("es");
    fireEvent.change(spanishInput(), { target: { value: "Jazz  en directo " } });
    expect(
      screen.queryByTestId("category-create-name-es-suggested"),
    ).toBeNull();

    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Live Jazz",
      seoType: "Event",
      translations: { es: "Jazz en directo" },
    });
  });

  it("leaves an unseen Spanish suggestion out of the new category, and names it under the selector", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({ es: "Jazz en vivo" });
    const notice = screen.getByTestId("category-create-suggestion-notice-es");
    expect(notice.tagName).toBe("BUTTON");
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledTimes(1);
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Live Jazz",
      seoType: "Event",
    });
  });

  it("sends the Spanish suggestion once its field has been shown", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({ es: "Jazz en vivo" });
    // The notice brings Spanish forward, focused, and goes once it is seen.
    fireEvent.click(
      screen.getByTestId("category-create-suggestion-notice-es"),
    );
    expect(document.activeElement).toBe(spanishInput());
    expect(
      screen.queryByTestId("category-create-suggestion-notice-es"),
    ).toBeNull();
    // Seen is enough: back on English, it is still sent.
    showCreateLanguage("en");
    expect(
      screen.queryByTestId("category-create-suggestion-notice-es"),
    ).toBeNull();
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Live Jazz",
      seoType: "Event",
      translations: { es: "Jazz en vivo" },
    });
  });

  it("leaves out a seen suggestion once the English name has changed, before the new one lands", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({ es: "Jazz" });
    showCreateLanguage("es");
    showCreateLanguage("en");
    typeName("Jazz Fusion");
    // No notice while typing: the check is the submit's.
    expect(
      screen.queryByTestId("category-create-suggestion-notice-es"),
    ).toBeNull();
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Jazz Fusion",
      seoType: "Event",
    });
  });

  it("keeps a Spanish name typed over a suggestion when the English name changes", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({ es: "Jazz" });
    showCreateLanguage("es");
    fireEvent.change(spanishInput(), { target: { value: "Jazz fusión" } });
    showCreateLanguage("en");
    typeName("Jazz Fusion");
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Jazz Fusion",
      seoType: "Event",
      translations: { es: "Jazz fusión" },
    });
  });

  it("sends a Spanish name typed out the same as the old suggestion after the English changes", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({ es: "Jazz" });
    showCreateLanguage("es");
    fireEvent.change(spanishInput(), { target: { value: "Jaz" } });
    fireEvent.change(spanishInput(), { target: { value: "Jazz" } });
    showCreateLanguage("en");
    typeName("Jazz Fusion");
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Jazz Fusion",
      seoType: "Event",
      translations: { es: "Jazz" },
    });
  });

  it("names a newer suggestion again when it lands while Spanish is hidden", () => {
    render(<PlatformCategoriesPage />);
    typeName("Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({ es: "Jazz" });
    showCreateLanguage("es");
    showCreateLanguage("en");
    typeName("Live Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({ es: "Jazz en vivo" });
    expect(
      screen.queryByTestId("category-create-suggestion-notice-es"),
    ).not.toBeNull();
    fireEvent.click(submitButton());
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Live Jazz",
      seoType: "Event",
    });
  });

  it("shows and focuses a refused English name again on a second Save from Spanish", () => {
    render(<PlatformCategoriesPage />);
    typeName("a");
    fireEvent.click(submitButton());
    expect(screen.getByRole("alert").textContent).toBe(
      "admin.pcAddErrorInvalidName",
    );
    showCreateLanguage("es");
    expect(screen.queryByTestId("category-create-name")).toBeNull();
    fireEvent.click(submitButton());
    expect(state.createMutate).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId("category-create-language") as HTMLSelectElement)
        .value,
    ).toBe("en");
    expect(document.activeElement).toBe(nameInput());
    expect(screen.getByRole("alert").textContent).toBe(
      "admin.pcAddErrorInvalidName",
    );
  });

  it("shows and focuses a refused Spanish name again on a second Save from English", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    showCreateLanguage("es");
    fireEvent.change(spanishInput(), { target: { value: "@jazz" } });
    fireEvent.click(submitButton());
    expect(screen.queryByText("admin.pcTranslationErrorInvalid")).not.toBeNull();
    showCreateLanguage("en");
    fireEvent.click(submitButton());
    expect(state.createMutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(spanishInput());
    expect(spanishInput().getAttribute("aria-invalid")).toBe("true");
  });

  it("never overwrites a Spanish name someone typed, and keeps it across a language switch", () => {
    render(<PlatformCategoriesPage />);
    showCreateLanguage("es");
    fireEvent.change(spanishInput(), { target: { value: "Mi nombre" } });
    showCreateLanguage("en");
    typeName("Live Jazz");
    fireEvent.blur(nameInput());
    expect(state.suggestTranslations.mutate).not.toHaveBeenCalled();
    showCreateLanguage("es");
    expect(spanishInput().value).toBe("Mi nombre");
    showCreateLanguage("en");
    expect(nameInput().value).toBe("Live Jazz");
  });

  it("leaves the field blank and quiet when no suggestion comes back", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    fireEvent.blur(nameInput());
    answerSuggestion({});
    showCreateLanguage("es");
    expect(spanishInput().value).toBe("");
    expect(state.toastDanger).not.toHaveBeenCalled();
  });

  it("puts a duplicate Spanish name under the Spanish field, bringing Spanish forward", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    showCreateLanguage("es");
    fireEvent.change(spanishInput(), { target: { value: "Música" } });
    // Back on English when the refusal lands.
    showCreateLanguage("en");
    fireEvent.click(submitButton());
    act(() => {
      state.createOptions?.onError?.({
        message: "CATEGORY_ALREADY_EXISTS",
        data: {
          appCode: "CATEGORY_ALREADY_EXISTS",
          meta: { field: "nameTranslations", locale: "es" },
        },
      });
    });
    expect(
      screen.queryByText(
        'admin.pcTranslationErrorExists {"language":"admin.pcLanguageEs"}',
      ),
    ).not.toBeNull();
    expect(screen.queryByText("admin.pcAddErrorExists")).toBeNull();
    expect(spanishInput().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(spanishInput());
  });

  it("shows a tile's Spanish name, or that it has none", () => {
    state.categories = [
      { ...MUSIC, names: { en: "Music", es: "Música" } },
      { ...COMEDY, names: { en: "Comedy" } },
    ];
    render(<PlatformCategoriesPage />);
    // English by default.
    expect(screen.getByTestId("category-name-en-music").textContent).toBe(
      "Music",
    );
    expect(screen.queryByTestId("category-name-es-music")).toBeNull();
    showTileLanguage("music", "es");
    showTileLanguage("comedy", "es");
    expect(screen.getByTestId("category-name-es-music").textContent).toBe(
      "Música",
    );
    expect(screen.getByTestId("category-name-es-comedy").textContent).toBe(
      "admin.pcNameMissing",
    );
  });

  it("saves only the Spanish name when the English one is unchanged", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music", es: "Música" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    showTileLanguage("music", "es");
    const spanish = screen.getByTestId(
      "category-rename-es-music",
    ) as HTMLInputElement;
    // The stored name is shown, and no suggestion is asked for it.
    expect(spanish.value).toBe("Música");
    fireEvent.change(spanish, { target: { value: "Música en vivo" } });
    fireEvent.click(button("category-rename-save-music"));
    expect(state.rename.mutate).not.toHaveBeenCalled();
    expect(state.setTranslations.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      translations: { es: "Música en vivo" },
    });
    act(() => {
      state.setTranslations.options?.onSuccess?.(
        { category: { ...MUSIC } },
        { categoryId: "c1", translations: { es: "Música en vivo" } },
      );
    });
    expect(state.toastSuccess.mock.calls[0]?.[0]?.title).toBe(
      "admin.pcNamesSavedToast",
    );
    expect(screen.queryByTestId("category-rename-input-music")).toBeNull();
  });

  it("clears a stored Spanish name with null", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music", es: "Música" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    showTileLanguage("music", "es");
    fireEvent.change(screen.getByTestId("category-rename-es-music"), {
      target: { value: "  " },
    });
    fireEvent.click(button("category-rename-save-music"));
    expect(state.setTranslations.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      translations: { es: null },
    });
  });

  it("renames first, then saves the Spanish name, with one editor open throughout", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    fireEvent.change(renameInput("music"), { target: { value: "Live Music" } });
    showTileLanguage("music", "es");
    fireEvent.change(screen.getByTestId("category-rename-es-music"), {
      target: { value: "Música en vivo" },
    });
    fireEvent.click(button("category-rename-save-music"));
    expect(state.rename.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      name: "Live Music",
    });
    expect(state.setTranslations.mutate).not.toHaveBeenCalled();
    act(() => {
      state.rename.options?.onSuccess?.(
        { category: { ...MUSIC, name: "Live Music" } },
        { categoryId: "c1", name: "Live Music" },
      );
      state.rename.options?.onSettled?.();
    });
    expect(state.setTranslations.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      translations: { es: "Música en vivo" },
    });
    // Still open for the second answer; no "renamed" toast in between.
    expect(screen.queryByTestId("category-rename-form-music")).not.toBeNull();
    expect(state.toastSuccess).not.toHaveBeenCalled();
  });

  it("asks for a suggestion in the editor only when the category has no Spanish name", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    fireEvent.blur(renameInput("music"));
    expect(state.suggestTranslations.mutate.mock.calls[0]?.[0]).toEqual({
      text: "Music",
      sourceLocale: "en",
      targetLocales: ["es"],
    });
    answerSuggestion({ es: "Música" });
    const notice = screen.getByTestId("category-suggestion-notice-music-es");
    expect(notice.textContent).toBe(
      'admin.pcSuggestionToReview {"language":"Español"}',
    );
    // Unique on a page of tiles: the button's name carries the category.
    expect(notice.getAttribute("aria-label")).toBe(
      'admin.pcSuggestionToReviewNamed {"language":"Español","name":"Music"}',
    );
    expect(languageOptions("category-language-music")).toEqual([
      "English",
      "Español",
    ]);
    showTileLanguage("music", "es");
    expect(
      (screen.getByTestId("category-rename-es-music") as HTMLInputElement)
        .value,
    ).toBe("Música");
    expect(
      screen.queryByTestId("category-rename-es-music-suggested"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("category-suggestion-notice-music-es"),
    ).toBeNull();
  });

  it("renames without an unseen Spanish suggestion", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    fireEvent.change(renameInput("music"), { target: { value: "Live Music" } });
    fireEvent.blur(renameInput("music"));
    answerSuggestion({ es: "Música en vivo" });
    expect(
      screen.queryByTestId("category-suggestion-notice-music-es"),
    ).not.toBeNull();
    fireEvent.click(button("category-rename-save-music"));
    expect(state.rename.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      name: "Live Music",
    });
    act(() => {
      state.rename.options?.onSuccess?.(
        { category: { ...MUSIC, name: "Live Music" } },
        { categoryId: "c1", name: "Live Music" },
      );
      state.rename.options?.onSettled?.();
    });
    // No Spanish save follows: the suggestion was never on screen.
    expect(state.setTranslations.mutate).not.toHaveBeenCalled();
  });

  it("renames without a seen suggestion for the old English name", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    fireEvent.blur(renameInput("music"));
    answerSuggestion({ es: "Música" });
    fireEvent.click(screen.getByTestId("category-suggestion-notice-music-es"));
    showTileLanguage("music", "en");
    fireEvent.change(renameInput("music"), { target: { value: "Live Music" } });
    fireEvent.click(button("category-rename-save-music"));
    expect(state.rename.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      name: "Live Music",
    });
    act(() => {
      state.rename.options?.onSuccess?.(
        { category: { ...MUSIC, name: "Live Music" } },
        { categoryId: "c1", name: "Live Music" },
      );
      state.rename.options?.onSettled?.();
    });
    expect(state.setTranslations.mutate).not.toHaveBeenCalled();
  });

  it("saves a Spanish suggestion once the notice has shown it", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    fireEvent.blur(renameInput("music"));
    answerSuggestion({ es: "Música" });
    fireEvent.click(screen.getByTestId("category-suggestion-notice-music-es"));
    const spanish = screen.getByTestId(
      "category-rename-es-music",
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(spanish);
    fireEvent.click(button("category-rename-save-music"));
    expect(state.setTranslations.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      translations: { es: "Música" },
    });
  });

  it("shows and focuses a refused English rename again on a second Save from Spanish", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    fireEvent.change(renameInput("music"), { target: { value: "a" } });
    fireEvent.click(button("category-rename-save-music"));
    expect(screen.getByRole("alert").textContent).toBe(
      "admin.pcAddErrorInvalidName",
    );
    showTileLanguage("music", "es");
    expect(screen.queryByTestId("category-rename-input-music")).toBeNull();
    fireEvent.click(button("category-rename-save-music"));
    expect(state.rename.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(renameInput("music"));
    expect(renameInput("music").getAttribute("aria-invalid")).toBe("true");
  });

  it("shows and focuses a refused Spanish rename again on a second Save from English", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    render(<PlatformCategoriesPage />);
    openRename("music");
    showTileLanguage("music", "es");
    fireEvent.change(screen.getByTestId("category-rename-es-music"), {
      target: { value: "@musica" },
    });
    fireEvent.click(button("category-rename-save-music"));
    expect(screen.queryByText("admin.pcTranslationErrorInvalid")).not.toBeNull();
    showTileLanguage("music", "en");
    fireEvent.click(button("category-rename-save-music"));
    expect(state.setTranslations.mutate).not.toHaveBeenCalled();
    const spanish = screen.getByTestId(
      "category-rename-es-music",
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(spanish);
    expect(spanish.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("platform categories: approving a request with its names", () => {
  const SPANISH_REQUEST = {
    id: "r1",
    status: "PENDING",
    kind: "CATEGORY",
    name: "Cumbia en vivo",
    slug: "cumbia-en-vivo",
    categoryName: null,
    createdAt: "2026-10-16T12:00:00.000Z",
    reviewNote: null,
    locale: "es",
  };
  const ENGLISH_REQUEST = {
    ...SPANISH_REQUEST,
    id: "r2",
    name: "Salsa Night",
    slug: "salsa-night",
    locale: null,
  };

  beforeEach(() => {
    resetState();
    state.roles = ["REVIEWER"];
    state.categories = [];
    state.requests = [SPANISH_REQUEST, ENGLISH_REQUEST];
    state.toastSuccess.mockReset();
    state.toastDanger.mockReset();
  });

  const field = (testId: string) =>
    screen.getByTestId(testId) as HTMLInputElement;

  it("shows the language each request was made in", () => {
    render(<PlatformCategoriesPage />);
    expect(screen.getByTestId("category-request-language-r1").textContent).toBe(
      "admin.pcRequestLanguageEs",
    );
    expect(screen.getByTestId("category-request-language-r2").textContent).toBe(
      "admin.pcRequestLanguageEn",
    );
  });

  it("never shows a Spanish request's stored slug; shows the one its English name makes", () => {
    render(<PlatformCategoriesPage />);
    // Closed: the slug is set from the English name, not yet known.
    expect(screen.queryByText("cumbia-en-vivo")).toBeNull();
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "admin.pcSlugFromEnglishName",
    );

    fireEvent.click(button("category-approve-r1"));
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "admin.pcSlugFromEnglishName",
    );
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "  Live  Cumbía " },
    });
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "live-cumbia",
    );
    expect(screen.queryByText("cumbia-en-vivo")).toBeNull();

    // Cleared: back to the plain line.
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "" },
    });
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "admin.pcSlugFromEnglishName",
    );

    // Closing the form goes back to the plain line.
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "Bolero Night" },
    });
    fireEvent.click(button("category-approve-cancel-r1"));
    expect(screen.queryByText("bolero-night")).toBeNull();
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "admin.pcSlugFromEnglishName",
    );
  });

  it("shows the existing category's slug when a Spanish request matches its Spanish name", () => {
    // Approval lands on the category already named this in Spanish.
    state.categories = [
      { ...MUSIC, names: { en: "Music", es: "CUMBIA EN VIVO" } },
    ];
    const slug = () =>
      screen.getByTestId("category-request-slug-r1").textContent;
    render(<PlatformCategoriesPage />);
    expect(slug()).toBe(MUSIC.slug);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "Live Concerts" },
    });
    expect(slug()).toBe(MUSIC.slug);
  });

  it("shows the slug of the category an approved request became", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    state.requests = [
      {
        ...SPANISH_REQUEST,
        status: "APPROVED",
        resolvedCategoryId: MUSIC.id,
      },
    ];
    render(<PlatformCategoriesPage />);
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      MUSIC.slug,
    );
  });

  it("shows the category's slug over an approved English request's stored one", () => {
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    state.requests = [
      {
        ...ENGLISH_REQUEST,
        status: "APPROVED",
        resolvedCategoryId: MUSIC.id,
      },
    ];
    render(<PlatformCategoriesPage />);
    expect(screen.getByTestId("category-request-slug-r2").textContent).toBe(
      MUSIC.slug,
    );
  });

  it("falls back when an approved request's category was deleted, ignoring Spanish matches", () => {
    // Another category now carries the request's Spanish name; the request
    // never became it.
    state.categories = [
      { ...MUSIC, names: { en: "Music", es: "Cumbia en vivo" } },
    ];
    const gone = "00000000-0000-4000-8000-000000000999";
    state.requests = [
      { ...SPANISH_REQUEST, status: "APPROVED", resolvedCategoryId: gone },
      { ...ENGLISH_REQUEST, status: "APPROVED", resolvedCategoryId: gone },
    ];
    render(<PlatformCategoriesPage />);
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "admin.pcSlugFromEnglishName",
    );
    expect(screen.getByTestId("category-request-slug-r2").textContent).toBe(
      "salsa-night",
    );
  });

  it("does not tie a rejected Spanish request to a category with its Spanish name", () => {
    state.categories = [
      { ...MUSIC, names: { en: "Music", es: "Cumbia en vivo" } },
    ];
    state.requests = [{ ...SPANISH_REQUEST, status: "REJECTED" }];
    render(<PlatformCategoriesPage />);
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "admin.pcSlugFromEnglishName",
    );
  });

  it("prefers the category at the English name's slug over a Spanish-name match, as approval does", () => {
    state.categories = [
      { ...MUSIC, names: { en: "Music" } },
      { ...COMEDY, names: { en: COMEDY.name, es: "Cumbia en vivo" } },
    ];
    const slug = () =>
      screen.getByTestId("category-request-slug-r1").textContent;
    render(<PlatformCategoriesPage />);
    expect(slug()).toBe(COMEDY.slug);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "Music" },
    });
    expect(slug()).toBe(MUSIC.slug);
  });

  it("keeps a Spanish match's slug when the form opens with the English field empty", () => {
    state.categories = [
      { ...MUSIC, names: { en: "Music", es: "Cumbia en vivo" } },
    ];
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      MUSIC.slug,
    );
  });

  it("shows no slug while the English name would make one the server refuses", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "a" },
    });
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "admin.pcSlugFromEnglishName",
    );
  });

  it("shows no slug for a refused English name even when the Spanish name matches a category", () => {
    // The server refuses the English name before it matches anything, so the
    // category already named this in Spanish is not where approval lands.
    state.categories = [
      { ...MUSIC, names: { en: "Music", es: "Cumbia en vivo" } },
    ];
    const slug = () =>
      screen.getByTestId("category-request-slug-r1").textContent;
    render(<PlatformCategoriesPage />);
    expect(slug()).toBe(MUSIC.slug);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "a" },
    });
    expect(slug()).toBe("admin.pcSlugFromEnglishName");
  });

  it("shows an English request's stored slug closed, and the edited name's slug open", () => {
    // Stored slug differs from the name's, to tell the two apart.
    state.requests = [{ ...ENGLISH_REQUEST, slug: "salsa-night-stored" }];
    const slug = () =>
      screen.getByTestId("category-request-slug-r2").textContent;
    render(<PlatformCategoriesPage />);
    expect(slug()).toBe("salsa-night-stored");

    fireEvent.click(button("category-approve-r2"));
    expect(slug()).toBe("salsa-night");
    fireEvent.change(field("category-approve-en-r2"), {
      target: { value: "Salsa Nights" },
    });
    expect(slug()).toBe("salsa-nights");
    fireEvent.change(field("category-approve-en-r2"), {
      target: { value: "" },
    });
    expect(slug()).toBe("admin.pcSlugFromEnglishName");

    fireEvent.click(button("category-approve-cancel-r2"));
    expect(slug()).toBe("salsa-night-stored");
  });

  it("puts a Spanish request under Spanish, suggests the English, and sends both", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    // Approve opens the names form; nothing is sent yet.
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
    // English first, focused: the name approval needs.
    expect(field("category-approve-en-r1").value).toBe("");
    expect(document.activeElement).toBe(field("category-approve-en-r1"));
    expect(screen.queryByTestId("category-approve-es-r1")).toBeNull();
    showApprovalLanguage("r1", "es");
    expect(field("category-approve-es-r1").value).toBe("Cumbia en vivo");

    // The English is asked for from the Spanish.
    fireEvent.blur(field("category-approve-es-r1"));
    expect(state.suggestTranslations.mutate.mock.calls[0]?.[0]).toEqual({
      text: "Cumbia en vivo",
      sourceLocale: "es",
      targetLocales: ["en"],
    });
    answerSuggestion({ en: "Live Cumbia" });
    expect(languageOptions("category-approve-language-r1")).toEqual([
      "English",
      "Español",
    ]);
    expect(
      screen.getByTestId("category-approve-suggestion-notice-r1-en")
        .textContent,
    ).toBe('admin.pcSuggestionToReview {"language":"English"}');
    // Approve with the English unseen: nothing is sent, and the English
    // suggestion is brought forward and focused instead of refused.
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("category-approve-en-r1"));
    expect(screen.queryByText("admin.pcEnglishNameRequired")).toBeNull();
    expect(
      screen.queryByTestId("category-approve-suggestion-notice-r1-en"),
    ).toBeNull();
    expect(field("category-approve-en-r1").value).toBe("Live Cumbia");
    // A suggested English name makes the slug as a typed one does.
    expect(screen.getByTestId("category-request-slug-r1").textContent).toBe(
      "live-cumbia",
    );
    expect(
      screen.queryByTestId("category-approve-en-r1-suggested"),
    ).not.toBeNull();
    // Translate sits beside English here, from Spanish.
    expect(
      screen
        .getByTestId("category-approve-en-r1-translate")
        .getAttribute("href"),
    ).toBe("https://translate.google.com/?sl=es&tl=en&text=Cumbia%20en%20vivo");

    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith({
      requestId: "r1",
      decision: "APPROVE",
      reviewNote: undefined,
      name: "Live Cumbia",
      translations: { es: "Cumbia en vivo" },
    });
  });

  it("will not approve a Spanish request without an English name", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("admin.pcEnglishNameRequired")).not.toBeNull();
  });

  it("shows the server's English-name refusal under the English field", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "Cumbia" },
    });
    fireEvent.click(button("category-approve-submit-r1"));
    act(() => {
      state.reviewRequest.options?.onError?.(
        {
          message: "CATEGORY_ENGLISH_NAME_REQUIRED",
          data: { appCode: "CATEGORY_ENGLISH_NAME_REQUIRED" },
        },
        { requestId: "r1", decision: "APPROVE" },
      );
    });
    expect(screen.queryByText("admin.pcEnglishNameRequired")).not.toBeNull();
    expect(state.toastDanger).not.toHaveBeenCalled();
    expect(field("category-approve-en-r1").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("prefills an English request's name and leaves an unseen Spanish suggestion out", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r2"));
    expect(field("category-approve-en-r2").value).toBe("Salsa Night");
    fireEvent.blur(field("category-approve-en-r2"));
    answerSuggestion({ es: "Noche de salsa" });
    const notice = screen.getByTestId("category-approve-suggestion-notice-r2-es");
    expect(notice.getAttribute("aria-label")).toBe(
      'admin.pcSuggestionToReviewNamed {"language":"Español","name":"Salsa Night"}',
    );
    fireEvent.click(button("category-approve-submit-r2"));
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r2",
        decision: "APPROVE",
        name: "Salsa Night",
        translations: { es: null },
      }),
    );
  });

  it("leaves out a seen Spanish suggestion once the English name has changed", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r2"));
    fireEvent.blur(field("category-approve-en-r2"));
    answerSuggestion({ es: "Noche de salsa" });
    fireEvent.click(
      screen.getByTestId("category-approve-suggestion-notice-r2-es"),
    );
    showApprovalLanguage("r2", "en");
    fireEvent.change(field("category-approve-en-r2"), {
      target: { value: "Salsa Nights" },
    });
    fireEvent.click(button("category-approve-submit-r2"));
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r2",
        name: "Salsa Nights",
        translations: { es: null },
      }),
    );
  });

  /**
   * A Spanish request whose English suggestion was seen, then the Spanish
   * edited: the English now answers an earlier Spanish name. Approve is
   * refused once, with the stale line under English.
   */
  function refuseStaleEnglish() {
    fireEvent.click(button("category-approve-r1"));
    showApprovalLanguage("r1", "es");
    fireEvent.blur(field("category-approve-es-r1"));
    answerSuggestion({ en: "Live Cumbia" });
    fireEvent.click(
      screen.getByTestId("category-approve-suggestion-notice-r1-en"),
    );
    showApprovalLanguage("r1", "es");
    fireEvent.change(field("category-approve-es-r1"), {
      target: { value: "Cumbia tropical" },
    });
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("category-approve-en-r1"));
  }
  const suggestCalls = () =>
    state.suggestTranslations.mutate.mock.calls as SuggestCall[];
  const staleLine = () => screen.queryByTestId("category-approve-en-stale-r1");

  it("asks again for an English suggestion that answers an older Spanish name, and sends the new one once seen", () => {
    render(<PlatformCategoriesPage />);
    refuseStaleEnglish();
    expect(suggestCalls()[suggestCalls().length - 1]?.[0]).toEqual({
      text: "Cumbia tropical",
      sourceLocale: "es",
      targetLocales: ["en"],
    });
    // The fresh suggestion lands in the English field, which is on screen.
    answerSuggestion({ en: "Tropical Cumbia" });
    expect(field("category-approve-en-r1").value).toBe("Tropical Cumbia");
    expect(staleLine()).toBeNull();
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r1",
        name: "Tropical Cumbia",
        translations: { es: "Cumbia tropical" },
      }),
    );
  });

  it("says why Approve sent nothing when the new English suggestion fails, and sends typed English", () => {
    render(<PlatformCategoriesPage />);
    refuseStaleEnglish();
    const line = staleLine();
    expect(line?.textContent).toBe("admin.pcStaleEnglishSuggestion");
    expect(line?.id).toBe("platform-category-approve-en-r1-stale");
    expect(
      field("category-approve-en-r1").getAttribute("aria-describedby"),
    ).toContain("platform-category-approve-en-r1-stale");
    // Inside a polite live region that was there before the refusal.
    const region = screen.getByTestId("category-approve-en-stale-region-r1");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.contains(line ?? null)).toBe(true);
    const calls = suggestCalls();
    act(() => {
      calls[calls.length - 1]?.[1].onError?.(new Error("translate down"));
    });
    // A second Approve still says so, and still sends nothing.
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
    expect(staleLine()).not.toBeNull();
    // Typed English is the admin's own: it goes.
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "Tropical Cumbia" },
    });
    expect(staleLine()).toBeNull();
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r1",
        name: "Tropical Cumbia",
        translations: { es: "Cumbia tropical" },
      }),
    );
  });

  it("keeps the live region mounted and empty until Approve is refused", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    const region = screen.getByTestId("category-approve-en-stale-region-r1");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("asks for the new English suggestion once while it is in flight, however often Approve is pressed", () => {
    render(<PlatformCategoriesPage />);
    refuseStaleEnglish();
    const after = suggestCalls().length;
    fireEvent.click(button("category-approve-submit-r1"));
    fireEvent.click(button("category-approve-submit-r1"));
    expect(suggestCalls().length).toBe(after);
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
  });

  it("drops the line once the English is no longer stale, and a re-landed suggestion does not bring it back", () => {
    render(<PlatformCategoriesPage />);
    refuseStaleEnglish();
    expect(staleLine()).not.toBeNull();
    // The Spanish goes back to what the English suggestion answered.
    showApprovalLanguage("r1", "es");
    fireEvent.change(field("category-approve-es-r1"), {
      target: { value: "Cumbia en vivo" },
    });
    showApprovalLanguage("r1", "en");
    expect(staleLine()).toBeNull();
    // The Spanish changes again: stale once more, but no refusal yet.
    showApprovalLanguage("r1", "es");
    fireEvent.change(field("category-approve-es-r1"), {
      target: { value: "Cumbia tropical" },
    });
    showApprovalLanguage("r1", "en");
    expect(staleLine()).toBeNull();
  });

  it("asks again after an empty English answer, keeps saying why, and sends typed English", () => {
    render(<PlatformCategoriesPage />);
    refuseStaleEnglish();
    answerSuggestion({});
    expect(staleLine()).not.toBeNull();
    const before = suggestCalls().length;
    fireEvent.click(button("category-approve-submit-r1"));
    // The empty answer did not block asking again.
    expect(suggestCalls().length).toBe(before + 1);
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
    expect(staleLine()).not.toBeNull();
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "Tropical Cumbia" },
    });
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "r1", name: "Tropical Cumbia" }),
    );
  });

  it("sends the old suggestion when the admin types it out again", () => {
    render(<PlatformCategoriesPage />);
    refuseStaleEnglish();
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "Live Cumbi" },
    });
    fireEvent.change(field("category-approve-en-r1"), {
      target: { value: "Live Cumbia" },
    });
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r1",
        name: "Live Cumbia",
        translations: { es: "Cumbia tropical" },
      }),
    );
  });

  it("sends an English request's Spanish suggestion once it has been shown", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r2"));
    fireEvent.blur(field("category-approve-en-r2"));
    answerSuggestion({ es: "Noche de salsa" });
    fireEvent.click(
      screen.getByTestId("category-approve-suggestion-notice-r2-es"),
    );
    expect(document.activeElement).toBe(field("category-approve-es-r2"));
    fireEvent.click(button("category-approve-submit-r2"));
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r2",
        name: "Salsa Night",
        translations: { es: "Noche de salsa" },
      }),
    );
  });

  it("shows and focuses a refused Spanish name again on a second Approve from English", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r2"));
    showApprovalLanguage("r2", "es");
    fireEvent.change(field("category-approve-es-r2"), {
      target: { value: "@salsa" },
    });
    fireEvent.click(button("category-approve-submit-r2"));
    expect(screen.queryByText("admin.pcTranslationErrorInvalid")).not.toBeNull();
    showApprovalLanguage("r2", "en");
    fireEvent.click(button("category-approve-submit-r2"));
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("category-approve-es-r2"));
    expect(
      field("category-approve-es-r2").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("shows and focuses a refused English name again on a second Approve from Spanish", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.click(button("category-approve-submit-r1"));
    expect(screen.queryByText("admin.pcEnglishNameRequired")).not.toBeNull();
    showApprovalLanguage("r1", "es");
    fireEvent.click(button("category-approve-submit-r1"));
    expect(state.reviewRequest.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("category-approve-en-r1"));
  });

  it("rejects in one press, with no names sent", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(screen.getAllByText("admin.pcReject")[0]!);
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith({
      requestId: "r1",
      decision: "REJECT",
      reviewNote: undefined,
    });
  });

  it("closes the names form on Cancel and puts focus back on Approve", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.click(button("category-approve-cancel-r1"));
    expect(screen.queryByTestId("category-approve-form-r1")).toBeNull();
    expect(document.activeElement).toBe(button("category-approve-r1"));
  });
});

// ── Enter submits each two-field form (no implicit submission) ─────────────

describe("platform categories: Enter in the name forms", () => {
  beforeEach(() => {
    resetState();
    state.roles = ["ADMIN"];
    state.categories = [{ ...MUSIC, names: { en: "Music" } }];
    state.requests = [];
    state.createMutate.mockReset();
    state.toastSuccess.mockReset();
    state.toastDanger.mockReset();
  });

  const enter = (element: HTMLElement) =>
    fireEvent.keyDown(element, { key: "Enter" });

  it("adds a category on Enter in the Spanish field", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    showCreateLanguage("es");
    const spanish = screen.getByTestId("category-create-name-es");
    fireEvent.change(spanish, { target: { value: "Jazz en vivo" } });
    enter(spanish);
    expect(state.createMutate).toHaveBeenCalledTimes(1);
    expect(state.createMutate).toHaveBeenCalledWith({
      name: "Live Jazz",
      seoType: "Event",
      translations: { es: "Jazz en vivo" },
    });
  });

  it("saves the names editor on Enter in the Spanish field", () => {
    render(<PlatformCategoriesPage />);
    openRename("music");
    showTileLanguage("music", "es");
    const spanish = screen.getByTestId("category-rename-es-music");
    fireEvent.change(spanish, { target: { value: "Música" } });
    enter(spanish);
    enter(spanish);
    expect(state.setTranslations.mutate).toHaveBeenCalledTimes(1);
    expect(state.setTranslations.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      translations: { es: "Música" },
    });
  });

  it("approves on Enter in the Spanish field, once", () => {
    state.roles = ["REVIEWER"];
    state.requests = [
      {
        id: "r1",
        status: "PENDING",
        kind: "CATEGORY",
        name: "Cumbia",
        slug: "cumbia",
        categoryName: null,
        createdAt: "2026-10-16T12:00:00.000Z",
        reviewNote: null,
        locale: "es",
      },
    ];
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-approve-r1"));
    fireEvent.change(screen.getByTestId("category-approve-en-r1"), {
      target: { value: "Cumbia" },
    });
    showApprovalLanguage("r1", "es");
    const spanish = screen.getByTestId("category-approve-es-r1");
    enter(spanish);
    enter(spanish);
    expect(state.reviewRequest.mutate).toHaveBeenCalledTimes(1);
    expect(state.reviewRequest.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r1",
        decision: "APPROVE",
        name: "Cumbia",
        translations: { es: "Cumbia" },
      }),
    );
  });

  it("says the English name was saved when only the Spanish save after a rename fails", () => {
    render(<PlatformCategoriesPage />);
    openRename("music");
    fireEvent.change(renameInput("music"), { target: { value: "Live Music" } });
    showTileLanguage("music", "es");
    fireEvent.change(screen.getByTestId("category-rename-es-music"), {
      target: { value: "Música en vivo" },
    });
    fireEvent.click(button("category-rename-save-music"));
    act(() => {
      state.rename.options?.onSuccess?.(
        { category: { ...MUSIC, name: "Live Music" } },
        { categoryId: "c1", name: "Live Music" },
      );
      state.rename.options?.onSettled?.();
    });
    act(() => {
      state.setTranslations.options?.onError?.(
        { message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } },
        { categoryId: "c1", translations: { es: "Música en vivo" } },
      );
    });
    expect(state.toastDanger.mock.calls[0]?.[0]?.title).toBe(
      'admin.pcEnglishSavedOtherNotToast {"language":"admin.pcLanguageEs"}',
    );
  });

  it("explains an invalid Spanish name with the translation rule, not the slug rule", () => {
    render(<PlatformCategoriesPage />);
    typeName("Live Jazz");
    showCreateLanguage("es");
    fireEvent.change(screen.getByTestId("category-create-name-es"), {
      target: { value: "@jazz" },
    });
    fireEvent.click(submitButton());
    expect(state.createMutate).not.toHaveBeenCalled();
    expect(
      screen.queryByText("admin.pcTranslationErrorInvalid"),
    ).not.toBeNull();
    expect(screen.queryByText("admin.pcAddErrorInvalidName")).toBeNull();
  });
});

// ── URLs per language (Spanish SEO FR-009/FR-010/FR-012, owner R24) ────────

describe("platform categories: URLs behind the language selector", () => {
  const MUSIC_WITH_URLS = {
    ...MUSIC,
    names: { en: "Music", es: "Música" },
    urls: [
      { locale: "en", slug: "music", isCurrent: true },
      { locale: "es", slug: "musica", isCurrent: true },
      { locale: "en", slug: "live-music", isCurrent: false },
      { locale: "es", slug: "musica-en-vivo", isCurrent: false },
    ],
  };
  const COMEDY_NO_SPANISH = {
    ...COMEDY,
    names: { en: "Comedy" },
    urls: [{ locale: "en", slug: "comedy", isCurrent: true }],
  };

  beforeEach(() => {
    resetState();
    state.roles = ["ADMIN"];
    state.categories = [MUSIC_WITH_URLS, COMEDY_NO_SPANISH];
    state.requests = [];
    state.invalidateList.mockReset();
    state.toastSuccess.mockReset();
    state.toastDanger.mockReset();
    state.toastWarning.mockReset();
  });

  const url = (locale: string, id: string) =>
    screen.getByTestId(`category-url-${locale}-${id}`).textContent;
  const oldUrls = (locale: string, id: string) =>
    Array.from(
      screen
        .queryByTestId(`category-old-urls-${locale}-${id}`)
        ?.querySelectorAll("li") ?? [],
    ).map((item) => item.textContent);
  const urlInput = (locale: string, id: string) =>
    screen.getByTestId(`category-url-input-${locale}-${id}`) as HTMLInputElement;

  it("opens on English: its name, its URL and its old URLs only", () => {
    render(<PlatformCategoriesPage />);
    expect(
      (screen.getByTestId("category-language-music") as HTMLSelectElement)
        .value,
    ).toBe("en");
    expect(screen.getByTestId("category-name-en-music").textContent).toBe(
      "Music",
    );
    expect(url("en", "c1")).toBe("/events/category/music");
    expect(oldUrls("en", "c1")).toEqual(["/events/category/live-music"]);
    // Nothing of the other language is on the tile.
    expect(screen.queryByTestId("category-url-es-c1")).toBeNull();
    expect(screen.queryByText("/es/eventos/categoria/musica")).toBeNull();
  });

  it("switches to Spanish: the Spanish name, URL and old URLs replace the English", () => {
    render(<PlatformCategoriesPage />);
    showTileLanguage("music", "es");
    expect(screen.getByTestId("category-name-es-music").textContent).toBe(
      "Música",
    );
    expect(url("es", "c1")).toBe("/es/eventos/categoria/musica");
    expect(oldUrls("es", "c1")).toEqual([
      "/es/eventos/categoria/musica-en-vivo",
    ]);
    expect(screen.queryByTestId("category-url-en-c1")).toBeNull();
    expect(
      button("category-url-change-es-c1").getAttribute("aria-label"),
    ).toBe(
      'admin.pcChangeUrlNamed {"language":"admin.pcLanguageEs","name":"Music"}',
    );
    // The other tile stays on English.
    expect(url("en", "c2")).toBe("/events/category/comedy");
  });

  it("with no Spanish name: says so, shows the URL that renders today, offers no Change URL", () => {
    render(<PlatformCategoriesPage />);
    showTileLanguage("comedy", "es");
    expect(screen.getByTestId("category-name-es-comedy").textContent).toBe(
      "admin.pcNameMissing",
    );
    // FR-010: the English slug under the Spanish path.
    expect(url("es", "c2")).toBe("/es/eventos/categoria/comedy");
    expect(
      within(tile("comedy")).queryByText(
        'admin.pcNotInSearchUntilNamed {"language":"admin.pcLanguageEs"}',
      ),
    ).not.toBeNull();
    expect(screen.queryByTestId("category-url-change-es-c2")).toBeNull();
    expect(oldUrls("es", "c2")).toEqual([]);
  });

  it("changes a URL: sends the cleaned slug, shows the reply at once, focus back on Change URL", () => {
    const view = render(<PlatformCategoriesPage />);
    showTileLanguage("music", "es");
    fireEvent.click(button("category-url-change-es-c1"));
    const input = urlInput("es", "c1");
    expect(input.value).toBe("musica");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-label")).toBe(
      'admin.pcNewUrlNamed {"language":"admin.pcLanguageEs","name":"Music"}',
    );

    fireEvent.change(input, { target: { value: " Musica-Viva " } });
    fireEvent.click(button("category-url-save-es-c1"));
    expect(state.changeSlug.mutate).toHaveBeenCalledTimes(1);
    expect(state.changeSlug.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      locale: "es",
      newSlug: "musica-viva",
    });
    expect(state.changeSlug.options?.meta).toEqual({ silent: true });

    act(() => {
      state.changeSlug.options?.onSuccess?.(
        {
          categoryId: "c1",
          locale: "es",
          currentSlug: "musica-viva",
          oldSlugs: ["musica", "musica-en-vivo"],
        },
        { categoryId: "c1", locale: "es", newSlug: "musica-viva" },
      );
    });
    // The stand-in's cache took the reply; render what the page now reads.
    view.rerender(<PlatformCategoriesPage />);
    expect(state.toastSuccess.mock.calls[0]?.[0]).toEqual({
      title: "admin.pcUrlChangedToast",
      message: "/es/eventos/categoria/musica-viva",
    });
    expect(state.invalidateList).toHaveBeenCalled();
    expect(state.invalidateListAll).toHaveBeenCalled();
    expect(screen.queryByTestId("category-url-form-es-c1")).toBeNull();
    expect(url("es", "c1")).toBe("/es/eventos/categoria/musica-viva");
    expect(oldUrls("es", "c1")).toEqual([
      "/es/eventos/categoria/musica",
      "/es/eventos/categoria/musica-en-vivo",
    ]);
    expect(document.activeElement).toBe(button("category-url-change-es-c1"));
    // The English rows are untouched.
    showTileLanguage("music", "en");
    expect(url("en", "c1")).toBe("/events/category/music");
    expect(oldUrls("en", "c1")).toEqual(["/events/category/live-music"]);
  });

  it("puts a taken URL under the field and keeps the editor open", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-url-change-en-c1"));
    fireEvent.change(urlInput("en", "c1"), { target: { value: "comedy" } });
    fireEvent.keyDown(urlInput("en", "c1"), { key: "Enter" });
    expect(state.changeSlug.mutate).toHaveBeenCalledWith({
      categoryId: "c1",
      locale: "en",
      newSlug: "comedy",
    });
    act(() => {
      state.changeSlug.options?.onError?.(appError("CATEGORY_SLUG_TAKEN"), {
        categoryId: "c1",
        locale: "en",
        newSlug: "comedy",
      });
    });
    const form = screen.getByTestId("category-url-form-en-c1");
    expect(within(form).queryByRole("alert")).not.toBeNull();
    expect(urlInput("en", "c1").getAttribute("aria-invalid")).toBe("true");
    expect(urlInput("en", "c1").value).toBe("comedy");
    expect(state.toastDanger).not.toHaveBeenCalled();
    // Editing the field drops the refusal.
    fireEvent.change(urlInput("en", "c1"), { target: { value: "comedy-2" } });
    expect(within(form).queryByRole("alert")).toBeNull();
  });

  it("refuses a slug that breaks the rules before any round trip", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-url-change-en-c1"));
    fireEvent.change(urlInput("en", "c1"), { target: { value: "no_way" } });
    fireEvent.click(button("category-url-save-en-c1"));
    expect(state.changeSlug.mutate).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId("category-url-form-en-c1")).queryByText(
        "errors.invalidCategorySlug",
      ),
    ).not.toBeNull();
  });

  it("closes without a call when the slug is unchanged, and on Escape", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-url-change-en-c1"));
    fireEvent.click(button("category-url-save-en-c1"));
    expect(state.changeSlug.mutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("category-url-form-en-c1")).toBeNull();
    expect(document.activeElement).toBe(button("category-url-change-en-c1"));

    fireEvent.click(button("category-url-change-en-c1"));
    fireEvent.keyDown(urlInput("en", "c1"), { key: "Escape" });
    expect(screen.queryByTestId("category-url-form-en-c1")).toBeNull();
  });

  it("keeps an unsaved URL edit while another language is looked at", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-url-change-en-c1"));
    fireEvent.change(urlInput("en", "c1"), { target: { value: "tunes" } });
    showTileLanguage("music", "es");
    expect(screen.queryByTestId("category-url-form-en-c1")).toBeNull();
    expect(url("es", "c1")).toBe("/es/eventos/categoria/musica");
    showTileLanguage("music", "en");
    expect(urlInput("en", "c1").value).toBe("tunes");
  });

  it("keeps an unsaved URL edit while the names editor or a confirm is open", () => {
    render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-url-change-en-c1"));
    fireEvent.change(urlInput("en", "c1"), { target: { value: "tunes" } });
    openRename("music");
    expect(screen.queryByTestId("category-url-form-en-c1")).toBeNull();
    fireEvent.click(button("category-rename-cancel-music"));
    expect(urlInput("en", "c1").value).toBe("tunes");

    fireEvent.click(button("category-active-toggle-music"));
    expect(screen.queryByTestId("category-url-form-en-c1")).toBeNull();
    fireEvent.click(
      document.getElementById("platform-category-confirm-cancel-c1")!,
    );
    expect(urlInput("en", "c1").value).toBe("tunes");
  });

  it("offers Change URL for a Spanish URL whose name was cleared (R20)", () => {
    state.categories = [
      {
        ...MUSIC_WITH_URLS,
        names: { en: "Music" },
      },
    ];
    render(<PlatformCategoriesPage />);
    showTileLanguage("music", "es");
    expect(url("es", "c1")).toBe("/es/eventos/categoria/musica");
    expect(screen.queryByTestId("category-url-change-es-c1")).not.toBeNull();
  });

  it("moves the category's own slug with an English URL change", () => {
    const view = render(<PlatformCategoriesPage />);
    fireEvent.click(button("category-url-change-en-c1"));
    fireEvent.change(urlInput("en", "c1"), { target: { value: "tunes" } });
    fireEvent.click(button("category-url-save-en-c1"));
    act(() => {
      state.changeSlug.options?.onSuccess?.(
        {
          categoryId: "c1",
          locale: "en",
          currentSlug: "tunes",
          oldSlugs: ["music", "live-music"],
        },
        { categoryId: "c1", locale: "en", newSlug: "tunes" },
      );
    });
    view.rerender(<PlatformCategoriesPage />);
    // The tile is keyed by its slug in test ids: it is now "tunes".
    expect(screen.queryByTestId("category-tile-tunes")).not.toBeNull();
    expect(url("en", "c1")).toBe("/events/category/tunes");
  });

  it("gives a REVIEWER the URLs but no Change URL", () => {
    state.roles = ["REVIEWER"];
    render(<PlatformCategoriesPage />);
    expect(url("en", "c1")).toBe("/events/category/music");
    expect(
      document.querySelector('[data-testid^="category-url-change-"]'),
    ).toBeNull();
  });

  it("brings Spanish forward when a Spanish name is refused while English is shown", () => {
    render(<PlatformCategoriesPage />);
    openRename("music");
    showTileLanguage("music", "es");
    fireEvent.change(screen.getByTestId("category-rename-es-music"), {
      target: { value: "Comedia" },
    });
    showTileLanguage("music", "en");
    fireEvent.click(button("category-rename-save-music"));
    expect(state.setTranslations.mutate).toHaveBeenCalledTimes(1);
    act(() => {
      state.setTranslations.options?.onError?.(
        {
          message: "CATEGORY_ALREADY_EXISTS",
          data: {
            appCode: "CATEGORY_ALREADY_EXISTS",
            meta: { field: "nameTranslations", locale: "es" },
          },
        },
        { categoryId: "c1", translations: { es: "Comedia" } },
      );
      state.setTranslations.options?.onSettled?.();
    });
    const spanish = screen.getByTestId(
      "category-rename-es-music",
    ) as HTMLInputElement;
    expect(spanish.value).toBe("Comedia");
    expect(spanish.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(spanish);
  });
});
