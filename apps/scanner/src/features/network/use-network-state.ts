import { useEffect, useState } from "react";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";

import { classifyNetworkState, type NetworkState } from "./network-state";

/**
 * Subscribe to NetInfo and expose a coarse `online | degraded | offline` state
 * for the global scanner banner. See {@link classifyNetworkState} for the
 * mapping rules.
 */
export const useNetworkState = (): NetworkState => {
  const [state, setState] = useState<NetworkState>("online");

  useEffect(() => {
    let cancelled = false;

    const apply = (sample: NetInfoState) => {
      if (cancelled) return;
      setState(
        classifyNetworkState({
          isConnected: sample.isConnected,
          isInternetReachable: sample.isInternetReachable,
        }),
      );
    };

    void NetInfo.fetch().then(apply);
    const unsubscribe = NetInfo.addEventListener(apply);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
};
