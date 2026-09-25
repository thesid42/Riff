import type { MetricsSnapshot, Variant } from '../shared/types.js';

export interface SignupChartPoint {
  time: number;
  timestamp: string;
  signups: number;
  marker: boolean;
}

export interface SignupChartTrack {
  variantId: string;
  label: string;
  headline: string;
  colorKey: 'a' | 'b' | 'c' | 'other';
  points: SignupChartPoint[];
  latestSignups: number;
}

export interface SignupChartTick {
  time: number;
  label: string;
}

export interface SignupChartModel {
  hasData: boolean;
  domainStart: number | null;
  domainEnd: number | null;
  yMaximum: number;
  yTicks: number[];
  xTicks: SignupChartTick[];
  tracks: SignupChartTrack[];
  observationTimestamp: string | null;
  totalSignups: number;
  xAxisTitle: string;
}

type MetricsVariant = MetricsSnapshot['variants'][number];

function parseTime(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function elapsedLabel(milliseconds: number, span: number): string {
  if (span < 1_000) return milliseconds === 0 ? '0.0ms' : milliseconds < 10 ? `${milliseconds.toFixed(1)}ms` : `${Math.round(milliseconds)}ms`;
  if (span < 10_000) return milliseconds === 0 ? '0.0s' : `${(milliseconds / 1_000).toFixed(1)}s`;
  if (span < 3_600_000) {
    const seconds = Math.floor(milliseconds / 1_000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  if (span < 86_400_000) return `${(milliseconds / 3_600_000).toFixed(milliseconds % 3_600_000 === 0 ? 0 : 1)}h`;
  return `${(milliseconds / 86_400_000).toFixed(milliseconds % 86_400_000 === 0 ? 0 : 1)}d`;
}

function makeYTicks(maximum: number): number[] {
  const limit = Math.max(1, maximum);
  const step = Math.max(1, Math.ceil(limit / 4));
  const top = Math.ceil(limit / step) * step;
  return Array.from({ length: Math.floor(top / step) + 1 }, (_, index) => index * step);
}

function colorKey(label: string, fallbackIndex: number): SignupChartTrack['colorKey'] {
  const normalized = label.trim().toUpperCase();
  if (normalized === 'A') return 'a';
  if (normalized === 'B') return 'b';
  if (normalized === 'C') return 'c';
  return fallbackIndex % 3 === 0 ? 'a' : fallbackIndex % 3 === 1 ? 'b' : fallbackIndex % 3 === 2 ? 'c' : 'other';
}

export function buildSignupChartModel(input: {
  metrics: MetricsSnapshot | null;
  variants: Variant[];
}): SignupChartModel {
  const { metrics, variants } = input;
  const raw = metrics?.series ?? [];
  const parsed = raw.flatMap((point) => {
    const time = parseTime(point.timestamp);
    if (time === null || !Number.isSafeInteger(point.signups) || point.signups < 0 || !point.variantId) return [];
    return [{ variantId: point.variantId, time, timestamp: new Date(time).toISOString(), signups: point.signups }];
  });
  const groups = new Map<string, typeof parsed>();
  for (const point of parsed) groups.set(point.variantId, [...(groups.get(point.variantId) ?? []), point]);

  const metadata = new Map(variants.map((variant) => [variant.id, variant]));
  const metricRows = metrics?.variants ?? [];
  const variantIds = new Set<string>();
  if (metrics?.status === 'available') {
    for (const row of metricRows) variantIds.add(row.variantId);
  }
  for (const point of parsed) variantIds.add(point.variantId);

  const orderedIds = [...variantIds].sort((left, right) => {
    const leftVariant = metadata.get(left);
    const rightVariant = metadata.get(right);
    const order = (variant: Variant | undefined) => {
      if (variant) {
        const label = variant.label.trim().toUpperCase();
        if (/^[A-Z]$/.test(label)) return label.charCodeAt(0) - 65;
      }
      return Number.MAX_SAFE_INTEGER;
    };
    return order(leftVariant) - order(rightVariant) || left.localeCompare(right);
  });

  const rawTimes = parsed.map((point) => point.time);
  const windowStart = parseTime(metrics?.window.start);
  const windowEnd = parseTime(metrics?.window.end);
  const updatedAt = parseTime(metrics?.updatedAt);
  const earliestEvent = rawTimes.length ? Math.min(...rawTimes) : null;
  const latestEvent = rawTimes.length ? Math.max(...rawTimes) : null;
  const domainStart = windowStart !== null && (earliestEvent === null || windowStart <= earliestEvent)
    ? windowStart
    : earliestEvent ?? (metrics?.status === 'available' ? updatedAt : null);
  const candidates = [latestEvent, updatedAt, windowEnd].filter((value): value is number => value !== null);
  const domainEnd = candidates.length ? Math.max(...candidates) : domainStart;
  const hasObservedResults = metrics?.status === 'available' && orderedIds.length > 0 && domainStart !== null && domainEnd !== null;

  const tracks: SignupChartTrack[] = hasObservedResults ? orderedIds.map((variantId, index) => {
    const variant = metadata.get(variantId);
    const byTime = new Map<number, number>();
    for (const point of (groups.get(variantId) ?? []).sort((a, b) => a.time - b.time || a.signups - b.signups)) {
      byTime.set(point.time, Math.max(byTime.get(point.time) ?? 0, point.signups));
    }
    const points: SignupChartPoint[] = [{ time: domainStart!, timestamp: new Date(domainStart!).toISOString(), signups: 0, marker: false }];
    let cumulative = 0;
    for (const [time, reported] of byTime) {
      cumulative = Math.max(cumulative, reported);
      if (time < domainStart! || time > domainEnd!) continue;
      const previous = points.at(-1)!;
      if (time === previous.time && cumulative === previous.signups) continue;
      points.push({ time, timestamp: new Date(time).toISOString(), signups: cumulative, marker: true });
    }
    if (points.at(-1)!.time < domainEnd!) {
      points.push({ time: domainEnd!, timestamp: new Date(domainEnd!).toISOString(), signups: cumulative, marker: false });
    }
    return {
      variantId,
      label: variant?.label?.trim() || `Version ${String.fromCharCode(65 + index)}`,
      headline: variant?.headline?.trim() || 'Headline unavailable',
      colorKey: colorKey(variant?.label ?? '', index),
      points,
      latestSignups: points.at(-1)?.signups ?? 0,
    };
  }) : [];

  const maximum = Math.max(0, ...tracks.flatMap((track) => track.points.map((point) => point.signups)));
  const span = domainStart !== null && domainEnd !== null ? Math.max(0, domainEnd - domainStart) : 0;
  const xTicks = domainStart === null || domainEnd === null ? [] : span === 0
    ? [{ time: domainStart, label: '0s' }]
    : [0, 0.5, 1].map((fraction) => {
      const time = domainStart + span * fraction;
      return { time, label: elapsedLabel(time - domainStart, span) };
    });
  const observationTime = domainEnd === null ? null : new Date(domainEnd).toISOString();
  const yTicks = makeYTicks(maximum);
  const startDescription = windowStart !== null && domainStart === windowStart
    ? 'from wave start'
    : earliestEvent !== null ? 'from first recorded sign-up' : 'from first recorded result';
  const timeUnit = span < 1_000 ? 'milliseconds' : span < 10_000 ? 'seconds' : span < 3_600_000 ? 'minutes:seconds' : span < 86_400_000 ? 'hours' : 'days';

  return {
    hasData: tracks.length > 0,
    domainStart,
    domainEnd,
    yMaximum: yTicks.at(-1) ?? 1,
    yTicks,
    xTicks,
    tracks,
    observationTimestamp: observationTime,
    totalSignups: tracks.reduce((sum, track) => sum + track.latestSignups, 0),
    xAxisTitle: `Elapsed time (${timeUnit}) ${startDescription}`,
  };
}

export function formatSignupTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(date);
}
