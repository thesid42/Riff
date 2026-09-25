import { personaById, type PersonaTemplate } from '../shared/personas.js';
import {
  average,
  median,
  percentile,
  type AgentJob,
  type DeciderSpeedMetrics,
  type PersonaFriction,
  type PersonaSegmentMetrics,
  type WaveProgress,
} from '../shared/run.js';
import { emptyMetricTotals, type MetricTotals } from '../shared/types.js';

const IMPRESSION_CENTS = 2;
const CLICK_CENTS = 8;

export function lastJobError(jobs: AgentJob[]): string | null {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (job.status === 'failed' && job.error) counts.set(job.error, (counts.get(job.error) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function jobProgress(jobs: AgentJob[]): WaveProgress {
  return jobs.reduce<WaveProgress>((progress, job) => {
    progress.total += 1;
    progress[job.status] += 1;
    return progress;
  }, { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0 });
}

export function totalsFromJobs(jobs: AgentJob[]): MetricTotals {
  const succeeded = jobs.filter((job) => job.status === 'succeeded');
  const clicks = succeeded.filter((job) => job.action === 'click' || job.action === 'signup').length;
  const signups = succeeded.filter((job) => job.action === 'signup').length;
  return {
    impressions: succeeded.length,
    uniqueVisitors: succeeded.length,
    clicks,
    signups,
    spendCents: succeeded.reduce((sum, job) => sum + eventCost(job.action), 0),
  };
}

export function variantTotals(jobs: AgentJob[]): Array<{ variantId: string; totals: MetricTotals }> {
  const byVariant = new Map<string, AgentJob[]>();
  for (const job of jobs) {
    const list = byVariant.get(job.variantId) ?? [];
    list.push(job);
    byVariant.set(job.variantId, list);
  }
  return [...byVariant.entries()].map(([variantId, list]) => ({ variantId, totals: totalsFromJobs(list) }));
}

export function signupSeries(jobs: AgentJob[]): Array<{ timestamp: string; variantId: string; signups: number }> {
  const counts = new Map<string, number>();
  const points: Array<{ timestamp: string; variantId: string; signups: number }> = [];
  for (const job of jobs.filter((item) => item.status === 'succeeded' && item.action === 'signup' && item.finishedAt).sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))) {
    const key = job.variantId;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    points.push({ timestamp: job.finishedAt!, variantId: job.variantId, signups: next });
  }
  return points;
}

export function segmentMetrics(jobs: AgentJob[], extras: PersonaTemplate[] = []): PersonaSegmentMetrics[] {
  const bySegment = new Map<string, AgentJob[]>();
  for (const job of jobs.filter((item) => item.status === 'succeeded')) {
    const list = bySegment.get(job.audienceSegment) ?? [];
    list.push(job);
    bySegment.set(job.audienceSegment, list);
  }
  return [...bySegment.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([segment, list]) => {
    const decide = list.map((job) => job.elapsedMs).filter((value): value is number => value != null);
    const dwell = list.map((job) => job.dwellSeconds).filter((value): value is number => value != null);
    const confidence = list.map((job) => job.confidence).filter((value): value is number => value != null);
    const attention = list.map((job) => job.attention).filter((value): value is number => value != null);
    const trust = list.map((job) => job.trust).filter((value): value is number => value != null);
    const intent = list.map((job) => job.purchaseIntent).filter((value): value is number => value != null);
    const noticedFirst: PersonaSegmentMetrics['noticedFirst'] = {};
    const frictionCounts = new Map<PersonaFriction, number>();
    for (const job of list) {
      if (job.noticedFirst) noticedFirst[job.noticedFirst] = (noticedFirst[job.noticedFirst] ?? 0) + 1;
      if (job.friction) frictionCounts.set(job.friction, (frictionCounts.get(job.friction) ?? 0) + 1);
    }
    const topFriction = [...frictionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      segment,
      label: personaById(segment, extras)?.label ?? segment,
      sampleSize: list.length,
      views: list.length,
      skips: list.filter((job) => job.action === 'skip').length,
      clicks: list.filter((job) => job.action === 'click' || job.action === 'signup').length,
      signups: list.filter((job) => job.action === 'signup').length,
      medianDecideMs: median(decide),
      p90DecideMs: percentile(decide, 90),
      medianDwellSeconds: median(dwell),
      averageConfidence: average(confidence),
      averageAttention: average(attention),
      averageTrust: average(trust),
      averageIntent: average(intent),
      topFriction,
      noticedFirst,
      reasons: list.map((job) => job.reason).filter((reason): reason is string => Boolean(reason)).slice(0, 3),
    };
  });
}

/** The most one persona judgment can spend: an impression plus a click. */
export const MAX_AGENT_COST_CENTS = IMPRESSION_CENTS + CLICK_CENTS;

export function eventCost(action: AgentJob['action']): number {
  if (action === 'signup' || action === 'click') return IMPRESSION_CENTS + CLICK_CENTS;
  return IMPRESSION_CENTS;
}

export function deciderSpeed(jobs: AgentJob[]): DeciderSpeedMetrics {
  const decided = jobs.filter((job) => job.status === 'succeeded' && job.elapsedMs != null);
  const empty: DeciderSpeedMetrics = { medianDecideMs: null, fastSignupRate: null, slowSignupRate: null, fastSampleSize: 0, slowSampleSize: 0 };
  if (decided.length === 0) return empty;
  const midpoint = median(decided.map((job) => job.elapsedMs as number));
  if (midpoint == null) return empty;
  const fast = decided.filter((job) => (job.elapsedMs as number) <= midpoint);
  const slow = decided.filter((job) => (job.elapsedMs as number) > midpoint);
  const rate = (list: AgentJob[]) => list.length === 0 ? null : list.filter((job) => job.action === 'signup').length / list.length;
  return {
    medianDecideMs: midpoint,
    fastSignupRate: rate(fast),
    slowSignupRate: rate(slow),
    fastSampleSize: fast.length,
    slowSampleSize: slow.length,
  };
}

export function emptyTotalsIfNone(jobs: AgentJob[]): MetricTotals {
  return jobs.some((job) => job.status === 'succeeded') ? totalsFromJobs(jobs) : emptyMetricTotals();
}
