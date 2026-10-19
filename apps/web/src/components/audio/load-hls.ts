/**
 * The one place hls.js is imported. Dynamic, so the bundler splits it into its
 * own chunk and a page downloads it only when `attachAudioSource` meets an
 * HLS-only block on a browser without native HLS.
 *
 * Its own module so tests replace the loader rather than the package: vitest
 * 1.x let a concurrent second `import("hls.js")` (StrictMode runs effects
 * twice before the first import resolves) bypass `vi.mock("hls.js")` and load
 * the real package.
 */
export async function loadHls(): Promise<typeof import("hls.js").default> {
  const mod = await import("hls.js");
  return mod.default;
}
