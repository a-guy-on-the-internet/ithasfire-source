import {
  forwardRef,
  Fragment,
  type ComponentType,
  type PropsWithChildren,
} from "react";

type GestureHandlerProps = PropsWithChildren<Record<string, any>>;

type MutableRef<T> = { current: T | null };

type HandlerState =
  | "UNDETERMINED"
  | "FAILED"
  | "BEGAN"
  | "CANCELLED"
  | "ACTIVE"
  | "END";

type HandlerStatesMap = Record<HandlerState, number>;

type Direction = "RIGHT" | "LEFT" | "UP" | "DOWN";

type DirectionsMap = Record<Direction, number>;

const STATES: HandlerStatesMap = {
  UNDETERMINED: 0,
  FAILED: 1,
  BEGAN: 2,
  CANCELLED: 3,
  ACTIVE: 4,
  END: 5,
};

const DIRECTIONS: DirectionsMap = {
  RIGHT: 1,
  LEFT: 2,
  UP: 4,
  DOWN: 8,
};

const noop = () => undefined;

const createStubComponent = (displayName: string) => {
  const Component = forwardRef<HTMLDivElement, GestureHandlerProps>(
    ({ children, ...rest }, ref) => (
      <div data-gesture-handler={displayName} ref={ref} {...rest}>
        {children}
      </div>
    ),
  );

  Component.displayName = displayName;

  return Component;
};

const createStubGesture = (displayName: string) => {
  const Handler = createStubComponent(displayName);

  return Object.assign(Handler, {
    displayName,
    State: STATES,
  });
};

const SimpleWrapper = ({ children }: GestureHandlerProps) => <>{children}</>;

type GestureCallback = (event: Record<string, unknown>) => void;

interface GestureBuilder {
  enabled: (value: boolean) => GestureBuilder;
  maxPointers: (_count: number) => GestureBuilder;
  activeOffsetX: (_range: number | number[]) => GestureBuilder;
  onBegin: (_cb: GestureCallback) => GestureBuilder;
  onUpdate: (_cb: GestureCallback) => GestureBuilder;
  onEnd: (_cb: GestureCallback) => GestureBuilder;
}

const createGestureBuilder = (): GestureBuilder => {
  const builder: GestureBuilder = {
    enabled: () => builder,
    maxPointers: () => builder,
    activeOffsetX: () => builder,
    onBegin: () => builder,
    onUpdate: () => builder,
    onEnd: () => builder,
  };

  return builder;
};

export const Gesture = {
  Pan: () => createGestureBuilder(),
};

export const GestureHandlerRootView = createStubComponent(
  "GestureHandlerRootView",
);

export const GestureDetector = SimpleWrapper;

export const PanGestureHandler = createStubGesture("PanGestureHandler");
export const TapGestureHandler = createStubGesture("TapGestureHandler");
export const FlingGestureHandler = createStubGesture("FlingGestureHandler");
export const LongPressGestureHandler = createStubGesture(
  "LongPressGestureHandler",
);
export const PinchGestureHandler = createStubGesture("PinchGestureHandler");
export const RotationGestureHandler = createStubGesture(
  "RotationGestureHandler",
);
export const ForceTouchGestureHandler = createStubGesture(
  "ForceTouchGestureHandler",
);
export const NativeViewGestureHandler = createStubGesture(
  "NativeViewGestureHandler",
);
export const ManualGestureHandler = createStubGesture("ManualGestureHandler");
export const Directions = DIRECTIONS;
export const State = STATES;

export const BaseButton = createStubComponent("BaseButton");
export const RectButton = createStubComponent("RectButton");
export const BorderlessButton = createStubComponent("BorderlessButton");

export const Swipeable = createStubComponent("Swipeable");
export const DrawerLayout = createStubComponent("DrawerLayout");

export const gestureHandlerRootHOC = <P,>(
  Component: ComponentType<P>,
): ComponentType<P> => Component;

export const createNativeWrapper = <P,>(
  Component: ComponentType<P>,
): ComponentType<P> => Component;

export const useGestureHandlerRef = <T,>(_ref?: MutableRef<T>) => ({
  current: null,
});

export const attachGestureHandler = noop;
export const updateGestureHandler = noop;
export const flushQueuedOperations = noop;
export const closeAllOpenInstances = noop;

export const TouchEventType = {
  UNDETERMINED: 0,
  DOWN: 1,
  MOVE: 2,
  UP: 3,
  CANCELLED: 4,
} as const;

export const configureNext = noop;
export const setGestureState = (_handlerTag: number, _newState: number) =>
  undefined;
export const getGestureState = (_handlerTag: number) => STATES.UNDETERMINED;

export const GestureRescuer = ({ children }: GestureHandlerProps) => (
  <Fragment>{children}</Fragment>
);

const stub = {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
  PanGestureHandler,
  TapGestureHandler,
  FlingGestureHandler,
  LongPressGestureHandler,
  PinchGestureHandler,
  RotationGestureHandler,
  ForceTouchGestureHandler,
  NativeViewGestureHandler,
  ManualGestureHandler,
  Directions,
  State,
  BaseButton,
  RectButton,
  BorderlessButton,
  Swipeable,
  DrawerLayout,
  gestureHandlerRootHOC,
  createNativeWrapper,
  useGestureHandlerRef,
  attachGestureHandler,
  updateGestureHandler,
  flushQueuedOperations,
  closeAllOpenInstances,
  TouchEventType,
  configureNext,
  setGestureState,
  getGestureState,
  GestureRescuer,
};

export default stub;
