declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
  // eslint-disable-next-line no-var
  var __TH_IS_REACT_ACTING__: (() => boolean) | undefined;
}

globalThis.__TH_IS_REACT_ACTING__ = () =>
  Boolean(globalThis.IS_REACT_ACT_ENVIRONMENT);

export {};
