import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Who sees which lifecycle action (owner decision 2026-08-25: "terms should
 * only be editable by the venue/organizer side of the request"). Pinned here:
 *
 *  - the ACT side never sees send-for-review, pull-back, or reopen — on DRAFT
 *    it gets one explanatory line instead of a form, on PROPOSED it gets
 *    exactly accept + decline;
 *  - the EDITOR side keeps every affordance it had;
 *  - an agreement with no originating request (`viewerSide: null`) behaves
 *    like the editor for both parties.
 *
 * The design system is mocked away — this proves wiring, not looks.
 */

const KEEP = (k: string) =>
  k === "id" || k === "role" || k === "disabled" || k.startsWith("aria-");

function domProps(rest: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (KEEP(k)) safe[k] = v;
    else if (k === "testID" || k === "testId") safe["data-testid"] = v;
  }
  return safe;
}

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  Spinner: () => <span data-testid="spinner" />,
  Button: ({ children, onPress, ...rest }: any) => (
    <button onClick={onPress} {...domProps(rest)}>
      {children}
    </button>
  ),
  Text: ({ children, tag, htmlFor, ...rest }: any) =>
    tag === "label" ? (
      <label htmlFor={htmlFor} {...domProps(rest)}>
        {children}
      </label>
    ) : (
      <span {...domProps(rest)}>{children}</span>
    ),
  TextInput: React.forwardRef(
    ({ value, onChangeText, ...rest }: any, ref: any) => (
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChangeText?.(e.target.value)}
        {...domProps(rest)}
      />
    ),
  ),
}));

vi.mock("tamagui", () => {
  const passthrough = () => (props: any) => {
    const { children, ...rest } = props;
    return <div {...domProps(rest)}>{children}</div>;
  };
  return { XStack: passthrough(), YStack: passthrough() };
});

vi.mock("lucide-react", () => {
  const icon = () => <span aria-hidden="true" />;
  return { FileX: icon, Send: icon, Undo2: icon };
});

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="confirm-dialog" /> : null,
}));

const cancelMutate = vi.fn();

vi.mock("@/trpc", () => {
  // Inline: `vi.mock` is hoisted, so a top-level helper is not yet defined.
  const mutation = () => ({
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  });
  return {
    trpc: {
      bookingAgreements: {
        sendForReview: mutation(),
        pullBack: mutation(),
        respond: mutation(),
        reopen: mutation(),
        cancel: {
          useMutation: () => ({ mutate: cancelMutate, isPending: false }),
        },
      },
    },
  };
});

import { NegotiationBar } from "../NegotiationBar";
import { fireEvent } from "@testing-library/react";

const AGREEMENT = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "PERFORMANCE",
  status: "DRAFT" as const,
  proposerType: "human" as const,
  proposerId: "33333333-3333-4333-8333-333333333333",
  proposerDisplayName: "Nyx Quartet",
  counterpartyType: "organization" as const,
  counterpartyId: "22222222-2222-4222-8222-222222222222",
  counterpartyDisplayName: "The Velvet Room",
  placeId: "44444444-4444-4444-8444-444444444444",
  eventId: null,
  payoutTermsId: "55555555-5555-4555-8555-555555555555",
  title: "Nyx Quartet at The Velvet Room",
  description: null,
  proposedDate: null,
  proposedEndDate: null,
  guaranteeCents: null,
  proposedAt: null,
  acceptedAt: null,
  declinedAt: null,
  declinedReason: null,
  expiresAt: null,
  fulfilledAt: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

type Props = React.ComponentProps<typeof NegotiationBar>;

function renderBar(overrides: Partial<Props> = {}) {
  return render(
    <NegotiationBar
      agreementId={AGREEMENT.id}
      agreement={AGREEMENT}
      event={null}
      mayEdit
      mayAct
      canEditTerms
      viewerSide="editor"
      blockedLineCount={0}
      onRefresh={vi.fn()}
      onActionError={vi.fn()}
      onRequestFinalize={vi.fn()}
      {...overrides}
    />,
  );
}

/** The act side as the server describes it. */
const ACT = { mayEdit: false, canEditTerms: false, viewerSide: "act" as const };

describe("NegotiationBar — act side (read-only terms)", () => {
  it("DRAFT: one explanatory line, no send-for-review", () => {
    renderBar(ACT);

    expect(screen.getByTestId("ba-act-side-notice")).toHaveTextContent(
      "admin.baActSideTermsNotice",
    );
    expect(screen.queryByTestId("ba-send-for-review")).toBeNull();
    // Not the generic "read-only" line either — the act gets the reason.
    expect(screen.queryByText("admin.baReadOnlyNotice")).toBeNull();
  });

  it("PROPOSED: accept and decline only — no pull-back, no counter", () => {
    renderBar({
      ...ACT,
      agreement: { ...AGREEMENT, status: "PROPOSED" },
    });

    expect(screen.getByTestId("ba-accept")).toBeInTheDocument();
    expect(screen.getByTestId("ba-decline")).toBeInTheDocument();
    expect(screen.queryByTestId("ba-pull-back")).toBeNull();
    expect(screen.getByTestId("ba-act-side-notice")).toHaveTextContent(
      "admin.baActSideProposedNotice",
    );
    expect(screen.queryByText(/counter/i)).toBeNull();
    // Cancel is the editor's exit — the act declines instead.
    expect(screen.queryByTestId("ba-cancel")).toBeNull();
  });

  it("never sees Cancel agreement, in any cancellable status", () => {
    for (const status of ["DRAFT", "PROPOSED", "ACCEPTED"] as const) {
      const { unmount } = renderBar({
        ...ACT,
        agreement: { ...AGREEMENT, status },
      });
      expect(screen.queryByTestId("ba-cancel")).toBeNull();
      unmount();
    }
  });

  it("ACCEPTED (unfinalized): no reopen, and no reopen hint for blocked lines", () => {
    renderBar({
      ...ACT,
      agreement: { ...AGREEMENT, status: "ACCEPTED" },
      blockedLineCount: 2,
    });

    expect(screen.queryByTestId("ba-reopen-open")).toBeNull();
    expect(screen.queryByTestId("ba-blocked-lines-hint")).toBeNull();
  });
});

describe("NegotiationBar — editor side owns the terms", () => {
  it("DRAFT: send for review, with the editor's own copy", () => {
    renderBar();
    expect(screen.getByTestId("ba-send-for-review")).toBeInTheDocument();
    expect(screen.getByText("admin.baEditorDraftNotice")).toBeInTheDocument();
    expect(screen.queryByText("admin.baDraftNotice")).toBeNull();
    expect(screen.queryByTestId("ba-act-side-notice")).toBeNull();
  });

  it("PROPOSED: pull back and cancel — the editor cannot self-accept or decline", () => {
    renderBar({ agreement: { ...AGREEMENT, status: "PROPOSED" } });
    expect(screen.getByTestId("ba-pull-back")).toBeInTheDocument();
    expect(screen.getByTestId("ba-cancel")).toBeInTheDocument();
    expect(screen.queryByTestId("ba-accept")).toBeNull();
    expect(screen.queryByTestId("ba-decline")).toBeNull();
    expect(
      screen.getByText("admin.baEditorProposedNotice"),
    ).toBeInTheDocument();
  });

  it("DRAFT: cancel sits beside send for review", () => {
    renderBar();
    expect(screen.getByTestId("ba-send-for-review")).toBeInTheDocument();
    expect(screen.getByTestId("ba-cancel")).toBeInTheDocument();
  });

  it("ACCEPTED (unfinalized): cancel sits beside finalize and reopen", () => {
    renderBar({ agreement: { ...AGREEMENT, status: "ACCEPTED" } });
    expect(screen.getByTestId("ba-finalize-open")).toBeInTheDocument();
    expect(screen.getByTestId("ba-reopen-open")).toBeInTheDocument();
    expect(screen.getByTestId("ba-cancel")).toBeInTheDocument();
  });

  it("ACCEPTED (finalized): no cancel — the linked event settles on these terms", () => {
    renderBar({
      agreement: { ...AGREEMENT, status: "ACCEPTED", eventId: "ev-1" },
    });
    expect(screen.queryByTestId("ba-cancel")).toBeNull();
    expect(screen.getByText("admin.baFinalizedNotice")).toBeInTheDocument();
  });

  it("terminal statuses: no cancel", () => {
    for (const status of ["DECLINED", "CANCELLED"] as const) {
      const { unmount } = renderBar({ agreement: { ...AGREEMENT, status } });
      expect(screen.queryByTestId("ba-cancel")).toBeNull();
      unmount();
    }
  });

  it("without an edit-level role (canEditTerms false) the cancel button is hidden", () => {
    for (const status of ["PROPOSED", "ACCEPTED"] as const) {
      const { unmount } = renderBar({
        canEditTerms: false,
        agreement: { ...AGREEMENT, status },
      });
      expect(screen.queryByTestId("ba-pull-back")).toBeNull();
      expect(screen.queryByTestId("ba-reopen-open")).toBeNull();
      expect(screen.queryByTestId("ba-cancel")).toBeNull();
      unmount();
    }
  });

  it("cancel: the reason field takes focus when the panel opens", () => {
    renderBar();
    fireEvent.click(screen.getByTestId("ba-cancel"));
    expect(screen.getByTestId("ba-cancel-reason")).toHaveFocus();
  });

  it("cancel: confirm sends the trimmed reason and keeps its name while pending", () => {
    cancelMutate.mockClear();
    renderBar({ agreement: { ...AGREEMENT, status: "PROPOSED" } });
    fireEvent.click(screen.getByTestId("ba-cancel"));
    fireEvent.change(screen.getByTestId("ba-cancel-reason"), {
      target: { value: "  room double-booked  " },
    });
    const confirm = screen.getByTestId("ba-cancel-confirm");
    expect(confirm).toHaveAttribute("aria-label", "admin.baCancelConfirm");
    fireEvent.click(confirm);
    expect(cancelMutate).toHaveBeenCalledTimes(1);
    expect(cancelMutate.mock.calls[0][0]).toEqual({
      agreementId: AGREEMENT.id,
      reason: "room double-booked",
    });
  });

  it("cancel: warns about the orphaned draft event only when one exists unfinalized", () => {
    const draftEvent = {
      id: "66666666-6666-4666-8666-666666666666",
      status: "DRAFT" as const,
      startsAt: new Date("2026-10-01T00:00:00.000Z"),
    };
    const { unmount } = renderBar({
      agreement: { ...AGREEMENT, status: "ACCEPTED" },
      event: draftEvent,
    });
    fireEvent.click(screen.getByTestId("ba-cancel"));
    expect(screen.getByTestId("ba-cancel-draft-event-hint")).toHaveTextContent(
      "admin.baCancelDraftEventHint",
    );
    unmount();

    renderBar({ agreement: { ...AGREEMENT, status: "ACCEPTED" } });
    fireEvent.click(screen.getByTestId("ba-cancel"));
    expect(screen.queryByTestId("ba-cancel-draft-event-hint")).toBeNull();
  });

  it("cancel: the reason panel expands inline and the confirm is gated on 3 trimmed chars", () => {
    renderBar({ agreement: { ...AGREEMENT, status: "PROPOSED" } });
    expect(screen.queryByTestId("ba-cancel-reason")).toBeNull();

    fireEvent.click(screen.getByTestId("ba-cancel"));
    const reason = screen.getByTestId("ba-cancel-reason");
    const confirm = screen.getByTestId("ba-cancel-confirm");
    expect(confirm).toBeDisabled();
    expect(screen.getByText("admin.baCancelReasonHint")).toBeInTheDocument();
    // The panel's own dismiss is NOT another "Cancel" — distinct name from
    // the "Cancel agreement" trigger one tab above it.
    expect(screen.getByText("admin.baCancelDismiss")).toBeInTheDocument();

    fireEvent.change(reason, { target: { value: "  ab  " } });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: "  abc " } });
    expect(confirm).not.toBeDisabled();

    // Toggling the trigger closes the panel and clears the draft reason.
    fireEvent.click(screen.getByTestId("ba-cancel"));
    expect(screen.queryByTestId("ba-cancel-reason")).toBeNull();
  });

  it("ACCEPTED (unfinalized): finalize, reopen, and the blocked-lines hint", () => {
    renderBar({
      agreement: { ...AGREEMENT, status: "ACCEPTED" },
      blockedLineCount: 1,
    });
    expect(screen.getByTestId("ba-finalize-open")).toBeInTheDocument();
    expect(screen.getByTestId("ba-reopen-open")).toBeInTheDocument();
    expect(screen.getByTestId("ba-blocked-lines-hint")).toBeInTheDocument();
  });
});

describe("NegotiationBar — no originating request", () => {
  it("keeps the collaborative rule and copy for both parties (viewerSide null)", () => {
    renderBar({
      viewerSide: null,
      agreement: { ...AGREEMENT, status: "PROPOSED" },
    });
    expect(screen.getByTestId("ba-pull-back")).toBeInTheDocument();
    expect(screen.getByTestId("ba-accept")).toBeInTheDocument();
    expect(screen.getByTestId("ba-decline")).toBeInTheDocument();
    expect(screen.getByText("admin.baProposedNotice")).toBeInTheDocument();
    expect(screen.queryByTestId("ba-act-side-notice")).toBeNull();
  });

  it("DRAFT keeps the collaborative copy (viewerSide null)", () => {
    renderBar({ viewerSide: null });
    expect(screen.getByText("admin.baDraftNotice")).toBeInTheDocument();
  });
});
