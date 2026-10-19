declare module "react-native-web" {
  import type * as ReactNativeTypes from "react-native";

  const ReactNativeWeb: typeof ReactNativeTypes;
  export * from "react-native";
  export default ReactNativeWeb;
}
