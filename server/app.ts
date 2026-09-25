import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  campaignInputSchema,
  emptyMetricsSnapshot,
  type IntegrationStatus,
} from '../shared/types.js';
import { CampaignDatabase } from './database.js';
import { getIntegrationStatuses } from './providers/index.js';

export interface CreateAppOptions {
  databasePath?: string;
  integrations?: IntegrationStatus[];
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const databasePath = options.databasePath ?? resolve(process.cwd(), '.data', 'riff.sqlite');
  const database = new CampaignDatabase(databasePath);
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
    return { campaign, variants: [], experiments: [], lessons: [] };
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/metrics', async (request, reply) => {
    if (!database.getCampaign(request.params.id)) return notFound(reply, 'Campaign');
    return emptyMetricsSnapshot(request.params.id);
  });

  app.get('/api/integrations', async () => ({
    integrations: options.integrations ?? getIntegrationStatuses(),
  }));

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/lessons', async (request, reply) => {
    if (!database.getCampaign(request.params.id)) return notFound(reply, 'Campaign');
    return { lessons: [] };
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/experiments', async (request, reply) => {
    if (!database.getCampaign(request.params.id)) return notFound(reply, 'Campaign');
    return { experiments: [] };
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

  app.addHook('onClose', async () => database.close());
  return app;
}

function notFound(reply: FastifyReply, entity: string): FastifyReply {
  return reply.code(404).send({ error: { code: 'not_found', message: `${entity} was not found.` } });
}
