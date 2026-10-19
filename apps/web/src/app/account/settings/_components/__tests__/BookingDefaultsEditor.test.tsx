import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BookingDefaultsEditor owner parameterization (booking-review-data-weave WS1):
 * the editor is mounted for HUMAN performers (account settings) and ORG
 * performers (org admin settings). These tests pin the owner contract — the
 * `{ ownerType, ownerId }` pair flows into both the read query and the update
 * mutation — and the org-only omissions (verified-stats toggle, genre hint).
 */

const testMocks = vi.hoisted(() => ({
  defaultsUseQuery: vi.fn(),
  updateMutate: vi.fn(),
  invalidateDefaults: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      performers: {
        getBookingDefaults: { invalidate: testMocks.invalidateDefaults },
      },
    }),
    performers: {
      getBookingDefaults: { useQuery: testMocks.defaultsUseQuery },
      // Eligibility read for the verified-stats toggle gate; the human tests
      // exercise the eligible path, org mounts disable the query entirely.
      getMyStatus: {
        useQuery: () => ({
          data: {
            human: {
              ownerId: "human-1",
              enabled: true,
              enabledAt: null,
              statsEligible: true,
              acceptsBookingRequests: false,
            },
            orgs: [],
          },
          isLoading: false,
          isError: false,
        }),
      },
      updateBookingDefaults: {
        useMutation: () => ({
          mutate: testMocks.updateMutate,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  Spinner: () => <span>Loading</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  // Key-echo translator (same convention as NotificationsSection.test.tsx).
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

import { BookingDefaultsEditor } from "../BookingDefaultsEditor";

/** All-null saved-defaults shape (what the server returns before first save). */
const EMPTY_DEFAULTS = {
  actName: null,
  lineupSize: null,
  setLengthMinutes: null,
  contactPhone: null,
  techNeeds: null,
  messageTemplate: null,
  feeType: null,
  feeAmountCents: null,
  linkMusic: null,
  linkVideo: null,
  linkSocial: null,
  linkEpk: null,
  includeVerifiedStats: null,
};

function mockDefaultsQuery(defaults: Record<string, unknown> = EMPTY_DEFAULTS) {
  testMocks.defaultsUseQuery.mockReturnValue({
    data: { defaults },
    isLoading: false,
    isError: false,
  });
}

/** Dirty the form (actName) then submit it, bypassing jsdom's requestSubmit. */
function editActNameAndSave(actName: string) {
  fireEvent.change(screen.getByLabelText("admin.bkFormActNameLabel"), {
    target: { value: actName },
  });
  fireEvent.submit(screen.getByRole("form", { name: "account.sBkDefTitle" }));
}

describe("BookingDefaultsEditor owner parameterization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries defaults with ownerType 'org' when mounted for an org", () => {
    mockDefaultsQuery();

    render(<BookingDefaultsEditor ownerType="org" ownerId="org-1" />);

    expect(testMocks.defaultsUseQuery).toHaveBeenCalledWith(
      { ownerType: "org", ownerId: "org-1" },
      expect.anything(),
    );
  });

  it("saves with ownerType 'org' for an org mount", () => {
    mockDefaultsQuery();

    render(<BookingDefaultsEditor ownerType="org" ownerId="org-1" />);
    editActNameAndSave("The Test Collective");

    expect(testMocks.updateMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "org",
        ownerId: "org-1",
        actName: "The Test Collective",
      }),
      expect.anything(),
    );
  });

  it("hides the human-only verified-stats toggle and genre hint for orgs", () => {
    mockDefaultsQuery();

    render(<BookingDefaultsEditor ownerType="org" ownerId="org-1" />);

    // Verified-stats snapshots are built server-side for HUMAN senders only
    // (create-booking-request) — the org editor must not offer the toggle.
    expect(
      screen.queryByText("account.sBkDefIncludeStatsLabel"),
    ).not.toBeInTheDocument();
    // Genre prefill from profile tags is human-only too.
    expect(
      screen.queryByText("account.sBkDefGenreHint"),
    ).not.toBeInTheDocument();
  });

  it("keeps the human mount unchanged: ownerType 'human' + stats toggle", () => {
    mockDefaultsQuery();

    render(<BookingDefaultsEditor ownerType="human" ownerId="human-1" />);

    expect(testMocks.defaultsUseQuery).toHaveBeenCalledWith(
      { ownerType: "human", ownerId: "human-1" },
      expect.anything(),
    );
    expect(
      screen.getByText("account.sBkDefIncludeStatsLabel"),
    ).toBeInTheDocument();
    expect(screen.getByText("account.sBkDefGenreHint")).toBeInTheDocument();

    editActNameAndSave("Solo Act");
    expect(testMocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "human",
        ownerId: "human-1",
        actName: "Solo Act",
      }),
      expect.anything(),
    );
  });
});
