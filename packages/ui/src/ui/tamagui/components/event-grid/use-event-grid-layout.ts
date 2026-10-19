"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

import {
  DEFAULT_MAX_ROWS_DESKTOP,
  DEFAULT_MAX_ROWS_MOBILE,
  DEFAULT_MAX_ROWS_TABLET,
  DEFAULT_MIN_CARD_WIDTH,
  MOBILE_BREAKPOINT,
  TABLET_BREAKPOINT,
  isWeb,
} from "./constants";

export interface EventGridLayoutConfig {
  minCardWidth?: number;
  maxRows?: number;
  rowGap?: number;
  columnGap?: number;
}

export interface EventGridLayout {
  columns: number;
  rows: number;
  width: number;
  containerRef:
    | React.MutableRefObject<HTMLElement | null>
    | React.MutableRefObject<null>;
  handleLayout: (event: LayoutChangeEvent) => void;
}

const resolveMaxRows = (width: number, explicitMaxRows?: number) => {
  if (typeof explicitMaxRows === "number") {
    return explicitMaxRows;
  }

  if (width >= TABLET_BREAKPOINT) {
    return DEFAULT_MAX_ROWS_DESKTOP;
  }

  if (width >= MOBILE_BREAKPOINT) {
    return DEFAULT_MAX_ROWS_TABLET;
  }

  return DEFAULT_MAX_ROWS_MOBILE;
};

const computeColumns = (width: number, minCardWidth: number) => {
  if (width <= 0) {
    return 1;
  }

  const rawColumns = Math.floor(width / minCardWidth);
  return Math.max(1, rawColumns);
};

export const useEventGridLayout = ({
  minCardWidth = DEFAULT_MIN_CARD_WIDTH,
  maxRows,
}: EventGridLayoutConfig = {}): EventGridLayout => {
  const containerRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState<number>(0);

  // SSR safety: default width leads to 1 column until measured
  const columns = useMemo(
    () => computeColumns(width, minCardWidth),
    [minCardWidth, width],
  );
  const rows = useMemo(() => resolveMaxRows(width, maxRows), [maxRows, width]);

  useEffect(() => {
    if (!isWeb) {
      return;
    }

    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setWidth(entry.contentRect.width);
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    if (isWeb) {
      return;
    }

    setWidth(event.nativeEvent.layout.width);
  }, []);

  return {
    columns,
    rows,
    width,
    containerRef: containerRef as React.MutableRefObject<HTMLElement | null>,
    handleLayout,
  };
};
