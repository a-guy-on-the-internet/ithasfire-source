/**
 * Web shim for react-native/Libraries/Utilities/codegenNativeComponent
 *
 * On native, codegenNativeComponent generates native view components.
 * On web, we return a simple View component since native components don't exist.
 */
import { View } from "react-native-web";

export type NativeComponentType<_Props> = typeof View;

function codegenNativeComponent<Props extends object>(
  _componentName: string,
  _options?: {
    interfaceOnly?: boolean;
    paperComponentName?: string;
    paperComponentNameDeprecated?: string;
    excludedPlatforms?: Array<"iOS" | "android">;
  },
): NativeComponentType<Props> {
  // On web, all "native" components are just Views
  return View as unknown as NativeComponentType<Props>;
}

export default codegenNativeComponent;
