import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CreativeImageJob } from '../shared/creative.js';
import { BflVideoClient, createProviders, getIntegrationStatuses, type BflClient, type LiquidClient } from '../server/providers/index.js';
import { ProviderError } from '../server/providers/index.js';
import { createApp } from '../server/app.js';
import { CampaignDatabase } from '../server/database.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const campaignInput = {
  name: 'Everyday Bottle',
  product: 'Sage green 750ml steel bottle',
  audience: 'People who bring water to work',
  approvedClaims: ['750ml capacity', 'Stainless steel'],
  budgetCents: 10_000,
};
const imageRequest = {
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  headlines: ['Carry water with ease', 'A bottle for your workday'],
  imagePrompt: 'A plain sage green steel bottle on a neutral tabletop, softly lit.',
};
const decision = {
  action: 'propose_test' as const,
  explanation: 'The saved brief supports a first controlled test.',
  hypothesis: 'A workday-focused headline may increase signups.',
  headlines: ['Carry water with ease', 'A bottle for your workday'],
  evidenceIds: [],
};

function fakeProviders(options: {
  submit?: (...args: any[]) => Promise<{ id: string; pollingUrl: string }>;
  poll?: (...args: any[]) => Promise<{ status: string; downloadImage?: () => Promise<{ bytes: Uint8Array; contentType: 'image/png' }> }>;
  plan?: (...args: any[]) => Promise<{ decision: typeof decision; metadata: { elapsedMs: number; model: string } }>;
} = {}) {
  const bfl = {
    submit: vi.fn(options.submit ?? (async () => ({ id: 'task-123', pollingUrl: 'https://api.bfl.ai/v1/get_result?id=task-123' }))),
    poll: vi.fn(options.poll ?? (async () => ({ status: 'Ready', downloadImage: async () => ({ bytes: png, contentType: 'image/png' as const }) }))),
  };
  const liquid = {
    proposeExperimentWithMetadata: vi.fn(options.plan ?? (async () => ({ decision, metadata: { elapsedMs: 5, model: 'test-model' } }))),
  };
  return { bfl, liquid, providers: { bfl: bfl as unknown as BflClient, liquid: liquid as unknown as LiquidClient } };
}

describe('creative composer API', () => {
  let directory: string;
  let databasePath: string;
  let assetDir: string;
  let app: FastifyInstance;
  let campaignId: string;

  // Media jobs run detached from the POST, so settle them before asserting the outcome.
  async function submitJob(id: string, path: 'images' | 'videos', payload: unknown) {
    const response = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/${path}`, payload });
    if (response.statusCode !== 200) return response;
    await app.waitForCreativeIdle();
    const jobId = response.json().job.id as string;
    const settled = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
    const job = (settled.json().jobs as CreativeImageJob[]).find((item) => item.id === jobId);
    return { statusCode: response.statusCode, json: () => ({ job }) } as typeof response;
  }

  async function createCampaign(): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/campaigns', payload: campaignInput });
    expect(response.statusCode).toBe(201);
    campaignId = response.json().campaign.id as string;
    return campaignId;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'riff-creative-'));
    databasePath = join(directory, 'campaigns.sqlite');
    assetDir = join(directory, 'creative-assets');
  });

  afterEach(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('GET creative is local-only and planning uses saved campaign context without calling BFL', async () => {
    const fixture = fakeProviders();
    app = createApp({ databasePath, assetDir, providers: fixture.providers });
    const id = await createCampaign();

    const get = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ jobs: [] });
    expect(get.json().imagePromptSuggestion).toContain(campaignInput.product);
    expect(get.json().imagePromptSuggestion).toContain(campaignInput.audience);
    expect(get.json().imagePromptSuggestion).toContain('neutral backdrop');
    expect(get.json().imagePromptSuggestion).toContain('unbranded');
    expect(fixture.bfl.submit).not.toHaveBeenCalled();
    expect(fixture.bfl.poll).not.toHaveBeenCalled();

    const plan = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/plan`, payload: {} });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toEqual({ decision, metadata: { elapsedMs: 5, model: 'test-model' } });
    const afterPlan = await app.inject({ method: 'GET', url: `/api/campaigns/${id}` });
    expect(afterPlan.json().campaign.headlines).toEqual(decision.headlines);
    expect((await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` })).json().headlines).toEqual(decision.headlines);
    expect(fixture.liquid.proposeExperimentWithMetadata).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'initial', evidence: [], lessons: [],
      brief: expect.stringContaining(`Approved claims: ${JSON.stringify(campaignInput.approvedClaims)}`),
    }), undefined);
    expect(fixture.bfl.submit).not.toHaveBeenCalled();
  });

  it('refuses an oversized saved Liquid brief without truncating approved claims or calling a provider', async () => {
    const fixture = fakeProviders();
    app = createApp({ databasePath, assetDir, providers: fixture.providers });
    const oversizedCampaign = { ...campaignInput, approvedClaims: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(300, 'x')) };
    const created = await app.inject({ method: 'POST', url: '/api/campaigns', payload: oversizedCampaign });
    expect(created.statusCode).toBe(201);
    const plan = await app.inject({ method: 'POST', url: `/api/campaigns/${created.json().campaign.id}/creative/plan`, payload: {} });
    expect(plan.statusCode).toBe(422);
    expect(plan.json().error.code).toBe('brief_too_long');
    expect(fixture.liquid.proposeExperimentWithMetadata).not.toHaveBeenCalled();
    expect(fixture.bfl.submit).not.toHaveBeenCalled();
  });

  it('validates explicit image requests before BFL, persists ready assets, and makes retries idempotent', async () => {
    const fixture = fakeProviders();
    app = createApp({ databasePath, assetDir, providers: fixture.providers, bflModel: 'flux-2-pro' });
    const id = await createCampaign();

    const bad = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: { ...imageRequest, headlines: ['Same', 'same'] } });
    expect(bad.statusCode).toBe(400);
    const malformed = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: { ...imageRequest, imagePrompt: 'x'.repeat(4_001) } });
    expect(malformed.statusCode).toBe(400);
    expect(fixture.bfl.submit).not.toHaveBeenCalled();

    const created = await submitJob(id, 'images', imageRequest);
    expect(created.statusCode).toBe(200);
    const job = created.json().job as CreativeImageJob;
    expect(job).toMatchObject({ id: imageRequest.requestId, campaignId: id, status: 'ready', imageUrl: `/api/creative-assets/${imageRequest.requestId}`, providerTaskId: 'task-123' });
    expect(job).toMatchObject({ mediaType: 'image', videoUrl: null, videoOptions: null });
    expect(job).not.toHaveProperty('pollingUrl');
    expect(job).not.toHaveProperty('model');
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(1);
    expect(fixture.bfl.submit).toHaveBeenCalledWith(imageRequest.imagePrompt, 1_024, 1_024, expect.any(AbortSignal));
    expect(fixture.bfl.poll).toHaveBeenCalledTimes(1);

    const duplicate = await submitJob(id, 'images', imageRequest);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().job).toEqual(job);
    const conflict = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: { ...imageRequest, imagePrompt: 'A changed prompt.' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(1);

    const asset = await app.inject({ method: 'GET', url: job.imageUrl! });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('image/png');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect(new Uint8Array(asset.rawPayload)).toEqual(png);
    expect((await app.inject({ method: 'GET', url: `/api/creative-assets/${'../'.repeat(5)}secret` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` })).json().jobs).toHaveLength(1);
  });

  it('marks unknown submit outcomes uncertain, sanitizes errors, blocks double submits, and never retries a reused key', async () => {
    const fixture = fakeProviders({ submit: async () => { throw new Error('private provider secret'); } });
    app = createApp({ databasePath, assetDir, providers: fixture.providers });
    const id = await createCampaign();

    const response = await submitJob(id, 'images', imageRequest);
    expect(response.statusCode).toBe(200);
    expect(response.json().job).toMatchObject({ status: 'uncertain', providerTaskId: null });
    expect(JSON.stringify(response.json())).not.toContain('private provider secret');
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(1);

    const duplicate = await submitJob(id, 'images', imageRequest);
    expect(duplicate.json().job.status).toBe('uncertain');
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(1);
    const otherKey = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: { ...imageRequest, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    });
    expect(otherKey.statusCode).toBe(409);
    expect(otherKey.json().error.code).toBe('campaign_media_job_active');
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(1);
  });

  it('runs distinct variant prompts sequentially, stores one asset per variant, and keeps retries idempotent', async () => {
    const prompts = [
      'A sage green bottle beside a folded work shirt, neutral studio light.',
      'A sage green bottle next to a notebook on a tidy desk, neutral studio light.',
      'A sage green bottle in a commuter tote, softly lit and unbranded.',
    ];
    const headlines = ['Carry water with ease', 'A bottle for your workday', 'Take your routine anywhere'];
    const fixture = fakeProviders({
      submit: vi.fn(async (prompt: string) => ({ id: `task-${prompts.indexOf(prompt)}`, pollingUrl: `https://api.bfl.ai/v1/get_result?id=${prompts.indexOf(prompt)}` })),
      poll: vi.fn(async () => ({ status: 'Ready', downloadImage: async () => ({ bytes: png, contentType: 'image/png' as const }) })),
    });
    app = createApp({ databasePath, assetDir, providers: fixture.providers });
    const id = await createCampaign();
    const request = { ...imageRequest, headlines, variantPrompts: prompts };
    const created = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: request });
    expect(created.statusCode).toBe(202);
    expect(created.json().job).toMatchObject({ visualMode: 'distinct', status: 'submitting' });
    expect(created.json().job.outputs).toHaveLength(3);
    expect(created.json().job.outputs.map((output: { status: string }) => output.status)).toEqual(['queued', 'queued', 'queued']);

    await vi.waitFor(async () => {
      const listed = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
      expect(listed.json().jobs[0].status).toBe('ready');
    });
    const job = (await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` })).json().jobs[0];
    expect(job).toMatchObject({ visualMode: 'distinct', status: 'ready', imageUrl: null, videoUrl: null });
    expect(job.outputs.map((output: { imagePrompt: string; headline: string; status: string; imageUrl: string }) => [output.imagePrompt, output.headline, output.status, output.imageUrl])).toEqual(
      prompts.map((prompt, index) => [prompt, headlines[index], 'ready', `/api/creative-assets/${job.outputs[index].id}`]),
    );
    expect(fixture.bfl.submit.mock.calls.map((call) => call[0])).toEqual(prompts);
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(3);
    for (const output of job.outputs) {
      const asset = await app.inject({ method: 'GET', url: output.imageUrl });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('image/png');
    }
    const duplicate = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: request });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().job.id).toBe(request.requestId);
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(3);
  });

  it('stops a distinct batch after a definite rejection and keeps ready child assets available', async () => {
    const prompts = ['First clean product scene.', 'Second clean product scene.', 'Third clean product scene.'];
    const fixture = fakeProviders({
      submit: vi.fn(async (prompt: string) => {
        if (prompt === prompts[1]) throw new ProviderError('BFL request failed with HTTP 402.');
        return { id: 'first-task', pollingUrl: 'https://api.bfl.ai/v1/get_result?id=first-task' };
      }),
    });
    app = createApp({ databasePath, assetDir, providers: fixture.providers });
    const id = await createCampaign();
    const request = {
      ...imageRequest,
      headlines: ['First headline', 'Second headline', 'Third headline'],
      variantPrompts: prompts,
    };
    const created = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: request });
    expect(created.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const listed = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
      expect(listed.json().jobs[0].status).toBe('failed');
    });
    const job = (await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` })).json().jobs[0];
    expect(job.outputs.map((output: { status: string }) => output.status)).toEqual(['ready', 'failed', 'skipped']);
    expect(job.outputs[1].error).toContain('HTTP 402');
    expect(fixture.bfl.submit.mock.calls.map((call) => call[0])).toEqual(prompts.slice(0, 2));
    const firstAsset = await app.inject({ method: 'GET', url: job.outputs[0].imageUrl });
    expect(firstAsset.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: job.outputs[1].imageUrl ?? `/api/creative-assets/${job.outputs[1].id}` })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: request });
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(2);
  });

  it('repairs both v5 schema layouts and preserves campaign data', async () => {
    app = createApp({ databasePath, assetDir, providers: fakeProviders().providers });
    const id = await createCampaign();
    await app.close();

    const interim = new DatabaseSync(databasePath);
    interim.exec('ALTER TABLE campaigns DROP COLUMN custom_personas; PRAGMA user_version = 5;');
    interim.close();
    app = createApp({ databasePath, assetDir });
    const preserved = await app.inject({ method: 'GET', url: `/api/campaigns/${id}` });
    expect(preserved.statusCode).toBe(200);
    expect(preserved.json().campaign.customPersonas).toEqual([]);
    await app.close();

    const upstreamV5 = new DatabaseSync(databasePath);
    upstreamV5.exec('DROP INDEX creative_job_outputs_job_order; DROP TABLE creative_job_outputs; ALTER TABLE creative_image_jobs DROP COLUMN visual_mode; PRAGMA user_version = 5;');
    upstreamV5.close();
    app = createApp({ databasePath, assetDir });
    const repaired = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().jobs).toEqual([]);
    const database = new CampaignDatabase(databasePath);
    expect(database.getCampaign(id)?.customPersonas).toEqual([]);
    expect(database.listCreativeJobs(id)).toEqual([]);
    database.close();
  });

  it('surfaces safe billing/auth rejection messages and returns the stored failure without a hidden retry', async () => {
    const fixture = fakeProviders({ submit: async () => { throw new ProviderError('BFL request failed with HTTP 402.'); } });
    app = createApp({ databasePath, assetDir, providers: fixture.providers });
    const id = await createCampaign();
    const result = await submitJob(id, 'images', imageRequest);
    expect(result.json().job).toMatchObject({ status: 'failed', error: 'The image provider reported insufficient credits (HTTP 402). No automatic retry was made.' });
    await submitJob(id, 'images', imageRequest);
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(1);
  });

  it('keeps video disabled by default and validates configurable video jobs before submit', async () => {
    const fixture = fakeProviders();
    app = createApp({ databasePath, assetDir, providers: fixture.providers });
    const id = await createCampaign();
    const get = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
    expect(get.json().capabilities).toEqual({ image: true, video: false });
    const disabled = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/creative/videos`,
      payload: { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', headlines: imageRequest.headlines, imagePrompt: imageRequest.imagePrompt },
    });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json().error.code).toBe('video_provider_unavailable');
  });

  it('creates the video adapter only when explicitly enabled and never probes the provider', () => {
    const urls: string[] = [];
    const fetch = async (input: RequestInfo | URL): Promise<Response> => { urls.push(String(input)); throw new Error('Unexpected network access.'); };
    const disabled = createProviders({ BFL_API_KEY: 'offline-fixture-key' }, fetch);
    expect(disabled.videoEnabled).toBe(false);
    expect(disabled.video).toBeUndefined();

    const enabled = createProviders({ BFL_API_KEY: 'offline-fixture-key', BFL_VIDEO_ENABLED: 'true', BFL_VIDEO_MODEL: 'flux-3-video' }, fetch);
    expect(enabled.videoEnabled).toBe(true);
    expect(enabled.video).toBeInstanceOf(BflVideoClient);
    expect(urls).toEqual([]);
    expect(getIntegrationStatuses({ BFL_API_KEY: 'offline-fixture-key', BFL_VIDEO_ENABLED: 'true', BFL_VIDEO_MODEL: 'flux-3-video' })
      .find(status => status.id === 'bfl')?.status).toBe('configured');
    expect(getIntegrationStatuses({ BFL_API_KEY: 'offline-fixture-key', BFL_VIDEO_ENABLED: 'yes' })
      .find(status => status.id === 'bfl')?.status).toBe('invalid');
  });

  it('submits an explicitly enabled video once, persists options/task first, and serves bounded MP4 ranges', async () => {
    const fixture = fakeProviders();
    const videoBytes = new Uint8Array([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    const video = {
      submit: vi.fn(async () => ({ id: 'video-task-123', pollingUrl: 'https://api.bfl.ai/v1/get_result?id=video-task-123' })),
      poll: vi.fn(async () => {
        const observer = new CampaignDatabase(databasePath);
        const persisted = observer.getCreativeJob('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
        observer.close();
        expect(persisted).toMatchObject({
          mediaType: 'video', status: 'generating', providerTaskId: 'video-task-123',
          videoOptions: { durationSeconds: 5, resolution: 'hd', aspectRatio: '1:1', generateAudio: false, draft: true },
        });
        return { status: 'Ready', downloadVideo: async () => ({ bytes: videoBytes, contentType: 'video/mp4' as const }) };
      }),
    };
    app = createApp({
      databasePath, assetDir, providers: { ...fixture.providers, video: video as never, videoEnabled: true }, bflVideoModel: 'flux-3-video',
    });
    const id = await createCampaign();
    const request = {
      requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      headlines: imageRequest.headlines,
      imagePrompt: 'A short product clip on a neutral studio set.',
    };
    const invalid = await app.inject({
      method: 'POST', url: `/api/campaigns/${id}/creative/videos`,
      payload: { ...request, videoOptions: { durationSeconds: 21, resolution: 'fhd', aspectRatio: '1:1', generateAudio: true, draft: true } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(video.submit).not.toHaveBeenCalled();

    const result = await submitJob(id, 'videos', request);
    expect(result.statusCode).toBe(200);
    const job = result.json().job as CreativeImageJob;
    expect(job).toMatchObject({
      mediaType: 'video', status: 'ready', imageUrl: null,
      videoUrl: `/api/creative-assets/${request.requestId}`,
      videoOptions: { durationSeconds: 5, resolution: 'hd', aspectRatio: '1:1', generateAudio: false, draft: true },
    });
    expect(video.submit).toHaveBeenCalledTimes(1);
    expect(video.submit).toHaveBeenCalledWith(request.imagePrompt, job.videoOptions, expect.any(AbortSignal));

    const range = await app.inject({ method: 'GET', url: job.videoUrl!, headers: { range: 'bytes=4-7' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 4-7/${videoBytes.byteLength}`);
    expect(new Uint8Array(range.rawPayload)).toEqual(videoBytes.subarray(4, 8));
    const duplicate = await submitJob(id, 'videos', request);
    expect(duplicate.json().job).toEqual(job);
    expect(video.submit).toHaveBeenCalledTimes(1);
  });

  it('submits distinct video prompts in order, serves each local MP4, and never resubmits a repeated key', async () => {
    const fixture = fakeProviders();
    const prompts = ['Bottle on a work desk.', 'Bottle by a commuter tote.'];
    const headlines = ['Carry water with ease', 'A bottle for your workday'];
    const options = { durationSeconds: 5, resolution: 'hd' as const, aspectRatio: '1:1' as const, generateAudio: false, draft: true };
    const videoBytes = new Uint8Array([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    const video = {
      submit: vi.fn(async (prompt: string, receivedOptions: typeof options) => ({ id: `video-${prompts.indexOf(prompt)}`, pollingUrl: `https://api.bfl.ai/v1/get_result?id=${prompts.indexOf(prompt)}` })),
      poll: vi.fn(async () => ({ status: 'Ready', downloadVideo: async () => ({ bytes: videoBytes, contentType: 'video/mp4' as const }) })),
    };
    app = createApp({ databasePath, assetDir, providers: { ...fixture.providers, video: video as never, videoEnabled: true }, bflVideoModel: 'flux-3-video' });
    const id = await createCampaign();
    const request = { ...imageRequest, headlines, imagePrompt: 'A neutral product clip.', variantPrompts: prompts, videoOptions: options };
    const created = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/videos`, payload: request });
    expect(created.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const listed = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
      expect(listed.json().jobs[0].status).toBe('ready');
    });
    const job = (await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` })).json().jobs[0];
    expect(job.outputs.map((output: { videoUrl: string; status: string }) => [output.videoUrl, output.status])).toEqual(
      job.outputs.map((output: { id: string }) => [`/api/creative-assets/${output.id}`, 'ready']),
    );
    expect(video.submit).toHaveBeenCalledTimes(2);
    expect(video.submit.mock.calls.map((call) => call[0])).toEqual(prompts);
    expect(video.submit.mock.calls.map((call) => call[1])).toEqual([options, options]);
    for (const output of job.outputs) {
      const range = await app.inject({ method: 'GET', url: output.videoUrl, headers: { range: 'bytes=4-7' } });
      expect(range.statusCode).toBe(206);
      expect(new Uint8Array(range.rawPayload)).toEqual(videoBytes.subarray(4, 8));
    }
    const duplicate = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/videos`, payload: request });
    expect(duplicate.statusCode).toBe(200);
    expect(video.submit).toHaveBeenCalledTimes(2);
  });

  it('aborts a sequential batch on shutdown without starting its remaining variants', async () => {
    const prompts = ['First scene.', 'Second scene.', 'Third scene.'];
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
    const fixture = fakeProviders({
      submit: vi.fn(async (prompt: string, _width: number, _height: number, signal: AbortSignal) => {
        if (prompt === prompts[1]) {
          secondStarted();
          return new Promise<{ id: string; pollingUrl: string }>((_resolve, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        return { id: 'first-task', pollingUrl: 'https://api.bfl.ai/v1/get_result?id=first-task' };
      }),
    });
    app = createApp({ databasePath, assetDir, providers: fixture.providers });
    const id = await createCampaign();
    const request = { ...imageRequest, headlines: ['One', 'Two', 'Three'], variantPrompts: prompts };
    const created = await app.inject({ method: 'POST', url: `/api/campaigns/${id}/creative/images`, payload: request });
    expect(created.statusCode).toBe(202);
    await secondStartedPromise;
    await app.close();

    const observer = new CampaignDatabase(databasePath);
    const persisted = observer.getCreativeJob(request.requestId)!;
    observer.close();
    expect(persisted.status).toBe('uncertain');
    expect(persisted.outputs.map((output) => output.status)).toEqual(['ready', 'uncertain', 'skipped']);
    expect(fixture.bfl.submit).toHaveBeenCalledTimes(2);
  });

  it('persists the provider task before polling and marks interrupted jobs uncertain after restart', async () => {
    app = createApp({ databasePath, assetDir, providers: fakeProviders().providers });
    const id = await createCampaign();
    await app.close();

    const database = new CampaignDatabase(databasePath);
    database.reserveCreativeJob({
      id: imageRequest.requestId, campaignId: id, requestHash: 'a'.repeat(64), headlines: imageRequest.headlines,
      imagePrompt: imageRequest.imagePrompt, model: 'flux-2-pro', mediaType: 'image', videoOptions: null, width: 1_024, height: 1_024,
      status: 'generating', imageUrl: null, videoUrl: null, error: null, providerTaskId: 'task-restarted',
      pollingUrl: 'https://api.bfl.ai/v1/get_result?id=task-restarted', contentType: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    database.close();

    app = createApp({ databasePath, assetDir });
    const creative = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
    expect(creative.json().jobs[0]).toMatchObject({ status: 'uncertain', providerTaskId: 'task-restarted' });
    expect(JSON.stringify(creative.json())).not.toContain('pollingUrl');
    const unavailableAsset = await app.inject({ method: 'GET', url: `/api/creative-assets/${imageRequest.requestId}` });
    expect(unavailableAsset.statusCode).toBe(404);
  });

  it('marks in-flight distinct outputs uncertain and queued outputs skipped after restart without resubmission', async () => {
    app = createApp({ databasePath, assetDir, providers: fakeProviders().providers });
    const id = await createCampaign();
    await app.close();
    const now = new Date().toISOString();
    const database = new CampaignDatabase(databasePath);
    database.reserveCreativeJob({
      id: imageRequest.requestId, campaignId: id, requestHash: 'b'.repeat(64), headlines: ['One headline', 'Two headline', 'Three headline'],
      imagePrompt: 'Base prompt.', model: 'flux-2-pro', mediaType: 'image', videoOptions: null, width: 1_024, height: 1_024,
      status: 'generating', imageUrl: null, videoUrl: null, error: null, providerTaskId: null, pollingUrl: null, contentType: null,
      createdAt: now, updatedAt: now, visualMode: 'distinct', outputs: [
        { id: '11111111-1111-4111-8111-111111111111', index: 0, headline: 'One headline', imagePrompt: 'One.', status: 'ready' },
        { id: '22222222-2222-4222-8222-222222222222', index: 1, headline: 'Two headline', imagePrompt: 'Two.', status: 'generating' },
        { id: '33333333-3333-4333-8333-333333333333', index: 2, headline: 'Three headline', imagePrompt: 'Three.', status: 'queued' },
      ],
    });
    database.close();

    app = createApp({ databasePath, assetDir });
    const listed = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
    expect(listed.json().jobs[0]).toMatchObject({ status: 'uncertain', visualMode: 'distinct' });
    expect(listed.json().jobs[0].outputs.map((output: { status: string }) => output.status)).toEqual(['ready', 'uncertain', 'skipped']);
    expect(listed.json().jobs[0].outputs[2].error).toContain('restarted');
    expect(JSON.stringify(listed.json())).not.toContain('pollingUrl');
  });

  it('migrates v2 image jobs into the media schema and marks interrupted tasks uncertain', async () => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT NOT NULL, audience TEXT NOT NULL,
        goal TEXT NOT NULL, approved_claims TEXT NOT NULL, budget_cents INTEGER NOT NULL,
        currency TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE creative_image_jobs (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL, headlines TEXT NOT NULL, image_prompt TEXT NOT NULL, model TEXT NOT NULL,
        width INTEGER NOT NULL CHECK (width = 1024), height INTEGER NOT NULL CHECK (height = 1024),
        status TEXT NOT NULL CHECK (status IN ('submitting', 'generating', 'ready', 'failed', 'uncertain')),
        image_url TEXT, error TEXT, provider_task_id TEXT, polling_url TEXT,
        content_type TEXT CHECK (content_type IS NULL OR content_type IN ('image/png', 'image/jpeg', 'image/webp')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX one_active_creative_job_per_campaign ON creative_image_jobs(campaign_id)
        WHERE status IN ('submitting', 'generating', 'uncertain');
      INSERT INTO campaigns VALUES ('${id}', 'Old campaign', 'Bottle', 'Workers', 'signups', '["750ml"]', 1000, 'USD', 'draft', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
      INSERT INTO creative_image_jobs VALUES (
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '${id}', '${'f'.repeat(64)}', '["Headline one","Headline two"]', 'A bottle on a table.', 'flux-2-pro',
        1024, 1024, 'generating', null, null, 'old-task', 'https://api.bfl.ai/v1/get_result?id=old-task', null,
        '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z'
      );
      PRAGMA user_version = 2;
    `);
    legacy.close();

    app = createApp({ databasePath, assetDir });
    const response = await app.inject({ method: 'GET', url: `/api/campaigns/${id}/creative` });
    expect(response.statusCode).toBe(200);
    expect(response.json().jobs[0]).toMatchObject({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', mediaType: 'image', status: 'uncertain',
      videoUrl: null, videoOptions: null, providerTaskId: 'old-task',
    });
    expect(response.json().jobs[0]).not.toHaveProperty('pollingUrl');
  });
});
