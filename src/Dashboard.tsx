import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, BookOpen, LoaderCircle, Plus, Settings2, Sprout } from 'lucide-react';
import { deriveMetrics, type Campaign, type Experiment, type IntegrationStatus, type Lesson, type MetricsSnapshot } from '../shared/types.js';
import type { WaveSnapshot } from '../shared/run.js';
import './dashboard.css';

interface CampaignDetails {
  campaign: Campaign;
  experiments: Experiment[];
  lessons: Lesson[];
  wave?: WaveSnapshot;
}

export interface DashboardCampaign {
  campaign: Campaign;
  experimentCount: number;
  lessonCount: number;
  latestLesson: string | null;
  wave: WaveSnapshot | null;
  metrics: MetricsSnapshot | null;
}

const numberFormat = new Intl.NumberFormat('en-US');
const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function count(value: number | undefined): string {
  return Number.isFinite(value) ? numberFormat.format(value as number) : '—';
}

function money(cents: number | null | undefined): string {
  return cents != null && Number.isFinite(cents) ? usdFormat.format(cents / 100) : '—';
}

function percent(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

function displayTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body &&
      typeof body.error === 'object' && body.error !== null && 'message' in body.error &&
      typeof body.error.message === 'string'
      ? body.error.message
      : `The request failed (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

function isLive(wave: WaveSnapshot | null | undefined): boolean {
  return Boolean(wave && (wave.loopActivity || wave.runtime === 'running' || wave.loopContinuing || wave.loopActive));
}

export function campaignStatus(row: DashboardCampaign): { label: string; kind: 'live' | 'paused' | 'done' | 'alert' | 'idle' } {
  const wave = row.wave;
  if (wave?.loopActivity) return { label: wave.loopActivity.title, kind: 'live' };
  if (wave?.runtime === 'running') return { label: 'Agent running', kind: 'live' };
  if (wave?.loopActive || wave?.loopContinuing) return { label: 'Improving toward target', kind: 'live' };
  if (wave?.runtime === 'paused') return { label: 'Paused', kind: 'paused' };
  if (wave?.loopStatus?.reason === 'threshold_met') return { label: 'Target reached', kind: 'done' };
  if (wave?.loopStatus?.reason === 'review_failed' || wave?.loopStatus?.reason === 'rules_failed' || wave?.loopStatus?.reason === 'creative_failed') {
    return { label: 'Loop stopped', kind: 'alert' };
  }
  if (row.experimentCount > 0) return { label: 'Last test complete', kind: 'idle' };
  return { label: 'Draft', kind: 'idle' };
}

export default function WorkspaceDashboard({
  campaigns,
  integrations,
  listLoading,
  listError,
  onRetryList,
  onCreate,
  onOpenCampaign,
  onOpenExperiments,
  onOpenLessons,
  onOpenConnections,
  onSetup,
}: {
  campaigns: Campaign[];
  integrations: IntegrationStatus[];
  listLoading: boolean;
  listError: string;
  onRetryList: () => void;
  onCreate: () => void;
  onOpenCampaign: (campaignId: string) => void;
  onOpenExperiments: (campaignId: string) => void;
  onOpenLessons: (campaignId: string) => void;
  onOpenConnections: () => void;
  onSetup: () => void;
}) {
  const [rows, setRows] = useState<DashboardCampaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (campaigns.length === 0) {
      setRows([]);
      setLoading(false);
      setError('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all(campaigns.map(async (campaign) => {
      const [details, metrics] = await Promise.allSettled([
        getJson<CampaignDetails>(`/api/campaigns/${encodeURIComponent(campaign.id)}`, controller.signal),
        getJson<MetricsSnapshot>(`/api/campaigns/${encodeURIComponent(campaign.id)}/metrics`, controller.signal),
      ]);
      const loaded = details.status === 'fulfilled' ? details.value : null;
      return {
        campaign: loaded?.campaign ?? campaign,
        experimentCount: loaded?.experiments.length ?? 0,
        lessonCount: loaded?.lessons.length ?? 0,
        latestLesson: loaded?.lessons[0]?.statement ?? null,
        wave: loaded?.wave ?? null,
        metrics: metrics.status === 'fulfilled' && metrics.value.campaignId === campaign.id ? metrics.value : null,
      } satisfies DashboardCampaign;
    }))
      .then((next) => {
        if (!controller.signal.aborted) setRows(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Dashboard details could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [campaigns, refresh]);

  useEffect(() => {
    if (!rows.some((row) => isLive(row.wave))) return;
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [rows]);

  const totals = useMemo(() => {
    const impressions = rows.reduce((sum, row) => sum + (row.metrics?.totals.impressions ?? 0), 0);
    const clicks = rows.reduce((sum, row) => sum + (row.metrics?.totals.clicks ?? 0), 0);
    const signups = rows.reduce((sum, row) => sum + (row.metrics?.totals.signups ?? 0), 0);
    const lessons = rows.reduce((sum, row) => sum + row.lessonCount, 0);
    const live = rows.filter((row) => isLive(row.wave)).length;
    const clickRates = rows
      .map((row) => row.metrics ? deriveMetrics(row.metrics.totals).clickRate : null)
      .filter((value): value is number => value != null);
    const bestClickRate = clickRates.length ? Math.max(...clickRates) : null;
    const configured = integrations.filter((item) => item.status === 'configured').length;
    return { impressions, clicks, signups, lessons, live, bestClickRate, configured };
  }, [integrations, rows]);

  const recentLessons = useMemo(() => (
    rows
      .filter((row) => row.latestLesson)
      .map((row) => ({ campaignId: row.campaign.id, name: row.campaign.name, statement: row.latestLesson!, updatedAt: row.campaign.updatedAt }))
      .slice(0, 4)
  ), [rows]);

  return (
    <div className="workspace-dashboard">
      <section className="campaign-heading" aria-label="Workspace dashboard">
        <div className="campaign-heading-main">
          <div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE OVERVIEW</div>
          <div className="heading-row">
            <div className="campaign-title-wrap">
              <h1>Dashboard</h1>
            </div>
            <div className="heading-actions">
              <button type="button" className="button button-secondary" onClick={onSetup}><Settings2 size={16} /> Setup</button>
              <button type="button" className="button button-primary" disabled={listLoading || Boolean(listError && campaigns.length === 0)} onClick={onCreate}><Plus size={17} /> Create campaign</button>
            </div>
          </div>
          <p className="campaign-subtitle">
            {campaigns.length > 0
              ? `${campaigns.length} ${campaigns.length === 1 ? 'campaign' : 'campaigns'} · ${totals.live} running · ${totals.lessons} ${totals.lessons === 1 ? 'learning' : 'learnings'}`
              : 'Loops, click rates, and learnings across every campaign in this workspace.'}
          </p>
        </div>
      </section>

      {error && <div className="alert alert-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => setRefresh((value) => value + 1)}>Retry</button></div>}

      {listLoading && campaigns.length === 0 ? <div className="loading-state" role="status"><LoaderCircle size={17} className="spin" />Loading workspace…</div> : campaigns.length === 0 ? (
        <section className="dash-empty" aria-labelledby="dash-empty-title">
          <span className="dash-empty-mark"><Sprout size={22} /></span>
          <h2 id="dash-empty-title">Start with a campaign brief.</h2>
          <p>Save a product, audience, and budget to see live loops, simulated click rates, and experiment learnings on this dashboard.</p>
          {listError
            ? <button type="button" className="button button-secondary" onClick={onRetryList}>Retry campaign list <ArrowRight size={15} /></button>
            : <button type="button" className="button button-primary" onClick={onCreate}><Plus size={16} /> Create campaign draft</button>}
        </section>
      ) : (
        <>
          <section className="metric-strip dash-strip" aria-label="Workspace metrics">
            <Metric label="Campaigns" value={count(campaigns.length)} hint={totals.live ? `${totals.live} live now` : 'Saved drafts'} />
            <Metric label="Best click rate" value={percent(totals.bestClickRate)} hint="Highest simulated CTR" />
            <Metric label="Sign-ups" value={count(totals.signups)} hint={`${count(totals.clicks)} clicks · ${count(totals.impressions)} views`} />
            <Metric label="Learnings" value={count(totals.lessons)} hint="Saved from completed waves" />
            <Metric label="Connections" value={`${totals.configured}/${integrations.length || 0}`} hint="Configured locally" />
          </section>

          <div className="dash-layout">
            <section className="dash-campaigns" aria-labelledby="dash-campaigns-title">
              <div className="dash-section-head">
                <div>
                  <span className="section-kicker">CAMPAIGNS</span>
                  <h2 id="dash-campaigns-title">Every draft and running loop</h2>
                </div>
                {loading && <span className="dash-refresh" role="status"><LoaderCircle size={14} className="spin" /> Updating</span>}
              </div>
              <div className="dash-card-grid">
                {rows.map((row) => {
                  const status = campaignStatus(row);
                  const derived = row.metrics ? deriveMetrics(row.metrics.totals) : null;
                  const spend = row.metrics?.totals.spendCents ?? 0;
                  const budget = row.campaign.budgetCents;
                  const spendPercent = budget > 0 ? Math.min(100, Math.max(0, spend / budget * 100)) : 0;
                  return (
                    <article className="dash-card" key={row.campaign.id}>
                      <div className="dash-card-top">
                        <span className={`status-pill dash-status dash-status-${status.kind}`}>
                          {status.kind === 'live' ? <LoaderCircle size={13} className="spin" /> : <span className="status-dot" />}
                          {status.label}
                        </span>
                        <span className="dash-card-updated">{displayTime(row.campaign.updatedAt) ?? '—'}</span>
                      </div>
                      <h3>{row.campaign.name}</h3>
                      <p className="dash-card-copy">{row.campaign.product} · {row.campaign.audience}</p>
                      <dl className="dash-card-stats">
                        <div><dt>Click rate</dt><dd>{percent(derived?.clickRate)}</dd></div>
                        <div><dt>Sign-ups</dt><dd>{row.metrics ? count(row.metrics.totals.signups) : '—'}</dd></div>
                        <div><dt>Target</dt><dd>{percent(row.wave?.successClickRate)}</dd></div>
                      </dl>
                      <div className="dash-spend">
                        <span>{money(spend)} / {money(budget)}</span>
                        <div className="progress-track" role="progressbar" aria-label={`${row.campaign.name} budget used`} aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spend}>
                          <span style={{ width: `${spendPercent}%` }} />
                        </div>
                      </div>
                      {(row.wave?.loopActivity || row.latestLesson) && (
                        <p className="dash-card-note">
                          {row.wave?.loopActivity
                            ? `${row.wave.loopActivity.detail}${row.wave.loopActivity.event ? ` ${row.wave.loopActivity.event}` : ''}`
                            : row.latestLesson}
                        </p>
                      )}
                      <div className="dash-card-meta">
                        <span>{row.experimentCount} {row.experimentCount === 1 ? 'experiment' : 'experiments'}</span>
                        <span>{row.lessonCount} {row.lessonCount === 1 ? 'learning' : 'learnings'}</span>
                      </div>
                      <div className="dash-card-actions">
                        <button type="button" className="button button-secondary" onClick={() => onOpenCampaign(row.campaign.id)}>Open campaign</button>
                        <button type="button" className="button button-primary" onClick={() => onOpenExperiments(row.campaign.id)}>Experiments <ArrowRight size={15} /></button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <aside className="dash-side">
              <section className="panel dash-side-panel" aria-labelledby="dash-lessons-title">
                <div className="dash-section-head">
                  <div>
                    <span className="section-kicker">RECENT LEARNINGS</span>
                    <h2 id="dash-lessons-title">What the last waves found</h2>
                  </div>
                </div>
                {recentLessons.length === 0 ? (
                  <p className="dash-side-empty">Finished waves write a learning here. Open Experiments to run the next loop.</p>
                ) : (
                  <ul className="dash-lesson-list">
                    {recentLessons.map((lesson) => (
                      <li key={`${lesson.campaignId}-${lesson.statement}`}>
                        <button type="button" onClick={() => onOpenLessons(lesson.campaignId)}>
                          <strong>{lesson.name}</strong>
                          <span>{lesson.statement}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {campaigns[0] && <button type="button" className="text-button dash-side-link" onClick={() => onOpenLessons(campaigns[0].id)}>View all learnings <BookOpen size={14} /></button>}
              </section>

              <section className="panel dash-side-panel" aria-labelledby="dash-connections-title">
                <div className="dash-section-head">
                  <div>
                    <span className="section-kicker">CONNECTIONS</span>
                    <h2 id="dash-connections-title">Local provider health</h2>
                  </div>
                </div>
                {integrations.length === 0 ? (
                  <p className="dash-side-empty">Connection status is not available right now.</p>
                ) : (
                  <ul className="dash-connection-list">
                    {integrations.map((integration) => (
                      <li key={integration.id}>
                        <span className={`connection-state connection-${integration.status}`}>
                          <span className="status-dot" />
                          {integration.status === 'configured' ? 'Ready' : integration.status === 'invalid' ? 'Needs attention' : 'Not set'}
                        </span>
                        <div>
                          <strong>{integration.name}</strong>
                          <span>{integration.purpose}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="text-button dash-side-link" onClick={onOpenConnections}>Manage connections <Settings2 size={14} /></button>
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="metric-item"><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-hint">{hint}</div></div>;
}
