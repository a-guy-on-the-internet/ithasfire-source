"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { setLastVisitedUrl } from "@/lib/last-url";

import { isAnalyticsExcludedPath } from "./analytics-excluded-paths";
import { stripClientSecretParams } from "./analytics-url-guard";

const LastVisitedUrlTrackerInner = () => {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) {
      return;
    }

    // Avoid `useSearchParams()` here so this component can safely render in
    // Next's not-found prerender paths.
    // If you need the full URL, prefer `window.location.search` inside the effect.
    const url =
      typeof window === "undefined"
        ? pathname
        : `${pathname}${stripClientSecretParams(window.location.search)}`;

    // Avoid turning sign-out into an immediate redirect loop.
    if (pathname.startsWith("/login") || pathname.startsWith("/auth")) {
      return;
    }
    // Token routes: their URL is a credential, and without it a return
    // visit lands on a dead page anyway.
    if (isAnalyticsExcludedPath(pathname)) {
      return;
    }

    setLastVisitedUrl(url);
  }, [pathname]);

  return null;
};

export const LastVisitedUrlTracker = () => <LastVisitedUrlTrackerInner />;
