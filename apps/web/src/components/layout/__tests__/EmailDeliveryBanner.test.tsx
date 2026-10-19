import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useSessionMock = vi.fn();

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => useSessionMock(),
  },
}));

vi.mock("tamagui", () => ({
  XStack: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  YStack: ({
    children,
    role,
    "aria-live": ariaLive,
  }: {
    children?: React.ReactNode;
    role?: string;
    "aria-live"?: "off" | "assertive" | "polite";
  }) => (
    <div role={role} aria-live={ariaLive}>
      {children}
    </div>
  ),
}));

vi.mock("@th/ui", () => ({
  Button: ({ children }: { children?: React.ReactNode }) => (
    <button>{children}</button>
  ),
  NextLinkAnchor: ({
    children,
    href,
  }: {
    children?: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
  Text: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
  useTranslations: () =>
    (key: string, params?: Record<string, string>) => {
      const messages: Record<string, string> = {
        "account.emailDeliveryUnknownEmail": "your email address",
        "account.emailDeliveryBouncedTitle": "We cannot email you right now",
        "account.emailDeliveryBouncedBody":
          "Messages to {email} are bouncing.",
        "account.emailDeliveryComplaintTitle": "Email delivery is paused",
        "account.emailDeliveryComplaintBody":
          "Email to {email} is paused after a spam complaint.",
        "account.emailDeliveryUpdateCta": "Update email",
      };
      return (messages[key] ?? key).replace(
        "{email}",
        params?.email ?? "",
      );
    },
}));

import { EmailDeliveryBanner } from "../EmailDeliveryBanner";

describe("EmailDeliveryBanner", () => {
  beforeEach(() => {
    useSessionMock.mockReset();
  });

  it("does not render for healthy sessions", () => {
    useSessionMock.mockReturnValue({
      data: { user: { email: "user@example.com", emailDeliveryStatus: null } },
    });

    const { container } = render(<EmailDeliveryBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders a bounced email remediation banner", () => {
    useSessionMock.mockReturnValue({
      data: {
        user: {
          email: "user@example.com",
          emailDeliveryStatus: "BOUNCED",
        },
      },
    });

    render(<EmailDeliveryBanner />);

    expect(
      screen.getByText("We cannot email you right now"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Messages to user@example.com are bouncing."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Update email" })).toHaveAttribute(
      "href",
      "/account/settings/email",
    );
  });

  it("renders a complaint email remediation banner", () => {
    useSessionMock.mockReturnValue({
      data: {
        user: {
          email: "complaint@example.com",
          emailDeliveryStatus: "COMPLAINED",
        },
      },
    });

    render(<EmailDeliveryBanner />);

    expect(screen.getByText("Email delivery is paused")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Email to complaint@example.com is paused after a spam complaint.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Update email" })).toHaveAttribute(
      "href",
      "/account/settings/email",
    );
  });
});