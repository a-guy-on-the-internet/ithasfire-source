import { useEffect, useState } from "react";

export type UserCoordinates = {
  lat: number;
  lng: number;
  timestamp?: number;
};

type UseUserLocationOptions = {
  /** If true, browser is asked for position on mount. */
  requestOnMount?: boolean;
};

/**
 * React hook to access browser Geolocation.
 * Defaults to inactive until `request()` or `requestOnMount` is used.
 */
export function useUserLocation({
  requestOnMount = false,
}: UseUserLocationOptions = {}) {
  const [coords, setCoords] = useState<UserCoordinates | null>(null);
  const [error, setError] = useState<GeolocationPositionError | null>(null);
  const [loading, setLoading] = useState(requestOnMount);

  const request = () => {
    if (!navigator.geolocation) {
      setError({
        code: 0,
        message: "Geolocation is not supported by this browser.",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError);
      return;
    }

    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoords({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          timestamp: position.timestamp,
        });
        setError(null);
        setLoading(false);
      },
      (err) => {
        console.warn("Geolocation request failed", err);
        setError(err);
        setLoading(false);
      },
      {
        enableHighAccuracy: false, // prefer speed over precision for event listing
        timeout: 15_000,
        maximumAge: 300_000, // acceptable to use 5min old position
      },
    );
  };

  useEffect(() => {
    if (requestOnMount) {
      request();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { coords, error, loading, request, setCoords };
}
