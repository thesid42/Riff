import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  ArrowRight, BarChart3, BookOpen, Check, ChevronDown, CircleHelp, FlaskConical,
  Leaf, LoaderCircle, Plus, Settings2, Sprout, X,
} from 'lucide-react';
import type {
  Campaign, Experiment, IntegrationStatus, Lesson, MetricsSnapshot, Variant,
} from '../shared/types.js';
import type { RoundSummary, WaveSnapshot } from '../shared/run.js';
import type { CreativeImageJob } from '../shared/creative.js';
import { isStoredHeadlineSet, isValidHeadlineSet } from '../shared/headlines.js';
import CreativeComposer from './CreativeComposer.js';
import PersonaWave from './PersonaWave.js';
import SignupChart from './SignupChart.js';
import ExperimentResults from './ExperimentResults.js';
import './charts.css';

type View = 'Campaign' | 'Experiments' | 'Lessons' | 'Connections';
type Drawer = 'metrics' | 'setup' | null;

interface CampaignDetails {
  campaign: Campaign;
  variants: Variant[];
  experiments: Experiment[];
  lessons: Lesson[];
  wave?: WaveSnapshot;
}

interface RoundMetrics extends Partial<RoundSummary> {
  round: number;
  experiment: Experiment;
  metrics: MetricsSnapshot;
}

const ROUND_CREATIVE_LABELS: Record<RoundSummary['creative'], string> = {
  initial: 'Starting creative',
  new: 'New creative',
  reused: 'Reused creative',
  'text-only': 'Text only',
};

function personaSummary(personas: RoundSummary['personas'] | undefined): string {
  if (!personas?.length) return 'No personas judged yet';
  const shown = personas.slice(0, 3).map((persona) => persona.label).join(', ');
  return personas.length > 3 ? `${shown} +${personas.length - 3} more` : shown;
}

interface SelectedCreative {
  campaignId: string;
  jobId: string;
  headlines: string[];
}

interface ApiError extends Error {
  status?: number;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw responseError(body, response.status);
  return body as T;
}

async function postJson<T>(url: string, value: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw responseError(body, response.status);
  return body as T;
}

function responseError(body: unknown, status: number): ApiError {
  const message = typeof body === 'object' && body !== null && 'error' in body &&
    typeof body.error === 'object' && body.error !== null && 'message' in body.error &&
    typeof body.error.message === 'string'
    ? body.error.message
    : `The request failed (${status}).`;
  const error = new Error(message) as ApiError;
  error.status = status;
  return error;
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
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
}

function humanizeStatus(status: string): string {
  return status.replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

function displayTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function App() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [view, setView] = useState<View>('Campaign');
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listRetry, setListRetry] = useState(0);
  const [details, setDetails] = useState<CampaignDetails | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [rounds, setRounds] = useState<RoundMetrics[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [metricsError, setMetricsError] = useState('');
  const [campaignRetry, setCampaignRetry] = useState(0);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [integrationsLoading, setIntegrationsLoading] = useState(true);
  const [integrationsError, setIntegrationsError] = useState('');
  const [integrationRetry, setIntegrationRetry] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string[]>>({});
  const [selectedCreative, setSelectedCreative] = useState<SelectedCreative | null>(null);

  const currentCampaign = campaigns.find((campaign) => campaign.id === selectedId) ?? null;
  const activeCampaign = details?.campaign.id === selectedId ? details.campaign : currentCampaign;
  const hasComposerDraft = Object.prototype.hasOwnProperty.call(composerDrafts, selectedId);
  const matchingDetails = details?.campaign.id === selectedId ? details : null;
  const composerHeadlines = hasComposerDraft
    ? composerDrafts[selectedId]!
    : (activeCampaign?.headlines && isStoredHeadlineSet(activeCampaign.headlines)) ? activeCampaign.headlines :
      (matchingDetails?.wave?.headlines && isStoredHeadlineSet(matchingDetails.wave.headlines)) ? matchingDetails.wave.headlines : [];
  const currentCreativeSelection = selectedCreative?.campaignId === selectedId && isValidHeadlineSet(selectedCreative.headlines) && isValidHeadlineSet(composerHeadlines) &&
    JSON.stringify(selectedCreative.headlines) === JSON.stringify(composerHeadlines) ? selectedCreative : null;

  function updateComposerHeadlines(campaignId: string, headlines: string[]) {
    setComposerDrafts((current) => ({ ...current, [campaignId]: headlines }));
    setSelectedCreative((current) => current && current.campaignId === campaignId && JSON.stringify(current.headlines) !== JSON.stringify(headlines) ? null : current);
  }

  useEffect(() => { setSelectedCreative(null); }, [selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    setListLoading(true);
    setListError('');
    getJson<{ campaigns: Campaign[] }>('/api/campaigns', controller.signal)
      .then(({ campaigns: found }) => {
        if (controller.signal.aborted) return;
        const safeCampaigns = Array.isArray(found) ? found : [];
        setCampaigns(safeCampaigns);
        setSelectedId((previous) => previous && safeCampaigns.some((item) => item.id === previous)
          ? previous
          : safeCampaigns[0]?.id ?? '');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setListError(error instanceof Error ? error.message : 'Campaigns could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [listRetry]);

  useEffect(() => {
    const controller = new AbortController();
    setIntegrationsLoading(true);
    setIntegrationsError('');
    getJson<{ integrations: IntegrationStatus[] }>('/api/integrations', controller.signal)
      .then(({ integrations: found }) => {
        if (!controller.signal.aborted) setIntegrations(Array.isArray(found) ? found : []);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setIntegrationsError(error instanceof Error ? error.message : 'Connections could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setIntegrationsLoading(false); });
    return () => controller.abort();
  }, [integrationRetry]);

  useEffect(() => {
    if (!selectedId) {
      setDetails(null);
      setMetrics(null);
      setRounds([]);
      setDetailsError('');
      setMetricsError('');
      setDetailsLoading(false);
      setMetricsLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetails(null);
    setMetrics(null);
    setRounds([]);
    setDetailsLoading(true);
    setMetricsLoading(true);
    setDetailsError('');
    setMetricsError('');

    getJson<CampaignDetails>(`/api/campaigns/${encodeURIComponent(selectedId)}`, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setDetails(result); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDetailsError(error instanceof Error ? error.message : 'Campaign details could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setDetailsLoading(false); });

    getJson<MetricsSnapshot>(`/api/campaigns/${encodeURIComponent(selectedId)}/metrics`, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && result.campaignId === selectedId) setMetrics(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMetricsError(error instanceof Error ? error.message : 'Metrics could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setMetricsLoading(false); });

    // Per-round metrics power one chart per experiment version.
    getJson<{ rounds: RoundMetrics[] }>(`/api/campaigns/${encodeURIComponent(selectedId)}/metrics/rounds`, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRounds(Array.isArray(result?.rounds) ? result.rounds : []);
      })
      .catch(() => { if (!controller.signal.aborted) setRounds([]); });
    return () => controller.abort();
  }, [selectedId, campaignRetry]);

  useEffect(() => {
    if (!selectedId || details?.wave?.runtime !== 'running') return;
    const controller = new AbortController();
    let inFlight = false;
    async function refreshWave() {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      const [nextDetails, nextMetrics, nextRounds] = await Promise.allSettled([
        getJson<CampaignDetails>(`/api/campaigns/${encodeURIComponent(selectedId)}`, controller.signal),
        getJson<MetricsSnapshot>(`/api/campaigns/${encodeURIComponent(selectedId)}/metrics`, controller.signal),
        getJson<{ rounds: RoundMetrics[] }>(`/api/campaigns/${encodeURIComponent(selectedId)}/metrics/rounds`, controller.signal),
      ]);
      if (!controller.signal.aborted) {
        if (nextDetails.status === 'fulfilled' && nextDetails.value.campaign.id === selectedId) setDetails(nextDetails.value);
        if (nextMetrics.status === 'fulfilled' && nextMetrics.value.campaignId === selectedId) setMetrics(nextMetrics.value);
        if (nextRounds.status === 'fulfilled') setRounds(Array.isArray(nextRounds.value.rounds) ? nextRounds.value.rounds : []);
      }
      inFlight = false;
    }
    void refreshWave();
    const timer = window.setInterval(() => void refreshWave(), 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [selectedId, details?.wave?.runtime]);

  async function createCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const rawBudget = String(form.get('budget') ?? '').trim();
    const budget = Number(rawBudget);
    const budgetCents = Math.round(budget * 100);
    if (!Number.isFinite(budget) || !Number.isSafeInteger(budgetCents) || budgetCents < 1) {
      setSaveError('Enter a budget of at least $0.01.');
      return;
    }
    setSaving(true);
    setSaveError('');
    const payload = {
      name: String(form.get('name') ?? '').trim(),
      product: String(form.get('product') ?? '').trim(),
      audience: String(form.get('audience') ?? '').trim(),
      goal: 'signups' as const,
      approvedClaims: String(form.get('approvedClaims') ?? '').split(/\r?\n/).map((claim) => claim.trim()).filter(Boolean),
      budgetCents,
      currency: 'USD' as const,
    };
    try {
      const { campaign } = await postJson<{ campaign: Campaign }>('/api/campaigns', payload);
      setCampaigns((previous) => [campaign, ...previous.filter((entry) => entry.id !== campaign.id)]);
      setSelectedId(campaign.id);
      setView('Campaign');
      setDialogOpen(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The draft could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const retryCampaign = () => setCampaignRetry((count) => count + 1);
  const navItems: Array<{ label: View; icon: typeof BarChart3 }> = [
    { label: 'Campaign', icon: BarChart3 },
    { label: 'Experiments', icon: FlaskConical },
    { label: 'Lessons', icon: BookOpen },
    { label: 'Connections', icon: Settings2 },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#campaign" onClick={(event) => { event.preventDefault(); setView('Campaign'); }} aria-label="Riff home">
          <span className="brand-mark"><Sprout size={20} strokeWidth={1.8} /></span>
          <span>Riff</span>
        </a>
        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${view === label ? 'is-active' : ''}`} type="button" onClick={() => setView(label)} aria-current={view === label ? 'page' : undefined}>
              <Icon className="nav-icon" size={16} aria-hidden="true" />{label}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <span className="workspace-label"><span className="online-dot" /> Local workspace</span>
          <button className="icon-button" type="button" aria-label="Setup and connections" title="Setup and connections" onClick={() => setDrawer('setup')}>
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      <main className="main-content">
        {listError && <div className="alert alert-error" role="alert"><span>{listError}</span><button type="button" className="text-button" onClick={() => setListRetry((count) => count + 1)}>Retry</button></div>}
        {listLoading && campaigns.length === 0 && !listError ? <LoadingState label="Loading saved campaigns…" /> : (
          <>
            <section className="campaign-heading" aria-label="Campaign controls">
              <div className="campaign-heading-main">
                <div className="eyebrow"><span className="eyebrow-line" /> CAMPAIGN WORKSPACE</div>
                <div className="heading-row">
                  <div className="campaign-title-wrap">
                    {campaigns.length > 0 ? (
                      <label className="sr-only" htmlFor="campaign-select">Choose campaign</label>
                    ) : null}
                    {campaigns.length > 0 ? (
                      <div className="campaign-select-wrap">
                        <select id="campaign-select" className="campaign-select" value={selectedId} onChange={(event) => setSelectedId(event.target.value)} aria-label="Choose campaign">
                          {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
                        </select>
                        <ChevronDown size={18} aria-hidden="true" />
                      </div>
                      ) : (
                      <h1>{listLoading || listError ? 'Campaign workspace' : 'Your next campaign starts here'}</h1>
                    )}
                    {campaigns.length > 0 && <div className="campaign-meta"><span className="status-pill"><span className="status-dot" /> {details?.wave?.runtime === 'running' ? 'Draft · wave running' : details?.wave?.runtime === 'paused' ? 'Draft · wave paused' : 'Draft'}</span><span>{activeCampaign?.product ?? 'Campaign brief'}</span></div>}
                  </div>
                  <div className="heading-actions">
                    {activeCampaign && <button type="button" className="button button-secondary" onClick={() => {
                      setView('Experiments');
                      window.requestAnimationFrame(() => document.getElementById('experiment-setup')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
                    }}><FlaskConical size={16} /> Experiment setup</button>}
                    <button type="button" className="button button-secondary" onClick={() => setDrawer('setup')}><Settings2 size={16} /> Setup</button>
                    <button type="button" className="button button-primary" disabled={listLoading || Boolean(listError && campaigns.length === 0)} onClick={() => { setSaveError(''); setDialogOpen(true); }}><Plus size={17} /> Create campaign</button>
                  </div>
                </div>
                <p className="campaign-subtitle">{activeCampaign
                  ? `${activeCampaign.audience} · Sign-up goal · Saved ${displayTime(activeCampaign.createdAt) ?? 'as a draft'}`
                  : 'Shape a brief, save a draft, and keep every result grounded in real campaign data.'}</p>
              </div>
            </section>

            {view === 'Campaign' && (
              <CampaignDashboard
                campaign={activeCampaign}
                details={details?.campaign.id === selectedId ? details : null}
                metrics={metrics?.campaignId === selectedId ? metrics : null}
                rounds={rounds.filter((entry) => entry.experiment.campaignId === selectedId)}
                listLoading={listLoading}
                listError={listError}
                detailsLoading={detailsLoading}
                metricsLoading={metricsLoading}
                detailsError={detailsError}
                metricsError={metricsError}
                onRetry={retryCampaign}
                onShowMetrics={() => setDrawer('metrics')}
                onCreate={() => { setSaveError(''); setDialogOpen(true); }}
                onRetryList={() => setListRetry((count) => count + 1)}
                onOpenExperiments={() => setView('Experiments')}
                initialHeadlines={hasComposerDraft || isStoredHeadlineSet(composerHeadlines) ? composerHeadlines : undefined}
                onHeadlinesChange={(headlines) => activeCampaign && updateComposerHeadlines(activeCampaign.id, headlines)}
                selectedCreativeJobId={currentCreativeSelection?.jobId ?? null}
                onUseForExperiment={(job, headlines) => {
                  if (!activeCampaign || !isValidHeadlineSet(headlines)) return;
                  updateComposerHeadlines(activeCampaign.id, [...headlines]);
                  setSelectedCreative({ campaignId: activeCampaign.id, jobId: job.id, headlines: [...headlines] });
                  setView('Experiments');
                  window.requestAnimationFrame(() => document.getElementById('experiment-setup')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
                }}
              />
            )}
            {view === 'Experiments' && (
              <ExperimentsView
                campaign={activeCampaign}
                details={details?.campaign.id === selectedId ? details : null}
                metrics={metrics?.campaignId === selectedId ? metrics : null}
                headlines={currentCreativeSelection?.headlines ?? composerHeadlines}
                creativeJobId={currentCreativeSelection?.jobId ?? null}
                onClearCreative={() => setSelectedCreative(null)}
                loading={detailsLoading}
                error={detailsError}
                onRetry={retryCampaign}
                onWave={(wave) => setDetails((current) => current?.campaign.id === selectedId ? { ...current, wave, campaign: { ...current.campaign, runtime: wave.runtime, agentCount: wave.agentCount, concurrency: wave.concurrency, headlines: wave.headlines } } : current)}
                onCampaign={(campaign) => {
                  setDetails((current) => current?.campaign.id === campaign.id ? { ...current, campaign } : current);
                  setCampaigns((previous) => previous.map((item) => item.id === campaign.id ? campaign : item));
                }}
              />
            )}
            {view === 'Lessons' && <RecordsView title="Lessons" description="Evidence-backed observations stay tied to the audience and test that produced them." icon={<BookOpen size={19} />} loading={detailsLoading} error={detailsError} onRetry={retryCampaign} hasCampaign={Boolean(activeCampaign)} emptyTitle="No lessons recorded" emptyBody="Campaign learnings will show here with the experiment that supports each one." items={details?.campaign.id === selectedId ? details.lessons : []} kind="lesson" />}
            {view === 'Connections' && <ConnectionsView integrations={integrations} loading={integrationsLoading} error={integrationsError} onRetry={() => setIntegrationRetry((count) => count + 1)} />}
          </>
        )}
      </main>

      {dialogOpen && <CreateCampaignDialog onClose={() => { if (!saving) setDialogOpen(false); }} onSubmit={createCampaign} saving={saving} error={saveError} />}
      {drawer && <InfoDrawer
        drawer={drawer}
        onClose={() => setDrawer(null)}
        campaign={activeCampaign}
        metrics={metrics?.campaignId === selectedId ? metrics : null}
        metricsLoading={metricsLoading}
        metricsError={metricsError}
        integrations={integrations}
        integrationsLoading={integrationsLoading}
        integrationsError={integrationsError}
        onRetryMetrics={retryCampaign}
        onRetryIntegrations={() => setIntegrationRetry((count) => count + 1)}
        onConnections={() => { setDrawer(null); setView('Connections'); }}
      />}
      <footer className="footer"><span><Leaf size={14} /> Built for careful experiments</span><span>Drafts stay local to this workspace</span></footer>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return <div className="loading-state" role="status"><LoaderCircle size={17} className="spin" />{label}</div>;
}

function CampaignDashboard({
  campaign, details, metrics, rounds, listLoading, listError, detailsLoading, metricsLoading, detailsError, metricsError, onRetry, onShowMetrics, onCreate, onRetryList,
  onOpenExperiments, initialHeadlines, onHeadlinesChange, selectedCreativeJobId, onUseForExperiment,
}: {
  campaign: Campaign | null;
  details: CampaignDetails | null;
  metrics: MetricsSnapshot | null;
  rounds: RoundMetrics[];
  listLoading: boolean;
  listError: string;
  detailsLoading: boolean;
  metricsLoading: boolean;
  detailsError: string;
  metricsError: string;
  onRetry: () => void;
  onShowMetrics: () => void;
  onCreate: () => void;
  onRetryList: () => void;
  onOpenExperiments: () => void;
  initialHeadlines?: string[];
  onHeadlinesChange: (headlines: string[]) => void;
  selectedCreativeJobId: string | null;
  onUseForExperiment: (job: CreativeImageJob, headlines: string[]) => void;
}) {
  const totals = metrics?.totals;
  const spend = totals ? money(totals.spendCents) : '—';
  const spendPercent = totals && campaign && campaign.budgetCents > 0 ? Math.min(100, Math.max(0, totals.spendCents / campaign.budgetCents * 100)) : 0;
  const variants = details?.variants ?? [];
  const retryError = detailsError || metricsError;

  return (
    <div className="dashboard-stack">
      {retryError && <div className="alert alert-error" role="alert"><span>{retryError}</span><button type="button" className="text-button" onClick={onRetry}>Retry</button></div>}
      <section className="metric-strip" aria-label="Campaign metrics">
        <MetricItem label="Ad views" value={totals ? count(totals.impressions) : '—'} hint="Total impressions" />
        <MetricItem label="Sign-ups" value={totals ? count(totals.signups) : '—'} hint="Recorded outcomes" />
        <MetricItem label="Cost per sign-up" value={totals ? money(deriveCostPerSignup(totals)) : '—'} hint="Simulated spend ÷ sign-ups" />
        <div className="metric-item metric-budget">
          <div className="metric-label">Simulated spend</div>
          <div className="metric-budget-value"><strong>{totals ? spend : '—'}</strong><span>/ {campaign ? money(campaign.budgetCents) : '—'}</span></div>
          <div className="progress-track" role={metrics && campaign ? 'progressbar' : undefined} aria-label={metrics && campaign ? 'Budget spent' : undefined} aria-valuemin={metrics && campaign ? 0 : undefined} aria-valuemax={metrics && campaign ? campaign.budgetCents : undefined} aria-valuenow={metrics && campaign ? totals?.spendCents ?? 0 : undefined}>
            <span style={{ width: `${totals ? spendPercent : 0}%` }} />
          </div>
          <span className="metric-hint">Budget used</span>
        </div>
          <button type="button" className="all-metrics-link" onClick={onShowMetrics}>All metrics <ArrowRight size={16} /></button>
      </section>

      <div className="insight-grid">
        <section className="panel chart-panel chart-panel-explained" aria-labelledby="chart-title">
          <div className="panel-heading">
            <div><span className="section-kicker">LOCAL PERSONA SIMULATION</span><h2 id="chart-title">Cumulative simulated sign-ups</h2><p>Each step adds a recorded sign-up from a simulated audience profile. Versions are compared over the same wave timeline.</p></div>
          </div>
          <SignupChart metrics={metrics} variants={variants} loading={metricsLoading} />
          <div className="chart-footnote"><span>{metrics?.window.label ?? 'Latest persona wave'}</span><span>Metrics source: {metrics?.source && metrics.source !== 'none' ? humanizeStatus(metrics.source) : 'not available'}</span></div>
        </section>


        <section className="next-panel" aria-labelledby="next-title">
          <div className="next-topline"><span className="next-icon"><Sprout size={19} /></span><span className="section-kicker">CAMPAIGN STATUS</span></div>
          <h2 id="next-title">{listLoading ? 'Checking saved campaigns…' : listError ? 'Campaigns could not be loaded.' : campaign ? 'Your campaign draft is saved.' : 'Start with a campaign brief.'}</h2>
          <p>{listError ? 'Retry the campaign list before creating a new draft, so existing work stays easy to find.' : campaign ? metrics?.status === 'available' ? 'Your latest experiment results are shown alongside this brief. Compare the headline versions using the simulated sign-up counts and time axis.' : 'The product, audience, approved claims, and budget are saved. Results will appear when campaign activity is available.' : listLoading ? 'The workspace is checking for drafts saved on this device.' : 'Add a product, audience, approved claims, and demo budget to create a draft.'}</p>
          <div className="next-divider" />
          {listError ? <button type="button" className="button button-secondary" onClick={onRetryList}>Retry campaign list <ArrowRight size={15} /></button> : campaign ? <div className="next-bottom"><span className="status-pill"><span className="status-dot" /> Draft</span><span>{details?.wave?.runtime === 'running' ? 'Persona wave running' : detailsLoading ? 'Loading campaign' : details?.wave?.progress.total ? `${details.wave.progress.succeeded} judged` : 'No activity started'}</span></div> : <button type="button" className="button button-primary" onClick={onCreate} disabled={listLoading}><Plus size={16} /> Create campaign draft</button>}
          {details?.wave?.loopStatus && (
            <p className={`loop-status loop-${details.wave.loopStatus.reason}`} role="status">
              {details.wave.loopStatus.message}
              {details.wave.loopStatus.bestClickRate != null && ` Best click rate ${percent(details.wave.loopStatus.bestClickRate)} against a ${percent(details.wave.loopStatus.threshold)} threshold, measured from ${humanizeStatus(details.wave.loopStatus.metricsSource)}.`}
              {details.wave.loopStatus.creativeNote && ` ${details.wave.loopStatus.creativeNote}`}
            </p>
          )}
          {metrics?.message && <p className="source-message">{metrics.message}</p>}
        </section>
      </div>

      {rounds.length > 1 && <details className="experiment-history round-history">
        <summary><span>Results by round <span className="experiment-history-count">{rounds.length} rounds</span></span><ChevronDown size={17} /></summary>
        <div className="round-chart-grid">{rounds.map((entry) => <article className="round-chart" key={entry.experiment.id}>
          <div className="round-chart-head">
            <div className="round-chart-title"><strong>Round {entry.round}</strong><span className={`round-badge round-${entry.experiment.status}`}>{humanizeStatus(entry.experiment.status)}</span></div>
            <span className="round-chart-meta">{count(entry.metrics.totals.signups)} sign-ups · {count(entry.metrics.totals.clicks)} clicks · {count(entry.metrics.totals.impressions)} views</span>
            <span className="round-chart-hypothesis">{entry.experiment.hypothesis || 'No hypothesis recorded'}</span>
          </div>
          {entry.creative && <div className="round-creative"><span className={`round-creative-badge round-creative-${entry.creative}`}>{ROUND_CREATIVE_LABELS[entry.creative]}</span>
            {entry.media?.some((item) => item.imageUrl) && <div className="round-thumbs">{entry.media.map((item) => item.imageUrl ? <img key={item.label} src={item.imageUrl} alt={`Variant ${item.label}: ${item.headline}`} loading="lazy" /> : null)}</div>}
          </div>}
          {entry.personas && <span className="round-personas" title={entry.personas.map((persona) => persona.label).join(', ')}>{entry.personas.length} personas · {personaSummary(entry.personas)}</span>}
          <SignupChart metrics={entry.metrics} variants={variants.filter((variant) => variant.experimentId === entry.experiment.id)} loading={false} />
          <div className="chart-footnote"><span>Metrics source: {humanizeStatus(entry.metrics.source)}</span><span>{displayTime(entry.experiment.windowStart) ?? '—'}</span></div>
        </article>)}</div>
      </details>}
      {campaign && <CreativeComposer campaign={campaign} initialHeadlines={initialHeadlines} onHeadlinesChange={onHeadlinesChange} selectedCreativeJobId={selectedCreativeJobId} onUseForExperiment={onUseForExperiment} />}

      {campaign ? <section className="experiment-summary-link" aria-label="Experiment results">
        <div><h3>{details?.experiments.length ? 'Your experiment results are in Experiments' : 'Ready to compare your headlines?'}</h3><p>Keep generated creatives here. Compare simulated responses and review previous waves in Experiments.</p></div>
        <button type="button" className="button button-secondary" onClick={onOpenExperiments}>{details?.experiments.length ? 'View experiment results' : 'Set up an experiment'} <ArrowRight size={16} /></button>
      </section> : <div className="empty-creatives"><div><h3>No campaign content yet</h3><p>Save a campaign draft to create and review your first ads.</p></div></div>}
    </div>
  );
}

function deriveCostPerSignup(totals: NonNullable<MetricsSnapshot['totals']>): number | null {
  return totals.signups > 0 ? totals.spendCents / totals.signups : null;
}

function MetricItem({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="metric-item"><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-hint">{hint}</div></div>;
}

function ExperimentsView({
  campaign, details, metrics, headlines, creativeJobId, onClearCreative, loading, error, onRetry, onWave, onCampaign,
}: {
  campaign: Campaign | null;
  details: CampaignDetails | null;
  metrics: MetricsSnapshot | null;
  headlines: string[];
  creativeJobId: string | null;
  onClearCreative: () => void;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onWave: (wave: WaveSnapshot) => void;
  onCampaign: (campaign: Campaign) => void;
}) {
  return (
    <div className="dashboard-stack">
      {campaign ? (
        <PersonaWave key={`wave-${campaign.id}`} campaign={campaign} headlines={headlines} creativeJobId={creativeJobId} onClearCreative={onClearCreative} wave={details?.wave ?? null} onWave={onWave} onCampaign={onCampaign} />
      ) : (
        <div className="empty-records"><span className="empty-record-icon"><FlaskConical size={20} /></span><h3>Choose a campaign to begin</h3><p>Save a campaign draft and configure persona judges here when you are ready to run a wave.</p></div>
      )}
      {error && <div className="alert alert-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={onRetry}>Retry</button></div>}
      {loading ? <LoadingState label="Loading experiments…" /> : campaign && <ExperimentResults key={`results-${campaign.id}`} experiments={details?.experiments ?? []} variants={details?.variants ?? []} metrics={metrics} currentExperimentId={details?.wave?.experimentId ?? null} />}
    </div>
  );
}

function RecordsView({
  title, description, icon, loading, error, onRetry, hasCampaign, emptyTitle, emptyBody, items, kind,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  loading: boolean;
  error: string;
  onRetry: () => void;
  hasCampaign: boolean;
  emptyTitle: string;
  emptyBody: string;
  items: Experiment[] | Lesson[];
  kind: 'experiment' | 'lesson';
}) {
  return (
    <section className="records-view">
      <div className="page-title-row"><span className="page-icon">{icon}</span><div><span className="section-kicker">CAMPAIGN NOTEBOOK</span><h2>{title}</h2><p>{description}</p></div></div>
      {error && <div className="alert alert-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={onRetry}>Retry</button></div>}
      {loading && <LoadingState label={`Loading ${title.toLowerCase()}…`} />}
      {!loading && items.length === 0 && <div className="empty-records"><span className="empty-record-icon">{kind === 'experiment' ? <FlaskConical size={20} /> : <BookOpen size={20} />}</span><h3>{hasCampaign ? emptyTitle : 'Choose a campaign to begin'}</h3><p>{hasCampaign ? emptyBody : 'Save a campaign draft and its experiments and lessons will appear here when they exist.'}</p></div>}
      {items.length > 0 && <div className="record-list">{items.map((item) => <article className="record-card" key={item.id}>
        {kind === 'experiment' && 'hypothesis' in item ? <><div className="record-card-title"><div><span className="section-kicker">EXPERIMENT</span><h3>{item.hypothesis}</h3></div><span className="record-status">{humanizeStatus(item.status)}</span></div><div className="record-meta"><span>{item.variantIds.length} {item.variantIds.length === 1 ? 'version' : 'versions'}</span><span>Created {displayTime(item.createdAt) ?? '—'}</span></div></> : 'statement' in item ? <><div className="record-card-title"><div><span className="section-kicker">LEARNING</span><h3>{item.statement}</h3></div><span className="record-status">{humanizeStatus(item.status)}</span></div><p className="record-description"><strong>Audience:</strong> {item.audience} <span>·</span> <strong>Offer:</strong> {item.offer}</p><div className="record-meta"><span>{item.evidenceIds.length} evidence {item.evidenceIds.length === 1 ? 'item' : 'items'}</span><span>Created {displayTime(item.createdAt) ?? '—'}</span></div></> : null}
      </article>)}</div>}
    </section>
  );
}

function ConnectionsView({ integrations, loading, error, onRetry }: { integrations: IntegrationStatus[]; loading: boolean; error: string; onRetry: () => void }) {
  return (
    <section className="records-view connections-view">
      <div className="page-title-row"><span className="page-icon"><Settings2 size={19} /></span><div><span className="section-kicker">CONFIGURATION</span><h2>Connections</h2><p>Configuration status for services used by the campaign workspace.</p></div></div>
      <div className="connection-note"><CircleHelp size={16} /><span>Status reflects local configuration only. Riff does not probe provider accounts.</span></div>
      {error && <div className="alert alert-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={onRetry}>Retry</button></div>}
      {loading && <LoadingState label="Loading connection status…" />}
      {!loading && integrations.length === 0 && !error && <div className="empty-records"><span className="empty-record-icon"><Settings2 size={20} /></span><h3>No connection metadata returned</h3><p>Connection details are not available right now.</p></div>}
      {!loading && integrations.length > 0 && <div className="connection-grid">{integrations.map((integration) => <IntegrationCard key={integration.id} integration={integration} />)}</div>}
    </section>
  );
}

function IntegrationCard({ integration }: { integration: IntegrationStatus }) {
  const [expanded, setExpanded] = useState(false);
  const stateLabel = integration.status === 'configured' ? 'Configured' : integration.status === 'invalid' ? 'Needs attention' : 'Not configured';
  return (
    <article className="connection-card">
      <div className="connection-card-head"><span className="connection-mark"><Leaf size={18} /></span><span className={`connection-state connection-${integration.status}`}><span className="status-dot" />{stateLabel}</span></div>
      <span className="section-kicker">{integration.purpose}</span>
      <h3>{integration.name}</h3>
      <p>{integrationSummary(integration)}</p>
      <div className="connection-provider">Provider <strong>{integration.provider}</strong></div>
      {integration.missing.length > 0 && <div className="connection-details"><button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Hide missing settings' : 'View missing settings'} <ChevronDown size={15} className={expanded ? 'chevron-up' : ''} /></button>{expanded && <ul>{integration.missing.map((setting) => <li key={setting}><code>{setting}</code></li>)}</ul>}</div>}
    </article>
  );
}

function integrationSummary(integration: IntegrationStatus): string {
  if (integration.status === 'configured') return 'Configuration is present. This view does not verify connectivity.';
  if (integration.status === 'invalid') return 'One or more local settings need attention.';
  return 'Some required local settings are not present.';
}

function CreateCampaignDialog({ onClose, onSubmit, saving, error }: { onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstInputRef.current?.focus();
    return () => { if (openerRef.current?.isConnected) openerRef.current.focus(); };
  }, []);
  function trapKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); if (!saving) onClose(); return; }
    if (event.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-title" aria-describedby="create-description" ref={dialogRef} onKeyDown={trapKeys} tabIndex={-1}>
        <div className="modal-heading"><div><span className="section-kicker">NEW CAMPAIGN</span><h2 id="create-title">Create a campaign draft</h2><p id="create-description">Add the brief details you want to keep with this campaign.</p></div><button type="button" className="icon-button modal-close" onClick={onClose} disabled={saving} aria-label="Close dialog"><X size={18} /></button></div>
        <form onSubmit={onSubmit} className="campaign-form">
          <label className="field"><span>Campaign name <b aria-hidden="true">*</b></span><input ref={firstInputRef} name="name" autoComplete="off" maxLength={120} required placeholder="e.g. Spring refill launch" /></label>
          <label className="field"><span>Product <b aria-hidden="true">*</b></span><input name="product" autoComplete="off" maxLength={300} required placeholder="What are you promoting?" /></label>
          <label className="field"><span>Target audience <b aria-hidden="true">*</b></span><textarea name="audience" rows={2} maxLength={500} required placeholder="Who should this campaign reach?" /></label>
          <label className="field"><span>Approved claims <small>One per line</small></span><textarea name="approvedClaims" rows={3} maxLength={16000} placeholder="Only claims your team has approved" /></label>
          <label className="field"><span>Demo budget <small>USD</small></span><div className="money-input"><span aria-hidden="true">$</span><input name="budget" type="number" min="0.01" step="0.01" required inputMode="decimal" placeholder="500.00" aria-label="Demo budget in US dollars" /></div><small className="field-help">This value is saved for planning. No spend is started.</small></label>
          {error && <div className="alert alert-error form-error" role="alert"><span>{error}</span></div>}
          <div className="form-note"><Check size={15} /> Saving stores a draft. It does not generate creatives or start traffic.</div>
          <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="button button-primary" disabled={saving}>{saving ? <><LoaderCircle size={16} className="spin" /> Saving…</> : <><Check size={16} /> Save draft</>}</button></div>
        </form>
      </div>
    </div>
  );
}

function InfoDrawer({
  drawer, onClose, campaign, metrics, metricsLoading, metricsError, integrations, integrationsLoading, integrationsError,
  onRetryMetrics, onRetryIntegrations, onConnections,
}: {
  drawer: Exclude<Drawer, null>;
  onClose: () => void;
  campaign: Campaign | null;
  metrics: MetricsSnapshot | null;
  metricsLoading: boolean;
  metricsError: string;
  integrations: IntegrationStatus[];
  integrationsLoading: boolean;
  integrationsError: string;
  onRetryMetrics: () => void;
  onRetryIntegrations: () => void;
  onConnections: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    return () => { if (openerRef.current?.isConnected) openerRef.current.focus(); };
  }, []);
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="info-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="drawer-heading"><div><span className="section-kicker">{drawer === 'metrics' ? 'CAMPAIGN DATA' : 'WORKSPACE SETUP'}</span><h2 id="drawer-title">{drawer === 'metrics' ? 'All metrics' : 'Setup status'}</h2></div><button type="button" className="icon-button" aria-label="Close panel" onClick={onClose}><X size={18} /></button></div>
        {drawer === 'metrics' ? <MetricsDetails campaign={campaign} metrics={metrics} loading={metricsLoading} error={metricsError} onRetry={onRetryMetrics} /> : <SetupDetails integrations={integrations} loading={integrationsLoading} error={integrationsError} onRetry={onRetryIntegrations} onConnections={onConnections} />}
      </aside>
    </div>
  );
}

function MetricsDetails({ campaign, metrics, loading, error, onRetry }: { campaign: Campaign | null; metrics: MetricsSnapshot | null; loading: boolean; error: string; onRetry: () => void }) {
  const totals = metrics?.totals;
  const derived = totals ? {
    clickRate: totals.impressions ? totals.clicks / totals.impressions : null,
    signupPerClick: totals.clicks ? totals.signups / totals.clicks : null,
    signupPerImpression: totals.impressions ? totals.signups / totals.impressions : null,
    costPerClickCents: totals.clicks ? totals.spendCents / totals.clicks : null,
    costPerSignupCents: totals.signups ? totals.spendCents / totals.signups : null,
  } : null;
  return (
    <div className="drawer-body">
      <p className="drawer-intro">{campaign ? `Current totals for ${campaign.name}.` : 'Select a campaign to see its metrics.'} Rates and costs show a dash when there is no outcome to calculate.</p>
      {error && <div className="alert alert-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={onRetry}>Retry</button></div>}
      {loading && <LoadingState label="Loading metrics…" />}
      {!loading && metrics && <>
        <div className="metric-detail-status"><span className="status-pill"><span className="status-dot" />{humanizeStatus(metrics.status)}</span><span>{displayTime(metrics.updatedAt) ? `Updated ${displayTime(metrics.updatedAt)}` : 'No update time available'}</span></div>
        <div className="detail-metric-grid">
          <DetailMetric label="Ad views" value={count(totals?.impressions)} />
          <DetailMetric label="Unique visitors" value={count(totals?.uniqueVisitors)} />
          <DetailMetric label="Clicks" value={count(totals?.clicks)} />
          <DetailMetric label="Sign-ups" value={count(totals?.signups)} />
          <DetailMetric label="Simulated spend" value={money(totals?.spendCents)} />
          <DetailMetric label="Budget" value={campaign ? money(campaign.budgetCents) : '—'} />
          <DetailMetric label="Click rate" value={percent(derived?.clickRate)} />
          <DetailMetric label="Sign-ups / clicks" value={percent(derived?.signupPerClick)} />
          <DetailMetric label="Sign-ups / views" value={percent(derived?.signupPerImpression)} />
          <DetailMetric label="Cost per click" value={money(derived?.costPerClickCents)} />
          <DetailMetric label="Cost per sign-up" value={money(derived?.costPerSignupCents)} />
          <DetailMetric label="Median decide time" value={metrics.decideTimeMedianMs != null ? `${Math.round(metrics.decideTimeMedianMs)} ms` : '—'} />
          <DetailMetric label="p90 decide time" value={metrics.decideTimeP90Ms != null ? `${Math.round(metrics.decideTimeP90Ms)} ms` : '—'} />
        </div>
        <p className="metrics-message">{metrics.message}</p>
        <p className="metrics-source">Analytics source: <strong>{humanizeStatus(metrics.source)}</strong></p>
      </>}
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return <div className="detail-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function SetupDetails({ integrations, loading, error, onRetry, onConnections }: { integrations: IntegrationStatus[]; loading: boolean; error: string; onRetry: () => void; onConnections: () => void }) {
  return (
    <div className="drawer-body setup-body">
      <div className="setup-intro"><span className="setup-icon"><Sprout size={20} /></span><div><h3>Configuration, at a glance</h3><p>These statuses describe local settings. They do not verify account access.</p></div></div>
      {error && <div className="alert alert-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={onRetry}>Retry</button></div>}
      {loading && <LoadingState label="Loading connection status…" />}
      {!loading && integrations.length > 0 && <div className="setup-list">{integrations.map((integration) => <SetupRow key={integration.id} integration={integration} />)}</div>}
      {!loading && integrations.length === 0 && !error && <p className="muted-copy">No connection metadata is available.</p>}
      <div className="setup-footer"><p>Manage local provider settings in the environment file. Secret values are never shown in the dashboard.</p><button type="button" className="button button-secondary" onClick={onConnections}>View connections <ArrowRight size={15} /></button></div>
    </div>
  );
}

function SetupRow({ integration }: { integration: IntegrationStatus }) {
  const [open, setOpen] = useState(false);
  const configured = integration.status === 'configured';
  return <article className="setup-row"><div className="setup-row-top"><span className="setup-row-icon"><Leaf size={16} /></span><div className="setup-row-name"><strong>{integration.name}</strong><span>{integration.purpose}</span></div><span className={`connection-state connection-${integration.status}`}>{configured ? <Check size={13} /> : null}{configured ? 'Configured' : integration.status === 'invalid' ? 'Needs attention' : 'Not configured'}</span></div><p>{integration.message}</p>{integration.missing.length > 0 && <><button className="text-button missing-toggle" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Hide missing settings' : `Missing settings (${integration.missing.length})`} <ChevronDown size={14} className={open ? 'chevron-up' : ''} /></button>{open && <ul className="missing-list">{integration.missing.map((setting) => <li key={setting}><code>{setting}</code></li>)}</ul>}</>}</article>;
}
