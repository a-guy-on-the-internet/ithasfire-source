/**
 * Test-only prop forwarder for `@th/ui` / Tamagui stand-ins.
 *
 * A mock that drops `aria-*`, `data-*`, `role`, `id` or `disabled` cannot
 * fail on a component that stops emitting them — the assertion passes
 * against nothing. Every stand-in that renders a DOM element should spread
 * `pickDomProps(rest)` so the mocks cannot drift from one another.
 */
export const pickDomProps = (rest: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (
      key.startsWith("data-") ||
      key.startsWith("aria-") ||
      key === "role" ||
      key === "id" ||
      key === "disabled"
    ) {
      out[key] = value;
    }
  }
  return out;
};
