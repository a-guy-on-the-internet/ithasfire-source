import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One behaviour, and it is about what this section is allowed to ASSERT.
 *
 * The note "Booking requests are off — the button will show 'not accepting
 * requests' until you turn them on above" names a state AND a control. Both
 * halves can be wrong at once, and were: `listBookingRequests` scope `venue`
 * admits ANY member of an owning org, while `places.getPlaceForEdit` sits at
 * `canManagePlace` (OWNER/ADMIN/EDITOR). So a SCANNER renders this section
 * with the place read refused. The old `acceptsBookingRequests ?? false` in
 * `BookingInbox` folded that into "off" — about a venue whose requests were
 * ON — and pointed at a switch that is not on their page, because
 * `BookingAcceptanceToggle` returns null on the same error.
 *
 * `null` is therefore a real third state here, not a nullable convenience.
 *
 * WHAT THIS CANNOT SEE: the design system is mocked away, so nothing about
 * layout, the 320px domain row, or real focus order.
 */

const mocks = vi.hoisted(() => ({
  embedsList: vi.fn(() => ({
    data: { embeds: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

vi.mock("tamagui", () => ({
  XStack: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  YStack: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@th/ui", () => ({
  Button: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Spinner: () => <div data-testid="spinner" />,
  Text: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
  TextInput: () => <input />,
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({
  ExternalLink: () => null,
  Globe: () => null,
  Plus: () => null,
  Trash2: () => null,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({ embeds: { list: { invalidate: vi.fn() } } }),
    embeds: {
      list: { useQuery: () => mocks.embedsList() },
      upsert: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      revoke: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({ currentOwner: null }),
}));

vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => ({
    canEdit: false,
    canManage: false,
    canFinance: false,
  }),
}));

vi.mock("@/components/embeds/EmbedCodeBlock", () => ({
  EmbedCodeBlock: () => null,
}));
vi.mock("@/components/embeds/EmbedModalPreview", () => ({
  EmbedModalPreview: () => null,
}));

import { BookingEmbedSection } from "../BookingEmbedSection";

const OFF_NOTE = /Booking requests are off/;

const renderSection = (acceptsBookingRequests: boolean | null) =>
  render(
    <BookingEmbedSection
      placeId="place-1"
      slug="the-spot"
      acceptsBookingRequests={acceptsBookingRequests}
    />,
  );

describe("BookingEmbedSection — the 'requests are off' note", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the note when requests are genuinely OFF", () => {
    renderSection(false);
    expect(screen.getByText(OFF_NOTE)).toBeInTheDocument();
  });

  it("omits the note when requests are ON", () => {
    renderSection(true);
    expect(screen.queryByText(OFF_NOTE)).toBeNull();
  });

  it("omits the note when the place read did NOT resolve", () => {
    // The regression this replaces. A `?? false` at the call site, or a
    // falsy `!acceptsBookingRequests` check here, puts the note back — and it
    // is two false statements at once for a reader who cannot see the switch.
    renderSection(null);
    expect(screen.queryByText(OFF_NOTE)).toBeNull();
    // The section itself still renders; only the claim is withheld.
    expect(
      screen.getByText("Booking button for your website"),
    ).toBeInTheDocument();
  });
});
