"use client";

import { useCallback, useMemo, useState } from "react";

import type { EventGridFilterState } from "./types";

export const emptyState: EventGridFilterState = {};

export interface UseEventGridFiltersOptions {
  defaultState?: EventGridFilterState;
  onChange?: (state: EventGridFilterState) => void;
}

export const useEventGridFilters = ({
  defaultState,
  onChange,
}: UseEventGridFiltersOptions = {}) => {
  const [state, setState] = useState<EventGridFilterState>(
    defaultState ?? emptyState,
  );

  const emit = useCallback(
    (next: EventGridFilterState) => {
      setState(next);
      onChange?.(next);
    },
    [onChange],
  );

  const update = useCallback(
    (partial: Partial<EventGridFilterState>) => {
      emit({ ...state, ...partial });
    },
    [emit, state],
  );

  const clear = useCallback(() => {
    emit({});
  }, [emit]);

  return useMemo(
    () => ({
      state,
      update,
      clear,
    }),
    [clear, state, update],
  );
};
