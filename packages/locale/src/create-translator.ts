import { IntlMessageFormat } from "intl-messageformat";

import { DEFAULT_LOCALE } from "./constants";
import { resolveMessageAsString } from "./message-resolver";
import type { MessageCatalog } from "./messages-schema";

export type TranslationPrimitive =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date;

export type RichTranslationValue =
  | TranslationPrimitive
  | ((chunks: string | string[]) => unknown)
  | object;

export type TranslationValues = Record<string, RichTranslationValue>;

export interface TranslatorOptions {
  onMissingMessage?: (key: string) => void;
}

export interface Translator {
  locale: string;
  messages: MessageCatalog;
  t: (key: string, values?: TranslationValues) => string;
  formatDate: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCurrency: (
    cents: number | bigint,
    currency: string,
    options?: Intl.NumberFormatOptions,
  ) => string;
  getRawMessage: (key: string) => string | undefined;
}

const normalizeDate = (value: Date | number | string): Date => {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return new Date(value);
};

export const createTranslator = (
  locale: string,
  messages: MessageCatalog,
  options: TranslatorOptions = {},
): Translator => {
  const normalizedLocale = locale || DEFAULT_LOCALE;

  const getRawMessage = (key: string) => resolveMessageAsString(messages, key);

  const formatDate = (
    value: Date | number | string,
    formatOptions?: Intl.DateTimeFormatOptions,
  ) =>
    new Intl.DateTimeFormat(normalizedLocale, formatOptions).format(
      normalizeDate(value),
    );

  const formatNumber = (
    value: number,
    formatOptions?: Intl.NumberFormatOptions,
  ) => new Intl.NumberFormat(normalizedLocale, formatOptions).format(value);

  const formatCurrency = (
    amount: number | bigint,
    currency: string,
    formatOptions: Intl.NumberFormatOptions = {},
  ) => {
    const numericValue = typeof amount === "bigint" ? Number(amount) : amount;
    return new Intl.NumberFormat(normalizedLocale, {
      style: "currency",
      currency,
      ...formatOptions,
    }).format(numericValue);
  };

  const t = (key: string, values: TranslationValues = {}) => {
    const rawMessage = getRawMessage(key);

    if (!rawMessage) {
      options.onMissingMessage?.(key);
      return key;
    }

    const formatter = new IntlMessageFormat(rawMessage, normalizedLocale);
    const formatted = formatter.format(values);

    if (Array.isArray(formatted)) {
      return formatted.length === 1
        ? String(formatted[0])
        : formatted.map(String).join("");
    }

    return String(formatted);
  };

  return {
    locale: normalizedLocale,
    messages,
    t,
    formatDate,
    formatNumber,
    formatCurrency,
    getRawMessage,
  };
};
