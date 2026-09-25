// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MetricsSnapshot, Variant } from '../shared/types.js';
import { emptyMetricsSnapshot } from '../shared/types.js';
import SignupChart from '../src/SignupChart.js';
import { buildSignupChartModel } from '../src/signup-chart-model.js';

const start = '2026-09-25T16:00:00.000Z';
const middle = '2026-09-25T16:05:00.000Z';
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
    variants: variantRows.map((variant, index) => ({
      variantId: variant.id,
      totals: { impressions: 4, uniqueVisitors: 4, clicks: index ? 1 : 2, signups: index === 0 ? 2 : index === 1 ? 1 : 0, spendCents: 8 },
    })),
    totals: { impressions: 12, uniqueVisitors: 12, clicks: 4, signups: 3, spendCents: 24 },
    series: [
      { timestamp: middle, variantId: 'variant-a', signups: 2 },
      { timestamp: '2026-09-25T16:02:00.000Z', variantId: 'variant-a', signups: 1 },
      { timestamp: '2026-09-25T16:03:00.000Z', variantId: 'variant-b', signups: 1 },
    ],
    message: 'Local persona-wave results.',
    ...overrides,
  };
}

afterEach(cleanup);

describe('signup chart model', () => {
  it('sorts real timestamps, plots cumulative step counts from zero, and keeps zero-signup versions visible', () => {
    const historicalVersion: Variant = { ...variantRows[0]!, id: 'historical-a', headline: 'An older experiment headline' };
    const model = buildSignupChartModel({ metrics: metricSnapshot(), variants: [...variantRows, historicalVersion] });
    expect(model.hasData).toBe(true);
    expect(model.tracks.map((track) => track.label)).toEqual(['A', 'B', 'C']);
    expect(model.tracks[0]?.points.map((point) => [point.timestamp, point.signups])).toEqual([
      [start, 0], ['2026-09-25T16:02:00.000Z', 1], [middle, 2], [end, 2],
    ]);
    expect(model.tracks[1]?.points.map((point) => point.signups)).toEqual([0, 1, 1]);
    expect(model.tracks[2]?.points.map((point) => point.signups)).toEqual([0, 0]);
    expect(model.yTicks).toEqual([0, 1, 2]);
    expect(model.xTicks.map((tick) => tick.label)).toEqual(['0:00', '5:00', '10:00']);
    expect(model.totalSignups).toBe(3);

    const largerScale = buildSignupChartModel({ metrics: metricSnapshot({
      series: [{ timestamp: middle, variantId: 'variant-a', signups: 11 }],
    }), variants: variantRows });
    expect(largerScale.yMaximum).toBe(largerScale.yTicks.at(-1));
    expect(largerScale.yMaximum).toBe(12);
  });

  it('shows a measured zero result when variants were judged but none signed up', () => {
    const metrics = metricSnapshot({
      totals: { impressions: 12, uniqueVisitors: 12, clicks: 2, signups: 0, spendCents: 24 },
      variants: variantRows.map((variant) => ({ variantId: variant.id, totals: { impressions: 4, uniqueVisitors: 4, clicks: 1, signups: 0, spendCents: 8 } })),
      series: [],
    });
    const model = buildSignupChartModel({ metrics, variants: variantRows });
    expect(model.hasData).toBe(true);
    expect(model.totalSignups).toBe(0);
    expect(model.tracks).toHaveLength(3);
    expect(model.tracks.every((track) => track.points.every((point) => point.signups === 0))).toBe(true);

    const withoutStart = buildSignupChartModel({ metrics: metricSnapshot({
      window: { label: 'Current wave', start: null, end: null }, series: [], updatedAt: middle,
    }), variants: variantRows });
    expect(withoutStart.xAxisTitle).toContain('from first recorded result');
  });

  it('keeps a single recorded result at its actual timestamp without inventing a time span', () => {
    const metrics = metricSnapshot({
      window: { label: 'Current wave', start: null, end: null },
      updatedAt: middle,
      variants: [{ variantId: 'variant-a', totals: { impressions: 1, uniqueVisitors: 1, clicks: 1, signups: 1, spendCents: 8 } }],
      series: [{ timestamp: middle, variantId: 'variant-a', signups: 1 }],
    });
    const model = buildSignupChartModel({ metrics, variants: variantRows.slice(0, 1) });
    expect(model.domainStart).toBe(Date.parse(middle));
    expect(model.domainEnd).toBe(Date.parse(middle));
    expect(model.xTicks).toEqual([{ time: Date.parse(middle), label: '0s' }]);
    expect(model.tracks[0]?.points.at(-1)?.signups).toBe(1);
  });

  it('uses distinct elapsed-time tick labels for a one-minute window', () => {
    const metrics = metricSnapshot({
      window: { label: 'Current wave', start, end: '2026-09-25T16:01:00.000Z' },
      updatedAt: '2026-09-25T16:01:00.000Z',
      series: [{ timestamp: '2026-09-25T16:01:00.000Z', variantId: 'variant-a', signups: 1 }],
    });
    const model = buildSignupChartModel({ metrics, variants: variantRows.slice(0, 1) });
    expect(model.xTicks.map((tick) => tick.label)).toEqual(['0:00', '0:30', '1:00']);

    const millisecondModel = buildSignupChartModel({ metrics: metricSnapshot({
      window: { label: 'Current wave', start, end: '2026-09-25T16:00:00.001Z' },
      updatedAt: '2026-09-25T16:00:00.001Z',
      series: [{ timestamp: '2026-09-25T16:00:00.001Z', variantId: 'variant-a', signups: 1 }],
    }), variants: variantRows.slice(0, 1) });
    expect(millisecondModel.xTicks.map((tick) => tick.label)).toEqual(['0.0ms', '0.5ms', '1.0ms']);
  });

  it('does not turn absent or invalid timestamp data into a zero trend', () => {
    const empty = buildSignupChartModel({ metrics: null, variants: [] });
    expect(empty.hasData).toBe(false);
    expect(empty.tracks).toEqual([]);
    const invalid = buildSignupChartModel({
      metrics: metricSnapshot({ status: 'unavailable', series: [{ timestamp: 'not-a-time', variantId: 'variant-a', signups: 2 }] }),
      variants: variantRows,
    });
    expect(invalid.hasData).toBe(false);
  });
});

describe('signup chart display', () => {
  it('explains the simulated scope and exposes version, headline, axes, and latest values', () => {
    render(<SignupChart metrics={metricSnapshot()} variants={variantRows} loading={false} />);
    expect(screen.getByRole('img', { name: /Cumulative simulated sign-ups by version/ })).toBeTruthy();
    expect(screen.getByText(/not live customer sign-ups or ad performance/i)).toBeTruthy();
    expect(screen.getByText('Cumulative sign-ups (count)')).toBeTruthy();
    expect(screen.getByText('Elapsed time (minutes:seconds) from wave start')).toBeTruthy();
    expect(screen.getByText('A clear first headline')).toBeTruthy();
    expect(screen.getByText('A different second headline')).toBeTruthy();
    expect(screen.getByText('2', { selector: 'td' })).toBeTruthy();
    expect(screen.getByText('0', { selector: 'td' })).toBeTruthy();
  });

  it('explains an empty chart as no wave results yet', () => {
    render(<SignupChart metrics={null} variants={[]} loading={false} />);
    expect(screen.getByText('No wave results yet')).toBeTruthy();
    expect(screen.getByText('Start an experiment to record simulated sign-ups by version.')).toBeTruthy();
  });
});
