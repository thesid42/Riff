import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  campaignInputSchema,
  type IntegrationStatus,
} from '../shared/types.js';
import { persistHeadlinesSchema, runWaveSchema } from '../shared/run.js';
import { createCustomPersona, customPersonaSchema } from '../shared/personas.js';
import { creativeImageRequestSchema, creativeVideoRequestSchema } from '../shared/creative.js';
import { CampaignDatabase } from './database.js';
import { createProviders, getIntegrationStatuses, type Providers } from './providers/index.js';
import { CreativeService, CreativeServiceError } from './creative.js';
import { ExperimentRunService, RunServiceError } from './experiment-run.js';

export interface CreateAppOptions {
  databasePath?: string;
  assetDir?: string;
  integrations?: IntegrationStatus[];
  providers?: Partial<Pick<Providers, 'liquid' | 'analytics' | 'bfl' | 'video' | 'videoEnabled'>>;
  bflModel?: string;
  bflVideoModel?: string;
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const databasePath = options.databasePath ?? resolve(process.cwd(), '.data', 'riff.sqlite');
  const database = new CampaignDatabase(databasePath);
  const providers = options.providers ?? createProviders();
  const creative = new CreativeService({
    database,
    assetDirectory: options.assetDir ?? resolve(process.cwd(), '.data', 'creative-assets'),
    liquid: providers.liquid,
    bfl: providers.bfl,
    video: providers.video,
    videoEnabled: options.providers?.videoEnabled ?? providers.videoEnabled ?? false,
    videoModel: options.bflVideoModel?.trim() || process.env.BFL_VIDEO_MODEL?.trim() || 'flux-3-video',
    bflModel: options.bflModel?.trim() || process.env.BFL_MODEL?.trim() || 'flux-2-pro',
  });
  const runner = new ExperimentRunService({
    database,
    liquid: providers.liquid,
    analytics: providers.analytics,
  });
  database.markInterruptedCreativeJobs(new Date().toISOString());
  runner.recover();
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    let hostUrl: URL | undefined;
    try {
      if (host) hostUrl = new URL(`http://${host}`);
    } catch { /* Invalid Host is rejected below. */ }
    const hostname = hostUrl?.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostUrl || hostUrl.username || hostUrl.password || hostUrl.pathname !== '/' || hostUrl.search || hostUrl.hash ||
      !['localhost', '127.0.0.1', '[::1]'].includes(hostname ?? '')) {
      return reply.code(403).send({ error: { code: 'host_forbidden', message: 'Request host is not allowed.' } });
    }
    if (request.method !== 'POST') return;
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: { code: 'origin_forbidden', message: 'Cross-site requests are not allowed.' } });
    }
    const origin = request.headers.origin;
    const developmentOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
    let normalizedOrigin: string | undefined;
    try {
      if (origin) {
        const originUrl = new URL(origin);
        if (originUrl.username || originUrl.password || originUrl.pathname !== '/' || originUrl.search || originUrl.hash) {
          throw new Error('Origin must be an origin only.');
        }
        normalizedOrigin = originUrl.origin;
      }
    } catch { /* An invalid Origin is rejected below. */ }
    if (origin && normalizedOrigin !== `http://${hostUrl.host}` && !developmentOrigins.has(normalizedOrigin ?? '')) {
      return reply.code(403).send({ error: { code: 'origin_forbidden', message: 'Request origin is not allowed.' } });
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return reply.code(415).send({ error: { code: 'json_required', message: 'Send a JSON request body.' } });
    }
  });

  app.get('/api/health', async () => ({
    status: 'ok' as const,
    mode: 'foundation' as const,
    simulationEnabled: false as const,
  }));

  app.get('/api/campaigns', async () => ({ campaigns: database.listCampaigns() }));

  app.post('/api/campaigns', async (request, reply) => {
    const parsed = campaignInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Campaign details are invalid.',
          issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
        },
      });
    }
    const now = new Date().toISOString();
    const campaign = database.createCampaign(randomUUID(), parsed.data, now);
    return reply.code(201).send({ campaign });
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id', async (request, reply) => {
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    return runner.details(campaign);
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/metrics', async (request, reply) => {
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    return runner.metrics(campaign);
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/wave', async (request, reply) => {
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    return { wave: runner.snapshot(campaign) };
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/headlines', async (request, reply) => {
    const parsed = persistHeadlinesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'validation_error', message: 'Provide 2 or 3 unique headlines.' } });
    }
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    try { return { campaign: runner.persistHeadlines(campaign, parsed.data.headlines) }; }
    catch (error) { return sendRunError(reply, error); }
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/personas', async (request, reply) => {
    const parsed = customPersonaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'validation_error', message: 'Persona details are invalid.' } });
    }
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    if (campaign.customPersonas.length >= 24) {
      return reply.code(400).send({ error: { code: 'persona_limit', message: 'This draft already has 24 custom personas.' } });
    }
    const added = createCustomPersona(parsed.data, randomUUID());
    const next = database.setCustomPersonas(campaign.id, [...campaign.customPersonas, added], new Date().toISOString());
    return { campaign: next, persona: added };
  });

  app.post<{ Params: { id: string; personaId: string } }>('/api/campaigns/:id/personas/:personaId/delete', async (request, reply) => {
    if (!isEmptyObject(request.body)) return reply.code(400).send({ error: { code: 'validation_error', message: 'The delete request must be an empty JSON object.' } });
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    const next = campaign.customPersonas.filter((persona) => persona.id !== request.params.personaId);
    if (next.length === campaign.customPersonas.length) return notFound(reply, 'Persona');
    return { campaign: database.setCustomPersonas(campaign.id, next, new Date().toISOString()) };
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/run', async (request, reply) => {
    const parsed = runWaveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'validation_error', message: 'Wave settings are invalid.' } });
    }
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    try {
      const selectedHeadlines = parsed.data.headlines?.length ? parsed.data.headlines : campaign.headlines;
      let media: Array<{ imageUrl: string | null; videoUrl: string | null }> = selectedHeadlines.map(() => ({ imageUrl: null, videoUrl: null }));
      let visualMode: 'shared' | 'distinct' | 'text-only' = 'text-only';
      if (parsed.data.creativeJobId) {
        const job = database.getCreativeJob(parsed.data.creativeJobId);
        if (!job || job.campaignId !== campaign.id) throw new RunServiceError(409, 'creative_job_mismatch', 'The selected creative job does not belong to this campaign.');
        if (job.status !== 'ready') throw new RunServiceError(409, 'creative_job_not_ready', 'The selected creative job is not ready to use.');
        if (job.headlines.length !== selectedHeadlines.length || job.headlines.some((headline, index) => headline !== selectedHeadlines[index])) {
          throw new RunServiceError(409, 'creative_headlines_mismatch', 'The selected creative job was created for a different headline order.');
        }
        visualMode = job.visualMode;
        if (job.visualMode === 'distinct') {
          if (job.outputs.length !== selectedHeadlines.length || job.outputs.some((output, index) =>
            output.index !== index || output.headline !== selectedHeadlines[index] || output.status !== 'ready' ||
            (job.mediaType === 'image' ? !output.imageUrl || !!output.videoUrl : !output.videoUrl || !!output.imageUrl))) {
            throw new RunServiceError(409, 'creative_job_not_ready', 'Every selected creative variant must be ready before starting the wave.');
          }
          media = job.outputs.map((output) => ({ imageUrl: output.imageUrl, videoUrl: output.videoUrl }));
        } else {
          if (job.mediaType === 'image' ? !job.imageUrl || !!job.videoUrl : !job.videoUrl || !!job.imageUrl) {
            throw new RunServiceError(409, 'creative_job_not_ready', 'The selected creative job has no ready local media asset.');
          }
          media = selectedHeadlines.map(() => ({ imageUrl: job.imageUrl, videoUrl: job.videoUrl }));
        }
      }
      return { wave: await runner.start(campaign, parsed.data, media, visualMode) };
    } catch (error) { return sendRunError(reply, error); }
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/pause', async (request, reply) => {
    if (!isEmptyObject(request.body)) return reply.code(400).send({ error: { code: 'validation_error', message: 'The pause request must be an empty JSON object.' } });
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    try { return { wave: runner.pause(campaign) }; }
    catch (error) { return sendRunError(reply, error); }
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/resume', async (request, reply) => {
    if (!isEmptyObject(request.body)) return reply.code(400).send({ error: { code: 'validation_error', message: 'The resume request must be an empty JSON object.' } });
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    try { return { wave: runner.resume(campaign) }; }
    catch (error) { return sendRunError(reply, error); }
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/creative', async (request, reply) => {
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    return creative.getCampaignCreative(campaign);
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/creative/plan', async (request, reply) => {
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    if (!isEmptyObject(request.body)) return reply.code(400).send({ error: { code: 'validation_error', message: 'The plan request must be an empty JSON object.' } });
    try { return await creative.plan(campaign); }
    catch (error) { return sendCreativeError(reply, error); }
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/creative/images', async (request, reply) => {
    const parsed = creativeImageRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Image job details are invalid.',
          issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
        },
      });
    }
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    try {
      const job = await creative.createImageJob(campaign, parsed.data);
      return reply.code(job.visualMode === 'distinct' && (job.status === 'submitting' || job.status === 'generating') ? 202 : 200).send({ job });
    }
    catch (error) { return sendCreativeError(reply, error); }
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/creative/videos', async (request, reply) => {
    const parsed = creativeVideoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Video job details are invalid.',
          issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
        },
      });
    }
    const campaign = database.getCampaign(request.params.id);
    if (!campaign) return notFound(reply, 'Campaign');
    try {
      const job = await creative.createVideoJob(campaign, parsed.data);
      return reply.code(job.visualMode === 'distinct' && (job.status === 'submitting' || job.status === 'generating') ? 202 : 200).send({ job });
    }
    catch (error) { return sendCreativeError(reply, error); }
  });

  app.get<{ Params: { jobId: string } }>('/api/creative-assets/:jobId', async (request, reply) => {
    const asset = await creative.getAsset(request.params.jobId);
    if (!asset) return notFound(reply, 'Creative asset');
    reply.header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=3600');
    if (asset.mediaType === 'video') {
      reply.header('accept-ranges', 'bytes');
      const range = request.headers.range;
      if (range) {
        const parsed = parseByteRange(range, asset.bytes.byteLength);
        if (!parsed) return reply.code(416).header('content-range', `bytes */${asset.bytes.byteLength}`).send();
        const { start, end } = parsed;
        return reply.code(206).header('content-range', `bytes ${start}-${end}/${asset.bytes.byteLength}`)
          .header('content-length', String(end - start + 1)).type(asset.contentType).send(asset.bytes.subarray(start, end + 1));
      }
    }
    return reply.type(asset.contentType).send(asset.bytes);
  });

  app.get('/api/integrations', async () => ({
    integrations: options.integrations ?? getIntegrationStatuses(),
  }));

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/lessons', async (request, reply) => {
    if (!database.getCampaign(request.params.id)) return notFound(reply, 'Campaign');
    return { lessons: database.listLessons(request.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/experiments', async (request, reply) => {
    if (!database.getCampaign(request.params.id)) return notFound(reply, 'Campaign');
    return { experiments: database.listExperiments(request.params.id) };
  });

  app.setErrorHandler((error, _request, reply) => {
    const candidateStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof candidateStatus === 'number' && candidateStatus >= 400 && candidateStatus < 500 ? candidateStatus : 500;
    app.log.error({ statusCode }, 'Request failed');
    const clientErrors: Record<number, { code: string; message: string }> = {
      400: { code: 'bad_request', message: 'The request body could not be parsed.' },
      413: { code: 'payload_too_large', message: 'The request body is too large.' },
      415: { code: 'unsupported_media_type', message: 'Send a JSON request body.' },
    };
    const safeError = clientErrors[statusCode] ?? { code: 'internal_error', message: 'The request could not be completed.' };
    return reply.code(statusCode).send({ error: safeError });
  });

  app.addHook('preClose', async () => {
    await Promise.all([runner.close(), creative.close()]);
  });
  app.addHook('onClose', async () => {
    await Promise.all([runner.close(), creative.close()]);
    database.close();
  });
  return app;
}

function notFound(reply: FastifyReply, entity: string): FastifyReply {
  return reply.code(404).send({ error: { code: 'not_found', message: `${entity} was not found.` } });
}

function isEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function sendRunError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof RunServiceError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  return reply.code(500).send({ error: { code: 'wave_failed', message: 'The persona wave could not be started.' } });
}

function sendCreativeError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CreativeServiceError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  return reply.code(500).send({ error: { code: 'creative_failed', message: 'The creative request could not be completed.' } });
}

function parseByteRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || value.includes(',')) return undefined;
  let start = match[1] ? Number(match[1]) : undefined;
  let end = match[2] ? Number(match[2]) : undefined;
  if (start === undefined) {
    const suffixLength = end!;
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return undefined;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    if (!Number.isSafeInteger(start) || start >= size) return undefined;
    end = end === undefined ? size - 1 : Math.min(end, size - 1);
    if (!Number.isSafeInteger(end) || end < start) return undefined;
  }
  return { start, end };
}
