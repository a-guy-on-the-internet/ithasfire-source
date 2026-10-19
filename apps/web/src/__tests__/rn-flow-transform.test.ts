import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { transformAsync } from "@babel/core";

/**
 * Regression guard:
 * React Native ships some Flow files that also contain TS-style assertions, e.g.
 * `require('./AnimatedExports') as $FlowFixMe`.
 *
 * Our Next.js config uses a custom babel-loader + `@babel/plugin-transform-typescript`
 * to strip those assertions.
 */
describe("react-native Flow transform", () => {
  it("strips TS-style `as $FlowFixMe` assertions from react-native Animated.js", async () => {
    const sourcePath =
      require.resolve("react-native/Libraries/Animated/Animated.js");
    const source = await readFile(sourcePath, "utf8");

    const result = await transformAsync(source, {
      babelrc: false,
      configFile: false,
      filename: sourcePath,
      presets: [
        require.resolve("@babel/preset-flow"),
        [require.resolve("@babel/preset-react"), { runtime: "automatic" }],
      ],
      plugins: [
        require.resolve("@babel/plugin-syntax-typescript"),
        require.resolve("@babel/plugin-transform-typescript"),
      ],
    });

    expect(result?.code).toBeTruthy();
    expect(result!.code).not.toContain("as $FlowFixMe");
  });
});
