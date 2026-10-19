"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

export type UseCurrentUrlOptions = {
  /**
   * When true (default), prefixes the current pathname with the window origin.
   */
  absolute?: boolean;
  /**
   * When true (default), preserves the hash fragment from the browser location when available.
   */
  includeHash?: boolean;
};

export const useCurrentUrl = (options: UseCurrentUrlOptions = {}) => {
  const pathname = usePathname();
  const [search, setSearch] = useState<string>("");
  const absolute = options.absolute ?? true;
  const includeHash = options.includeHash ?? true;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setSearch(window.location.search);
  }, [pathname]);

  return useMemo(() => {
    if (!pathname) {
      return undefined;
    }

    const relative =
      search && search.length > 0 ? `${pathname}${search}` : pathname;

    if (!absolute) {
      if (!includeHash) {
        return relative;
      }

      if (typeof window === "undefined") {
        return relative;
      }

      const hash = window.location.hash;
      return hash ? `${relative}${hash}` : relative;
    }

    if (typeof window === "undefined") {
      // During SSR we cannot access the origin. Fall back to the relative URL.
      return relative;
    }

    const origin = window.location.origin;
    const hash = includeHash ? window.location.hash : "";
    return `${origin}${relative}${hash}`;
  }, [absolute, includeHash, pathname, search]);
};
