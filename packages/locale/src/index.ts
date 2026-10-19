export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  type SupportedLocale,
} from "./constants";

export {
  messageDictionarySchema,
  type MessageCatalog,
  type MessageDictionary,
  type MessageLeaf,
  type MessageNode,
} from "./messages-schema";

export { loadMessages, preloadAllMessages } from "./load-messages";

export {
  createTranslator,
  type Translator,
  type TranslatorOptions,
  type TranslationValues,
  type TranslationPrimitive,
  type RichTranslationValue,
} from "./create-translator";

export {
  resolveMessage,
  resolveMessageAsString,
  flattenCatalog,
} from "./message-resolver";

export { icuArgumentNames } from "./icu-arguments";

export {
  formatEventDate,
  formatEventTimeRange,
  formatEventDateShort,
  type FormatEventDateOptions,
  type FormatEventTimeRangeOptions,
  type FormatEventDateShortOptions,
} from "./format-event-date";

export {
  LocaleProvider,
  useTranslations,
  useFormatters,
  useLocale,
  useMessages,
  useTranslator,
  type LocaleProviderProps,
  type Messages,
  type FormatterBag,
} from "./react/locale-context";
