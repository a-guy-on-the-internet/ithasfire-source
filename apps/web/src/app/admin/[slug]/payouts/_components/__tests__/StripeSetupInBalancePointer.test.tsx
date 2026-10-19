import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AdminPageSectionsProvider,
  useAdminPageSectionsActions,
} from "../../../_components/admin-page-sections";
import { StripeSetupInBalancePointer } from "../PayoutsSections";

vi.mock("tamagui", () => ({
  YStack: ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>,
}));

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations: () => (key: string) => key,
}));

/** Stands in for the Payouts page: owns the jump handler for its route. */
function RegisteredPage({
  onJump,
  children,
}: {
  onJump: (sectionId: string) => boolean;
  children: ReactNode;
}) {
  const actions = useAdminPageSectionsActions();
  useEffect(() => actions?.register("payouts", onJump), [actions, onJump]);
  return <>{children}</>;
}

function click(link: HTMLElement) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(link, event);
  return event;
}

describe("StripeSetupInBalancePointer", () => {
  it("routes the click through the page's jump handler and keeps the browser out of it", () => {
    const onJump = vi.fn(() => true);
    render(
      <AdminPageSectionsProvider>
        <RegisteredPage onJump={onJump}>
          <StripeSetupInBalancePointer />
        </RegisteredPage>
      </AdminPageSectionsProvider>,
    );
    const event = click(screen.getByTestId("stripe-account-setup-pointer-link"));
    expect(onJump).toHaveBeenCalledWith("balance");
    expect(event.defaultPrevented).toBe(true);
  });

  it("with no provider it is a plain #balance link: the default is NOT prevented", () => {
    render(<StripeSetupInBalancePointer />);
    const link = screen.getByTestId("stripe-account-setup-pointer-link");
    expect(link.getAttribute("href")).toBe("#balance");
    expect(click(link).defaultPrevented).toBe(false);
  });

  it("a declined jump (no section yet) falls back to the browser too", () => {
    const onJump = vi.fn(() => false);
    render(
      <AdminPageSectionsProvider>
        <RegisteredPage onJump={onJump}>
          <StripeSetupInBalancePointer />
        </RegisteredPage>
      </AdminPageSectionsProvider>,
    );
    const event = click(screen.getByTestId("stripe-account-setup-pointer-link"));
    expect(onJump).toHaveBeenCalledWith("balance");
    expect(event.defaultPrevented).toBe(false);
  });
});
