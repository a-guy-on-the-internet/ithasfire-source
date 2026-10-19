import type { LucideIcon, LucideProps } from "lucide-react";
import { AlertTriangle, Check, Info, Loader2 } from "lucide-react";

export type IconFixtureName = "check" | "info" | "alert" | "spinner";

const iconRegistry: Record<IconFixtureName, LucideIcon> = {
  check: Check,
  info: Info,
  alert: AlertTriangle,
  spinner: Loader2,
};

const defaultIconProps: LucideProps = {
  size: 16,
  strokeWidth: 2,
  "aria-hidden": "true",
};

export const createLucideIconFixture = (
  name: IconFixtureName = "check",
  props?: Partial<LucideProps>,
) => {
  const Icon = iconRegistry[name];
  return (
    <Icon data-testid={`lucide-${name}`} {...defaultIconProps} {...props} />
  );
};

export const lucideIcons = {
  check: createLucideIconFixture("check"),
  info: createLucideIconFixture("info"),
  alert: createLucideIconFixture("alert"),
  spinner: createLucideIconFixture("spinner"),
};
