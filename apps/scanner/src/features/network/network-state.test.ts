import { describe, expect, it } from "vitest";

import { classifyNetworkState } from "./network-state";

describe("classifyNetworkState", () => {
  it("returns online when connected and reachable", () => {
    expect(
      classifyNetworkState({ isConnected: true, isInternetReachable: true }),
    ).toBe("online");
  });

  it("treats unknown reachability as online to avoid banner flicker", () => {
    expect(
      classifyNetworkState({ isConnected: true, isInternetReachable: null }),
    ).toBe("online");
  });

  it("returns degraded when connected but not reachable", () => {
    expect(
      classifyNetworkState({ isConnected: true, isInternetReachable: false }),
    ).toBe("degraded");
  });

  it("returns offline when not connected", () => {
    expect(
      classifyNetworkState({ isConnected: false, isInternetReachable: false }),
    ).toBe("offline");
    expect(
      classifyNetworkState({ isConnected: false, isInternetReachable: null }),
    ).toBe("offline");
  });

  it("treats fully unknown connectivity as online to avoid cold-start flicker", () => {
    expect(
      classifyNetworkState({ isConnected: null, isInternetReachable: null }),
    ).toBe("online");
  });
});
