import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * BookingRequestDialog: hands the trigger's intent to the panel and reads the
 * success copy per intent — with the parked-at-an-unclaimed-venue variant.
 */

vi.mock("@th/ui", () => {
  const Modal = ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null;
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

vi.mock("../blocks/RequestToPlayForm", () => ({
  RequestToPlayPanel: ({
    intent,
    onSuccess,
  }: {
    intent: string | null;
    onSuccess: (r: { intent: string }) => void;
  }) => (
    <div data-testid="panel" data-intent={intent ?? ""}>
      <button
        type="button"
        onClick={() => onSuccess({ intent: "PERFORM" })}
      >
        sent-perform
      </button>
      <button
        type="button"
        onClick={() => onSuccess({ intent: "RENT" })}
      >
        sent-rent
      </button>
      <button
        type="button"
        onClick={() => onSuccess({ intent: "USE" })}
      >
        sent-use
      </button>
    </div>
  ),
}));

import { BookingRequestDialog } from "../BookingRequestDialog";

function renderDialog(props: Partial<React.ComponentProps<typeof BookingRequestDialog>> = {}) {
  return render(
    <BookingRequestDialog
      open
      onClose={vi.fn()}
      placeId="place-1"
      placeName="Velvet Room"
      title="places.heroRequestToBookCta"
      {...props}
    />,
  );
}

describe("BookingRequestDialog", () => {
  it("passes the trigger's intent to the panel", () => {
    renderDialog({ intent: "RENT" });
    expect(screen.getByTestId("panel")).toHaveAttribute("data-intent", "RENT");
  });

  it("reads the success body per intent; there is no parked variant any more", () => {
    const { unmount } = renderDialog();
    fireEvent.click(screen.getByText("sent-perform"));
    expect(
      screen.getByText("admin.bkSuccessTitle place=Velvet Room"),
    ).toBeInTheDocument();
    expect(screen.getByText("admin.bkSuccessBody")).toBeInTheDocument();
    unmount();

    const rent = renderDialog();
    fireEvent.click(screen.getByText("sent-rent"));
    expect(screen.getByText("admin.bkSuccessBodyRent")).toBeInTheDocument();
    rent.unmount();

    // Amendment 2026-09-25: an unclaimed venue takes no requests, so no
    // success can be "parked". USE reads the default body.
    renderDialog();
    fireEvent.click(screen.getByText("sent-use"));
    expect(screen.getByText("admin.bkSuccessBody")).toBeInTheDocument();
    expect(screen.queryByText("admin.bkSuccessBodyParked")).not.toBeInTheDocument();
  });

  it("reopens on a fresh form", () => {
    const { rerender } = renderDialog();
    fireEvent.click(screen.getByText("sent-rent"));
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument();

    rerender(
      <BookingRequestDialog
        open={false}
        onClose={vi.fn()}
        placeId="place-1"
        placeName="Velvet Room"
        title="t"
      />,
    );
    rerender(
      <BookingRequestDialog
        open
        onClose={vi.fn()}
        placeId="place-1"
        placeName="Velvet Room"
        title="t"
      />,
    );
    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });
});
