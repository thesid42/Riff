import { ProviderError, boundedText, cancelBody, object, readJson, rejectRedirect, safeBaseUrl, timeoutSignal, type FetchLike } from './common.js';

export interface ExperimentContext {
  brief: string;
  evidence: Array<{ id: string; summary: string }>;
  lessons: Array<{ id: string; statement: string }>;
  stage?: 'initial' | 'review' | 'retest';
}
export interface ExperimentDecision {
  action: 'wait' | 'propose_test';
  explanation: string;
  hypothesis: string;
  headlines: string[];
  evidenceIds: string[];
}
export interface LiquidUsageMetadata {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}
export interface LiquidResponseMetadata {
  requestId?: string;
  model?: string;
  finishReason?: string;
  elapsedMs: number;
  usage?: LiquidUsageMetadata;
}
export interface ExperimentDecisionWithMetadata {
  decision: ExperimentDecision;
  metadata: LiquidResponseMetadata;
}
export interface LiquidClientConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export const LIQUID_DEFAULT_MAX_TOKENS = 4_096;
export const LIQUID_DEFAULT_TIMEOUT_MS = 60_000;
export const LIQUID_MAX_TOKENS_LIMIT = 8_192;
export const LIQUID_TIMEOUT_MS_LIMIT = 120_000;

const DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['wait', 'propose_test'], description: 'Use wait when essential brief information is missing or review data is insufficient. A wait decision has hypothesis:"" and headlines:[].' },
    explanation: { type: 'string', maxLength: 1_000, description: 'Give a concise reason grounded in the supplied brief, evidence, or lessons.' },
    hypothesis: { type: 'string', maxLength: 500, description: 'For wait, this must be exactly the empty string. For propose_test, state a testable comparison of the supplied headline angles.' },
    headlines: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 120 }, description: 'For wait, this must be an empty array with no placeholder words or old headlines. For propose_test, give 2 or 3 materially different, comparable headline angles.' },
    evidenceIds: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 100 } },
  },
  required: ['action', 'explanation', 'hypothesis', 'headlines', 'evidenceIds'],
  additionalProperties: false,
} as const;

export class LiquidClient {
  private readonly base: URL;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly openRouter: boolean;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  constructor(config: LiquidClientConfig, private readonly fetchImpl: FetchLike = fetch) {
    this.base = safeBaseUrl(config.baseUrl, 'LIQUID_BASE_URL', ['http:', 'https:']);
    this.model = boundedText(config.model, 'LIQUID_MODEL', 120);
    this.apiKey = config.apiKey === undefined ? undefined : boundedText(config.apiKey, 'LIQUID_API_KEY', 4_096);
    this.openRouter = isOpenRouterBaseUrl(config.baseUrl);
    this.maxTokens = boundedInteger(config.maxTokens, LIQUID_DEFAULT_MAX_TOKENS, 1, LIQUID_MAX_TOKENS_LIMIT, 'LIQUID_MAX_TOKENS');
    this.timeoutMs = boundedInteger(config.timeoutMs, LIQUID_DEFAULT_TIMEOUT_MS, 1_000, LIQUID_TIMEOUT_MS_LIMIT, 'LIQUID_TIMEOUT_MS');
    if (this.base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)) {
      throw new ProviderError('LIQUID_BASE_URL may use HTTP only on localhost.', 'configuration');
    }
    if (this.openRouter && !this.apiKey) throw new ProviderError('LIQUID_API_KEY is required for OpenRouter.', 'configuration');
  }

  async proposeExperiment(context: ExperimentContext, signal?: AbortSignal): Promise<ExperimentDecision> {
    return (await this.proposeExperimentWithMetadata(context, signal)).decision;
  }

  async proposeExperimentWithMetadata(context: ExperimentContext, signal?: AbortSignal): Promise<ExperimentDecisionWithMetadata> {
    const normalized = validateContext(context);
    const startedAt = performance.now();
    const timeout = timeoutSignal(this.timeoutMs, signal);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const url = new URL('chat/completions', this.base.href.endsWith('/') ? this.base : `${this.base.href}/`);
      const messages = [{ role: 'system', content: `${systemPrompt}\n\n${stagePolicy(normalized.stage)}` }, { role: 'user', content: JSON.stringify(normalized) }];
      const requestBody = this.openRouter
        ? {
            model: this.model,
            temperature: 0.1,
            max_tokens: this.maxTokens,
            response_format: { type: 'json_schema', json_schema: { name: 'experiment_decision', strict: true, schema: DECISION_JSON_SCHEMA } },
            provider: { require_parameters: true, allow_fallbacks: false },
            reasoning: { exclude: true },
            messages,
          }
        : { model: this.model, temperature: 0.1, max_tokens: this.maxTokens, response_format: { type: 'json_object' }, messages };
      const response = await this.fetchImpl(url, {
        method: 'POST', headers, redirect: 'error', signal: timeout.signal,
        body: JSON.stringify(requestBody),
      });
      await rejectRedirect(response);
      if (!response.ok) { await cancelBody(response); throw new ProviderError(`Liquid request failed with HTTP ${response.status}.`); }
      const payload = object(await readJson(response, 256_000, timeout.signal));
      if (payload.error !== undefined && payload.error !== null) throw new ProviderError('Liquid provider returned an error.', 'response');
      const choices = payload.choices;
      if (!Array.isArray(choices) || choices.length < 1) throw new ProviderError('Liquid response did not include a choice.', 'response');
      const choice = object(choices[0]);
      if (choice.error !== undefined && choice.error !== null) throw new ProviderError('Liquid provider returned an error.', 'response');
      const hasFinishReason = Object.prototype.hasOwnProperty.call(choice, 'finish_reason');
      if (choice.finish_reason === 'length') throw new ProviderError('Liquid response exhausted its completion token budget.', 'response');
      if (hasFinishReason && (typeof choice.finish_reason !== 'string' || choice.finish_reason !== 'stop')) {
        throw new ProviderError('Liquid response did not finish cleanly.', 'response');
      }
      if (this.openRouter && !hasFinishReason) throw new ProviderError('OpenRouter response did not include a finish reason.', 'response');
      const message = object(choice.message);
      if (message.refusal !== undefined && message.refusal !== null && message.refusal !== '') throw new ProviderError('Liquid declined to provide a decision.', 'response');
      if (hasToolCalls(message.tool_calls) || (message.function_call !== undefined && message.function_call !== null)) {
        throw new ProviderError('Liquid response attempted to call a tool.', 'response');
      }
      if (typeof message.content !== 'string' || message.content.length > 16_000) throw new ProviderError('Liquid response content was invalid.', 'response');
      let parsed: unknown;
      try { parsed = JSON.parse(message.content); } catch { throw new ProviderError('Liquid returned malformed decision JSON.', 'response'); }
      const decision = validateDecision(parsed, new Set(normalized.evidence.map(item => item.id)));
      const usage = readUsageMetadata(payload.usage);
      const requestId = safeMetadataText(payload.id, 200);
      const model = safeMetadataText(payload.model, 160) ?? this.model;
      return {
        decision,
        metadata: {
          ...(requestId ? { requestId } : {}),
          ...(model ? { model } : {}),
          ...(hasFinishReason ? { finishReason: 'stop' } : {}),
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
          ...(usage ? { usage } : {}),
        },
      };
    } catch (error) {
      if (timeout.signal.aborted) throw new ProviderError(signal?.aborted ? 'Liquid request was cancelled.' : 'Liquid request timed out.', 'timeout');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Liquid network request failed.');
    } finally { timeout.dispose(); }
  }
}

const systemPrompt = 'You are a cautious campaign experiment planner. Return only JSON with action (wait or propose_test), explanation, hypothesis, headlines, and evidenceIds. For wait, hypothesis must be the literal empty string and headlines must be the literal empty array; never put placeholder words, rationale, or old headlines in either field. Example wait shape: {"action":"wait","explanation":"<replace with the context-based reason>","hypothesis":"","headlines":[],"evidenceIds":[]}. Replace the explanation with an actual reason from this context; cite only supplied evidence IDs when relevant, otherwise use an empty evidenceIds array. For propose_test, give one specific testable hypothesis comparing materially different headline angles and 2 or 3 comparable headlines. First check that the brief supplies product, approved facts or claims, audience, and goal; if an essential element is missing, choose wait. Never claim a test won or that a proposed hypothesis is a result. Ground each claim only in an explicitly supplied approved fact or claim: do not turn repeated use or other context into unsupported durability, lifespan, savings, or environmental guarantees. Change only the headline angle, and keep the image, offer, audience, landing page, and spend consistent across variants. Cite only supplied evidence IDs; do not invent IDs or evidence. No tools.';

function stagePolicy(stage: ExperimentContext['stage']): string {
  if (stage === 'initial') return 'STAGE POLICY — INITIAL: When product, approved facts or claims, audience, and goal are present, propose a first controlled test. Historical performance observations are not required; do not wait solely because none exist.';
  if (stage === 'review') return 'STAGE POLICY — REVIEW: If the existing test is below its minimum data threshold or has no usable performance observations, choose wait. Do not propose a pivot from insufficient results. If evidence is sufficient, any next step is still only a test proposal, never a declared winner.';
  if (stage === 'retest') return 'STAGE POLICY — RETEST: A changed audience may be tested using a supplied scoped lesson as a rationale. Propose a controlled test without claiming a winner or requiring performance observations from the new audience first. Keep all variants on that audience and hold other elements constant.';
  return 'STAGE POLICY — UNSPECIFIED: Infer intent from the brief. A complete first-time brief with no existing experiment is initial and can support a first test without historical performance. An existing test under review with insufficient data should wait. A changed-audience retest can propose a controlled test from a scoped lesson without claiming a winner. Missing essential brief information means wait.';
}

export function isOpenRouterBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://openrouter.ai' && url.pathname.replace(/\/$/, '') === '/api/v1';
  } catch { return false; }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new ProviderError(`${name} must be an integer from ${min} to ${max}.`, 'configuration');
  return result;
}

function hasToolCalls(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
}

function safeMetadataText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (clean.length === 0 || clean.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$/.test(clean)) return undefined;
  return clean;
}

function readUsageMetadata(value: unknown): LiquidUsageMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object' && !Array.isArray(usage.completion_tokens_details)
    ? usage.completion_tokens_details as Record<string, unknown>
    : undefined;
  const result: LiquidUsageMetadata = {};
  addTokenCount(result, 'promptTokens', usage.prompt_tokens);
  addTokenCount(result, 'completionTokens', usage.completion_tokens);
  addTokenCount(result, 'totalTokens', usage.total_tokens);
  addTokenCount(result, 'reasoningTokens', usage.reasoning_tokens ?? details?.reasoning_tokens);
  return Object.keys(result).length ? result : undefined;
}

function addTokenCount(target: LiquidUsageMetadata, key: keyof LiquidUsageMetadata, value: unknown): void {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) target[key] = value;
}

function validateContext(context: ExperimentContext): ExperimentContext {
  const brief = boundedText(context?.brief, 'brief', 4_000);
  if (!Array.isArray(context.evidence) || context.evidence.length > 30 || !Array.isArray(context.lessons) || context.lessons.length > 20) throw new ProviderError('Liquid context exceeds limits.', 'configuration');
  if (context.stage !== undefined && context.stage !== 'initial' && context.stage !== 'review' && context.stage !== 'retest') {
    throw new ProviderError('Liquid context stage is invalid.', 'configuration');
  }
  const evidence = context.evidence.map(item => ({ id: boundedText(item?.id, 'evidence id', 100), summary: boundedText(item?.summary, 'evidence summary', 500) }));
  const lessons = context.lessons.map(item => ({ id: boundedText(item?.id, 'lesson id', 100), statement: boundedText(item?.statement, 'lesson statement', 500) }));
  if (new Set(evidence.map(item => item.id)).size !== evidence.length) throw new ProviderError('Evidence IDs must be unique.', 'configuration');
  return { brief, evidence, lessons, ...(context.stage === undefined ? {} : { stage: context.stage }) };
}

function validateDecision(value: unknown, suppliedEvidence: Set<string>): ExperimentDecision {
  const v = object(value, 'Liquid returned an invalid decision.');
  if (v.action !== 'wait' && v.action !== 'propose_test') throw new ProviderError('Liquid decision action is invalid.', 'response');
  const explanation = boundedText(v.explanation, 'explanation', 1_000);
  let hypothesis: string;
  let headlines: string[];
  if (v.action === 'wait') {
    if (v.hypothesis !== '' || !Array.isArray(v.headlines) || v.headlines.length !== 0) throw new ProviderError('Liquid wait decisions must not propose creative.', 'response');
    hypothesis = '';
    headlines = [];
  } else {
    hypothesis = boundedText(v.hypothesis, 'hypothesis', 500);
    if (hypothesis.length < 10) throw new ProviderError('Liquid test hypothesis is too short.', 'response');
    if (!Array.isArray(v.headlines) || v.headlines.length < 2 || v.headlines.length > 3) throw new ProviderError('Liquid decision must include 2 or 3 comparable headlines.', 'response');
    headlines = v.headlines.map(x => boundedText(x, 'headline', 120));
    if (new Set(headlines.map(x => x.toLocaleLowerCase())).size !== headlines.length) throw new ProviderError('Liquid comparison headlines must be unique.', 'response');
  }
  if (!Array.isArray(v.evidenceIds) || v.evidenceIds.length > 30 || v.evidenceIds.some(id => typeof id !== 'string' || !suppliedEvidence.has(id))) throw new ProviderError('Liquid decision cited evidence that was not supplied.', 'response');
  return { action: v.action, explanation, hypothesis, headlines, evidenceIds: [...new Set(v.evidenceIds as string[])] };
}
