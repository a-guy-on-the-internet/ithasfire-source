export type LatLngLiteral = {
  lat: number;
  lng: number;
};

const normalizeEnv = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

export const tileServerUrl = normalizeEnv(
  process.env.NEXT_PUBLIC_TILESERVER_URL,
);

export const isMapEnabled = Boolean(tileServerUrl);

/** @deprecated Use isMapEnabled — kept for backward compatibility during migration. */
export const isGoogleMapsEnabled = isMapEnabled;

export const mapStyleLight = tileServerUrl
  ? `${tileServerUrl}/styles/streets/style.json`
  : "";

export const mapStyleDark = tileServerUrl
  ? `${tileServerUrl}/styles/streets-dark/style.json`
  : "";

export const usCentroid: LatLngLiteral = { lat: 39.8283, lng: -98.5795 };
export const defaultMapZoom = 3;
export const detailMapZoom = 14;
export const coordinatesPickerZoom = 15;
