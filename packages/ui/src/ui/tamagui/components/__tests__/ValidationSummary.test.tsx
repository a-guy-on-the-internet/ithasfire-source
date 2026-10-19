import { fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";

import { renderWithProvider } from "../../../../../test/utils";
import {
  ValidationSummary,
  useValidationSummaryFocus,
  type ValidationSummaryHandle,
} from "../forms/ValidationSummary";

const errors = [
  { id: "title", fieldId: "event-title", message: "Title — add a title" },
  { id: "doors", fieldId: "event-doors", message: "Doors — before the set" },
];

describe("ValidationSummary", () => {
  it("renders nothing when there are no errors", () => {
    renderWithProvider(<ValidationSummary errors={[]} testIdBase="vs" />);
    // The provider wraps children in its own display:contents spans, so
    // assert on the component's own output rather than the container.
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vs")).not.toBeInTheDocument();
  });

  it("renders a labelled, focusable group (not a live region) with a count heading and one entry per error", () => {
    renderWithProvider(<ValidationSummary errors={errors} testIdBase="vs" />);

    const region = screen.getByRole("group");
    expect(region).toHaveAttribute("tabindex", "-1");
    // Focus always moves here on failed submit; a live region on top would
    // announce the list twice.
    expect(region).not.toHaveAttribute("aria-live");
    expect(region).toHaveAttribute(
      "aria-labelledby",
      screen.getByTestId("vs-title").getAttribute("id"),
    );
    expect(screen.getByTestId("vs-title")).toHaveTextContent(
      "2 things need fixing",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const entry = screen.getByRole("button", { name: "Title — add a title" });
    expect(entry).toBeInTheDocument();
    // Inside a <form onSubmit> an untyped <button> submits the form.
    expect(entry).toHaveAttribute("type", "button");
  });

  it("singularises the default heading and honours a custom title", () => {
    const { rerender } = renderWithProvider(
      <ValidationSummary errors={[errors[0]!]} testIdBase="vs" />,
    );
    expect(screen.getByTestId("vs-title")).toHaveTextContent(
      "1 thing needs fixing",
    );

    rerender(
      <ValidationSummary errors={errors} title="Fix these" testIdBase="vs" />,
    );
    expect(screen.getByTestId("vs-title")).toHaveTextContent("Fix these");
  });

  it("moves focus to the field when an entry is activated", () => {
    renderWithProvider(
      <>
        <ValidationSummary errors={errors} testIdBase="vs" />
        <input id="event-title" aria-label="Event title" />
      </>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Title — add a title" }),
    );
    expect(screen.getByLabelText("Event title")).toHaveFocus();
  });

  it("delegates to onFocusField when provided instead of touching the DOM", () => {
    const onFocusField = vi.fn();
    renderWithProvider(
      <>
        <ValidationSummary
          errors={errors}
          onFocusField={onFocusField}
          testIdBase="vs"
        />
        <input id="event-title" aria-label="Event title" />
      </>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Title — add a title" }),
    );
    expect(onFocusField).toHaveBeenCalledWith("event-title");
    expect(screen.getByLabelText("Event title")).not.toHaveFocus();
  });

  it("renders entries without a fieldId as plain text, not buttons", () => {
    renderWithProvider(
      <ValidationSummary
        errors={[{ id: "generic", message: "Something is off" }]}
        testIdBase="vs"
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Something is off")).toBeInTheDocument();
  });

  it("focuses the summary through the imperative handle", () => {
    const ref = createRef<ValidationSummaryHandle>();
    renderWithProvider(
      <ValidationSummary ref={ref} errors={errors} testIdBase="vs" />,
    );

    ref.current?.focus();
    expect(screen.getByRole("group")).toHaveFocus();
  });

  it("useValidationSummaryFocus moves focus after the next frame", () => {
    vi.useFakeTimers();
    try {
      const Harness = () => {
        const summary = useValidationSummaryFocus();
        return (
          <>
            <ValidationSummary
              ref={summary.ref}
              errors={errors}
              testIdBase="vs"
            />
            <button type="button" onClick={summary.focusSummary}>
              Submit
            </button>
          </>
        );
      };
      renderWithProvider(<Harness />);

      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
      vi.runAllTimers();
      expect(screen.getByRole("group")).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });
});
