import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import { checkRules } from '../server/experiment-run.js';
import type { AnalyticsClient } from '../server/providers/analytics.js';
import type { BflClient } from '../server/providers/index.js';
import type { CreativeJudgmentWithMetadata, ExperimentContext, ExperimentDecisionWithMetadata } from '../server/providers/liquid.js';

const headlines = ['A 750 ml bottle for every day', 'Take 750 ml along for the day'];
const nextHeadlines = ['Carry 750 ml without the bulk', 'A bottle sized for your commute'];
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

type Decision = ExperimentDecisionWithMetadata['decision'];

/**
 * `action` controls the persona verdict, which drives the measured click rate. `decide` shapes the
 * review decision from the context Liquid received, so tests can pick supplied persona IDs.
 */
function mockLiquid(action: 'click' | 'skip', decision: 'propose_test' | 'wait' | ((context: ExperimentContext) => Partial<Decision>) = 'propose_test') {
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
    proposeExperimentWithMetadata: vi.fn(async (context: ExperimentContext): Promise<ExperimentDecisionWithMetadata> => {
      const base: Decision = decision === 'wait'
        ? { action: 'wait', explanation: 'Too little evidence yet.', hypothesis: '', headlines: [], evidenceIds: ['SEG-01'], personaIds: [], needsNewCreative: false }
        : { action: 'propose_test', explanation: 'A scoped observation.', hypothesis: 'A shorter headline may raise sign-ups.', headlines: nextHeadlines, evidenceIds: ['SEG-01'], personaIds: [], needsNewCreative: false };
      return { decision: { ...base, ...(typeof decision === 'function' ? decision(context) : {}) }, metadata: { elapsedMs: 80 } };
    }),
  };
}

/** A BFL stand-in behind the real CreativeService, so generated images get real asset URLs. */
function mockBfl(status: 'Ready' | 'Failed' = 'Ready') {
  let task = 0;
  return {
    submit: vi.fn(async () => { task += 1; return { id: `task-${task}`, pollingUrl: `https://api.bfl.ai/v1/get_result?id=task-${task}` }; }),
    poll: vi.fn(async () => status === 'Ready'
      ? { status, downloadImage: async () => ({ bytes: png, contentType: 'image/png' as const }) }
      : { status }),
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

  async function createCampaign(budgetCents = 5000) {
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents },
    });
    return created.json().campaign.id as string;
  }

  async function startWave(agentCount = 8, options: { id?: string; creativeJobId?: string; budgetCents?: number } = {}) {
    const id = options.id ?? await createCampaign(options.budgetCents);
    const started = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/run`,
      payload: { agentCount, concurrency: 2, headlines, ...(options.creativeJobId ? { creativeJobId: options.creativeJobId } : {}) },
    });
    expect(started.statusCode).toBe(200);
    return id;
  }

  /** Generates one distinct image per starting headline, as the composer would before round 1. */
  async function startingCreative(id: string) {
    const response = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/creative/images`,
      payload: {
        requestId: randomUUID(),
        headlines,
        imagePrompt: 'A plain steel bottle on a neutral backdrop.',
        variantPrompts: ['A steel bottle, hero view.', 'A steel bottle, wide frame.'],
      },
    });
    expect(response.statusCode).toBeLessThan(300);
    await app.waitForCreativeIdle();
    return response.json().job.id as string;
  }

  function loopApp(liquid: ReturnType<typeof mockLiquid>, options: { bfl?: ReturnType<typeof mockBfl>; maxAutoRounds?: number } = {}) {
    return createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      assetDir: join(directory, 'assets'),
      providers: { liquid: liquid as never, analytics: mockAnalytics(), bfl: options.bfl as unknown as BflClient | undefined, videoEnabled: false },
      successClickRate: 0.7,
      maxAutoRounds: options.maxAutoRounds ?? 3,
      autoCreative: true,
      creativePollMs: 20,
    });
  }

  async function waitForStop(id: string, reason: string, timeout = 15_000) {
    await vi.waitFor(async () => {
      const details = await detailsFor(id);
      expect(details.wave.runtime).toBe('idle');
      expect(details.wave.loopStatus?.reason).toBe(reason);
    }, { timeout, interval: 100 });
    return detailsFor(id);
  }

  const detailsFor = async (id: string) => (await app.inject({ method: 'GET', url: `/api/campaigns/${id}` })).json();
  const roundsFor = async (id: string) => (await app.inject({ method: 'GET', url: `/api/campaigns/${id}/metrics/rounds` })).json().rounds as Array<{
    round: number;
    creative: string;
    personas: Array<{ id: string }>;
    media: Array<{ headline: string; imageUrl: string | null }>;
  }>;

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

  it('keeps collecting on the same experiment when Liquid waits below the threshold', async () => {
    const bfl = mockBfl();
    app = loopApp(mockLiquid('skip', 'wait'), { bfl });
    const id = await startWave();
    const details = await waitForStop(id, 'round_cap');

    // Collection waves count toward the cap, keep the tested headlines, and make no image call.
    expect(details.experiments).toHaveLength(3);
    expect(details.campaign.headlines).toEqual(headlines);
    expect(new Set(details.variants.map((variant: { headline: string }) => variant.headline))).toEqual(new Set(headlines));
    expect(bfl.submit).not.toHaveBeenCalled();
    expect((await roundsFor(id)).slice(0, 2).map((round) => round.creative)).toEqual(['text-only', 'text-only']);
  }, 20_000);

  it('stops with threshold_met when Liquid waits but the click rate already clears the threshold', async () => {
    app = loopApp(mockLiquid('click', 'wait'));
    const id = await startWave();
    const details = await waitForStop(id, 'threshold_met');
    expect(details.experiments).toHaveLength(1);
  }, 15_000);

  it('generates new images for the new headlines when Liquid asks for new creative', async () => {
    const bfl = mockBfl();
    app = loopApp(mockLiquid('skip', () => ({ needsNewCreative: true })), { bfl, maxAutoRounds: 2 });
    const id = await createCampaign();
    await startWave(8, { id, creativeJobId: await startingCreative(id) });
    const details = await waitForStop(id, 'round_cap');

    // Two images for round 1, two more for round 2, each prompted for one of the new headlines.
    expect(bfl.submit).toHaveBeenCalledTimes(4);
    expect(bfl.submit.mock.calls.slice(2).map((call) => call[0])).toEqual(nextHeadlines.map((headline) => expect.stringContaining(headline)));
    const [second, first] = await roundsFor(id);
    expect(first!.creative).toBe('initial');
    expect(second!.creative).toBe('new');
    expect(second!.media.map((item) => item.headline)).toEqual(nextHeadlines);
    // The proof that new creative reached the wave: round 2's variants carry different images.
    const firstUrls = first!.media.map((item) => item.imageUrl);
    const secondUrls = second!.media.map((item) => item.imageUrl);
    expect(firstUrls.every(Boolean) && secondUrls.every(Boolean)).toBe(true);
    expect(secondUrls.some((url) => firstUrls.includes(url))).toBe(false);
    expect(details.decisions.at(-1).creativeOutcome).toBe('new');
  }, 20_000);

  it('reuses the images without a BFL call when Liquid keeps the headlines and asks for no new creative', async () => {
    const bfl = mockBfl();
    app = loopApp(mockLiquid('skip', () => ({ headlines, needsNewCreative: false })), { bfl, maxAutoRounds: 2 });
    const id = await createCampaign();
    await startWave(8, { id, creativeJobId: await startingCreative(id) });
    await waitForStop(id, 'round_cap');

    expect(bfl.submit).toHaveBeenCalledTimes(2);
    const [second, first] = await roundsFor(id);
    expect(second!.creative).toBe('reused');
    expect(second!.media.map((item) => item.imageUrl)).toEqual(first!.media.map((item) => item.imageUrl));
  }, 20_000);

  it('generates anyway when the headlines changed, even if Liquid asked to reuse', async () => {
    const bfl = mockBfl();
    app = loopApp(mockLiquid('skip', () => ({ needsNewCreative: false })), { bfl, maxAutoRounds: 2 });
    const id = await createCampaign();
    await startWave(8, { id, creativeJobId: await startingCreative(id) });
    await waitForStop(id, 'round_cap');

    // Round 1's images were made for different headlines, so reusing them would be invalid.
    expect(bfl.submit).toHaveBeenCalledTimes(4);
    expect((await roundsFor(id))[0]!.creative).toBe('new');
  }, 20_000);

  it('stops with creative_failed and starts no round when generation fails', async () => {
    const bfl = mockBfl('Failed');
    app = loopApp(mockLiquid('skip', () => ({ needsNewCreative: true })), { bfl });
    const id = await startWave();
    const details = await waitForStop(id, 'creative_failed');

    expect(bfl.submit).toHaveBeenCalled();
    expect(details.experiments).toHaveLength(1);
    expect(details.wave.loopStatus.message).toContain('no round was started');
  }, 15_000);

  it('stops with rules_failed and keeps the tested headlines when a proposal cites an unapproved claim', async () => {
    app = loopApp(mockLiquid('skip', () => ({ headlines: ['Keeps drinks cold for 24 hours', 'A 750 ml bottle for the commute'] })));
    const id = await startWave();
    const details = await waitForStop(id, 'rules_failed');

    expect(details.wave.loopStatus.message).toContain('"24"');
    expect(details.campaign.headlines).toEqual(headlines);
    expect(details.experiments).toHaveLength(1);
  }, 15_000);

  it('stops with rules_failed when the next round could exceed the budget', async () => {
    app = loopApp(mockLiquid('skip', 'propose_test'));
    // Round 1 spends 16 cents; a second 8-agent round could spend 80 more, past a 50 cent budget.
    const id = await startWave(8, { budgetCents: 50 });
    const details = await waitForStop(id, 'rules_failed');

    expect(details.wave.loopStatus.message).toContain('budget');
    expect(details.campaign.headlines).toEqual(headlines);
    expect(details.experiments).toHaveLength(1);
  }, 15_000);

  it('runs the next round only against the personas Liquid names', async () => {
    let chosen = '';
    app = loopApp(mockLiquid('skip', (context) => {
      chosen = context.personas![0]!.id;
      return { personaIds: [chosen] };
    }), { maxAutoRounds: 2 });
    const id = await startWave();
    const details = await waitForStop(id, 'round_cap');

    const [second, first] = await roundsFor(id);
    expect(first!.personas.length).toBeGreaterThan(1);
    // Round personas are read from the stored agent_jobs, so every job targeted the chosen persona.
    expect(second!.personas.map((persona) => persona.id)).toEqual([chosen]);
    expect(details.wave.progress.total).toBe(8);
    expect(details.wave.segments.map((segment: { segment: string }) => segment.segment)).toEqual([chosen]);
    expect(details.decisions.at(-1).personaIds).toEqual([chosen]);
  }, 20_000);

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

describe('checkRules', () => {
  const campaign = { approvedClaims: ['750 ml capacity', 'Stainless steel'], budgetCents: 5000 };

  it('passes claim-safe headlines within budget', () => {
    expect(checkRules(campaign, ['A 750 ml steel bottle', 'Stainless steel for the commute'], 100, 8)).toBeNull();
  });

  it('flags unapproved numbers and claim words, but allows words an approved claim uses', () => {
    expect(checkRules(campaign, ['Save 20% today', 'A 750 ml bottle'], 0, 8)).toContain('"20"');
    expect(checkRules(campaign, ['Guaranteed to last', 'A 750 ml bottle'], 0, 8)).toContain('"guaranteed"');
    expect(checkRules({ ...campaign, approvedClaims: ['Guaranteed for life'] }, ['Guaranteed quality', 'A steel bottle'], 0, 8)).toBeNull();
  });

  it('rejects invalid headline sets and projected overspend', () => {
    expect(checkRules(campaign, ['Only one'], 0, 8)).toContain('2 or 3 unique headlines');
    expect(checkRules(campaign, ['A steel bottle', 'A bottle of steel'], 4950, 8)).toContain('budget');
  });
});
