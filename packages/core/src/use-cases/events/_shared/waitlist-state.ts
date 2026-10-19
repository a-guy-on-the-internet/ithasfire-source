import type { WaitlistStatus } from "@th/ports/repos/events";

export type WaitlistState = {
  open: boolean;
  opensAt: Date | null;
};

export function computeWaitlistState(
  status: WaitlistStatus,
  publishAt: Date | null | undefined,
  now: Date,
): WaitlistState {
  if (status === "OPEN") {
    return { open: true, opensAt: publishAt ?? null };
  }

  if (status === "SCHEDULED") {
    if (publishAt && now >= publishAt) {
      return { open: true, opensAt: publishAt };
    }
    return { open: false, opensAt: publishAt ?? null };
  }

  return { open: false, opensAt: null };
}
