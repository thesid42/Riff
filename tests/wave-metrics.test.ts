import { describe, expect, it } from 'vitest';
import type { AgentJob } from '../shared/run.js';
import { deciderSpeed, lastJobError, latestJudgmentAt, segmentMetrics, totalsFromJobs } from '../server/wave-metrics.js';

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    campaignId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    experimentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    variantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    personaId: 'age-25-34-specialist',
    audienceSegment: 'age-25-34-specialist',
    status: 'succeeded',
    action: 'click',
    reason: 'Clear capacity.',
    dwellSeconds: 8,
    timeToActionSeconds: 4,
    confidence: 0.7,
    attention: 0.6,
    clarity: 0.8,
    trust: 0.5,
    purchaseIntent: 0.4,
    noticedFirst: 'headline',
    friction: 'none',
    elapsedMs: 100,
    queueWaitMs: 10,
    promptTokens: 20,
    completionTokens: 30,
    error: null,
    enqueuedAt: '2026-09-25T18:00:00.000Z',
    startedAt: '2026-09-25T18:00:01.000Z',
    finishedAt: '2026-09-25T18:00:02.000Z',
    ...overrides,
  };
}

describe('wave metrics', () => {
  it('reports the newest completed judgment even when jobs finish out of queue order', () => {
    expect(latestJudgmentAt([
      job({ finishedAt: '2026-09-25T18:00:09.000Z' }),
      job({ finishedAt: '2026-09-25T18:00:02.000Z' }),
      job({ status: 'failed', finishedAt: '2026-09-25T18:00:20.000Z' }),
      job({ finishedAt: 'invalid' }),
    ])).toBe('2026-09-25T18:00:09.000Z');
    expect(latestJudgmentAt([job({ status: 'pending', finishedAt: null })])).toBeNull();
  });

  it('rolls up action mix, dwell, scores, and notice-first without imputing failed jobs', () => {
    const jobs = [
      job({ id: '11111111-1111-4111-8111-111111111111', action: 'signup', elapsedMs: 80, dwellSeconds: 12 }),
      job({ id: '22222222-2222-4222-8222-222222222222', action: 'skip', elapsedMs: 200, dwellSeconds: 3, friction: 'busy' }),
      job({ id: '33333333-3333-4333-8333-333333333333', status: 'failed', action: null, elapsedMs: 400, reason: null }),
    ];
    const [segment] = segmentMetrics(jobs);
    expect(segment.sampleSize).toBe(2);
    expect(segment.skips).toBe(1);
    expect(segment.signups).toBe(1);
    expect(segment.medianDwellSeconds).toBe(7.5);
    expect(segment.averageAttention).toBe(0.6);
    expect(segment.noticedFirst.headline).toBe(2);
    expect(totalsFromJobs(jobs).impressions).toBe(2);
    expect(totalsFromJobs(jobs).signups).toBe(1);
    expect(lastJobError(jobs)).toBeNull();
    expect(lastJobError([job({ status: 'failed', error: 'Liquid response exhausted its completion token budget.', action: null })])).toBe('Liquid response exhausted its completion token budget.');
  });

  it('compares signup rate for fast versus slow deciders', () => {
    const jobs = [
      job({ id: '11111111-1111-4111-8111-111111111111', action: 'signup', elapsedMs: 50 }),
      job({ id: '22222222-2222-4222-8222-222222222222', action: 'signup', elapsedMs: 60 }),
      job({ id: '33333333-3333-4333-8333-333333333333', action: 'skip', elapsedMs: 200 }),
      job({ id: '44444444-4444-4444-8444-444444444444', action: 'skip', elapsedMs: 220 }),
    ];
    const speed = deciderSpeed(jobs);
    expect(speed.medianDecideMs).toBe(130);
    expect(speed.fastSampleSize).toBe(2);
    expect(speed.slowSampleSize).toBe(2);
    expect(speed.fastSignupRate).toBe(1);
    expect(speed.slowSignupRate).toBe(0);
  });
});
