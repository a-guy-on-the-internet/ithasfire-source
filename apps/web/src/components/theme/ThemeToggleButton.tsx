"use client";

import { Moon, SunMedium } from "lucide-react";
import { Button, useTranslations } from "@th/ui";
import { useAppTheme } from "@/components/theme/AppThemeProvider";

/**
 * Light/dark appearance toggle — a square ghost icon Button (v2 nav grammar,
 * same atom as Saves/Notifications). Shows the CURRENT mode's glyph (moon in
 * dark, sun in light); the aria-label offers the switch.
 *
 * Rendered in BOTH the public navbar (AppNavbar) and the app-shell navbars
 * (Admin / Platform / Seller `navbarTrailingSlot`) so the toggle is reachable
 * on every web surface — not just the consumer site.
 */
export const ThemeToggleButton = () => {
  const t = useTranslations();
  const { mode, toggle } = useAppTheme();
  const isDark = mode === "dark";
  const Icon = isDark ? Moon : SunMedium;
  return (
    <Button
      size="$4"
      variant="ghost"
      icon
      aria-label={
        (isDark
          ? t("common.switchToLight")
          : t("common.switchToDark")) as string
      }
      onPress={toggle}
      data-testid="navbar-theme-toggle"
    >
      <Icon size={18} strokeWidth={2.25} aria-hidden />
    </Button>
  );
};

ThemeToggleButton.displayName = "ThemeToggleButton";
