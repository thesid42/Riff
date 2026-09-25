import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import type { AnalyticsClient } from '../server/providers/analytics.js';
import { ProviderError } from '../server/providers/common.js';
import type { CreativeJudgmentWithMetadata, ExperimentDecisionWithMetadata } from '../server/providers/liquid.js';

const judgment = (): CreativeJudgmentWithMetadata => ({
  judgment: {
    action: 'click',
    reason: 'The capacity headline is concrete.',
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
});

function mockLiquid() {
  return {
    judgeCreative: vi.fn(async () => judgment()),
    proposeExperimentWithMetadata: vi.fn(async (): Promise<ExperimentDecisionWithMetadata> => ({
      decision: {
        action: 'wait',
        explanation: 'Sample is enough to record a scoped observation, not a winner.',
        hypothesis: '',
        headlines: [],
        evidenceIds: ['SEG-01'],
        personaIds: [],
        needsNewCreative: false,
      },
      metadata: { elapsedMs: 80 },
    })),
  };
}

function mockAnalytics(): AnalyticsClient {
  return {
    provider: 'rawtree',
    ingest: vi.fn(async (events) => events.length),
    query: vi.fn(async () => []),
    querySeries: vi.fn(async () => []),
  };
}

describe('persona wave', () => {
  let directory: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'riff-run-'));
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      // One wave per test: a wait decision would otherwise chain collection rounds.
      maxAutoRounds: 1,
      providers: { liquid: mockLiquid() as never, analytics: mockAnalytics(), videoEnabled: false },
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('refuses a wave without two headlines', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents: 5000 },
    });
    const id = created.json().campaign.id as string;
    const response = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/run`, payload: { agentCount: 8, concurrency: 2 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('headlines_required');
  });

  it('persists Liquid headlines and starts a wave that writes analytics events', async () => {
    const analytics = mockAnalytics();
    const liquid = mockLiquid();
    await app.close();
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      // One wave per test: a wait decision would otherwise chain collection rounds.
      maxAutoRounds: 1,
      providers: { liquid: liquid as never, analytics, videoEnabled: false },
    });
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents: 5000 },
    });
    const id = created.json().campaign.id as string;
    const saved = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/headlines`,
      payload: { headlines: ['A 750 ml bottle for every day', 'Take 750 ml along for the day'] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().campaign.headlines).toHaveLength(2);

    const started = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/run`,
      payload: { agentCount: 8, concurrency: 2, headlines: ['A 750 ml bottle for every day', 'Take 750 ml along for the day'] },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().wave.runtime).toBe('running');
    expect(started.json().wave.progress.total).toBe(8);

    await vi.waitFor(async () => {
      const details = await app.inject({ method: 'GET', url: `/api/campaigns/${id}` });
      expect(details.json().wave.progress.succeeded + details.json().wave.progress.failed).toBe(8);
      expect(details.json().wave.runtime).toBe('idle');
      expect(details.json().wave.latestDecision?.action).toBe('wait');
    }, { timeout: 5_000 });

    const details = await app.inject({ method: 'GET', url: `/api/campaigns/${id}` });
    expect(details.json().variants).toHaveLength(2);
    expect(details.json().experiments).toHaveLength(1);
    expect(details.json().wave.segments.length).toBeGreaterThan(0);
    expect(liquid.judgeCreative).toHaveBeenCalled();
    const judgeInput = liquid.judgeCreative.mock.calls[0][0];
    expect(judgeInput.assignedHeadline).toBeTruthy();
    expect(judgeInput.siblingHeadlines.length).toBe(1);
    expect(analytics.ingest).toHaveBeenCalled();
    const metrics = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/metrics` });
    expect(metrics.json().totals.impressions).toBeGreaterThan(0);
    expect(metrics.json().decideTimeMedianMs).toBe(120);
    expect(details.json().wave.runtime).toBe('idle');
    expect(details.json().wave.latestDecision?.action).toBe('wait');
    expect(details.json().lessons).toHaveLength(1);
    expect(details.json().wave.deciderSpeed.fastSampleSize + details.json().wave.deciderSpeed.slowSampleSize).toBe(8);
    const ingested = (analytics.ingest as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as Array<{ event_type: string; audience_segment?: string; decision_latency_ms?: number }>);
    expect(ingested.some((event) => event.event_type === 'impression')).toBe(true);
    expect(ingested.filter((event) => event.event_type === 'impression').length).toBe(8);
    expect(ingested.filter((event) => event.event_type === 'signup').length)
      .toBeLessThanOrEqual(ingested.filter((event) => event.event_type === 'click').length);
    expect(ingested.every((event) => event.audience_segment && event.decision_latency_ms === 120)).toBe(true);
    expect(liquid.proposeExperimentWithMetadata).toHaveBeenCalledWith(expect.objectContaining({ stage: 'review' }));
  });

  it('keeps measured latency on failed jobs and does not invent a skip', async () => {
    const analytics = mockAnalytics();
    const liquid = {
      judgeCreative: vi.fn(async () => { throw new ProviderError('Liquid request failed with HTTP 500.', 'response'); }),
      proposeExperimentWithMetadata: vi.fn(),
    };
    await app.close();
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      // One wave per test: a wait decision would otherwise chain collection rounds.
      maxAutoRounds: 1,
      providers: { liquid: liquid as never, analytics, videoEnabled: false },
    });
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents: 5000 },
    });
    const id = created.json().campaign.id as string;
    const started = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/run`,
      payload: { agentCount: 8, concurrency: 2, headlines: ['A 750 ml bottle for every day', 'Take 750 ml along for the day'] },
    });
    expect(started.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const details = await app.inject({ method: 'GET', url: `/api/campaigns/${id}` });
      expect(details.json().wave.progress.failed).toBe(8);
    }, { timeout: 8_000 });
    const details = await app.inject({ method: 'GET', url: `/api/campaigns/${id}` });
    expect(details.json().wave.segments).toEqual([]);
    expect(details.json().wave.lastError).toBe('Liquid request failed with HTTP 500.');
    expect(analytics.ingest).not.toHaveBeenCalled();
    const metrics = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/metrics` });
    expect(metrics.json().totals.impressions).toBe(0);
    expect(liquid.proposeExperimentWithMetadata).not.toHaveBeenCalled();
  });

  it('saves a custom persona on the draft', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents: 5000 },
    });
    const id = created.json().campaign.id as string;
    const added = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/personas`,
      payload: { ageBand: '25-34', work: 'specialist', job: 'dentist', country: 'Spain', location: 'Madrid', language: 'Spanish', device: 'phone', household: 'partner' },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().persona.custom).toBe(true);
    expect(added.json().campaign.customPersonas).toHaveLength(1);
    expect(added.json().campaign.customPersonas[0].location).toBe('Madrid');
  });

  it('rejects manually submitted headlines over 60 characters with a clear message', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents: 5000 },
    });
    const id = created.json().campaign.id as string;
    const tooLong = 'x'.repeat(61);

    const saved = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/headlines`, payload: { headlines: [tooLong, 'A normal headline'] } });
    expect(saved.statusCode).toBe(400);
    expect(saved.json().error.message).toContain('60 characters');

    const started = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/run`, payload: { agentCount: 8, headlines: [tooLong, 'A normal headline'] } });
    expect(started.statusCode).toBe(400);
    expect(started.json().error.message).toContain('60 characters');
  });

  it('maps an explicitly selected creative batch to exact headline order and leaves later unselected waves text-only', async () => {
    await app.close();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const prompts = ['Bottle on a work desk.', 'Bottle by a commuter tote.'];
    const bfl = {
      submit: vi.fn(async (prompt: string) => ({ id: `task-${prompts.indexOf(prompt)}`, pollingUrl: `https://api.bfl.ai/v1/get_result?id=${prompts.indexOf(prompt)}` })),
      poll: vi.fn(async () => ({ status: 'Ready', downloadImage: async () => ({ bytes: png, contentType: 'image/png' as const }) })),
    };
    const analytics = mockAnalytics();
    const liquid = mockLiquid();
    app = createApp({
      databasePath: join(directory, 'campaigns.sqlite'),
      assetDir: join(directory, 'creative-assets'),
      providers: { liquid: liquid as never, analytics, bfl: bfl as never, videoEnabled: false },
    });
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Steel bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents: 5000 },
    });
    const campaignId = created.json().campaign.id as string;
    const headlines = ['Carry water with ease', 'A bottle for your workday'];
    await app.inject({ method: 'POST', url: `/api/campaigns/${campaignId}/headlines`, payload: { headlines } });
    const creative = await app.inject({
      method: 'POST', url: `/api/campaigns/${campaignId}/creative/images`,
      payload: {
        requestId: '44444444-4444-4444-8444-444444444444', headlines,
        imagePrompt: 'A clean product photograph of a steel bottle.', variantPrompts: prompts,
      },
    });
    expect(creative.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const listed = await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}/creative` });
      expect(listed.json().jobs[0].status).toBe('ready');
    });
    const job = (await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}/creative` })).json().jobs[0];

    const wrongOrder = await app.inject({
      method: 'POST', url: `/api/campaigns/${campaignId}/run`,
      payload: { creativeJobId: job.id, headlines: [...headlines].reverse(), agentCount: 8 },
    });
    expect(wrongOrder.statusCode).toBe(409);
    expect(wrongOrder.json().error.code).toBe('creative_headlines_mismatch');

    const otherCampaign = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Other', product: 'Other product', audience: 'Commuters', approvedClaims: [], budgetCents: 5000 },
    });
    const foreignJob = await app.inject({
      method: 'POST', url: `/api/campaigns/${otherCampaign.json().campaign.id}/run`,
      payload: { creativeJobId: job.id, headlines, agentCount: 8 },
    });
    expect(foreignJob.statusCode).toBe(409);
    expect(foreignJob.json().error.code).toBe('creative_job_mismatch');

    const started = await app.inject({
      method: 'POST', url: `/api/campaigns/${campaignId}/run`,
      payload: { creativeJobId: job.id, headlines, agentCount: 8, concurrency: 2 },
    });
    expect(started.statusCode).toBe(200);
    const selected = await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}` });
    const firstExperimentId = selected.json().wave.experimentId;
    expect(selected.json().variants.filter((variant: { experimentId: string }) => variant.experimentId === firstExperimentId)
      .map((variant: { imageUrl: string | null }) => variant.imageUrl)).toEqual(job.outputs.map((output: { imageUrl: string }) => output.imageUrl));
    expect(selected.json().experiments[0].hypothesis).toContain('complete campaign concepts');
    await vi.waitFor(async () => {
      const wave = await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}/wave` });
      expect(wave.json().wave.runtime).toBe('idle');
    }, { timeout: 5_000 });
    const visionCalls = liquid.judgeCreative.mock.calls.map((call) => call[0]);
    expect(visionCalls.some((input) => input.media?.mediaType === 'image' && input.media.contentType === 'image/png' && input.media.bytes.byteLength > 0)).toBe(true);
    expect(visionCalls.every((input) => input.mediaType === 'image')).toBe(true);

    const textOnly = await app.inject({
      method: 'POST', url: `/api/campaigns/${campaignId}/run`,
      payload: { headlines, agentCount: 8, concurrency: 2 },
    });
    expect(textOnly.statusCode).toBe(200);
    const secondDetails = await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}` });
    const secondExperimentId = secondDetails.json().wave.experimentId;
    expect(secondDetails.json().variants.filter((variant: { experimentId: string }) => variant.experimentId === secondExperimentId)
      .map((variant: { imageUrl: string | null; videoUrl: string | null }) => [variant.imageUrl, variant.videoUrl]))
      .toEqual([[null, null], [null, null]]);
    await vi.waitFor(async () => {
      const wave = await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}/wave` });
      expect(wave.json().wave.runtime).toBe('idle');
    }, { timeout: 5_000 });
    const textOnlyCalls = liquid.judgeCreative.mock.calls.slice(visionCalls.length).map((call) => call[0]);
    expect(textOnlyCalls.length).toBeGreaterThan(0);
    expect(textOnlyCalls.every((input) => input.media == null && !input.mediaType)).toBe(true);
    expect(bfl.submit).toHaveBeenCalledTimes(2);
  });

  it('refuses a wave when Liquid or analytics is missing', async () => {
    await app.close();
    app = createApp({ databasePath: join(directory, 'campaigns.sqlite'), providers: { videoEnabled: false } });
    const created = await app.inject({
      method: 'POST', url: '/api/campaigns',
      payload: { name: 'Bottle', product: 'Bottle', audience: 'Commuters', approvedClaims: ['750 ml'], budgetCents: 5000 },
    });
    const id = created.json().campaign.id as string;
    const response = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/run`,
      payload: { agentCount: 8, headlines: ['A 750 ml bottle for every day', 'Take 750 ml along for the day'] },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('liquid_unavailable');
  });
});
