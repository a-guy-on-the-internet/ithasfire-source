/**
 * Cross-origin-safe audio download.
 *
 * Audio is served from R2/a CDN on a DIFFERENT origin than the web app, and
 * the HTML5 `download` attribute is IGNORED for cross-origin resources — the
 * browser navigates/opens the file instead of saving it. To force a save we
 * fetch the bytes ourselves, wrap them in a same-origin object URL, and click
 * a synthetic anchor.
 *
 * If the fetch fails (CORS not allowed, network error) we fall back to opening
 * the URL in a new tab so the control never dead-ends.
 *
 * Pure DOM + fetch — no React — so both the React player and the vanilla
 * hydrator can share it.
 */

/** Strip a trailing `.ext`, sanitize, and clamp for use as a filename base. */
function sanitizeBase(raw: string): string {
  return (
    raw
      .trim()
      .replace(/\.[a-z0-9]{1,5}$/i, "") // drop an existing extension
      .replace(/[^\w\-. ]+/g, "_") // keep word chars, dash, dot, space
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_.]+|[_.]+$/g, "")
      .slice(0, 120) || "audio"
  );
}

/** Last path segment of a URL, ignoring query/hash. Empty string if unparseable. */
function basenameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url, "http://_");
    const seg = pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

/**
 * Only `http:`/`https:` are safe download targets. Anything else
 * (`javascript:`, `data:`, `blob:`, `file:`, relative, unparseable) is
 * rejected so a hostile stored `sourceUrl` can never reach `fetch()` — which
 * force-saves attacker bytes for `data:` — nor the `window.open` fallback,
 * which is a navigable sink that executes `javascript:`.
 */
function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** File extension from a URL path (no leading dot). Defaults to `mp3`. */
function extFromUrl(url: string): string {
  const base = basenameFromUrl(url);
  const match = base.match(/\.([a-z0-9]{1,5})$/i);
  return match ? match[1].toLowerCase() : "mp3";
}

/**
 * Derive a friendly download filename from the embed title, falling back to
 * the URL basename, always with a sensible audio extension.
 */
export function deriveAudioFilename(url: string, title?: string | null): string {
  const ext = extFromUrl(url);
  const source = title?.trim() || basenameFromUrl(url) || "audio";
  return `${sanitizeBase(source)}.${ext}`;
}

/**
 * Download the direct audio file at `url`, saving it as a friendly filename.
 * Never throws; on any failure it opens the file in a new tab instead.
 */
export async function downloadAudioFile(
  url: string,
  title?: string | null,
): Promise<void> {
  // Scheme gate FIRST — covers both the fetch path and the window.open
  // fallback. A hostile stored `sourceUrl` (`javascript:`/`data:`) must never
  // reach either sink. No-op on rejection.
  if (!isHttpUrl(url)) return;

  const filename = deriveAudioFilename(url, title);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after a tick so the browser has grabbed the bytes.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  } catch {
    // CORS / network failure — degrade to opening the file so the button
    // never silently dead-ends.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
