import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * VolunteerSection — the `volunteer-open-sheet-btn` trigger.
 *
 * This button is the ONLY way to open the volunteer sheet. Until 2026-08-27
 * the sheet could only be opened from the floating contextual action bar, and
 * that bar's config was the last machine-checked statement that the action
 * existed; when the bar was deleted the config became a prose comment
 * (`bar-configs.ts:661`) instead of a test. Every gate below therefore pins
 * WHERE THE TRIGGER RENDERS, not the pure predicate behind it —
 * `shouldHideVolunteerSection` already has its own 18-test suite in
 * `volunteer-section.helpers.test.ts` and is not re-tested here.
 *
 * The query-error case is pinned deliberately: an errored roles query hides
 * the trigger outright, which is the failure mode behind Gap 8 (2026-06-11,
 * a transient blip hid the CTA for a whole live-event session). The fix was
 * the retry policy, not the render gate, so the gate itself must stay visible
 * in a test.
 */

// ── DOM-level stand-ins for the styling layer ────────────────────────────────

const pickDomProps = (rest: Record<string, unknown>) => {
  const domProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") {
      domProps[key] = value;
    }
  }
  return domProps;
};

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  );
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    Card: Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

const MESSAGES: Record<string, string> = {
  "eventDetail.volunteerSectionTitle": "Volunteer",
  "eventDetail.volunteerSectionSubtitle": "Help make this happen.",
  "pageActions.volunteer": "Volunteer",
};

vi.mock("@th/ui", () => {
  const Passthrough = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  );
  // Faithful to `@th/ui` Button: `onPress` ONLY (never `onClick`), and
  // `data-*` reaches the DOM node.
  const Button = ({
    children,
    onPress,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
  } & Record<string, unknown>) => (
    <button type="button" onClick={onPress} {...pickDomProps(rest)}>
      {children}
    </button>
  );
  // Mirrors the real BottomSheet: children mount only while `open`.
  const BottomSheet = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div data-testid="volunteer-sheet">{children}</div> : null,
    {
      Panel: Passthrough,
      Header: ({ title }: { title?: string }) => <h2>{title}</h2>,
      Body: Passthrough,
      Footer: Passthrough,
    },
  );
  return {
    Badge: Passthrough,
    BottomSheet,
    Button,
    Checkbox: () => <input type="checkbox" readOnly />,
    Text: ({
      children,
      ...rest
    }: { children?: ReactNode } & Record<string, unknown>) => (
      <span {...pickDomProps(rest)}>{children}</span>
    ),
    TextInput: () => <input />,
    useTranslations: () => (key: string) => MESSAGES[key] ?? key,
    useFormatters: () => ({
      dateTime: () => "Sat, Jan 1, 2028",
      date: () => "Sat, Jan 1, 2028",
      time: () => "8:00 PM",
    }),
  };
});

// ── Query layer ──────────────────────────────────────────────────────────────
// Only the roles query drives the trigger's visibility, so it is the only one
// with mutable state; the rest are inert stand-ins.

type RolesQueryState = {
  isLoading: boolean;
  isError: boolean;
  data: { introText?: string | null; roles: unknown[] } | undefined;
};

const ROLE = {
  id: "role_1",
  name: "Door",
  description: null,
  capacity: null,
  sortOrder: 0,
  signupCount: 0,
  acceptedCount: 0,
  shifts: [],
};

let rolesQuery: RolesQueryState;
/** `enabled` as the component passed it on the last render of each test. */
let rolesQueryEnabled: boolean | undefined;

const inertQuery = { data: undefined, isLoading: false, isError: false };

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    volunteer: {
      publicRoles: {
        list: {
          useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
            rolesQueryEnabled = opts?.enabled;
            return { ...rolesQuery, refetch: vi.fn() };
          },
        },
        waiver: { useQuery: () => ({ ...inertQuery, refetch: vi.fn() }) },
      },
      signups: {
        listMine: { useQuery: () => ({ ...inertQuery, refetch: vi.fn() }) },
        submit: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
        updateContactPrefs: {
          useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
        },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}));

vi.mock("@/lib/app-error", () => ({ getAppErrorCode: () => undefined }));

// The gate snapshot (SMS opt-ins render only when `sms === true`); unknown here.
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: undefined, isLoading: false }),
}));

vi.mock("@/components/volunteering/AddToCalendarButton", () => ({
  AddToCalendarButton: () => null,
}));

import { VolunteerSection } from "../VolunteerSection";

/** Comfortably in the future so the past-event gate never fires by accident. */
const FUTURE_ENDS_AT = "2099-01-01T00:00:00.000Z";
const PAST_ENDS_AT = "2000-01-01T00:00:00.000Z";

beforeEach(() => {
  rolesQuery = { isLoading: false, isError: false, data: { roles: [ROLE] } };
  rolesQueryEnabled = undefined;
});

describe("VolunteerSection — the sheet trigger renders", () => {
  it("renders `volunteer-open-sheet-btn` for a published, future event with roles", () => {
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="PUBLISHED"
        eventEndsAt={FUTURE_ENDS_AT}
      />,
    );

    expect(screen.getByTestId("volunteer-open-sheet-btn")).toBeInTheDocument();
  });

  it("renders exactly one trigger", () => {
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="PUBLISHED"
        eventEndsAt={FUTURE_ENDS_AT}
      />,
    );

    expect(screen.getAllByTestId("volunteer-open-sheet-btn")).toHaveLength(1);
  });

  it("opens the sheet when pressed — it is the only way in", () => {
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="PUBLISHED"
        eventEndsAt={FUTURE_ENDS_AT}
      />,
    );

    expect(screen.queryByTestId("volunteer-sheet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("volunteer-open-sheet-btn"));
    expect(screen.getByTestId("volunteer-sheet")).toBeInTheDocument();
  });
});

describe("VolunteerSection — states that hide the trigger", () => {
  it("hides it for a non-PUBLISHED event, and does not even run the query", () => {
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="DRAFT"
        eventEndsAt={FUTURE_ENDS_AT}
      />,
    );

    expect(
      screen.queryByTestId("volunteer-open-sheet-btn"),
    ).not.toBeInTheDocument();
    expect(rolesQueryEnabled).toBe(false);
  });

  it("hides it once the event has ended", () => {
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="PUBLISHED"
        eventEndsAt={PAST_ENDS_AT}
      />,
    );

    expect(
      screen.queryByTestId("volunteer-open-sheet-btn"),
    ).not.toBeInTheDocument();
    expect(rolesQueryEnabled).toBe(false);
  });

  it("hides it while the roles query is still loading", () => {
    rolesQuery = { isLoading: true, isError: false, data: undefined };
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="PUBLISHED"
        eventEndsAt={FUTURE_ENDS_AT}
      />,
    );

    expect(
      screen.queryByTestId("volunteer-open-sheet-btn"),
    ).not.toBeInTheDocument();
    // The query DID run — this is a transient state, not a gate.
    expect(rolesQueryEnabled).toBe(true);
  });

  it("hides it when the roles query errors with no data", () => {
    rolesQuery = { isLoading: false, isError: true, data: undefined };
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="PUBLISHED"
        eventEndsAt={FUTURE_ENDS_AT}
      />,
    );

    expect(
      screen.queryByTestId("volunteer-open-sheet-btn"),
    ).not.toBeInTheDocument();
  });

  it("hides it when a refetch fails even though roles are still cached (Gap 8 blast radius)", () => {
    // react-query keeps `data` from the last success when a background
    // refetch fails, so this is the state a single blip actually produces —
    // and `if (rolesQuery.isError) return null` yanks the trigger out from
    // under a user who could see it a second ago. Pinned so the cost of that
    // gate stays visible: the retry policy
    // (`shouldRetryVolunteerRolesQuery`) is the only thing keeping a
    // transient failure from removing the page's sole volunteer affordance.
    rolesQuery = { isLoading: false, isError: true, data: { roles: [ROLE] } };
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="PUBLISHED"
        eventEndsAt={FUTURE_ENDS_AT}
      />,
    );

    expect(
      screen.queryByTestId("volunteer-open-sheet-btn"),
    ).not.toBeInTheDocument();
  });

  it("hides it when the event has volunteering on but zero roles", () => {
    rolesQuery = { isLoading: false, isError: false, data: { roles: [] } };
    render(
      <VolunteerSection
        eventId="evt_1"
        eventStatus="PUBLISHED"
        eventEndsAt={FUTURE_ENDS_AT}
      />,
    );

    expect(
      screen.queryByTestId("volunteer-open-sheet-btn"),
    ).not.toBeInTheDocument();
  });
});
