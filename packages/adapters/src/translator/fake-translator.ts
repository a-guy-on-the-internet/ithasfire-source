import type { TranslatorPort } from "@th/ports/translator";

/**
 * Deterministic `TranslatorPort` for tests and local dev without Google
 * credentials. Known phrases come from `dictionary` (keyed
 * `<target>:<text>`); anything else becomes `[<target>] <text>`.
 */
export class FakeTranslator implements TranslatorPort {
  readonly calls: Array<{ text: string; source: string; targets: string[] }> =
    [];

  constructor(private readonly dictionary: Record<string, string> = {}) {}

  async translate(input: {
    text: string;
    source: string;
    targets: string[];
  }): Promise<Record<string, string>> {
    this.calls.push({ ...input, targets: [...input.targets] });
    const out: Record<string, string> = {};
    for (const target of input.targets) {
      if (target === input.source) continue;
      out[target] =
        this.dictionary[`${target}:${input.text}`] ??
        `[${target}] ${input.text}`;
    }
    return out;
  }
}
