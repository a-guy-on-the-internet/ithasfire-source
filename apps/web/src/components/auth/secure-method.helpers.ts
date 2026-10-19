/**
 * Keyboard grammar for the "Secure your account" method picker.
 *
 * Pure and DOM-free so the wrapping/Home/End rules can be unit-tested without
 * a renderer, in the same shape as `payout-schedule-nav.helpers.ts`: the
 * component owns `role`, `aria-*`, the roving tabindex and the focus move;
 * this module owns only "which option does this key land on".
 *
 * Returning `null` for an unhandled key is load-bearing. The component must
 * never `preventDefault` a key it did not act on — Tab especially — or the
 * group becomes a keyboard trap.
 */

export const SECURE_METHOD_ORDER = ["passkey", "totp", "email"] as const;

export type SecureMethod = (typeof SECURE_METHOD_ORDER)[number];

/** DOM id for a method's radio, so focus can follow selection. */
export const secureMethodDomId = (method: SecureMethod): string =>
  `auth-2fa-method-${method}`;

/**
 * The option an arrow / Home / End key lands on, or `null` when the key is
 * not one this group handles.
 *
 * A radio group is circular and vertical: Up/Down are primary, Left/Right
 * accepted as equivalents, and the list wraps at both ends. With nothing
 * selected, forward lands on the first option and backward on the last —
 * branched explicitly rather than modelled as index -1, which the wrap
 * arithmetic would send to the second-to-last.
 */
export function nextSecureMethodForKey(
  current: SecureMethod | undefined,
  key: string,
  order: readonly SecureMethod[] = SECURE_METHOD_ORDER,
): SecureMethod | null {
  if (order.length === 0) return null;

  const forward = key === "ArrowDown" || key === "ArrowRight";
  const backward = key === "ArrowUp" || key === "ArrowLeft";

  if (key === "Home") return order[0] ?? null;
  if (key === "End") return order[order.length - 1] ?? null;
  if (!forward && !backward) return null;

  const idx = current === undefined ? -1 : order.indexOf(current);
  if (idx === -1) {
    return forward ? (order[0] ?? null) : (order[order.length - 1] ?? null);
  }

  const next = forward
    ? (idx + 1) % order.length
    : (idx - 1 + order.length) % order.length;
  return order[next] ?? null;
}
