import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OrganizerBookingDialog (organizer-booking-requests FR-009): sender-org gate
 * → request form → success. These tests pin the org-picker composition (edit
 * roles only, self-booking excluded, calm zero-org empty state), client-side
 * validation, the wire payload for `bookingRequests.createToPerformer`, and
 * the duplicate-open-request error surface.
 */

const testMocks = vi.hoisted(() => ({
  owners: vi.fn(),
  eventsUseQuery: vi.fn(),
  createMutate: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    events: {
      listMine: { useQuery: testMocks.eventsUseQuery },
    },
    bookingRequests: {
      createToPerformer: {
        useMutation: () => ({
          mutate: testMocks.createMutate,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => testMocks.owners(),
}));

vi.mock("@th/ui", () => {
  const Modal = ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null;
  Modal.Panel = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  Modal.Header = ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header>
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </header>
  );
  Modal.Body = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  Modal.Footer = ({ children }: { children?: ReactNode }) => (
    <footer>{children}</footer>
  );
  return {
    Modal,
    useFormatters: () => ({
      dateTime: () => "date",
    }),
    // Key-echo translator (same convention as ReceivedBookingRequestsList.test.tsx).
    useTranslations:
      () =>
      (key: string, values?: Record<string, unknown>) =>
        values
          ? `${key} ${Object.entries(values)
              .map(([name, value]) => `${name}=${String(value)}`)
              .join(" ")}`
          : key,
  };
});

import { OrganizerBookingDialog } from "../OrganizerBookingDialog";

function orgOwner(overrides: Record<string, unknown> = {}) {
  return {
    kind: "org",
    orgId: "org-1",
    orgName: "Ryman Presents",
    orgSlug: "ryman",
    role: "ADMIN",
    adminSlug: "ryman",
    ...overrides,
  };
}

function mockOwners(ownersWithSlugs: unknown[] | undefined) {
  testMocks.owners.mockReturnValue({
    ownersWithSlugs,
    isPending: false,
    isError: false,
  });
}

function renderDialog(overrides: Record<string, unknown> = {}) {
  return render(
    <OrganizerBookingDialog
      open
      onClose={vi.fn()}
      performerOwnerType="human"
      performerOwnerId="human-9"
      performerName="Jo Artist"
      title="profileStd.requestToBookCta"
      {...overrides}
    />,
  );
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText("admin.bkFormMessageLabel"), {
    target: { value: "We'd love to have you on our summer bill." },
  });
  fireEvent.change(screen.getByLabelText("admin.bkFormDatesLabel 1"), {
    target: { value: "2027-08-01" },
  });
}

describe("OrganizerBookingDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMocks.eventsUseQuery.mockReturnValue({
      data: { items: [] },
      isLoading: false,
      isError: false,
    });
  });

  it("shows the calm empty state with a link to the admin area when the viewer has no eligible org", () => {
    // A VIEWER role never qualifies as a sender.
    mockOwners([orgOwner({ role: "VIEWER" })]);

    renderDialog();

    expect(screen.getByText("admin.bkOrgNoOrgTitle")).toBeInTheDocument();
    const link = screen.getByText("admin.bkOrgNoOrgCta").closest("a");
    expect(link).toHaveAttribute("href", "/admin");
    expect(
      screen.queryByLabelText("admin.bkFormMessageLabel"),
    ).not.toBeInTheDocument();
  });

  it("excludes the target org itself from the sender pool (self-booking)", () => {
    mockOwners([orgOwner()]);

    renderDialog({ performerOwnerType: "org", performerOwnerId: "org-1" });

    // The only edit-role org IS the act — empty state, not a doomed form.
    expect(screen.getByText("admin.bkOrgNoOrgTitle")).toBeInTheDocument();
  });

  it("shows a quiet identity line for a single sender org and a picker for several", () => {
    mockOwners([orgOwner()]);
    const { unmount } = renderDialog();
    expect(
      screen.getByText("admin.bkOrgSendingAs org=Ryman Presents"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("admin.bkFormSenderLabel"),
    ).not.toBeInTheDocument();
    unmount();

    mockOwners([
      orgOwner(),
      orgOwner({ orgId: "org-2", orgName: "Basement Shows", adminSlug: "basement" }),
    ]);
    renderDialog();
    const picker = screen.getByLabelText("admin.bkFormSenderLabel");
    expect(picker).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Ryman Presents" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Basement Shows" }),
    ).toBeInTheDocument();
  });

  it("validates the message length client-side before mutating", () => {
    mockOwners([orgOwner()]);

    renderDialog();

    fireEvent.change(screen.getByLabelText("admin.bkFormMessageLabel"), {
      target: { value: "too short" },
    });
    fireEvent.change(screen.getByLabelText("admin.bkFormDatesLabel 1"), {
      target: { value: "2027-08-01" },
    });
    fireEvent.submit(
      screen.getByRole("form", { name: "profileStd.requestToBookCta" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "admin.bkErrMessageTooShort",
    );
    expect(testMocks.createMutate).not.toHaveBeenCalled();
  });

  it("submits the wire payload for createToPerformer", () => {
    mockOwners([orgOwner()]);

    renderDialog();

    fillRequiredFields();
    fireEvent.submit(
      screen.getByRole("form", { name: "profileStd.requestToBookCta" }),
    );

    expect(testMocks.createMutate).toHaveBeenCalledWith(
      {
        organizerOrgId: "org-1",
        performerOwnerType: "human",
        performerOwnerId: "human-9",
        message: "We'd love to have you on our summer bill.",
        preferredDates: ["2027-08-01"],
      },
      expect.anything(),
    );
  });

  it("shows the success screen with a bookings-hub link after a successful send", () => {
    mockOwners([orgOwner()]);
    testMocks.createMutate.mockImplementation(
      (_input: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );

    renderDialog();

    fillRequiredFields();
    fireEvent.submit(
      screen.getByRole("form", { name: "profileStd.requestToBookCta" }),
    );

    expect(
      screen.getByText("admin.bkOrgSuccessTitle act=Jo Artist"),
    ).toBeInTheDocument();
    const link = screen.getByText("admin.bkOrgSuccessLink").closest("a");
    expect(link).toHaveAttribute("href", "/admin/ryman/bookings");
  });

  it("offers the event attach only when the sender org has attachable events", () => {
    mockOwners([orgOwner()]);
    const { unmount } = renderDialog();
    // No events → no dead select.
    expect(
      screen.queryByLabelText(/admin\.bkOrgEventAttachLabel/),
    ).not.toBeInTheDocument();
    unmount();

    testMocks.eventsUseQuery.mockReturnValue({
      data: {
        items: [
          {
            id: "3f1f9a5e-0000-4000-8000-000000000001",
            title: "Summer Showcase",
            status: "PUBLISHED",
            startsAt: new Date("2027-08-01T20:00:00Z"),
          },
        ],
      },
      isLoading: false,
      isError: false,
    });
    renderDialog();
    expect(
      screen.getByLabelText(/admin\.bkOrgEventAttachLabel/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Summer Showcase/ }),
    ).toBeInTheDocument();
  });

  it("surfaces duplicate_open_request as a friendly inline error", () => {
    mockOwners([orgOwner()]);
    testMocks.createMutate.mockImplementation(
      (_input: unknown, opts: { onError: (err: unknown) => void }) =>
        opts.onError({ data: { appCode: "DUPLICATE_OPEN_REQUEST" } }),
    );

    renderDialog();

    fillRequiredFields();
    fireEvent.submit(
      screen.getByRole("form", { name: "profileStd.requestToBookCta" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "admin.bkOrgErrDuplicate",
    );
  });
});
