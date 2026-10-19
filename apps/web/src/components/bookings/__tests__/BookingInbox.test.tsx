import { forwardRef, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ONE venue-side booking inbox, in its three scopes. Merged from the two
 * suites that pinned the place inbox and the org cross-venue inbox when they
 * were separate files; every pin that was true of either surface is kept.
 *
 * The real component is mounted with the real `getBookingRequestSender` lens
 * and the REAL `BookingThread` / `BookingAcceptanceToggle`; only the chrome
 * (DataTable, ConfirmDialog, @th/ui primitives, tamagui) and the embed section
 * are mocked. The DataTable mock renders every column cell, an expand trigger
 * wired to `onRowPress`, and the `renderExpandedRow` output — the lightest
 * mount that exercises the branching without restructuring the component.
 */

const testMocks = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
  respondMutate: vi.fn(),
  resendMutate: vi.fn(),
  markViewedMutate: vi.fn(),
  setAcceptanceMutate: vi.fn(),
  createEventMutate: vi.fn(),
  listInvalidate: vi.fn(),
  listSetData: vi.fn(),
  countOpenInvalidate: vi.fn(),
  agreementInvalidate: vi.fn(),
  messagesInvalidate: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
  toastWarning: vi.fn(),
  /** Every `bookingAgreements.get` the expanded thread issues. */
  agreementUseQuery: vi.fn(),
  /** Hold / assign / tag writes (booking-holds spec). */
  holdMutate: vi.fn(),
  assignMutate: vi.fn(),
  setTagsMutate: vi.fn(),
}));

// Mutable per-test list payload.
let listRequests: unknown[] = [];
let listExtra: Record<string, unknown> = {};
/**
 * React Query's cache stamp. Moved by deliveries AND by `setData` writes — the
 * follow-the-row latch must NOT key on it, and the tests below pin that.
 */
let listUpdatedAt = 0;
/**
 * The list query's fetch flags. The latch resolves on the `isFetching`
 * true→false edge of a fetch that did not error; a failed fetch (error set,
 * `errorUpdatedAt` bumped) drops it. A test "delivers" a list by flipping
 * `listFetching` on, rerendering, swapping `listRequests`, flipping it off,
 * and rerendering again — see `deliverList`.
 */
let listFetching = false;
let listError: Error | null = null;
let listErrorUpdatedAt = 0;
/** What `bookingAgreements.get` resolves to (undefined = still in flight). */
let agreementData: unknown = undefined;
/** What `useEventOwnerEntities` resolves to. */
let ownersWithSlugs: unknown[] | undefined = undefined;
/**
 * Mutable per-test `places.getPlaceForEdit` payload. The place scope reads it
 * for the acceptance switch and for which onboarding empty state is TRUE.
 */
let placeData: { place: Record<string, unknown> } | undefined = {
  place: {
    placeId: "place-1",
    verificationStatus: "VERIFIED",
    acceptsBookingRequests: true,
    // The default fixture is the venue's owner. The switch fails CLOSED
    // without this, so omitting it would disable the control everywhere.
    viewerCanManageSwitches: true,
  },
};
/**
 * `places.getPlaceForEdit` failure, for the role that reaches this inbox and
 * is refused that read: `listBookingRequests` scope `venue` admits ANY member
 * of an owning org, while `getPlaceForEdit` sits at `canManagePlace`
 * (OWNER/ADMIN/EDITOR). So a SCANNER renders the whole page with no place.
 */
let placeError: unknown = null;
// Opt-in: render `renderMobileCard` instead of the table cells, as the real
// DataTable does below 600px. Reset to `false` in beforeEach.
let cardMode = false;

/** The `?request=<id>` deep link; null = no query string. */
let requestParam: string | null = null;
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: testMocks.routerPush,
    replace: testMocks.routerReplace,
  }),
  usePathname: () => "/admin/acme/bookings",
  useSearchParams: () => ({
    get: (key: string) => (key === "request" ? requestParam : null),
    // Other params ride along untouched; `request` is the only one stripped.
    toString: () =>
      requestParam ? `request=${requestParam}&view=compact` : "view=compact",
  }),
}));

// The place scope reads the admin shell's owner to decide whether the org
// workflow chrome (assignee / tags) renders. Human shell by default; a test
// flips it to an org to exercise the chrome.
let currentAdminOwner: Record<string, unknown> | null = null;
vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: currentAdminOwner,
    normalizedSlug: "the-spot",
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    ownersWithSlugs,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: {
        list: {
          setData: testMocks.listSetData,
          invalidate: testMocks.listInvalidate,
        },
        countOpen: { invalidate: testMocks.countOpenInvalidate },
        messages: { list: { invalidate: testMocks.messagesInvalidate } },
      },
      bookingAgreements: { get: { invalidate: testMocks.agreementInvalidate } },
      bookingHolds: { listForRequest: { invalidate: vi.fn() } },
      bookingTags: { list: { invalidate: vi.fn() } },
      // Consumed by the REAL BookingAcceptanceToggle the place scope mounts.
      places: {
        getPlaceForEdit: {
          cancel: vi.fn(),
          getData: () => placeData,
          setData: vi.fn(),
          invalidate: vi.fn(),
        },
        getVenueCalendar: { invalidate: vi.fn() },
        // The picker's month comes from here and caches for 30s; the strip
        // and the picker both invalidate it after a write.
        getCalendarEventsAdmin: { invalidate: vi.fn() },
      },
    }),
    places: {
      getPlaceForEdit: {
        useQuery: () => ({
          data: placeError ? undefined : placeData,
          isLoading: false,
          error: placeError,
        }),
      },
      // The availability-onboarding detector (consumed by the acceptance
      // toggle's FR-001 warning). UNANSWERED here: this suite is about the
      // inbox, and an errored read is also the shipped reality until the
      // router procedure lands.
      getAvailabilitySetupState: {
        useQuery: () => ({ data: undefined, isLoading: false, isError: true }),
      },
      // The thread's venue-confirm dialog reads whether the venue withholds
      // its address (`VenueConfirmationActions`, pinned in its own suite).
      getPlacePublic: {
        useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
      },
      setBookingAcceptance: {
        useMutation: () => ({
          mutate: testMocks.setAcceptanceMutate,
          isPending: false,
        }),
      },
      // The community-listing consent switch mounted directly beneath the
      // booking one (community-listings-at-claimed-venues FR-005). Its own
      // behaviour is pinned in
      // `app/admin/[slug]/places/[placeId]/bookings/_components/__tests__/
      // CommunityListingAcceptanceToggle.test.tsx`; here it only has to be
      // mountable, so the inbox suite keeps testing the inbox.
      setCommunityListingAcceptance: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      // The three reads `HoldDatePicker` makes once "Place hold" is opened.
      // One default calendar, no rooms: enough for the picker to have a
      // target without rendering a calendar switch.
      listCalendars: {
        useQuery: () => ({
          data: [{ id: "cal-1", name: "Main", isDefault: true, spaces: [] }],
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
      // Per-day open/closed plus the VENUE's zone, which is what makes the
      // grid's "today" the venue's and not the viewer's.
      getBookingAvailability: {
        useQuery: () => ({
          data: { timezone: "America/Chicago", days: [] },
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
      // The live hold overlay for the month, plus the events that took nights.
      getCalendarEventsAdmin: {
        useQuery: () => ({
          data: { events: [], holds: [] },
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
    },
    // Roster behind the assignee column / picker (org scopes only).
    orgs: {
      listMembers: {
        useQuery: () => ({
          data: {
            items: [
              { humanId: "22222222-2222-4222-8222-222222222222", name: "Dana Booker", email: "dana@example.com", role: "EDITOR", joinedAt: new Date() },
              { humanId: "33333333-3333-4333-8333-333333333333", name: null, email: "viewer@example.com", role: "VIEWER", joinedAt: new Date() },
            ],
            total: 2,
          },
          isLoading: false,
          isError: false,
        }),
      },
    },
    bookingHolds: {
      place: { useMutation: () => ({ mutate: testMocks.holdMutate, isPending: false }) },
      placeMany: { useMutation: () => ({ mutate: testMocks.holdMutate, isPending: false }) },
      reorder: { useMutation: () => ({ mutate: testMocks.holdMutate, isPending: false }) },
      challenge: { useMutation: () => ({ mutate: testMocks.holdMutate, isPending: false }) },
      extend: { useMutation: () => ({ mutate: testMocks.holdMutate, isPending: false }) },
      release: { useMutation: () => ({ mutate: testMocks.holdMutate, isPending: false }) },
      confirm: { useMutation: () => ({ mutate: testMocks.holdMutate, isPending: false }) },
      // P5-fixes: the strip books a night without terms (FR-004).
      bookNightWithoutTerms: { useMutation: () => ({ mutate: testMocks.holdMutate, isPending: false }) },
    },
    bookingTags: {
      list: {
        useQuery: () => ({
          data: {
            tags: [
              { id: "tag-1", orgId: "org-1", name: "Rock", slug: "rock", color: "accent", sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
            ],
          },
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      setForRequest: { useMutation: () => ({ mutate: testMocks.setTagsMutate, isPending: false }) },
    },
    bookingRequests: {
      assign: {
        useMutation: () => ({ mutate: testMocks.assignMutate, isPending: false }),
      },
      list: {
        useQuery: (input: unknown) => {
          testMocks.listUseQuery(input);
          return {
            data: { requests: listRequests, ...listExtra },
            dataUpdatedAt: listUpdatedAt,
            isFetching: listFetching,
            isError: listError !== null,
            error: listError,
            errorUpdatedAt: listErrorUpdatedAt,
            isLoading: false,
            refetch: vi.fn(),
          };
        },
      },
      markViewed: {
        useMutation: () => ({
          mutate: testMocks.markViewedMutate,
          isPending: false,
        }),
      },
      respond: {
        useMutation: () => ({
          mutate: testMocks.respondMutate,
          isPending: false,
        }),
      },
      resendInvite: {
        useMutation: () => ({
          mutate: testMocks.resendMutate,
          isPending: false,
        }),
      },
      // The expanded row mounts <BookingThread>. This suite is about the
      // inbox, so the thread's own procedures are stubbed to a quiet empty
      // state rather than exercised — BookingThread has its own suite.
      messages: {
        list: {
          useQuery: () => ({
            data: { items: [], nextCursor: null },
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        post: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        markRead: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
      attachments: {
        list: {
          useQuery: () => ({
            data: [],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
      },
    },
    // The in-thread venue-confirmation action (`VenueConfirmationActions`)
    // owns these two; nothing here asserts on them.
    venueConfirmation: {
      confirm: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      withdraw: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    // Read by the thread's TERMS STRIP and by the in-thread create-event
    // action (same key). What is asserted here is whether the read fires at
    // all and what the action does with the answer.
    bookingAgreements: {
      // P5-fixes: the holds strip's one-tap "Send terms" (FR-003).
      sendTerms: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      get: {
        useQuery: (input: unknown) => {
          testMocks.agreementUseQuery(input);
          return {
            data: agreementData,
            error: null,
            isFetching: agreementData === undefined,
            refetch: vi.fn(),
          };
        },
      },
      createEventFromAgreement: {
        useMutation: () => ({
          mutate: testMocks.createEventMutate,
          isPending: false,
        }),
      },
    },
  },
}));

const PASSTHROUGH_PROPS = [
  "role",
  "id",
  "tabIndex",
  "onKeyDown",
  "aria-label",
  "aria-selected",
  "aria-controls",
  "aria-labelledby",
  "aria-pressed",
  "aria-hidden",
  // The stage rail hangs its ids on `data-testid` (a DOM prop) rather than
  // `testID`, and encodes each bar's lit/dim state in `data-state`.
  "data-testid",
  "data-state",
] as const;

vi.mock("tamagui", () => {
  const Stack = (props: Record<string, unknown>) => {
    const passed: Record<string, unknown> = {};
    for (const key of PASSTHROUGH_PROPS) {
      if (key in props) passed[key] = props[key];
    }
    return (
      <div
        data-testid={props.testID as string | undefined}
        onClick={props.onPress as (() => void) | undefined}
        {...passed}
      >
        {props.children as ReactNode}
      </div>
    );
  };
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
    // The tag input reads two icon colours off the theme.
    useTheme: () => ({}),
  };
});

vi.mock("@th/ui", () => ({
  // Rendered by the community-listing consent switch beneath the booking one
  // (its FR-005 consequence line). Presence is all this suite needs; the copy
  // and the FR-007 count are pinned in that component's own suite.
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
    <div data-testid={testID} role="status">
      <span>{title}</span>
      <span>{description}</span>
      {children}
    </div>
  ),
  // Chrome for the in-thread venue-confirmation dialogs
  // (`VenueConfirmationActions`, pinned in its own suite). They stay mounted
  // closed, so the stand-ins only need to exist.
  Modal: Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    {
      Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Header: ({ title }: { title: string }) => <h2>{title}</h2>,
      Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  ),
  RadioGroupField: ({ children }: { children?: ReactNode }) => (
    <div role="radiogroup">{children}</div>
  ),
  Radio: ({ label }: { label?: ReactNode }) => <span>{label}</span>,
  CharCountTextarea: () => <textarea />,
  Badge: ({
    children,
    role,
    "aria-label": ariaLabel,
    "data-testid": dataTestId,
  }: {
    children?: ReactNode;
    role?: string;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <span role={role} aria-label={ariaLabel} data-testid={dataTestId}>
      {children}
    </span>
  ),
  // Forwards `aria-hidden` / `tabIndex` for `OpenAgreementButton`, which
  // renders a Button INSIDE an anchor: the real Tamagui Button emits
  // `role="button" tabindex="0"` even as a span, so this stand-in reproduces
  // the nested-interactive hazard faithfully enough for the neutralising
  // attributes to be assertable.
  /**
   * `aria-label` IS FORWARDED. The real atom spreads `rest` onto the element,
   * so it always did — but this mock dropped it, which made every accessible
   * NAME in the inbox unassertable here by construction. That is how a page
   * shipped N buttons all called "Release", each releasing a different night:
   * nothing in this suite could see the name at all.
   */
  Button: ({
    children,
    disabled,
    onPress,
    testID,
    tabIndex,
    "aria-label": ariaLabel,
    "aria-hidden": ariaHidden,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
    tabIndex?: number;
    "aria-label"?: string;
    "aria-hidden"?: boolean;
  }) => (
    <button
      type="button"
      data-testid={testID}
      disabled={disabled}
      onClick={onPress}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
    >
      {children}
    </button>
  ),
  DataTable: ({
    columns,
    rows,
    getRowKey,
    onRowPress,
    renderExpandedRow,
    renderMobileCard,
    rowActions,
    emptyState,
  }: {
    columns: { id: string; header: ReactNode; cell: (row: unknown) => ReactNode }[];
    rows: unknown[];
    getRowKey: (row: unknown) => string;
    onRowPress?: (row: unknown) => void;
    renderExpandedRow?: (row: unknown) => ReactNode;
    renderMobileCard?: (row: unknown) => ReactNode;
    rowActions?: { header?: ReactNode; render?: (row: unknown, index: number) => ReactNode };
    emptyState?: ReactNode;
  }) => (
    <div data-testid="table">
      <div data-testid="table-headers">
        {columns.map((col) => (
          <span key={col.id} data-testid={`header-${col.id}`}>
            {col.header}
          </span>
        ))}
        {rowActions?.header ? <span>{rowActions.header}</span> : null}
      </div>
      {rows.length === 0
        ? emptyState
        : rows.map((row, index) => (
            <div key={getRowKey(row)} data-testid={`row-${getRowKey(row)}`}>
              {/* Card mode REPLACES the table below 600px (and drops the
                  rowActions column with it) — mirror that either/or here. */}
              {cardMode ? (
                <div data-testid={`card-${getRowKey(row)}`}>
                  {renderMobileCard?.(row)}
                </div>
              ) : (
                <>
                  {columns.map((col) => (
                    <div key={col.id} data-testid={`cell-${col.id}-${getRowKey(row)}`}>
                      {col.cell(row)}
                    </div>
                  ))}
                  <div data-testid={`actions-${getRowKey(row)}`}>
                    {rowActions?.render?.(row, index)}
                  </div>
                </>
              )}
              <button
                type="button"
                data-testid={`expand-${getRowKey(row)}`}
                onClick={() => onRowPress?.(row)}
              >
                expand
              </button>
              <div data-testid={`expanded-${getRowKey(row)}`}>
                {renderExpandedRow?.(row)}
              </div>
            </div>
          ))}
    </div>
  ),
  // Forwards `aria-label`: the in-table agreement control is ICON-ONLY, so
  // the anchor's accessible name is the only thing a screen reader gets.
  // forwardRef because CreateEventOutcomeNotice focuses its link on mount.
  NextLinkAnchor: forwardRef<
    HTMLAnchorElement,
    { href: string; children?: ReactNode; "aria-label"?: string }
  >(function NextLinkAnchor({ href, children, "aria-label": ariaLabel }, ref) {
    return (
      <a ref={ref} href={href} aria-label={ariaLabel}>
        {children}
      </a>
    );
  }),
  Spinner: () => <span>loading…</span>,
  // The tag input's typeahead — reduced to its input; the picker's own
  // mechanics are @th/ui's concern.
  AutocompleteField: ({
    query,
    onQueryChange,
    placeholder,
    testIdBase,
  }: {
    query: string;
    onQueryChange: (v: string) => void;
    placeholder?: string;
    testIdBase?: string;
  }) => (
    <input
      data-testid={`${testIdBase}-input`}
      placeholder={placeholder}
      value={query}
      onChange={(e) => onQueryChange(e.currentTarget.value)}
    />
  ),
  DatePicker: ({ value, testId }: { value?: string; testId?: string }) => (
    <input data-testid={testId} value={value ?? ""} readOnly />
  ),
  /**
   * The grouped venue×calendar filter, flattened to a plain multi-select so
   * specs can drive it with `selectOptions`. The real control's popover,
   * tri-state parents and chips are covered by its own unit tests
   * (packages/ui .../__tests__/GroupedMultiSelect.test.ts); what THESE specs
   * care about is that a selection reaches the inbox as a set of calendar ids
   * and narrows the rows and the tab counts.
   */
  GroupedMultiSelect: ({
    groups,
    value,
    onChange,
    label,
    allLabel,
    testIdBase,
  }: {
    groups: { id: string; label: string; options: { id: string; label: string }[] }[];
    value: string[];
    onChange: (next: string[]) => void;
    label?: string;
    allLabel?: string;
    testIdBase?: string;
  }) => (
    <select
      multiple
      data-testid={testIdBase}
      aria-label={label ?? allLabel}
      value={value}
      onChange={(e) =>
        onChange(
          Array.from(e.currentTarget.selectedOptions).map((o) => o.value),
        )
      }
    >
      {groups.flatMap((g) =>
        g.options.map((o) => (
          <option key={o.id} value={o.id}>
            {`${g.label} — ${o.label}`}
          </option>
        )),
      )}
    </select>
  ),
  StyledSelect: ({
    value,
    options,
    onChange,
    testId,
    ariaLabel,
    selectId,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
    testId?: string;
    ariaLabel?: string;
    selectId?: string;
  }) => (
    <select
      id={selectId}
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  // Mounted by the REAL BookingAcceptanceToggle in the place scope.
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    testId,
    "aria-label": ariaLabel,
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    disabled?: boolean;
    testId?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      switch
    </button>
  ),
  Text: ({
    children,
    testID,
    role,
  }: {
    children?: ReactNode;
    testID?: string;
    role?: string;
  }) => (
    <span data-testid={testID} role={role}>
      {children}
    </span>
  ),
  TextInput: ({
    value,
    onChangeText,
    testID,
    testId,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
    testID?: string;
    testId?: string;
    placeholder?: string;
  }) => (
    <input
      data-testid={testID ?? testId}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.currentTarget.value)}
    />
  ),
  useFormatters: () => ({
    dateTime: (d: Date) => new Date(d).toISOString().slice(0, 10),
    locale: "en-US",
  }),
  useNotify: () => ({
    toast: {
      success: testMocks.toastSuccess,
      danger: testMocks.toastDanger,
      warning: testMocks.toastWarning,
    },
  }),
  // Key-echo translator: arg-less keys echo verbatim; interpolated ones
  // append `name=value` so a count reaching the message is visible.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values
      ? `${key} ${Object.entries(values)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(" ")}`
      : key,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) => `$${cents / 100}`,
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
    description: ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <div>{title}</div>
        <div data-testid="dialog-description">{description}</div>
        <div data-testid="dialog-confirm-label">{confirmLabel}</div>
        <button type="button" data-testid="dialog-confirm" onClick={onConfirm}>
          confirm
        </button>
      </div>
    ) : null,
}));

// The website booking-button section is a self-contained embed manager with
// its own queries. Stubbed so this suite stays about the inbox; the toggle
// beside it is mounted FOR REAL, because "the switch is on the bookings page"
// is a thing this suite pins.
vi.mock(
  "@/app/admin/[slug]/places/[placeId]/bookings/_components/BookingEmbedSection",
  () => ({
    // THREE-state probe, not two. `null` means the place read was refused, and
    // the real section must suppress its "booking requests are off" note in
    // that case — a two-state probe would report the bug as passing.
    BookingEmbedSection: ({
      acceptsBookingRequests,
    }: {
      acceptsBookingRequests: boolean | null;
    }) => (
      <div
        data-testid="booking-embed-section"
        data-accepts={
          acceptsBookingRequests === null
            ? "unknown"
            : acceptsBookingRequests
              ? "true"
              : "false"
        }
      />
    ),
  }),
);

// The hours modal (availability-onboarding FR-002) rides inside the REAL
// acceptance toggle but is a self-contained surface with its own reads and
// writes (presets, the hours editor). Stubbed so this suite stays about the
// inbox — the toggle's own warning still renders for real off the
// `getAvailabilitySetupState` mock above.
vi.mock(
  "@/app/admin/[slug]/places/[placeId]/calendars/_components/SetHoursModal",
  () => ({
    SetHoursModal: ({ open }: { open: boolean }) =>
      open ? <div data-testid="set-hours-modal" /> : null,
  }),
);

// The terms strip's deal summary reads `deals.getTermsDeal`; its logic is
// covered in `components/deals`. Here it is a slot.
vi.mock("@/components/deals", () => ({ DealSummary: () => null }));

import { BookingInbox, type BookingInboxProps } from "../BookingInbox";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VENUES = [
  {
    placeId: "place-1",
    placeName: "The Spot",
    openCount: 1,
    calendars: [{ id: "cal-place-1", name: "Main Calendar" }],
  },
  {
    placeId: "place-2",
    placeName: "Exit/In",
    openCount: 1,
    calendars: [{ id: "cal-place-2", name: "Main Calendar" }],
  },
];

/**
 * Drive the (mocked) grouped venue×calendar filter. The real control is a
 * popover of tri-state checkboxes; the mock flattens it to a `multiple`
 * select, so a spec picks calendar ids and the component receives the same
 * flat id list either way.
 */
function selectCalendars(calendarIds: string[]) {
  const el = screen.getByTestId("bookings-venue-filter") as HTMLSelectElement;
  for (const option of Array.from(el.options)) {
    option.selected = calendarIds.includes(option.value);
  }
  fireEvent.change(el);
}

function makeRow(overrides: Record<string, unknown> = {}) {
  const placeId = (overrides.placeId as string | undefined) ?? "place-1";
  return {
    id: "row-owned",
    placeId,
    placeName: "The Spot",
    // The grouped filter selects CALENDARS, so every row needs one. Derived
    // from the place so a spec that only overrides `placeId` still lines up
    // with the venue fixtures' calendar ids.
    calendarId: `cal-${placeId}`,
    calendarName: "Main Calendar",
    performerOwnerType: "human",
    performerOwnerId: "11111111-1111-1111-1111-111111111111",
    performerDisplayName: "Owned Performer",
    contactName: null,
    contactEmail: null,
    claimedAt: null,
    // booking-inquirer-outreach: null on every row that never had a venue
    // reply emailed out, which is every row unless a spec says otherwise.
    inquirerEmailUndeliverableAt: null,
    inquirerEmailUndeliverableStatus: null,
    source: "PLATFORM",
    message: "We want to play a show.",
    preferredDates: ["2026-08-01"],
    expectedDraw: null,
    genre: null,
    links: [],
    actName: null,
    lineupSize: null,
    setLengthMinutes: null,
    contactPhone: null,
    techNeeds: null,
    feeType: null,
    feeAmountCents: null,
    feeCurrency: null,
    status: "VIEWED",
    viewedAt: new Date("2026-07-02T12:00:00Z"),
    respondedAt: null,
    declineReason: null,
    agreementId: null,
    // The stage projection. Nulled by default so the fixture mirrors the
    // server contract's "not there yet OR we could not tell".
    agreementStatus: null,
    eventId: null,
    eventStatus: null,
    eventStartsAt: null,
    // venue-confirmation spec: every row carries the intent and the venue's
    // stance on its event. `none` with no event is the wire's "nothing yet".
    intent: "PERFORM",
    venueConfirmation: { state: "none", eventId: null, ownerSide: null },
    linkMusic: null,
    linkVideo: null,
    linkSocial: null,
    linkEpk: null,
    expiresAt: null,
    createdAt: new Date("2026-07-01T12:00:00Z"),
    verifiedStatsSnapshot: null,
    unreadMessageCount: 0,
    // booking-holds spec: every row carries these three.
    holds: [],
    assigneeHumanId: null,
    tags: [],
    ...overrides,
  };
}

const ownedRow = () => makeRow();

const anonymousRow = () =>
  makeRow({
    id: "row-anon",
    performerOwnerType: null,
    performerOwnerId: null,
    performerDisplayName: "Jo Blow",
    contactName: "Jo Blow",
    contactEmail: "jo@example.com",
    source: "EMBED",
  });

/**
 * The SAME inquiry after the venue's first reply attached a shadow owner pair
 * (booking-inquirer-outreach). Still unclaimed — every anonymous affordance
 * (mailto, resend invite, no agreement CTAs) must survive the flip.
 */
const shadowOwnedInquiryRow = () =>
  makeRow({
    id: "row-anon",
    performerOwnerType: "human",
    performerOwnerId: "22222222-2222-4222-8222-222222222222",
    performerDisplayName: null,
    contactName: "Jo Blow",
    contactEmail: "jo@example.com",
    claimedAt: null,
    source: "EMBED",
  });

/** An ACCEPTED agreement, as `bookingAgreements.get` returns it. */
function acceptedAgreement(overrides: Record<string, unknown> = {}) {
  return {
    agreement: {
      status: "ACCEPTED",
      counterpartyType: "organization",
      counterpartyId: "org-1",
      counterpartyDisplayName: "The Spot",
      proposerDisplayName: "Owned Performer",
      proposedDate: new Date("2026-09-19T00:00:00.000Z"),
      proposedEndDate: null,
      guaranteeCents: 65000,
      ...overrides,
    },
    bookingRequest: { preferredDates: ["2026-08-01"] },
    pitchProvenance: null,
    mayEdit: false,
  };
}

function renderPlace(props: Partial<BookingInboxProps> = {}) {
  return render(
    <BookingInbox
      scope={{ kind: "place", placeId: "place-1" }}
      slug="acme"
      {...props}
    />,
  );
}

function renderOrg(props: Partial<BookingInboxProps> = {}) {
  return render(
    <BookingInbox
      scope={{ kind: "org-venues", orgId: "org-1" }}
      slug="acme"
      venues={VENUES}
      venuesTruncated={false}
      venuesLoading={false}
      venuesError={false}
      onRetryVenues={vi.fn()}
      {...props}
    />,
  );
}

/** The personal admin's cross-venue inbox — same chrome, no id in the scope. */
function renderHuman(props: Partial<BookingInboxProps> = {}) {
  return render(
    <BookingInbox
      scope={{ kind: "human-venues" }}
      slug="acme"
      venues={VENUES}
      venuesTruncated={false}
      venuesLoading={false}
      venuesError={false}
      onRetryVenues={vi.fn()}
      {...props}
    />,
  );
}

/** Everything multi-venue must hold for BOTH cross-venue scopes. */
const MULTI_VENUE: [string, typeof renderOrg][] = [
  ["org-venues", renderOrg],
  ["human-venues", renderHuman],
];

function expandRow(id: string) {
  fireEvent.click(screen.getByTestId(`expand-${id}`));
}

function switchTab(tab: "open" | "agreement" | "event" | "closed") {
  fireEvent.click(screen.getByTestId(`booking-inbox-tab-${tab}`));
}

function pressed(tab: string): boolean {
  return (
    screen.getByTestId(`booking-inbox-tab-${tab}`).getAttribute("aria-pressed") ===
    "true"
  );
}

function tabLabel(tab: string): string {
  return screen.getByTestId(`booking-inbox-tab-${tab}`).textContent ?? "";
}

/**
 * Stand in for the respond mutation succeeding, echoing the real
 * `respondToBookingRequestOutputSchema` payload — `agreementId` is what the
 * accept toast's link is built from.
 */
function mockRespondSuccess(result: Record<string, unknown>) {
  testMocks.respondMutate.mockImplementation(
    (
      _input: unknown,
      opts: { onSuccess: (r: unknown) => void; onSettled?: () => void },
    ) => {
      opts.onSuccess(result);
      opts.onSettled?.();
    },
  );
}

function acceptRow(id: string) {
  expandRow(id);
  fireEvent.click(screen.getByTestId(`booking-accept-${id}`));
  fireEvent.click(screen.getByTestId("dialog-confirm"));
}

// A FRESH element per rerender: React bails out of a render whose element
// (and so props object) is the one it already has, and the mocked query
// flags would never reach the component.
const PLACE = () => <BookingInbox scope={{ kind: "place", placeId: "place-1" }} slug="acme" />;

/** A refetch that STARTS, then lands `requests` without error. */
function deliverList(rerender: (ui: React.ReactElement) => void, requests: unknown[]) {
  listFetching = true;
  rerender(PLACE());
  listRequests = requests;
  listUpdatedAt += 1000;
  listFetching = false;
  rerender(PLACE());
}

/** A refetch that STARTS, then fails — data untouched, error stamped. */
function failList(rerender: (ui: React.ReactElement) => void) {
  listFetching = true;
  rerender(PLACE());
  listError = new Error("boom");
  listErrorUpdatedAt = Date.now() + 1;
  listFetching = false;
  rerender(PLACE());
}

/**
 * Open the month picker on a row and pick the first night it will take.
 * `aria-pressed` is only set on a SELECTABLE cell, so it doubles as the
 * "this day is on offer" selector — a past, dark or taken day carries
 * `aria-disabled` and no pressed state.
 */
function openPickerAndChooseADate(id: string): string {
  fireEvent.click(screen.getByTestId(`expand-${id}`));
  fireEvent.click(screen.getByTestId(`booking-holds-${id}-place`));
  const day = document.querySelector<HTMLButtonElement>(
    `[data-testid^="booking-holds-${id}-place-day-"][aria-pressed="false"]`,
  );
  if (!day) throw new Error("the month offered no holdable night");
  fireEvent.click(day);
  return day.dataset.date!;
}

/** Place a hold on `r-acc` from its expanded Agreement row and report success. */
function placeHoldOn(id: string) {
  const date = openPickerAndChooseADate(id);
  fireEvent.click(screen.getByTestId(`booking-holds-${id}-place-submit`));
  const opts = testMocks.holdMutate.mock.calls.at(-1)![1] as {
    onSuccess: (r: unknown) => void;
  };
  act(() =>
    opts.onSuccess({
      placed: [{ id: "hold-new", position: 1, date }],
      failed: [],
    }),
  );
  expect(testMocks.listInvalidate).toHaveBeenCalled();
}

const accRowOnAgreement = () =>
  makeRow({ id: "r-acc", status: "ACCEPTED", agreementStatus: "DRAFT", holds: [] });
const accRowOnHolds = () =>
  makeRow({
    id: "r-acc",
    status: "ACCEPTED",
    agreementStatus: "DRAFT",
    holds: [liveHold({ id: "hold-new", position: 1 })],
  });

function mailtoLinks(container: HTMLElement) {
  return container.querySelectorAll('a[href^="mailto:"]');
}

beforeEach(() => {
  vi.clearAllMocks();
  listRequests = [];
  listExtra = {};
  listUpdatedAt = 0;
  listFetching = false;
  listError = null;
  listErrorUpdatedAt = 0;
  currentAdminOwner = null;
  agreementData = undefined;
  ownersWithSlugs = undefined;
  cardMode = false;
  requestParam = null;
  placeData = {
    place: {
      placeId: "place-1",
      verificationStatus: "VERIFIED",
      acceptsBookingRequests: true,
      viewerCanManageSwitches: true,
    },
  };
  placeError = null;
  // Apply cache writes for real. The component corrects the cached row to
  // ACCEPTED before the refetch lands so the tab it switches to isn't empty
  // for a round-trip; a `setData` stub that swallowed the write would make
  // "the row is still on screen" untestable here.
  testMocks.listSetData.mockImplementation(
    (
      _input: unknown,
      updater: (prev: { requests: unknown[] }) => { requests: unknown[] } | undefined,
    ) => {
      const next = updater({ requests: listRequests, ...listExtra });
      if (next) listRequests = next.requests;
    },
  );
});

// ── Scope: the data each scope asks for ──────────────────────────────────────

describe("BookingInbox — one component, three scopes", () => {
  it("place scope queries the venue list for that place", () => {
    renderPlace();
    expect(testMocks.listUseQuery.mock.calls[0]![0]).toEqual({
      scope: "venue",
      placeId: "place-1",
    });
  });

  it("org-venues scope queries the org's owned venues", () => {
    renderOrg();
    expect(testMocks.listUseQuery.mock.calls[0]![0]).toEqual({
      scope: "org-venues",
      orgId: "org-1",
    });
  });

  it("human-venues scope needs no id — the owner IS the actor", () => {
    render(<BookingInbox scope={{ kind: "human-venues" }} slug="@me" />);
    expect(testMocks.listUseQuery.mock.calls[0]![0]).toEqual({
      scope: "human-venues",
    });
  });

  it("renders NO Venue column or filter for the place scope", () => {
    listRequests = [ownedRow()];
    renderPlace();
    expect(screen.queryByTestId("header-venue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bookings-venue-filter")).not.toBeInTheDocument();
  });

  it("renders the acceptance switch and embed section for the place scope ONLY", () => {
    listRequests = [ownedRow()];
    const org = renderOrg();
    expect(screen.queryByTestId("booking-acceptance-switch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("booking-embed-section")).not.toBeInTheDocument();
    org.unmount();

    renderPlace();
    const toggle = screen.getByTestId("booking-acceptance-switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("booking-embed-section")).toBeInTheDocument();
    // DOM order is the placement claim: the switch precedes the tabs.
    const tabs = screen.getByRole("group", { name: "admin.bkWsFilterLabel" });
    expect(
      toggle.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("flips the switch through places.setBookingAcceptance", () => {
    listRequests = [ownedRow()];
    renderPlace();
    fireEvent.click(screen.getByTestId("booking-acceptance-switch"));
    expect(testMocks.setAcceptanceMutate).toHaveBeenCalledWith({
      placeId: "place-1",
      accepts: false,
    });
  });

  // The toggles self-fetch `places.getPlaceForEdit`, so the inbox needs no
  // prop of its own for the write bar — but "needs no prop" is worth PROVING
  // here rather than assuming, because the inbox is the surface a VIEWER
  // actually lands on.
  it("shows both switches locked on the inbox when the viewer is below the write bar", () => {
    listRequests = [ownedRow()];
    placeData = {
      place: {
        placeId: "place-1",
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: true,
        acceptsCommunityListings: false,
        viewerCanManageSwitches: false,
      },
    };
    renderPlace();

    expect(screen.getByTestId("booking-acceptance-switch")).toBeDisabled();
    expect(
      screen.getByTestId("community-listing-acceptance-switch"),
    ).toBeDisabled();
    fireEvent.click(screen.getByTestId("booking-acceptance-switch"));
    expect(testMocks.setAcceptanceMutate).not.toHaveBeenCalled();
  });

  it("feeds the embed section the same acceptance value", () => {
    listRequests = [ownedRow()];
    placeData = {
      place: {
        placeId: "place-1",
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: false,
        viewerCanManageSwitches: true,
      },
    };
    renderPlace();
    expect(screen.getByTestId("booking-embed-section")).toHaveAttribute(
      "data-accepts",
      "false",
    );
  });

  /**
   * THE ROLE THAT REACHES THIS PAGE AND IS REFUSED THE PLACE READ.
   *
   * `listBookingRequests` scope `venue` admits any member of an owning org, so
   * a SCANNER gets the inbox; `places.getPlaceForEdit` sits at
   * `canManagePlace`, so they do not get the place. The inbox must say NOTHING
   * about the venue's booking state in that window — it does not know it.
   *
   * This asserts the absence of a claim, which is the whole point: `?? false`
   * turned "we could not read it" into "your venue is off", about a venue
   * whose requests are ON, and pointed at a switch that is not on the page
   * (the toggle returns null on the same error).
   */
  it("says NOTHING about acceptance when the place read is refused", () => {
    listRequests = [ownedRow()];
    placeError = { data: { code: "FORBIDDEN" }, message: "NOT_RESOURCE_OWNER" };
    renderPlace();

    // Not "false" — "unknown". `?? false` fails here.
    expect(screen.getByTestId("booking-embed-section")).toHaveAttribute(
      "data-accepts",
      "unknown",
    );
    // And the switch the false note would have pointed at is genuinely absent.
    expect(screen.queryByTestId("booking-acceptance-switch")).toBeNull();
  });

  it("makes no empty-state claim either when the place read is refused", () => {
    listRequests = [];
    placeError = { data: { code: "FORBIDDEN" }, message: "NOT_RESOURCE_OWNER" };
    renderPlace();

    // Title only. None of the three cause sentences may render, because we
    // cannot tell which one is true.
    expect(screen.getByText("admin.bkInboxEmptyTitle")).toBeInTheDocument();
    expect(screen.queryByText("admin.bkInboxEmptyBodyOff")).toBeNull();
    expect(screen.queryByText("admin.bkInboxEmptyBodyOn")).toBeNull();
    expect(screen.queryByText("admin.bkInboxEmptyBodyUnverified")).toBeNull();
    expect(screen.queryByTestId("booking-inbox-verify-cta")).toBeNull();
  });
});

// ── Stage tabs ───────────────────────────────────────────────────────────────

describe("BookingInbox — stage tabs: where the booking IS", () => {
  const inboxRows = () => [
    makeRow({ id: "r-pending", status: "PENDING" }),
    makeRow({ id: "r-viewed", status: "VIEWED" }),
    makeRow({
      id: "r-agreement",
      status: "ACCEPTED",
      agreementId: "ag-1",
      agreementStatus: "DRAFT",
    }),
    makeRow({
      id: "r-event",
      status: "ACCEPTED",
      agreementId: "ag-2",
      agreementStatus: "ACCEPTED",
      eventId: "ev-1",
      eventStatus: "DRAFT",
      eventStartsAt: new Date(2026, 7, 1),
    }),
    makeRow({ id: "r-declined", status: "DECLINED" }),
    makeRow({ id: "r-withdrawn", status: "WITHDRAWN" }),
  ];

  it("counts what each tab actually filters, in both scopes", () => {
    listRequests = inboxRows();
    const org = renderOrg();
    expect(tabLabel("open")).toBe("admin.bkInboxTabOpen (2)");
    expect(tabLabel("agreement")).toBe("admin.bkInboxTabAgreement (1)");
    expect(tabLabel("event")).toBe("admin.bkInboxTabEvent (1)");
    expect(tabLabel("closed")).toBe("admin.bkInboxTabClosed (2)");
    org.unmount();

    renderPlace();
    expect(tabLabel("open")).toBe("admin.bkInboxTabOpen (2)");
    expect(tabLabel("closed")).toBe("admin.bkInboxTabClosed (2)");
  });

  it("shows exactly the rows each count promises", () => {
    listRequests = inboxRows();
    renderPlace();

    expect(screen.getByTestId("row-r-pending")).toBeInTheDocument();
    expect(screen.getByTestId("row-r-viewed")).toBeInTheDocument();
    expect(screen.queryByTestId("row-r-agreement")).not.toBeInTheDocument();

    switchTab("agreement");
    expect(screen.getByTestId("row-r-agreement")).toBeInTheDocument();
    expect(screen.queryByTestId("row-r-event")).not.toBeInTheDocument();

    switchTab("event");
    expect(screen.getByTestId("row-r-event")).toBeInTheDocument();
    expect(screen.queryByTestId("row-r-agreement")).not.toBeInTheDocument();

    switchTab("closed");
    expect(screen.getByTestId("row-r-declined")).toBeInTheDocument();
    expect(screen.getByTestId("row-r-withdrawn")).toBeInTheDocument();
    expect(screen.queryByTestId("row-r-pending")).not.toBeInTheDocument();
  });

  it("lands on the first NON-EMPTY tab in slot order", () => {
    listRequests = [
      makeRow({ id: "r-agreement", status: "ACCEPTED", agreementId: "ag-1" }),
      makeRow({ id: "r-declined", status: "DECLINED" }),
    ];
    renderPlace();
    expect(pressed("agreement")).toBe(true);
    expect(screen.getByTestId("row-r-agreement")).toBeInTheDocument();
  });

  it("LATCHES the landing tab — answering the last open request never moves the user", () => {
    listRequests = [ownedRow()];
    mockRespondSuccess({ bookingRequestId: "row-owned", status: "DECLINED" });
    const { rerender } = renderPlace();
    expect(pressed("open")).toBe(true);

    expandRow("row-owned");
    fireEvent.click(screen.getByTestId("booking-decline-row-owned"));
    fireEvent.change(screen.getByTestId("booking-decline-reason-row-owned"), {
      target: { value: "Calendar is full" },
    });
    fireEvent.click(screen.getByTestId("booking-decline-confirm-row-owned"));

    // The refetch lands: the only row is now closed. Open has 0 — and the
    // view stays on Open, showing its empty-tab copy, rather than jumping.
    listRequests = [makeRow({ status: "DECLINED" })];
    rerender(<BookingInbox scope={{ kind: "place", placeId: "place-1" }} slug="acme" />);
    expect(pressed("open")).toBe(true);
    expect(screen.getByText("admin.bkInboxEmptyOpen")).toBeInTheDocument();
  });

  it("drops a venue selection whose venue stopped being owned", () => {
    listRequests = [
      ownedRow(),
      makeRow({ id: "row-2", placeId: "place-2", placeName: "Exit/In" }),
    ];
    const { rerender } = renderOrg();
    selectCalendars(["cal-place-2"]);
    expect(screen.queryByTestId("row-row-owned")).not.toBeInTheDocument();

    rerender(
      <BookingInbox
        scope={{ kind: "org-venues", orgId: "org-1" }}
        slug="acme"
        venues={[VENUES[0]!, {
          placeId: "place-3",
          placeName: "The 5 Spot",
          openCount: 0,
          calendars: [{ id: "cal-place-3", name: "Main Calendar" }],
        }]}
        onRetryVenues={vi.fn()}
      />,
    );
    // The dropped selection reads as NO filter — both rows are back.
    expect(screen.getByTestId("row-row-owned")).toBeInTheDocument();
    expect(screen.getByTestId("row-row-2")).toBeInTheDocument();
  });

  it("distinguishes an empty TAB from an empty inbox", () => {
    listRequests = [ownedRow()];
    renderPlace();
    switchTab("event");
    expect(screen.getByText("admin.bkInboxEmptyEvent")).toBeInTheDocument();
    expect(screen.queryByText("admin.bkInboxEmptyTitle")).not.toBeInTheDocument();
  });
});

// ── Multi-venue chrome, for BOTH cross-venue scopes ──────────────────────────

describe.each(MULTI_VENUE)("BookingInbox — multi-venue chrome (%s)", (_kind, renderMulti) => {
  it("renders the Venue column, names each row's venue, and offers the filter", () => {
    listRequests = [
      ownedRow(),
      makeRow({ id: "row-2", placeId: "place-2", placeName: "Exit/In" }),
    ];
    renderMulti();
    expect(screen.getByTestId("header-venue")).toBeInTheDocument();
    expect(screen.getByTestId("cell-venue-row-owned")).toHaveTextContent("The Spot");
    expect(screen.getByTestId("cell-venue-row-2")).toHaveTextContent("Exit/In");
    expect(screen.getByTestId("bookings-venue-filter")).toBeInTheDocument();
  });

  it("renders no acceptance switch and no embed section — those are place settings", () => {
    listRequests = [ownedRow()];
    renderMulti();
    expect(screen.queryByTestId("booking-acceptance-switch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("booking-embed-section")).not.toBeInTheDocument();
  });

  it("counts within the VENUE FILTER, not across every venue", () => {
    listRequests = [
      ownedRow(),
      makeRow({ id: "row-2", placeId: "place-2", placeName: "Exit/In" }),
    ];
    renderMulti();
    expect(tabLabel("open")).toBe("admin.bkInboxTabOpen (2)");

    selectCalendars(["cal-place-2"]);
    expect(tabLabel("open")).toBe("admin.bkInboxTabOpen (1)");
    expect(screen.queryByTestId("row-row-owned")).not.toBeInTheDocument();
    expect(screen.getByTestId("row-row-2")).toBeInTheDocument();

    // Back to every venue — the default, so nothing is hidden behind a choice.
    selectCalendars([]);
    expect(screen.getByTestId("row-row-owned")).toBeInTheDocument();
  });

  it("points at the FILTER when a chosen venue is the empty one", () => {
    listRequests = [ownedRow()];
    renderMulti();
    selectCalendars(["cal-place-2"]);
    expect(screen.getByText("admin.bkWsVenEmptyFiltered")).toBeInTheDocument();
  });

  it("shows the cross-venue onboarding state with its venues CTA", () => {
    renderMulti();
    expect(screen.getByText("admin.bkWsVenEmptyTitle")).toBeInTheDocument();
    expect(screen.getByText("admin.bkWsVenEmptyCta")).toBeInTheDocument();
    expect(screen.queryByText("admin.bkInboxEmptyTitle")).not.toBeInTheDocument();
  });

  it("names the venue on the mobile card", () => {
    cardMode = true;
    listRequests = [ownedRow()];
    renderMulti();
    expect(screen.getByTestId("card-row-owned")).toHaveTextContent("The Spot");
  });

  it("points an accepted anonymous row at the venue's own inbox for resends", () => {
    listRequests = [{ ...anonymousRow(), status: "ACCEPTED" }];
    const { container } = renderMulti();
    expandRow("row-anon");
    expect(screen.queryByTestId("booking-resend-invite-row-anon")).not.toBeInTheDocument();
    expect(
      container.querySelector('a[href="/admin/acme/places/place-1/bookings"]'),
    ).toHaveAttribute("aria-label", "admin.bkWsVenueViewAria venue=The Spot");
  });

  it("surfaces truncation from the LIST read, the COUNT read, and a FAILED venue read", () => {
    listRequests = [ownedRow()];
    listExtra = { ownedPlacesTruncated: true };
    const a = renderMulti();
    expect(screen.getByTestId("hub-venues-truncated")).toHaveTextContent(
      "admin.bkWsVenuesTruncated count=2",
    );
    a.unmount();

    listExtra = {};
    const b = renderMulti({ venuesTruncated: true });
    expect(screen.getByTestId("hub-venues-truncated")).toBeInTheDocument();
    b.unmount();

    listExtra = { ownedPlacesTruncated: true };
    renderMulti({ venues: [], venuesError: true });
    expect(screen.getByTestId("hub-venues-retry")).toBeInTheDocument();
    expect(screen.getByTestId("hub-venues-truncated")).toHaveTextContent(
      "admin.bkWsVenuesTruncatedUnknown",
    );
  });

  it("stays quiet when neither read was truncated", () => {
    listRequests = [ownedRow()];
    renderMulti();
    expect(screen.queryByTestId("hub-venues-truncated")).not.toBeInTheDocument();
  });
});

// ── Empty states ─────────────────────────────────────────────────────────────

describe("BookingInbox — onboarding empty state names the real blocker (place)", () => {
  it("blames verification — and offers the one fix this page cannot do inline", () => {
    placeData = {
      place: {
        placeId: "place-1",
        verificationStatus: "UNVERIFIED",
        acceptsBookingRequests: false,
        viewerCanManageSwitches: true,
      },
    };
    renderPlace();
    expect(screen.getByText("admin.bkInboxEmptyBodyUnverified")).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: "admin.bkInboxEmptyVerifyCta" });
    expect(cta).toHaveAttribute(
      "href",
      "/admin/acme/places/place-1/settings#verification",
    );
    expect(screen.getByTestId("booking-inbox-verify-cta")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("booking-inbox-verify-cta")).toHaveAttribute("tabindex", "-1");
  });

  it("blames the switch — and does NOT offer a button for a control 200px above", () => {
    placeData = {
      place: {
        placeId: "place-1",
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: false,
        viewerCanManageSwitches: true,
      },
    };
    renderPlace();
    expect(screen.getByText("admin.bkInboxEmptyBodyOff")).toBeInTheDocument();
    expect(screen.queryByTestId("booking-inbox-verify-cta")).not.toBeInTheDocument();
  });

  it("says nothing it cannot know while the place is still loading", () => {
    placeData = undefined;
    renderPlace();
    expect(screen.getByText("admin.bkInboxEmptyTitle")).toBeInTheDocument();
    for (const key of [
      "admin.bkInboxEmptyBodyOn",
      "admin.bkInboxEmptyBodyOff",
      "admin.bkInboxEmptyBodyUnverified",
    ]) {
      expect(screen.queryByText(key)).not.toBeInTheDocument();
    }
  });

});

// ── Rows ─────────────────────────────────────────────────────────────────────

describe("BookingInbox — owned rows (regression pin)", () => {
  it("renders the performer name with NO source badge and NO mailto link", () => {
    listRequests = [ownedRow()];
    const { container } = renderPlace();
    expect(screen.getByText("Owned Performer")).toBeInTheDocument();
    expect(screen.queryByText("admin.bkWsVenAnonSource")).not.toBeInTheDocument();
    expandRow("row-owned");
    expect(mailtoLinks(container)).toHaveLength(0);
  });

  it("owned ACCEPTED row shows the agreement link and NO invite box", () => {
    listRequests = [makeRow({ status: "ACCEPTED", agreementId: "ag-1" })];
    const { container } = renderPlace();
    expandRow("row-owned");
    expect(container.querySelector('a[href="/admin/acme/bookings/agreement/ag-1"]')).not.toBeNull();
    expect(screen.getByText("admin.baInboxAcceptedNote")).toBeInTheDocument();
    expect(screen.queryByText("admin.bkWsVenInviteSent")).not.toBeInTheDocument();
  });

  it("reads the agreement for an accepted row's thread, keyed on that agreement", () => {
    listRequests = [makeRow({ status: "ACCEPTED", agreementId: "ag-1" })];
    renderPlace();
    expandRow("row-owned");
    expect(testMocks.agreementUseQuery).toHaveBeenCalledWith({ agreementId: "ag-1" });
  });

  it("issues no agreement read for a request that has none", () => {
    listRequests = [ownedRow()];
    renderPlace();
    expandRow("row-owned");
    expect(testMocks.agreementUseQuery).not.toHaveBeenCalled();
    expect(screen.queryByTestId("booking-thread-row-owned-terms")).not.toBeInTheDocument();
  });

  it("mounts the conversation as the VENUE side with the shell slug", () => {
    listRequests = [ownedRow()];
    renderPlace();
    expandRow("row-owned");
    expect(screen.getByTestId("booking-thread-row-owned")).toBeInTheDocument();
  });

  it("keeps the thread on a TERMINAL request — it is the booking's history", () => {
    listRequests = [makeRow({ status: "DECLINED", declineReason: "Booked" })];
    renderPlace();
    switchTab("closed");
    expandRow("row-owned");
    expect(screen.getByTestId("booking-thread-row-owned")).toBeInTheDocument();
    expect(screen.getByText("admin.bkInboxDeclinedNote reason=Booked")).toBeInTheDocument();
  });
});

describe("BookingInbox — anonymous rows (FR-006/FR-007)", () => {
  it("renders contactName, the source badge and the mailto affordance", () => {
    listRequests = [anonymousRow()];
    const { container } = renderPlace();
    expect(screen.getByText("Jo Blow")).toBeInTheDocument();
    expect(screen.getByText("admin.bkWsVenAnonSource")).toBeInTheDocument();
    expandRow("row-anon");
    const links = mailtoLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "mailto:jo@example.com");
  });

  // ── The venue's only way to answer an unclaimed inquiry ────────────────
  // THE REGRESSION THIS FILE MISSED. The Conversation used to be gated behind
  // `!isAnonymous`, on a comment claiming the thread had nobody to authorize.
  // It was wrong about the VENUE half: both gates in `thread-access.ts` return
  // on `side === "VENUE"` before the unclaimed-inquiry refusal, which lives in
  // the PERFORMER branch. The result was a shipped, reviewed, green email-relay
  // feature with no composer anywhere in the product to trigger it.
  it("MOUNTS the conversation on an unclaimed anonymous inquiry — the venue may write", () => {
    listRequests = [anonymousRow()];
    renderPlace();
    expandRow("row-anon");
    expect(screen.getByTestId("booking-thread-row-anon")).toBeInTheDocument();
    expect(screen.getByTestId("booking-thread-row-anon-input")).toBeInTheDocument();
    expect(screen.getByTestId("booking-thread-row-anon-send")).toBeInTheDocument();
  });

  // ── The list advertised a hold the detail then refused to show ────────
  // SAME CLASS AS THE CONVERSATION GATE ABOVE, and the same shape of wrong
  // reason. The holds strip was gated on `!isAnonymous` because "a hold
  // notifies the act, and an unclaimed sender has no account to notify". The
  // notify half is true and is precisely why it is not a reason to hide the
  // line: `notify-booking-hold-intents` SKIPS the act leg for an unclaimed
  // inquiry BY DESIGN (`booking_holds.notify.anonymous_act_skipped`), no
  // placement path refuses one, and `seed/booking-requests.ts` ships an
  // anonymous PENDING request holding a date on purpose. So the Stage column
  // printed "Oct 13 · 1st hold" and expanding the row showed no holds section
  // at all — staff could see the night was taken and could not reach it.
  it("an unclaimed inquiry's hold is REACHABLE — the list and the detail agree", () => {
    const held = {
      id: "h-anon",
      calendarId: "cal-1",
      date: "2026-10-13",
      position: 1,
      status: "ACTIVE" as const,
      respondBy: null,
      lapsed: false,
    };
    listRequests = [{ ...anonymousRow(), holds: [held] }];
    renderPlace();

    // The list cell's claim.
    expect(
      screen.getByTestId("booking-inbox-row-row-anon-hold-h-anon"),
    ).toBeInTheDocument();

    // ...which the detail must honour rather than contradict.
    expandRow("row-anon");
    expect(screen.getByTestId("booking-holds-row-anon-row-h-anon")).toBeInTheDocument();
    // The sentence itself, not its test id: this suite's `Text` mock forwards
    // `testID` only, and "the explanation is on screen" is the actual claim.
    expect(screen.getByText("admin.bkHoldsUnclaimedNoteBooking")).toBeInTheDocument();

    // Release stays live — the server honours it and it is the action a venue
    // chasing an unclaimed inquirer actually needs. Confirm does not: the
    // server refuses it with HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST.
    expect(screen.getByTestId("booking-holds-row-anon-release-h-anon")).not.toBeDisabled();
    // P5-fixes: booking an unclaimed request is refused, so neither booking
    // action is offered (and the retired hold Confirm is gone everywhere).
    expect(screen.queryByTestId("booking-holds-row-anon-book-h-anon")).toBeNull();
    expect(screen.queryByTestId("booking-holds-row-anon-confirm-h-anon")).toBeNull();

    // And no NEW hold is offered on an inquiry nobody can be told about —
    // unchanged from before this fix, deliberately.
    expect(screen.queryByTestId("booking-holds-row-anon-place")).toBeNull();
  });

  it("says the thread is a RELAY to email, naming the address and the return path", () => {
    listRequests = [anonymousRow()];
    renderPlace();
    expandRow("row-anon");
    const note = screen.getByTestId("booking-thread-row-anon-email-relay");
    expect(note).toHaveTextContent("admin.bkWsVenThreadRelayLabel");
    // Both interpolated: a venue that cannot see WHICH address this leaves for
    // cannot tell an in-app message from an email, which is the whole point.
    expect(note).toHaveTextContent(
      "admin.bkWsVenThreadRelayBody name=Jo Blow email=jo@example.com",
    );
    expect(note).not.toHaveTextContent("admin.bkWsVenThreadRelayFailedBody");
  });

  it("keeps the mailto AND the thread — two channels, not a replacement", () => {
    listRequests = [anonymousRow()];
    const { container } = renderPlace();
    expandRow("row-anon");
    expect(mailtoLinks(container)).toHaveLength(1);
    expect(screen.getByTestId("booking-thread-row-anon")).toBeInTheDocument();
  });

  it("mounts NO relay note on an owned request — that thread is a real chat", () => {
    listRequests = [ownedRow()];
    renderPlace();
    expandRow("row-owned");
    expect(screen.getByTestId("booking-thread-row-owned")).toBeInTheDocument();
    expect(
      screen.queryByTestId("booking-thread-row-owned-email-relay"),
    ).not.toBeInTheDocument();
  });

  it("place scope: accepted anonymous row shows INVITE SENT with a resend action", () => {
    listRequests = [{ ...anonymousRow(), status: "ACCEPTED" }];
    renderPlace();
    expandRow("row-anon");
    expect(screen.getByText("admin.bkWsVenInviteSent")).toBeInTheDocument();
    expect(screen.getByTestId("booking-resend-invite-row-anon")).toBeInTheDocument();
    expect(screen.queryByText("admin.baInboxAcceptedNote")).not.toBeInTheDocument();
  });

  it("accept dialog forks to the invite copy for anonymous rows", () => {
    listRequests = [anonymousRow()];
    renderPlace();
    expandRow("row-anon");
    fireEvent.click(screen.getByTestId("booking-accept-row-anon"));
    expect(screen.getByTestId("dialog-description").textContent).toBe(
      "admin.bkWsVenAcceptAnonConfirm name=Jo Blow",
    );
    expect(screen.getByTestId("dialog-confirm-label").textContent).toBe(
      "admin.bkWsVenAcceptAnonCta",
    );
  });

  it("resend rate limit renders the calm inline message", () => {
    listRequests = [{ ...anonymousRow(), status: "ACCEPTED" }];
    testMocks.resendMutate.mockImplementation(
      (_input: unknown, opts: { onError: (err: unknown) => void }) => {
        opts.onError({ data: { code: "TOO_MANY_REQUESTS" } });
      },
    );
    renderPlace();
    expandRow("row-anon");
    fireEvent.click(screen.getByTestId("booking-resend-invite-row-anon"));
    expect(testMocks.resendMutate.mock.calls[0]![0]).toEqual({ bookingRequestId: "row-anon" });
    expect(screen.getByText("admin.bkInboxInviteResendLimited")).toBeInTheDocument();
  });
});

describe("BookingInbox — SHADOW-OWNED inquiries keep every anonymous affordance", () => {
  // Regression guard for booking-inquirer-outreach: the venue's first reply
  // attaches a shadow owner pair so the reply has somewhere to go. If the
  // inbox narrowed on the raw sender lens, that flip would silently strip the
  // mailto, the resend-invite button and the invite-fork accept copy from
  // exactly the inquiries a venue engaged with.

  it("still renders contactName and the mailto affordance", () => {
    listRequests = [shadowOwnedInquiryRow()];
    const { container } = renderPlace();
    expect(screen.getByText("Jo Blow")).toBeInTheDocument();
    expandRow("row-anon");
    const links = mailtoLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "mailto:jo@example.com");
  });

  it("still offers the resend-invite action on an ACCEPTED row", () => {
    listRequests = [{ ...shadowOwnedInquiryRow(), status: "ACCEPTED" }];
    renderPlace();
    expandRow("row-anon");
    expect(screen.getByText("admin.bkWsVenInviteSent")).toBeInTheDocument();
    expect(screen.getByTestId("booking-resend-invite-row-anon")).toBeInTheDocument();
  });

  it("still mounts the conversation AND its relay note", () => {
    listRequests = [shadowOwnedInquiryRow()];
    renderPlace();
    expandRow("row-anon");
    expect(screen.getByTestId("booking-thread-row-anon")).toBeInTheDocument();
    expect(
      screen.getByTestId("booking-thread-row-anon-email-relay"),
    ).toHaveTextContent("admin.bkWsVenThreadRelayBody name=Jo Blow email=jo@example.com");
  });

  it("still forks the accept dialog to the invite copy", () => {
    listRequests = [shadowOwnedInquiryRow()];
    renderPlace();
    expandRow("row-anon");
    fireEvent.click(screen.getByTestId("booking-accept-row-anon"));
    expect(screen.getByTestId("dialog-description").textContent).toBe(
      "admin.bkWsVenAcceptAnonConfirm name=Jo Blow",
    );
  });

  it("flips to the OWNED presentation once the inquiry is CLAIMED", () => {
    listRequests = [
      {
        ...shadowOwnedInquiryRow(),
        claimedAt: new Date("2026-07-05T12:00:00Z"),
        performerDisplayName: "Jo's Real Band",
      },
    ];
    const { container } = renderPlace();
    expect(screen.getByText("Jo's Real Band")).toBeInTheDocument();
    expandRow("row-anon");
    expect(mailtoLinks(container)).toHaveLength(0);
  });
});

describe("BookingInbox — the venue's emailed reply never arrived", () => {
  // booking-inquirer-outreach: a venue replying to an ANONYMOUS inquiry has
  // that reply mailed to the submitted address. When the mail hard-bounces or
  // draws a spam complaint the thread looks identical to one nobody answered
  // — the venue believes they replied and the inquirer saw nothing. These pin
  // the only surface that says otherwise.

  const bouncedRow = (overrides: Record<string, unknown> = {}) =>
    ({
      ...shadowOwnedInquiryRow(),
      inquirerEmailUndeliverableAt: new Date("2026-07-04T09:00:00Z"),
      inquirerEmailUndeliverableStatus: "BOUNCED",
      ...overrides,
    }) as Record<string, unknown>;

  const complainedRow = (overrides: Record<string, unknown> = {}) =>
    bouncedRow({ inquirerEmailUndeliverableStatus: "COMPLAINED", ...overrides });

  it("names the ROW badge as a sentence — a bounce, not a bare colour", () => {
    listRequests = [bouncedRow()];
    renderPlace();
    const badge = screen.getByTestId("booking-inbox-row-row-anon-undeliverable");
    expect(badge).toHaveTextContent("admin.bkWsVenUndelivBouncedBadge");
    expect(
      screen.getByRole("img", {
        name: "admin.bkWsVenUndelivBouncedAria name=Jo Blow",
      }),
    ).toBe(badge);
  });

  it("keeps a SPAM COMPLAINT distinct from a bounce on the row", () => {
    listRequests = [complainedRow()];
    renderPlace();
    const badge = screen.getByTestId("booking-inbox-row-row-anon-undeliverable");
    expect(badge).toHaveTextContent("admin.bkWsVenUndelivSpamBadge");
    expect(badge).not.toHaveTextContent("admin.bkWsVenUndelivBouncedBadge");
    expect(
      screen.getByRole("img", {
        name: "admin.bkWsVenUndelivSpamAria name=Jo Blow",
      }),
    ).toBe(badge);
  });

  it("renders NOTHING on a reachable inquiry — no badge, no notice", () => {
    listRequests = [shadowOwnedInquiryRow()];
    renderPlace();
    expect(
      screen.queryByTestId("booking-inbox-row-row-anon-undeliverable"),
    ).not.toBeInTheDocument();
    expandRow("row-anon");
    expect(
      screen.queryByTestId("booking-inbox-detail-row-anon-undeliverable-notice"),
    ).not.toBeInTheDocument();
  });

  it("explains the BOUNCE in the detail and keeps the mailto right below it", () => {
    listRequests = [bouncedRow()];
    const { container } = renderPlace();
    expandRow("row-anon");
    const notice = screen.getByTestId(
      "booking-inbox-detail-row-anon-undeliverable-notice",
    );
    expect(notice).toHaveTextContent("admin.bkWsVenUndelivBouncedTitle");
    // The address and the person are both interpolated — a bounce notice that
    // cannot say WHICH address failed sends the venue back to guessing.
    expect(notice).toHaveTextContent(
      "admin.bkWsVenUndelivBouncedBody name=Jo Blow email=jo@example.com",
    );
    expect(notice).toHaveTextContent("admin.bkWsVenUndelivBouncedNext");
    expect(notice).toHaveTextContent("admin.bkWsVenUndelivWhen date=2026-07-04");
    // FR-006's contact link is the venue's remaining option once our sending
    // fails, so it MUST survive the failure state.
    const links = mailtoLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "mailto:jo@example.com");
  });

  it("explains a SPAM COMPLAINT with its own copy, never the bounce's", () => {
    listRequests = [complainedRow()];
    const { container } = renderPlace();
    expandRow("row-anon");
    const notice = screen.getByTestId(
      "booking-inbox-detail-row-anon-undeliverable-notice",
    );
    expect(notice).toHaveTextContent("admin.bkWsVenUndelivSpamTitle");
    expect(notice).toHaveTextContent(
      "admin.bkWsVenUndelivSpamBody name=Jo Blow email=jo@example.com",
    );
    expect(notice).toHaveTextContent("admin.bkWsVenUndelivSpamNext");
    expect(notice).not.toHaveTextContent("admin.bkWsVenUndelivBouncedBody");
    expect(mailtoLinks(container)).toHaveLength(1);
  });

  it("warns IN THE THREAD, so a dead channel never quietly invites another message", () => {
    listRequests = [bouncedRow()];
    renderPlace();
    expandRow("row-anon");
    const note = screen.getByTestId("booking-thread-row-anon-email-relay");
    expect(note).toHaveTextContent("admin.bkWsVenThreadRelayFailedLabel");
    expect(note).toHaveTextContent(
      "admin.bkWsVenThreadRelayFailedBody name=Jo Blow email=jo@example.com",
    );
    // The optimistic "this goes out as an email" copy must NOT survive.
    expect(note).not.toHaveTextContent("admin.bkWsVenThreadRelayBody name=");
    // ONE alarm: the cause and the next step stay with the notice above, and
    // the notice is rendered BEFORE the composer in reading order.
    const notice = screen.getByTestId(
      "booking-inbox-detail-row-anon-undeliverable-notice",
    );
    expect(
      notice.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the SAME failed line for a spam complaint — the cause lives in the notice", () => {
    listRequests = [complainedRow()];
    renderPlace();
    expandRow("row-anon");
    expect(
      screen.getByTestId("booking-thread-row-anon-email-relay"),
    ).toHaveTextContent("admin.bkWsVenThreadRelayFailedLabel");
    expect(
      screen.getByTestId("booking-inbox-detail-row-anon-undeliverable-notice"),
    ).toHaveTextContent("admin.bkWsVenUndelivSpamTitle");
  });

  it("goes quiet once the inquiry is CLAIMED — the stamp is never cleared", () => {
    // The columns are stamped on unclaimed rows and never unstamped. After a
    // claim the thread reaches the performer in-platform, so a surviving
    // bounce warning would be a lie about a channel nobody uses any more.
    listRequests = [
      bouncedRow({
        claimedAt: new Date("2026-07-06T12:00:00Z"),
        performerDisplayName: "Jo's Real Band",
      }),
    ];
    renderPlace();
    expect(
      screen.queryByTestId("booking-inbox-row-row-anon-undeliverable"),
    ).not.toBeInTheDocument();
    expandRow("row-anon");
    expect(
      screen.queryByTestId("booking-inbox-detail-row-anon-undeliverable-notice"),
    ).not.toBeInTheDocument();
  });

  it("ignores HALF a stamp — a status with no timestamp is not an alarm", () => {
    listRequests = [bouncedRow({ inquirerEmailUndeliverableAt: null })];
    renderPlace();
    expect(
      screen.queryByTestId("booking-inbox-row-row-anon-undeliverable"),
    ).not.toBeInTheDocument();
  });

  it("carries the badge onto the mobile card, in the same slot", () => {
    cardMode = true;
    listRequests = [bouncedRow()];
    renderPlace();
    expect(
      screen.getByTestId("booking-inbox-card-row-anon-undeliverable"),
    ).toHaveTextContent("admin.bkWsVenUndelivBouncedBadge");
  });
});

describe("BookingInbox — unread reply indicator on the ROW", () => {
  it("names the chip as a sentence, not a bare number", () => {
    listRequests = [makeRow({ unreadMessageCount: 3 })];
    renderPlace();
    const chip = screen.getByRole("img", { name: "booking.threadUnreadA11y count=3" });
    expect(chip).toBe(screen.getByTestId("booking-inbox-row-row-owned-unread"));
  });

  it("renders NOTHING at 0 — no empty chip, no zero", () => {
    listRequests = [makeRow({ unreadMessageCount: 0 })];
    renderPlace();
    expect(screen.queryByTestId("booking-inbox-row-row-owned-unread")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("BookingInbox — the stage rail on the ROW", () => {
  const base = "booking-inbox-row-row-owned-stage-rail";

  it("shows a pending request as the first leg, with the rest not yet reached", () => {
    listRequests = [makeRow({ status: "PENDING" })];
    renderPlace();
    expect(screen.getByTestId(`${base}-bar-request`).getAttribute("data-state")).toBe("current");
    expect(screen.getByTestId(`${base}-bar-event`).getAttribute("data-state")).toBe("upcoming");
  });

  it("lights the event leg and names the event's own status once one exists", () => {
    listRequests = [
      makeRow({
        status: "ACCEPTED",
        agreementId: "agr-1",
        agreementStatus: "ACCEPTED",
        eventId: "evt-1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date("2026-09-19T18:00:00Z"),
      }),
    ];
    renderPlace();
    // Lands on Event — the first non-empty tab.
    expect(pressed("event")).toBe(true);
    expect(screen.getByTestId(`${base}-bar-event`).getAttribute("data-state")).toBe("current");
    expect(screen.getByText("admin.eventStatusDraft")).toBeInTheDocument();
  });

  it("goes quiet across the whole rail on a declined request", () => {
    listRequests = [makeRow({ status: "DECLINED" })];
    renderPlace();
    expect(screen.getByTestId(`${base}-bar-request`).getAttribute("data-state")).toBe("stopped");
    const summary = screen.getByTestId(`${base}-summary`).textContent ?? "";
    expect(summary).toContain("admin.bkStageNotReached");
    expect(summary).not.toContain("admin.bkStageNotYet");
  });

  it("files a degraded projection under Agreement and renders it as 'not yet'", () => {
    listRequests = [
      makeRow({ status: "ACCEPTED", agreementId: "agr-1", agreementStatus: null }),
    ];
    renderPlace();
    expect(pressed("agreement")).toBe(true);
    expect(screen.getByTestId(`${base}-summary`).textContent).toContain("admin.bkStageNotYet");
  });
});

// ── Accept / decline ─────────────────────────────────────────────────────────

describe("BookingInbox — accept leads somewhere (agreement dead end)", () => {
  it("gives the success toast an action pointing at the new agreement", () => {
    listRequests = [ownedRow()];
    mockRespondSuccess({ bookingRequestId: "row-owned", status: "ACCEPTED", agreementId: "ag-42" });
    renderPlace();
    acceptRow("row-owned");

    const opts = testMocks.toastSuccess.mock.calls[0]![0] as {
      title: string;
      message?: string;
      action?: { label: string; onPress: () => void };
    };
    expect(opts.title).toBe("admin.bkInboxAcceptSuccess");
    expect(opts.message).toBe("admin.bkInboxAcceptSuccessMessage");
    expect(opts.action?.label).toBe("admin.baOpenAgreement");
    opts.action?.onPress();
    expect(testMocks.routerPush).toHaveBeenCalledWith("/admin/acme/bookings/agreement/ag-42");
    // Both query keys — `list.invalidate()` never touches `countOpen`, which
    // feeds the venue filter's numbers and the admin rail badge.
    expect(testMocks.listInvalidate).toHaveBeenCalledTimes(1);
    expect(testMocks.countOpenInvalidate).toHaveBeenCalledTimes(1);
  });

  it("omits the action when the response carries no agreementId", () => {
    listRequests = [ownedRow()];
    mockRespondSuccess({ bookingRequestId: "row-owned", status: "ACCEPTED" });
    renderPlace();
    acceptRow("row-owned");
    const opts = testMocks.toastSuccess.mock.calls[0]![0] as { action?: unknown };
    expect(opts.action).toBeUndefined();
    expect(testMocks.routerPush).not.toHaveBeenCalled();
  });

  it("gives an ANONYMOUS accept no agreement action — there is no agreement", () => {
    listRequests = [anonymousRow()];
    mockRespondSuccess({ bookingRequestId: "row-anon", status: "ACCEPTED" });
    renderOrg();
    acceptRow("row-anon");
    const opts = testMocks.toastSuccess.mock.calls[0]![0] as { title: string; action?: unknown };
    expect(opts.title).toBe("admin.bkWsVenInviteSent");
    expect(opts.action).toBeUndefined();
  });

  it("follows the accepted request to the Agreement tab with its detail open", () => {
    listRequests = [ownedRow()];
    mockRespondSuccess({ bookingRequestId: "row-owned", status: "ACCEPTED", agreementId: "ag-42" });
    renderPlace();
    acceptRow("row-owned");

    expect(pressed("agreement")).toBe(true);
    expect(pressed("open")).toBe(false);
    expect(screen.getByTestId("row-row-owned")).toBeInTheDocument();
    // The cached row carries the new agreement, so the link is live at once.
    expect(screen.getByTestId("booking-row-agreement-row-owned")).toBeInTheDocument();
    expect(screen.getByTestId("booking-open-agreement-row-owned")).toBeInTheDocument();
  });

  it("reaches the agreement from the COLLAPSED row with a DISTINCT accessible name", () => {
    listRequests = [
      makeRow({ status: "ACCEPTED", agreementId: "ag-7" }),
      makeRow({
        id: "row-2",
        status: "ACCEPTED",
        agreementId: "ag-8",
        performerDisplayName: "The Silver Pines",
      }),
    ];
    renderOrg();
    const names = ["row-owned", "row-2"].map((id) =>
      screen.getByTestId(`actions-${id}`).querySelector("a")?.getAttribute("aria-label"),
    );
    expect(names).toEqual([
      "admin.baOpenAgreement — Owned Performer",
      "admin.baOpenAgreement — The Silver Pines",
    ]);
  });

  it("leaves exactly ONE focusable, named control per agreement affordance", () => {
    listRequests = [makeRow({ status: "ACCEPTED", agreementId: "ag-7" })];
    const { container } = renderPlace();
    expandRow("row-owned");
    const anchors = container.querySelectorAll('a[href="/admin/acme/bookings/agreement/ag-7"]');
    // Row action + detail button; the terms strip's own link is a text link
    // with a different accessible name and is not counted here.
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const testId of ["booking-row-agreement-row-owned", "booking-open-agreement-row-owned"]) {
      const inner = screen.getByTestId(testId);
      expect(inner).toHaveAttribute("aria-hidden", "true");
      expect(inner).toHaveAttribute("tabindex", "-1");
    }
  });

  it("mirrors the agreement link into the mobile card (no rowActions there)", () => {
    cardMode = true;
    listRequests = [makeRow({ status: "ACCEPTED", agreementId: "ag-7" })];
    renderPlace();
    const card = screen.getByTestId("card-row-owned");
    expect(card.querySelector('a[href="/admin/acme/bookings/agreement/ag-7"]')).not.toBeNull();
  });

  it("does NOT name the venue on the place scope's mobile card", () => {
    cardMode = true;
    listRequests = [ownedRow()];
    renderPlace();
    expect(screen.getByTestId("card-row-owned")).not.toHaveTextContent("The Spot");
  });
});

describe("BookingInbox — decline (TO_VENUE: reason REQUIRED)", () => {
  it("blocks a decline with no reason, then invalidates both query keys", () => {
    listRequests = [ownedRow()];
    mockRespondSuccess({ bookingRequestId: "row-owned", status: "DECLINED" });
    renderOrg();
    expandRow("row-owned");
    fireEvent.click(screen.getByTestId("booking-decline-row-owned"));
    expect(screen.getByTestId("booking-decline-confirm-row-owned")).toBeDisabled();

    fireEvent.change(screen.getByTestId("booking-decline-reason-row-owned"), {
      target: { value: "Already booked" },
    });
    fireEvent.click(screen.getByTestId("booking-decline-confirm-row-owned"));
    expect(testMocks.respondMutate.mock.calls[0]![0]).toEqual({
      bookingRequestId: "row-owned",
      action: "decline",
      declineReason: "Already booked",
    });
    expect(testMocks.listInvalidate).toHaveBeenCalledTimes(1);
    expect(testMocks.countOpenInvalidate).toHaveBeenCalledTimes(1);
  });
});

// ── Finalize in the chat ─────────────────────────────────────────────────────

describe("BookingInbox — 'Create event from this booking' lives in the thread", () => {
  const acceptedRow = () =>
    makeRow({ status: "ACCEPTED", agreementId: "ag-1", agreementStatus: "ACCEPTED" });

  it("offers the action once the agreement is ACCEPTED and the viewer is the venue", () => {
    listRequests = [acceptedRow()];
    agreementData = acceptedAgreement();
    ownersWithSlugs = [
      { kind: "org", orgId: "org-1", orgSlug: "acme", role: "ADMIN", adminSlug: "acme" },
    ];
    renderPlace();
    expandRow("row-owned");
    const cta = screen.getByTestId("booking-thread-row-owned-create-event-cta");
    expect(cta).toHaveTextContent("admin.bkInboxCreateEventCta");
    // Sits INSIDE the thread, above the composer.
    const composer = screen.getByTestId("booking-thread-row-owned-input");
    expect(cta.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The terms strip is still there, one line above.
    expect(screen.getByTestId("booking-thread-row-owned-terms")).toBeInTheDocument();
  });

  it("does NOT offer it while the agreement is still a DRAFT", () => {
    listRequests = [makeRow({ status: "ACCEPTED", agreementId: "ag-1", agreementStatus: "DRAFT" })];
    agreementData = acceptedAgreement({ status: "DRAFT" });
    renderPlace();
    expandRow("row-owned");
    expect(screen.queryByTestId("booking-thread-row-owned-create-event")).not.toBeInTheDocument();
    // …but the agreement is still one click away.
    expect(screen.getByTestId("booking-open-agreement-row-owned")).toBeInTheDocument();
  });

  it("does NOT offer it to a viewer who is not on the venue side", () => {
    listRequests = [acceptedRow()];
    agreementData = acceptedAgreement();
    ownersWithSlugs = [{ kind: "human", humanId: "someone-else", adminSlug: "@x" }];
    renderPlace();
    expandRow("row-owned");
    expect(screen.queryByTestId("booking-thread-row-owned-create-event")).not.toBeInTheDocument();
  });

  it("creates the event in place, shows the outcome inline, and follows the row to Event", () => {
    listRequests = [acceptedRow()];
    agreementData = acceptedAgreement();
    ownersWithSlugs = [
      { kind: "org", orgId: "org-1", orgSlug: "acme", role: "ADMIN", adminSlug: "acme" },
    ];
    testMocks.createEventMutate.mockImplementation(
      (_input: unknown, opts: { onSuccess: (r: unknown) => void }) => {
        opts.onSuccess({ eventId: "ev-9", alreadyLinked: false, finalized: true });
      },
    );
    const { rerender } = renderPlace();
    switchTab("agreement");
    expandRow("row-owned");
    fireEvent.click(screen.getByTestId("booking-thread-row-owned-create-event-cta"));

    expect(testMocks.createEventMutate.mock.calls[0]![0]).toEqual({ agreementId: "ag-1" });
    // No navigation — the outcome and the way to the event render right here.
    expect(testMocks.routerPush).not.toHaveBeenCalled();
    // The row moved on; the view followed it — and the row is ALREADY there,
    // with its thread still open, because the event was written onto the
    // cached row before the tab switched. No manual list swap here: the
    // `setData` stub applies the component's own write. (Left to the refetch,
    // the Event tab showed its empty state for one round trip and unmounted
    // the notice that had just taken focus.)
    expect(pressed("event")).toBe(true);
    expect(screen.getByTestId("row-row-owned")).toBeInTheDocument();
    expect(screen.getByTestId("booking-thread-row-owned")).toBeInTheDocument();
    const written = listRequests[0] as { eventId: string | null; eventStatus: string | null };
    expect(written.eventId).toBe("ev-9");
    expect(written.eventStatus).toBe("DRAFT");
    // The stage rail tolerates the missing start date on the local write.
    expect(
      screen.getByTestId("booking-inbox-row-row-owned-stage-rail-bar-event").getAttribute("data-state"),
    ).toBe("current");
    // The list, the agreement read AND the thread's ledger are refreshed —
    // the server wrote `booking_event.created` in the same transaction.
    expect(testMocks.listInvalidate).toHaveBeenCalled();
    expect(testMocks.agreementInvalidate).toHaveBeenCalledWith({ agreementId: "ag-1" });
    expect(testMocks.messagesInvalidate).toHaveBeenCalledWith({ bookingRequestId: "row-owned" });
    rerender(<BookingInbox scope={{ kind: "place", placeId: "place-1" }} slug="acme" />);
    // The outcome is on screen, inside the thread, with the way to the event.
    const notice = screen.getByTestId("ba-create-event-outcome");
    expect(notice).toHaveTextContent("Event created and agreement finalized");
    expect(notice.querySelector("a")).toHaveAttribute("href", "/admin/acme/events/ev-9");
  });

  it("keeps the outcome after the refetch moves the row and REMOUNTS it", () => {
    listRequests = [acceptedRow()];
    agreementData = acceptedAgreement();
    ownersWithSlugs = [
      { kind: "org", orgId: "org-1", orgSlug: "acme", role: "ADMIN", adminSlug: "acme" },
    ];
    testMocks.createEventMutate.mockImplementation(
      (_input: unknown, opts: { onSuccess: (r: unknown) => void }) => {
        opts.onSuccess({ eventId: "ev-9", alreadyLinked: false, finalized: true });
      },
    );
    const { rerender } = renderPlace();
    expandRow("row-owned");
    fireEvent.click(screen.getByTestId("booking-thread-row-owned-create-event-cta"));

    // The refetch lands with the row's new eventId. Simulate the real
    // DataTable's remount on the tab move by toggling card mode, which swaps
    // the row's subtree wholesale.
    listRequests = [{ ...acceptedRow(), eventId: "ev-9", eventStatus: "DRAFT", eventStartsAt: new Date(2026, 8, 19) }];
    cardMode = true;
    rerender(<BookingInbox scope={{ kind: "place", placeId: "place-1" }} slug="acme" />);
    cardMode = false;
    rerender(<BookingInbox scope={{ kind: "place", placeId: "place-1" }} slug="acme" />);

    expect(pressed("event")).toBe(true);
    expect(screen.getByTestId("ba-create-event-outcome")).toHaveTextContent(
      "Event created and agreement finalized",
    );
    expect(screen.queryByTestId("booking-thread-row-owned-open-event")).not.toBeInTheDocument();
  });

  it("renders 'Open event' in that slot once an event exists", () => {
    listRequests = [
      makeRow({
        status: "ACCEPTED",
        agreementId: "ag-1",
        agreementStatus: "ACCEPTED",
        eventId: "ev-9",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 7, 1),
      }),
    ];
    const { container } = renderPlace();
    expandRow("row-owned");
    expect(screen.queryByTestId("booking-thread-row-owned-create-event")).not.toBeInTheDocument();
    const link = container.querySelector('a[href="/admin/acme/events/ev-9"]');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("aria-label", "admin.bkInboxOpenEventCta");
    // Stage-aware: "a draft agreement was created" is stale once the event
    // exists — the terms strip and Open event say where the booking is.
    expect(screen.queryByText("admin.baInboxAcceptedNote")).not.toBeInTheDocument();
  });

  /**
   * WHOSE EVENT. A RENT / USE confirmation mints the event into the
   * REQUESTER's admin; the venue's shell has no edit access to it, so the
   * `/admin/{slug}/events/{id}` link this slot builds would 403. The common
   * path here is a confirm-mint or a reload — no outcome notice is held to
   * hide the link — so the gate has to live on the row itself.
   */
  it("never links a requester-owned event into the venue's admin; says where it lives", () => {
    listRequests = [
      makeRow({
        status: "ACCEPTED",
        agreementId: "ag-1",
        agreementStatus: "ACCEPTED",
        eventId: "ev-9",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 7, 1),
        intent: "RENT",
        venueConfirmation: { state: "confirmed", eventId: "ev-9", ownerSide: "requester" },
      }),
    ];
    const { container } = renderPlace();
    expandRow("row-owned");
    expect(container.querySelector('a[href="/admin/acme/events/ev-9"]')).toBeNull();
    expect(screen.queryByTestId("booking-thread-row-owned-open-event")).not.toBeInTheDocument();
    const slot = screen.getByTestId("booking-thread-row-owned-requester-owned-event");
    expect(slot).toHaveTextContent("admin.bkInboxEventRequesterOwnedNote");
    // Not the create button either — the event exists.
    expect(screen.queryByTestId("booking-thread-row-owned-create-event")).not.toBeInTheDocument();
  });

  it("links a venue-owned event exactly as before", () => {
    listRequests = [
      makeRow({
        status: "ACCEPTED",
        agreementId: "ag-1",
        agreementStatus: "ACCEPTED",
        eventId: "ev-9",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 7, 1),
        venueConfirmation: { state: "confirmed", eventId: "ev-9", ownerSide: "place" },
      }),
    ];
    const { container } = renderPlace();
    expandRow("row-owned");
    expect(container.querySelector('a[href="/admin/acme/events/ev-9"]')).not.toBeNull();
    expect(
      screen.queryByTestId("booking-thread-row-owned-requester-owned-event"),
    ).not.toBeInTheDocument();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// booking-holds spec 2026-08-25 — Holds tab, hold line, assignee, tags
// ─────────────────────────────────────────────────────────────────────────────

const EDITOR_ID = "22222222-2222-4222-8222-222222222222";

const liveHold = (over: Record<string, unknown> = {}) => ({
  id: "hold-1",
  calendarId: "cal-1",
  date: "2026-10-13",
  position: 2,
  status: "ACTIVE",
  respondBy: null,
  lapsed: false,
  ...over,
});

describe("BookingInbox — Holds tab (FR-011)", () => {
  it("lists the fifth tab between Open and Agreement, with its count", () => {
    listRequests = [
      makeRow({ id: "r-open", status: "VIEWED" }),
      makeRow({ id: "r-held", status: "ACCEPTED", agreementStatus: "DRAFT", holds: [liveHold()] }),
    ];
    renderPlace();
    const labels = Array.from(
      document.querySelectorAll('[data-testid^="booking-inbox-tab-"]'),
    ).map((el) => el.textContent);
    expect(labels).toEqual([
      "admin.bkInboxTabOpen (1)",
      "admin.bkInboxTabHolds (1)",
      "admin.bkInboxTabAgreement (0)",
      "admin.bkInboxTabEvent (0)",
      "admin.bkInboxTabClosed (1)".replace("1", "0"),
    ]);
  });

  it("shows the hold line under the stage rail — date, ordinal, and the clock when challenged", () => {
    const soon = new Date(Date.now() + 5 * 3_600_000);
    listRequests = [
      makeRow({
        id: "r-held",
        status: "ACCEPTED",
        agreementStatus: "DRAFT",
        holds: [liveHold({ status: "CHALLENGED", respondBy: soon })],
      }),
    ];
    renderPlace();
    fireEvent.click(screen.getByTestId("booking-inbox-tab-holds"));
    const line = screen.getByTestId("booking-inbox-row-r-held-hold-hold-1");
    expect(line.textContent).toContain("admin.bkHoldSummary");
    expect(line.textContent).toContain("position=admin.bkHoldPosition2");
    expect(screen.getByTestId("booking-inbox-row-r-held-hold-hold-1-clock").textContent).toContain(
      "admin.bkHoldHoursLeft",
    );
  });

  it("marks a lapsed challenge as lapsed and files the row off the Holds tab", () => {
    listRequests = [
      makeRow({
        id: "r-lapsed",
        status: "ACCEPTED",
        agreementStatus: "DRAFT",
        holds: [liveHold({ status: "CHALLENGED", respondBy: new Date(0), lapsed: true })],
      }),
    ];
    renderPlace();
    expect(screen.getByTestId("booking-inbox-tab-holds").textContent).toBe(
      "admin.bkInboxTabHolds (0)",
    );
    expect(screen.getByTestId("booking-inbox-tab-agreement").textContent).toBe(
      "admin.bkInboxTabAgreement (1)",
    );
  });

  it("mounts the holds strip in the expanded row and offers Place hold", () => {
    listRequests = [
      makeRow({ id: "r-held", status: "ACCEPTED", agreementStatus: "DRAFT", holds: [liveHold()] }),
    ];
    renderPlace();
    fireEvent.click(screen.getByTestId("booking-inbox-tab-holds"));
    fireEvent.click(screen.getByTestId("expand-r-held"));
    expect(screen.getByTestId("booking-holds-r-held-row-hold-1")).toBeTruthy();
    expect(screen.getByTestId("booking-holds-r-held-release-hold-1")).toBeTruthy();
    // P5-fixes: the hold Confirm is retired (HOLD_CONFIRM_RETIRED), and a 2nd
    // hold has another act ahead, so it offers neither booking action.
    expect(screen.queryByTestId("booking-holds-r-held-confirm-hold-1")).toBeNull();
    expect(screen.queryByTestId("booking-holds-r-held-book-hold-1")).toBeNull();
    // Position 2 cannot be challenged — only the head of the line can.
    expect(screen.queryByTestId("booking-holds-r-held-challenge-hold-1")).toBeNull();
    fireEvent.click(screen.getByTestId("booking-holds-r-held-place"));
    expect(screen.getByTestId("booking-holds-r-held-place-form")).toBeTruthy();
  });

  it("release goes through the confirm dialog, then the mutation", () => {
    listRequests = [
      makeRow({ id: "r-held", status: "ACCEPTED", agreementStatus: "DRAFT", holds: [liveHold({ position: 1 })] }),
    ];
    renderPlace();
    fireEvent.click(screen.getByTestId("booking-inbox-tab-holds"));
    fireEvent.click(screen.getByTestId("expand-r-held"));
    fireEvent.click(screen.getByTestId("booking-holds-r-held-release-hold-1"));
    fireEvent.click(screen.getByTestId("dialog-confirm"));
    expect(testMocks.holdMutate).toHaveBeenCalledWith(
      { holdId: "hold-1" },
      expect.anything(),
    );
  });

  it("follows the row from Agreement to Holds only once a NEWER list lands, and only once", () => {
    listUpdatedAt = 1000;
    listRequests = [accRowOnAgreement()];
    const { rerender } = renderPlace();
    expect(pressed("agreement")).toBe(true);
    placeHoldOn("r-acc");

    // The cache still holds the pre-write list: the row is still on Agreement
    // and the latch must NOT resolve against it.
    rerender(PLACE());
    expect(pressed("agreement")).toBe(true);

    // The refetch lands: the row now carries a live hold and files under Holds.
    deliverList(rerender, [accRowOnHolds()]);
    expect(pressed("holds")).toBe(true);
    expect(pressed("agreement")).toBe(false);
    // …with the detail still open and the strip showing the new line.
    expect(screen.getByTestId("booking-holds-r-acc-row-hold-new")).toBeTruthy();

    // Resolved ONCE: a later, unrelated delivery does not move the user again.
    fireEvent.click(screen.getByTestId("booking-inbox-tab-event"));
    deliverList(rerender, [accRowOnHolds()]);
    expect(pressed("event")).toBe(true);
  });

  it("does NOT resolve the latch on a cache write — only a fetch that lands", () => {
    listUpdatedAt = 1000;
    listRequests = [accRowOnAgreement()];
    const { rerender } = renderPlace();
    placeHoldOn("r-acc");

    // A `setData` write (markViewed / assign / setTags) bumps dataUpdatedAt
    // against the STALE list. Keyed on that stamp, the latch resolved here,
    // found the row still on Agreement, and cleared — so the real delivery
    // then moved the row out from under the open panel.
    listUpdatedAt = 2000;
    rerender(PLACE());
    expect(pressed("agreement")).toBe(true);
    listUpdatedAt = 3000;
    rerender(PLACE());
    expect(pressed("agreement")).toBe(true);

    // The fetch itself lands: NOW the view follows.
    deliverList(rerender, [accRowOnHolds()]);
    expect(pressed("holds")).toBe(true);
    expect(screen.getByTestId("booking-holds-r-acc-row-hold-new")).toBeTruthy();
  });

  it("arms the latch against the count AT THE WRITE, not at the click — a delivery mid round-trip does not pre-resolve it", () => {
    listUpdatedAt = 1000;
    listRequests = [accRowOnAgreement()];
    const { rerender } = renderPlace();
    const date = openPickerAndChooseADate("r-acc");
    fireEvent.click(screen.getByTestId("booking-holds-r-acc-place-submit"));
    const opts = testMocks.holdMutate.mock.calls.at(-1)![1] as {
      onSuccess: (r: unknown) => void;
    };

    // A routine refetch lands WHILE the mutation is in flight — the row is
    // still on Agreement, because the server has not written yet.
    deliverList(rerender, [accRowOnAgreement()]);
    expect(pressed("agreement")).toBe(true);

    // The write succeeds. A latch armed with the count from the click's
    // render would treat the delivery above as "the" refetch and resolve
    // against it; nothing would follow the row.
    act(() =>
      opts.onSuccess({
        placed: [{ id: "hold-new", position: 1, date }],
        failed: [],
      }),
    );
    rerender(PLACE());
    expect(pressed("agreement")).toBe(true);

    deliverList(rerender, [accRowOnHolds()]);
    expect(pressed("holds")).toBe(true);
    expect(screen.getByTestId("booking-holds-r-acc-row-hold-new")).toBeTruthy();
  });

  it("drops the latch when the refetch FAILS — the next unrelated delivery must not move the tab", () => {
    listUpdatedAt = 1000;
    listRequests = [accRowOnAgreement()];
    const { rerender } = renderPlace();
    placeHoldOn("r-acc");

    // The refetch errors out. React Query keeps the old data and only moves
    // errorUpdatedAt; an armed latch would survive this. Dropping it is SAFE
    // rather than strictly required — the inbox shows its error panel in
    // place of the tabs until the first success, so the user has nothing to
    // be yanked from — but the next success is an unrelated delivery, and
    // moving the tab on it would be a surprise either way.
    failList(rerender);
    expect(screen.queryByTestId("booking-inbox-tab-agreement")).not.toBeInTheDocument();

    // Minutes later a routine refetch succeeds and the row IS on Holds now —
    // but the user never asked to go there.
    listError = null;
    deliverList(rerender, [accRowOnHolds()]);
    expect(pressed("agreement")).toBe(true);
    expect(pressed("holds")).toBe(false);
  });

  it("drops the latch when the user picks a tab themselves", () => {
    listUpdatedAt = 1000;
    listRequests = [accRowOnAgreement()];
    const { rerender } = renderPlace();
    placeHoldOn("r-acc");

    // Before the refetch lands, the venue moves to Event on purpose.
    fireEvent.click(screen.getByTestId("booking-inbox-tab-event"));
    expect(pressed("event")).toBe(true);

    // The refetch lands with the row on Holds; their choice stands.
    deliverList(rerender, [accRowOnHolds()]);
    expect(pressed("event")).toBe(true);
    expect(pressed("holds")).toBe(false);
  });

  it("offers no strip on a terminal row without live holds, and no Place hold on one with them", () => {
    listRequests = [
      makeRow({ id: "r-declined", status: "DECLINED", holds: [] }),
      makeRow({ id: "r-withdrawn", status: "WITHDRAWN", holds: [liveHold({ id: "hold-w" })] }),
    ];
    renderPlace();
    switchTab("closed");
    fireEvent.click(screen.getByTestId("expand-r-declined"));
    expect(screen.queryByTestId("booking-holds-r-declined")).toBeNull();
    // A live hold files the row under Holds whatever its status (FR-011).
    fireEvent.click(screen.getByTestId("booking-inbox-tab-holds"));
    fireEvent.click(screen.getByTestId("expand-r-withdrawn"));
    expect(screen.getByTestId("booking-holds-r-withdrawn-row-hold-w")).toBeTruthy();
    expect(screen.queryByTestId("booking-holds-r-withdrawn-place")).toBeNull();
  });

  // WAS "does not mount the strip for an anonymous inquiry — nobody to
  // notify". Still green, but that sentence stopped being true: an unclaimed
  // inquiry that ALREADY holds a night now renders its line (see "an unclaimed
  // inquiry's hold is REACHABLE — the list and the detail agree"). What
  // survives is the narrower rule this row actually exercises — no hold, and
  // no offer of a new one, because there is nobody to tell about it.
  /**
   * The wiring `BookingHoldsStrip`'s own suite cannot see: the strip proves it
   * USES `nameSuffix`, this proves the inbox HANDS it one. Without this the
   * prop could be dropped at the call site and every strip test stays green.
   *
   * Asserted by ROLE + accessible name rather than by test id — the collision
   * being fixed is in the accessible-name tree, so that is where to look.
   */
  it("hands the strip the counterparty, so two expanded rows name distinct lines", () => {
    const held = (id: string) => ({
      id,
      calendarId: "cal-1",
      date: "2026-10-13",
      position: 1,
      status: "ACTIVE" as const,
      respondBy: null,
      lapsed: false,
    });
    listRequests = [
      makeRow({ id: "r-one", performerDisplayName: "Neon Static", holds: [held("h-one")] }),
      makeRow({ id: "r-two", performerDisplayName: "Glass Hours", holds: [held("h-two")] }),
    ];
    renderPlace();
    expandRow("r-one");
    expandRow("r-two");

    // SAME night, SAME position, two different requests — exactly the case
    // date + ordinal cannot separate.
    expect(
      screen.getByRole("button", { name: /admin\.bkHoldReleaseAction .* — Neon Static$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /admin\.bkHoldReleaseAction .* — Glass Hours$/ }),
    ).toBeInTheDocument();
    // And the add-row, which no date could ever have qualified. By ATTRIBUTE,
    // not by role: this suite's `styled()` mock flattens every styled
    // component to a <div>, ignoring `tag`, so the add-row has no button role
    // here. That it IS a real non-submitting <button> is pinned in the strip's
    // own suite, whose mock honours `tag`.
    expect(
      screen.getByTestId("booking-holds-r-one-place").getAttribute("aria-label"),
    ).toBe("admin.bkHoldPlace — Neon Static");
  });

  it("offers no hold surface on an unclaimed inquiry that holds nothing", () => {
    listRequests = [anonymousRow()];
    renderPlace();
    fireEvent.click(screen.getByTestId("expand-row-anon"));
    expect(screen.queryByTestId("booking-holds-row-anon")).toBeNull();
  });
});

describe("BookingInbox — assignee and tags (FR-015 / FR-017)", () => {
  it("org scope: shows the Assigned-to column, resolving the roster name", () => {
    listRequests = [
      makeRow({ id: "r-a", assigneeHumanId: EDITOR_ID }),
      makeRow({ id: "r-b", placeId: "place-2", placeName: "Exit/In" }),
    ];
    renderOrg();
    expect(screen.getByTestId("header-assignee").textContent).toBe("admin.bkInboxColAssignee");
    expect(screen.getByTestId("booking-inbox-row-r-a-assignee").textContent).toBe("Dana Booker");
    expect(screen.getByTestId("booking-inbox-row-r-b-assignee").textContent).toBe(
      "admin.bkAssigneeUnassigned",
    );
  });

  it("org scope: the Unassigned filter narrows the rows AND the tab counts", () => {
    listRequests = [
      makeRow({ id: "r-a", assigneeHumanId: EDITOR_ID }),
      makeRow({ id: "r-b", placeId: "place-2", placeName: "Exit/In" }),
    ];
    renderOrg();
    expect(screen.getByTestId("booking-inbox-tab-open").textContent).toBe("admin.bkInboxTabOpen (2)");
    fireEvent.change(screen.getByTestId("booking-inbox-filter-assignee"), {
      target: { value: "__unassigned__" },
    });
    expect(screen.getByTestId("booking-inbox-tab-open").textContent).toBe("admin.bkInboxTabOpen (1)");
    expect(screen.queryByTestId("row-r-a")).toBeNull();
    expect(screen.getByTestId("row-r-b")).toBeTruthy();
  });

  it("org scope: renders tag chips on the row and the picker in the expanded row; assign writes", () => {
    listRequests = [
      makeRow({ id: "r-a", tags: [{ id: "tag-1", name: "Rock", color: "accent" }] }),
    ];
    renderOrg();
    expect(screen.getByTestId("booking-inbox-row-r-a-tag-tag-1").textContent).toBe("Rock");
    fireEvent.click(screen.getByTestId("expand-r-a"));
    expect(screen.getByTestId("booking-tags-r-a")).toBeTruthy();
    // The picker lists edit-role members only — the VIEWER is not an option.
    const select = screen.getByTestId("booking-assignee-r-a-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "__unassigned__",
      EDITOR_ID,
    ]);
    fireEvent.change(select, { target: { value: EDITOR_ID } });
    expect(testMocks.assignMutate).toHaveBeenCalledWith(
      { bookingRequestId: "r-a", assigneeHumanId: EDITOR_ID },
      expect.anything(),
    );
  });

  it("human-venues scope: holds render but no assignee or tag chrome", () => {
    listRequests = [
      makeRow({
        id: "r-h",
        status: "ACCEPTED",
        agreementStatus: "DRAFT",
        holds: [liveHold()],
        tags: [{ id: "tag-1", name: "Rock", color: "accent" }],
      }),
    ];
    render(<BookingInbox scope={{ kind: "human-venues" }} slug="@me" venues={VENUES} />);
    expect(screen.getByTestId("booking-inbox-tab-holds").textContent).toBe(
      "admin.bkInboxTabHolds (1)",
    );
    expect(screen.queryByTestId("header-assignee")).toBeNull();
    expect(screen.queryByTestId("booking-inbox-org-filters")).toBeNull();
    expect(screen.queryByTestId("booking-inbox-row-r-h-tag-tag-1")).toBeNull();
    fireEvent.click(screen.getByTestId("booking-inbox-tab-holds"));
    fireEvent.click(screen.getByTestId("expand-r-h"));
    expect(screen.getByTestId("booking-holds-r-h")).toBeTruthy();
    expect(screen.queryByTestId("booking-assignee-r-h")).toBeNull();
  });

  it("place scope inside an ORG shell gets the org chrome", () => {
    currentAdminOwner = { kind: "org", orgId: "org-1", role: "ADMIN", adminSlug: "acme" };
    listRequests = [makeRow({ id: "r-p" })];
    renderPlace();
    expect(screen.getByTestId("header-assignee")).toBeTruthy();
    expect(screen.getByTestId("booking-inbox-org-filters")).toBeTruthy();
  });
});

describe("BookingInbox — `?request=<id>` deep link", () => {
  it("lands on the row's stage tab with it expanded and strips the param once; an unknown id does nothing", () => {
    // Two open rows make Open the latched default — the deep link must beat it.
    listRequests = [
      makeRow({ id: "r-pending", status: "PENDING" }),
      makeRow({ id: "r-viewed", status: "VIEWED" }),
      makeRow({
        id: "r-agreement",
        status: "ACCEPTED",
        agreementId: "ag-1",
        agreementStatus: "DRAFT",
      }),
    ];
    requestParam = "r-agreement";
    const replaceState = vi.spyOn(window.history, "replaceState");
    const known = renderPlace();

    expect(pressed("agreement")).toBe(true);
    expect(pressed("open")).toBe(false);
    expect(screen.getByTestId("expanded-r-agreement")).not.toBeEmptyDOMElement();
    // Native `replaceState`, not a router navigation: no history entry (a
    // refresh or Back must not re-run the jump) and no remount of this tree.
    expect(replaceState).toHaveBeenCalledTimes(1);
    // Only `request` is removed; the other param survives.
    expect(replaceState.mock.lastCall?.[2]).toBe(
      "/admin/acme/bookings?view=compact",
    );
    expect(testMocks.routerReplace).not.toHaveBeenCalled();
    expect(testMocks.routerPush).not.toHaveBeenCalled();
    // An ACCEPTED row is not "viewed" by being opened this way.
    expect(testMocks.markViewedMutate).not.toHaveBeenCalled();
    known.unmount();

    // Unknown id: the latched default stands, nothing expands, URL untouched.
    vi.clearAllMocks();
    requestParam = "r-deleted";
    renderPlace();
    expect(pressed("open")).toBe(true);
    expect(screen.getByTestId("expanded-r-pending")).toBeEmptyDOMElement();
    expect(screen.getByTestId("expanded-r-viewed")).toBeEmptyDOMElement();
    expect(replaceState).not.toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it("a PENDING row opened by deep link is marked viewed, exactly as a click would", () => {
    listRequests = [
      makeRow({ id: "r-pending", status: "PENDING" }),
      makeRow({
        id: "r-agreement",
        status: "ACCEPTED",
        agreementId: "ag-1",
        agreementStatus: "DRAFT",
      }),
    ];
    requestParam = "r-pending";
    renderPlace();

    expect(pressed("open")).toBe(true);
    expect(screen.getByTestId("expanded-r-pending")).not.toBeEmptyDOMElement();
    expect(testMocks.markViewedMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.markViewedMutate).toHaveBeenCalledWith(
      { bookingRequestId: "r-pending" },
      expect.anything(),
    );
  });
});
