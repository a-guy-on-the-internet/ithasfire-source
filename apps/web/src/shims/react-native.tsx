import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as ReactNativeWeb from "react-native-web";

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

// Re-export every named symbol from react-native-web **except** `default`.
// `export * from "react-native-web"` breaks in Vite's ESM dev server because
// react-native-web uses `export =` (CJS), which Vite wraps with a synthetic
// `default` binding that ESM `export *` cannot forward — causing:
//   "Importing binding name 'default' cannot be resolved by star export entries."
// Spreading the namespace object into a `const` then re-exporting avoids the
// issue while keeping every named export available.
const { default: _rnwDefault, ...rnwNamedExports } = ReactNativeWeb as any;
export const {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  AppRegistry,
  AppState,
  Appearance,
  BackHandler,
  Button,
  CheckBox,
  Clipboard,
  DeviceEventEmitter,
  Dimensions,
  Easing,
  FlatList,
  I18nManager,
  Image,
  ImageBackground,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Linking,
  LogBox,
  Modal,
  NativeEventEmitter,
  PanResponder,
  Picker,
  PixelRatio,
  Platform,
  Pressable,
  ProgressBar,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  SectionList,
  Share,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Touchable,
  TouchableHighlight,
  TouchableNativeFeedback,
  TouchableOpacity,
  TouchableWithoutFeedback,
  UIManager,
  Vibration,
  View,
  VirtualizedList,
  YellowBox,
  findNodeHandle,
  processColor,
  render,
  unmountComponentAtNode,
  unstable_createElement,
  useColorScheme,
  useLocaleContext,
  useWindowDimensions,
} = rnwNamedExports;
export { DrawerLayoutAndroid, NativeModules, TurboModuleRegistry };

export default ReactNative;
