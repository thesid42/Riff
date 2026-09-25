import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';

describe('backend API', () => {
  let directory: string;
  let app: FastifyInstance;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'riff-'));
    databasePath = join(directory, 'campaigns.sqlite');
    app = createApp({ databasePath });
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('reports a non-simulating foundation health status', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', mode: 'foundation', simulationEnabled: false });
  });

  it('validates input and persists a draft campaign across app restarts', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/api/campaigns', payload: { name: '' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('validation_error');

    const created = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: {
        name: '<img src=x onerror=alert(1)>',
        product: 'A product',
        audience: 'New customers',
        approvedClaims: ['No unsupported promise'],
        budgetCents: 12500,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['content-type']).toContain('application/json');
    const campaign = created.json().campaign;
    expect(campaign).toMatchObject({
      name: '<img src=x onerror=alert(1)>',
      product: 'A product',
      audience: 'New customers',
      goal: 'signups',
      approvedClaims: ['No unsupported promise'],
      budgetCents: 12500,
      currency: 'USD',
      status: 'draft',
    });
    expect(campaign.id).toBeTruthy();
    expect(campaign.createdAt).toBe(campaign.updatedAt);

    await app.close();
    app = createApp({ databasePath });
    const listed = await app.inject({ method: 'GET', url: '/api/campaigns' });
    expect(listed.json().campaigns).toEqual([campaign]);
    const details = await app.inject({ method: 'GET', url: `/api/campaigns/${campaign.id}` });
    expect(details.json()).toEqual({ campaign, variants: [], experiments: [], lessons: [] });
  });

  it('returns structured not found errors for missing campaigns', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/campaigns/missing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Campaign was not found.' } });
  });

  it('rejects non-local Host headers on reads', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: {
        name: 'Host check', product: 'A product', audience: 'New customers', budgetCents: 1000,
      },
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: { host: 'attacker.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('host_forbidden');
  });

  it('accepts same-origin campaign creation on a configured local port', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://127.0.0.1:4000',
        'content-type': 'application/json',
      },
      payload: {
        name: 'Custom port', product: 'A product', audience: 'New customers', budgetCents: 1000,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().campaign).toMatchObject({ name: 'Custom port', status: 'draft' });
  });

  it('rejects cross origin or non JSON mutations', async () => {
    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { origin: 'https://example.com', 'content-type': 'application/json' },
      payload: {},
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json().error.code).toBe('origin_forbidden');

    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json().error.code).toBe('json_required');

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toEqual({ code: 'bad_request', message: 'The request body could not be parsed.' });
  });

  it('returns only safe integration metadata', async () => {
    await app.close();
    app = createApp({
      databasePath,
      integrations: [{
        id: 'liquid', name: 'Liquid AI', purpose: 'Advisor', status: 'not_configured',
        provider: 'Liquid AI', missing: ['LIQUID_API_KEY'], message: 'Credentials are not configured.',
      }],
    });
    const response = await app.inject({ method: 'GET', url: '/api/integrations' });
    const body = response.json();
    expect(body.integrations[0]).toHaveProperty('status', 'not_configured');
    expect(JSON.stringify(body)).not.toMatch(/secret|token|sk-[A-Za-z0-9]/i);
  });
});
