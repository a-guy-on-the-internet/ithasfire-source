import { createElement } from "react";

/**
 * `expo-camera` for the screen tests.
 *
 * `CameraView` publishes its CURRENT props to {@link camera}, which is how the
 * harness's `scan(code)` fires a barcode: through whatever `onBarcodeScanned`
 * the screen passed on its latest render. The screen withholds that callback
 * while a verdict is up (NFR-003), so `camera.onBarcodeScanned === undefined`
 * is exactly "the camera is paused" and a scan the operator could not make in
 * real life cannot be made here either.
 */
type CameraProps = {
  active?: boolean;
  enableTorch?: boolean;
  onBarcodeScanned?: (scan: { data: string; type?: string }) => void;
};

export const camera: {
  mounted: boolean;
  active: boolean;
  onBarcodeScanned: CameraProps["onBarcodeScanned"];
} = { mounted: false, active: false, onBarcodeScanned: undefined };

export const resetCamera = (): void => {
  camera.mounted = false;
  camera.active = false;
  camera.onBarcodeScanned = undefined;
};

export const CameraView = (props: CameraProps & { style?: unknown }) => {
  camera.mounted = true;
  camera.active = props.active ?? true;
  camera.onBarcodeScanned = props.onBarcodeScanned;
  return createElement("div", {
    "data-testid": "camera-view",
    "data-active": String(props.active ?? true),
  });
};

const GRANTED = {
  granted: true,
  canAskAgain: true,
  status: "granted",
  expires: "never",
} as const;

export const useCameraPermissions = () =>
  [GRANTED, async () => GRANTED] as const;
