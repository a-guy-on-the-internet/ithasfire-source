"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import {
  DEFAULT_LOCALE,
  createTranslator,
  messageDictionarySchema,
  type MessageCatalog,
  type TranslationValues,
  type Translator,
  type TranslatorOptions,
} from "@th/locale";
import fallbackCatalog from "@th/locale/messages/en.json" with { type: "json" };

type TranslatorContextValue = Translator;

type ResolvedFormatterOptions = TranslatorOptions | undefined;

type TranslatorDependencies = readonly [
  string,
  MessageCatalog | undefined,
  ResolvedFormatterOptions,
];

const fallbackMessages = messageDictionarySchema.parse(fallbackCatalog);
const fallbackTranslator = createTranslator(DEFAULT_LOCALE, fallbackMessages);

const TranslationContext =
  createContext<TranslatorContextValue>(fallbackTranslator);
TranslationContext.displayName = "UiTranslationContext";

export interface TranslationProviderProps {
  children: ReactNode;
  formatterOptions?: TranslatorOptions;
  locale?: string;
  messages?: MessageCatalog;
}

const createTranslatorMemoKey = (
  locale: string,
  messages: MessageCatalog | undefined,
  formatterOptions: ResolvedFormatterOptions,
): TranslatorDependencies => [locale, messages, formatterOptions];

const createTranslatorForDependencies = (
  locale: string,
  messages: MessageCatalog | undefined,
  formatterOptions: ResolvedFormatterOptions,
) => {
  const resolvedLocale = locale || DEFAULT_LOCALE;
  const resolvedMessages = messages ?? fallbackMessages;

  if (
    resolvedLocale === fallbackTranslator.locale &&
    resolvedMessages === fallbackMessages &&
    (!formatterOptions || Object.keys(formatterOptions).length === 0)
  ) {
    return fallbackTranslator;
  }

  return createTranslator(resolvedLocale, resolvedMessages, formatterOptions);
};

export const TranslationProvider = ({
  children,
  formatterOptions,
  locale = DEFAULT_LOCALE,
  messages,
}: TranslationProviderProps) => {
  const dependencies = useMemo<TranslatorDependencies>(
    () => createTranslatorMemoKey(locale, messages, formatterOptions),
    [locale, messages, formatterOptions],
  );

  const translator = useMemo(
    () => createTranslatorForDependencies(...dependencies),
    dependencies,
  );

  return (
    <TranslationContext.Provider value={translator}>
      {children}
    </TranslationContext.Provider>
  );
};

export const useTranslator = () => useContext(TranslationContext);

export const useTranslations = () => {
  const translator = useTranslator();

  return useCallback(
    (key: string, values?: TranslationValues) => translator.t(key, values),
    [translator],
  );
};

export const useFormatters = () => {
  const translator = useTranslator();

  return useMemo(
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

export const useLocale = () => useTranslator().locale;

export const useMessages = () => useTranslator().messages;
