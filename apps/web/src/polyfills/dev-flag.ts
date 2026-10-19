const globalObject = globalThis as typeof globalThis & { __DEV__?: boolean };

if (typeof globalObject.__DEV__ === "undefined") {
  globalObject.__DEV__ = process.env.NODE_ENV !== "production";
}
