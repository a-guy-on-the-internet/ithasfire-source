"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import { DEFAULT_LOCALE } from "../constants";
import {
  createTranslator,
  type TranslationValues,
  type Translator,
  type TranslatorOptions,
} from "../create-translator";
import type { MessageCatalog } from "../messages-schema";

const LocaleContext = createContext<Translator | null>(null);

export type Messages = MessageCatalog;

export interface LocaleProviderProps extends TranslatorOptions {
  locale?: string;
  messages: MessageCatalog;
  children: ReactNode;
}

export const LocaleProvider = ({
  locale = DEFAULT_LOCALE,
  messages,
  onMissingMessage,
  children,
}: LocaleProviderProps) => {
  const translator = useMemo(
    () => createTranslator(locale, messages, { onMissingMessage }),
    [locale, messages, onMissingMessage],
  );

  return (
    <LocaleContext.Provider value={translator}>
      {children}
    </LocaleContext.Provider>
  );
};

LocaleProvider.displayName = "LocaleProvider";

const useLocaleContext = () => {
  const translator = useContext(LocaleContext);

  if (!translator) {
    throw new Error("LocaleProvider must wrap components using locale hooks");
  }

  return translator;
};

export const useTranslations = () => {
  const translator = useLocaleContext();

  return useCallback(
    (key: string, values?: TranslationValues) => translator.t(key, values),
    [translator],
  );
};

export interface FormatterBag {
  locale: string;
  number: Translator["formatNumber"];
  currency: Translator["formatCurrency"];
  dateTime: Translator["formatDate"];
  getRawMessage: Translator["getRawMessage"];
}

export const useFormatters = () => {
  const translator = useLocaleContext();

  return useMemo<FormatterBag>(
    () => ({
      locale: translator.locale,
      number: translator.formatNumber,
      currency: translator.formatCurrency,
      dateTime: translator.formatDate,
      getRawMessage: translator.getRawMessage,
    }),
    [translator],
  );
};

export const useLocale = () => useLocaleContext().locale;

export const useTranslator = () => useLocaleContext();

export const useMessages = () => useLocaleContext().messages;
