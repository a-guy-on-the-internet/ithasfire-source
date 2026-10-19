import React from "react";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";
import esPackage from "@th/locale/messages/es.json";

import enApp from "@/i18n/messages/en";
import esApp from "@/i18n/messages/es";
import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * Each context names what the page withholds. The copy is the shipped
 * catalog (en + es), so a context pointing at a missing key fails here
 * instead of rendering the raw key.
 */

vi.mock("@/trpc", () => ({
  trpc: { useUtils: () => ({ invalidate: vi.fn() }) },
}));

vi.mock("../useEmailVerificationPrompt", () => ({
  useEmailVerificationPrompt: () => ({
    email: "ana@example.com",
    isSending: false,
    canSend: true,
    codeIsFresh: false,
    openVerify: vi.fn(),
    verifyModal: null,
  }),
}));

vi.mock("tamagui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tamagui")>();
  const Stack = React.forwardRef<HTMLDivElement, Record<string, unknown>>(
    ({ children, ...rest }, ref) => (
      <div ref={ref} {...pickDomProps(rest)}>
        {children as ReactNode}
      </div>
    ),
  );
  Stack.displayName = "Stack";
  return { ...actual, Stack, XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  const { ButtonStub } = await import("@/test-support/th-ui-button-stub");
  const Text = ({
    children,
    tag,
    ...rest
  }: { children?: ReactNode; tag?: string } & Record<string, unknown>) =>
    React.createElement(tag ?? "span", pickDomProps(rest), children);
  return { ...actual, Text, Spinner: () => null, Button: ButtonStub };
});

import {
  EmailVerificationRequired,
  type EmailVerificationRequiredContext,
} from "../EmailVerificationRequired";

const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] =
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
        ? mergeCatalogs(existing as Messages, value as Messages)
        : value;
  }
  return result as Messages;
};

const catalogs = {
  en: mergeCatalogs(enPackage as unknown as Messages, enApp),
  es: mergeCatalogs(esPackage as unknown as Messages, esApp),
};

const renderGate = (
  context: EmailVerificationRequiredContext,
  locale: "en" | "es" = "en",
) =>
  render(
    <TranslationProvider locale={locale} messages={catalogs[locale]}>
      <EmailVerificationRequired context={context} headingTag="h1" />
    </TranslationProvider>,
  );

const CONTEXTS: EmailVerificationRequiredContext[] = [
  "tickets",
  "order",
  "printTickets",
  "resale",
  "credits",
  "review",
  "coordinator",
  "generic",
];

describe("EmailVerificationRequired", () => {
  it.each(CONTEXTS.flatMap((c) => [[c, "en"], [c, "es"]] as const))(
    "%s (%s) renders catalog copy, never a raw key",
    (context, locale) => {
      renderGate(context, locale);
      const region = screen.getByRole("region");
      expect(region.textContent).not.toMatch(/emailGate\./);
      expect(region.textContent).toContain("ana@example.com");
    },
  );

  it("the print sheet asks for the tickets, not the order", () => {
    renderGate("printTickets");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Verify your email to print your tickets",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "They are in the inbox for ana@example.com and still work at the door.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/this order/)).toBeNull();
  });

  it("the print sheet copy in Spanish", () => {
    renderGate("printTickets", "es");
    expect(
      screen.getByRole("heading", {
        name: "Verifica tu correo para imprimir tus entradas",
      }),
    ).toBeInTheDocument();
  });

  it("names the region by its heading", () => {
    renderGate("printTickets");
    expect(
      screen.getByRole("region", {
        name: "Verify your email to print your tickets",
      }),
    ).toBeInTheDocument();
  });
});
