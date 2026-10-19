/**
 * Copy text that only becomes available asynchronously (e.g. after a network
 * round-trip) WITHOUT losing the user-activation window.
 *
 * Safari/WebKit consumes the transient user activation as soon as the click
 * handler awaits, so `await mutateAsync(); await clipboard.writeText(url)`
 * rejects with a NotAllowedError DOMException. The fix is the
 * ClipboardItem-with-promise pattern: hand `navigator.clipboard.write` a
 * ClipboardItem whose payload is a *promise* built synchronously inside the
 * gesture — Safari authorizes the write under the original activation and
 * resolves the payload afterwards.
 *
 * Engines without ClipboardItem promise payloads (Firefox <127) fall back to
 * `writeText`; Chrome's activation window survives fast awaits either way.
 *
 * IMPORTANT: call this synchronously inside the event handler — do not await
 * anything before building `textPromise` or calling this function.
 */
export async function copyTextFromPromise(
  textPromise: Promise<string>,
): Promise<void> {
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  ) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": textPromise.then(
          (text) => new Blob([text], { type: "text/plain" }),
        ),
      }),
    ]);
    return;
  }
  const text = await textPromise;
  await navigator.clipboard.writeText(text);
}

/**
 * True when a clipboard write was refused by the user agent (Safari's
 * "request is not allowed…" NotAllowedError). Use to show a clearer
 * "couldn't copy" message instead of the raw DOMException text.
 */
export const isClipboardBlockedError = (err: unknown): boolean =>
  typeof DOMException !== "undefined" &&
  err instanceof DOMException &&
  err.name === "NotAllowedError";
