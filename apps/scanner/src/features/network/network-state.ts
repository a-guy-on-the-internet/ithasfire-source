/**
 * Network connectivity classifier for the scanner shell.
 *
 * The scanner is online-only for v1 writes (per scanner-foundation FR-010), so
 * we surface a global banner that distinguishes between three operator-visible
 * states. Logic is pure so it can be unit-tested without bringing up NetInfo.
 */

export type NetworkState = "online" | "degraded" | "offline";

export interface NetworkSample {
  /** True when the device reports an active connection (wifi/cellular). */
  isConnected: boolean | null;
  /**
   * True when NetInfo has confirmed reachability beyond the local link. When
   * `null`, NetInfo hasn't probed yet; we optimistically treat that as online
   * to avoid a banner flicker on cold start.
   */
  isInternetReachable: boolean | null;
}

export const classifyNetworkState = (sample: NetworkSample): NetworkState => {
  if (sample.isConnected === false) {
    return "offline";
  }
  if (sample.isInternetReachable === false) {
    return "degraded";
  }
  // Both `isConnected: null` and `isInternetReachable: null` mean NetInfo
  // hasn't yet returned a definitive sample. Treat unknowns as online to
  // avoid a cold-start flicker; we only paint chrome on definitive `false`s.
  return "online";
};
