// @vitest-environment node
import { describe, expect, it } from "vitest";

// These imports target our Storybook mock modules directly.
// We can't import the upstream RN deep paths inside Vitest because those files
// contain Flow syntax that Rollup/Vite won't parse.
//
// If any of these stop exporting what gesture-handler expects, we want a fast
// unit-test failure instead of a broken Storybook build.

describe("Storybook React Native shims", () => {
  it("react-native exports TurboModuleRegistry", async () => {
    const rn = await import("../../../.storybook/mocks/react-native");
    expect(rn).toHaveProperty("TurboModuleRegistry");
    expect(rn.TurboModuleRegistry).toHaveProperty("get");
    expect(rn.TurboModuleRegistry).toHaveProperty("getEnforcing");
  });

  it("react-native exports DrawerLayoutAndroid", async () => {
    const rn = await import("../../../.storybook/mocks/react-native");
    expect(rn).toHaveProperty("DrawerLayoutAndroid");
  });

  it("ReactNativeViewConfigRegistry exports expected event maps", async () => {
    const mod =
      await import("../../../.storybook/mocks/react-native-libraries/Renderer/shims/ReactNativeViewConfigRegistry");
    expect(mod).toHaveProperty("customDirectEventTypes");
    expect(mod).toHaveProperty("customBubblingEventTypes");
    expect(mod).toHaveProperty("register");
    expect(mod).toHaveProperty("get");
  });

  it("ReactNative renderer shim has a default export", async () => {
    const mod =
      await import("../../../.storybook/mocks/react-native-libraries/Renderer/shims/ReactNative");
    expect(mod).toHaveProperty("default");
    expect(typeof mod.default).toBe("object");
  });

  it("codegenNativeComponent has a default export", async () => {
    const mod =
      await import("../../../.storybook/mocks/react-native-libraries/Utilities/codegenNativeComponent");
    expect(mod).toHaveProperty("default");
    expect(typeof mod.default).toBe("function");
  });

  it("PressabilityDebug exports PressabilityDebugView", async () => {
    const mod =
      await import("../../../.storybook/mocks/react-native-libraries/Pressability/PressabilityDebug");
    expect(mod).toHaveProperty("PressabilityDebugView");
  });
});
