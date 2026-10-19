/**
 * Durable resume points for jobs that scan a table in pages across runs.
 *
 * A job whose candidate set is dominated by rows it deliberately KEEPS cannot
 * make progress with a per-run cursor: every run restarts at the same oldest
 * rows and anything past one run's page budget is never examined at all. That
 * is not a slow scan, it is no scan — and it is silent, because the job
 * reports zero work done, which is indistinguishable from having nothing to
 * do. `storage.sweep-orphaned-uploads` is the motivating case.
 *
 * The stored value is opaque to this port: each job defines its own cursor
 * shape and is responsible for tolerating a stored value it no longer
 * understands (treat as "start from the beginning" rather than throwing).
 */
export interface JobCursorsRepo {
  /**
   * The stored resume point for a job, or null when it has never stored one
   * (or deliberately cleared it after a full pass).
   */
  get(jobName: string): Promise<unknown | null>;

  /**
   * Store (or clear, with null) a job's resume point. Upserts by job name and
   * MUST NOT disturb other columns on the row — `enabled` in particular is the
   * job kill switch and is owned by a different code path.
   */
  set(jobName: string, cursor: unknown | null): Promise<void>;
}
