import type { Preview } from "@storybook/react";
import React, { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import "@tamagui/core/reset.css";
import "./fonts.css";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, loadMessages } from "@th/locale";

import { IthasFireProvider, themes } from "../src/ui/tamagui";
import { TranslationProvider } from "../src/locale";

const backgroundValues = [
  { name: "surface (light)", value: themes.swiss.surface },
  { name: "muted (light)", value: themes.swiss.surfaceMuted },
  { name: "surface (dark)", value: themes.ember.surface },
  { name: "muted (dark)", value: themes.ember.surfaceMuted },
];

const localeToolbarItems = SUPPORTED_LOCALES.map((value) => ({
  value,
  title: value,
  right: value.toUpperCase(),
})) satisfies Array<{ value: string; title: string; right: string }>;

type StoryLocaleProviderProps = {
  children: ReactNode;
  locale: string;
};

type LoadedLocaleState = {
  locale: string;
  messages: Awaited<ReturnType<typeof loadMessages>> | null;
};

const StoryLocaleProvider = ({
  children,
  locale,
}: StoryLocaleProviderProps) => {
  const [state, setState] = useState<LoadedLocaleState>(() => ({
    locale,
    messages: null,
  }));

  useEffect(() => {
    let canceled = false;

    async function hydrateLocale(nextLocale: string) {
      try {
        const messages = await loadMessages(nextLocale);
        if (!canceled) {
          setState({ locale: nextLocale, messages });
        }
      } catch (error) {
        if (!canceled) {
          // eslint-disable-next-line no-console
          console.error("Failed to load locale messages", error);
          setState({ locale: DEFAULT_LOCALE, messages: null });
        }
      }
    }

    hydrateLocale(locale);

    return () => {
      canceled = true;
    };
  }, [locale]);

  const translationProps = useMemo(
    () => ({
      locale: state.messages ? state.locale : DEFAULT_LOCALE,
      messages: state.messages ?? undefined,
    }),
    [state],
  );

  return (
    <TranslationProvider {...translationProps}>{children}</TranslationProvider>
  );
};

const preview: Preview = {
  parameters: {
    layout: "centered",
    actions: { argTypesRegex: "^on[A-Z].*" },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
    backgrounds: {
      default: "surface (light)",
      values: backgroundValues,
    },
  },
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Global theme for Tamagui components",
      defaultValue: "light",
      toolbar: {
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
    locale: {
      name: "Locale",
      description: "Active translation locale",
      defaultValue: DEFAULT_LOCALE,
      toolbar: {
        icon: "globe",
        items: localeToolbarItems,
      },
    },
  },
  decorators: [
    (Story, context) => (
      <IthasFireProvider theme={context.globals.theme as "light" | "dark"}>
        <StoryLocaleProvider
          locale={(context.globals.locale as string) ?? DEFAULT_LOCALE}
        >
          <Story />
        </StoryLocaleProvider>
      </IthasFireProvider>
    ),
  ],
};

export default preview;
