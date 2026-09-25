import { z } from 'zod';
import { headlineSetSchema } from './headlines.js';

export { headlineSetSchema } from './headlines.js';

export const DEFAULT_AGENT_COUNT = 40;
export const MIN_AGENT_COUNT = 8;
export const MAX_AGENT_COUNT = 1_000;
export const DEFAULT_CONCURRENCY = 8;
export const MAX_CONCURRENCY = 20;
export const DEFAULT_OFFER = 'Join the waitlist';

export const runWaveSchema = z.object({
  agentCount: z.number().int().min(MIN_AGENT_COUNT).max(MAX_AGENT_COUNT).default(DEFAULT_AGENT_COUNT),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).default(DEFAULT_CONCURRENCY),
  creativeJobId: z.string().uuid().optional(),
  headlines: headlineSetSchema.optional(),
  profileMix: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
}).strict();

export type RunWaveInput = z.output<typeof runWaveSchema>;

export const persistHeadlinesSchema = z.object({
  headlines: headlineSetSchema,
}).strict();

export type CampaignRuntime = 'idle' | 'running' | 'paused';
export type AgentJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type PersonaAction = 'skip' | 'click' | 'signup';
export type NoticedFirst = 'headline' | 'image' | 'offer' | 'video' | 'unsure';
export type PersonaFriction = 'price' | 'trust' | 'relevance' | 'busy' | 'none';

export interface PersonaJudgment {
  action: PersonaAction;
  reason: string;
  dwellSeconds: number;
  timeToActionSeconds: number;
  confidence: number;
  attention: number;
  clarity: number;
  trust: number;
  purchaseIntent: number;
  noticedFirst: NoticedFirst;
  friction: PersonaFriction;
}

export interface AgentJob {
  id: string;
  campaignId: string;
  experimentId: string;
  variantId: string;
  personaId: string;
  audienceSegment: string;
  status: AgentJobStatus;
  action: PersonaAction | null;
  reason: string | null;
  dwellSeconds: number | null;
  timeToActionSeconds: number | null;
  confidence: number | null;
  attention: number | null;
  clarity: number | null;
  trust: number | null;
  purchaseIntent: number | null;
  noticedFirst: NoticedFirst | null;
  friction: PersonaFriction | null;
  elapsedMs: number | null;
  queueWaitMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DecisionRecord {
  id: string;
  campaignId: string;
  experimentId: string;
  action: 'wait' | 'propose_test';
  explanation: string;
  hypothesis: string;
  headlines: string[];
  evidenceIds: string[];
  /** Personas Liquid asked the next round to target; empty means the full roster. */
  personaIds: string[];
  /** Whether Liquid asked for new creative at step 3 of the next round. */
  needsNewCreative: boolean;
  /** What step 3 actually did for the round this decision started, or null if none followed. */
  creativeOutcome: CreativeOutcome | null;
  createdAt: string;
}

/** new: generated for this round; reused: carried from the previous round; text-only: no media. */
export type CreativeOutcome = 'new' | 'reused' | 'text-only';

/** What a round ran against, so each "Results by round" card can show its creative and audience. */
export interface RoundSummary {
  /** initial for the manually started round; otherwise what step 3 did for this round. */
  creative: 'initial' | CreativeOutcome;
  personas: Array<{ id: string; label: string }>;
  media: Array<{ label: string; headline: string; imageUrl: string | null; videoUrl: string | null }>;
}

export interface WaveProgress {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
}

export interface PersonaSegmentMetrics {
  segment: string;
  label: string;
  sampleSize: number;
  views: number;
  skips: number;
  clicks: number;
  signups: number;
  medianDecideMs: number | null;
  p90DecideMs: number | null;
  medianDwellSeconds: number | null;
  averageConfidence: number | null;
  averageAttention: number | null;
  averageTrust: number | null;
  averageIntent: number | null;
  topFriction: PersonaFriction | null;
  noticedFirst: Partial<Record<NoticedFirst, number>>;
  reasons: string[];
}

export interface DeciderSpeedMetrics {
  medianDecideMs: number | null;
  fastSignupRate: number | null;
  slowSignupRate: number | null;
  fastSampleSize: number;
  slowSampleSize: number;
}

export interface WaveSnapshot {
  runtime: CampaignRuntime;
  agentCount: number;
  concurrency: number;
  headlines: string[];
  experimentId: string | null;
  progress: WaveProgress;
  segments: PersonaSegmentMetrics[];
  deciderSpeed: DeciderSpeedMetrics;
  latestDecision: DecisionRecord | null;
  lastError: string | null;
  ingestError: string | null;
  reviewError: string | null;
  /** Why the auto-run loop stopped, so the UI can explain it instead of going quiet. */
  loopStatus: LoopStatus | null;
}

export type LoopStopReason = 'threshold_met' | 'round_cap' | 'paused' | 'review_failed' | 'rules_failed' | 'creative_failed';

export interface LoopStatus {
  reason: LoopStopReason;
  round: number;
  maxRounds: number;
  message: string;
  /** Best observed click rate and the metrics source it was judged from. */
  bestClickRate: number | null;
  threshold: number;
  metricsSource: 'rawtree' | 'tinybird' | 'sqlite' | 'none';
  /** Set when the last chained round reused creative because no generator was available. */
  creativeNote?: string;
}

export function emptyWaveProgress(): WaveProgress {
  return { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0 };
}

export function emptyWaveSnapshot(agentCount = DEFAULT_AGENT_COUNT, concurrency = DEFAULT_CONCURRENCY): WaveSnapshot {
  return {
    runtime: 'idle',
    agentCount,
    concurrency,
    headlines: [],
    experimentId: null,
    progress: emptyWaveProgress(),
    segments: [],
    deciderSpeed: { medianDecideMs: null, fastSignupRate: null, slowSignupRate: null, fastSampleSize: 0, slowSampleSize: 0 },
    latestDecision: null,
    lastError: null,
    ingestError: null,
    reviewError: null,
    loopStatus: null,
  };
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
