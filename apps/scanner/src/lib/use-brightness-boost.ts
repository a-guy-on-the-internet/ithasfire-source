import { useEffect, useRef } from "react";
import * as Brightness from "expo-brightness";

export function useBrightnessBoost() {
  const savedRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const current = await Brightness.getBrightnessAsync();
        if (!cancelled) {
          savedRef.current = current;
          await Brightness.setBrightnessAsync(1);
        }
      } catch {
        // expo-brightness may not be available (e.g. Expo Go on Android).
      }
    })();

    return () => {
      cancelled = true;
      if (savedRef.current !== null) {
        void Brightness.setBrightnessAsync(savedRef.current).catch(() => {});
      }
    };
  }, []);
}
