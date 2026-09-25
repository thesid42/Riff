import { ProviderError, boundedText, cancelBody, object, readJson, rejectRedirect, safeBaseUrl, timeoutSignal, type FetchLike } from './common.js';

export interface ExperimentContext {
  brief: string;
  evidence: Array<{ id: string; summary: string }>;
  lessons: Array<{ id: string; statement: string }>;
}
export interface ExperimentDecision {
  action: 'wait' | 'propose_test';
  explanation: string;
  hypothesis: string;
  headlines: string[];
  evidenceIds: string[];
}

export class LiquidClient {
  private readonly base: URL;
  private readonly model: string;
  private readonly apiKey?: string;
  constructor(private readonly config: { baseUrl: string; model: string; apiKey?: string }, private readonly fetchImpl: FetchLike = fetch) {
    this.base = safeBaseUrl(config.baseUrl, 'LIQUID_BASE_URL', ['http:', 'https:']);
    this.model = boundedText(config.model, 'LIQUID_MODEL', 120);
    this.apiKey = config.apiKey === undefined ? undefined : boundedText(config.apiKey, 'LIQUID_API_KEY', 4_096);
    if (this.base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)) {
      throw new ProviderError('LIQUID_BASE_URL may use HTTP only on localhost.', 'configuration');
    }
  }

  async proposeExperiment(context: ExperimentContext, signal?: AbortSignal): Promise<ExperimentDecision> {
    const normalized = validateContext(context);
    const timeout = timeoutSignal(30_000, signal);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const url = new URL('chat/completions', this.base.href.endsWith('/') ? this.base : `${this.base.href}/`);
      const response = await this.fetchImpl(url, {
        method: 'POST', headers, redirect: 'error', signal: timeout.signal,
        body: JSON.stringify({ model: this.model, temperature: 0.1, max_tokens: 512, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: 'Return only JSON with action (wait or propose_test), explanation, hypothesis, headlines, evidenceIds (only supplied IDs). For wait, use hypothesis:"" and headlines:[]. For propose_test, give a specific hypothesis and 2 or 3 comparable headlines. Do not invent evidence IDs or claim evidence that was not supplied. No tools.' },
            { role: 'user', content: JSON.stringify(normalized) }] }),
      });
      await rejectRedirect(response);
      if (!response.ok) { await cancelBody(response); throw new ProviderError(`Liquid request failed with HTTP ${response.status}.`); }
      const payload = object(await readJson(response, 256_000, timeout.signal));
      const choices = payload.choices;
      if (!Array.isArray(choices) || choices.length < 1) throw new ProviderError('Liquid response did not include a choice.', 'response');
      const message = object(object(choices[0]).message);
      if (typeof message.content !== 'string' || message.content.length > 16_000) throw new ProviderError('Liquid response content was invalid.', 'response');
      let parsed: unknown;
      try { parsed = JSON.parse(message.content); } catch { throw new ProviderError('Liquid returned malformed decision JSON.', 'response'); }
      return validateDecision(parsed, new Set(normalized.evidence.map(item => item.id)));
    } catch (error) {
      if (timeout.signal.aborted) throw new ProviderError(signal?.aborted ? 'Liquid request was cancelled.' : 'Liquid request timed out.', 'timeout');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Liquid network request failed.');
    } finally { timeout.dispose(); }
  }
}

function validateContext(context: ExperimentContext): ExperimentContext {
  const brief = boundedText(context?.brief, 'brief', 4_000);
  if (!Array.isArray(context.evidence) || context.evidence.length > 30 || !Array.isArray(context.lessons) || context.lessons.length > 20) throw new ProviderError('Liquid context exceeds limits.', 'configuration');
  const evidence = context.evidence.map(item => ({ id: boundedText(item?.id, 'evidence id', 100), summary: boundedText(item?.summary, 'evidence summary', 500) }));
  const lessons = context.lessons.map(item => ({ id: boundedText(item?.id, 'lesson id', 100), statement: boundedText(item?.statement, 'lesson statement', 500) }));
  if (new Set(evidence.map(item => item.id)).size !== evidence.length) throw new ProviderError('Evidence IDs must be unique.', 'configuration');
  return { brief, evidence, lessons };
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
