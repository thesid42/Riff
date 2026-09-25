import { useEffect, useState } from 'react';
import { LoaderCircle, Pause, Play, Users } from 'lucide-react';
import type { DecisionRecord, WaveSnapshot } from '../shared/run.js';
import { DEFAULT_AGENT_COUNT, DEFAULT_CONCURRENCY, MAX_AGENT_COUNT, MAX_CONCURRENCY, MIN_AGENT_COUNT } from '../shared/run.js';
import { PERSONA_TEMPLATES } from '../shared/personas.js';

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

export default function PersonaWave({
  campaignId,
  headlines,
  wave,
  onWave,
}: {
  campaignId: string;
  headlines: string[];
  wave: WaveSnapshot | null;
  onWave: (wave: WaveSnapshot) => void;
}) {
  const [agentCount, setAgentCount] = useState(wave?.agentCount ?? DEFAULT_AGENT_COUNT);
  const [concurrency, setConcurrency] = useState(wave?.concurrency ?? DEFAULT_CONCURRENCY);
  const [profileMix, setProfileMix] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const runtime = wave?.runtime ?? 'idle';
  const progress = wave?.progress;
  const completed = (progress?.succeeded ?? 0) + (progress?.failed ?? 0);
  const total = progress?.total ?? 0;

  useEffect(() => {
    if (wave?.agentCount) setAgentCount(wave.agentCount);
    if (wave?.concurrency) setConcurrency(wave.concurrency);
  }, [wave?.agentCount, wave?.concurrency]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ wave: WaveSnapshot }>(`/api/campaigns/${encodeURIComponent(campaignId)}/run`, {
        agentCount, concurrency, headlines: headlines.filter((line) => line.trim()),
        ...(profileMix.length ? { profileMix } : {}),
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
      const result = await postJson<{ wave: WaveSnapshot }>(`/api/campaigns/${encodeURIComponent(campaignId)}/pause`, {});
      onWave(result.wave);
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
      const result = await postJson<{ wave: WaveSnapshot }>(`/api/campaigns/${encodeURIComponent(campaignId)}/resume`, {});
      onWave(result.wave);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The wave could not resume.');
    } finally {
      setBusy(false);
    }
  }

  function toggleProfile(id: string) {
    setProfileMix((current) => {
      const selected = current.length ? current : PERSONA_TEMPLATES.map((persona) => persona.id);
      const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
      return next.length === 0 || next.length === PERSONA_TEMPLATES.length ? [] : next;
    });
  }

  return (
    <section className="wave-panel" aria-labelledby="wave-title">
      <div className="wave-heading">
        <div>
          <span className="section-kicker">PERSONA WAVE</span>
          <h2 id="wave-title">Run this draft with profile agents</h2>
          <p>Liquid headlines go to age and job personas. The draft stays a draft while the wave runs.</p>
        </div>
        <span className={`status-pill ${runtime === 'running' ? 'wave-running' : ''}`}>
          <span className="status-dot" /> {runtime === 'running' ? 'Wave running' : runtime === 'paused' ? 'Wave paused' : 'Draft idle'}
        </span>
      </div>

      <div className="wave-controls">
        <label className="composer-field">
          <span><b>Agents</b><small>{MIN_AGENT_COUNT}–{MAX_AGENT_COUNT}</small></span>
          <input type="number" min={MIN_AGENT_COUNT} max={MAX_AGENT_COUNT} value={agentCount} disabled={runtime === 'running' || busy}
            onChange={(event) => setAgentCount(Math.max(MIN_AGENT_COUNT, Math.min(MAX_AGENT_COUNT, Number(event.target.value) || DEFAULT_AGENT_COUNT)))} aria-label="Number of persona agents" />
        </label>
        <label className="composer-field">
          <span><b>Concurrency</b><small>1–{MAX_CONCURRENCY}</small></span>
          <input type="number" min={1} max={MAX_CONCURRENCY} value={concurrency} disabled={runtime === 'running' || busy}
            onChange={(event) => setConcurrency(Math.max(1, Math.min(MAX_CONCURRENCY, Number(event.target.value) || DEFAULT_CONCURRENCY)))} aria-label="Concurrent persona agents" />
        </label>
        <div className="wave-actions">
          {runtime === 'running'
            ? <button className="button button-secondary" type="button" onClick={() => void pause()} disabled={busy}><Pause size={15} /> Pause</button>
            : runtime === 'paused'
              ? <button className="button button-primary" type="button" onClick={() => void resume()} disabled={busy}><Play size={15} /> Resume</button>
              : <button className="button button-primary" type="button" onClick={() => void start()} disabled={busy || headlines.filter((line) => line.trim()).length < 2}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <Users size={15} />} Start wave
              </button>}
        </div>
      </div>
      <p className="wave-headlines">{headlines.filter(Boolean).length ? `Judging: ${headlines.filter(Boolean).join(' · ')}` : 'Suggest or enter at least two headlines before starting.'}</p>
      <fieldset className="profile-mix" disabled={runtime === 'running' || busy}>
        <legend>Profile mix</legend>
        <p>Leave every profile selected, or narrow the audience without changing N. Applies to the next wave.</p>
        <div className="profile-mix-list">
          {PERSONA_TEMPLATES.map((persona) => (
            <label key={persona.id}>
              <input type="checkbox" checked={profileMix.length === 0 || profileMix.includes(persona.id)}
                onChange={() => toggleProfile(persona.id)} />
              {persona.label}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <div className="alert alert-error" role="alert"><span>{error}</span></div>}
      {wave?.lastError && (progress?.failed ?? 0) > 0 && <div className="alert alert-error" role="alert"><span>{progress?.failed} agents failed: {wave.lastError}</span></div>}
      {wave?.ingestError && <div className="alert alert-error" role="alert"><span>Analytics ingest: {wave.ingestError}</span></div>}
      {wave?.reviewError && <div className="alert alert-error" role="alert"><span>Campaign review: {wave.reviewError}</span></div>}

      <div className="wave-progress" role="status">
        <div className="progress-track" aria-label="Persona wave progress">
          <span style={{ width: `${total ? Math.min(100, (completed / total) * 100) : 0}%` }} />
        </div>
        <small>{completed} / {total || agentCount} agents · {progress?.succeeded ?? 0} judged · {progress?.failed ?? 0} failed · {progress?.running ?? 0} live</small>
      </div>

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
            <caption>Persona results by age and job</caption>
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
      ) : (
        <p className="wave-empty">Profiles: {PERSONA_TEMPLATES.map((persona) => persona.label).join(', ')}</p>
      )}

      <DecisionCard decision={wave?.latestDecision ?? null} />
    </section>
  );
}

function DecisionCard({ decision }: { decision: DecisionRecord | null }) {
  if (!decision) return <p className="wave-empty">A campaign review appears here when the wave finishes.</p>;
  return (
    <article className="decision-card">
      <span className="section-kicker">LATEST REVIEW</span>
      <h3>{decision.action === 'wait' ? 'Wait for more evidence' : 'Propose another headline test'}</h3>
      <p>{decision.explanation}</p>
      {decision.hypothesis && <small>Hypothesis · {decision.hypothesis}</small>}
      {decision.headlines.length > 0 && <small>Next headlines · {decision.headlines.join(' · ')}</small>}
    </article>
  );
}
