import { isIP } from "node:net";

/**
 * The identity a client IP is rate-limited under.
 *
 * WHY. A per-IP counter is only as strong as the cost of a new IP. For IPv4
 * that cost is real. For IPv6 it is zero: an ISP or cloud host hands a single
 * customer a whole /64 (2^64 addresses), so a limiter keyed on the full
 * address lets one attacker rotate through unlimited "distinct" IPs. Keying
 * IPv6 on its /64 puts the whole allocation in one bucket.
 *
 *  - IPv4 → returned UNCHANGED (byte-identical to the raw value, so every
 *    existing IPv4 counter key stays the same across a deploy).
 *  - IPv6 → its /64 prefix: the first four hextets, lower-case and
 *    zero-padded, as `xxxx:xxxx:xxxx:xxxx::/64`. A zone id (`%eth0`) is dropped.
 *  - IPv4-mapped IPv6 (`::ffff:a.b.c.d`, or its hex form `::ffff:0102:0304`)
 *    → the dotted IPv4, so a dual-stack proxy cannot split one client into
 *    two buckets or park every IPv4 client in the same `::ffff:0:0/64`.
 *  - null / undefined / blank → null (callers substitute their "no-ip" key).
 *  - Anything else (not an IP) → returned unchanged. `ctx.clientIp` can carry
 *    an unvalidated proxy-header value on the non-forwarded path; passing it
 *    through keeps today's keys rather than collapsing strangers together.
 */
export function rateLimitIpBucket(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  if (isIP(raw) === 4) return raw;

  const zone = raw.indexOf("%");
  const address = zone >= 0 ? raw.slice(0, zone) : raw;
  if (isIP(address) !== 6) return raw;

  const hextets = expandIpv6(address);
  if (!hextets) return raw;

  // IPv4-mapped (::ffff:0:0/96) → the IPv4 address.
  if (hextets.slice(0, 5).every((h) => h === "0000") && hextets[5] === "ffff") {
    const hi = parseInt(hextets[6]!, 16);
    const lo = parseInt(hextets[7]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }

  // Deprecated IPv4-compatible `::a.b.c.d` deliberately lands in the zero /64.
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

/**
 * Expand an IPv6 address (already accepted by `isIP`) to eight lower-case,
 * four-digit hextets. An embedded IPv4 tail becomes its two hextets. Returns
 * null on anything malformed, which `isIP` should already have ruled out.
 */
function expandIpv6(address: string): string[] | null {
  let text = address.toLowerCase();

  const v4Tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4Tail) {
    const octets = v4Tail.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, -v4Tail[0].length)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  // Without `::` there must be exactly eight groups; with it, `::` stands for
  // at least one zero group (RFC 5952 allows it to replace a single group).
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0"));
}
