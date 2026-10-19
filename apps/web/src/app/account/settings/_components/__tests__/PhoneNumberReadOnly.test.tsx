import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "@/i18n/messages/en";

/**
 * PhoneNumberReadOnly — the number on file, shown while SMS is switched off.
 * The translator resolves against the real English catalog, so a missing key
 * fails here instead of rendering the raw key.
 */

const mocks = vi.hoisted(() => ({
  user: undefined as
    | { phoneNumber?: string | null; phoneNumberVerified?: boolean | null }
    | undefined,
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: mocks.user ? { user: mocks.user } : null,
      isPending: false,
    }),
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("lucide-react", () => ({ Phone: () => null, ShieldCheck: () => null }));

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        enMessages,
      ) ?? key,
}));

vi.mock("../settings-primitives", () => ({
  SectionCard: ({ children }: { children?: ReactNode }) => (
    <section data-testid="phone-read-only">{children}</section>
  ),
}));

import { PhoneNumberReadOnly } from "../PhoneNumberReadOnly";

describe("PhoneNumberReadOnly", () => {
  beforeEach(() => {
    mocks.user = undefined;
  });

  it("shows a verified number with the SMS-off caption and no controls", () => {
    mocks.user = { phoneNumber: "+15555550123", phoneNumberVerified: true };
    render(<PhoneNumberReadOnly />);

    expect(screen.getByText("PHONE NUMBER")).toBeInTheDocument();
    expect(screen.getByText("+15555550123")).toBeInTheDocument();
    expect(screen.getByText("VERIFIED")).toBeInTheDocument();
    expect(
      screen.getByText("Text messages aren’t available yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("marks an unverified number as unverified", () => {
    mocks.user = { phoneNumber: "+15555550123", phoneNumberVerified: false };
    render(<PhoneNumberReadOnly />);

    expect(screen.getByText("UNVERIFIED")).toBeInTheDocument();
    expect(screen.queryByText("VERIFIED")).not.toBeInTheDocument();
  });

  for (const [label, user] of [
    ["no number on file", { phoneNumber: null }],
    ["no session", undefined],
  ] as const) {
    it(`renders nothing (${label})`, () => {
      mocks.user = user;
      const { container } = render(<PhoneNumberReadOnly />);
      expect(container).toBeEmptyDOMElement();
    });
  }
});
