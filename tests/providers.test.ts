import { afterEach, describe, expect, it, vi } from 'vitest';
import { BflClient } from '../server/providers/bfl.js';
import { ProviderError, type FetchLike } from '../server/providers/common.js';
import { RawtreeClient, TinybirdClient, validateEvents, type AnalyticsEvent, type AnalyticsQuery } from '../server/providers/analytics.js';
import { createProviders, getIntegrationStatuses } from '../server/providers/index.js';
import { LiquidClient } from '../server/providers/liquid.js';

const campaignId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const experimentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const variantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const eventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const visitorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const encoder = new TextEncoder();

afterEach(() => vi.useRealTimers());

function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    campaign_id: campaignId,
    experiment_id: experimentId,
    variant_id: variantId,
    event_id: eventId,
    visitor_id: visitorId,
    timestamp: '2026-09-24T10:30:00Z',
    event_type: 'signup',
    cost_cents: 4,
    ...overrides,
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function captureFetch(result: (url: URL, init: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; calls: Array<{ url: URL; init: RequestInit }> } {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    return result(url, init);
  };
  return { fetch, calls };
}

const query = (overrides: Partial<AnalyticsQuery> = {}): AnalyticsQuery => ({
  campaignId,
  experimentId,
  start: '2026-09-24T10:30:00Z',
  end: '2026-09-24T11:00:00Z',
  ...overrides,
});

describe('analytics providers', () => {
  it('validates event IDs and normalizes strict UTC timestamps', () => {
    const normalized = validateEvents([event({ timestamp: '2026-09-24T10:30:00Z' })]);
    expect(normalized[0].timestamp).toBe('2026-09-24T10:30:00.000Z');
    expect(() => validateEvents([event({ timestamp: '2026-02-30T10:30:00Z' })])).toThrow(/valid ISO UTC/);
    expect(() => validateEvents([event({ timestamp: '2026-09-24T10:30:00+00:00' })])).toThrow(/ISO UTC/);
    expect(() => validateEvents([event(), event({ event_id: eventId })])).toThrow(/unique/);
  });

  it('uses the Rawtree insert contract and returns only the acknowledged inserted count', async () => {
    const fixture = captureFetch(url => {
      expect(url.origin).toBe('https://analytics.example.test');
      expect(url.pathname).toBe('/v1/tables/campaign_events');
      expect(url.searchParams.get('database')).toBe('growth');
      return responseJson({ inserted: 1 });
    });
    const client = new RawtreeClient({ apiKey: 'raw-secret', database: 'growth', table: 'campaign_events', baseUrl: 'https://analytics.example.test' }, fixture.fetch);
    await expect(client.ingest([event()])).resolves.toBe(1);
    expect(fixture.calls[0].init.redirect).toBe('error');
    expect((fixture.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer raw-secret');
    expect(JSON.parse(String(fixture.calls[0].init.body))).toEqual([{ ...event(), timestamp: '2026-09-24T10:30:00.000Z' }]);
  });

  it('queries Rawtree with a bounded minute window and rejects SQL injection before fetching', async () => {
    const fixture = captureFetch(() => responseJson({ data: [{
      variant_id: variantId, impressions: '4', unique_visitors: '3', clicks: 2, signups: 1, spend_cents: 4,
    }] }));
    const client = new RawtreeClient({ apiKey: 'raw-secret', database: 'growth', table: 'campaign_events' }, fixture.fetch);
    const rows = await client.query(query());
    expect(rows).toEqual([{ variantId, impressions: 4, uniqueVisitors: 3, clicks: 2, signups: 1, spendCents: 4 }]);
    const sql = JSON.parse(String(fixture.calls[0].init.body)).sql as string;
    expect(sql).toContain("timestamp >= '2026-09-24T10:30:00.000Z'");
    expect(sql).toContain("timestamp < '2026-09-24T11:00:00.000Z'");
    expect(sql).toContain('GROUP BY event_id');
    expect(fixture.calls[0].init.headers).toMatchObject({ 'x-rawtree-database': 'growth' });

    await expect(client.query(query({ start: "2026-09-24T10:30:00Z' OR 1=1 --" }))).rejects.toMatchObject({ code: 'configuration' });
    await expect(client.query(query({ start: '2026-09-24T10:30:00Z', end: '2026-09-24T10:30:00Z' }))).rejects.toMatchObject({ code: 'configuration' });
    await expect(client.query(query({ start: '2026-09-01T00:00:00Z', end: '2026-10-02T00:00:00Z' }))).rejects.toMatchObject({ code: 'configuration' });
    expect(fixture.calls).toHaveLength(1);
  });

  it('uses Tinybird NDJSON and trusts only its documented wait=true HTTP acknowledgement', async () => {
    const fixture = captureFetch(url => {
      expect(url.pathname).toBe('/v0/events');
      expect(url.searchParams.get('name')).toBe('campaign_events');
      expect(url.searchParams.get('wait')).toBe('true');
      return new Response('', { status: 200 });
    });
    const client = new TinybirdClient({
      baseUrl: 'https://api.eu.tinybird.co', ingestToken: 'ingest-secret', readToken: 'read-secret',
      datasource: 'campaign_events', metricsPipe: 'campaign_metrics',
    }, fixture.fetch);
    await expect(client.ingest([event()])).resolves.toBe(1);
    expect(fixture.calls[0].init.headers).toMatchObject({ authorization: 'Bearer ingest-secret', 'content-type': 'application/x-ndjson' });
    expect(String(fixture.calls[0].init.body)).toBe(`${JSON.stringify({ ...event(), timestamp: '2026-09-24T10:30:00.000Z' })}\n`);

    const queryFixture = captureFetch(url => {
      expect(url.pathname).toBe('/v0/pipes/campaign_metrics.json');
      expect(url.searchParams.get('start')).toBe('2026-09-24T10:30:00.000Z');
      expect(url.searchParams.get('end')).toBe('2026-09-24T11:00:00.000Z');
      return responseJson({ data: [] });
    });
    const reader = new TinybirdClient({
      baseUrl: 'https://api.eu.tinybird.co', ingestToken: 'ingest-secret', readToken: 'read-secret',
      datasource: 'campaign_events', metricsPipe: 'campaign_metrics',
    }, queryFixture.fetch);
    await expect(reader.query(query())).resolves.toEqual([]);
    expect(queryFixture.calls[0].init.headers).toMatchObject({ authorization: 'Bearer read-secret' });

    const notAcknowledged = new TinybirdClient({
      baseUrl: 'https://api.eu.tinybird.co', ingestToken: 'ingest-secret', readToken: 'read-secret',
      datasource: 'campaign_events', metricsPipe: 'campaign_metrics',
    }, async () => new Response('', { status: 202 }));
    await expect(notAcknowledged.ingest([event()])).rejects.toMatchObject({ code: 'response', message: 'Tinybird did not acknowledge the event batch.' });
  });

  it('bounds malformed and oversized analytics responses', async () => {
    const malformed = new RawtreeClient({ apiKey: 'key', database: 'db', table: 'events' }, async () => new Response('{not json'));
    await expect(malformed.query(query())).rejects.toMatchObject({ code: 'response', message: 'Provider returned malformed JSON.' });

    const oversized = new TinybirdClient({
      baseUrl: 'https://api.eu.tinybird.co', ingestToken: 'ingest', readToken: 'read', datasource: 'events', metricsPipe: 'metrics',
    }, async () => new Response('x'.repeat(300_000)));
    await expect(oversized.query(query())).rejects.toMatchObject({ code: 'response', message: 'Provider response exceeded the size limit.' });
  });

  it('keeps the analytics timeout active while it consumes the response body', async () => {
    vi.useFakeTimers();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('{"data":')); },
      pull() { return new Promise<void>(() => {}); },
      cancel() { canceled = true; },
    });
    const client = new RawtreeClient({ apiKey: 'key', database: 'db', table: 'events' }, async () => new Response(stream));
    const pending = client.query(query());
    const expectedTimeout = expect(pending).rejects.toMatchObject({ code: 'timeout', message: 'Analytics request timed out.' });
    await vi.advanceTimersByTimeAsync(15_000);
    await expectedTimeout;
    expect(canceled).toBe(true);
  });

  it('sanitizes raw fetch errors and rejects redirects', async () => {
    const leaking = new RawtreeClient({ apiKey: 'key', database: 'db', table: 'events' }, async () => { throw new TypeError('secret https://private.example/token'); });
    await expect(leaking.query(query())).rejects.toMatchObject({ message: 'Analytics network request failed.' });
    const redirectedResponse = responseJson({ data: [] });
    Object.defineProperty(redirectedResponse, 'redirected', { value: true });
    const redirected = new TinybirdClient({
      baseUrl: 'https://api.eu.tinybird.co', ingestToken: 'ingest', readToken: 'read', datasource: 'events', metricsPipe: 'metrics',
    }, async () => redirectedResponse);
    await expect(redirected.query(query())).rejects.toMatchObject({ code: 'response', message: 'Provider redirected a request unexpectedly.' });
  });
});

describe('Liquid advisor', () => {
  const context = { brief: 'Improve signups for new users.', evidence: [{ id: 'event-1', summary: 'Variant A had 2 signups.' }], lessons: [] };

  it('accepts a wait decision without fabricated creative', async () => {
    const fixture = captureFetch(url => {
      expect(url.href).toBe('http://127.0.0.1:8080/v1/chat/completions');
      return responseJson({ choices: [{ message: { content: JSON.stringify({
        action: 'wait', explanation: 'There is not enough evidence yet.', hypothesis: '', headlines: [], evidenceIds: ['event-1'],
      }) } }] });
    });
    const client = new LiquidClient({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'lfm2.5-1.2b-instruct' }, fixture.fetch);
    await expect(client.proposeExperiment(context)).resolves.toEqual({
      action: 'wait', explanation: 'There is not enough evidence yet.', hypothesis: '', headlines: [], evidenceIds: ['event-1'],
    });
    expect(fixture.calls[0].init.redirect).toBe('error');
  });

  it('rejects invented evidence IDs and invalid model output', async () => {
    const fixture = captureFetch(() => responseJson({ choices: [{ message: { content: JSON.stringify({
      action: 'propose_test', explanation: 'A comparison can be run.', hypothesis: 'A clearer benefit improves signups.',
      headlines: ['Start today', 'Try the product today'], evidenceIds: ['not-supplied'],
    }) } }] }));
    const client = new LiquidClient({ baseUrl: 'http://localhost:8080/v1', model: 'test-model' }, fixture.fetch);
    await expect(client.proposeExperiment(context)).rejects.toMatchObject({ code: 'response', message: 'Liquid decision cited evidence that was not supplied.' });

    const malformed = new LiquidClient({ baseUrl: 'http://localhost:8080/v1', model: 'test-model' }, async () => responseJson({ choices: [{ message: { content: '{' } }] }));
    await expect(malformed.proposeExperiment(context)).rejects.toMatchObject({ code: 'response', message: 'Liquid returned malformed decision JSON.' });
  });
});

describe('BFL image adapter', () => {
  const id = 'task-123';
  const pollingUrl = `https://api.bfl.ai/v1/get_result?id=${id}`;

  it('retains and polls the returned query URL, with documented statuses', async () => {
    const fixture = captureFetch(url => url.pathname === '/v1/flux-2-pro'
      ? responseJson({ id, polling_url: pollingUrl })
      : responseJson({ id, status: 'Generating', result: null }));
    const client = new BflClient('bfl-secret', fixture.fetch);
    const submission = await client.submit('A clean product image.');
    expect(submission).toEqual({ id, pollingUrl });
    const poll = await client.poll(submission);
    expect(poll).toEqual({ status: 'Generating' });
    expect(fixture.calls[1].url.href).toBe(pollingUrl);
    expect(fixture.calls[1].init.headers).toMatchObject({ 'x-key': 'bfl-secret' });
    expect(fixture.calls.every(call => call.init.redirect === 'error')).toBe(true);
    expect(JSON.parse(String(fixture.calls[0].init.body))).toEqual({
      prompt: 'A clean product image.', width: 1024, height: 1024, disable_pup: true,
    });
  });

  it('keeps FLUX.2 Pro prompt flags off configured legacy endpoints', async () => {
    const fixture = captureFetch(() => responseJson({ id, polling_url: pollingUrl }));
    const client = new BflClient('bfl-secret', fixture.fetch, 'flux-pro');
    await client.submit('A product on a plain background.', 640, 768);

    expect(fixture.calls[0].url.pathname).toBe('/v1/flux-pro');
    expect(JSON.parse(String(fixture.calls[0].init.body))).toEqual({
      prompt: 'A product on a plain background.', width: 640, height: 768,
    });
  });

  it('rejects mismatched or attacker controlled polling URLs before sending credentials', async () => {
    const fixture = captureFetch(() => responseJson({ id, status: 'Pending' }));
    const client = new BflClient('bfl-secret', fixture.fetch);
    await expect(client.poll({ id, pollingUrl: 'https://evil.example/v1/get_result?id=task-123' })).rejects.toMatchObject({ code: 'response' });
    await expect(client.poll({ id, pollingUrl: 'https://bfl.ai.evil.example/v1/get_result?id=task-123' })).rejects.toMatchObject({ code: 'response' });
    await expect(client.poll({ id, pollingUrl: 'https://api.bfl.ai/v1/get_result?id=someone-else' })).rejects.toMatchObject({ code: 'response' });
    expect(fixture.calls).toHaveLength(0);
  });

  it('accepts a returned BFL regional polling host within the trusted domain boundary', async () => {
    const regionalUrl = `https://api.us1.bfl.ai/v1/get_result?id=${id}`;
    const fixture = captureFetch(url => url.pathname === '/v1/flux-2-pro'
      ? responseJson({ id, polling_url: regionalUrl })
      : responseJson({ id, status: 'Pending', result: null }));
    const client = new BflClient('bfl-secret', fixture.fetch);
    const submission = await client.submit('A clean product image.');
    await expect(client.poll(submission)).resolves.toEqual({ status: 'Pending' });
    expect(fixture.calls[1].url.href).toBe(regionalUrl);
  });

  it('accepts human-readable moderation/error statuses and rejects unknown ones', async () => {
    let status = 'Request Moderated';
    const fixture = captureFetch(() => responseJson({ id, status, result: null }));
    const client = new BflClient('bfl-secret', fixture.fetch);
    await expect(client.poll({ id, pollingUrl })).resolves.toEqual({ status: 'Request Moderated' });
    status = 'Task not found';
    await expect(client.poll({ id, pollingUrl })).resolves.toEqual({ status: 'Task not found' });
    status = 'Still-working-forever';
    await expect(client.poll({ id, pollingUrl })).rejects.toMatchObject({ code: 'response', message: 'BFL returned an unknown task status.' });
  });

  it('validates signed image hosts before download and checks image signatures', async () => {
    const fixture = captureFetch(() => responseJson({ id, status: 'Ready', result: { sample: 'https://evil.example/image.png' } }));
    const client = new BflClient('bfl-secret', fixture.fetch);
    const poll = await client.poll({ id, pollingUrl });
    await expect(poll.downloadImage?.()).rejects.toMatchObject({ code: 'response', message: 'BFL image URL host was not allowed.' });
    expect(fixture.calls).toHaveLength(1);

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
    const valid = new BflClient('bfl-secret', async input => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/get_result') return responseJson({ id, status: 'Ready', result: { sample: 'https://delivery.us.bfl.ai/result?signature=short-lived' } });
      return new Response(pngBytes, { headers: { 'content-type': 'image/png' } });
    });
    const ready = await valid.poll({ id, pollingUrl });
    await expect(ready.downloadImage?.()).resolves.toMatchObject({ bytes: pngBytes, contentType: 'image/png' });
  });

  it('sanitizes network failures and catches redirected credential-bearing requests', async () => {
    const leaking = new BflClient('bfl-secret', async () => { throw new TypeError('https://api.bfl.ai?x=bfl-secret'); });
    await expect(leaking.poll({ id, pollingUrl })).rejects.toMatchObject({ message: 'BFL request failed.' });
    const redirectedResponse = responseJson({ id, status: 'Pending' });
    Object.defineProperty(redirectedResponse, 'redirected', { value: true });
    const redirected = new BflClient('bfl-secret', async () => redirectedResponse);
    await expect(redirected.poll({ id, pollingUrl })).rejects.toMatchObject({ code: 'response', message: 'Provider redirected a request unexpectedly.' });
  });
});

describe('provider configuration', () => {
  it('reports missing, configured-but-unverified, and invalid configuration without making requests or exposing secrets', () => {
    const missing = getIntegrationStatuses({ ANALYTICS_PROVIDER: 'rawtree' });
    expect(missing.find(status => status.id === 'liquid')).toMatchObject({ status: 'not_configured', missing: ['LIQUID_BASE_URL', 'LIQUID_MODEL'] });
    expect(missing.find(status => status.id === 'liquid')?.status).not.toBe('invalid');

    const env = {
      LIQUID_BASE_URL: 'http://127.0.0.1:8080/v1', LIQUID_MODEL: 'lfm2.5-1.2b-instruct', LIQUID_API_KEY: 'secret-liquid',
      ANALYTICS_PROVIDER: 'rawtree', RAWTREE_API_KEY: 'secret-rawtree', RAWTREE_DATABASE: 'growth', RAWTREE_BASE_URL: 'https://rawtree.example.test',
      BFL_API_KEY: 'secret-bfl', BFL_MODEL: 'flux-2-pro',
    };
    const statuses = getIntegrationStatuses(env);
    expect(statuses.every(status => status.status === 'configured')).toBe(true);
    expect(statuses.map(status => status.message).join(' ')).toMatch(/not been checked/);
    expect(JSON.stringify(statuses)).not.toMatch(/secret-|https?:\/\//i);
    expect(getIntegrationStatuses({ ...env, LIQUID_BASE_URL: 'http://remote.example/v1' }).find(status => status.id === 'liquid')?.status).toBe('invalid');
    expect(getIntegrationStatuses({ ...env, RAWTREE_TABLE: 'campaign_events;drop' }).find(status => status.id === 'analytics')?.status).toBe('invalid');
    expect(getIntegrationStatuses({ ...env, BFL_MODEL: '../private' }).find(status => status.id === 'bfl')?.status).toBe('invalid');
  });

  it('creates configured adapters without contacting providers and wires custom endpoints/models', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async input => { calls.push(String(input)); throw new Error('A configured adapter unexpectedly fetched.'); };
    const providers = createProviders({
      LIQUID_BASE_URL: 'http://127.0.0.1:8080/v1', LIQUID_MODEL: 'lfm2.5-1.2b-instruct',
      ANALYTICS_PROVIDER: 'rawtree', RAWTREE_API_KEY: 'raw-secret', RAWTREE_DATABASE: 'growth', RAWTREE_BASE_URL: 'https://custom.rawtree.test',
      BFL_API_KEY: 'bfl-secret', BFL_MODEL: 'flux-2-klein-4b',
    }, fetch);
    expect(providers.analytics).toBeInstanceOf(RawtreeClient);
    expect(providers.liquid).toBeInstanceOf(LiquidClient);
    expect(providers.bfl).toBeInstanceOf(BflClient);
    expect(calls).toEqual([]);
  });

  it('rejects invalid provider selection and constructor configuration', () => {
    expect(getIntegrationStatuses({ ANALYTICS_PROVIDER: 'similar-looking-provider' }).find(status => status.id === 'analytics')).toMatchObject({ status: 'invalid', missing: [] });
    expect(() => new RawtreeClient({ apiKey: 'key', database: 'bad-db', table: 'events' })).toThrow(ProviderError);
    expect(() => new TinybirdClient({ baseUrl: 'file:///tmp', ingestToken: 'ingest', readToken: 'read', datasource: 'events', metricsPipe: 'metrics' })).toThrow(ProviderError);
  });
});
