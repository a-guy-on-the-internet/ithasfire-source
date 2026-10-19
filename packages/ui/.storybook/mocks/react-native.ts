import {
  createElement,
  forwardRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import * as ReactNativeWeb from "react-native-web";

export * from "react-native-web";

const stubbedTurboModule = new Proxy(
  {},
  {
    get: () => () => undefined,
  },
);

export const TurboModuleRegistry = {
  get: () => stubbedTurboModule,
  getEnforcing: () => stubbedTurboModule,
};

type DrawerLayoutProps = ComponentProps<typeof ReactNativeWeb.View> & {
  renderNavigationView?: () => ReactNode;
  drawerPosition?: "left" | "right";
  drawerWidth?: number;
  drawerLockMode?: "unlocked" | "locked-closed" | "locked-open";
};

export const DrawerLayoutAndroid = forwardRef<unknown, DrawerLayoutProps>(
  ({ renderNavigationView, children, ...rest }, ref) =>
    createElement(
      ReactNativeWeb.View,
      { ...rest, ref },
      renderNavigationView
        ? createElement(
            ReactNativeWeb.View,
            { key: "drawer-navigation" },
            renderNavigationView(),
          )
        : null,
      children,
    ),
);

export default ReactNativeWeb;
