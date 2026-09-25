import type { IntegrationStatus } from '../../shared/types.js';
import { RawtreeClient, TinybirdClient, type AnalyticsClient } from './analytics.js';
import { BflClient } from './bfl.js';
import { BflVideoClient } from './bfl-video.js';
import {
  LiquidClient,
  isOpenRouterBaseUrl,
  LIQUID_DEFAULT_MAX_TOKENS,
  LIQUID_DEFAULT_TIMEOUT_MS,
  LIQUID_MAX_TOKENS_LIMIT,
  LIQUID_TIMEOUT_MS_LIMIT,
} from './liquid.js';
import { configStatus, ProviderError, safeBaseUrl, type FetchLike } from './common.js';

export { RawtreeClient, TinybirdClient, validateEvents } from './analytics.js';
export type { AnalyticsClient, AnalyticsEvent, AnalyticsMetricRow, AnalyticsQuery } from './analytics.js';
export { BflClient } from './bfl.js';
export type { BflSubmission, GeneratedImage } from './bfl.js';
export { BflVideoClient } from './bfl-video.js';
export type { BflVideoOptions, BflVideoSubmission, BflVideoPoll, GeneratedVideo } from './bfl-video.js';
export {
  LiquidClient,
  isOpenRouterBaseUrl,
  LIQUID_DEFAULT_MAX_TOKENS,
  LIQUID_DEFAULT_TIMEOUT_MS,
  LIQUID_MAX_TOKENS_LIMIT,
  LIQUID_TIMEOUT_MS_LIMIT,
} from './liquid.js';
export type { CreativeJudgeContext, CreativeJudgmentWithMetadata, ExperimentContext, ExperimentDecision, ExperimentDecisionWithMetadata, LiquidClientConfig, LiquidResponseMetadata, LiquidUsageMetadata } from './liquid.js';
export { ProviderError } from './common.js';

export interface Providers { liquid?: LiquidClient; analytics?: AnalyticsClient; bfl?: BflClient; video?: BflVideoClient; videoEnabled: boolean; }

export function getIntegrationStatuses(env: NodeJS.ProcessEnv = process.env): IntegrationStatus[] {
  const liquidBase = value(env.LIQUID_BASE_URL);
  const liquidModel = value(env.LIQUID_MODEL);
  const openRouter = liquidBase ? isOpenRouterBaseUrl(liquidBase) : false;
  const liquidKey = value(env.LIQUID_API_KEY);
  const liquidMissing = [!liquidBase && 'LIQUID_BASE_URL', !liquidModel && 'LIQUID_MODEL', openRouter && !liquidKey && 'LIQUID_API_KEY'].filter(Boolean) as string[];
  const liquid = status('liquid', 'Liquid AI', 'Propose experiment decisions from supplied evidence.', openRouter ? 'Liquid AI / OpenRouter' : 'Liquid AI / llama.cpp', liquidMissing, () => {
    if (liquidBase) {
      safeBaseUrl(liquidBase, 'LIQUID_BASE_URL', ['http:', 'https:']);
      const url = new URL(liquidBase);
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
    }
    if (liquidModel && (liquidModel.length > 120 || !liquidModel.trim())) throw new Error();
    if (liquidKey && liquidKey.length > 4_096) throw new Error();
    readIntegerSetting(env.LIQUID_MAX_TOKENS, LIQUID_DEFAULT_MAX_TOKENS, 1, LIQUID_MAX_TOKENS_LIMIT, 'LIQUID_MAX_TOKENS');
    readIntegerSetting(env.LIQUID_TIMEOUT_MS, LIQUID_DEFAULT_TIMEOUT_MS, 1_000, LIQUID_TIMEOUT_MS_LIMIT, 'LIQUID_TIMEOUT_MS');
  });
  const analyticsProvider = (value(env.ANALYTICS_PROVIDER) || 'rawtree').toLowerCase();
  let analytics: IntegrationStatus;
  if (analyticsProvider === 'rawtree') {
    const missing = [!configStatus(env.RAWTREE_API_KEY) && 'RAWTREE_API_KEY', !configStatus(env.RAWTREE_DATABASE) && 'RAWTREE_DATABASE'].filter(Boolean) as string[];
    analytics = status('analytics', 'Analytics', 'Ingest events and query experiment metrics.', 'Rawtree', missing, () => {
      const db = value(env.RAWTREE_DATABASE); if (db && !/^[a-z][a-z0-9_]{0,62}$/.test(db)) throw new Error();
      const table = value(env.RAWTREE_TABLE) || 'campaign_events'; if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) throw new Error();
      const baseUrl = value(env.RAWTREE_BASE_URL); if (baseUrl) safeBaseUrl(baseUrl, 'RAWTREE_BASE_URL');
      const key = value(env.RAWTREE_API_KEY); if (key && key.length > 4_096) throw new Error();
    });
  } else if (analyticsProvider === 'tinybird') {
    const missing = [!configStatus(env.TINYBIRD_BASE_URL) && 'TINYBIRD_BASE_URL', !configStatus(env.TINYBIRD_INGEST_TOKEN) && 'TINYBIRD_INGEST_TOKEN', !configStatus(env.TINYBIRD_READ_TOKEN) && 'TINYBIRD_READ_TOKEN'].filter(Boolean) as string[];
    analytics = status('analytics', 'Analytics', 'Ingest events and query experiment metrics.', 'Tinybird', missing, () => {
      const baseUrl = value(env.TINYBIRD_BASE_URL); if (baseUrl) safeBaseUrl(baseUrl, 'TINYBIRD_BASE_URL');
      for (const identifier of [env.TINYBIRD_DATASOURCE || 'campaign_events', env.TINYBIRD_METRICS_PIPE || 'campaign_metrics']) if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) throw new Error();
      for (const token of [env.TINYBIRD_INGEST_TOKEN, env.TINYBIRD_READ_TOKEN]) { const clean = value(token); if (clean && clean.length > 4_096) throw new Error(); }
    });
  } else {
    analytics = { id: 'analytics', name: 'Analytics', purpose: 'Ingest events and query experiment metrics.', status: 'invalid', provider: 'Unknown', missing: [], message: 'ANALYTICS_PROVIDER must be rawtree or tinybird.' };
  }
  const bflKey = value(env.BFL_API_KEY);
  const bflModel = value(env.BFL_MODEL) || 'flux-2-pro';
  const bfl = status('bfl', 'Black Forest Labs', 'Generate campaign images on explicit request.', 'Black Forest Labs FLUX.2', [!bflKey && 'BFL_API_KEY'].filter(Boolean) as string[], () => {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(bflModel) || (bflKey && bflKey.length > 4_096)) throw new Error();
    const videoEnabled = value(env.BFL_VIDEO_ENABLED) || 'false';
    const videoModel = value(env.BFL_VIDEO_MODEL) || 'flux-3-video';
    if (videoEnabled !== 'true' && videoEnabled !== 'false') throw new Error();
    if (videoModel !== 'flux-3-video') throw new Error();
  });
  return [liquid, analytics, bfl];
}

export function createProviders(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): Providers {
  const result: Providers = { videoEnabled: (value(env.BFL_VIDEO_ENABLED) || 'false') === 'true' };
  const liquidBase = value(env.LIQUID_BASE_URL);
  const liquidModel = value(env.LIQUID_MODEL);
  const liquidKey = value(env.LIQUID_API_KEY);
  const openRouter = liquidBase ? isOpenRouterBaseUrl(liquidBase) : false;
  if (liquidBase && liquidModel && (!openRouter || liquidKey)) {
    result.liquid = new LiquidClient({
      baseUrl: liquidBase,
      model: liquidModel,
      apiKey: liquidKey,
      maxTokens: readIntegerSetting(env.LIQUID_MAX_TOKENS, LIQUID_DEFAULT_MAX_TOKENS, 1, LIQUID_MAX_TOKENS_LIMIT, 'LIQUID_MAX_TOKENS'),
      timeoutMs: readIntegerSetting(env.LIQUID_TIMEOUT_MS, LIQUID_DEFAULT_TIMEOUT_MS, 1_000, LIQUID_TIMEOUT_MS_LIMIT, 'LIQUID_TIMEOUT_MS'),
    }, fetchImpl);
  }
  const provider = (value(env.ANALYTICS_PROVIDER) || 'rawtree').toLowerCase();
  if (provider === 'rawtree' && configStatus(env.RAWTREE_API_KEY) && configStatus(env.RAWTREE_DATABASE)) {
    result.analytics = new RawtreeClient({ apiKey: value(env.RAWTREE_API_KEY)!, database: value(env.RAWTREE_DATABASE)!, table: value(env.RAWTREE_TABLE) || 'campaign_events', baseUrl: value(env.RAWTREE_BASE_URL) }, fetchImpl);
  } else if (provider === 'tinybird' && configStatus(env.TINYBIRD_BASE_URL) && configStatus(env.TINYBIRD_INGEST_TOKEN) && configStatus(env.TINYBIRD_READ_TOKEN)) {
    result.analytics = new TinybirdClient({ baseUrl: value(env.TINYBIRD_BASE_URL)!, ingestToken: value(env.TINYBIRD_INGEST_TOKEN)!, readToken: value(env.TINYBIRD_READ_TOKEN)!, datasource: value(env.TINYBIRD_DATASOURCE) || 'campaign_events', metricsPipe: value(env.TINYBIRD_METRICS_PIPE) || 'campaign_metrics' }, fetchImpl);
  }
  if (configStatus(env.BFL_API_KEY)) result.bfl = new BflClient(value(env.BFL_API_KEY)!, fetchImpl, value(env.BFL_MODEL) || 'flux-2-pro');
  if (result.videoEnabled && configStatus(env.BFL_API_KEY)) result.video = new BflVideoClient(value(env.BFL_API_KEY)!, fetchImpl, value(env.BFL_VIDEO_MODEL) || 'flux-3-video');
  return result;
}

function value(input: string | undefined): string | undefined { return input?.trim() || undefined; }
export const DEFAULT_SUCCESS_CLICK_RATE = 0.7;
export const DEFAULT_MAX_AUTO_ROUNDS = 3;

/**
 * Reads the click-rate at which the auto-run loop stops early. Expressed as a fraction in
 * (0, 1]. Note this is judged from LLM persona decisions, not human traffic, so the default
 * sits far above real-world click-through rates.
 */
export function readSuccessClickRate(env: NodeJS.ProcessEnv = process.env): number {
  const input = value(env.SUCCESS_CLICK_RATE_THRESHOLD);
  if (input === undefined || input === '') return DEFAULT_SUCCESS_CLICK_RATE;
  const parsed = Number(input.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new ProviderError('SUCCESS_CLICK_RATE_THRESHOLD must be a number greater than 0 and at most 1.', 'configuration');
  }
  return parsed;
}

export function readMaxAutoRounds(env: NodeJS.ProcessEnv = process.env): number {
  return readIntegerSetting(env.MAX_AUTO_ROUNDS, DEFAULT_MAX_AUTO_ROUNDS, 1, 20, 'MAX_AUTO_ROUNDS');
}

/**
 * Whether chained rounds may generate new images with BFL. On by default, since new creative per
 * round is what the loop is for; set AUTO_CREATIVE_ENABLED=false to exercise it without image spend.
 */
export function readAutoCreativeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const input = value(env.AUTO_CREATIVE_ENABLED)?.toLowerCase();
  if (input === undefined || input === 'true') return true;
  if (input === 'false') return false;
  throw new ProviderError('AUTO_CREATIVE_ENABLED must be true or false.', 'configuration');
}

function readIntegerSetting(input: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (input === undefined || input === '') return fallback;
  const clean = input.trim();
  if (!clean || !/^\d+$/.test(clean)) throw new ProviderError(`${name} must be an integer from ${min} to ${max}.`, 'configuration');
  const parsed = Number(clean);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ProviderError(`${name} must be an integer from ${min} to ${max}.`, 'configuration');
  return parsed;
}
function status(id: IntegrationStatus['id'], name: string, purpose: string, provider: string, missing: string[], validate: () => void): IntegrationStatus {
  let invalid = false; try { validate(); } catch { invalid = true; }
  return { id, name, purpose, status: invalid ? 'invalid' : missing.length ? 'not_configured' : 'configured', provider, missing, message: invalid ? 'Configuration values are invalid.' : missing.length ? `Configure ${missing.join(', ')} to enable this integration.` : 'Configuration is present; provider connectivity has not been checked.' };
}
