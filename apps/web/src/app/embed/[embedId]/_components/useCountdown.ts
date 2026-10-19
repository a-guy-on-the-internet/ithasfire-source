import { useEffect, useState } from "react";

/**
 * Hold countdown hook — mirrors the main checkout's useCountdown.
 * Returns a formatted string like "2:30" and an expired flag.
 */
export function useCountdown(holdExpiresAt: string | null) {
  const [countdown, setCountdown] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!holdExpiresAt) {
      setCountdown(null);
      setIsExpired(false);
      return;
    }

    const expiry = new Date(holdExpiresAt);
    const fmt = (ms: number) => {
      const totalSec = Math.max(0, Math.floor(ms / 1000));
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${m}:${s.toString().padStart(2, "0")}`;
    };

    const tick = () => {
      const diff = expiry.getTime() - Date.now();
      if (diff > 0) {
        setCountdown(fmt(diff));
        setIsExpired(false);
      } else {
        setCountdown("Expired");
        setIsExpired(true);
      }
    };

    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [holdExpiresAt]);

  return { countdown, isExpired };
}
