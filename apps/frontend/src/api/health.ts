import { healthOperations, type HealthLive, type HealthReadiness } from '@planner/contracts';

export function decodeHealthLive(value: unknown): HealthLive {
  return healthOperations.live.output.parse(value);
}

export function decodeHealthReadiness(value: unknown): HealthReadiness {
  return healthOperations.readiness.output.parse(value);
}
