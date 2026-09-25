import { config as loadDotenv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LiquidClient, type ExperimentDecision, type LiquidResponseMetadata } from '../server/providers/liquid.js';
import { ProviderError, type FetchLike } from '../server/providers/common.js';
import { LIQUID_MOCK_SCENARIOS, OFFLINE_FIXTURE_DECISIONS, type LiquidMockScenario } from './liquid-mock-scenarios.js';

const EXPECTED_BASE_URL = 'https://openrouter.ai/api/v1';
const EXPECTED_MODEL = 'liquid/lfm-2.5-2.6b:free';
const COMPLETION_LIMIT = 4_096;
const REQUEST_TIMEOUT_MS = 60_000;

type RunMode = 'offline-fixture' | 'live-openrouter';
type ScenarioStatus = 'completed' | 'failed' | 'not_run';
type ActionComparison = 'action_matches_expectation' | 'action_differs_from_expectation';
type FailureDisposition = 'continued' | 'stopped' | 'end_of_scenarios';

// Only these exact, sanitized validation messages can continue into another independent scenario.
// Provider/network/authentication/refusal/truncation/redirect failures are deliberately excluded.
const DECISION_VALIDATION_MESSAGES = new Set([
  'Liquid returned an invalid decision.',
  'explanation must be a non-empty string of at most 1000 characters.',
  'Liquid decision action is invalid.',
  'Liquid wait decisions must not propose creative.',
  'hypothesis must be a non-empty string of at most 500 characters.',
  'Liquid test hypothesis is too short.',
  'Liquid decision must include 2 or 3 comparable headlines.',
  'headline must be a non-empty string of at most 120 characters.',
  'Liquid comparison headlines must be unique.',
  'Liquid decision cited evidence that was not supplied.',
]);

interface ScenarioResult {
  id: LiquidMockScenario['id'];
  title: string;
  expectedAction: ExperimentDecision['action'];
  context: LiquidMockScenario['context'];
  status: ScenarioStatus;
  observedAction: ExperimentDecision['action'] | null;
  actionComparison: ActionComparison | null;
  elapsedMs: number | null;
  decision: ExperimentDecision | null;
  metadata: LiquidResponseMetadata | null;
  failureCategory: string | null;
  failureDetail: string | null;
  failureDisposition: FailureDisposition | null;
}

interface RunReport {
  product: 'Riff';
  mode: RunMode;
  provider: 'MockedLiquid fixture' | 'OpenRouter';
  model: string;
  createdAt: string;
  completionTokenLimit: number;
  contextWindowTokens: number | null;
  note: string;
  results: ScenarioResult[];
}

function parseMode(args: string[]): 'offline-fixture' | 'live-openrouter' | 'invalid' {
  if (args.length === 0) return 'offline-fixture';
  if (args.length === 1 && args[0] === '--live') return 'live-openrouter';
  if (args.length === 1 && args[0] === '--help') return 'invalid';
  return 'invalid';
}

function showUsage(): void {
  console.log('Usage: npm run test:liquid [-- --live]');
  console.log('Without --live, runs a deterministic MockedLiquid fixture. With --live, sends up to three sequential Liquid requests to the pinned OpenRouter profile.');
  console.log('Live mode requires LIQUID_BASE_URL=https://openrouter.ai/api/v1, LIQUID_MODEL=liquid/lfm-2.5-2.6b:free, and LIQUID_API_KEY in .env.');
}

function validateLiveConfiguration(): { baseUrl: string; model: string; apiKey: string } | null {
  loadDotenv({ quiet: true });
  const baseUrl = process.env.LIQUID_BASE_URL?.trim() ?? '';
  const model = process.env.LIQUID_MODEL?.trim() ?? '';
  const apiKey = process.env.LIQUID_API_KEY?.trim() ?? '';
  let validBase = false;
  try {
    const parsed = new URL(baseUrl);
    validBase = parsed.protocol === 'https:' && parsed.hostname === 'openrouter.ai' &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      parsed.href.replace(/\/$/, '') === EXPECTED_BASE_URL;
  } catch { /* The safe configuration message below avoids echoing environment values. */ }
  if (!validBase || model !== EXPECTED_MODEL || !apiKey) {
    console.error(`Live mode requires the exact OpenRouter base, model ${EXPECTED_MODEL}, and a non-empty LIQUID_API_KEY. Nothing was sent.`);
    return null;
  }
  return { baseUrl, model, apiKey };
}

function fixtureTransport(): FetchLike {
  let callIndex = 0;
  return async () => {
    const index = callIndex++;
    const decision = OFFLINE_FIXTURE_DECISIONS[index];
    if (!decision) return new Response('fixture exhausted', { status: 500 });
    return new Response(JSON.stringify({
      id: `mocked-liquid-request-${index + 1}`,
      model: 'mocked-liquid-fixture',
      choices: [{ message: { content: JSON.stringify(decision) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 412 + index * 23, completion_tokens: 71 + index * 5, total_tokens: 483 + index * 28 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function failureCategory(error: unknown): string {
  if (!(error instanceof ProviderError)) return 'request_failed';
  if (isDecisionValidationError(error)) return 'decision_validation';
  const message = error.message;
  const status = message.match(/\bHTTP (\d{3})\b/)?.[1];
  if (status === '401' || status === '403') return 'authentication';
  if (status === '429') return 'rate_limit';
  if (error.code === 'timeout') return 'timeout';
  if (error.code === 'configuration') return 'configuration';
  if (error.code === 'response') return 'invalid_response';
  return 'request_failed';
}

function isDecisionValidationError(error: unknown): boolean {
  return error instanceof ProviderError && error.code === 'response' && DECISION_VALIDATION_MESSAGES.has(error.message);
}

function failureDetail(error: unknown): string | null {
  if (!(error instanceof ProviderError)) return null;
  const detail = error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return detail || null;
}

export function initialResults(): ScenarioResult[] {
  return LIQUID_MOCK_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    expectedAction: scenario.expectedAction,
    context: scenario.context,
    status: 'not_run',
    observedAction: null,
    actionComparison: null,
    elapsedMs: null,
    decision: null,
    metadata: null,
    failureCategory: null,
    failureDetail: null,
    failureDisposition: null,
  }));
}

export async function collectDecisions(mode: RunMode, client: LiquidClient, results: ScenarioResult[]): Promise<boolean> {
  let sawFailureOrMismatch = false;
  for (let index = 0; index < LIQUID_MOCK_SCENARIOS.length; index++) {
    const scenario = LIQUID_MOCK_SCENARIOS[index];
    const result = results[index];
    const startedAt = Date.now();
    try {
      const { decision, metadata } = await client.proposeExperimentWithMetadata(scenario.context);
      result.status = 'completed';
      result.observedAction = decision.action;
      result.actionComparison = decision.action === scenario.expectedAction
        ? 'action_matches_expectation'
        : 'action_differs_from_expectation';
      if (result.actionComparison === 'action_differs_from_expectation') sawFailureOrMismatch = true;
      result.elapsedMs = metadata.elapsedMs;
      result.decision = decision;
      result.metadata = metadata;
      printResult(index, result, mode);
    } catch (error) {
      result.status = 'failed';
      result.elapsedMs = Math.max(0, Date.now() - startedAt);
      result.failureCategory = failureCategory(error);
      result.failureDetail = failureDetail(error);
      sawFailureOrMismatch = true;
      if (isDecisionValidationError(error)) {
        result.failureDisposition = index + 1 < results.length ? 'continued' : 'end_of_scenarios';
      } else {
        result.failureDisposition = 'stopped';
      }
      printResult(index, result, mode);
      if (result.failureDisposition === 'continued') {
        continue;
      }
      for (let remaining = index + 1; remaining < results.length; remaining++) printResult(remaining, results[remaining], mode);
      return false;
    }
  }
  return !sawFailureOrMismatch;
}

function stripTerminalText(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function printResult(index: number, result: ScenarioResult, mode: RunMode): void {
  const latency = result.elapsedMs == null ? '' : ` · ${result.elapsedMs} ms`;
  const label = mode === 'offline-fixture' ? 'mocked' : 'live';
  if (result.status === 'completed' && result.decision) {
    console.log(`[${index + 1}/3] ${label} · ${result.status} · action=${result.decision.action} · ${result.actionComparison}${latency}`);
    if (result.actionComparison === 'action_differs_from_expectation') console.log('  unexpected valid action: runner will exit non-zero');
    for (const headline of result.decision.headlines) console.log(`  headline: “${stripTerminalText(headline)}”`);
  } else if (result.status === 'failed') {
    console.log(`[${index + 1}/3] ${label} · failed · category=${result.failureCategory ?? 'request_failed'}${latency}`);
    if (result.failureDetail) console.log(`  detail: ${stripTerminalText(result.failureDetail)}`);
    if (result.failureDisposition === 'continued') console.log('  continuing: known decision-validation error; next scenario is independent');
    else if (result.failureDisposition === 'end_of_scenarios') console.log('  finished: no scenarios remain');
    else console.log('  stopped: remaining requests were not sent');
  } else {
    console.log(`[${index + 1}/3] ${label} · not_run`);
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function makeOutputDirectory(): Promise<string> {
  const root = join(process.cwd(), 'output', 'liquid-mocks');
  await mkdir(root, { recursive: true });
  const baseName = formatTimestamp(new Date());
  for (let suffix = 0; suffix < 100; suffix++) {
    const candidateName = suffix === 0 ? baseName : `${baseName}-${String(suffix).padStart(2, '0')}`;
    const candidate = join(root, candidateName);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not create a unique report directory.');
}

function htmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function markdownEscape(value: string): string {
  return value.replace(/\r?\n/g, ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\\`*_{}\[\]()#+\-.!|]/g, '\\$&');
}

function mockImagePlaceholder(): string {
  return '<div class="mock-image" role="img" aria-label="Mock image placeholder reused for versions A and B"><svg viewBox="0 0 160 150" aria-hidden="true"><ellipse cx="80" cy="126" rx="53" ry="11" fill="#e0e6db"/><path d="M63 45h34l7 12v58c0 7-5 11-11 11H68c-6 0-11-4-11-11V57z" fill="#96ab91"/><path d="M68 35h24v10H68z" fill="#6f846d"/><path d="M72 27h16v8H72z" fill="#536956"/><path d="M66 61h28" stroke="#c5d3be" stroke-width="3" stroke-linecap="round"/><circle cx="79" cy="82" r="2" fill="#dce6d7"/></svg><span>Mock image · same placeholder for A/B</span></div>';
}

function resultClass(result: ScenarioResult): string {
  if (result.status === 'failed') return 'failed';
  if (result.status === 'not_run') return 'not-run';
  return result.actionComparison === 'action_matches_expectation' ? 'matched' : 'different';
}

function resultHtml(result: ScenarioResult, index: number): string {
  const observed = result.observedAction ?? (result.status === 'failed' ? 'Request failed' : 'Not run');
  const decision = result.decision;
  const chips = decision?.evidenceIds.length
    ? decision.evidenceIds.map((id) => `<span class="chip">${htmlEscape(id)}</span>`).join('')
    : '<span class="muted">No evidence IDs returned</span>';
  const headlines = decision?.headlines.length
    ? `<ul class="headline-list">${decision.headlines.map((headline) => `<li>${htmlEscape(headline)}</li>`).join('')}</ul>`
    : '<p class="muted">No headline proposal returned.</p>';
  const metadata = result.metadata;
  const usage = metadata?.usage;
  const usageText = usage
    ? [`prompt ${usage.promptTokens ?? '—'}`, `completion ${usage.completionTokens ?? '—'}`, `total ${usage.totalTokens ?? '—'}`].map(htmlEscape).join(' · ')
    : 'Token usage unavailable';
  const statusText = result.status === 'failed'
    ? result.failureDisposition === 'continued'
      ? `Decision validation · continuing`
      : result.failureDisposition === 'end_of_scenarios'
        ? `Decision validation · last scenario`
        : `Stopped · ${htmlEscape(result.failureCategory ?? 'request failed')}`
    : htmlEscape(result.status === 'not_run' ? 'Not run after earlier failure' : 'Completed');
  const explanation = decision?.explanation ? `<p class="explanation">${htmlEscape(decision.explanation)}</p>` : '';
  const hypothesis = decision?.hypothesis ? `<div class="hypothesis"><span>Hypothesis</span><p>${htmlEscape(decision.hypothesis)}</p></div>` : '';
  const brief = `<details class="scenario-input"><summary>Scenario brief and synthetic evidence</summary><p>${htmlEscape(LIQUID_MOCK_SCENARIOS[index].context.brief)}</p><ul>${LIQUID_MOCK_SCENARIOS[index].context.evidence.map((item) => `<li><code>${htmlEscape(item.id)}</code> ${htmlEscape(item.summary)}</li>`).join('')}</ul>${LIQUID_MOCK_SCENARIOS[index].context.lessons.length ? `<h4>Scoped synthetic lesson</h4><ul>${LIQUID_MOCK_SCENARIOS[index].context.lessons.map((item) => `<li><code>${htmlEscape(item.id)}</code> ${htmlEscape(item.statement)}</li>`).join('')}</ul>` : ''}</details>`;

  return `<article class="scenario-card ${resultClass(result)}">
    <div class="scenario-head"><div><span class="eyebrow">SCENARIO ${index + 1}</span><h2>${htmlEscape(result.title)}</h2></div><span class="status-badge">${statusText}</span></div>
    <div class="comparison"><div><span>Expected action</span><strong>${htmlEscape(result.expectedAction)}</strong></div><div><span>Observed action</span><strong>${htmlEscape(observed)}</strong></div><div><span>Action comparison</span><strong>${htmlEscape(result.actionComparison ?? 'not evaluated')}</strong></div></div>
    <p class="caveat">The comparison checks only the action label. A match does not establish semantic correctness.</p>
    ${result.failureDetail ? `<p class="failure-detail">${htmlEscape(result.failureDetail)}</p>` : ''}
    ${hypothesis}${headlines}${explanation}
    <div class="evidence-row"><span class="field-label">Returned evidence IDs</span><div class="chips">${chips}</div></div>
    <div class="metadata-row"><span>${result.elapsedMs == null ? 'Latency unavailable' : `${result.elapsedMs} ms`}</span><span>${htmlEscape(metadata?.finishReason ?? 'Finish reason unavailable')}</span><span>${htmlEscape(usageText)}</span>${metadata?.requestId ? `<span>Request ID ${htmlEscape(metadata.requestId)}</span>` : ''}${metadata?.model ? `<span>Model ${htmlEscape(metadata.model)}</span>` : ''}</div>
    ${brief}
  </article>`;
}

function previewHtml(report: RunReport): string {
  const first = report.results[0]?.decision;
  const firstTwo = first?.action === 'propose_test' ? first.headlines.slice(0, 2) : [];
  const headlineA = firstTwo[0] ?? 'No initial headline proposed';
  const headlineB = firstTwo[1] ?? 'No second headline proposed';
  const placeholderA = mockImagePlaceholder();
  const placeholderB = mockImagePlaceholder();
  return `<section class="preview"><div class="section-heading"><div><span class="eyebrow">MOCK CAMPAIGN PREVIEW</span><h2>Two headline slots</h2></div><p>Preview only · no ads generated · no live campaign data</p></div><div class="ad-grid"><article class="ad-card"><div class="ad-top"><span>Version A</span><b>Mock ad</b></div>${placeholderA}<h3>${htmlEscape(headlineA)}</h3><p>Everyday Bottle · Waitlist sign-up</p><span class="mock-label">Synthetic brief · approved claims only</span></article><article class="ad-card"><div class="ad-top"><span>Version B</span><b>Mock ad</b></div>${placeholderB}<h3>${htmlEscape(headlineB)}</h3><p>Everyday Bottle · Waitlist sign-up</p><span class="mock-label">Same placeholder image as A</span></article></div><p class="preview-note">All audience descriptions and any sample counts in these scenarios are synthetic. No analytics, traffic, image generation, or database writes are involved.</p></section>`;
}

function renderHtml(report: RunReport): string {
  const modeLabel = report.mode === 'live-openrouter' ? 'LIVE LIQUID' : 'OFFLINE MOCKED FIXTURE';
  const modeClass = report.mode === 'live-openrouter' ? 'live' : 'offline';
  const cards = report.results.map((result, index) => resultHtml(result, index)).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Riff · Liquid mock campaign report</title>
<style>
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2922;background:#f5f7f3;font-synthesis:none;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;--sage:#4f7656;--line:#e2e8df;--muted:#7d887f;--paper:#fff}
  *{box-sizing:border-box}body{margin:0}.shell{max-width:1160px;margin:0 auto;padding:34px 28px 52px}.top{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-bottom:20px;border-bottom:1px solid var(--line)}.brand{font-size:20px;font-weight:750;letter-spacing:-.7px}.brand span{color:var(--sage)}.mode{padding:7px 10px;border-radius:99px;font-size:10px;font-weight:750;letter-spacing:.7px}.mode.live{color:#795437;background:#f6eddd}.mode.offline{color:#507158;background:#eaf2e8}.hero{padding:27px 0 20px}.hero .eyebrow,.eyebrow{color:#8b958b;font-size:9px;font-weight:750;letter-spacing:1.3px}.hero h1{margin:7px 0 8px;font-size:clamp(25px,4vw,35px);letter-spacing:-1.2px}.hero p,.section-heading p{color:var(--muted);font-size:12px;line-height:1.6}.summary{display:flex;flex-wrap:wrap;gap:9px;margin:16px 0 0}.summary span{padding:7px 10px;border:1px solid var(--line);border-radius:9px;background:var(--paper);color:#68746a;font-size:10px}.preview,.scenario-card{margin-top:15px;padding:19px;border:1px solid var(--line);border-radius:15px;background:var(--paper);box-shadow:0 3px 9px rgba(38,55,39,.025)}.section-heading,.scenario-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.section-heading h2,.scenario-head h2{margin:5px 0 0;font-size:17px;letter-spacing:-.35px}.section-heading p{margin:0}.ad-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px;margin-top:14px}.ad-card{padding:13px;border:1px solid #e8ede6;border-radius:12px;background:#fbfcfa}.ad-top{display:flex;align-items:center;justify-content:space-between;color:#566358;font-size:11px;font-weight:700}.ad-top b{padding:4px 7px;border-radius:99px;color:#8b795d;background:#f6f1e7;font-size:8px;text-transform:uppercase;letter-spacing:.5px}.mock-image{height:124px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;margin-top:11px;border:1px solid #e7ede5;border-radius:10px;background:linear-gradient(140deg,#f0f4ed,#fafbf9);color:#788777}.mock-image svg{height:97px;max-width:100%}.mock-image span{font-size:8px;letter-spacing:.2px}.ad-card h3{margin:12px 0 5px;font-size:14px;line-height:1.35}.ad-card>p{margin:0;color:var(--muted);font-size:9px}.mock-label{display:inline-flex;margin-top:11px;color:#859185;font-size:8px}.preview-note,.caveat{color:#8b958c;font-size:9px;line-height:1.55}.preview-note{margin:13px 0 0}.scenario-card{padding:17px 18px}.scenario-head h2{font-size:16px}.status-badge{flex:0 0 auto;padding:6px 8px;border-radius:99px;color:#657667;background:#f2f5f0;font-size:9px;font-weight:650}.matched .status-badge{color:#55775a;background:#edf5eb}.different .status-badge{color:#8c744c;background:#f7f2e7}.failed .status-badge{color:#995e55;background:#f9eeec}.comparison{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:15px}.comparison>div{min-height:57px;padding:10px;border:1px solid #edf0ec;border-radius:9px;background:#fcfdfb}.comparison span,.field-label{display:block;color:#929c93;font-size:8px}.comparison strong{display:block;margin-top:6px;color:#435147;font-size:10px;overflow-wrap:anywhere}.caveat{margin:9px 0 12px}.hypothesis{padding:10px 11px;border-left:2px solid #9ab39a;background:#f6f9f4}.hypothesis span{color:#829082;font-size:8px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}.hypothesis p,.explanation{margin:5px 0 0;color:#556258;font-size:10px;line-height:1.55}.headline-list{margin:10px 0 0;padding-left:18px;color:#344137;font-size:11px;line-height:1.6}.headline-list li+li{margin-top:3px}.muted{color:#9aa39b;font-size:9px}.evidence-row{display:flex;align-items:flex-start;gap:10px;margin-top:12px}.field-label{min-width:105px;padding-top:4px}.chips{display:flex;flex-wrap:wrap;gap:5px}.chip{padding:4px 6px;border:1px solid #e8ede6;border-radius:6px;color:#6e7c70;background:#fafbf9;font:9px ui-monospace,SFMono-Regular,Consolas,monospace}.metadata-row{display:flex;flex-wrap:wrap;gap:6px 13px;margin-top:13px;padding-top:10px;border-top:1px solid #eef1ed;color:#939d94;font-size:8px}.scenario-input{margin-top:12px;border-top:1px solid #eef1ed;padding-top:10px}.scenario-input summary{color:#718072;font-size:9px;font-weight:700;cursor:pointer}.scenario-input p,.scenario-input li{color:#758077;font-size:9px;line-height:1.55}.scenario-input ul{padding-left:17px}.scenario-input code{color:#5e7460;font-size:8px}.scenario-input h4{color:#778377;font-size:9px;margin-bottom:0}.footer{padding-top:17px;color:#9aa39a;font-size:8px;text-align:center}
  .failure-detail{padding:9px 10px;border-radius:8px;background:#fbf4f2;color:#87594f;font-size:10px;line-height:1.5;overflow-wrap:anywhere}
  @media(max-width:640px){.shell{padding:20px 14px 32px}.top{align-items:flex-start}.brand{font-size:18px}.section-heading{display:block}.section-heading p{margin-top:6px}.preview,.scenario-card{padding:14px}.ad-grid{grid-template-columns:1fr}.comparison{grid-template-columns:1fr}.comparison>div{min-height:0}.evidence-row{display:block}.field-label{margin-bottom:7px}.metadata-row{gap:7px 10px}}
</style></head><body><main class="shell">
<header class="top"><div class="brand">Riff <span>·</span> Liquid runner</div><span class="mode ${modeClass}">${modeLabel}</span></header>
<section class="hero"><span class="eyebrow">SYNTHETIC CAMPAIGN SCENARIOS</span><h1>${report.mode === 'live-openrouter' ? 'Live Liquid advice' : 'Mocked fixture advice'}, synthetic evidence</h1><p>${htmlEscape(report.note)}</p><div class="summary"><span>Model: ${htmlEscape(report.model)}</span><span>Completion limit: ${report.completionTokenLimit.toLocaleString()} tokens</span><span>Model context: ${report.contextWindowTokens == null ? 'Not applicable' : `${report.contextWindowTokens.toLocaleString()} tokens`}</span><span>Generated: ${htmlEscape(report.createdAt)}</span></div></section>
${previewHtml(report)}
<section aria-label="Scenario results"><div class="section-heading" style="margin:25px 2px 4px"><div><span class="eyebrow">UP TO THREE SEQUENTIAL CALLS</span><h2>Scenario results</h2></div><p>Expected-action comparison is not a semantic evaluation.</p></div>${cards}</section>
<footer class="footer">Riff local mock report · Provider requests are limited to Liquid in live mode. No BFL, analytics, campaign, or database requests.</footer>
</main></body></html>`;
}

function renderMarkdown(report: RunReport): string {
  const lines = [
    '# Riff · Liquid scenario report',
    '',
    `- Mode: ${report.mode === 'live-openrouter' ? 'Live Liquid / OpenRouter' : 'Offline MockedLiquid fixture'}`,
    `- Model: ${markdownEscape(report.model)}`,
    `- Completion token limit: ${report.completionTokenLimit}`,
    `- Model context window: ${report.contextWindowTokens == null ? 'not applicable for fixture mode' : `${report.contextWindowTokens.toLocaleString()} tokens`}`,
    `- Created: ${report.createdAt}`,
    '',
    `> ${markdownEscape(report.note)}`,
    '',
    'All brief details, audience descriptions, claims, sample evidence, and ad image placeholders are synthetic. The action comparison only checks the action field and does not establish semantic correctness.',
    '',
    '## Mock ad preview',
    '',
    'The same local SVG placeholder is reused for versions A and B. It was not generated, and there is no live campaign data.',
    '',
    '## Scenarios',
    '',
  ];
  for (const [index, result] of report.results.entries()) {
    lines.push(`### ${index + 1}. ${markdownEscape(result.title)}`, '');
    lines.push(`- Status: ${result.status}`, `- Expected action: ${result.expectedAction}`, `- Observed action: ${result.observedAction ?? (result.status === 'failed' ? 'request failed' : 'not run')}`, `- Action comparison: ${result.actionComparison ?? 'not evaluated'}`, `- Latency: ${result.elapsedMs == null ? 'unavailable' : `${result.elapsedMs} ms`}`);
    if (result.failureCategory) lines.push(`- Failure category: ${result.failureCategory}`);
    if (result.failureDetail) lines.push(`- Failure detail: ${markdownEscape(result.failureDetail)}`);
    if (result.failureDisposition) {
      const disposition = result.failureDisposition === 'continued'
        ? 'continued to the next independent scenario after a known decision-validation error'
        : result.failureDisposition === 'end_of_scenarios'
          ? 'no independent scenarios remained'
          : 'stopped; later scenarios were not sent';
      lines.push(`- Failure handling: ${disposition}`);
    }
    if (result.metadata) {
      lines.push(`- Request ID: ${markdownEscape(result.metadata.requestId ?? 'unavailable')}`, `- Response model: ${markdownEscape(result.metadata.model ?? 'unavailable')}`, `- Finish reason: ${markdownEscape(result.metadata.finishReason ?? 'unavailable')}`);
      const usage = result.metadata.usage;
      lines.push(`- Token usage: prompt ${usage?.promptTokens ?? '—'}, completion ${usage?.completionTokens ?? '—'}, total ${usage?.totalTokens ?? '—'}, reasoning ${usage?.reasoningTokens ?? '—'}`);
    }
    if (result.decision) {
      lines.push('', '**Validated structured decision**', '', `- Action: ${result.decision.action}`, `- Explanation: ${markdownEscape(result.decision.explanation)}`, `- Hypothesis: ${markdownEscape(result.decision.hypothesis || 'none')}`, `- Evidence IDs: ${result.decision.evidenceIds.map(markdownEscape).join(', ') || 'none'}`);
      lines.push('- Headlines:');
      if (result.decision.headlines.length === 0) lines.push('  - None proposed');
      else for (const headline of result.decision.headlines) lines.push(`  - ${markdownEscape(headline)}`);
    }
    lines.push('', '**Synthetic brief**', '', markdownEscape(result.context.brief), '', '**Synthetic evidence**', '');
    for (const evidence of result.context.evidence) lines.push('- ' + markdownEscape(evidence.id) + ': ' + markdownEscape(evidence.summary));
    for (const lesson of result.context.lessons) lines.push('- Scoped synthetic lesson ' + markdownEscape(lesson.id) + ': ' + markdownEscape(lesson.statement));
    lines.push('');
  }
  lines.push('---', '', 'No raw HTTP, credentials, hidden reasoning trace, campaign state, analytics write, or BFL call is included.');
  return `${lines.join('\n')}\n`;
}

async function saveReport(report: RunReport): Promise<string> {
  const directory = await makeOutputDirectory();
  await Promise.all([
    writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
    writeFile(join(directory, 'report.md'), renderMarkdown(report), { encoding: 'utf8', flag: 'wx' }),
    writeFile(join(directory, 'report.html'), renderHtml(report), { encoding: 'utf8', flag: 'wx' }),
  ]);
  return relative(process.cwd(), directory).replaceAll('\\', '/');
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'invalid') {
    showUsage();
    if (process.argv.slice(2).some((arg) => arg !== '--help')) process.exitCode = 2;
    return;
  }

  const liveConfiguration = mode === 'live-openrouter' ? validateLiveConfiguration() : null;
  if (mode === 'live-openrouter' && !liveConfiguration) {
    process.exitCode = 2;
    return;
  }

  const client = mode === 'offline-fixture'
    ? new LiquidClient({ baseUrl: EXPECTED_BASE_URL, model: EXPECTED_MODEL, apiKey: 'offline-fixture-key', maxTokens: COMPLETION_LIMIT, timeoutMs: REQUEST_TIMEOUT_MS }, fixtureTransport())
    : new LiquidClient({ ...liveConfiguration!, maxTokens: COMPLETION_LIMIT, timeoutMs: REQUEST_TIMEOUT_MS });
  const results = initialResults();
  const allSucceeded = await collectDecisions(mode, client, results);
  const report: RunReport = {
    product: 'Riff',
    mode,
    provider: mode === 'live-openrouter' ? 'OpenRouter' : 'MockedLiquid fixture',
    model: mode === 'live-openrouter' ? EXPECTED_MODEL : 'MockedLiquid fixture (no live model)',
    createdAt: new Date().toISOString(),
    completionTokenLimit: COMPLETION_LIMIT,
    contextWindowTokens: mode === 'live-openrouter' ? 65_536 : null,
    note: mode === 'live-openrouter'
      ? 'Up to three validated Liquid decisions are requested sequentially. Known decision-validation errors are recorded and independent scenarios continue; provider, network, authentication, refusal, truncation, redirect, and other failures stop the remaining requests. The model is live; all campaign details, claims, audience descriptions, counts, and evidence are fictional. The runner sends no requests to ad platforms, analytics providers, or image generation.'
      : 'This report uses an injected deterministic MockedLiquid transport. No .env file or live provider is read or contacted. Known decision-validation errors are recorded and independent scenarios continue; other failures stop remaining requests. All campaign details, claims, audience descriptions, counts, and evidence are fictional.',
    results,
  };
  const reportPath = await saveReport(report);
  console.log(`Report: ${reportPath}/report.html`);
  console.log(`Artifacts: ${reportPath}/report.json and ${reportPath}/report.md`);
if (!allSucceeded) process.exitCode = 1;
}

const isDirectExecution = process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) await main();
