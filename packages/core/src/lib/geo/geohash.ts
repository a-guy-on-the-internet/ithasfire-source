import ngeohashImport from "ngeohash";

// `ngeohash` is CommonJS. In ESM builds, the runtime binding can be either a
// namespace-like object or available under `.default` depending on the bundler.
// Normalize to the object that has `encode/decode/...`.
const ngeohash: any = (ngeohashImport as any)?.default ?? ngeohashImport;

import { EARTH_RADIUS_METERS, haversineDistance } from "./haversine";

const DEFAULT_PRECISION = 6;
const MIN_PRECISION = 1;
const MAX_PRECISION = 12;
const MIN_LAT = -90;
const MAX_LAT = 90;
const MIN_LNG = -180;
const MAX_LNG = 180;

const KM_TO_METERS = 1_000;

const toRadians = (value: number): number => (value * Math.PI) / 180;
const toDegrees = (value: number): number => (value * 180) / Math.PI;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const normalizeLongitude = (value: number): number => {
  if (value >= MIN_LNG && value <= MAX_LNG) {
    return value;
  }

  const normalized = ((((value + 180) % 360) + 360) % 360) - 180;

  return normalized;
};

const assertLatitude = (lat: number): void => {
  if (!Number.isFinite(lat) || lat < MIN_LAT || lat > MAX_LAT) {
    throw new RangeError(
      `Latitude must be between ${MIN_LAT} and ${MAX_LAT}. Received: ${lat}`,
    );
  }
};

const assertLongitude = (lng: number): void => {
  if (!Number.isFinite(lng) || lng < MIN_LNG || lng > MAX_LNG) {
    throw new RangeError(
      `Longitude must be between ${MIN_LNG} and ${MAX_LNG}. Received: ${lng}`,
    );
  }
};

const assertPrecision = (precision: number): void => {
  if (
    !Number.isInteger(precision) ||
    precision < MIN_PRECISION ||
    precision > MAX_PRECISION
  ) {
    throw new RangeError(
      `Precision must be an integer between ${MIN_PRECISION} and ${MAX_PRECISION}. Received: ${precision}`,
    );
  }
};

export function encodeGeohash(
  lat: number,
  lng: number,
  precision: number = DEFAULT_PRECISION,
): string {
  assertLatitude(lat);
  assertLongitude(lng);
  assertPrecision(precision);

  return ngeohash.encode(lat, lng, precision);
}

export type DecodedGeohash = {
  lat: number;
  lng: number;
  errorMeters: number;
};

export function decodeGeohash(hash: string): DecodedGeohash {
  if (
    typeof hash !== "string" ||
    hash.length < MIN_PRECISION ||
    hash.length > MAX_PRECISION
  ) {
    throw new TypeError(
      `Geohash must be a string between ${MIN_PRECISION} and ${MAX_PRECISION} characters.`,
    );
  }

  const { latitude, longitude } = ngeohash.decode(hash);
  const [minLat, minLng, maxLat, maxLng] = ngeohash.decode_bbox(hash);

  const centerLat = latitude;
  const centerLng = longitude;

  const corners = [
    { lat: minLat, lng: minLng },
    { lat: minLat, lng: maxLng },
    { lat: maxLat, lng: minLng },
    { lat: maxLat, lng: maxLng },
  ];

  const errorMeters = corners.reduce((maxError, corner) => {
    const distance = haversineDistance(
      centerLat,
      centerLng,
      corner.lat,
      corner.lng,
    );
    return Math.max(maxError, distance);
  }, 0);

  return { lat: centerLat, lng: centerLng, errorMeters };
}

export function geohashNeighbors(hash: string): string[] {
  if (
    typeof hash !== "string" ||
    hash.length < MIN_PRECISION ||
    hash.length > MAX_PRECISION
  ) {
    throw new TypeError(
      `Geohash must be a string between ${MIN_PRECISION} and ${MAX_PRECISION} characters.`,
    );
  }

  return ngeohash.neighbors(hash);
}

export type BoundingBox = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

export function bboxForRadius(
  lat: number,
  lng: number,
  radiusKm: number,
): BoundingBox {
  assertLatitude(lat);
  assertLongitude(lng);

  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new RangeError(
      `radiusKm must be a positive number. Received: ${radiusKm}`,
    );
  }

  const radiusMeters = radiusKm * KM_TO_METERS;
  const latRadians = toRadians(lat);
  const deltaLatRadians = radiusMeters / EARTH_RADIUS_METERS;

  const cosLat = Math.cos(latRadians);
  const deltaLngRadians =
    cosLat === 0
      ? Math.PI
      : radiusMeters / (EARTH_RADIUS_METERS * Math.max(cosLat, 1e-12));

  const deltaLatDegrees = toDegrees(deltaLatRadians);
  const deltaLngDegrees = toDegrees(deltaLngRadians);

  const minLat = clamp(lat - deltaLatDegrees, MIN_LAT, MAX_LAT);
  const maxLat = clamp(lat + deltaLatDegrees, MIN_LAT, MAX_LAT);

  if (deltaLngDegrees >= 180) {
    return {
      minLat,
      maxLat,
      minLng: MIN_LNG,
      maxLng: MAX_LNG,
    };
  }

  let minLng = normalizeLongitude(lng - deltaLngDegrees);
  let maxLng = normalizeLongitude(lng + deltaLngDegrees);

  if (minLng > maxLng) {
    // The bounding box crosses the anti-meridian; returning the full longitudinal range keeps callers simple.
    minLng = MIN_LNG;
    maxLng = MAX_LNG;
  }

  return {
    minLat,
    minLng,
    maxLat,
    maxLng,
  };
}
