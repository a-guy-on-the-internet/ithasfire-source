import type { MessageCatalog, MessageNode } from "./messages-schema";

const KEY_DELIMITER = ".";

export const resolveMessage = (
  catalog: MessageCatalog,
  key: string,
): MessageNode | undefined => {
  if (!key) return undefined;

  return key
    .split(KEY_DELIMITER)
    .reduce<MessageNode | undefined>((acc, segment) => {
      if (acc === undefined) return undefined;
      if (typeof acc === "string") return undefined;
      return acc[segment];
    }, catalog);
};

export const resolveMessageAsString = (
  catalog: MessageCatalog,
  key: string,
): string | undefined => {
  const message = resolveMessage(catalog, key);
  return typeof message === "string" ? message : undefined;
};

export const flattenCatalog = (
  catalog: MessageCatalog,
  prefix = "",
): Record<string, string> => {
  return Object.entries(catalog).reduce<Record<string, string>>(
    (acc, [segment, value]) => {
      const nextKey = prefix ? `${prefix}${KEY_DELIMITER}${segment}` : segment;

      if (typeof value === "string") {
        acc[nextKey] = value;
        return acc;
      }

      Object.assign(acc, flattenCatalog(value, nextKey));
      return acc;
    },
    {},
  );
};
