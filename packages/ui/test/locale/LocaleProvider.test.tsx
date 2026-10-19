import { render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
  LocaleProvider,
  useFormatters,
  useTranslations,
  type Messages,
} from "../../src/locale/index.js";

const sampleMessages: Messages = {
  common: {
    greeting: "Hello {name}!",
    priceRange: "{min} – {max}",
  },
};

describe("LocaleProvider", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LocaleProvider locale="en" messages={sampleMessages}>
      {children}
    </LocaleProvider>
  );

  it("formats messages with string values", () => {
    const { result } = renderHook(() => useTranslations(), { wrapper });
    const message = result.current("common.greeting", { name: "Ada" });

    expect(message).toBe("Hello Ada!");
  });

  it("supports rich values when formatting", () => {
    const { result } = renderHook(() => useTranslations(), { wrapper });
    const node = result.current("common.priceRange", {
      min: <span data-testid="min">$10</span>,
      max: "$25",
    });

    const { getByTestId, getByText } = render(<>{node}</>);

    expect(getByTestId("min").textContent).toBe("$10");
    expect(getByText("$25")).toBeInTheDocument();
  });

  it("falls back to the key when a translation is missing", () => {
    const { result } = renderHook(() => useTranslations(), { wrapper });

    expect(result.current("missing.message")).toBe("missing.message");
  });

  it("provides locale-aware formatters", () => {
    const { result } = renderHook(() => useFormatters(), { wrapper });

    expect(result.current.currency(1999.5, "USD")).toBe(
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: "USD",
      }).format(1999.5),
    );

    expect(result.current.dateTime(new Date("2024-03-29T12:00:00Z"))).toBe(
      new Intl.DateTimeFormat("en").format(new Date("2024-03-29T12:00:00Z")),
    );
  });
});
