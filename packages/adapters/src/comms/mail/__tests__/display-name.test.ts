import { describe, expect, it } from "vitest";

import { escapeQuotedString, sanitizeDisplayName } from "../display-name";

describe("escapeQuotedString", () => {
  it("escapes quotes so a name can't close the quoted string and add a mailbox", () => {
    const name = 'x" <evil@x.io>, "y';
    const quoted = `"${escapeQuotedString(name)}" <victim@example.com>`;
    expect(quoted).toBe('"x\\" <evil@x.io>, \\"y" <victim@example.com>');
    // Exactly two UNESCAPED quotes remain: the ones we added.
    expect(quoted.match(/(?<!\\)"/g)).toHaveLength(2);
  });

  it("escapes backslashes first, so a trailing backslash can't escape our closing quote", () => {
    expect(escapeQuotedString("a\\")).toBe("a\\\\");
    expect(escapeQuotedString('a\\"')).toBe('a\\\\\\"');
  });

  it("leaves an ordinary name alone", () => {
    expect(escapeQuotedString("Maya Rodriguez")).toBe("Maya Rodriguez");
  });
});

describe("sanitizeDisplayName", () => {
  it("collapses line breaks and drops control characters", () => {
    expect(sanitizeDisplayName(" Mallory\r\nBcc: a@b.c\u0000 ")).toBe(
      "Mallory Bcc: a@b.c",
    );
  });
});
