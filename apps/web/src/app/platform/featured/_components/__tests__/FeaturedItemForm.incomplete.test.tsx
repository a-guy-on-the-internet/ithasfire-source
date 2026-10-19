import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * A half-typed "curated until" must block the submit. Chrome reports "" while
 * some segments are blank, which unguarded saved the item with no end date.
 */

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough };
});

vi.mock("lucide-react", () => ({ Star: () => <span aria-hidden="true" /> }));

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    id,
    role,
  }: {
    children?: ReactNode;
    id?: string;
    role?: string;
  }) => (
    <span id={id} role={role}>
      {children}
    </span>
  ),
  useTranslations: () => (key: string) => key,
}));

vi.mock("../styled", () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ITEM_TYPES: ["EVENT", "HUMAN", "ORGANIZATION", "PLACE"],
    TYPE_BADGE_KEYS: {
      EVENT: "e",
      HUMAN: "h",
      ORGANIZATION: "o",
      PLACE: "p",
    },
    CTA_URL_PLACEHOLDERS: { EVENT: "", HUMAN: "", ORGANIZATION: "", PLACE: "" },
    SectionHeader: box,
    FormCard: box,
    FieldRow: box,
    FieldLabel: ({
      children,
      htmlFor,
    }: {
      children?: ReactNode;
      htmlFor?: string;
    }) => <label htmlFor={htmlFor}>{children}</label>,
    SubmitButton: ({
      children,
      onPress,
      disabled,
      "data-testid": testId,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      "data-testid"?: string;
    }) => (
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={() => onPress?.()}
      >
        {children}
      </button>
    ),
    WebInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
      <input {...props} />
    ),
    WebSelect: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
      <select {...props} />
    ),
    WebTextarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
      <textarea {...props} />
    ),
  };
});

import { FeaturedItemForm } from "../FeaturedItemForm";

/** Chrome's half-typed state: `value` stays "" while `badInput` is true. */
function stubBadInput(el: HTMLInputElement, read: () => boolean) {
  Object.defineProperty(el, "validity", {
    configurable: true,
    get: () => ({ badInput: read() }),
  });
}

describe("FeaturedItemForm — half-typed curated-until", () => {
  it("disables submit and shows an alert while the date is half-typed", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <FeaturedItemForm
        onSubmit={onSubmit}
        isPending={false}
        mutationErrorMessage={null}
        validationErrorMessage={null}
        resetSignal={0}
      />,
    );
    fireEvent.change(container.querySelector("#featured-item-id")!, {
      target: { value: "00000000-0000-4000-8000-000000000001" },
    });
    const submit = screen.getByTestId("featured-submit");
    expect(submit).not.toBeDisabled();

    const until = screen.getByTestId(
      "featured-curated-until",
    ) as HTMLInputElement;
    let bad = true;
    stubBadInput(until, () => bad);
    fireEvent.keyUp(until, { key: "1" });

    expect(submit).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(until).not.toHaveAttribute("aria-invalid");
    fireEvent.blur(until);

    expect(screen.getByRole("alert").textContent).toBe(
      "common.dateTimeIncomplete",
    );
    expect(until).toHaveAttribute("aria-invalid", "true");
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();

    bad = false;
    fireEvent.change(until, { target: { value: "2026-12-01T09:00" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByTestId("featured-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0].curatedUntil).toEqual(
      new Date("2026-12-01T09:00"),
    );
  });
});
