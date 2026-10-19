/**
 * The colour grammar an entity page theme may store (`colorPrimary`,
 * `colorBg`, `colorText`).
 *
 * The public page writes these values into inline CSS custom properties
 * (`--th-color-bg: <value>`), so a free string is CSS injection: `url(…)`
 * makes every visitor fetch from a third party, and `red;position:fixed;…`
 * lands in the style attribute as extra declarations (React does not escape
 * `;`). Only these shapes pass:
 *
 * - hex: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`;
 * - `rgb()` / `rgba()` / `hsl()` / `hsla()` whose arguments are digits, `.`,
 *   `%`, spaces, commas, `/` and `deg`;
 * - a bare colour keyword, 3 to 30 ASCII letters (`rebeccapurple`,
 *   `transparent`).
 *
 * Nothing else gets through: no `;`, `:`, quotes, `\`, braces, `<`, and no
 * parenthesis outside the four colour functions, so `url(` and `var(` cannot
 * be written.
 *
 * LEAF MODULE: no imports. The web app imports it on the read side to drop
 * colours stored before this check existed, and must not pull zod or a use
 * case into the client bundle to do it.
 */

export const THEME_COLOR_MAX_LENGTH = 50;

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_COLOR = /^(?:rgba?|hsla?)\((?=[^)]*\d)(?:[\d.% ,/]|deg)+\)$/i;
const NAMED_COLOR = /^[a-z]{3,30}$/i;

/** True when `value` is a colour in the grammar above, exactly (no trim). */
export function isSafeThemeColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > THEME_COLOR_MAX_LENGTH) return false;
  return (
    HEX_COLOR.test(value) ||
    FUNCTION_COLOR.test(value) ||
    NAMED_COLOR.test(value)
  );
}
