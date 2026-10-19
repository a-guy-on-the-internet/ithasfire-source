import { renderWithProvider } from "../../../../../test/utils";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CheckoutPanel } from "../events/CheckoutPanel";
import { DataTable } from "../data/DataTable";
import { TranslationProvider } from "../../../../locale";
import { messageDictionarySchema } from "@th/locale";
import esCatalog from "@th/locale/messages/es.json" with { type: "json" };

describe("Localized tickets components", () => {
  const messages = messageDictionarySchema.parse(esCatalog);

  it("renders CheckoutPanel defaults using the provided locale", () => {
    renderWithProvider(
      <TranslationProvider locale="es" messages={messages}>
        <CheckoutPanel
          items={[{ label: "Subtotal", value: "$25.00" }]}
          totalValue="$30.00"
        />
      </TranslationProvider>,
    );

    expect(screen.getByText("Revisar pedido")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Confirmar compra" }),
    ).toBeInTheDocument();
  });

  it("renders DataTable default empty state", () => {
    renderWithProvider(<DataTable columns={[]} rows={[]} />);

    expect(screen.getByText("No items yet.")).toBeVisible();
  });
});
