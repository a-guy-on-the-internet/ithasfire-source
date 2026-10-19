/**
 * `NativeThemeProvider` persists the theme through SecureStore. In jsdom there
 * is no keychain and the tests do not care which theme resolves — they pin one
 * via `enabledThemes`, which short-circuits hydration entirely. This stub just
 * keeps the import resolvable.
 */
export const AFTER_FIRST_UNLOCK = "AFTER_FIRST_UNLOCK";

export async function getItemAsync(): Promise<string | null> {
  return null;
}

export async function setItemAsync(): Promise<void> {
  // no-op
}

export async function deleteItemAsync(): Promise<void> {
  // no-op
}
