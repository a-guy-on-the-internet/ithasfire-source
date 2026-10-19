import type { Messages } from "@th/ui";

import type { AppLocale } from "../config";

const messagesLoaders: Record<AppLocale, () => Promise<{ default: Messages }>> =
  {
    en: () => import("./en"),
    es: () => import("./es"),
  };

export const loadMessages = async (locale: AppLocale): Promise<Messages> => {
  const loader = messagesLoaders[locale] ?? messagesLoaders.en;
  const messageModule = await loader();
  return messageModule.default;
};
