import { describe, expect, it, vi } from "vitest";

import {
  createMessageFormatter,
  createMessageResolver,
  formatMessageString,
  resolveMessage,
  type Messages,
} from "../../src/locale/index.js";

const messages: Messages = {
  greeting: "Hello {name}",
  nested: {
    label: "Nested",
  },
};

describe("locale utils", () => {
  it("resolves nested message keys", () => {
    expect(resolveMessage(messages, "nested.label")).toBe("Nested");
    expect(resolveMessage(messages, "nested.missing")).toBeUndefined();
  });

  it("formats message strings with values", () => {
    expect(formatMessageString("Hello {name}", { name: "Grace" })).toBe(
      "Hello Grace",
    );
    expect(formatMessageString("Value {value}")).toBe("Value {value}");
  });

  it("creates a message formatter with fallback logic", () => {
    const onMissing = vi.fn();
    const formatter = createMessageFormatter(messages, {
      missingStrategy: "return-empty",
      onMissingMessage: onMissing,
    });

    expect(formatter.formatMessage("greeting", { name: "Alan" })).toBe(
      "Hello Alan",
    );
    expect(formatter.formatMessage("unknown")).toBe("");
    expect(onMissing).toHaveBeenCalledWith("unknown");
  });

  it("creates a resolver with key fallback", () => {
    const resolver = createMessageResolver(messages);

    expect(resolver.getMessageOrFallback("missing")).toBe("missing");
    expect(resolver.getMessageOrFallback("greeting")).toBe("Hello {name}");
  });
});
