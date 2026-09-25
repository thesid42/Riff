import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import type { AnalyticsClient } from '../server/providers/analytics.js';
import type { CreativeJudgmentWithMetadata, ExperimentDecisionWithMetadata } from '../server/providers/liquid.js';

const headlines = ['A 750 ml bottle for every day', 'Take 750 ml along for the day'];
const nextHeadlines = ['Carry 750 ml without the bulk', 'A bottle sized for your commute'];

/** `action` controls the persona verdict, which drives the measured click rate. */
function mockLiquid(action: 'click' | 'skip', decision: 'propose_test' | 'wait' = 'propose_test') {
  return {
    judgeCreative: vi.fn(async (): Promise<CreativeJudgmentWithMetadata> => ({
      judgment: {
        action,
        reason: 'A scoped reason.',
        dwellSeconds: 8,
        timeToActionSeconds: 4,
        confidence: 0.7,
        attention: 0.6,
        clarity: 0.8,
        trust: 0.5,
        purchaseIntent: 0.4,
        noticedFirst: 'headline',
        friction: 'none',
      },
      metadata: { elapsedMs: 120, usage: { promptTokens: 20, completionTokens: 30 } },
    })),
    proposeExperimentWithMetadata: vi.fn(async (): Promise<ExperimentDecisionWithMetadata> => ({
      decision: {
        action: decision,
        explanation: 'A scoped observation.',
        hypothesis: decision === 'propose_test' ? 'A shorter headline may raise sign-ups.' : '',
        headlines: decision === 'propose_test' ? nextHeadlines : [],
        evidenceIds: ['SEG-01'],
      },
      metadata: { elapsedMs: 80 },
    })),
  };
}

function mockAnalytics(overrides: Partial<AnalyticsClient> = {}): AnalyticsClient {
  return {
    provider: 'rawtree',
    ingest: vi.fn(async (events) => events.length),
    query: vi.fn(async () => []),
    querySeries: vi.fn(async () => []),
    ...overrides,
  } as AnalyticsClient;
}

describe('experiment loop', () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'riff-loop-'));
  });

  afterEach(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function startWave(agentCount = 8) {
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents: 5000 },
    });
    const id = created.json().campaign.id as string;
    const started = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/run`,
      payload: { agentCount, concurrency: 2, headlines },
    });
    expect(started.statusCode).toBe(200);
    return id;
  }

  const detailsFor = async (id: string) => (await app.inject({ method: 'GET', url: `/api/campaigns/${id}` })).json();

  it('chains rounds up to the cap and processes jobs in every one', async () => {
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      providers: { liquid: mockLiquid('skip', 'propose_test') as never, analytics: mockAnalytics(), videoEnabled: false },
      successClickRate: 0.7,
      maxAutoRounds: 3,
    });
    const id = await startWave();

    await vi.waitFor(async () => {
      const details = await detailsFor(id);
      expect(details.experiments).toHaveLength(3);
      expect(details.wave.runtime).toBe('idle');
      expect(details.wave.loopStatus?.reason).toBe('round_cap');
    }, { timeout: 15_000, interval: 100 });

    // The re-entrancy guard: every chained round must actually PROCESS its jobs. Asserting only
    // that experiment rows exist would pass even if pump() silently refused to start a worker.
    const details = await detailsFor(id);
    for (const experiment of details.experiments) {
      const jobs = details.wave.experimentId === experiment.id ? details.wave.progress : null;
      expect(experiment.status === 'completed' || experiment.status === 'inconclusive').toBe(true);
      if (jobs) expect(jobs.succeeded).toBeGreaterThan(0);
    }
    expect(details.wave.progress.succeeded).toBe(8);
    expect(details.lessons.length).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('stops as soon as a variant meets the click-rate threshold', async () => {
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      // Every persona clicks, so the measured rate is 100% and clears the threshold.
      providers: { liquid: mockLiquid('click', 'propose_test') as never, analytics: mockAnalytics(), videoEnabled: false },
      successClickRate: 0.7,
      maxAutoRounds: 3,
    });
    const id = await startWave();

    await vi.waitFor(async () => {
      const details = await detailsFor(id);
      expect(details.wave.runtime).toBe('idle');
      expect(details.wave.loopStatus?.reason).toBe('threshold_met');
    }, { timeout: 10_000, interval: 100 });

    const details = await detailsFor(id);
    expect(details.experiments).toHaveLength(1);
    expect(details.wave.loopStatus?.bestClickRate).toBeGreaterThanOrEqual(0.7);
    expect(details.wave.loopStatus?.threshold).toBe(0.7);
    // Step 6 still runs on the winning round, so the decision and lesson are recorded.
    expect(details.wave.latestDecision).not.toBeNull();
    expect(details.lessons).toHaveLength(1);
  }, 15_000);

  it('does not chain when Liquid asks to wait', async () => {
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      providers: { liquid: mockLiquid('skip', 'wait') as never, analytics: mockAnalytics(), videoEnabled: false },
      successClickRate: 0.7,
      maxAutoRounds: 3,
    });
    const id = await startWave();

    await vi.waitFor(async () => {
      const details = await detailsFor(id);
      expect(details.wave.runtime).toBe('idle');
      expect(details.wave.loopStatus?.reason).toBe('liquid_wait');
    }, { timeout: 10_000, interval: 100 });

    expect((await detailsFor(id)).experiments).toHaveLength(1);
  }, 15_000);

  it('falls back to local metrics and reports sqlite as the source when the store fails', async () => {
    const analytics = mockAnalytics({
      query: vi.fn(async () => { throw new Error('rawtree unreachable'); }),
    });
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      providers: { liquid: mockLiquid('click', 'wait') as never, analytics, videoEnabled: false },
      successClickRate: 0.99,
      maxAutoRounds: 1,
    });
    const id = await startWave();

    await vi.waitFor(async () => {
      expect((await detailsFor(id)).wave.runtime).toBe('idle');
    }, { timeout: 10_000, interval: 100 });

    const metrics = (await app.inject({ method: 'GET', url: `/api/campaigns/${id}/metrics` })).json();
    expect(metrics.source).toBe('sqlite');
    expect(metrics.totals.impressions).toBeGreaterThan(0);
    expect(metrics.message).toContain('rawtree unreachable');
  }, 15_000);

  it('reports rawtree as the source and exposes one chart per round', async () => {
    const variantId = '11111111-1111-4111-8111-111111111111';
    const analytics = mockAnalytics({
      query: vi.fn(async () => [
        { variantId, impressions: 40, uniqueVisitors: 40, clicks: 4, signups: 2, spendCents: 400 },
      ]),
      querySeries: vi.fn(async () => [
        { variantId, timestamp: '2026-01-01T00:00:00.000Z', signups: 1 },
        { variantId, timestamp: '2026-01-01T00:01:00.000Z', signups: 2 },
      ]),
    });
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      providers: { liquid: mockLiquid('skip', 'wait') as never, analytics, videoEnabled: false },
      successClickRate: 0.7,
      maxAutoRounds: 1,
    });
    const id = await startWave();

    await vi.waitFor(async () => {
      expect((await detailsFor(id)).wave.runtime).toBe('idle');
    }, { timeout: 10_000, interval: 100 });

    const metrics = (await app.inject({ method: 'GET', url: `/api/campaigns/${id}/metrics` })).json();
    expect(metrics.source).toBe('rawtree');
    expect(metrics.totals.impressions).toBe(40);
    expect(metrics.series).toHaveLength(2);

    const rounds = (await app.inject({ method: 'GET', url: `/api/campaigns/${id}/metrics/rounds` })).json();
    expect(rounds.rounds).toHaveLength(1);
    expect(rounds.rounds[0].round).toBe(1);
    expect(rounds.rounds[0].metrics.source).toBe('rawtree');
    expect(rounds.rounds[0].experiment.hypothesis).toBeTruthy();
  }, 15_000);
});
