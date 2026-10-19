import type { ReactNode } from "react";

import { pickDomProps } from "./pick-dom-props";

/**
 * Test-only stand-in for the `@th/ui` Button, for tests that cannot boot a
 * TamaguiProvider. Hand-rolled copies of this have dropped `aria-*` and
 * mis-mapped `disabled`, so assertions against them read null (TRAPS.md).
 * This one forwards every DOM attribute `pickDomProps` keeps and maps
 * `onPress` to a click.
 *
 * vi.mock("@th/ui", async (importOriginal) => ({
 *   ...(await importOriginal<typeof import("@th/ui")>()),
 *   Button: ButtonStub,
 * }));
 */
export const ButtonStub = ({
  children,
  onPress,
  type,
  ...rest
}: {
  children?: ReactNode;
  onPress?: () => void;
  type?: "button" | "submit" | "reset";
} & Record<string, unknown>) => (
  <button type={type ?? "button"} onClick={onPress} {...pickDomProps(rest)}>
    {children}
  </button>
);
