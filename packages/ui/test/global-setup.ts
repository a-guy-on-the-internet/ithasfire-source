import "./act-environment";

export default function setupActEnvironment(): void {
  if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  }
}
