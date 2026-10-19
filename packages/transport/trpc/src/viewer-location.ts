import { encodeGeohash } from "@th/core";
import { isIP } from "node:net";
import { CLIENT_IP_HEADER_PRECEDENCE } from "./client-ip";
import type { HeadersLike } from "./context";

export type ViewerLocationSource =
  | "vercel"
  | "cloudflare"
  | "cloudfront"
  | "fastly"
  | "akamai"
  | "gcp"
  | "generic";

export type ViewerLocation = {
  source: ViewerLocationSource;
  ip: string | null;
  city: string | null;
  regionCode: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;
  postalCode: string | null;
  timezone: string | null;
  accuracyRadiusKm: number | null;
};

type HeaderCandidate = HeadersLike | Record<string, unknown> | null | undefined;
type NormalizedHeaders = Record<string, string>;

type FieldPick = {
  value: string | null;
  header: string | null;
};

type NumericFieldPick = {
  value: number | null;
  header: string | null;
};

const CITY_HEADERS = [
  "x-vercel-ip-city",
  "cloudfront-viewer-city",
  "cf-ipcity",
  "x-geo-city",
  "x-appengine-city",
];

const REGION_HEADERS = [
  "x-vercel-ip-country-region",
  "cloudfront-viewer-country-region",
  "cf-region",
  "cf-region-code",
  "x-geo-region",
  "x-appengine-region",
];

const COUNTRY_HEADERS = [
  "x-vercel-ip-country",
  "cloudfront-viewer-country",
  "cf-ipcountry",
  "x-geo-country",
  "x-appengine-country",
];

const TIMEZONE_HEADERS = [
  "x-vercel-ip-timezone",
  "cloudfront-viewer-time-zone",
  "x-geo-timezone",
];

const POSTAL_HEADERS = ["cloudfront-viewer-postal-code", "x-geo-postal-code"];

const LATITUDE_HEADERS = [
  "x-vercel-ip-latitude",
  "cloudfront-viewer-latitude",
  "cf-iplatitude",
  "x-geo-latitude",
];

const LONGITUDE_HEADERS = [
  "x-vercel-ip-longitude",
  "cloudfront-viewer-longitude",
  "cf-iplongitude",
  "x-geo-longitude",
];

const APP_ENGINE_LAT_LNG_HEADER = "x-appengine-citylatlong";

// The client-IP precedence shared with context.ts's rate-limit resolver
// (`resolveClientIp`) so the two can't drift — see client-ip.ts. This geo list
// is a SUPERSET: it appends extra CDN/source-labelling headers used only to
// infer `ViewerLocationSource`, and resolution runs through the isIP-validated
// `pickIpField` (source-labelling on top). The rate limiter deliberately keeps
// the strict 4-header precedence with no isIP gate.
const IP_HEADERS = [
  ...CLIENT_IP_HEADER_PRECEDENCE,
  "x-client-ip",
  "fastly-client-ip",
  "x-cluster-client-ip",
  "forwarded",
  "fly-client-ip",
  "x-appengine-user-ip",
];

const ACCURACY_METERS_HEADERS = ["cf-accuracy-meters"];
const ACCURACY_KM_HEADERS = ["x-geo-accuracy-km"];

const HEADER_SOURCE_MAP: Record<string, ViewerLocationSource> = {
  "x-vercel-ip-city": "vercel",
  "x-vercel-ip-country": "vercel",
  "x-vercel-ip-country-region": "vercel",
  "x-vercel-ip-latitude": "vercel",
  "x-vercel-ip-longitude": "vercel",
  "x-vercel-ip-timezone": "vercel",
  "cloudfront-viewer-city": "cloudfront",
  "cloudfront-viewer-country": "cloudfront",
  "cloudfront-viewer-country-region": "cloudfront",
  "cloudfront-viewer-latitude": "cloudfront",
  "cloudfront-viewer-longitude": "cloudfront",
  "cloudfront-viewer-postal-code": "cloudfront",
  "cloudfront-viewer-time-zone": "cloudfront",
  "cf-ipcity": "cloudflare",
  "cf-ipcountry": "cloudflare",
  "cf-iplatitude": "cloudflare",
  "cf-iplongitude": "cloudflare",
  "cf-region": "cloudflare",
  "cf-region-code": "cloudflare",
  "cf-accuracy-meters": "cloudflare",
  "cf-connecting-ip": "cloudflare",
  "fastly-client-ip": "fastly",
  "x-geo-city": "generic",
  "x-geo-country": "generic",
  "x-geo-region": "generic",
  "x-geo-latitude": "generic",
  "x-geo-longitude": "generic",
  "x-geo-postal-code": "generic",
  "x-geo-timezone": "generic",
  "x-geo-accuracy-km": "generic",
  "x-appengine-city": "gcp",
  "x-appengine-country": "gcp",
  "x-appengine-region": "gcp",
  "x-appengine-citylatlong": "gcp",
  "x-appengine-user-ip": "gcp",
};

const sanitizeHeaderValue = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const normalized = sanitizeHeaderValue(candidate);
      if (normalized) return normalized;
    }
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;
  return trimmed;
};

const normalizeHeaders = (headers: HeaderCandidate): NormalizedHeaders => {
  const normalized: NormalizedHeaders = {};
  if (!headers || typeof headers !== "object") return normalized;
  for (const [key, rawValue] of Object.entries(headers)) {
    const value = sanitizeHeaderValue(rawValue);
    if (!value) continue;
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
};

const pickStringField = (
  headers: NormalizedHeaders,
  headerNames: string[],
): FieldPick => {
  for (const name of headerNames) {
    const key = name.toLowerCase();
    const value = headers[key];
    if (value) {
      return { value, header: key };
    }
  }
  return { value: null, header: null };
};

const parseNumber = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const parseLatitude = (value: string | null): number | null => {
  const parsed = parseNumber(value);
  if (parsed === null || parsed < -90 || parsed > 90) return null;
  return parsed;
};

const parseLongitude = (value: string | null): number | null => {
  const parsed = parseNumber(value);
  if (parsed === null || parsed < -180 || parsed > 180) return null;
  return parsed;
};

const parseAccuracyMeters = (value: string | null): number | null => {
  const meters = parseNumber(value);
  if (meters === null) return null;
  return meters / 1000;
};

const parseAccuracyKilometers = (value: string | null): number | null => {
  const kilometers = parseNumber(value);
  if (kilometers === null) return null;
  return kilometers;
};

const pickNumericField = (
  headers: NormalizedHeaders,
  headerNames: string[],
  parser: (value: string | null) => number | null,
): NumericFieldPick => {
  for (const name of headerNames) {
    const key = name.toLowerCase();
    const raw = headers[key] ?? null;
    const parsed = parser(raw);
    if (parsed !== null) {
      return { value: parsed, header: key };
    }
  }
  return { value: null, header: null };
};

const parseIpCandidate = (raw: string | null): string | null => {
  if (!raw) return null;
  const firstSegment = raw.split(",")[0]?.trim();
  if (!firstSegment) return null;
  if (isIP(firstSegment)) return firstSegment;
  if (firstSegment.startsWith("[") && firstSegment.includes("]")) {
    const inside = firstSegment.slice(1, firstSegment.indexOf("]"));
    if (isIP(inside)) return inside;
  }
  if (firstSegment.includes(":") && firstSegment.includes(".")) {
    const maybeIpv4 = firstSegment.slice(0, firstSegment.lastIndexOf(":"));
    if (isIP(maybeIpv4)) return maybeIpv4;
  }
  return null;
};

const pickIpField = (headers: NormalizedHeaders): FieldPick => {
  for (const name of IP_HEADERS) {
    const key = name.toLowerCase();
    const raw = headers[key] ?? null;
    const parsed = parseIpCandidate(raw ?? null);
    if (parsed) {
      return { value: parsed, header: key };
    }
  }
  return { value: null, header: null };
};

const parseLatLngPair = (
  value: string | null,
): { lat: number | null; lng: number | null } => {
  if (!value) return { lat: null, lng: null };
  const sanitized = value.replace(/[()]/g, "");
  const [latRaw, lngRaw] = sanitized.split(/[,\s]/).filter(Boolean);
  return {
    lat: parseLatitude(latRaw ?? null),
    lng: parseLongitude(lngRaw ?? null),
  };
};

const computeGeohash = (
  lat: number | null,
  lng: number | null,
): string | null => {
  if (lat === null || lng === null) return null;
  try {
    return encodeGeohash(lat, lng, 6);
  } catch {
    return null;
  }
};

const resolveSource = (headers: Set<string>): ViewerLocationSource => {
  for (const header of headers) {
    const source = HEADER_SOURCE_MAP[header];
    if (source) return source;
  }
  return "generic";
};

const addSourceHint = (
  headers: Set<string>,
  headerName: string | null,
): void => {
  if (!headerName) return;
  headers.add(headerName);
};

export const extractViewerLocation = (
  headersInput: HeaderCandidate,
): ViewerLocation | null => {
  const headers = normalizeHeaders(headersInput);
  if (!Object.keys(headers).length) return null;

  const sourceHints = new Set<string>();

  const { value: ip, header: ipHeader } = pickIpField(headers);
  addSourceHint(sourceHints, ipHeader);

  const { value: city, header: cityHeader } = pickStringField(
    headers,
    CITY_HEADERS,
  );
  addSourceHint(sourceHints, cityHeader);

  const { value: regionCode, header: regionHeader } = pickStringField(
    headers,
    REGION_HEADERS,
  );
  addSourceHint(sourceHints, regionHeader);

  const { value: countryCode, header: countryHeader } = pickStringField(
    headers,
    COUNTRY_HEADERS,
  );
  addSourceHint(sourceHints, countryHeader);

  const { value: timezone, header: timezoneHeader } = pickStringField(
    headers,
    TIMEZONE_HEADERS,
  );
  addSourceHint(sourceHints, timezoneHeader);

  const { value: postalCode, header: postalHeader } = pickStringField(
    headers,
    POSTAL_HEADERS,
  );
  addSourceHint(sourceHints, postalHeader);

  const appEngineLatLng = parseLatLngPair(
    headers[APP_ENGINE_LAT_LNG_HEADER] ?? null,
  );
  if (appEngineLatLng.lat !== null || appEngineLatLng.lng !== null) {
    addSourceHint(sourceHints, APP_ENGINE_LAT_LNG_HEADER);
  }

  const { value: latitudeCandidate, header: latitudeHeader } = pickStringField(
    headers,
    LATITUDE_HEADERS,
  );
  const { value: longitudeCandidate, header: longitudeHeader } =
    pickStringField(headers, LONGITUDE_HEADERS);

  let latitude = parseLatitude(latitudeCandidate);
  let longitude = parseLongitude(longitudeCandidate);
  let latitudeSourceHeader = latitudeHeader;
  let longitudeSourceHeader = longitudeHeader;

  if (latitude === null && appEngineLatLng.lat !== null) {
    latitude = appEngineLatLng.lat;
    latitudeSourceHeader = APP_ENGINE_LAT_LNG_HEADER;
  }

  if (longitude === null && appEngineLatLng.lng !== null) {
    longitude = appEngineLatLng.lng;
    longitudeSourceHeader = APP_ENGINE_LAT_LNG_HEADER;
  }

  addSourceHint(sourceHints, latitudeSourceHeader);
  addSourceHint(sourceHints, longitudeSourceHeader);

  const { value: accuracyFromMeters, header: accuracyMetersHeader } =
    pickNumericField(headers, ACCURACY_METERS_HEADERS, parseAccuracyMeters);
  addSourceHint(sourceHints, accuracyMetersHeader);

  const { value: accuracyFromKm, header: accuracyKmHeader } = pickNumericField(
    headers,
    ACCURACY_KM_HEADERS,
    parseAccuracyKilometers,
  );
  addSourceHint(sourceHints, accuracyKmHeader);

  const accuracyRadiusKm = accuracyFromMeters ?? accuracyFromKm ?? null;

  const hasAnyValue = [
    ip,
    city,
    regionCode,
    countryCode,
    latitude,
    longitude,
    postalCode,
    timezone,
  ].some((value) => value !== null);

  if (!hasAnyValue) return null;

  const source = resolveSource(sourceHints);
  const geohash = computeGeohash(latitude, longitude);

  return {
    source,
    ip,
    city,
    regionCode,
    countryCode,
    latitude,
    longitude,
    geohash,
    postalCode,
    timezone,
    accuracyRadiusKm,
  };
};
