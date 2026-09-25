// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MetricsSnapshot, Variant } from '../shared/types.js';
import { emptyMetricsSnapshot } from '../shared/types.js';
import SignupChart from '../src/SignupChart.js';
import { buildSignupChartModel } from '../src/signup-chart-model.js';

const start = '2026-09-25T16:00:00.000Z';
const end = '2026-09-25T16:10:00.000Z';
const variantRows: Variant[] = [
  { id: 'variant-a', campaignId: 'campaign', label: 'A', headline: 'A clear first headline', offer: 'Join the waitlist', status: 'ready', imageUrl: null, videoUrl: null, parentId: null, experimentId: 'experiment', createdAt: start },
  { id: 'variant-b', campaignId: 'campaign', label: 'B', headline: 'A different second headline', offer: 'Join the waitlist', status: 'ready', imageUrl: null, videoUrl: null, parentId: null, experimentId: 'experiment', createdAt: start },
  { id: 'variant-c', campaignId: 'campaign', label: 'C', headline: 'A third test headline', offer: 'Join the waitlist', status: 'ready', imageUrl: null, videoUrl: null, parentId: null, experimentId: 'experiment', createdAt: start },
];

function metricSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  const base = emptyMetricsSnapshot('campaign');
  return {
    ...base,
    status: 'available',
    window: { label: 'Current wave', start, end },
    updatedAt: end,
    variants: [
      { variantId: 'variant-a', totals: { impressions: 40, uniqueVisitors: 40, clicks: 8, signups: 3, spendCents: 40 } },
      { variantId: 'variant-b', totals: { impressions: 40, uniqueVisitors: 40, clicks: 5, signups: 1, spendCents: 40 } },
      { variantId: 'variant-c', totals: { impressions: 20, uniqueVisitors: 20, clicks: 2, signups: 0, spendCents: 20 } },
    ],
    totals: { impressions: 100, uniqueVisitors: 100, clicks: 15, signups: 4, spendCents: 100 },
    series: [],
    message: 'Experiment results.',
    ...overrides,
  };
}

afterEach(cleanup);

describe('version comparison chart model', () => {
  it('compares variants by views, clicks, and sign-ups instead of elapsed time', () => {
    const model = buildSignupChartModel({ metrics: metricSnapshot(), variants: variantRows });
    expect(model.hasData).toBe(true);
    expect(model.versions.map((version) => version.label)).toEqual(['A', 'B', 'C']);
    expect(model.versions[0]).toMatchObject({ impressions: 40, clicks: 8, signups: 3 });
    expect(model.versions[1]).toMatchObject({ impressions: 40, clicks: 5, signups: 1 });
    expect(model.versions[2]).toMatchObject({ impressions: 20, clicks: 2, signups: 0 });
    expect(model.totalImpressions).toBe(100);
    expect(model.totalClicks).toBe(15);
    expect(model.totalSignups).toBe(4);
    expect(model.metrics.map((metric) => metric.label)).toEqual(['Ad views', 'Clicks', 'Sign-ups']);
    expect(model.yMaximum).toBeGreaterThanOrEqual(40);
  });

  it('keeps zero-signup versions visible when totals exist', () => {
    const metrics = metricSnapshot({
      totals: { impressions: 12, uniqueVisitors: 12, clicks: 2, signups: 0, spendCents: 24 },
      variants: variantRows.map((variant) => ({
        variantId: variant.id,
        totals: { impressions: 4, uniqueVisitors: 4, clicks: 1, signups: 0, spendCents: 8 },
      })),
    });
    const model = buildSignupChartModel({ metrics, variants: variantRows });
    expect(model.hasData).toBe(true);
    expect(model.totalSignups).toBe(0);
    expect(model.versions).toHaveLength(3);
  });

  it('does not invent a chart when metrics are missing or unavailable', () => {
    expect(buildSignupChartModel({ metrics: null, variants: [] }).hasData).toBe(false);
    expect(buildSignupChartModel({
      metrics: metricSnapshot({ status: 'unavailable', variants: [] }),
      variants: variantRows,
    }).hasData).toBe(false);
  });
});

describe('version comparison chart display', () => {
  it('shows grouped metric bars and a totals table', () => {
    render(<SignupChart metrics={metricSnapshot()} variants={variantRows} loading={false} />);
    expect(screen.getByRole('img', { name: /Version comparison of ad views, clicks, and sign-ups/ })).toBeTruthy();
    expect(screen.getByText(/not a time series/i)).toBeTruthy();
    expect(screen.getByText('Metric by version')).toBeTruthy();
    expect(screen.getByText('A clear first headline')).toBeTruthy();
    expect(screen.getByText('A different second headline')).toBeTruthy();
    expect(screen.getByText('Click rate')).toBeTruthy();
  });

  it('explains an empty chart', () => {
    render(<SignupChart metrics={null} variants={[]} loading={false} />);
    expect(screen.getByText('No results yet')).toBeTruthy();
    expect(screen.getByText(/compare ad views, clicks, and sign-ups/i)).toBeTruthy();
  });
});
