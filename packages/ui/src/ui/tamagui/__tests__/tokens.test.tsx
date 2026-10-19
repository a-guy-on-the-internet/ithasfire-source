import { render } from "@testing-library/react";

import {
  IthasFireProvider,
  defaultTheme,
  fonts,
  shorthands,
  tamaguiConfig,
  themes,
  tokens,
} from "../index";
import {
  getBadgeVariantTokens,
  getNotificationToneTokens,
  hexToRgba,
} from "../components/shared";

const colorKeys = [
  "brandPrimary",
  "brandSecondary",
  "brandSecondaryHover",
  "warmAccent",
  "neutral100",
  "neutral300",
  "neutral700",
  "neutral900",
  "accentSubtle",
  "accent",
  "accentHard",
  "accentSoft",
  "success",
  "warning",
  "danger",
  "info",
  "focus",
];

const unwrapToken = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "val" in (value as Record<string, unknown>)
    ? (value as { val: unknown }).val
    : value;

describe("Tamagui tokens", () => {
  it("exposes expected color tokens", () => {
    const exportedKeys = Object.keys(tokens.color);
    colorKeys.forEach((key) => {
      expect(exportedKeys).toContain(key);
    });

    expect(tokens.color.brandPrimary).toBe("#35589A");
    expect(tokens.color.brandSecondary).toBe("#FF5721");
    expect(tokens.color.brandSecondaryHover).toBe("#E84B19");
    expect(tokens.color.accent).toBe("#35589A");
    expect(tokens.color.accentSubtle).toBe("#E8EDF5");
    expect(tokens.color.accentHard).toBe("#2A4578");

    // Theme-level tokens resolve per-theme
    expect(themes.swiss.backgroundInverted).toBe("#181818");
    expect(themes.ember.backgroundInverted).toBe("#FFFFFF");
  });

  it("wires tokens into the Tamagui config", () => {
    expect(unwrapToken(tamaguiConfig.tokens.color.brandPrimary)).toBe(
      tokens.color.brandPrimary,
    );
    expect(unwrapToken(tamaguiConfig.tokens.radius.md)).toBe(tokens.radius.md);
  });

  it("provides shorthands for common layout props", () => {
    expect(shorthands.px).toBe("paddingHorizontal");
    expect(shorthands.py).toBe("paddingVertical");
  });

  it("defines typographic scales", () => {
    expect(fonts.heading.family).toBeTruthy();
    expect(fonts.body.size["3"]).toBeGreaterThan(0);
  });
});

describe("IthasFireProvider", () => {
  beforeEach(() => {
    document.body.className = "";
  });

  it("renders children with the default theme", () => {
    const { getByText, unmount } = render(
      <IthasFireProvider>
        <span>Theme child</span>
      </IthasFireProvider>,
    );
    expect(getByText("Theme child")).toBeInTheDocument();
    expect(document.body.classList.contains(`t_${defaultTheme}`)).toBe(true);
    unmount();
  });

  it("supports overriding theme name", () => {
    const { getByText, unmount } = render(
      <IthasFireProvider theme="ember">
        <span>Dark theme</span>
      </IthasFireProvider>,
    );
    expect(getByText("Dark theme")).toBeInTheDocument();
    expect(document.body.classList.contains(`t_${themes.ember.name}`)).toBe(
      true,
    );
    unmount();
  });

  it("switches the active theme when the prop changes", () => {
    const { rerender, unmount } = render(
      <IthasFireProvider>
        <span>Theme swap</span>
      </IthasFireProvider>,
    );

    expect(document.body.classList.contains(`t_${defaultTheme}`)).toBe(true);

    rerender(
      <IthasFireProvider theme="swiss">
        <span>Theme swap</span>
      </IthasFireProvider>,
    );

    expect(document.body.classList.contains(`t_${themes.swiss.name}`)).toBe(
      true,
    );
    expect(document.body.classList.contains(`t_${themes.ember.name}`)).toBe(
      false,
    );
    unmount();
  });

  it("can opt out of root theme class", () => {
    const { getByText, unmount } = render(
      <IthasFireProvider disableRootThemeClass>
        <span>No root class</span>
      </IthasFireProvider>,
    );

    expect(getByText("No root class")).toBeInTheDocument();
    expect(document.body.className).toBe("");
    unmount();
  });
});

describe("Intent token helpers", () => {
  it("maps badge variants to tone-specific surfaces", () => {
    const solidSuccess = getBadgeVariantTokens("success", "solid");
    expect(solidSuccess.backgroundColor).toBe("#22C55E");
    // Dark ink on the saturated success fill — white was 2.28:1 (WCAG fail).
    expect(solidSuccess.textColor).toBe("#181818");

    const softInfo = getBadgeVariantTokens("info");
    // Derive expectations from the palette so the test doesn't become brittle
    // when theme colors change.
    expect(softInfo.backgroundColor).toBe(hexToRgba(tokens.color.info, 0.12));
    expect(softInfo.iconColor).toBe(tokens.color.info);
  });

  it("exposes notification tone tokens", () => {
    const dangerTokens = getNotificationToneTokens("danger");
    // Derives from light-theme roles (Swiss minimalism light-first); the
    // resting border darkened to #8C8C8C to clear WCAG 1.4.11 (3:1) on white.
    expect(dangerTokens.frameBorder).toBe("#8C8C8C");
    expect(dangerTokens.textSecondary).toBe("rgba(24, 24, 24, 0.72)");
    expect(dangerTokens.accent).toBe("#EF4444");
    expect(dangerTokens.iconBorder).toBe("rgba(239, 68, 68, 0.4)");
  });
});
