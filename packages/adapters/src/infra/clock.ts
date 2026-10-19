import type { ClockPort } from "@th/ports/clock";

type NowProvider = () => Date | number;

function normalizeNowValue(value: Date | number): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Clock now provider returned an invalid date value");
  }
  return date;
}

class SystemClockAdapter implements ClockPort {
  constructor(private readonly nowProvider: NowProvider) {}

  now(): Date {
    return normalizeNowValue(this.nowProvider());
  }
}

export type CreateSystemClockOptions = {
  nowProvider?: NowProvider;
};

export function createSystemClock(
  options: CreateSystemClockOptions = {},
): ClockPort {
  const provider = options.nowProvider ?? Date.now;
  return new SystemClockAdapter(provider);
}
