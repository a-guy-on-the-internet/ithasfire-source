type NativeComponent<Props> = (props: Props) => null;

type NativeComponentOptions = {
  interfaceOnly?: boolean;
  paperComponentName?: string;
  paperComponentNameDeprecated?: string;
  excludedPlatforms?: Array<"iOS" | "android">;
};

const codegenNativeComponent = <Props extends Record<string, unknown>>(
  componentName: string,
  _options?: NativeComponentOptions,
): NativeComponent<Props> => {
  const Component = () => null;
  Object.defineProperty(Component, "name", {
    value: componentName,
    configurable: true,
  });
  return Component;
};

export default codegenNativeComponent;
