import { z } from 'zod';
import { PLANNER_VERSION } from './version.js';

const commonHealthFields = {
  version: z.literal(PLANNER_VERSION),
  requestId: z.uuid(),
};

export const healthInputSchema = z.strictObject({});
export const healthLiveSchema = z.strictObject({
  status: z.literal('live'),
  ...commonHealthFields,
});
export const healthReadinessSchema = z.strictObject({
  status: z.enum(['ready', 'unavailable']),
  ...commonHealthFields,
});

export type HealthInput = z.infer<typeof healthInputSchema>;
export type HealthLive = z.infer<typeof healthLiveSchema>;
export type HealthReadiness = z.infer<typeof healthReadinessSchema>;

export const healthOperations = {
  live: {
    id: 'health.live',
    kind: 'read',
    input: healthInputSchema,
    output: healthLiveSchema,
  },
  readiness: {
    id: 'health.readiness',
    kind: 'read',
    input: healthInputSchema,
    output: healthReadinessSchema,
  },
} as const;
