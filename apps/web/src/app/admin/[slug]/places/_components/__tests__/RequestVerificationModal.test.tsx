import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-012/FR-013 — the modal presentation of the ONE verification-request
 * implementation (`VerificationRequestForm`).
 *
 * What this pins: the modal really renders the shared upload form (not a
 * lookalike), a staged document goes presign → PUT → `submitPlaceVerification`
 * with the right payload, success closes the dialog, and the blockers panel
 * refuses submission when the editor is dirty or the place is ineligible.
 *
 * What it deliberately does NOT pin: Escape-to-dismiss and focus-return. Those
 * live in `@th/ui`'s `Modal` primitive, which this suite (like every other
 * dialog suite in the app) stubs out — jsdom + a stubbed design system cannot
 * honestly evidence them. They are verified by driving the real page.
 */

const ORG_ID = "77777777-7777-4777-8777-777777777777";
const PLACE_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  presignMutateAsync: vi.fn(() =>
    Promise.resolve({
      key: "verif/doc-1.pdf",
      uploadUrl: "https://r2.example/put",
    }),
  ),
  submitMutateAsync: vi.fn(() => Promise.resolve({ requestId: "req-1" })),
  detailQuery: vi.fn(() => ({ data: undefined as unknown })),
  eligibility: vi.fn(() => ({ eligible: true, reasons: [] as string[] })),
  toastWarning: vi.fn(),
  toastDanger: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    onPress?: () => void;
  } & Record<string, unknown>) => {
    const safe: Record<string, unknown> = { onClick: onPress };
    for (const [key, value] of Object.entries(props)) {
      if (key === "data-testid" || key.startsWith("aria-")) safe[key] = value;
    }
    return React.createElement("div", safe, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({
      danger: { val: "#B93312" },
      warning: { val: "#F59E0B" },
      info: { val: "#35589A" },
      colorMuted: { val: "#5C544A" },
    }),
  };
});

vi.mock("@th/ui", () => {
  // Mirrors the real Modal: NO children render while closed. That is what
  // makes "closed ⇒ the form (and its getPlaceDetail read) never mounts" a
  // real assertion here.
  const ModalRoot = ({
    open,
    children,
    onClose,
  }: {
    open?: boolean;
    children?: ReactNode;
    onClose?: () => void;
  }) =>
    open ? (
      <div data-testid="modal">
        {/* Stands in for the backdrop press AND the Escape key: the real Modal
            routes BOTH through the same `onClose`, which is exactly why the
            component cannot tell them apart and treats both as "dismiss". */}
        <button type="button" onClick={onClose}>
          backdrop-dismiss
        </button>
        {children}
      </div>
    ) : null;
  const ModalPanel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const ModalHeader = ({
    title,
    subtitle,
    onClose,
  }: {
    title?: string;
    subtitle?: string;
    onClose?: () => void;
  }) => (
    <div>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close">
          x
        </button>
      )}
    </div>
  );
  const ModalBody = ({ children }: { children?: ReactNode }) => (
    <div data-testid="modal-body">{children}</div>
  );
  const ModalFooter = ({ children }: { children?: ReactNode }) => (
    <div data-testid="modal-footer">{children}</div>
  );
  return {
    Modal: Object.assign(ModalRoot, {
      Panel: ModalPanel,
      Header: ModalHeader,
      Body: ModalBody,
      Footer: ModalFooter,
    }),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Spinner: () => <div data-testid="spinner" />,
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    } & Record<string, unknown>) => (
      <button
        type="button"
        onClick={onPress}
        disabled={disabled}
        aria-label={rest["aria-label"] as string | undefined}
      >
        {children}
      </button>
    ),
    useNotify: () => ({
      toast: {
        success: mocks.toastSuccess,
        warning: mocks.toastWarning,
        danger: mocks.toastDanger,
        info: mocks.toastInfo,
      },
    }),
    useTranslations: () => (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(" ")}` : key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        getPlaceForEdit: { invalidate: vi.fn() },
        getPlaceDetail: { invalidate: vi.fn() },
        getPlaceTitle: { invalidate: vi.fn() },
        listHumanPlaces: { invalidate: vi.fn() },
      },
    }),
    places: {
      getPlaceDetail: { useQuery: () => mocks.detailQuery() },
      requestVerificationDocUpload: {
        useMutation: () => ({ mutateAsync: mocks.presignMutateAsync }),
      },
      submitPlaceVerification: {
        useMutation: () => ({ mutateAsync: mocks.submitMutateAsync }),
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "boom",
}));

vi.mock("@/lib/format", () => ({
  formatBytes: (n: number) => `${n}B`,
}));

// Pass-through: the HEIC branch is exercised by the upload helper's own suite.
vi.mock("@/lib/images/prepare-image-upload", () => ({
  prepareImageForUpload: (file: File) => Promise.resolve(file),
}));

vi.mock("@th/core/use-cases/places", () => ({
  getPlaceVerificationEligibility: () => mocks.eligibility(),
}));

import { RequestVerificationModal } from "../RequestVerificationModal";

const onClose = vi.fn();

function renderModal(props: Partial<{ isDirty: boolean; open: boolean }> = {}) {
  return render(
    <RequestVerificationModal
      open
      placeId={PLACE_ID}
      placeName="The Velvet Room"
      access={{ orgIds: [ORG_ID], humanIds: [] }}
      formState={{
        name: "The Velvet Room",
        addressLine1: "123 Main St",
        city: "Portland",
        countryCode: "US",
      }}
      onClose={onClose}
      {...props}
    />,
  );
}

/**
 * `act` around a synchronous trigger, then a flushed microtask queue — the
 * form's handlers are async, so assertions must run after they settle.
 */
const actAndFlush = async (fn: () => void) => {
  await act(async () => {
    fn();
    await Promise.resolve();
  });
};

function stageFile(container: HTMLElement, name = "license.pdf") {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File(["x"], name, { type: "application/pdf" });
  // jsdom's FileList is read-only; define the property the handler reads.
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  return actAndFlush(() => fireEvent.change(input));
}

describe("RequestVerificationModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detailQuery.mockReturnValue({ data: undefined });
    mocks.eligibility.mockReturnValue({ eligible: true, reasons: [] });
    mocks.presignMutateAsync.mockResolvedValue({
      key: "verif/doc-1.pdf",
      uploadUrl: "https://r2.example/put",
    });
    mocks.submitMutateAsync.mockResolvedValue({ requestId: "req-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
    );
  });

  it("renders the shared upload form inside the dialog, titled for the place", () => {
    renderModal();

    expect(screen.getByText("admin.placeVerifModalTitle")).toBeInTheDocument();
    expect(screen.getByText("The Velvet Room")).toBeInTheDocument();
    // The real drop zone / instructions from VerificationRequestForm, not a
    // lookalike: these keys only exist in that component.
    expect(
      screen.getByText("admin.placeVerifDropOrBrowse"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("admin.placeVerifWhatToUpload"),
    ).toBeInTheDocument();
    // Actions land in the dialog FOOTER, not adrift at the end of the body.
    const footer = screen.getByTestId("modal-footer");
    expect(footer).toHaveTextContent("admin.placeVerifSubmitForReview");
    expect(footer).toHaveTextContent("admin.placeVerifCancel");
  });

  it("cannot submit until a document is staged", () => {
    renderModal();

    expect(
      screen.getByText("admin.placeVerifSubmitForReview").closest("button"),
    ).toBeDisabled();
  });

  it("uploads the staged document and creates the verification request", async () => {
    const { container } = renderModal();

    await stageFile(container);

    expect(screen.getByText("license.pdf")).toBeInTheDocument();

    await actAndFlush(() =>
      fireEvent.click(screen.getByText("admin.placeVerifSubmitForReview")),
    );

    expect(mocks.presignMutateAsync).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      contentType: "application/pdf",
      sizeBytes: 1,
      fileName: "license.pdf",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://r2.example/put",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(mocks.submitMutateAsync).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      orgId: ORG_ID,
      documents: [
        {
          storageKey: "verif/doc-1.pdf",
          fileName: "license.pdf",
          contentType: "application/pdf",
          sizeBytes: 1,
        },
      ],
    });
    // Success closes the dialog.
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog open and reports the failure when submit throws", async () => {
    mocks.submitMutateAsync.mockRejectedValueOnce(new Error("nope"));
    const { container } = renderModal();

    await stageFile(container);
    await actAndFlush(() =>
      fireEvent.click(screen.getByText("admin.placeVerifSubmitForReview")),
    );

    expect(mocks.toastDanger).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("blocks submission with a stated reason while the editor is dirty", async () => {
    const { container } = renderModal({ isDirty: true });

    await stageFile(container);

    expect(
      screen.getByText("admin.placeVerifBlockedHeading"),
    ).toBeInTheDocument();
    expect(screen.getByText("admin.placeVerifSaveFirst")).toBeInTheDocument();
    expect(
      screen.getByText("admin.placeVerifSubmitForReview").closest("button"),
    ).toBeDisabled();
  });

  it("lists every eligibility blocker instead of a silently disabled button", () => {
    mocks.eligibility.mockReturnValue({
      eligible: false,
      reasons: ["Street address is required.", "City is required."],
    });

    renderModal();

    expect(screen.getByText("Street address is required.")).toBeInTheDocument();
    expect(screen.getByText("City is required.")).toBeInTheDocument();
  });

  it("offers the reuse-docs toggle when a rejected request has documents", () => {
    mocks.detailQuery.mockReturnValue({
      data: {
        verification: {
          activeRequest: null,
          history: [
            {
              id: "req-old",
              status: "REJECTED",
              documents: [{ deletedAt: null }, { deletedAt: new Date() }],
            },
          ],
        },
      },
    });

    const { container } = renderModal();

    expect(
      screen.getByText("admin.placeVerifReuseDocsLabel"),
    ).toBeInTheDocument();
    // Only the NON-deleted document counts toward the reuse hint.
    expect(
      screen.getByText("admin.placeVerifReuseDocsHint 1"),
    ).toBeInTheDocument();
    // …and it alone satisfies the "at least one document" rule.
    expect(
      screen.getByText("admin.placeVerifSubmitForReview").closest("button"),
    ).not.toBeDisabled();
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
  });

  it("renders NOTHING while closed — no dialog, no getPlaceDetail read", () => {
    renderModal({ open: false });

    expect(screen.queryByTestId("modal")).toBeNull();
    expect(screen.queryByText("admin.placeVerifDropOrBrowse")).toBeNull();
  });

  // ── Discard guard ───────────────────────────────────────────────────────
  //
  // `Modal` unmounts its children on close and the form owns `stagedFiles`, so
  // every close path destroys staged uploads. The inline /verify presentation
  // had no backdrop, so this hazard arrived WITH the modal.

  it("refuses an accidental dismiss while documents are staged, and says so", async () => {
    const { container } = renderModal();
    await stageFile(container);

    fireEvent.click(screen.getByText("backdrop-dismiss"));

    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalled();
    // Still there, still staged.
    expect(screen.getByText("license.pdf")).toBeInTheDocument();
  });

  it("allows a dismiss when nothing is staged", () => {
    renderModal();

    fireEvent.click(screen.getByText("backdrop-dismiss"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("confirms before discarding staged documents via Cancel", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = renderModal();
    await stageFile(container);

    fireEvent.click(screen.getByText("admin.placeVerifCancel"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByText("admin.placeVerifCancel"));
    expect(onClose).toHaveBeenCalledTimes(1);

    confirmSpy.mockRestore();
  });

  it("confirms before discarding staged documents via the header close", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = renderModal();
    await stageFile(container);

    fireEvent.click(screen.getByLabelText("Close"));

    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("does not confirm when there is nothing to discard", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderModal();

    fireEvent.click(screen.getByText("admin.placeVerifCancel"));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("closes on a successful submit without asking anything", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = renderModal();
    await stageFile(container);

    await actAndFlush(() =>
      fireEvent.click(screen.getByText("admin.placeVerifSubmitForReview")),
    );

    // The files were consumed, not discarded — no confirm, no refusal.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("refuses EVERY close path while an upload is in flight", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    // Hang the presign so the form stays in its uploading state.
    mocks.presignMutateAsync.mockImplementation(() => new Promise(() => {}));

    const { container } = renderModal();
    await stageFile(container);
    await actAndFlush(() =>
      fireEvent.click(screen.getByText("admin.placeVerifSubmitForReview")),
    );

    fireEvent.click(screen.getByText("backdrop-dismiss"));
    fireEvent.click(screen.getByLabelText("Close"));

    expect(onClose).not.toHaveBeenCalled();
    // Orphaning a half-run presign→PUT loop is worse than an unclosable
    // dialog, so not even an explicit close gets a confirm here.
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("cancel and the header close both dismiss without submitting", () => {
    renderModal();

    fireEvent.click(screen.getByText("admin.placeVerifCancel"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mocks.submitMutateAsync).not.toHaveBeenCalled();
  });
});
