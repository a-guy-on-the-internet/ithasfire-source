"use client";

import { useState, useCallback } from "react";
import { useTheme } from "tamagui";
import { Spinner } from "@th/ui";
import { Navigation, MapPin, Clock } from "lucide-react";

import { trpc } from "@/trpc";
import { useUserLocation } from "@/hooks/user-location/useUserLocation";
import { useImperial, KM_TO_MI } from "@/hooks/useImperial";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TravelTimeWidgetProps = {
  /** Destination (event venue) coordinates. */
  destinationLat: number;
  destinationLng: number;
  /** Whether to use mobile sizing. */
  mobile?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatDistance(meters: number, imperial: boolean): string {
  const km = meters / 1_000;
  if (imperial) {
    const miles = km * KM_TO_MI;
    return miles < 0.1 ? "< 0.1 mi" : `${miles.toFixed(1)} mi`;
  }
  return km < 0.1 ? "< 0.1 km" : `${km.toFixed(1)} km`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function TravelTimeWidget({
  destinationLat,
  destinationLng,
  mobile = false,
}: TravelTimeWidgetProps) {
  const theme = useTheme();
  const [imperial] = useImperial();
  const {
    coords,
    loading: geoLoading,
    request: requestLocation,
    error: geoError,
  } = useUserLocation();
  const [hasRequested, setHasRequested] = useState(false);

  // Only enabled once we have user coords
  const travelQuery = trpc.routing.getTravelTime.useQuery(
    {
      origin: { lat: coords?.lat ?? 0, lng: coords?.lng ?? 0 },
      destination: { lat: destinationLat, lng: destinationLng },
      mode: "auto",
    },
    {
      enabled: coords != null,
      staleTime: 5 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  const handleGetTravelTime = useCallback(() => {
    setHasRequested(true);
    requestLocation();
  }, [requestLocation]);

  const isLoading = geoLoading || (coords != null && travelQuery.isLoading);
  const result = travelQuery.data;
  const showResult = result?.available && result.timeSeconds != null;
  const permissionDenied = geoError?.code === 1; // PERMISSION_DENIED

  // ── Not yet requested ──────────────────────────────────────────────────
  if (!hasRequested) {
    return (
      <button
        type="button"
        className="travel-time-btn"
        onClick={handleGetTravelTime}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 14px",
          borderRadius: 0,
          fontSize: 13,
          fontWeight: 500,
          color: theme.color?.val ?? "#211C16",
          background:
            "color-mix(in srgb, var(--foreground, #211C16) 6%, transparent)",
          border:
            "2px solid color-mix(in srgb, var(--foreground, #211C16) 10%, transparent)",
          transition: "background 0.15s",
          width: "100%",
          justifyContent: "center",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background =
            "color-mix(in srgb, var(--foreground, #211C16) 12%, transparent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background =
            "color-mix(in srgb, var(--foreground, #211C16) 6%, transparent)";
        }}
        onFocus={(e) => {
          e.currentTarget.style.background =
            "color-mix(in srgb, var(--foreground, #211C16) 12%, transparent)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.background =
            "color-mix(in srgb, var(--foreground, #211C16) 6%, transparent)";
        }}
      >
        <Navigation size={14} aria-hidden="true" />
        <span>Get travel time</span>
      </button>
    );
  }

  // ── Loading state ──────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "10px 14px",
          borderRadius: 0,
          fontSize: 13,
          color: theme.colorMuted?.val ?? "#5C544A",
          background:
            "color-mix(in srgb, var(--foreground, #211C16) 4%, transparent)",
        }}
      >
        <Spinner
          width={14}
          height={14}
          borderWidth={2}
          indicatorColor={theme.colorMuted?.val ?? "#5C544A"}
        />
        <span>
          {geoLoading ? "Finding your location..." : "Calculating route..."}
        </span>
      </div>
    );
  }

  // ── Permission denied ──────────────────────────────────────────────────
  if (permissionDenied) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 14px",
          borderRadius: 0,
          fontSize: 13,
          color: theme.colorMuted?.val ?? "#5C544A",
          background:
            "color-mix(in srgb, var(--foreground, #211C16) 4%, transparent)",
        }}
      >
        <MapPin size={14} aria-hidden="true" />
        <span>
          Location access denied. Enable it in your browser settings to see
          travel time.
        </span>
      </div>
    );
  }

  // ── Geolocation error (non-permission) ─────────────────────────────────
  if (geoError) {
    return (
      <button
        type="button"
        className="travel-time-btn"
        onClick={handleGetTravelTime}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 14px",
          borderRadius: 0,
          fontSize: 13,
          fontWeight: 500,
          color: theme.colorMuted?.val ?? "#5C544A",
          background:
            "color-mix(in srgb, var(--foreground, #211C16) 4%, transparent)",
          width: "100%",
          justifyContent: "center",
        }}
      >
        <Navigation size={14} aria-hidden="true" />
        <span>Could not get location. Tap to retry.</span>
      </button>
    );
  }

  // ── Route not available (service down / no route found) ────────────────
  if (result && !result.available) {
    return null; // silently hide — don't confuse the user
  }

  // ── Success ────────────────────────────────────────────────────────────
  if (showResult) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px",
          borderRadius: 0,
          fontSize: 13,
          color: theme.color?.val ?? "#211C16",
          background:
            "color-mix(in srgb, var(--foreground, #211C16) 6%, transparent)",
          border:
            "2px solid color-mix(in srgb, var(--foreground, #211C16) 8%, transparent)",
        }}
        data-testid="travel-time-result"
      >
        <Clock
          size={14}
          color={theme.colorMuted?.val ?? "#5C544A"}
          aria-hidden="true"
        />
        <span style={{ fontWeight: 700 }}>
          {formatDuration(result.timeSeconds!)}
        </span>
        {result.distanceMeters != null && (
          <>
            <span style={{ color: theme.colorMuted?.val ?? "#5C544A" }}>·</span>
            <span style={{ color: theme.colorMuted?.val ?? "#5C544A" }}>
              {formatDistance(result.distanceMeters, imperial)}
            </span>
          </>
        )}
        <span style={{ color: theme.colorMuted?.val ?? "#5C544A" }}>by car</span>
      </div>
    );
  }

  return null;
}
