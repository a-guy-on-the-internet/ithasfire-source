import type { LoggerPort } from "@th/ports/logger";
import type { EventGateType, EventVisibility } from "@th/ports/repos/events";

type EventGateLogAction =
  | "visibility_updated"
  | "gate_type_updated"
  | "password_set"
  | "password_cleared"
  | "password_attempt"
  | "application_submitted"
  | "application_reviewed"
  | "waitlist_updated"
  | "waitlist_join";

type EventGateLogResult = "success" | "failure" | "noop" | "bypassed";

export type EventGateLogPayload = {
  eventId: string;
  gateType?: EventGateType;
  visibility?: EventVisibility;
  action: EventGateLogAction;
  result: EventGateLogResult;
  actorHumanId?: string;
  viewerHumanId?: string | null;
  metadata?: Record<string, unknown>;
};

export function logEventGate(
  logger: LoggerPort | undefined,
  payload: EventGateLogPayload,
): void {
  if (!logger) {
    return;
  }

  logger.info("event_gate", {
    category: "event_gate",
    ...payload,
  });
}
