const MAX_STATEMENT_DESCRIPTOR_SUFFIX_LENGTH = 22;
const FALLBACK_PREFIX = "EVENT";

const TRANSLITERATION_MAP: Record<string, string> = {
  Æ: "AE",
  æ: "ae",
  Ð: "D",
  ð: "d",
  Ł: "L",
  ł: "l",
  Ø: "O",
  ø: "o",
  Þ: "TH",
  þ: "th",
  ß: "ss",
};

export function buildStatementDescriptorSuffix(
  title: string,
  eventId: string,
): string {
  const sanitized = sanitizeDescriptorText(title);
  const truncated = truncateAtWordBoundary(sanitized);
  const descriptor = hasAsciiLetter(truncated)
    ? truncated
    : buildFallbackDescriptor(eventId);

  return descriptor.toUpperCase();
}

function sanitizeDescriptorText(value: string): string {
  const transliterated = Array.from(value, (char) =>
    TRANSLITERATION_MAP[char] ?? char,
  ).join("");

  return transliterated
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 .,_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWordBoundary(value: string): string {
  if (value.length <= MAX_STATEMENT_DESCRIPTOR_SUFFIX_LENGTH) {
    return value;
  }

  const sliced = value.slice(0, MAX_STATEMENT_DESCRIPTOR_SUFFIX_LENGTH);
  const lastSpace = sliced.lastIndexOf(" ");
  const truncated = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;

  return truncated.trim();
}

function buildFallbackDescriptor(eventId: string): string {
  const eventPrefix = eventId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return truncateAtWordBoundary(`${FALLBACK_PREFIX} ${eventPrefix}`);
}

function hasAsciiLetter(value: string): boolean {
  return /[A-Za-z]/.test(value);
}