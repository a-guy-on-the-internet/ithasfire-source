import type { Configuration, RuleSetRule } from "webpack";
import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";

const webpackFn = nextConfig.webpack as
  | ((config: Configuration) => Configuration)
  | undefined;

const isRuleSetRule = (value: unknown): value is RuleSetRule => {
  return typeof value === "object" && value !== null;
};

const isRegexRule = (
  rule: RuleSetRule,
): rule is RuleSetRule & { test: RegExp } => {
  return rule.test instanceof RegExp;
};

type JavascriptParser = {
  javascript?: {
    exportsPresence?: string;
  };
};

const getJavascriptParser = (
  rule?: RuleSetRule,
): JavascriptParser | undefined => {
  if (!rule?.parser || typeof rule.parser !== "object") {
    return undefined;
  }
  return rule.parser as JavascriptParser;
};

describe("next.config webpack", () => {
  it("forces TRPC dist files to javascript/auto with relaxed export checks", () => {
    expect(webpackFn).toBeTypeOf("function");

    const baseConfig: Configuration = {};
    const mutated = webpackFn!(baseConfig);

    const rules = mutated.module?.rules ?? [];
    const trpcRule = rules.find(
      (rule): rule is RuleSetRule & { test: RegExp } => {
        if (!isRuleSetRule(rule) || !isRegexRule(rule)) {
          return false;
        }

        const unixPath = "node_modules/@trpc/client/dist/index.mjs";
        const windowsPath =
          "node_modules\\@trpc\\react-query\\dist\\client.mjs";

        return rule.test.test(unixPath) && rule.test.test(windowsPath);
      },
    );

    expect(trpcRule?.type).toBe("javascript/auto");
    const parser = getJavascriptParser(trpcRule);
    expect(parser?.javascript?.exportsPresence).toBe("warn");
  });
});
