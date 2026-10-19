import { forwardRef, type ComponentPropsWithoutRef } from "react";
import ReactNativeWeb from "react-native-web";

const noop = () => undefined;

const BaseView: any = (ReactNativeWeb as any).View ?? "div";

const DrawerLayoutAndroid = forwardRef<any, ComponentPropsWithoutRef<any>>(
  (props, ref) => <BaseView ref={ref} {...props} />,
);

DrawerLayoutAndroid.displayName = "DrawerLayoutAndroid";

const TurboModuleRegistry = {
  get: (_name: string) => undefined,
  getEnforcing: (_name: string) => ({}),
  addListener: noop,
  removeListeners: noop,
};

const NativeModules: Record<string, unknown> = {
  ...((ReactNativeWeb as any).NativeModules ?? {}),
  RNGestureHandlerModule: {},
  ReanimatedModule: {},
};

const ReactNative = {
  ...ReactNativeWeb,
  DrawerLayoutAndroid,
  TurboModuleRegistry,
  NativeModules,
};

// Re-export commonly used symbols where possible. We intentionally avoid `export *` because
// the ambient declaration for `react-native-web` uses `export =` which breaks `export *`.
export { DrawerLayoutAndroid, NativeModules, TurboModuleRegistry };
export { default as ReactNativeWeb } from "react-native-web";

export default ReactNative;
