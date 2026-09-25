import type { MetricsSnapshot, Variant } from '../shared/types.js';

export type ComparisonMetricKey = 'impressions' | 'clicks' | 'signups';

export interface ComparisonMetric {
  key: ComparisonMetricKey;
  label: string;
}

export interface ComparisonVersion {
  variantId: string;
  label: string;
  headline: string;
  colorKey: 'a' | 'b' | 'c' | 'other';
  impressions: number;
  clicks: number;
  signups: number;
  clickRate: number | null;
  signupRate: number | null;
}

export interface ComparisonChartModel {
  hasData: boolean;
  metrics: ComparisonMetric[];
  versions: ComparisonVersion[];
  yMaximum: number;
  yTicks: number[];
  totalImpressions: number;
  totalClicks: number;
  totalSignups: number;
}

export const COMPARISON_METRICS: ComparisonMetric[] = [
  { key: 'impressions', label: 'Ad views' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'signups', label: 'Sign-ups' },
];

function makeYTicks(maximum: number): number[] {
  const limit = Math.max(1, maximum);
  const step = Math.max(1, Math.ceil(limit / 4));
  const top = Math.ceil(limit / step) * step;
  return Array.from({ length: Math.floor(top / step) + 1 }, (_, index) => index * step);
}

function colorKey(label: string, fallbackIndex: number): ComparisonVersion['colorKey'] {
  const normalized = label.trim().toUpperCase();
  if (normalized === 'A') return 'a';
  if (normalized === 'B') return 'b';
  if (normalized === 'C') return 'c';
  return fallbackIndex % 3 === 0 ? 'a' : fallbackIndex % 3 === 1 ? 'b' : 'c';
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Prefer variant totals (correct experiment comparison) over time-series sign-ups. */
export function buildSignupChartModel(input: {
  metrics: MetricsSnapshot | null;
  variants: Variant[];
}): ComparisonChartModel {
  const { metrics, variants } = input;
  if (!metrics || metrics.status !== 'available' || metrics.variants.length === 0) {
    return {
      hasData: false,
      metrics: COMPARISON_METRICS,
      versions: [],
      yMaximum: 1,
      yTicks: [0, 1],
      totalImpressions: 0,
      totalClicks: 0,
      totalSignups: 0,
    };
  }

  const metadata = new Map(variants.map((variant) => [variant.id, variant]));
  const ordered = [...metrics.variants].sort((left, right) => {
    const leftVariant = metadata.get(left.variantId);
    const rightVariant = metadata.get(right.variantId);
    const order = (variant: Variant | undefined) => {
      if (!variant) return Number.MAX_SAFE_INTEGER;
      const label = variant.label.trim().toUpperCase();
      return /^[A-Z]$/.test(label) ? label.charCodeAt(0) - 65 : Number.MAX_SAFE_INTEGER;
    };
    return order(leftVariant) - order(rightVariant) || left.variantId.localeCompare(right.variantId);
  });

  const versions: ComparisonVersion[] = ordered.map((row, index) => {
    const variant = metadata.get(row.variantId);
    return {
      variantId: row.variantId,
      label: variant?.label?.trim() || `Version ${String.fromCharCode(65 + index)}`,
      headline: variant?.headline?.trim() || 'Headline unavailable',
      colorKey: colorKey(variant?.label ?? '', index),
      impressions: row.totals.impressions,
      clicks: row.totals.clicks,
      signups: row.totals.signups,
      clickRate: rate(row.totals.clicks, row.totals.impressions),
      signupRate: rate(row.totals.signups, row.totals.impressions),
    };
  });

  const peak = Math.max(0, ...versions.flatMap((version) => [version.impressions, version.clicks, version.signups]));
  const yTicks = makeYTicks(peak);

  return {
    hasData: true,
    metrics: COMPARISON_METRICS,
    versions,
    yMaximum: yTicks.at(-1) ?? 1,
    yTicks,
    totalImpressions: versions.reduce((sum, version) => sum + version.impressions, 0),
    totalClicks: versions.reduce((sum, version) => sum + version.clicks, 0),
    totalSignups: versions.reduce((sum, version) => sum + version.signups, 0),
  };
}

export function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}
