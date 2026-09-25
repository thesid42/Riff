import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiquidClient, LIQUID_DEFAULT_MAX_TOKENS, LIQUID_DEFAULT_TIMEOUT_MS, LIQUID_VISION_IMAGE_MAX_BYTES, isOpenRouterBaseUrl, type ExperimentDecision } from '../server/providers/liquid.js';
import { createProviders, getIntegrationStatuses } from '../server/providers/index.js';
import { countHeadlineCharacters, HEADLINE_MAX_LENGTH, isStoredHeadlineSet, isValidHeadlineSet, LEGACY_HEADLINE_MAX_LENGTH } from '../shared/headlines.js';

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
  personaIds: [],
  needsNewCreative: false,
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
            required: ['action', 'explanation', 'hypothesis', 'headlines', 'evidenceIds', 'personaIds', 'needsNewCreative'],
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
    expect(request?.body.response_format.json_schema.schema.properties.headlines.items.maxLength).toBe(HEADLINE_MAX_LENGTH);
    expect(request?.body.response_format.json_schema.schema.properties.headlines.items.description).toContain('ready-to-display ad headline');
    expect(request?.body.messages[0].content).toContain('final, ready-to-display ad headlines');
    expect(request?.body.messages[0].content).toContain('language of the brief');
    expect(request?.body.messages[0].content).toContain('complete headline-and-visual concepts');
    expect(request?.body.messages[0].content).not.toContain('keep the image');
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
    expect(requestBody?.response_format.json_schema.schema.required).toEqual(['action', 'explanation', 'hypothesis', 'headlines', 'evidenceIds', 'personaIds', 'needsNewCreative']);
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

  it('rejects truncated JSON, provider/choice errors, refusals, and tool calls without returning provider text', async () => {
    const fixtures: Array<{ name: string; response: () => Response; message: string }> = [
      { name: 'truncated json', response: () => openRouterResponse({ content: '{' }), message: 'Liquid returned malformed decision JSON.' },
      { name: 'top-level error', response: () => openRouterResponse({ payload: { error: { message: `private ${apiKey}` } } }), message: 'Liquid provider returned an error.' },
      { name: 'choice-level error', response: () => openRouterResponse({ choice: { error: { message: `private ${apiKey}` } } }), message: 'Liquid provider returned an error.' },
      { name: 'refusal object', response: () => openRouterResponse({ choice: { message: { role: 'assistant', refusal: { reason: `private ${apiKey}` }, content: JSON.stringify(decision) } } }), message: 'Liquid declined to provide a decision.' },
      { name: 'tool call', response: () => openRouterResponse({ choice: { message: { role: 'assistant', tool_calls: [{ id: 'x' }], content: JSON.stringify(decision) } } }), message: 'Liquid response attempted to call a tool.' },
    ];
    for (const fixture of fixtures) {
      const clientUnderTest = client(async () => fixture.response());
      const error = await clientUnderTest.proposeExperimentWithMetadata(context).catch(value => value as Error);
      expect(error, fixture.name).toBeInstanceOf(Error);
      expect(error.message, fixture.name).toBe(fixture.message);
      expect(error.message, fixture.name).not.toContain(apiKey);
    }
  });

  it('clips a long local-planner explanation instead of failing headline suggestions', async () => {
    const long = `${'The brief is complete enough to propose a first headline test. '.repeat(8)}Extra.`;
    expect(long.length).toBeGreaterThan(300);
    const result = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...decision, explanation: long }),
    })).proposeExperiment(context);
    expect(result.explanation.length).toBeGreaterThan(0);
    expect(Array.from(result.explanation).length).toBeLessThanOrEqual(300);
    expect(result.headlines).toEqual(decision.headlines);
  });

  it('accepts a missing or array explanation from the local VLM', async () => {
    const { explanation: _ignored, ...without } = decision;
    const missing = await client(async () => openRouterResponse({
      content: JSON.stringify(without),
    })).proposeExperiment(context);
    expect(missing.explanation).toBe('The saved brief supports a first headline comparison.');

    const listed = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...decision, explanation: ['The brief is complete.', 'A headline test can start.'] }),
    })).proposeExperiment(context);
    expect(listed.explanation).toBe('The brief is complete. A headline test can start.');
  });

  it('accepts a clean wait and strips leftover creative from a sloppy wait', async () => {
    const cleanWait: ExperimentDecision = {
      action: 'wait', explanation: 'The brief does not specify a campaign goal.', hypothesis: '', headlines: [], evidenceIds: [], personaIds: [], needsNewCreative: false,
    };
    const validClient = client(async () => openRouterResponse({ content: JSON.stringify(cleanWait) }));
    await expect(validClient.proposeExperiment(context)).resolves.toEqual(cleanWait);

    for (const malformed of [
      { ...cleanWait, hypothesis: 'Try a brighter promise.' },
      { ...cleanWait, headlines: ['Built to Last'] },
      { ...cleanWait, needsNewCreative: true },
    ]) {
      const coerced = await client(async () => openRouterResponse({ content: JSON.stringify(malformed) })).proposeExperiment(context);
      expect(coerced).toEqual(cleanWait);
    }
  });

  it('promotes a wait that includes 2 or 3 headlines into the next test', async () => {
    const promoted = await client(async () => openRouterResponse({
      content: JSON.stringify({
        action: 'wait',
        explanation: 'A closer desk crop may raise clicks.',
        hypothesis: 'A tighter lunch-desk scene may help.',
        headlines: ['Save time organizing design notes', 'Keep team feedback organized'],
        evidenceIds: ['exp-1-variant-a'],
        personaIds: [],
        needsNewCreative: true,
      }),
    })).proposeExperiment(context);
    expect(promoted.action).toBe('propose_test');
    expect(promoted.headlines).toEqual(['Save time organizing design notes', 'Keep team feedback organized']);
    expect(promoted.needsNewCreative).toBe(true);
    expect(promoted.hypothesis).toContain('tighter lunch-desk');
  });

  it('coerces a missing, object, or oversized propose_test hypothesis', async () => {
    const fallback = 'The latest wave supports a follow-up headline and creative test.';
    const base = {
      action: 'propose_test' as const,
      explanation: 'A closer desk crop may raise clicks.',
      headlines: ['Save time organizing design notes', 'Keep team feedback organized'],
      evidenceIds: ['exp-1-variant-a'],
      personaIds: [],
      needsNewCreative: true,
    };
    const missing = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...base, hypothesis: '' }),
    })).proposeExperiment({ ...context, stage: 'review' });
    expect(missing.action).toBe('propose_test');
    expect(missing.hypothesis).toBe(fallback);

    const nested = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...base, hypothesis: { text: 'A tighter lunch-desk scene may help more people stop.' } }),
    })).proposeExperiment({ ...context, stage: 'review' });
    expect(nested.hypothesis).toContain('tighter lunch-desk');

    const alias = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...base, hypothesis: '   ', proposal: 'Try a closer product hero on a clear desk.' }),
    })).proposeExperiment({ ...context, stage: 'review' });
    expect(alias.hypothesis).toContain('closer product hero');

    const long = `${'A closer crop should help. '.repeat(40)}Keep the product large in frame.`;
    const clipped = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...base, hypothesis: long }),
    })).proposeExperiment({ ...context, stage: 'review' });
    expect(clipped.hypothesis.length).toBeGreaterThan(10);
    expect(clipped.hypothesis.length).toBeLessThanOrEqual(500);
  });

  it('keeps only supplied evidence IDs when the planner invents extras', async () => {
    const mixed = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...decision, evidenceIds: ['not-supplied', 'exp-1-variant-a', { id: 'exp-1-variant-a' }] }),
    })).proposeExperiment({ ...context, stage: 'review' });
    expect(mixed.evidenceIds).toEqual(['exp-1-variant-a']);

    const unknownOnly = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...decision, evidenceIds: ['made-up-id'] }),
    })).proposeExperiment({ ...context, stage: 'review' });
    expect(unknownOnly.evidenceIds).toEqual([]);
  });

  it('counts trimmed Unicode code points and preserves the separate legacy stored-headline limit', () => {
    expect(countHeadlineCharacters('  🌱A  ')).toBe(2);
    expect(HEADLINE_MAX_LENGTH).toBe(60);
    expect(LEGACY_HEADLINE_MAX_LENGTH).toBe(120);
    expect(isValidHeadlineSet(['🌱'.repeat(60), 'é'.repeat(60)])).toBe(true);
    expect(isValidHeadlineSet(['🌱'.repeat(61), 'A second line'])).toBe(false);
    expect(isValidHeadlineSet(['A\nB', 'A second line'])).toBe(false);
    expect(isValidHeadlineSet(['A�B', 'A second line'])).toBe(false);
    expect(isStoredHeadlineSet(['x'.repeat(120), 'another stored line'])).toBe(true);
    expect(isStoredHeadlineSet(['x'.repeat(121), 'another stored line'])).toBe(false);
  });

  it('accepts accented Latin and emoji, rejects stray non-Latin generated copy, and permits mixed-language briefs', async () => {
    const accented: ExperimentDecision = {
      ...decision,
      headlines: ['Café teams, find focus ✨', "Don't miss your design team's next win"],
    };
    const accentedClient = client(async () => openRouterResponse({ content: JSON.stringify(accented) }));
    await expect(accentedClient.proposeExperiment(context)).resolves.toEqual(accented);

    const strayScript: ExperimentDecision = {
      ...decision,
      headlines: ['Try 现在 today', 'Keep feedback clear'],
    };
    const wrongLanguageClient = client(async () => openRouterResponse({ content: JSON.stringify(strayScript) }));
    await expect(wrongLanguageClient.proposeExperiment(context)).rejects.toMatchObject({
      code: 'response', message: 'Liquid headlines do not match the campaign brief language.',
    });

    const mixedLanguageContext = { ...context, brief: `${context.brief} Audience note: 中文用户。` };
    const multilingual: ExperimentDecision = { ...decision, headlines: ['更轻松地整理设计反馈', 'Keep feedback clear'] };
    const multilingualClient = client(async () => openRouterResponse({ content: JSON.stringify(multilingual) }));
    await expect(multilingualClient.proposeExperiment(mixedLanguageContext)).resolves.toEqual(multilingual);
  });

  it('accepts a 60-code-point Liquid headline and clips a longer one instead of failing', async () => {
    const exact: ExperimentDecision = { ...decision, headlines: ['A'.repeat(60), 'B'.repeat(60)] };
    const validClient = client(async () => openRouterResponse({ content: JSON.stringify(exact) }));
    await expect(validClient.proposeExperiment(context)).resolves.toEqual(exact);

    const overLimit: ExperimentDecision = { ...decision, headlines: ['A'.repeat(61), 'A second line'] };
    const clipped = await client(async () => openRouterResponse({ content: JSON.stringify(overLimit) })).proposeExperiment(context);
    expect(clipped.headlines).toEqual(['A'.repeat(60), 'A second line']);
  });

  it('coerces messy local-VLM headlines into 2 or 3 unique clipped lines', async () => {
    const objects = await client(async () => openRouterResponse({
      content: JSON.stringify({
        ...decision,
        headlines: [
          { headline: 'Save time organizing design feedback for small teams today now' },
          { title: 'Keep team feedback organized' },
          { text: 'Save time organizing design feedback for small teams today now' },
        ],
      }),
    })).proposeExperiment(context);
    expect(objects.headlines).toEqual([
      'Save time organizing design feedback for small teams today',
      'Keep team feedback organized',
    ]);

    const extras = await client(async () => openRouterResponse({
      content: JSON.stringify({
        ...decision,
        headlines: [
          'Organize feedback in less time',
          'Keep team feedback organized',
          'Save hours on design notes',
          'A fourth unused line',
        ],
      }),
    })).proposeExperiment(context);
    expect(extras.headlines).toEqual([
      'Organize feedback in less time',
      'Keep team feedback organized',
      'Save hours on design notes',
    ]);

    const listed = await client(async () => openRouterResponse({
      content: JSON.stringify({
        ...decision,
        headlines: '1. Organize feedback in less time\n2. Keep team feedback organized',
      }),
    })).proposeExperiment(context);
    expect(listed.headlines).toEqual(['Organize feedback in less time', 'Keep team feedback organized']);

    const titled = await client(async () => openRouterResponse({
      content: JSON.stringify({
        action: decision.action,
        explanation: decision.explanation,
        hypothesis: decision.hypothesis,
        titles: ['Organize feedback in less time', 'Keep team feedback organized'],
        evidenceIds: decision.evidenceIds,
        personaIds: decision.personaIds,
        needsNewCreative: decision.needsNewCreative,
      }),
    })).proposeExperiment(context);
    expect(titled.headlines).toEqual(decision.headlines);

    const tooFew = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...decision, headlines: ['Only one line'] }),
    })).proposeExperiment(context).catch(value => value as Error);
    expect(tooFew).toBeInstanceOf(Error);
    expect(tooFew.message).toBe('Liquid must return 2 or 3 final headlines of up to 60 characters each.');
  });

  it('accepts only supplied persona IDs, requires none for wait, and sends the persona whitelist', async () => {
    const withPersonas = { ...context, personas: [{ id: 'us-chi-manager', label: 'Chicago manager' }], stage: 'review' as const };
    let requestBody: Record<string, any> | undefined;
    const targeted = { ...decision, personaIds: ['us-chi-manager'], needsNewCreative: true };
    const validClient = client(async (_input, init = {}) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, any>;
      return openRouterResponse({ content: JSON.stringify(targeted) });
    });
    await expect(validClient.proposeExperiment(withPersonas)).resolves.toEqual(targeted);
    expect(JSON.parse(requestBody?.messages[1].content as string).personas).toEqual(withPersonas.personas);

    const waitWithPersona = await client(async () => openRouterResponse({
      content: JSON.stringify({ action: 'wait', explanation: 'Too little data.', hypothesis: '', headlines: [], evidenceIds: [], personaIds: ['us-chi-manager'], needsNewCreative: false }),
    })).proposeExperiment(withPersonas);
    expect(waitWithPersona).toEqual({
      action: 'wait', explanation: 'Too little data.', hypothesis: '', headlines: [], evidenceIds: [], personaIds: [], needsNewCreative: false,
    });

    const droppedUnknown = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...decision, personaIds: ['not-supplied', 'us-chi-manager'] }),
    })).proposeExperiment(withPersonas);
    expect(droppedUnknown.personaIds).toEqual(['us-chi-manager']);

    const noWhitelist = await client(async () => openRouterResponse({
      content: JSON.stringify({ ...decision, personaIds: ['us-chi-manager'] }),
    })).proposeExperiment(context);
    expect(noWhitelist.personaIds).toEqual([]);

    const clientUnderTest = client(async () => openRouterResponse({ content: JSON.stringify({ ...decision, needsNewCreative: 'yes' }) }));
    await expect(clientUnderTest.proposeExperiment(withPersonas)).rejects.toMatchObject({
      code: 'response',
      message: 'Liquid decision needsNewCreative must be a boolean.',
    });
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

  it('judges headline copy only when no media bytes are attached', async () => {
    const judgment = {
      action: 'signup',
      reason: 'The 750 ml capacity is clear in the headline.',
      dwellSeconds: 9,
      timeToActionSeconds: 5,
      confidence: 0.8,
      attention: 0.7,
      clarity: 0.9,
      trust: 0.6,
      purchaseIntent: 0.5,
      noticedFirst: 'headline',
      friction: 'none',
    };
    let body: Record<string, any> | undefined;
    const result = await client(async (_input, init = {}) => {
      body = JSON.parse(String(init.body)) as Record<string, any>;
      return openRouterResponse({ content: JSON.stringify(judgment) });
    }).judgeCreative({
      brief: 'Campaign: Bottle\nProduct: 750 ml bottle',
      personaCard: 'You are a 25–34-year-old specialist.',
      personaLabel: '25–34 specialist',
      assignedHeadline: 'A 750 ml bottle for every day',
      siblingHeadlines: ['Take 750 ml along for the day'],
      mediaUrl: '/api/creative-assets/job-1',
      mediaType: 'image',
    });
    expect(body?.response_format.json_schema.name).toBe('persona_judgment');
    expect(body?.messages[1].content).toContain('A 750 ml bottle for every day');
    expect(body?.messages[1].content).toContain('Take 750 ml along for the day');
    expect(body?.messages[0].content).toContain('If mediaAttached is false, judge copy only');
    expect(body?.messages[0].content).toContain('Use image or video only when you inspected attached media');
    expect(body?.messages[0].content).toContain('Matching the campaign brief or product facts is not a reason to click or sign up');
    expect(JSON.parse(body?.messages[1].content as string).scrollContext.defaultAction).toBe('skip');
    expect(JSON.parse(body?.messages[1].content as string)).toMatchObject({
      mediaUrl: '/api/creative-assets/job-1', mediaType: 'image', mediaAttached: false,
    });
    expect(result.judgment).toEqual(judgment);
    expect(result.metadata.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.usage?.promptTokens).toBe(200);
    expect(body?.max_tokens).toBe(LIQUID_DEFAULT_MAX_TOKENS);
  });

  it('attaches image pixels as a vision data URL when media is supplied', async () => {
    const judgment = {
      action: 'click',
      reason: 'The bottle in the photo matches the everyday claim.',
      dwellSeconds: 11,
      timeToActionSeconds: 6,
      confidence: 0.7,
      attention: 0.8,
      clarity: 0.7,
      trust: 0.6,
      purchaseIntent: 0.5,
      noticedFirst: 'image',
      friction: 'none',
    };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let body: Record<string, any> | undefined;
    const local = new LiquidClient({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'LiquidAI/LFM2.5-VL-3B-MLX-8bit' }, async (_input, init = {}) => {
      body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(judgment) } }] }), { status: 200 });
    });
    const result = await local.judgeCreative({
      brief: 'Campaign: Bottle\nProduct: 750 ml bottle',
      personaCard: 'You are a 25–34-year-old specialist.',
      personaLabel: '25–34 specialist',
      assignedHeadline: 'A 750 ml bottle for every day',
      siblingHeadlines: ['Take 750 ml along for the day'],
      mediaUrl: '/api/creative-assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mediaType: 'image',
      media: { bytes: png, contentType: 'image/png', mediaType: 'image' },
    });
    expect(Array.isArray(body?.messages[1].content)).toBe(true);
    expect(body?.messages[1].content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('"mediaAttached":true'),
    });
    expect(body?.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${Buffer.from(png).toString('base64')}` },
    });
    expect(JSON.parse(body?.messages[1].content[0].text as string)).not.toHaveProperty('media');
    expect(result.judgment.noticedFirst).toBe('image');
  });

  it('attaches video bytes as a vision data URL when media is supplied', async () => {
    const judgment = {
      action: 'skip',
      reason: 'The clip is too busy for a commute.',
      dwellSeconds: 4,
      timeToActionSeconds: 2,
      confidence: 0.5,
      attention: 0.4,
      clarity: 0.4,
      trust: 0.4,
      purchaseIntent: 0.2,
      noticedFirst: 'video',
      friction: 'busy',
    };
    const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    let body: Record<string, any> | undefined;
    const local = new LiquidClient({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'LiquidAI/LFM2.5-VL-3B-MLX-8bit' }, async (_input, init = {}) => {
      body = JSON.parse(String(init.body)) as Record<string, any>;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(judgment) } }] }), { status: 200 });
    });
    await local.judgeCreative({
      brief: 'Campaign: Bottle',
      personaCard: 'You are a commuter.',
      personaLabel: '25–34 commuter',
      assignedHeadline: 'A 750 ml bottle for every day',
      siblingHeadlines: ['Take 750 ml along for the day'],
      mediaUrl: '/api/creative-assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mediaType: 'video',
      media: { bytes: mp4, contentType: 'video/mp4', mediaType: 'video' },
    });
    expect(body?.messages[1].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${Buffer.from(mp4).toString('base64')}` },
    });
  });

  it('rejects vision media that exceeds the size limit', async () => {
    const oversized = new Uint8Array(LIQUID_VISION_IMAGE_MAX_BYTES + 1);
    await expect(client(async () => openRouterResponse({ content: '{}' })).judgeCreative({
      brief: 'Campaign: Bottle',
      personaCard: 'You are a student.',
      personaLabel: '18–24 student',
      assignedHeadline: 'A 750 ml bottle for every day',
      siblingHeadlines: ['Take 750 ml along for the day'],
      mediaType: 'image',
      media: { bytes: oversized, contentType: 'image/png', mediaType: 'image' },
    })).rejects.toMatchObject({ code: 'configuration', message: 'Judge media exceeds the vision size limit.' });
  });

  it('normalizes sloppy local VLM enum values instead of failing the job', async () => {
    const result = await client(async () => openRouterResponse({
      content: JSON.stringify({
        action: 'Sign up',
        reason: 'The photo makes the bottle look easy to carry.',
        dwell_seconds: 10,
        time_to_action_seconds: 6,
        confidence: 0.7,
        attention: 0.8,
        clarity: 0.6,
        trust: 0.5,
        purchase_intent: 0.4,
        noticed_first: 'the product image',
        friction: 'not relevant',
      }),
    })).judgeCreative({
      brief: 'Campaign: Bottle',
      personaCard: 'You are a commuter.',
      personaLabel: '25–34 commuter',
      assignedHeadline: 'A 750 ml bottle for every day',
      siblingHeadlines: ['Take 750 ml along for the day'],
    });
    expect(result.judgment).toMatchObject({
      action: 'signup',
      noticedFirst: 'image',
      friction: 'relevance',
      dwellSeconds: 10,
      timeToActionSeconds: 6,
      purchaseIntent: 0.4,
    });
  });

  it('accepts 0-10 score scales from the local VLM', async () => {
    const result = await client(async () => openRouterResponse({
      content: JSON.stringify({
        action: 'skip',
        reason: 'Too busy to stop.',
        dwellSeconds: 2,
        timeToActionSeconds: 1,
        confidence: 7,
        attention: 3,
        clarity: 8,
        trust: 4,
        purchaseIntent: 2,
        noticedFirst: 'headline',
        friction: 'busy',
      }),
    })).judgeCreative({
      brief: 'Campaign: Bottle',
      personaCard: 'You are a commuter.',
      personaLabel: '25–34 commuter',
      assignedHeadline: 'A 750 ml bottle for every day',
      siblingHeadlines: ['Take 750 ml along for the day'],
    });
    expect(result.judgment).toMatchObject({
      action: 'skip',
      confidence: 0.7,
      attention: 0.3,
      clarity: 0.8,
      trust: 0.4,
      purchaseIntent: 0.2,
    });
  });

  it('keeps a valid persona judgment when the model hits the token cap after finishing JSON', async () => {
    const judgment = {
      action: 'skip',
      reason: 'The headline feels generic.',
      dwellSeconds: 3,
      timeToActionSeconds: 2,
      confidence: 0.4,
      attention: 0.3,
      clarity: 0.5,
      trust: 0.4,
      purchaseIntent: 0.2,
      noticedFirst: 'headline',
      friction: 'relevance',
    };
    const result = await client(async () => openRouterResponse({
      choice: { finish_reason: 'length' },
      content: JSON.stringify(judgment),
    })).judgeCreative({
      brief: 'Campaign: Bottle',
      personaCard: 'You are a student.',
      personaLabel: '18–24 student',
      assignedHeadline: 'A 750 ml bottle for every day',
      siblingHeadlines: ['Take 750 ml along for the day'],
    });
    expect(result.judgment.action).toBe('skip');
  });
});
