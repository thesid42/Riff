import { z } from 'zod';
import type { PersonaTemplate } from './personas.js';
import type { CampaignRuntime } from './run.js';

export const campaignInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  product: z.string().trim().min(1).max(300),
  audience: z.string().trim().min(1).max(500),
  goal: z.literal('signups').default('signups'),
  approvedClaims: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  budgetCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('USD').default('USD'),
}).strict();

export type CampaignInput = z.output<typeof campaignInputSchema>;

export interface Campaign {
  id: string;
  name: string;
  product: string;
  audience: string;
  goal: 'signups';
  approvedClaims: string[];
  budgetCents: number;
  currency: 'USD';
  status: 'draft';
  runtime: CampaignRuntime;
  agentCount: number;
  concurrency: number;
  headlines: string[];
  customPersonas: PersonaTemplate[];
  createdAt: string;
  updatedAt: string;
}

export interface Variant {
  id: string;
  campaignId: string;
  label: string;
  headline: string;
  offer: string;
  status: 'draft' | 'creating' | 'ready' | 'paused' | 'failed';
  imageUrl: string | null;
  videoUrl: string | null;
  parentId: string | null;
  experimentId: string | null;
  createdAt: string;
}

export interface Experiment {
  id: string;
  campaignId: string;
  hypothesis: string;
  status: 'draft' | 'collecting' | 'inconclusive' | 'completed';
  variantIds: string[];
  windowStart: string | null;
  windowEnd: string | null;
  createdAt: string;
}

export interface Lesson {
  id: string;
  campaignId: string;
  statement: string;
  audience: string;
  offer: string;
  experimentId: string;
  evidenceIds: string[];
  status: 'active' | 'needs_retest';
  createdAt: string;
}

export interface MetricTotals {
  impressions: number;
  uniqueVisitors: number;
  clicks: number;
  signups: number;
  spendCents: number;
}

export interface DerivedMetrics {
  clickRate: number | null;
  signupPerClick: number | null;
  signupPerImpression: number | null;
  costPerClickCents: number | null;
  costPerSignupCents: number | null;
}

export interface MetricsSnapshot {
  campaignId: string;
  /** Which path actually produced these numbers, so a silent fallback stays visible. */
  source: 'none' | 'rawtree' | 'tinybird' | 'sqlite';
  status: 'not_started' | 'available' | 'unavailable';
  window: { label: string; start: string | null; end: string | null };
  updatedAt: string | null;
  totals: MetricTotals;
  variants: Array<{ variantId: string; totals: MetricTotals }>;
  series: Array<{ timestamp: string; variantId: string; signups: number }>;
  message: string;
  decideTimeMedianMs?: number | null;
  decideTimeP90Ms?: number | null;
}

export interface IntegrationStatus {
  id: 'liquid' | 'analytics' | 'bfl';
  name: string;
  purpose: string;
  status: 'not_configured' | 'configured' | 'invalid';
  provider: string;
  missing: string[];
  message: string;
}

export const emptyMetricTotals = (): MetricTotals => ({
  impressions: 0,
  uniqueVisitors: 0,
  clicks: 0,
  signups: 0,
  spendCents: 0,
});

export function deriveMetrics(totals: MetricTotals): DerivedMetrics {
  return {
    clickRate: totals.impressions === 0 ? null : totals.clicks / totals.impressions,
    signupPerClick: totals.clicks === 0 ? null : totals.signups / totals.clicks,
    signupPerImpression: totals.impressions === 0 ? null : totals.signups / totals.impressions,
    costPerClickCents: totals.clicks === 0 ? null : totals.spendCents / totals.clicks,
    costPerSignupCents: totals.signups === 0 ? null : totals.spendCents / totals.signups,
  };
}

export function emptyMetricsSnapshot(campaignId: string): MetricsSnapshot {
  return {
    campaignId,
    source: 'none',
    status: 'not_started',
    window: { label: 'All time', start: null, end: null },
    updatedAt: null,
    totals: emptyMetricTotals(),
    variants: [],
    series: [],
    message: 'No analytics data has been collected.',
  };
}
