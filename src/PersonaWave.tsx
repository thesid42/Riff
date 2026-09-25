import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Pause, Play, Plus, Users, X } from 'lucide-react';
import type { Campaign } from '../shared/types.js';
import type { DecisionRecord, WaveSnapshot } from '../shared/run.js';
import { countHeadlineCharacters, HEADLINE_MAX_LENGTH, isValidHeadlineSet } from '../shared/headlines.js';
import { DEFAULT_AGENT_COUNT, DEFAULT_CONCURRENCY, MAX_AGENT_COUNT, MAX_CONCURRENCY, MIN_AGENT_COUNT } from '../shared/run.js';
import {
  AGE_BANDS, DEVICES, HOUSEHOLDS, PERSONA_TEMPLATES, WORK_TYPES,
  filterPersonaCatalog, personaCatalog, type CustomPersonaInput, type PersonaTemplate,
} from '../shared/personas.js';
import './experiments.css';

interface ApiError extends Error { status?: number }

async function postJson<T>(url: string, value: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body &&
      typeof body.error === 'object' && body.error !== null && 'message' in body.error &&
      typeof body.error.message === 'string' ? body.error.message : `The request failed (${response.status}).`;
    const error = new Error(message) as ApiError;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

function percent(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—';
}

function ms(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

function seconds(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(1)}s` : '—';
}

function noticeMix(noticed: Record<string, number | undefined>): string {
  const parts = Object.entries(noticed)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([key, count]) => `${key} ${count}`);
  return parts.length ? parts.join(', ') : '—';
}

const emptyDraft: CustomPersonaInput = {
  ageBand: '25-34', work: 'specialist', job: '', country: '', location: '', language: 'English', device: 'phone', household: 'alone',
};

export default function PersonaWave({
  campaign,
  headlines,
  creativeJobId,
  onClearCreative,
  wave,
  onWave,
  onCampaign,
}: {
  campaign: Campaign;
  headlines: string[];
  creativeJobId: string | null;
  onClearCreative: () => void;
  wave: WaveSnapshot | null;
  onWave: (wave: WaveSnapshot) => void;
  onCampaign: (campaign: Campaign) => void;
}) {
  const catalog = personaCatalog(campaign.customPersonas);
  const countries = useMemo(() => [...new Set(catalog.map((persona) => persona.country))].sort(), [catalog]);
  const [agentCount, setAgentCount] = useState(wave?.agentCount ?? DEFAULT_AGENT_COUNT);
  const [concurrency, setConcurrency] = useState(wave?.concurrency ?? DEFAULT_CONCURRENCY);
  const [profileMix, setProfileMix] = useState<string[]>([]);
  const [ageFilter, setAgeFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [workFilter, setWorkFilter] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<CustomPersonaInput>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const runtime = wave?.runtime ?? 'idle';
  const progress = wave?.progress;
  const completed = (progress?.succeeded ?? 0) + (progress?.failed ?? 0);
  const total = progress?.total ?? 0;
  const visible = filterPersonaCatalog(catalog, {
    ageBands: ageFilter ? [ageFilter] : undefined,
    countries: countryFilter ? [countryFilter] : undefined,
    works: workFilter ? [workFilter] : undefined,
    query,
  });
  const selectedIds = profileMix.length ? profileMix : catalog.map((persona) => persona.id);
  const selectedCount = selectedIds.length;
  const validHeadlines = isValidHeadlineSet(headlines);
  const hasOverlongHeadline = headlines.some((line) => countHeadlineCharacters(line) > HEADLINE_MAX_LENGTH);
  const waveHasResults = Boolean(wave && (wave.experimentId || wave.progress.total > 0));
  const scopedDecision = wave?.latestDecision && wave.experimentId &&
    wave.latestDecision.experimentId === wave.experimentId ? wave.latestDecision : null;
  const statusLabel = runtime === 'running' ? 'Wave running' : runtime === 'paused' ? 'Wave paused' :
    waveHasResults ? 'Latest wave saved' : 'Ready to run';

  useEffect(() => {
    if (wave?.agentCount) setAgentCount(wave.agentCount);
    if (wave?.concurrency) setConcurrency(wave.concurrency);
  // Live progress refreshes should not overwrite settings the user is preparing
  // for the next run. Sync only when switching campaigns or experiment runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id, wave?.experimentId]);

  async function start() {
    if (!validHeadlines) return;
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ wave: WaveSnapshot }>(`/api/campaigns/${encodeURIComponent(campaign.id)}/run`, {
        agentCount, concurrency, headlines: headlines.map((line) => line.trim()),
        ...(creativeJobId ? { creativeJobId } : {}),
        ...(profileMix.length && profileMix.length < catalog.length ? { profileMix } : {}),
      });
      onWave(result.wave);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The persona wave could not start.');
    } finally {
      setBusy(false);
    }
  }

  async function pause() {
    setBusy(true);
    setError('');
    try {
      onWave((await postJson<{ wave: WaveSnapshot }>(`/api/campaigns/${encodeURIComponent(campaign.id)}/pause`, {})).wave);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The wave could not be paused.');
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    setError('');
    try {
      onWave((await postJson<{ wave: WaveSnapshot }>(`/api/campaigns/${encodeURIComponent(campaign.id)}/resume`, {})).wave);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The wave could not resume.');
    } finally {
      setBusy(false);
    }
  }

  async function addPersona() {
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ campaign: Campaign; persona: PersonaTemplate }>(`/api/campaigns/${encodeURIComponent(campaign.id)}/personas`, draft);
      onCampaign(result.campaign);
      setProfileMix((current) => current.length ? [...current, result.persona.id] : []);
      setDraft(emptyDraft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The persona could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function removePersona(id: string) {
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ campaign: Campaign }>(`/api/campaigns/${encodeURIComponent(campaign.id)}/personas/${encodeURIComponent(id)}/delete`, {});
      onCampaign(result.campaign);
      setProfileMix((current) => current.filter((item) => item !== id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The persona could not be removed.');
    } finally {
      setBusy(false);
    }
  }

  function toggleProfile(id: string) {
    setProfileMix((current) => {
      const selected = current.length ? current : catalog.map((persona) => persona.id);
      const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
      return next.length === 0 || next.length === catalog.length ? [] : next;
    });
  }

  function selectVisible() {
    const ids = visible.map((persona) => persona.id);
    setProfileMix(ids.length === catalog.length ? [] : ids);
  }

  return (
    <section className="wave-panel experiment-wave" id="experiment-setup" aria-labelledby="wave-title">
      <div className="wave-heading">
        <div>
          <span className="section-kicker">PERSONA EXPERIMENT</span>
          <h2 id="wave-title">Experiment setup</h2>
          <p>Choose an audience and simulate how people respond to your ad.</p>
        </div>
        <span className={`status-pill ${runtime === 'running' ? 'wave-running' : ''}`}>
          <span className="status-dot" /> {statusLabel}
        </span>
      </div>

      <section className="experiment-brief" aria-label="Next wave brief">
        <div className="experiment-brief-heading">
          <div>
            <span className="section-kicker">NEXT WAVE</span>
            <h3>Headlines and audience</h3>
          </div>
          <span className="experiment-audience-count">{selectedCount} {selectedCount === 1 ? 'profile' : 'profiles'} · {agentCount} agents</span>
        </div>
        {validHeadlines ? (
          <ol className="experiment-headline-list" aria-label="Headlines for the next wave">
            {headlines.map((headline, index) => <li key={`${index}:${headline}`}><span>{String.fromCharCode(65 + index)}</span><p>{headline}</p></li>)}
          </ol>
        ) : (
          <p className="experiment-headline-guidance" role="status">{hasOverlongHeadline
            ? `Shorten headlines to ${HEADLINE_MAX_LENGTH} characters or fewer in Campaign before starting.`
            : `Add 2–3 unique, non-empty headlines of up to ${HEADLINE_MAX_LENGTH} characters in Campaign before starting.`}</p>
        )}
        <p className="experiment-copy-note">{creativeJobId ? 'Agents inspect the selected image or video with its headline, then simulate skipping, clicking, or signing up.' : 'With no creative selected, agents evaluate headline copy only.'}</p>
        <div className="wave-visual-note" role="status">
        {creativeJobId
          ? <>A saved creative is selected for the next wave. <button type="button" className="text-button" onClick={onClearCreative}>Remove creative</button></>
          : 'No creative is selected for the next wave.'}
        </div>
      </section>

      <div className="experiment-run-row">
        <div className="wave-actions">
          {runtime === 'running'
            ? <button className="button button-secondary" type="button" onClick={() => void pause()} disabled={busy} aria-busy={busy}><Pause size={15} /> Pause</button>
            : runtime === 'paused'
              ? <button className="button button-primary" type="button" onClick={() => void resume()} disabled={busy} aria-busy={busy}><Play size={15} /> Resume</button>
              : <button className="button button-primary" type="button" onClick={() => void start()} disabled={busy || !validHeadlines} aria-busy={busy}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <Users size={15} />} Start wave
              </button>}
        </div>
      </div>
      {!validHeadlines && <p className="experiment-start-guidance">{hasOverlongHeadline
        ? `Shorten headlines to ${HEADLINE_MAX_LENGTH} characters or fewer in Campaign before starting.`
        : `Add 2–3 unique headlines of up to ${HEADLINE_MAX_LENGTH} characters in Campaign before starting.`}</p>}

      <details className="experiment-disclosure">
        <summary><span>Next wave settings</span><small>{agentCount} agents · {concurrency} concurrent</small></summary>
        <div className="experiment-settings-grid">
          <label className="composer-field">
            <span><b>Agent count</b><small>{MIN_AGENT_COUNT}–{MAX_AGENT_COUNT}</small></span>
            <input type="number" min={MIN_AGENT_COUNT} max={MAX_AGENT_COUNT} value={agentCount} disabled={runtime === 'running' || busy}
              onChange={(event) => setAgentCount(Math.max(MIN_AGENT_COUNT, Math.min(MAX_AGENT_COUNT, Number(event.target.value) || DEFAULT_AGENT_COUNT)))} aria-label="Number of persona agents" />
          </label>
          <label className="composer-field">
            <span><b>Concurrency</b><small>1–{MAX_CONCURRENCY}</small></span>
            <input type="number" min={1} max={MAX_CONCURRENCY} value={concurrency} disabled={runtime === 'running' || busy}
              onChange={(event) => setConcurrency(Math.max(1, Math.min(MAX_CONCURRENCY, Number(event.target.value) || DEFAULT_CONCURRENCY)))} aria-label="Concurrent persona agents" />
          </label>
        </div>
      </details>

      <details className="experiment-disclosure audience-disclosure">
        <summary><span>Choose audience profiles</span><small>{selectedCount} selected · {visible.length} shown</small></summary>
        <div className="experiment-disclosure-body">
          <p className="experiment-helper">Filters and profile selections apply to the next wave only.</p>
          <div className="persona-filters">
            <label className="composer-field"><span><b>Age</b></span>
              <select value={ageFilter} onChange={(event) => setAgeFilter(event.target.value)} aria-label="Filter by age" disabled={runtime === 'running'}>
                <option value="">All ages</option>
                {AGE_BANDS.map((band) => <option key={band} value={band}>{band}</option>)}
              </select>
            </label>
            <label className="composer-field"><span><b>Country</b></span>
              <select value={countryFilter} onChange={(event) => setCountryFilter(event.target.value)} aria-label="Filter by country" disabled={runtime === 'running'}>
                <option value="">All countries</option>
                {countries.map((country) => <option key={country} value={country}>{country}</option>)}
              </select>
            </label>
            <label className="composer-field"><span><b>Work</b></span>
              <select value={workFilter} onChange={(event) => setWorkFilter(event.target.value)} aria-label="Filter by work" disabled={runtime === 'running'}>
                <option value="">All work types</option>
                {WORK_TYPES.map((work) => <option key={work} value={work}>{work}</option>)}
              </select>
            </label>
            <label className="composer-field"><span><b>Search</b></span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Job or city" aria-label="Search personas" disabled={runtime === 'running'} />
            </label>
          </div>
          <div className="persona-filter-actions">
            <button className="text-button" type="button" onClick={selectVisible} disabled={runtime === 'running' || busy}>Use visible profiles</button>
            <button className="text-button" type="button" onClick={() => setProfileMix([])} disabled={runtime === 'running' || busy}>Use full catalog</button>
          </div>

          <fieldset className="profile-mix" disabled={runtime === 'running' || busy}>
            <legend>Profile mix · {selectedCount} selected</legend>
            <div className="profile-mix-list">
              {visible.map((item) => (
                <label key={item.id}>
                  <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleProfile(item.id)} />
                  <span>{item.label}{item.custom ? ' · custom' : ''}</span>
                  {item.custom && <button type="button" className="icon-button composer-remove" aria-label={`Remove ${item.label}`} onClick={() => void removePersona(item.id)}><X size={13} /></button>}
                </label>
              ))}
            </div>
            {!visible.length && <p className="wave-empty">No profiles match these filters.</p>}
          </fieldset>
          <p className="experiment-catalog-note">{catalog.length} profiles available, including {PERSONA_TEMPLATES.length} built-in and {campaign.customPersonas.length} custom.</p>
        </div>
      </details>

      <details className="experiment-disclosure custom-persona-disclosure">
        <summary><span>Add a custom persona</span><small>{campaign.customPersonas.length} saved on this campaign</small></summary>
        <div className="experiment-disclosure-body">
          <p className="experiment-helper">Saved to this campaign and available in later waves.</p>
          <form className="persona-create" onSubmit={(event) => { event.preventDefault(); void addPersona(); }}>
            <div className="persona-create-grid">
              <label className="composer-field"><span><b>Age</b></span>
                <select value={draft.ageBand} onChange={(event) => setDraft((current) => ({ ...current, ageBand: event.target.value as CustomPersonaInput['ageBand'] }))} disabled={runtime === 'running' || busy}>{AGE_BANDS.map((band) => <option key={band}>{band}</option>)}</select>
              </label>
              <label className="composer-field"><span><b>Work</b></span>
                <select value={draft.work} onChange={(event) => setDraft((current) => ({ ...current, work: event.target.value as CustomPersonaInput['work'] }))} disabled={runtime === 'running' || busy}>{WORK_TYPES.map((work) => <option key={work}>{work}</option>)}</select>
              </label>
              <label className="composer-field"><span><b>Job</b></span>
                <input value={draft.job} onChange={(event) => setDraft((current) => ({ ...current, job: event.target.value }))} required maxLength={80} placeholder="pharmacist" disabled={runtime === 'running' || busy} />
              </label>
              <label className="composer-field"><span><b>Country</b></span>
                <input value={draft.country} onChange={(event) => setDraft((current) => ({ ...current, country: event.target.value }))} required maxLength={80} placeholder="India" disabled={runtime === 'running' || busy} />
              </label>
              <label className="composer-field"><span><b>City</b></span>
                <input value={draft.location} onChange={(event) => setDraft((current) => ({ ...current, location: event.target.value }))} required maxLength={80} placeholder="Pune" disabled={runtime === 'running' || busy} />
              </label>
              <label className="composer-field"><span><b>Language</b></span>
                <input value={draft.language} onChange={(event) => setDraft((current) => ({ ...current, language: event.target.value }))} required maxLength={40} disabled={runtime === 'running' || busy} />
              </label>
              <label className="composer-field"><span><b>Device</b></span>
                <select value={draft.device} onChange={(event) => setDraft((current) => ({ ...current, device: event.target.value as CustomPersonaInput['device'] }))} disabled={runtime === 'running' || busy}>{DEVICES.map((device) => <option key={device}>{device}</option>)}</select>
              </label>
              <label className="composer-field"><span><b>Household</b></span>
                <select value={draft.household} onChange={(event) => setDraft((current) => ({ ...current, household: event.target.value as CustomPersonaInput['household'] }))} disabled={runtime === 'running' || busy}>{HOUSEHOLDS.map((household) => <option key={household}>{household}</option>)}</select>
              </label>
            </div>
            <button className="button button-secondary" type="submit" disabled={runtime === 'running' || busy} aria-busy={busy}><Plus size={15} /> Save persona</button>
          </form>
        </div>
      </details>

      {error && <div className="alert alert-error" role="alert"><span>{error}</span></div>}
      {wave?.lastError && (progress?.failed ?? 0) > 0 && <div className="alert alert-error" role="alert"><span>{progress?.failed} agents failed: {wave.lastError}</span></div>}
      {wave?.ingestError && <div className="alert alert-error" role="alert"><span>Analytics ingest: {wave.ingestError}</span></div>}
      {wave?.reviewError && <div className="alert alert-error" role="alert"><span>Campaign review: {wave.reviewError}</span></div>}

      <section className="experiment-results-summary" aria-label="Latest wave results">
        <div className="experiment-results-heading">
          <div>
            <span className="section-kicker">{runtime === 'running' ? 'CURRENT WAVE' : runtime === 'paused' ? 'PAUSED WAVE' : 'LATEST RESULTS'}</span>
            <h3>{waveHasResults ? `${completed} of ${total || wave?.agentCount || agentCount} agents complete` : 'No wave run yet'}</h3>
          </div>
          {waveHasResults && <span className="experiment-result-count">{progress?.succeeded ?? 0} judged · {progress?.failed ?? 0} failed · {progress?.running ?? 0} live</span>}
        </div>
        {waveHasResults ? (
          <>
            {total > 0 && <div className="wave-progress" role="status">
              <div className="progress-track" role="progressbar" aria-label="Latest wave progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(total, completed)}>
                <span style={{ width: `${Math.min(100, (completed / total) * 100)}%` }} />
              </div>
              <small>{completed} of {total} agents · {progress?.succeeded ?? 0} judged · {progress?.failed ?? 0} failed</small>
            </div>}
            {scopedDecision && <DecisionCard decision={scopedDecision} />}
          </>
        ) : <p className="experiment-helper">Start a wave to see judged results and a campaign review here.</p>}
      </section>

      {(wave?.segments.length || wave?.deciderSpeed && (wave.deciderSpeed.fastSampleSize + wave.deciderSpeed.slowSampleSize) > 0) ? (
        <details className="experiment-disclosure experiment-detail-disclosure">
          <summary><span>Detailed results</span><small>{wave?.segments.length ?? 0} audience breakdowns</small></summary>
          <div className="experiment-disclosure-body">
            {wave?.deciderSpeed && (wave.deciderSpeed.fastSampleSize + wave.deciderSpeed.slowSampleSize) > 0 && (
              <p className="wave-speed">
                Fast deciders (≤ {ms(wave.deciderSpeed.medianDecideMs)}) signup {percent(wave.deciderSpeed.fastSignupRate)}
                {' · '}
                Slow deciders signup {percent(wave.deciderSpeed.slowSignupRate)}
              </p>
            )}
            {wave?.segments.length ? (
              <div className="segment-table-wrap">
                <table className="segment-table">
                  <caption>Persona results by job and location</caption>
                  <thead>
                    <tr>
                      <th>Profile</th><th>N</th><th>Skip / click / sign-up</th><th>Decide</th><th>Dwell</th>
                      <th>Conf</th><th>Attn</th><th>Trust</th><th>Intent</th><th>Noticed first</th><th>Friction</th><th>Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wave.segments.map((segment) => (
                      <tr key={segment.segment}>
                        <td>{segment.label}</td>
                        <td>{segment.sampleSize}</td>
                        <td>{segment.skips} / {segment.clicks} / {segment.signups}</td>
                        <td>{ms(segment.medianDecideMs)}</td>
                        <td>{seconds(segment.medianDwellSeconds)}</td>
                        <td>{percent(segment.averageConfidence)}</td>
                        <td>{percent(segment.averageAttention)}</td>
                        <td>{percent(segment.averageTrust)}</td>
                        <td>{percent(segment.averageIntent)}</td>
                        <td>{noticeMix(segment.noticedFirst)}</td>
                        <td>{segment.topFriction ?? '—'}</td>
                        <td>{segment.reasons.length ? segment.reasons.join(' · ') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function DecisionCard({ decision }: { decision: DecisionRecord | null }) {
  if (!decision) return null;
  return (
    <article className="decision-card">
      <span className="section-kicker">LATEST REVIEW</span>
      <h3>{decision.action === 'wait' ? 'Wait for more evidence' : 'Propose another headline test'}</h3>
      <details className="experiment-review-detail">
        <summary>Read review and suggestions</summary>
        <p>{decision.explanation}</p>
        {decision.hypothesis && <p><strong>Hypothesis</strong> · {decision.hypothesis}</p>}
        {decision.headlines.length > 0 && <div><strong>Suggested next headlines</strong><ul>{decision.headlines.map((headline, index) => <li key={index}>{headline}</li>)}</ul></div>}
      </details>
    </article>
  );
}
