import type { ReactNode } from "react";

// Use import-then-export (direct binding) to avoid
// "Indirectly exported binding name … is not found" in Vite ESM dev server.
import {
  TranslationProvider,
  useTranslations,
  useFormatters,
  useLocale,
  useMessages,
  useTranslator,
} from "./translation-context";
export {
  TranslationProvider,
  useTranslations,
  useFormatters,
  useLocale,
  useMessages,
  useTranslator,
};

export type { TranslationProviderProps } from "./translation-context";

import { LocaleProvider } from "@th/locale";
export { LocaleProvider };

export type { Messages, LocaleProviderProps } from "@th/locale";

import {
  DEFAULT_LOCALE,
  createTranslator,
  resolveMessage,
  resolveMessageAsString,
  type TranslationValues,
  type Messages,
} from "@th/locale";

export type MissingMessageStrategy = "return-key" | "return-empty";

export type FormatMessageValues = Record<
  string,
  string | number | boolean | Date | null | undefined
>;

export type FormatMessageRichValues = Record<
  string,
  ReactNode | string | number | boolean | Date | null | undefined
>;

export interface MessageFormatterOptions {
  locale?: string;
  missingStrategy?: MissingMessageStrategy;
  onMissingMessage?: (key: string) => void;
}

export interface MessageFormatter {
  locale: string;
  getRawMessage: (key: string) => string | undefined;
  formatMessage: (key: string, values?: TranslationValues) => string;
}

export interface MessageResolver {
  getMessage: (key: string) => string | undefined;
  getMessageOrFallback: (key: string) => string;
}

const stringify = (value: unknown): string => {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(stringify).join("");
  return typeof value === "string" ? value : String(value);
};

export const formatMessageString = (
  template: string,
  values: TranslationValues = {},
  locale: string = DEFAULT_LOCALE,
): string => {
  const translator = createTranslator(locale, { __template__: template });
  return stringify(translator.t("__template__", values));
};

export const createMessageFormatter = (
  messages: Messages,
  {
    locale = DEFAULT_LOCALE,
    missingStrategy = "return-key",
    onMissingMessage,
  }: MessageFormatterOptions = {},
): MessageFormatter => {
  const translator = createTranslator(locale, messages, { onMissingMessage });

  return {
    locale: translator.locale,
    getRawMessage: translator.getRawMessage,
    formatMessage: (key: string, values: TranslationValues = {}) => {
      const raw = translator.getRawMessage(key);
      if (!raw) {
        return missingStrategy === "return-empty" ? "" : key;
      }
      return stringify(translator.t(key, values));
    },
  };
};

export const createMessageResolver = (messages: Messages): MessageResolver => {
  return {
    getMessage: (key: string) => resolveMessageAsString(messages, key),
    getMessageOrFallback: (key: string) =>
      resolveMessageAsString(messages, key) ?? key,
  };
};

export { resolveMessage };
