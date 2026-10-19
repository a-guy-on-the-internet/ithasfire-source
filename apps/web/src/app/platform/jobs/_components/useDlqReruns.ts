"use client";

import { useCallback, useRef, useState } from "react";

import {
  dlqItemKey,
  ranButEntryKept,
  type DlqRerunSettled,
} from "./dlq-rerun-outcome";

export interface DlqRerunRowState {
  /** This entry's rerun is the one in flight. */
  pending: boolean;
  /**
   * Rerun is off for this row: another entry in the same queue is being rerun,
   * or this entry already ran and could not be removed.
   */
  blocked: boolean;
  /** The job ran for this entry and the entry is still listed. */
  ranEntryKept: boolean;
}

/**
 * Rerun bookkeeping for the DLQ panels on `/platform/jobs`. It holds no
 * network code: the page calls `start` before it fires the mutation and
 * `finish` when the mutation settles.
 *
 * Three rules live here.
 *
 * 1. **One rerun per queue at a time.** A panel has a single outcome line, so
 *    a second rerun in the same queue would overwrite the first one's answer
 *    (A fails, B runs, the panel says "the job ran" and nothing says A
 *    failed). While one is in flight every Rerun in that queue is off, and
 *    the line is always about the rerun the operator just watched. A rerun is
 *    synchronous and can run for minutes, so the guard is a ref: it is current
 *    inside one event, where state is not.
 * 2. **The outcome line is keyed by queue**, so one job's outcome never shows
 *    under another job's panel. A rerun that settles after its panel was
 *    closed is kept and shows the next time that panel opens.
 * 3. **An entry that ran but could not be removed stays marked** for as long
 *    as this page state lives. The outcome line is replaced by the next
 *    rerun, delete or panel close; the fact that rerunning that entry would
 *    run the job twice must outlast it. The mark is per entry, so it ends when
 *    the entry leaves the list.
 */
export function useDlqReruns() {
  const inFlightRef = useRef<Map<string, string>>(new Map());
  const ranEntryKeptRef = useRef<Set<string>>(new Set());

  const [inFlight, setInFlight] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [settledByQueue, setSettledByQueue] = useState<
    ReadonlyMap<string, DlqRerunSettled>
  >(new Map());
  const [ranEntryKept, setRanEntryKept] = useState<ReadonlySet<string>>(
    new Set(),
  );

  /** Forget the outcome line of one queue (its panel closed, or it is stale). */
  const dismiss = useCallback((queue: string) => {
    setSettledByQueue((prev) => {
      if (!prev.has(queue)) return prev;
      const next = new Map(prev);
      next.delete(queue);
      return next;
    });
  }, []);

  /**
   * Claim the queue for one rerun. Returns false, and changes nothing, when
   * the rerun must not fire: the queue is busy, or this entry already ran.
   */
  const start = useCallback(
    (queue: string, jobId: string): boolean => {
      if (inFlightRef.current.has(queue)) return false;
      if (ranEntryKeptRef.current.has(dlqItemKey(queue, jobId))) return false;
      inFlightRef.current.set(queue, jobId);
      setInFlight(new Map(inFlightRef.current));
      dismiss(queue);
      return true;
    },
    [dismiss],
  );

  /** Release the queue and record what the rerun settled with. */
  const finish = useCallback(
    (queue: string, jobId: string, settled: DlqRerunSettled) => {
      if (inFlightRef.current.get(queue) === jobId) {
        inFlightRef.current.delete(queue);
        setInFlight(new Map(inFlightRef.current));
      }
      setSettledByQueue((prev) => new Map(prev).set(queue, settled));
      if (ranButEntryKept(settled)) {
        ranEntryKeptRef.current.add(dlqItemKey(queue, jobId));
        setRanEntryKept(new Set(ranEntryKeptRef.current));
      }
    },
    [],
  );

  const settledFor = useCallback(
    (queue: string): DlqRerunSettled | undefined => settledByQueue.get(queue),
    [settledByQueue],
  );

  const rowState = useCallback(
    (queue: string, jobId: string): DlqRerunRowState => {
      const running = inFlight.get(queue);
      const pending = running === jobId;
      const kept = ranEntryKept.has(dlqItemKey(queue, jobId));
      return {
        pending,
        blocked: kept || (running !== undefined && !pending),
        ranEntryKept: kept,
      };
    },
    [inFlight, ranEntryKept],
  );

  return { start, finish, dismiss, settledFor, rowState };
}
