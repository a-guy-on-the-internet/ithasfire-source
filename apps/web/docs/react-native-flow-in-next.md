# React Native Flow files in Next.js (web)

Ithas Fire’s web app imports some React Native packages (via `react-native-web`).
React Native itself still ships a number of **Flow**-typed source files.

## Why we need a custom Babel step

Some RN files are Flow, but also include **TypeScript-style** assertions like:

- `require('./AnimatedExports') as $FlowFixMe`

That’s valid JavaScript _syntax_ only once transformed. In Next builds it can break parsing/bundling unless we explicitly strip those assertions.

In `apps/web/next.config.ts` we run `babel-loader` over `react-native/**` with:

- `@babel/preset-flow` (strip Flow types)
- `@babel/plugin-transform-typescript` (strip TS-style `as` assertions)

Note: `@babel/plugin-syntax-typescript` is included so Babel can parse TS syntax, but it does **not** transform/strip anything on its own.

## Regression test

We keep a simple regression test to ensure the transform keeps working:

- `apps/web/src/__tests__/rn-flow-transform.test.ts`

It reads `react-native/Libraries/Animated/Animated.js`, runs the same presets/plugins, and asserts the output no longer contains `as $FlowFixMe`.

## If this breaks again

Usually this happens after upgrading `react-native`.

Things to check:

1. The RN file changed and now uses a different assertion pattern.
2. Our loader rules are no longer matching the file extension (`.js` vs `.mjs`).
3. Turbopack rules drifted from Webpack rules.
