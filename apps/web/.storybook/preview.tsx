import type { Decorator, Preview } from "@storybook/react";
import type { IthasFireThemeName } from "@th/ui";

import React, { createElement, type ComponentType } from "react";

import { NotificationProvider, tamaguiConfigStorybook } from "@th/ui";
import { Theme, TamaguiProvider } from "tamagui";
import "../src/app/globals.css";
import "./fonts.css";

const themeOptions = ["swiss", "ember", "stub"] as const;

const defaultTheme: IthasFireThemeName = "ember";

const StorybookProviders = (({
  children,
  theme,
}: {
  children: React.ReactNode;
  theme: IthasFireThemeName;
}) => {
  return (
    <TamaguiProvider config={tamaguiConfigStorybook} defaultTheme={theme}>
      <Theme name={theme}>
        <NotificationProvider>{children}</NotificationProvider>
      </Theme>
    </TamaguiProvider>
  );
}) as unknown as ComponentType<{
  children: React.ReactNode;
  theme: IthasFireThemeName;
  key?: string;
}>;

const withAppProviders: Decorator = (Story, context) => {
  const selectedTheme =
    (context.globals.theme as IthasFireThemeName) ?? defaultTheme;
  return createElement(
    StorybookProviders,
    { key: selectedTheme, theme: selectedTheme },
    Story(context),
  );
};

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: "^on[A-Z].*" },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
      expanded: true,
    },
    layout: "fullscreen",
    options: {
      storySort: {
        order: ["Introduction", "Foundations", "Components"],
      },
    },
  },
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Switch between Ithas Fire themes",
      defaultValue: defaultTheme,
      toolbar: {
        icon: "mirror",
        items: themeOptions.map((value) => ({
          value,
          title: `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`,
        })),
        dynamicTitle: true,
      },
    },
  },
  decorators: [withAppProviders],
};

export default preview;
