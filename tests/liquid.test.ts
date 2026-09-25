import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiquidClient, LIQUID_DEFAULT_MAX_TOKENS, LIQUID_DEFAULT_TIMEOUT_MS, isOpenRouterBaseUrl, type ExperimentDecision } from '../server/providers/liquid.js';
import { createProviders, getIntegrationStatuses } from '../server/providers/index.js';

const openRouterBase = 'https://openrouter.ai/api/v1';
const openRouterModel = 'liquid/lfm-2.5-2.6b:free';
const apiKey = 'test-only-openrouter-key';
const context = {
  brief: 'A subscription tool for small design teams. Approved claim: save time organizing feedback.',
  evidence: [{ id: 'exp-1-variant-a', summary: 'The current headline has four signups.' }],
  lessons: [{ id: 'lesson-1', statement: 'Keep the offer and image consistent.' }],
};
const decision: ExperimentDecision = {
  action: 'propose_test',
  explanation: 'The brief supports a small headline test.',
  hypothesis: 'A direct time-saving headline may improve signups.',
  headlines: ['Organize feedback in less time', 'Keep team feedback organized'],
  evidenceIds: ['exp-1-variant-a'],
};

afterEach(() => vi.useRealTimers());

function openRouterResponse(options: {
  choice?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  content?: string;
} = {}): Response {
  const choice = {
    finish_reason: 'stop',
    message: { role: 'assistant', content: options.content ?? JSON.stringify(decision) },
    ...options.choice,
  };
  return new Response(JSON.stringify({
    id: 'gen-test-123',
    model: openRouterModel,
    choices: [choice],
    usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280, completion_tokens_details: { reasoning_tokens: 25, private_reasoning: 'never expose this' } },
    reasoning: 'never expose this either',
    ...options.payload,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function client(fetchImpl: typeof fetch, options: { maxTokens?: number; timeoutMs?: number } = {}) {
  return new LiquidClient({ baseUrl: openRouterBase, model: openRouterModel, apiKey, ...options }, fetchImpl);
}

describe('OpenRouter Liquid adapter', () => {
  it('sends strict structured output to the exact configured free model and returns bounded attribution metadata', async () => {
    let request: { url: URL; init: RequestInit; body: Record<string, any> } | undefined;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const url = input instanceof URL ? input : new URL(String(input));
      request = { url, init, body: JSON.parse(String(init.body)) as Record<string, any> };
      return openRouterResponse();
    };
    const result = await client(fetchImpl).proposeExperimentWithMetadata(context);

    expect(request?.url.href).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request?.init.method).toBe('POST');
    expect(request?.init.redirect).toBe('error');
    expect((request?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${apiKey}`);
    expect(request?.body).toMatchObject({
      model: openRouterModel,
      max_tokens: LIQUID_DEFAULT_MAX_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'experiment_decision',
          strict: true,
          schema: {
            required: ['action', 'explanation', 'hypothesis', 'headlines', 'evidenceIds'],
            additionalProperties: false,
          },
        },
      },
      provider: { require_parameters: true, allow_fallbacks: false },
      reasoning: { exclude: true },
    });
    expect(request?.body.response_format.json_schema.schema.properties).toHaveProperty('evidenceIds');
    expect(request?.body.response_format.json_schema.schema.properties.hypothesis.description).toContain('exactly the empty string');
    expect(request?.body.response_format.json_schema.schema.properties.headlines.description).toContain('empty array');
    expect(result.decision).toEqual(decision);
    expect(result.metadata).toMatchObject({
      requestId: 'gen-test-123', model: openRouterModel, finishReason: 'stop',
      usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280, reasoningTokens: 25 },
    });
    expect(result.metadata.elapsedMs).toEqual(expect.any(Number));
    expect(result.metadata.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result.metadata)).not.toContain('never expose this');
    expect(JSON.stringify(result)).not.toContain('never expose this');
  });

  it('requires an API key only for the trusted OpenRouter endpoint and detects no lookalike hosts', () => {
    expect(isOpenRouterBaseUrl(openRouterBase)).toBe(true);
    expect(isOpenRouterBaseUrl(`${openRouterBase}/`)).toBe(true);
    expect(isOpenRouterBaseUrl('https://openrouter.ai.evil.example/api/v1')).toBe(false);
    expect(isOpenRouterBaseUrl('https://openrouter.ai:9443/api/v1')).toBe(false);
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1evil')).toBe(false);
    expect(() => new LiquidClient({ baseUrl: openRouterBase, model: openRouterModel })).toThrow('LIQUID_API_KEY is required for OpenRouter.');

    const noKey = getIntegrationStatuses({ LIQUID_BASE_URL: openRouterBase, LIQUID_MODEL: openRouterModel });
    expect(noKey.find(item => item.id === 'liquid')).toMatchObject({
      provider: 'Liquid AI / OpenRouter', status: 'not_configured', missing: ['LIQUID_API_KEY'],
    });
    const lookalike = getIntegrationStatuses({ LIQUID_BASE_URL: 'https://openrouter.ai.evil.example/api/v1', LIQUID_MODEL: openRouterModel });
    expect(lookalike.find(item => item.id === 'liquid')?.provider).toBe('Liquid AI / llama.cpp');
  });

  it('uses configurable bounded token and timeout values and rejects invalid settings', async () => {
    expect(() => new LiquidClient({ baseUrl: openRouterBase, model: openRouterModel, apiKey, maxTokens: 0 })).toThrow(/LIQUID_MAX_TOKENS/);
    expect(() => new LiquidClient({ baseUrl: openRouterBase, model: openRouterModel, apiKey, maxTokens: 8193 })).toThrow(/LIQUID_MAX_TOKENS/);
    expect(() => new LiquidClient({ baseUrl: openRouterBase, model: openRouterModel, apiKey, maxTokens: 1.5 })).toThrow(/LIQUID_MAX_TOKENS/);
    expect(() => new LiquidClient({ baseUrl: openRouterBase, model: openRouterModel, apiKey, timeoutMs: 999 })).toThrow(/LIQUID_TIMEOUT_MS/);
    expect(() => new LiquidClient({ baseUrl: openRouterBase, model: openRouterModel, apiKey, timeoutMs: 120_001 })).toThrow(/LIQUID_TIMEOUT_MS/);

    for (const invalid of ['NaN', 'Infinity', '1.5', ' ', '0', '8193']) {
      const status = getIntegrationStatuses({
        LIQUID_BASE_URL: openRouterBase, LIQUID_MODEL: openRouterModel, LIQUID_API_KEY: apiKey, LIQUID_MAX_TOKENS: invalid,
      }).find(item => item.id === 'liquid');
      expect(status?.status, `LIQUID_MAX_TOKENS=${JSON.stringify(invalid)}`).toBe('invalid');
    }

    let requestBody: Record<string, any> | undefined;
    const providers = createProviders({
      LIQUID_BASE_URL: openRouterBase, LIQUID_MODEL: openRouterModel, LIQUID_API_KEY: apiKey,
      LIQUID_MAX_TOKENS: '777', LIQUID_TIMEOUT_MS: '1200',
    }, async (_input, init = {}) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, any>;
      return openRouterResponse();
    });
    await providers.liquid?.proposeExperiment(context);
    expect(requestBody?.max_tokens).toBe(777);

    const defaults = getIntegrationStatuses({
      LIQUID_BASE_URL: openRouterBase, LIQUID_MODEL: openRouterModel, LIQUID_API_KEY: apiKey,
    }).find(item => item.id === 'liquid');
    expect(defaults?.status).toBe('configured');
    expect(LIQUID_DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  it.each([
    ['length', 'Liquid response exhausted its completion token budget.'],
    ['content_filter', 'Liquid response did not finish cleanly.'],
    ['error', 'Liquid response did not finish cleanly.'],
    ['tool_calls', 'Liquid response did not finish cleanly.'],
    ['unknown_finish_reason', 'Liquid response did not finish cleanly.'],
  ])('rejects a non-stop finish reason: %s', async (finishReason, message) => {
    const clientUnderTest = client(async () => openRouterResponse({ choice: { finish_reason: finishReason } }));
    await expect(clientUnderTest.proposeExperimentWithMetadata(context)).rejects.toMatchObject({
      code: 'response', message,
    });
  });

  it.each([
    ['initial', 'STAGE POLICY — INITIAL'],
    ['review', 'STAGE POLICY — REVIEW'],
    ['retest', 'STAGE POLICY — RETEST'],
  ] as const)('forwards the %s stage and its policy without changing the decision schema', async (stage, policy) => {
    let requestBody: Record<string, any> | undefined;
    const clientUnderTest = client(async (_input, init = {}) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, any>;
      return openRouterResponse();
    });

    const result = await clientUnderTest.proposeExperimentWithMetadata({ ...context, stage });

    expect(result.decision).toEqual(decision);
    expect(JSON.parse(requestBody?.messages[1].content as string)).toMatchObject({ stage });
    expect(requestBody?.messages[0].content).toContain(policy);
    expect(requestBody?.response_format.json_schema.schema.required).toEqual(['action', 'explanation', 'hypothesis', 'headlines', 'evidenceIds']);
  });

  it('preserves omitted stage compatibility and rejects an invalid stage before making a request', async () => {
    let requestCount = 0;
    let requestBody: Record<string, any> | undefined;
    const clientUnderTest = client(async (_input, init = {}) => {
      requestCount += 1;
      requestBody = JSON.parse(String(init.body)) as Record<string, any>;
      return openRouterResponse();
    });

    await clientUnderTest.proposeExperiment(context);
    const normalizedContext = JSON.parse(requestBody?.messages[1].content as string);
    expect(normalizedContext).not.toHaveProperty('stage');
    expect(requestBody?.messages[0].content).toContain('STAGE POLICY — UNSPECIFIED');

    await expect(clientUnderTest.proposeExperiment({ ...context, stage: 'pivot' } as unknown as typeof context)).rejects.toMatchObject({
      code: 'configuration', message: 'Liquid context stage is invalid.',
    });
    expect(requestCount).toBe(1);
  });

  it('rejects truncated JSON, provider/choice errors, refusals, tool calls, and unknown evidence IDs without returning provider text', async () => {
    const fixtures: Array<{ name: string; response: () => Response; message: string }> = [
      { name: 'truncated json', response: () => openRouterResponse({ content: '{' }), message: 'Liquid returned malformed decision JSON.' },
      { name: 'top-level error', response: () => openRouterResponse({ payload: { error: { message: `private ${apiKey}` } } }), message: 'Liquid provider returned an error.' },
      { name: 'choice-level error', response: () => openRouterResponse({ choice: { error: { message: `private ${apiKey}` } } }), message: 'Liquid provider returned an error.' },
      { name: 'refusal object', response: () => openRouterResponse({ choice: { message: { role: 'assistant', refusal: { reason: `private ${apiKey}` }, content: JSON.stringify(decision) } } }), message: 'Liquid declined to provide a decision.' },
      { name: 'tool call', response: () => openRouterResponse({ choice: { message: { role: 'assistant', tool_calls: [{ id: 'x' }], content: JSON.stringify(decision) } } }), message: 'Liquid response attempted to call a tool.' },
      { name: 'unknown evidence', response: () => openRouterResponse({ content: JSON.stringify({ ...decision, evidenceIds: ['not-supplied'] }) }), message: 'Liquid decision cited evidence that was not supplied.' },
    ];
    for (const fixture of fixtures) {
      const clientUnderTest = client(async () => fixture.response());
      const error = await clientUnderTest.proposeExperimentWithMetadata(context).catch(value => value as Error);
      expect(error, fixture.name).toBeInstanceOf(Error);
      expect(error.message, fixture.name).toBe(fixture.message);
      expect(error.message, fixture.name).not.toContain(apiKey);
    }
  });

  it('accepts a clean wait and rejects any wait that includes hypothesis text or headlines', async () => {
    const cleanWait: ExperimentDecision = {
      action: 'wait', explanation: 'The brief does not specify a campaign goal.', hypothesis: '', headlines: [], evidenceIds: [],
    };
    const validClient = client(async () => openRouterResponse({ content: JSON.stringify(cleanWait) }));
    await expect(validClient.proposeExperiment(context)).resolves.toEqual(cleanWait);

    for (const malformed of [
      { ...cleanWait, hypothesis: 'Try a brighter promise.' },
      { ...cleanWait, headlines: ['Built to Last'] },
    ]) {
      const invalidClient = client(async () => openRouterResponse({ content: JSON.stringify(malformed) }));
      await expect(invalidClient.proposeExperiment(context)).rejects.toMatchObject({
        code: 'response', message: 'Liquid wait decisions must not propose creative.',
      });
    }
  });

  it('requires a stop finish reason for OpenRouter but preserves legacy local JSON-object responses', async () => {
    const missingOpenRouterFinish = client(async () => openRouterResponse({ choice: { finish_reason: undefined } }));
    await expect(missingOpenRouterFinish.proposeExperiment(context)).rejects.toMatchObject({
      code: 'response', message: 'OpenRouter response did not include a finish reason.',
    });

    let body: Record<string, any> | undefined;
    const local = new LiquidClient({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'lfm2.5-1.2b-instruct' }, async (_input, init = {}) => {
      body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        action: 'wait', explanation: 'There is not enough information.', hypothesis: '', headlines: [], evidenceIds: [],
      }) } }] }), { status: 200 });
    });
    const result = await local.proposeExperimentWithMetadata(context);
    expect(body?.response_format).toEqual({ type: 'json_object' });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('reasoning');
    expect(result.decision.action).toBe('wait');
    expect(result.metadata).not.toHaveProperty('finishReason');
  });

  it('keeps the configured timeout active through body consumption', async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"gen-timeout"')); },
      pull() { return new Promise<void>(() => {}); },
    });
    const timed = new LiquidClient({ baseUrl: 'http://localhost:8080/v1', model: 'local-test', timeoutMs: 1_000 }, async () => new Response(stream));
    const pending = timed.proposeExperiment(context);
    const expectedTimeout = expect(pending).rejects.toMatchObject({ code: 'timeout', message: 'Liquid request timed out.' });
    await vi.advanceTimersByTimeAsync(1_000);
    await expectedTimeout;
  });
});
