import { useRef, useState } from 'react';
import { ChevronDown, ExternalLink, FlaskConical } from 'lucide-react';
import type { Experiment, MetricsSnapshot, Variant } from '../shared/types.js';
import CreativeMediaViewer from './CreativeMediaViewer.js';
import './experiment-results.css';

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Date unavailable';
}

export function variantsForExperiment(experiment: Experiment, variants: Variant[]): Variant[] {
  return experiment.variantIds.flatMap((id) => {
    const variant = variants.find((item) => item.id === id && item.campaignId === experiment.campaignId && item.experimentId === experiment.id);
    return variant ? [variant] : [];
  });
}

export default function ExperimentResults({ experiments, variants, metrics, currentExperimentId }: {
  experiments: Experiment[];
  variants: Variant[];
  metrics: MetricsSnapshot | null;
  currentExperimentId: string | null;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const ordered = [...experiments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = currentExperimentId ? ordered.find((item) => item.id === currentExperimentId) : ordered[0];
  const older = latest ? ordered.filter((item) => item.id !== latest.id) : ordered;
  return (
    <section className="experiment-results" aria-labelledby="experiment-results-title">
      <div className="experiment-results-heading">
        <div><span className="section-kicker">RECORDED RESULTS</span><h2 id="experiment-results-title">Latest experiment</h2></div>
        <span className="experiment-simulation-label">Simulated audience · headline test</span>
      </div>
      {latest ? <ExperimentRecord key={latest.id} experiment={latest} variants={variantsForExperiment(latest, variants)} metrics={metrics} /> : (
        <div className="experiment-results-empty"><FlaskConical size={22} /><div><h3>{currentExperimentId ? 'Loading this wave’s versions…' : 'No waves yet'}</h3><p>{currentExperimentId ? 'The saved versions will appear as this wave starts.' : 'Start a wave above to compare how simulated profiles respond to your headlines.'}</p></div></div>
      )}
      {older.length > 0 && <details className="experiment-history" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary><span>Previous experiments <span className="experiment-history-count">{older.length}</span></span><ChevronDown size={17} /></summary>
        {historyOpen && <div className="experiment-history-list">{older.map((experiment) => <ExperimentRecord key={experiment.id} experiment={experiment} variants={variantsForExperiment(experiment, variants)} metrics={null} historical />)}</div>}
      </details>}
    </section>
  );
}

function ExperimentRecord({ experiment, variants, metrics, historical = false }: {
  experiment: Experiment; variants: Variant[]; metrics: MetricsSnapshot | null; historical?: boolean;
}) {
  const [media, setMedia] = useState<{ items: Array<{ id: string; kind: 'image' | 'video'; src: string; title: string }>; index: number } | null>(null);
  const currentMedia = media?.items[media.index];
  const recordRef = useRef<HTMLElement>(null);
  const textOnly = variants.length > 0 && variants.every((variant) => !variant.imageUrl && !variant.videoUrl);
  const matchingMetrics = metrics?.campaignId === experiment.campaignId && metrics.status === 'available' ? metrics : null;
  return <article className="experiment-record" ref={recordRef}>
    <div className="experiment-record-header"><span>{timestamp(experiment.createdAt)}</span><span className="record-status">{experiment.status === 'collecting' ? 'Collecting responses' : experiment.status.charAt(0).toUpperCase() + experiment.status.slice(1)}</span></div>
    <p className="experiment-record-explanation">{textOnly
      ? 'Text-only experiment. No visual was selected when this wave started. Images generated later stay in Campaign.'
      : 'These are the versions saved when the wave started. The simulation evaluates headline copy; attached visuals are for your review.'}</p>
    <div className="experiment-version-grid">{variants.map((variant) => {
      const totals = matchingMetrics?.variants.find((entry) => entry.variantId === variant.id)?.totals;
      const kind = variant.videoUrl ? 'video' : 'image';
      const src = variant.videoUrl ?? variant.imageUrl;
      return <article className="experiment-version" key={variant.id} aria-label={`Version ${variant.label} result`}>
        <div className="experiment-version-title"><span className="version-badge">{variant.label}</span><span>{src ? kind === 'video' ? 'Video attached' : 'Image attached' : 'Text-only version'}</span></div>
        <h3>{variant.headline || 'Untitled version'}</h3>
        {src && <div className="experiment-version-media">
          {kind === 'video' ? <video controls preload="metadata" src={src} aria-label={`Version ${variant.label} video`} /> : <img src={src} alt={`Version ${variant.label} saved visual`} loading="lazy" />}
          <button type="button" className="text-button" onClick={() => {
            recordRef.current?.querySelectorAll('video').forEach((video) => video.pause());
            const items = variants.flatMap((item) => {
              const source = item.videoUrl ?? item.imageUrl;
              return source ? [{ id: item.id, kind: item.videoUrl ? 'video' as const : 'image' as const, src: source, title: `Version ${item.label} · saved visual` }] : [];
            });
            setMedia({ items, index: items.findIndex((item) => item.id === variant.id) });
          }}>{kind === 'video' ? 'Watch video' : 'View image'} <ExternalLink size={14} /></button>
        </div>}
        {!historical && <dl className="experiment-version-metrics">
          <div><dt>Responses</dt><dd>{totals ? totals.impressions.toLocaleString() : '—'}</dd></div>
          <div><dt>Sign-ups</dt><dd>{totals ? totals.signups.toLocaleString() : '—'}</dd></div>
          <div><dt>Sign-up rate</dt><dd>{totals && totals.impressions > 0 ? `${Math.round(totals.signups / totals.impressions * 100)}%` : '—'}</dd></div>
        </dl>}
      </article>;
    })}</div>
    {variants.length === 0 && <p className="experiment-record-explanation">The saved versions are not available yet.</p>}
    {!historical && <p className="experiment-metric-caption">Sign-up rate = simulated sign-ups ÷ responses. These are model predictions, not real ad traffic.</p>}
    <details className="experiment-record-detail"><summary>Experiment details</summary><p>{experiment.hypothesis}</p>{historical && <p>Historical version snapshot. Live metrics are shown only for the latest wave.</p>}</details>
    {media && currentMedia && <CreativeMediaViewer kind={currentMedia.kind} src={currentMedia.src} title={currentMedia.title} alt={currentMedia.title} onClose={() => setMedia(null)} navigation={{
      index: media.index, count: media.items.length,
      onPrevious: () => setMedia((current) => current ? { ...current, index: Math.max(0, current.index - 1) } : null),
      onNext: () => setMedia((current) => current ? { ...current, index: Math.min(current.items.length - 1, current.index + 1) } : null),
    }} />}
  </article>;
}
