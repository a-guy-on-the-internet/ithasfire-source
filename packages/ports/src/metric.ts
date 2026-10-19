export interface MetricsPort {
  increment(name: string, tags?: Record<string, string>): void;
  record(name: string, value: number, tags?: Record<string, string>): void;
}
