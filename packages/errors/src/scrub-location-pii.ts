/**
 * Strips WHERE-SOMEONE-LIVES data from an error-tracker event before it leaves
 * the process.
 *
 * Why this exists: the API reports with `sendDefaultPii: true` (the
 * request body), and frame locals (`includeLocalVariables`, off in the API
 * today; the web server has it on) would carry the values of every local in
 * every stack frame. A place may withhold its address — often because the place
 * is somebody's home — and the only copy of the truth lives on the Place row.
 * An exception thrown anywhere that holds that row (an upsert, an event save,
 * a holder email) would otherwise ship the street, the coordinates and the
 * phone number to a third-party SaaS whose access list is not ours.
 *
 * Scrubbing is by KEY, not by value: a value cannot be recognised as an
 * address, but the field names are ours. Keys are compared case-insensitively
 * with `_`/`-` ignored, so `postalCode`, `postal_code` and `POSTALCODE` all
 * match. A sensitive key's whole value is replaced — including an object
 * (`address: { … }`) — with {@link SCRUBBED}.
 *
 * Shape-agnostic on purpose: this package does not depend on a Sentry SDK, so
 * the event is typed structurally and every area is optional. The areas
 * walked are the ones that carry application data:
 *
 *   - `exception.values[].stacktrace.frames[].vars` (local variables)
 *   - `request.data` (object, or a JSON string — parsed, scrubbed and
 *     re-serialised; a string that is not valid JSON, e.g. a body the SDK
 *     truncated, is scrubbed textually `"key": value` by `"key": value`)
 *   - `extra`
 *   - `contexts`
 *   - `breadcrumbs[].data` (array form, and the legacy `{ values: [] }` form)
 *   - `request.url`'s query and `request.query_string`: replaced whole when
 *     they carry location (a sensitive parameter name, or decoded text the
 *     message scrub changes: a tRPC GET's `?input=` JSON); the path is kept
 *   - `tags`
 *   - free TEXT: `exception.values[].value`, `message` (string, or its
 *     `message` / `formatted`), `logentry.message` / `formatted` / `params`,
 *     `breadcrumbs[].message`, and every string leaf of the areas above
 *     except the request body (keys first: a sensitive key's value is
 *     replaced unexamined). A Prisma validation error prints its call's
 *     arguments (`geometry: { type: "Polygon", coordinates: [ [ … ] ] }`),
 *     and the API copies a cause's message into `extra.causeMessage`, so text
 *     is scrubbed `key: value` by `key: value` ({@link scrubMessageText}) and
 *     bare decimal coordinate pairs are cut wherever they stand. Text work is
 *     capped per string ({@link MAX_TEXT_LENGTH}) and per area
 *     ({@link MAX_AREA_TEXT}).
 *
 * BOUNDED: depth-capped at {@link MAX_DEPTH} and node-capped at
 * {@link MAX_NODES}. Anything past either cap is REPLACED, never passed
 * through unexamined — an object we did not look inside is an object we
 * cannot vouch for. Cycles are detected along the current path and become
 * `"[Circular]"`.
 *
 * NEVER THROWS. Each area is scrubbed under its own guard; an area that fails
 * is dropped (a frame's vars, the request body, extra, a breadcrumb's data, a
 * context — except `trace`, which loses only its `data`). The outer guard is
 * the last resort and drops every frame's vars. Instrumentation must never be
 * the reason an error goes unreported — nor the reason an address is.
 *
 * The event is mutated in place (its areas are REPLACED with scrubbed copies —
 * the copies never alias application objects) and returned, so it can be the
 * last expression of a `beforeSend` / `beforeSendTransaction` hook.
 */

/** Replacement value for a sensitive key. */
export const SCRUBBED = "[scrubbed]";

/** Replacement for a subtree past the depth or node budget. */
export const SCRUBBED_TRUNCATED = "[scrubbed: truncated]";

/** Nesting levels walked below an area's root. */
export const MAX_DEPTH = 12;

/** Total values visited per area before the rest is replaced. */
export const MAX_NODES = 20_000;

/**
 * Keys whose value is location or a proxy for it (a phone number
 * reverse-looks-up to an address). Written in their natural casing; matching
 * normalises. `addrLine1` / `addrLine2` / `postcode` are the Place columns,
 * `addressLine1` / `addressLine2` / `postalCode` the record fields.
 * `locationLabel` / `areaLabel` / `city` / `region` are deliberately absent:
 * they are what a withheld place publishes, and they are what makes an error
 * report triageable.
 */
export const LOCATION_SENSITIVE_KEYS: readonly string[] = [
  "address",
  "addressText",
  "formattedAddress",
  "addrLine1",
  "addrLine2",
  "addressLine1",
  "addressLine2",
  "street",
  "postalCode",
  "postcode",
  "zip",
  "lat",
  "lng",
  "latitude",
  "longitude",
  // The viewer's own position (`events.discoverPublicEvents` input).
  "userLat",
  "userLng",
  "geohash",
  "geohash8",
  "geohash6",
  "geoPoint",
  "phone",
  // Columns that hold a phone or a postal address (grep packages/db/prisma):
  // performer / application / agreement / volunteer contacts, SMS consent,
  // auth users, org mailing address, billing and tax-situs snapshots.
  "contactPhone",
  "phoneE164",
  "phoneNumber",
  "physicalAddress",
  "billingAddressLine1",
  "billingAddressLine2",
  "billingPostalCode",
  "taxSitusPostal",
  // Arrival-area shapes (GeoJSON) and their positions: a drawn lot beside a
  // withheld house is the house (arrival-areas NFR-002).
  "geometry",
  "coordinates",
  // Bare position arrays held in stack-frame locals (arrival-areas geometry
  // helpers). `positions` and `line` also name payee positions and
  // agreement / tax lines in settlement code: scrubbing those locals costs
  // triage detail only, never behaviour.
  "positions",
  "ring",
  "line",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, "");
}

const SENSITIVE = new Set(LOCATION_SENSITIVE_KEYS.map(normalizeKey));

/** True when `key` names location (or a location proxy) and must be scrubbed. */
export function isLocationSensitiveKey(key: string): boolean {
  return SENSITIVE.has(normalizeKey(key));
}

type Budget = {
  nodes: number;
  /** Characters of string leaves text-scrubbed so far in this area. */
  chars: number;
  /** Text-scrub string leaves (false only for the request body). */
  textLeaves: boolean;
};

/**
 * A string leaf: scrubbed as text when it could hold `key: value` text or a
 * position (a cheap pre-check), within the area's {@link MAX_AREA_TEXT}.
 */
function scrubLeafText(value: string, budget: Budget): string {
  if (!value.includes(":") && !value.includes("[")) return value;
  if (budget.chars + value.length > MAX_AREA_TEXT) {
    budget.chars = MAX_AREA_TEXT;
    return SCRUBBED_TRUNCATED;
  }
  budget.chars += value.length;
  return scrubMessageText(value);
}

function scrubValue(
  value: unknown,
  depth: number,
  path: Set<object>,
  budget: Budget,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) return SCRUBBED_TRUNCATED;
  // Keys first (below: a sensitive key's value is replaced unexamined); a
  // string reached here sits under a non-sensitive key, so its TEXT is
  // scrubbed (an error message copied into `extra.causeMessage`).
  if (typeof value === "string") {
    return budget.textLeaves ? scrubLeafText(value, budget) : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return SCRUBBED_TRUNCATED;
  // Cycle = the value is already on the path from the root. A value shared
  // by two branches (a DAG) is not a cycle and is scrubbed in both.
  if (path.has(value)) return "[Circular]";
  if (value instanceof Date) return value;

  path.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        if (budget.nodes >= MAX_NODES) {
          out.push(SCRUBBED_TRUNCATED);
          break;
        }
        out.push(scrubValue(item, depth + 1, path, budget));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (budget.nodes >= MAX_NODES) {
        out[key] = SCRUBBED_TRUNCATED;
        break;
      }
      out[key] = isLocationSensitiveKey(key)
        ? SCRUBBED
        : scrubValue(child, depth + 1, path, budget);
    }
    return out;
  } finally {
    path.delete(value);
  }
}

/**
 * Scrub one area root with a fresh cycle path and budget. `textLeaves: false`
 * keeps the request-body path as it was (keys only).
 */
function scrubArea(value: unknown, textLeaves = true): unknown {
  return scrubValue(value, 0, new Set(), { nodes: 0, chars: 0, textLeaves });
}

/**
 * `"key": value` pairs in JSON-ish text whose key is sensitive. Handles a
 * string / number / literal value; an object or array value is left to its
 * own keys (the textual path is the fallback for text that is not JSON).
 */
const JSON_PAIR_RE =
  /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g;

/** A key followed by an object or array value (`"key": {` / `"key": [`). */
const JSON_CONTAINER_KEY_RE = /"((?:[^"\\]|\\.)*)"\s*:\s*[[{]/g;

/**
 * FAIL CLOSED on text that is not JSON (a body the SDK truncated): a
 * sensitive key whose value is an object or array cannot be bounded without
 * a parser (`"coordinates":[[[-86.78,36.16],…` has no closing bracket), so
 * everything from that key on is cut and replaced by
 * {@link SCRUBBED_TRUNCATED}. The head is then scrubbed pair by pair.
 */
function scrubJsonishText(text: string): string {
  let head = text;
  JSON_CONTAINER_KEY_RE.lastIndex = 0;
  for (let m = JSON_CONTAINER_KEY_RE.exec(text); m; m = JSON_CONTAINER_KEY_RE.exec(text)) {
    if (isLocationSensitiveKey(m[1] ?? "")) {
      head = `${text.slice(0, m.index)}"${SCRUBBED_TRUNCATED}"`;
      break;
    }
  }
  return head.replace(JSON_PAIR_RE, (match, key: string, sep: string) =>
    isLocationSensitiveKey(key) ? `"${key}"${sep}"${SCRUBBED}"` : match,
  );
}

/** Characters of one message text examined; the rest is replaced. */
export const MAX_TEXT_LENGTH = 64 * 1024;

/**
 * Characters of string leaves text-scrubbed per area (frame vars, extra, one
 * context, …); a leaf past it is replaced whole.
 */
export const MAX_AREA_TEXT = 256 * 1024;

/** A bare key longer than this is not treated as a key. */
const MAX_KEY_LENGTH = 64;

/** Levels of quoted-string-inside-quoted-string (escaped JSON) looked into. */
const MAX_STRING_DEPTH = 3;

/** How far back from a length cut an unclosed `[` is looked for. */
const TAIL_BRACKET_WINDOW = 500;

/**
 * A bare `[lng, lat]` / `[lng, lat, alt]` pair: two decimals of at most three
 * integer digits, optionally a third number. What is left of a GeoJSON shape
 * once its keys are gone, or a position in a message without one. Integer
 * pairs (`[-86, 36]`) are deliberately NOT matched: that would redact every
 * small numeric array in a message (ids, counts, ranges) for a position
 * precise to ~100 km.
 */
const COORDINATE_PAIR_RE =
  /\[\s{0,200}-?\d{1,3}\.\d{1,20}\s{0,200},\s{0,200}-?\d{1,3}\.\d{1,20}(?:\s{0,200},\s{0,200}-?\d{1,9}(?:\.\d{1,20})?)?\s{0,200}\]/g;

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[\w$-]/;
/**
 * A bare key may not continue a word (`36lat:`). It MAY follow a `.`: in a
 * dotted path (`data.lat: 36.16`) the last segment is the key, and
 * `prisma.arrivalArea.create(` has no `:` after any segment.
 */
const WORD_CHAR = /[\w$]/;

function isLineBreak(ch: string | undefined): boolean {
  return ch === "\n" || ch === "\r";
}

function isQuote(ch: string | undefined): ch is '"' | "'" {
  return ch === '"' || ch === "'";
}

/**
 * The index of the quote closing the one at `start` on the same line,
 * honouring backslash escapes; when the line (or text) ends first, `-1 - p`
 * where `p` is where the scan stopped.
 */
function quoteClose(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) return i;
    if (isLineBreak(ch)) break;
    i += ch === "\\" ? 2 : 1;
  }
  return -1 - Math.min(i, text.length);
}

/** Index just past a `:` key separator at `p` (spaces/tabs first), or -1. */
function afterKeyColon(text: string, p: number): number {
  let i = p;
  while (text[i] === " " || text[i] === "\t") i += 1;
  if (text[i] !== ":") return -1;
  if (text[i + 1] === "/" && text[i + 2] === "/") return -1; // a URL scheme
  return i + 1;
}

/** Longest dotted path (`data.where.lat`) {@link startsKeyAt} reads. */
const MAX_KEY_PATH_LENGTH = 4 * MAX_KEY_LENGTH;

/**
 * Does a `key:` (bare, quoted, or a bare dotted path such as `data.lat:`)
 * start at `p`? Bounded work.
 */
function startsKeyAt(text: string, p: number): boolean {
  const ch = text[p];
  if (isQuote(ch)) {
    const close = quoteClose(text, p);
    return close >= 0 && close - p <= 200 && afterKeyColon(text, close + 1) >= 0;
  }
  if (!ch || !IDENT_START.test(ch)) return false;
  if (p > 0 && WORD_CHAR.test(text[p - 1] as string)) return false;
  let segment = p;
  let e = p + 1;
  for (;;) {
    while (
      e < text.length &&
      e - segment <= MAX_KEY_LENGTH &&
      IDENT_CHAR.test(text[e] as string)
    ) {
      e += 1;
    }
    if (e - segment > MAX_KEY_LENGTH || e - p > MAX_KEY_PATH_LENGTH) return false;
    if (text[e] !== "." || !IDENT_START.test(text[e + 1] ?? "")) break;
    segment = e + 1;
    e = segment + 1;
  }
  return afterKeyColon(text, e) >= 0;
}

/**
 * The index just past the `}` / `]` that closes the container opening at
 * `start`, or -1 when the text ends first (a truncated message). Quoted
 * strings (either quote) are skipped up to the end of their line, so a
 * bracket inside one does not count. Linear.
 */
function containerEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (isQuote(ch)) {
      const close = quoteClose(text, i);
      i = close >= 0 ? close + 1 : -1 - close;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * The end of a bare (unquoted, unbracketed) sensitive value starting at
 * `start`. It runs to the end of the line, and stops earlier only at an
 * unmatched closing bracket or at a `,` that ends the line or is followed by
 * another `key:`. A `key:` NOT preceded by a comma does not end it
 * (`lat: 36.1 lng: -86.7` is one value). `(…)` / `[…]` / `{…}` and quoted
 * parts inside it are kept whole, so `phone: +1 (615) 555-1234` and
 * `lat: new Prisma.Decimal("36.16"), lng: …` end where they should.
 */
function bareValueEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (isLineBreak(ch)) break;
    if (isQuote(ch)) {
      const close = quoteClose(text, i);
      if (close < 0) {
        i = -1 - close;
        break;
      }
      i = close + 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      // A `,` ends the value only before another `key:` or at the end of
      // the line (Prisma's `lng: -86.78,`); `1417 Shelby Ave, Nashville`
      // runs on.
      let k = i + 1;
      while (text[k] === " " || text[k] === "\t") k += 1;
      if (k >= text.length || isLineBreak(text[k]) || startsKeyAt(text, k)) break;
    }
    i += 1;
  }
  while (i > start && (text[i - 1] === " " || text[i - 1] === "\t")) i -= 1;
  return i;
}

type ValueCut = { start: number; end: number; replacement: string };

/**
 * Where the value of a sensitive key whose `:` ends at `colonEnd` lies, and
 * what replaces it. FAIL CLOSED: a container that never closes, or a value on
 * the following lines with no later `key:` line, runs to the end of the text.
 * Null when there is no value to take.
 */
function sensitiveValueAt(text: string, colonEnd: number): ValueCut | null {
  let p = colonEnd;
  while (text[p] === " " || text[p] === "\t") p += 1;
  if (p >= text.length) return null;
  const ch = text[p];
  const toEnd = { start: p, end: text.length, replacement: `"${SCRUBBED_TRUNCATED}"` };

  if (isLineBreak(ch)) {
    // `p` is the line break: replacements here carry the space a same-line
    // value keeps, so every branch reads `key: "…"`.
    const toEndHere = { ...toEnd, replacement: ` "${SCRUBBED_TRUNCATED}"` };
    // The value is on the following line(s).
    let r = p;
    while (r < text.length && /\s/.test(text[r] as string)) r += 1;
    if (r >= text.length) return null;
    if (text[r] === "{" || text[r] === "[") {
      const end = containerEnd(text, r);
      return end < 0
        ? toEndHere
        : { start: p, end, replacement: ` "${SCRUBBED}"` };
    }
    // Every line up to the next one that starts a key (or closes a bracket).
    let lineStart = p;
    while (lineStart < text.length) {
      let t = lineStart;
      while (isLineBreak(text[t])) t += 1;
      const breakAt = lineStart;
      while (text[t] === " " || text[t] === "\t") t += 1;
      if (startsKeyAt(text, t) || /[}\])]/.test(text[t] ?? "")) {
        const region = text.slice(p, breakAt);
        return /\S/.test(region)
          ? { start: p, end: breakAt, replacement: ` "${SCRUBBED}"` }
          : null;
      }
      let next = t;
      while (next < text.length && !isLineBreak(text[next])) next += 1;
      if (next >= text.length) break;
      lineStart = next;
    }
    return toEndHere;
  }
  if (ch === "{" || ch === "[") {
    const end = containerEnd(text, p);
    return end < 0 ? toEnd : { start: p, end, replacement: `"${SCRUBBED}"` };
  }
  if (isQuote(ch)) {
    const close = quoteClose(text, p);
    const end = close >= 0 ? close + 1 : -1 - close;
    return { start: p, end, replacement: `"${SCRUBBED}"` };
  }
  const end = bareValueEnd(text, p);
  return end > p ? { start: p, end, replacement: `"${SCRUBBED}"` } : null;
}

/**
 * Does a quoted value hold scrubbable text once unescaped? Escaped JSON
 * (`"{\"lat\":36.1}"`) and a message quoted inside a message both land here.
 */
function quotedValueIsSensitive(content: string, depth: number): boolean {
  const mayHoldKeyText = content.includes(":") || content.includes("[");
  // Past the nesting cap the string is not looked into: FAIL CLOSED, any one
  // that could hold key text or a position goes whole.
  if (depth >= MAX_STRING_DEPTH) return mayHoldKeyText;
  if (!mayHoldKeyText) return false;
  const unescaped = content.replace(/\\([\s\S])/g, "$1");
  return scrubTextAt(unescaped, depth + 1) !== unescaped;
}

/**
 * One left-to-right pass over `text`. Quoted strings are whole tokens: a
 * quoted string followed by `:` is a key, any other is a value (looked into
 * for escaped key text, and replaced whole if it holds any). A bare
 * identifier followed by `:` is a key unless it continues a word; the last
 * segment of a dotted path counts (`data.lat:`). A sensitive key keeps its name;
 * only its value is replaced. Linear: a quote that fails to close on its line
 * marks the rest of that line, so no later quote of the same kind rescans it.
 */
function scrubTextAt(text: string, depth: number): string {
  let out = "";
  let cursor = 0;
  let i = 0;
  const unclosedUntil: Record<'"' | "'", number> = { '"': -1, "'": -1 };

  const takeSensitive = (colonEnd: number): number | null => {
    const cut = sensitiveValueAt(text, colonEnd);
    if (!cut) return null;
    out += text.slice(cursor, cut.start) + cut.replacement;
    cursor = cut.end;
    return cut.end;
  };

  while (i < text.length) {
    const ch = text[i] as string;
    if (isQuote(ch) && i >= unclosedUntil[ch]) {
      const close = quoteClose(text, i);
      if (close < 0) {
        unclosedUntil[ch] = -1 - close;
        i += 1;
        continue;
      }
      const colonEnd = afterKeyColon(text, close + 1);
      if (colonEnd >= 0) {
        const next = isLocationSensitiveKey(text.slice(i + 1, close))
          ? takeSensitive(colonEnd)
          : null;
        i = next ?? colonEnd;
        continue;
      }
      if (quotedValueIsSensitive(text.slice(i + 1, close), depth)) {
        out += `${text.slice(cursor, i)}"${SCRUBBED}"`;
        cursor = close + 1;
      }
      i = close + 1;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let e = i + 1;
      while (e < text.length && IDENT_CHAR.test(text[e] as string)) e += 1;
      const keyable =
        e - i <= MAX_KEY_LENGTH &&
        !(i > 0 && WORD_CHAR.test(text[i - 1] as string));
      const colonEnd = keyable ? afterKeyColon(text, e) : -1;
      if (colonEnd >= 0) {
        const next = isLocationSensitiveKey(text.slice(i, e))
          ? takeSensitive(colonEnd)
          : null;
        i = next ?? colonEnd;
        continue;
      }
      i = e;
      continue;
    }
    i += 1;
  }
  out += text.slice(cursor);
  return out.replace(COORDINATE_PAIR_RE, `"${SCRUBBED}"`);
}

/**
 * Scrub free text (an exception message, a log line, a string local) `key:
 * value` by `key: value`: quoted (`"lat": 36.1`, `'lat': …`) and bare
 * (`lat: 36.1`) keys; a value that is a scalar, a quoted string, a nested
 * `{ … }` / `[ … ]` (Prisma prints its arguments that way, over many lines)
 * or on the following lines. A sensitive key keeps its name, so the message
 * still says which field failed. FAIL CLOSED: a value that never ends runs to
 * the end of the text, and text past {@link MAX_TEXT_LENGTH} is replaced
 * (cut before an unclosed `[` near the cut, so a position is never split).
 * Then any bare decimal coordinate pair left is cut.
 */
export function scrubMessageText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return scrubTextAt(text, 0);
  let head = text.slice(0, MAX_TEXT_LENGTH);
  let closers = 0;
  for (let i = head.length - 1; i >= head.length - TAIL_BRACKET_WINDOW; i -= 1) {
    const ch = head[i];
    if (ch === "]") closers += 1;
    else if (ch === "[") {
      if (closers === 0) {
        head = head.slice(0, i);
        break;
      }
      closers -= 1;
    }
  }
  return scrubTextAt(head, 0) + SCRUBBED_TRUNCATED;
}

/** {@link scrubMessageText} for a value that may not be a string. */
function scrubTextField(value: unknown): unknown {
  return typeof value === "string" ? scrubMessageText(value) : value;
}

/** `message` / `formatted` / `params` of a log-entry-shaped object, in place. */
function scrubLogEntry(entry: Loose): void {
  if (entry.message !== undefined) entry.message = scrubTextField(entry.message);
  if (entry.formatted !== undefined) {
    entry.formatted = scrubTextField(entry.formatted);
  }
  if (entry.params !== undefined) entry.params = scrubArea(entry.params);
}

/** Decode one query component (`+` is a space); null when it is malformed. */
function decodeQueryPart(part: string): string | null {
  try {
    return decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * Does a raw query string (no leading `?`) carry location? A parameter named
 * like a sensitive key (`lat=36.16`), or a value whose decoded text the
 * message scrub would change (a tRPC GET's `input={"json":{"near":{"lat":…}}}`).
 * FAIL CLOSED: a component that does not decode counts as location.
 */
function queryCarriesLocation(query: string): boolean {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = decodeQueryPart(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? "" : decodeQueryPart(pair.slice(eq + 1));
    if (key === null || value === null) return true;
    if (isLocationSensitiveKey(key)) return true;
    const text = `${key}=${value}`;
    if (scrubMessageText(text) !== text) return true;
  }
  return false;
}

/**
 * `request.url` with its query replaced by {@link SCRUBBED} when the query
 * carries location (the path, which names the procedure, is kept; so is the
 * rest of a URL with no query).
 */
function scrubRequestUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const hash = url.indexOf("#", q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  return queryCarriesLocation(query) ? `${url.slice(0, q)}?${SCRUBBED}` : url;
}

/**
 * `request.query_string` (a string, `[key, value]` pairs, or an object):
 * replaced whole by {@link SCRUBBED} when it carries location.
 */
function scrubQueryString(qs: unknown): unknown {
  if (typeof qs === "string") {
    return queryCarriesLocation(qs.startsWith("?") ? qs.slice(1) : qs)
      ? SCRUBBED
      : qs;
  }
  const pairs: Array<[unknown, unknown]> = Array.isArray(qs)
    ? qs.map((pair) => (Array.isArray(pair) ? [pair[0], pair[1]] : [pair, ""]))
    : isObject(qs)
      ? Object.entries(qs)
      : [];
  for (const [key, value] of pairs) {
    const k = String(key);
    const v = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    if (isLocationSensitiveKey(k)) return SCRUBBED;
    const text = `${k}=${v}`;
    if (scrubMessageText(text) !== text) return SCRUBBED;
  }
  return qs;
}

function scrubRequestData(data: unknown): unknown {
  if (typeof data !== "string") return scrubArea(data, false);
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(scrubArea(parsed, false));
    }
    return data;
  } catch {
    return scrubJsonishText(data);
  }
}

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return value !== null && typeof value === "object";
}

function framesOf(event: Loose): Loose[] {
  const exception = event.exception;
  if (!isObject(exception) || !Array.isArray(exception.values)) return [];
  const frames: Loose[] = [];
  for (const value of exception.values) {
    if (!isObject(value)) continue;
    const stacktrace = value.stacktrace;
    if (!isObject(stacktrace) || !Array.isArray(stacktrace.frames)) continue;
    for (const frame of stacktrace.frames) {
      if (isObject(frame)) frames.push(frame);
    }
  }
  return frames;
}

function dropFrameVars(event: Loose): void {
  for (const frame of framesOf(event)) {
    delete frame.vars;
  }
}

function breadcrumbsOf(event: Loose): Loose[] {
  const crumbs = event.breadcrumbs;
  const list = Array.isArray(crumbs)
    ? crumbs
    : isObject(crumbs) && Array.isArray(crumbs.values)
      ? crumbs.values
      : [];
  return list.filter(isObject);
}

/**
 * Run `fn`; if it throws, run `onError` (itself guarded). Keeps one area's
 * failure from skipping the others.
 */
function guarded(fn: () => void, onError: () => void): void {
  try {
    fn();
  } catch {
    try {
      onError();
    } catch {
      // Nothing left to do for this area; the other areas still run.
    }
  }
}

/**
 * Scrub location data out of an error-tracker event (see the module header).
 * Mutates and returns `event`; never throws.
 */
export function scrubLocationFromErrorEvent<E>(event: E): E {
  if (!isObject(event)) return event;
  const e = event as Loose;
  try {
    // 1. Stack-frame locals.
    for (const frame of framesOf(e)) {
      guarded(
        () => {
          if (frame.vars !== undefined) frame.vars = scrubArea(frame.vars);
        },
        () => {
          delete frame.vars;
        },
      );
    }

    // 2. Request body.
    const request = e.request;
    if (isObject(request) && request.data !== undefined) {
      guarded(
        () => {
          request.data = scrubRequestData(request.data);
        },
        () => {
          delete request.data;
        },
      );
    }

    // 2b. Request URL query and query string: a tRPC GET carries its input
    // there (`?input=<url-encoded JSON>`, e.g. a search's `near` lat/lng).
    if (isObject(request)) {
      if (typeof request.url === "string") {
        const url = request.url;
        guarded(
          () => {
            request.url = scrubRequestUrl(url);
          },
          () => {
            const q = url.indexOf("?");
            request.url = q < 0 ? url : `${url.slice(0, q)}?${SCRUBBED}`;
          },
        );
      }
      if (request.query_string !== undefined) {
        guarded(
          () => {
            request.query_string = scrubQueryString(request.query_string);
          },
          () => {
            request.query_string = SCRUBBED;
          },
        );
      }
    }

    // 3. Extra.
    if (e.extra !== undefined) {
      guarded(
        () => {
          e.extra = scrubArea(e.extra);
        },
        () => {
          delete e.extra;
        },
      );
    }

    // 4. Contexts — per context, so one bad context cannot cost the others.
    // A context value must stay an object (the ingest schema), so a context
    // that cannot be scrubbed is removed rather than replaced by a string —
    // except `trace`, which links the event to its transaction: only its
    // free-form `data` goes.
    const contexts = e.contexts;
    if (isObject(contexts)) {
      for (const name of Object.keys(contexts)) {
        guarded(
          () => {
            if (isLocationSensitiveKey(name)) {
              delete contexts[name];
              return;
            }
            contexts[name] = scrubArea(contexts[name]);
          },
          () => {
            const context = contexts[name];
            if (name === "trace" && isObject(context)) {
              delete context.data;
            } else {
              delete contexts[name];
            }
          },
        );
      }
    }

    // 5. Message text: what a Prisma validation error (and any thrown
    // message that interpolates its input) prints. Each part under its own
    // guard; one that cannot be scrubbed is replaced, never kept.
    const exception = e.exception;
    if (isObject(exception) && Array.isArray(exception.values)) {
      for (const value of exception.values) {
        if (!isObject(value) || value.value === undefined) continue;
        guarded(
          () => {
            value.value = scrubTextField(value.value);
          },
          () => {
            value.value = SCRUBBED_TRUNCATED;
          },
        );
      }
    }
    if (e.message !== undefined) {
      guarded(
        () => {
          if (isObject(e.message)) scrubLogEntry(e.message);
          else e.message = scrubTextField(e.message);
        },
        () => {
          e.message = SCRUBBED_TRUNCATED;
        },
      );
    }
    const logentry = e.logentry;
    if (isObject(logentry)) {
      guarded(
        () => scrubLogEntry(logentry),
        () => {
          delete e.logentry;
        },
      );
    }

    // 6. Tags: strings, so only their text can carry a message.
    const tags = e.tags;
    if (isObject(tags)) {
      guarded(
        () => {
          e.tags = scrubArea(tags);
        },
        () => {
          delete e.tags;
        },
      );
    }

    // 7. Breadcrumbs: their data, and their message text.
    for (const crumb of breadcrumbsOf(e)) {
      if (crumb.data !== undefined) {
        guarded(
          () => {
            crumb.data = scrubArea(crumb.data);
          },
          () => {
            delete crumb.data;
          },
        );
      }
      if (crumb.message !== undefined) {
        guarded(
          () => {
            crumb.message = scrubTextField(crumb.message);
          },
          () => {
            delete crumb.message;
          },
        );
      }
    }
  } catch {
    // Last resort: the frames' locals are where a Place row is most likely
    // to be sitting. Drop them all.
    try {
      dropFrameVars(e);
    } catch {
      // The event goes out as-is rather than not at all.
    }
  }
  return event;
}
