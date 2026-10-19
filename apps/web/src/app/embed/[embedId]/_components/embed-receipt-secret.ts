// The receipt secret of a paid embed order: the second factor the server
// wants before `embeds.confirmGuestPayment` hands over ticket codes
// (packages/core/src/use-cases/embeds/_shared/guest-client-secret.ts).
//
// Why it exists: the client secret alone confirms an order, but a redirect
// (3-D Secure or bank authentication; Cash App Pay and Amazon Pay too until
// the owner turned them off in Stripe on 2026-10-13) brings the buyer back
// on a URL carrying it, and that URL reaches request logs and browser
// history. A
// ticket code IS door admission, so codes show only in the tab that started
// the payment (owner ruling 2026-10-12). That tab holds the receipt secret
// here; any other tab, or anyone holding a logged URL, asks without it and
// is told "confirmed" with no codes (the email carries them).
//
// Where it lives: in this module's memory, and in sessionStorage so a
// same-tab redirect return (a full reload of the iframe's page) can read it
// back. NEVER localStorage, a URL, a log line, a trace or a message to the
// host page. Every storage call is guarded: a sandboxed or third-party
// iframe can throw on any of them, and then only the in-frame path keeps it
// (from memory), so a redirect return in that frame shows no codes.
//
// sessionStorage is per tab, and in a third-party iframe it is partitioned
// by the top-level site as well, so a fresh tab, another browser or a
// logged return URL never finds it. That is the intended answer, not a gap.
// A tab the payment page opens from this frame (Cash App's test page did,
// before Cash App was turned off on 2026-10-13) is a new tab too. Measured in Chrome 2026-10-13: with a cross-site host
// (shop.localhost framing localhost) it found no secret and showed no codes;
// with a SAME-site host (localhost ports) it started with a copy of the
// frame's sessionStorage and showed them. Either is the buyer's own browser.

/** The prefix of every entry ({@link embedReceiptSecretKey}). */
const RECEIPT_SECRET_PREFIX = "hf:embed:receipt:";

/**
 * How long an entry is kept, counted from when it was written (the create
 * answer). The same length as the server's `EMBED_GUEST_TICKET_WINDOW_MS`,
 * which counts from when the tickets were ISSUED (the payment's finalize,
 * later than the create). So an entry can expire a little before the
 * server's window closes: a buyer who pays near the end of a long hold and
 * asks again close to two hours after the create gets no codes, and the
 * email carries them.
 */
export const EMBED_RECEIPT_SECRET_MS = 2 * 60 * 60 * 1000;

/** The shape the server accepts (`guestReceiptSecretSchema`). */
const RECEIPT_SECRET_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;
/** A PaymentIntent id, as the client secret's first part carries it. */
const PAYMENT_INTENT_ID_SHAPE = /^pi_[A-Za-z0-9_]+$/;

type HeldReceiptSecret = { secret: string; at: number };

/** In-memory copy, for a frame whose storage throws. Keyed like storage. */
const inMemory = new Map<string, HeldReceiptSecret>();

/**
 * The PaymentIntent id inside a client secret (`pi_xxx_secret_yyy`), or
 * null. The storage key is built from this, never from the secret.
 */
function paymentIntentIdOf(clientSecret: string): string | null {
  const at = clientSecret.indexOf("_secret_");
  if (at <= 0) return null;
  const id = clientSecret.slice(0, at);
  return PAYMENT_INTENT_ID_SHAPE.test(id) ? id : null;
}

/**
 * The sessionStorage key for one order's receipt secret: per embed and per
 * PaymentIntent id, which a redirect return also knows (it is the part of
 * the return URL's client secret before `_secret_`).
 */
export const embedReceiptSecretKey = (embedId: string, paymentIntentId: string) =>
  `${RECEIPT_SECRET_PREFIX}${embedId}:${paymentIntentId}`;

function usable(held: unknown): HeldReceiptSecret | null {
  if (!held || typeof held !== "object") return null;
  const { secret, at } = held as Partial<HeldReceiptSecret>;
  if (typeof secret !== "string" || !RECEIPT_SECRET_SHAPE.test(secret)) {
    return null;
  }
  const age = Date.now() - (typeof at === "number" ? at : NaN);
  if (!(age >= 0 && age < EMBED_RECEIPT_SECRET_MS)) return null;
  return { secret, at: at as number };
}

function readStored(key: string): HeldReceiptSecret | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let held: HeldReceiptSecret | null;
  try {
    held = usable(JSON.parse(raw));
  } catch {
    held = null;
  }
  if (!held) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage blocked: nothing to remove.
    }
  }
  return held;
}

function held(key: string): HeldReceiptSecret | null {
  const fromMemory = usable(inMemory.get(key));
  if (fromMemory) return fromMemory;
  inMemory.delete(key);
  return readStored(key);
}

/**
 * Keeps the receipt secret `createGuestCheckout` answered with, for the
 * order whose client secret came beside it. Call it as the answer lands,
 * before the payment step can call Stripe's `confirmPayment` (a redirect
 * method leaves the page there). A missing or malformed secret (an API older
 * than this web build sends none) is not kept.
 *
 * The FIRST secret kept for an order stays. A create sent again under the
 * same checkout key is answered from the server's replay record with a NEW
 * secret that the order's stored hash does not match (an accepted
 * degradation: that tab gets no codes, the email carries them). Keeping the
 * first is right whenever the original request's answer lands before the
 * replay's; which one lands first has not been measured, and when only the
 * replay's lands, no kept secret can match.
 */
export function rememberEmbedReceiptSecret(
  embedId: string,
  clientSecret: string,
  receiptSecret: unknown,
): void {
  if (typeof receiptSecret !== "string") return;
  if (!RECEIPT_SECRET_SHAPE.test(receiptSecret)) return;
  const paymentIntentId = paymentIntentIdOf(clientSecret);
  if (!paymentIntentId) return;
  const key = embedReceiptSecretKey(embedId, paymentIntentId);
  if (held(key)) return;
  const entry: HeldReceiptSecret = { secret: receiptSecret, at: Date.now() };
  inMemory.set(key, entry);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Storage blocked: the in-frame confirm still finds it in memory; a
    // redirect return in this frame will show no codes.
  }
}

/**
 * The receipt secret kept for the order behind `clientSecret`, or null: a
 * new tab, an expired entry, an order made before this build, or storage
 * that was blocked on a reload. Null means "ask without it". The server then
 * confirms with no codes.
 */
export function heldEmbedReceiptSecret(
  embedId: string,
  clientSecret: string,
): string | null {
  const paymentIntentId = paymentIntentIdOf(clientSecret);
  if (!paymentIntentId) return null;
  return held(embedReceiptSecretKey(embedId, paymentIntentId))?.secret ?? null;
}

/**
 * Deletes every embed's expired or unusable entry, in storage and in memory.
 * A read only checks the entry it is for, so without this a secret kept by
 * an embed that never loads again would sit in storage past its window.
 * Run on every widget mount.
 */
export function sweepExpiredEmbedReceiptSecrets(): void {
  for (const [key, entry] of inMemory) {
    if (!usable(entry)) inMemory.delete(key);
  }
  try {
    const store = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(RECEIPT_SECRET_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      let ok: HeldReceiptSecret | null;
      try {
        const raw = store.getItem(key);
        ok = raw ? usable(JSON.parse(raw)) : null;
      } catch {
        ok = null;
      }
      if (!ok) store.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing was written either.
  }
}

/** Tests only: forget the in-memory copies (storage is the test's to clear). */
export function forgetEmbedReceiptSecretsInMemory(): void {
  inMemory.clear();
}
