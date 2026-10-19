"use client";

/**
 * Persisted pointer to the signed-in user's active support thread.
 *
 * Why localStorage: the frozen backend contract has no "get my active thread"
 * query — `support.getMessages` requires a `threadId`, and only
 * `support.sendMessage` returns the thread. So once the user sends their first
 * message we remember the returned thread id and use it as the poll target on
 * subsequent opens (including across reloads), driving the unread badge.
 *
 * The key is namespaced per human id so a shared device doesn't leak one
 * person's thread pointer to the next sign-in.
 */

const KEY_PREFIX = "th-support-thread:";

function keyFor(humanId: string): string {
  return `${KEY_PREFIX}${humanId}`;
}

export function getStoredThreadId(humanId: string | null | undefined): string | null {
  if (!humanId || typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(keyFor(humanId));
  } catch {
    return null;
  }
}

export function setStoredThreadId(
  humanId: string | null | undefined,
  threadId: string,
): void {
  if (!humanId || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(keyFor(humanId), threadId);
  } catch {
    // Quota / privacy mode — non-fatal; polling just won't persist across reloads.
  }
}

export function clearStoredThreadId(humanId: string | null | undefined): void {
  if (!humanId || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(keyFor(humanId));
  } catch {
    // ignore
  }
}
