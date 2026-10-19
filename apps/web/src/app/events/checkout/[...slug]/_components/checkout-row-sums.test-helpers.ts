import { screen, within } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Read a rendered checkout surface's ROWS back as cents and check they add up
 * to the total that surface displays. Two surfaces handed the same total
 * always agree with each other; only their rows can show one of them is
 * wrong.
 */

/** "$56.85" / "−$5.50" → 5685 / 550 (sign dropped). */
export const money = (text: string | null | undefined) =>
  Math.round(Number((text ?? "").replace(/[^0-9.]/g, "")) * 100);

const oneValue = (testId: string) => {
  const el = screen.queryByTestId(testId);
  return el ? money(el.textContent) : 0;
};

const discountRowValues = (testIds: string[]) =>
  testIds
    .flatMap((id) => screen.queryAllByTestId(id))
    .map((row) => money(within(row).getByText(/−/).textContent));

/** The mobile tray's rows (open it first). */
export const trayRows = () => ({
  lines: screen
    .getAllByTestId("mobile-cta-line-value")
    .map((el) => money(el.textContent)),
  subtotal: oneValue("mobile-cta-subtotal-value"),
  platform: oneValue("mobile-cta-platform-fee-value"),
  processing: oneValue("mobile-cta-processing-fee-value"),
  tax: oneValue("mobile-cta-tax-value"),
  discounts: discountRowValues([
    "mobile-cta-member-discount-row",
    "mobile-cta-discount-row",
  ]),
  button: money(screen.getByTestId("mobile-cta-total-value").textContent),
});

/** Lines sum to the Subtotal; Subtotal + fees + tax − discounts = button. */
export const expectTraySumsToButton = (r: ReturnType<typeof trayRows>) => {
  const discount = r.discounts.reduce((a, b) => a + b, 0);
  expect(r.lines.reduce((a, b) => a + b, 0)).toBe(r.subtotal);
  expect(r.subtotal + r.platform + r.processing + r.tax - discount).toBe(
    r.button,
  );
};

/** The desktop summary's rows. */
export const summaryRows = () => ({
  lines: screen
    .getAllByTestId("order-summary-line-value")
    .map((el) => money(el.textContent)),
  subtotal: oneValue("order-summary-subtotal-value"),
  platform: oneValue("order-summary-platform-fee-value"),
  processing: oneValue("order-summary-processing-fee-value"),
  tax: oneValue("order-summary-tax-value"),
  discounts: discountRowValues([
    "order-summary-member-discount-row",
    "order-summary-discount-row",
    "order-summary-preorder-member-discount-row",
    "order-summary-preorder-discount-row",
  ]),
  credit: oneValue("order-summary-credit-value"),
  total: money(screen.getByTestId("order-summary-total-value").textContent),
});

/** Lines sum to the Subtotal; Subtotal + fees + tax − discounts − credit = total. */
export const expectSummarySumsToTotal = (r: ReturnType<typeof summaryRows>) => {
  const discount = r.discounts.reduce((a, b) => a + b, 0);
  expect(r.lines.reduce((a, b) => a + b, 0)).toBe(r.subtotal);
  expect(
    r.subtotal + r.platform + r.processing + r.tax - discount - r.credit,
  ).toBe(r.total);
};
