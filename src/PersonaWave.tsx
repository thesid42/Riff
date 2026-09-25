import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { LoaderCircle, Pause, Play, Plus, Users, X } from 'lucide-react';
import type { Campaign } from '../shared/types.js';
import type { DecisionRecord, WaveSnapshot } from '../shared/run.js';
import { countHeadlineCharacters, HEADLINE_MAX_LENGTH, isValidHeadlineSet } from '../shared/headlines.js';
import {
  DEFAULT_AGENT_COUNT, DEFAULT_CONCURRENCY, DEFAULT_MAX_AUTO_ROUNDS, DEFAULT_SUCCESS_CLICK_RATE,
  MAX_AGENT_COUNT, MAX_CONCURRENCY, MAX_MAX_AUTO_ROUNDS, MIN_AGENT_COUNT, MIN_MAX_AUTO_ROUNDS,
} from '../shared/run.js';
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

function clickRateToPercent(rate: number): number {
  return Math.max(1, Math.min(100, Math.round(rate * 100)));
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
  const [targetPercent, setTargetPercent] = useState(clickRateToPercent(wave?.successClickRate ?? campaign.successClickRate ?? DEFAULT_SUCCESS_CLICK_RATE));
  const [maxIterations, setMaxIterations] = useState(wave?.maxAutoRounds ?? campaign.maxAutoRounds ?? DEFAULT_MAX_AUTO_ROUNDS);
  const [profileMix, setProfileMix] = useState<string[]>([]);
  const [ageFilter, setAgeFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [workFilter, setWorkFilter] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<CustomPersonaInput>(emptyDraft);
  const [setupTab, setSetupTab] = useState<'audience' | 'settings'>('audience');
  const [editingAudience, setEditingAudience] = useState(false);
  const [addingPersona, setAddingPersona] = useState(false);
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
  const selectedProfileNames = selectedIds.map((id) => catalog.find((persona) => persona.id === id)?.label).filter((label): label is string => Boolean(label));
  const audienceSummary = selectedCount === catalog.length
    ? `All ${catalog.length} profiles`
    : `${selectedProfileNames.slice(0, 2).join(' · ')}${selectedCount > 2 ? ` +${selectedCount - 2}` : ''}`;
  const validHeadlines = isValidHeadlineSet(headlines);
  const hasOverlongHeadline = headlines.some((line) => countHeadlineCharacters(line) > HEADLINE_MAX_LENGTH);
  const waveHasResults = Boolean(wave && (wave.experimentId || wave.progress.total > 0));
  const scopedDecision = wave?.latestDecision && wave.experimentId &&
    wave.latestDecision.experimentId === wave.experimentId ? wave.latestDecision : null;
  const live = Boolean(wave?.loopActivity || (wave?.loopContinuing && !wave?.loopStatus) || runtime === 'running');
  const statusLabel = live
    ? (wave?.loopActivity?.title ?? (runtime === 'running' ? 'Judging this wave' : 'Improving campaign'))
    : runtime === 'paused' || wave?.loopStatus?.reason === 'paused' ? 'Wave paused'
      : wave?.loopStatus?.reason === 'threshold_met' ? 'Target reached'
        : waveHasResults ? 'Latest wave saved' : 'Ready to run';

  useEffect(() => {
    if (wave?.agentCount) setAgentCount(wave.agentCount);
    if (wave?.concurrency) setConcurrency(wave.concurrency);
    if (wave?.successClickRate != null) setTargetPercent(clickRateToPercent(wave.successClickRate));
    else if (campaign.successClickRate != null) setTargetPercent(clickRateToPercent(campaign.successClickRate));
    if (wave?.maxAutoRounds != null) setMaxIterations(wave.maxAutoRounds);
    else if (campaign.maxAutoRounds != null) setMaxIterations(campaign.maxAutoRounds);
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
        successClickRate: targetPercent / 100,
        maxAutoRounds: maxIterations,
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
      setAddingPersona(false);
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

  function moveSetupTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' || event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      ? 'audience'
      : 'settings';
    setSetupTab(next);
    document.getElementById(next === 'audience' ? 'wave-audience-tab' : 'wave-settings-tab')?.focus();
  }

  return (
    <section className="wave-panel experiment-wave" id="experiment-setup" aria-labelledby="wave-title">
      <div className="wave-heading">
        <div>
          <span className="section-kicker">PERSONA EXPERIMENT</span>
          <h2 id="wave-title">Experiment setup</h2>
          <p>Choose an audience and simulate how people respond to your ad.</p>
        </div>
        <span className={`status-pill ${live ? 'wave-running' : ''}`}>
          {live ? <LoaderCircle size={13} className="spin" /> : <span className="status-dot" />} {statusLabel}
        </span>
      </div>

      <section className="experiment-brief" aria-label="Next wave brief">
        <div className="experiment-brief-heading">
          <div>
            <span className="section-kicker">NEXT WAVE</span>
            <h3>Headlines for the next wave</h3>
          </div>
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
        <p className="experiment-copy-note" role="status">{creativeJobId
          ? <>Creative attached: profiles will inspect each saved visual with its headline. <button type="button" className="text-button" onClick={onClearCreative}>Remove creative</button></>
          : 'Text-only wave: profiles will evaluate headline copy.'}</p>
      </section>

      <div className="wave-setup-tabs" role="tablist" aria-label="Wave setup">
        <button type="button" role="tab" id="wave-audience-tab" tabIndex={setupTab === 'audience' ? 0 : -1} aria-controls="wave-audience-panel" aria-selected={setupTab === 'audience'} onKeyDown={moveSetupTab} onClick={() => setSetupTab('audience')}>
          Audience <span>{selectedCount} selected</span>
        </button>
        <button type="button" role="tab" id="wave-settings-tab" tabIndex={setupTab === 'settings' ? 0 : -1} aria-controls="wave-settings-panel" aria-selected={setupTab === 'settings'} onKeyDown={moveSetupTab} onClick={() => setSetupTab('settings')}>
          Run settings <span>{agentCount} agents · {targetPercent}% target · {maxIterations === 0 ? 'no cap' : `${maxIterations} max`}</span>
        </button>
      </div>

      <div className="wave-setup-panel" role="tabpanel" id="wave-audience-panel" aria-labelledby="wave-audience-tab" hidden={setupTab !== 'audience'}>
        <div className="wave-audience-overview">
          <div>
            <strong>{audienceSummary}</strong>
            <p>{selectedCount} profiles selected for the next wave</p>
          </div>
          <div className="wave-audience-actions">
            <button className="button button-secondary" type="button" onClick={() => {
              const next = !editingAudience;
              setEditingAudience(next);
              if (!next) setAddingPersona(false);
            }} disabled={runtime === 'running' || busy}>{editingAudience ? 'Done' : 'Edit audience'}</button>
            <button className="text-button" type="button" onClick={() => { setEditingAudience(true); setAddingPersona(true); }} disabled={runtime === 'running' || busy}>
              <Plus size={14} /> Add custom profile <span>({campaign.customPersonas.length})</span>
            </button>
          </div>
        </div>
        {editingAudience && <div className="wave-audience-editor">
          <p className="experiment-helper">Filters and profile selections apply to the next wave only.</p>
          <div className="persona-filters">
            <label className="composer-field"><span><b>Age</b></span>
              <select value={ageFilter} onChange={(event) => setAgeFilter(event.target.value)} aria-label="Filter by age" disabled={runtime === 'running' || busy}>
                <option value="">All ages</option>
                {AGE_BANDS.map((band) => <option key={band} value={band}>{band}</option>)}
              </select>
            </label>
            <label className="composer-field"><span><b>Country</b></span>
              <select value={countryFilter} onChange={(event) => setCountryFilter(event.target.value)} aria-label="Filter by country" disabled={runtime === 'running' || busy}>
                <option value="">All countries</option>
                {countries.map((country) => <option key={country} value={country}>{country}</option>)}
              </select>
            </label>
            <label className="composer-field"><span><b>Work</b></span>
              <select value={workFilter} onChange={(event) => setWorkFilter(event.target.value)} aria-label="Filter by work" disabled={runtime === 'running' || busy}>
                <option value="">All work types</option>
                {WORK_TYPES.map((work) => <option key={work} value={work}>{work}</option>)}
              </select>
            </label>
            <label className="composer-field"><span><b>Search</b></span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Job or city" aria-label="Search personas" disabled={runtime === 'running' || busy} />
            </label>
          </div>
          <div className="persona-filter-actions">
            <button className="text-button" type="button" onClick={selectVisible} disabled={runtime === 'running' || busy}>Use visible profiles</button>
            <button className="text-button" type="button" onClick={() => setProfileMix([])} disabled={runtime === 'running' || busy}>Use full catalog</button>
            <span>{selectedCount} selected · {visible.length} shown</span>
          </div>
          <fieldset className="profile-mix" disabled={runtime === 'running' || busy}>
            <legend>Audience profiles</legend>
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
          <p className="experiment-catalog-note">{catalog.length} profiles available · {PERSONA_TEMPLATES.length} built-in · {campaign.customPersonas.length} custom</p>
        </div>}
        {addingPersona && <div className="wave-custom-persona-form">
          <div className="wave-custom-persona-heading"><strong>Add custom profile</strong><span>Saved to this campaign for later waves.</span></div>
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
            <div className="persona-form-actions">
              <button className="button button-primary" type="submit" disabled={runtime === 'running' || busy} aria-busy={busy}><Plus size={15} /> Save profile</button>
              <button className="text-button" type="button" onClick={() => setAddingPersona(false)} disabled={busy}>Cancel</button>
            </div>
          </form>
        </div>
        }
      </div>

      <div className="wave-setup-panel wave-settings-panel" role="tabpanel" id="wave-settings-panel" aria-labelledby="wave-settings-tab" hidden={setupTab !== 'settings'}>
        <div className="experiment-settings-grid">
          <label className="composer-field">
            <span><b>Agent count</b><small>{MIN_AGENT_COUNT}–{MAX_AGENT_COUNT} profiles to simulate</small></span>
            <input type="number" min={MIN_AGENT_COUNT} max={MAX_AGENT_COUNT} value={agentCount} disabled={runtime === 'running' || busy}
              onChange={(event) => setAgentCount(Math.max(MIN_AGENT_COUNT, Math.min(MAX_AGENT_COUNT, Number(event.target.value) || DEFAULT_AGENT_COUNT)))} aria-label="Number of persona agents" />
          </label>
          <label className="composer-field">
            <span><b>Concurrency</b><small>Up to {MAX_CONCURRENCY} profiles at once</small></span>
            <input type="number" min={1} max={MAX_CONCURRENCY} value={concurrency} disabled={runtime === 'running' || busy}
              onChange={(event) => setConcurrency(Math.max(1, Math.min(MAX_CONCURRENCY, Number(event.target.value) || DEFAULT_CONCURRENCY)))} aria-label="Concurrent persona agents" />
          </label>
          <label className="composer-field">
            <span><b>Click-rate target</b><small>1–100%</small></span>
            <input type="number" min={1} max={100} value={targetPercent} disabled={runtime === 'running' || busy}
              onChange={(event) => setTargetPercent(Math.max(1, Math.min(100, Number(event.target.value) || clickRateToPercent(DEFAULT_SUCCESS_CLICK_RATE))))} aria-label="Click-rate target percent" />
          </label>
          <label className="composer-field">
            <span><b>Max iterations</b><small>0 = no cap</small></span>
            <input type="number" min={MIN_MAX_AUTO_ROUNDS} max={MAX_MAX_AUTO_ROUNDS} value={maxIterations} disabled={runtime === 'running' || busy}
              onChange={(event) => setMaxIterations(Math.max(MIN_MAX_AUTO_ROUNDS, Math.min(MAX_MAX_AUTO_ROUNDS, Number(event.target.value) || 0)))} aria-label="Maximum loop iterations" />
          </label>
        </div>
        <p className="experiment-helper">The agent keeps testing until a variant hits the click-rate target. Set max iterations to cap automatic rounds, or leave 0 for no cap.</p>
      </div>

      <div className="experiment-run-row">
        <div className="wave-actions">
          {runtime === 'running'
            ? <button className="button button-secondary" type="button" onClick={() => void pause()} disabled={busy} aria-busy={busy}><Pause size={15} /> Pause</button>
            : runtime === 'paused'
              ? <button className="button button-primary" type="button" onClick={() => void resume()} disabled={busy} aria-busy={busy}><Play size={15} /> Resume</button>
              : <button className="button button-primary" type="button" onClick={() => void start()} disabled={busy || !validHeadlines} aria-busy={busy}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <Users size={15} />} Run until target
              </button>}
        </div>
        {!validHeadlines && <p className="experiment-start-guidance" role="status">{hasOverlongHeadline
          ? `Shorten headlines to ${HEADLINE_MAX_LENGTH} characters or fewer in Campaign before starting.`
          : `Add 2–3 unique headlines of up to ${HEADLINE_MAX_LENGTH} characters in Campaign before starting.`}</p>}
      </div>
      {wave?.loopActivity && (
        <section className="loop-live" aria-live="polite" aria-label="Campaign agent activity">
          <div className="loop-live-row">
            <LoaderCircle size={18} className="spin" />
            <div>
              <strong>{wave.loopActivity.title}</strong>
              <p>{wave.loopActivity.detail}</p>
            </div>
            <span className="loop-live-round">Round {wave.loopActivity.round}{wave.maxAutoRounds > 0 ? ` of ${wave.maxAutoRounds}` : ''}</span>
          </div>
          {runtime === 'running' && total > 0 && (
            <div className="wave-progress loop-live-progress" role="status">
              <div className="progress-track" role="progressbar" aria-label="Current wave progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(total, completed)}>
                <span style={{ width: `${Math.min(100, (completed / total) * 100)}%` }} />
              </div>
              <small>{completed} of {total} personas · {progress?.succeeded ?? 0} judged · {progress?.failed ?? 0} failed</small>
            </div>
          )}
          {wave.loopActivity.event && <p className="loop-live-event">{wave.loopActivity.event}</p>}
        </section>
      )}
      {wave?.loopContinuing && !wave.loopStatus && !wave.loopActivity && (
        <p className="loop-status" role="status">The campaign agent is running. It will keep testing and improving until the click-rate target is met.</p>
      )}
      {wave?.loopStatus && (
        <p className={`loop-status loop-${wave.loopStatus.reason}`} role="status">
          {wave.loopStatus.message}
          {wave.loopStatus.bestClickRate != null && ` Best click rate ${percent(wave.loopStatus.bestClickRate)} against a ${percent(wave.loopStatus.threshold)} threshold, measured from ${wave.loopStatus.metricsSource}.`}
          {wave.loopStatus.creativeNote && ` ${wave.loopStatus.creativeNote}`}
        </p>
      )}

      {error && <div className="alert alert-error" role="alert"><span>{error}</span></div>}
      {wave?.lastError && (progress?.failed ?? 0) > 0 && <div className="alert alert-error" role="alert"><span>{progress?.failed} {progress?.failed === 1 ? 'agent' : 'agents'} failed: {wave.lastError}</span></div>}
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
