import { ProviderError, boundedText, cancelBody, object, readJson, readTextBounded, rejectRedirect, safeBaseUrl, timeoutSignal, type FetchLike } from './common.js';

export type AnalyticsEvent = {
  campaign_id: string; experiment_id: string; variant_id: string; event_id: string; visitor_id: string;
  timestamp: string; event_type: 'impression' | 'click' | 'signup'; cost_cents: number;
  audience_segment?: string;
  agent_id?: string;
  decision_latency_ms?: number;
  dwell_seconds?: number;
  time_to_action_seconds?: number;
  confidence?: number;
  attention?: number;
  clarity?: number;
  trust?: number;
  purchase_intent?: number;
  noticed_first?: string;
  friction?: string;
};
export type AnalyticsQuery = { campaignId: string; experimentId: string; start: string; end: string };
export type AnalyticsMetricRow = {
  variantId: string; impressions: number; uniqueVisitors: number; clicks: number; signups: number; spendCents: number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export interface AnalyticsClient { readonly provider: 'rawtree' | 'tinybird'; ingest(events: AnalyticsEvent[], signal?: AbortSignal): Promise<number>; query(input: AnalyticsQuery, signal?: AbortSignal): Promise<AnalyticsMetricRow[]>; }

export function validateEvents(events: AnalyticsEvent[]): AnalyticsEvent[] {
  if (!Array.isArray(events) || events.length < 1 || events.length > 500) throw new ProviderError('Event batch must contain 1 to 500 events.', 'configuration');
  const seen = new Set<string>();
  return events.map(event => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new ProviderError('Event is invalid.', 'configuration');
    for (const key of ['campaign_id', 'experiment_id', 'variant_id', 'event_id', 'visitor_id'] as const) {
      if (typeof event[key] !== 'string' || !UUID.test(event[key])) throw new ProviderError(`${key} must be a UUID.`, 'configuration');
    }
    if (seen.has(event.event_id)) throw new ProviderError('Event IDs must be unique within a batch.', 'configuration');
    seen.add(event.event_id);
    if (!['impression', 'click', 'signup'].includes(event.event_type)) throw new ProviderError('Event type is invalid.', 'configuration');
    const timestamp = normalizeIsoUtc(event.timestamp);
    if (!Number.isSafeInteger(event.cost_cents) || event.cost_cents < 0 || event.cost_cents > 1_000_000) throw new ProviderError('Event cost is invalid.', 'configuration');
    return { ...event, timestamp };
  });
}

function validateQuery(input: AnalyticsQuery): AnalyticsQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !UUID.test(input.campaignId) || !UUID.test(input.experimentId)) throw new ProviderError('Campaign and experiment IDs must be UUIDs.', 'configuration');
  const startIso = normalizeIsoUtc(input.start), endIso = normalizeIsoUtc(input.end);
  const start = new Date(startIso), end = new Date(endIso);
  const days = (end.valueOf() - start.valueOf()) / 86_400_000;
  if (days <= 0 || days > 30) throw new ProviderError('Query window must be positive and no longer than 30 days, with end exclusive.', 'configuration');
  return { campaignId: input.campaignId, experimentId: input.experimentId, start: startIso, end: endIso };
}

function normalizeIsoUtc(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderError('Timestamp must be an ISO UTC datetime.', 'configuration');
  const match = ISO_UTC.exec(value);
  if (!match) throw new ProviderError('Timestamp must be an ISO UTC datetime.', 'configuration');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = ''] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const millisecond = Number(fractionText.padEnd(3, '0') || '0');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millisecond) {
    throw new ProviderError('Timestamp must be a valid ISO UTC datetime.', 'configuration');
  }
  return date.toISOString();
}

abstract class BaseAnalytics implements AnalyticsClient {
  abstract readonly provider: 'rawtree' | 'tinybird';
  protected constructor(protected fetchImpl: FetchLike) {}
  abstract ingest(events: AnalyticsEvent[], signal?: AbortSignal): Promise<number>;
  abstract query(input: AnalyticsQuery, signal?: AbortSignal): Promise<AnalyticsMetricRow[]>;
  protected async request<T>(url: URL, init: RequestInit, consume: (response: Response, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const timeout = timeoutSignal(15_000, signal);
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: 'error', signal: timeout.signal });
      await rejectRedirect(response);
      if (!response.ok) { await cancelBody(response); throw new ProviderError(`Analytics request failed with HTTP ${response.status}.`); }
      return await consume(response, timeout.signal);
    } catch (e) {
      if (timeout.signal.aborted) throw new ProviderError(signal?.aborted ? 'Analytics request was cancelled.' : 'Analytics request timed out.', 'timeout');
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('Analytics network request failed.');
    } finally { timeout.dispose(); }
  }
}

export class RawtreeClient extends BaseAnalytics {
  readonly provider = 'rawtree' as const;
  private base: URL;
  private apiKey: string;
  constructor(private config: { apiKey: string; database: string; table: string; baseUrl?: string }, fetchImpl: FetchLike = fetch) {
    super(fetchImpl); this.base = safeBaseUrl(config.baseUrl ?? 'https://api.rawtree.com', 'RAWTREE_BASE_URL');
    this.apiKey = boundedToken(config.apiKey, 'RAWTREE_API_KEY');
    if (!IDENT.test(config.database) || !IDENT.test(config.table)) throw new ProviderError('Rawtree database and table must be valid identifiers.', 'configuration');
  }
  async ingest(events: AnalyticsEvent[], signal?: AbortSignal): Promise<number> {
    const batch = validateEvents(events);
    const url = new URL(`/v1/tables/${encodeURIComponent(this.config.table)}`, this.base);
    url.searchParams.set('database', this.config.database);
    return this.request(url, { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(batch) }, async (response, signal) => {
      const result = object(await readJson(response, 256_000, signal));
      if (result.inserted !== batch.length) throw new ProviderError('Rawtree did not acknowledge the full event batch.', 'response');
      return batch.length;
    }, signal);
  }
  async query(input: AnalyticsQuery, signal?: AbortSignal): Promise<AnalyticsMetricRow[]> {
    const q = validateQuery(input);
    const sql = `WITH deduplicated AS (SELECT event_id, argMax(variant_id, timestamp) AS variant_id, argMax(visitor_id, timestamp) AS visitor_id, argMax(event_type, timestamp) AS event_type, argMax(cost_cents, timestamp) AS cost_cents FROM ${this.config.table} WHERE campaign_id = '${q.campaignId}' AND experiment_id = '${q.experimentId}' AND timestamp >= '${q.start}' AND timestamp < '${q.end}' GROUP BY event_id) SELECT variant_id, countIf(event_type = 'impression') AS impressions, uniqExactIf(visitor_id, event_type = 'impression') AS unique_visitors, countIf(event_type = 'click') AS clicks, countIf(event_type = 'signup') AS signups, sum(cost_cents) AS spend_cents FROM deduplicated GROUP BY variant_id`;
    const url = new URL('/v1/query', this.base);
    return this.request(url, { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'x-rawtree-database': this.config.database, 'content-type': 'application/json' }, body: JSON.stringify({ sql }) }, async (response, signal) => {
      const result = object(await readJson(response, 256_000, signal));
      if (!Array.isArray(result.data) || result.data.length > 500) throw new ProviderError('Rawtree returned invalid metrics.', 'response');
      return result.data.map(parseMetric);
    }, signal);
  }
}

export class TinybirdClient extends BaseAnalytics {
  readonly provider = 'tinybird' as const;
  private base: URL;
  private ingestToken: string;
  private readToken: string;
  constructor(private config: { ingestToken: string; readToken: string; datasource: string; metricsPipe: string; baseUrl: string }, fetchImpl: FetchLike = fetch) {
    super(fetchImpl); this.base = safeBaseUrl(config.baseUrl, 'TINYBIRD_BASE_URL');
    this.ingestToken = boundedToken(config.ingestToken, 'TINYBIRD_INGEST_TOKEN');
    this.readToken = boundedToken(config.readToken, 'TINYBIRD_READ_TOKEN');
    if (!IDENT.test(config.datasource) || !IDENT.test(config.metricsPipe)) throw new ProviderError('Tinybird datasource and pipe must be valid identifiers.', 'configuration');
  }
  async ingest(events: AnalyticsEvent[], signal?: AbortSignal): Promise<number> {
    const batch = validateEvents(events); const url = new URL('/v0/events', this.base);
    url.searchParams.set('name', this.config.datasource); url.searchParams.set('wait', 'true');
    const body = `${batch.map(event => JSON.stringify(event)).join('\n')}\n`;
    return this.request(url, { method: 'POST', headers: { authorization: `Bearer ${this.ingestToken}`, 'content-type': 'application/x-ndjson' }, body }, async (response, signal) => {
      // Tinybird documents HTTP 200 with wait=true as the database acknowledgement.
      // Its Events API does not document a stable row-count acknowledgement body.
      if (response.status !== 200) {
        await cancelBody(response);
        throw new ProviderError('Tinybird did not acknowledge the event batch.', 'response');
      }
      await readTextBounded(response, 32_000, signal);
      return batch.length;
    }, signal);
  }
  async query(input: AnalyticsQuery, signal?: AbortSignal): Promise<AnalyticsMetricRow[]> {
    const q = validateQuery(input); const url = new URL(`/v0/pipes/${encodeURIComponent(this.config.metricsPipe)}.json`, this.base);
    url.searchParams.set('campaign_id', q.campaignId); url.searchParams.set('experiment_id', q.experimentId); url.searchParams.set('start', q.start); url.searchParams.set('end', q.end);
    return this.request(url, { method: 'GET', headers: { authorization: `Bearer ${this.readToken}` } }, async (response, signal) => {
      const result = object(await readJson(response, 256_000, signal));
      if (!Array.isArray(result.data) || result.data.length > 500) throw new ProviderError('Tinybird returned invalid metrics.', 'response');
      return result.data.map(parseMetric);
    }, signal);
  }
}

function boundedToken(value: string, name: string): string {
  return boundedText(value, name, 4_096);
}

function parseMetric(value: unknown): AnalyticsMetricRow {
  const row = object(value, 'Analytics metric row was invalid.');
  const variantId = row.variant_id ?? row.variantId;
  if (typeof variantId !== 'string' || !UUID.test(variantId)) throw new ProviderError('Analytics returned invalid variant ID.', 'response');
  const num = (key: string, alt: string): number => {
    const value = row[key] ?? row[alt]; const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new ProviderError('Analytics returned invalid metric values.', 'response'); return n;
  };
  return { variantId, impressions: num('impressions', 'impressions'), uniqueVisitors: num('unique_visitors', 'uniqueVisitors'), clicks: num('clicks', 'clicks'), signups: num('signups', 'signups'), spendCents: num('spend_cents', 'spendCents') };
}
