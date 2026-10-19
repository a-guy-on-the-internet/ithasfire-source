type ReactNativeRenderer = {
  findHostInstance_DEPRECATED: (...args: unknown[]) => null;
  findNodeHandle: (...args: unknown[]) => null;
  isChildPublicInstance: (...args: unknown[]) => boolean;
  dispatchCommand: (...args: unknown[]) => void;
  sendAccessibilityEvent: (...args: unknown[]) => void;
  render: (...args: unknown[]) => null;
  unmountComponentAtNode: (...args: unknown[]) => void;
  unmountComponentAtNodeAndRemoveContainer: (...args: unknown[]) => void;
  unstable_batchedUpdates: <T>(fn: (arg: T) => void, bookkeeping: T) => void;
};

const noop = () => {};
const returnNull = () => null;

const ReactNativeRenderer: ReactNativeRenderer = {
  findHostInstance_DEPRECATED: returnNull,
  findNodeHandle: returnNull,
  isChildPublicInstance: () => false,
  dispatchCommand: noop,
  sendAccessibilityEvent: noop,
  render: returnNull,
  unmountComponentAtNode: noop,
  unmountComponentAtNodeAndRemoveContainer: noop,
  unstable_batchedUpdates: (fn, bookkeeping) => {
    fn(bookkeeping);
  },
};

export default ReactNativeRenderer;
