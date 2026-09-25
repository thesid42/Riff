import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Eye, ImagePlus, LoaderCircle, Play, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import type { Campaign } from '../shared/types.js';
import type { CreativeImageJob, CreativeVideoOptions } from '../shared/creative.js';
import CreativeMediaViewer from './CreativeMediaViewer.js';

type CreativeMediaType = 'image' | 'video';
interface CreativeCapabilities { image: boolean; video: boolean }

interface ExperimentDecision {
  action: 'wait' | 'propose_test';
  explanation: string;
  hypothesis: string;
  headlines: string[];
  evidenceIds: string[];
}

interface PlanMetadata {
  model?: string;
  elapsedMs?: number;
}

interface ComposerState {
  loadStatus: 'loading' | 'ready' | 'error';
  loadError: string;
  imagePromptSuggestion: string;
  imagePrompt: string;
  promptEdited: boolean;
  jobs: CreativeImageJob[];
  capabilities: CreativeCapabilities;
  mediaType: CreativeMediaType;
  videoOptions: CreativeVideoOptions;
  planLoading: boolean;
  planError: string;
  decision: ExperimentDecision | null;
  metadata: PlanMetadata | null;
  headlines: string[];
  generationLoading: boolean;
  generationError: string;
  reloadVersion: number;
  manualEditing: boolean;
}

const EMPTY_STATE: ComposerState = {
  loadStatus: 'loading', loadError: '', imagePromptSuggestion: '', imagePrompt: '', promptEdited: false,
  jobs: [], capabilities: { image: true, video: false }, mediaType: 'image',
  videoOptions: { durationSeconds: 5, resolution: 'hd', aspectRatio: '1:1', generateAudio: false, draft: true },
  planLoading: false, planError: '', decision: null, metadata: null, headlines: [],
  generationLoading: false, generationError: '', reloadVersion: 0, manualEditing: false,
};

interface ApiError extends Error { status?: number }

async function readJson<T>(response: Response): Promise<T> {
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

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(url, { signal, headers: { Accept: 'application/json' } }));
}

async function postJson<T>(url: string, value: unknown, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(url, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  }));
}

function parseDecision(value: unknown): ExperimentDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Liquid returned an invalid response. Try again.');
  const decision = value as Partial<ExperimentDecision>;
  if (decision.action !== 'wait' && decision.action !== 'propose_test') throw new Error('Liquid returned an invalid response. Try again.');
  if (typeof decision.explanation !== 'string' || typeof decision.hypothesis !== 'string' ||
      !Array.isArray(decision.headlines) || !decision.headlines.every((item) => typeof item === 'string') ||
      !Array.isArray(decision.evidenceIds) || !decision.evidenceIds.every((item) => typeof item === 'string')) {
    throw new Error('Liquid returned an incomplete response. Try again.');
  }
  if (decision.action === 'wait') {
    if (decision.hypothesis !== '' || decision.headlines.length !== 0) throw new Error('Liquid returned an invalid wait recommendation. Try again.');
  } else {
    const headlines = decision.headlines.map((line) => line.trim());
    if (headlines.length < 2 || headlines.length > 3 || headlines.some((line) => !line || line.length > 120) ||
        new Set(headlines.map((line) => line.toLocaleLowerCase())).size !== headlines.length || decision.hypothesis.trim().length < 10) {
      throw new Error('Liquid returned unusable headline suggestions. Review the brief and try again.');
    }
    decision.headlines = headlines;
  }
  return decision as ExperimentDecision;
}

function isCreativeJob(value: unknown, campaignId: string): value is CreativeImageJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Partial<CreativeImageJob>;
  return job.campaignId === campaignId && typeof job.id === 'string' && Array.isArray(job.headlines) &&
    typeof job.imagePrompt === 'string' && ['submitting', 'generating', 'ready', 'failed', 'uncertain'].includes(job.status ?? '') &&
    (job.mediaType === 'image' || job.mediaType === 'video') &&
    (job.imageUrl === null || typeof job.imageUrl === 'string') && (job.error === null || typeof job.error === 'string') &&
    (job.videoUrl === null || typeof job.videoUrl === 'string') &&
    (job.videoOptions === null || (typeof job.videoOptions === 'object' && job.videoOptions !== null)) &&
    typeof job.createdAt === 'string' && typeof job.updatedAt === 'string';
}

function sameVideoOptions(first: CreativeVideoOptions | null, second: CreativeVideoOptions): boolean {
  return first != null && first.durationSeconds === second.durationSeconds && first.resolution === second.resolution &&
    first.aspectRatio === second.aspectRatio && first.generateAudio === second.generateAudio && first.draft === second.draft;
}

function draftFingerprint(headlines: string[], imagePrompt: string, mediaType: CreativeMediaType, videoOptions: CreativeVideoOptions): string {
  const text = JSON.stringify([headlines.map((line) => line.trim()), imagePrompt.trim(), mediaType, mediaType === 'video' ? videoOptions : null]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

interface StoredRequest { fingerprint: string; requestId: string }
interface ViewerItem { kind: 'image' | 'video'; src: string; title: string; alt: string }

function requestStorageKey(campaignId: string): string {
  return `riff:creative-request:${campaignId}`;
}

function storedRequest(campaignId: string, fingerprint: string): StoredRequest | null {
  try {
    const value = localStorage.getItem(requestStorageKey(campaignId));
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !('fingerprint' in parsed) || !('requestId' in parsed) ||
        parsed.fingerprint !== fingerprint || typeof parsed.requestId !== 'string') return null;
    return { fingerprint, requestId: parsed.requestId };
  } catch { return null; }
}

function createOrReuseRequestId(campaignId: string, fingerprint: string): string {
  const existing = storedRequest(campaignId, fingerprint);
  if (existing) return existing.requestId;
  const requestId = crypto.randomUUID();
  try { localStorage.setItem(requestStorageKey(campaignId), JSON.stringify({ fingerprint, requestId })); } catch { /* The in-memory request still has a stable id for this attempt. */ }
  return requestId;
}

function clearStoredRequest(campaignId: string, fingerprint: string, requestId: string): void {
  const existing = storedRequest(campaignId, fingerprint);
  if (existing?.requestId === requestId) {
    try { localStorage.removeItem(requestStorageKey(campaignId)); } catch { /* A retained key remains safe to reuse. */ }
  }
}

function sameDraft(job: CreativeImageJob, headlines: string[], imagePrompt: string, mediaType: CreativeMediaType, videoOptions: CreativeVideoOptions): boolean {
  return job.mediaType === mediaType && (mediaType === 'image' || sameVideoOptions(job.videoOptions, videoOptions)) &&
    job.imagePrompt.trim() === imagePrompt.trim() && job.headlines.length === headlines.length &&
    job.headlines.every((headline, index) => headline.trim() === headlines[index]?.trim());
}

function variantLabel(index: number): string { return String.fromCharCode(65 + index); }

export default function CreativeComposer({ campaign, onHeadlinesChange }: { campaign: Campaign; onHeadlinesChange?: (headlines: string[]) => void }) {
  const [campaignStates, setCampaignStates] = useState<Record<string, ComposerState>>({});
  const [viewer, setViewer] = useState<ViewerItem | null>(null);
  const planControllers = useRef(new Map<string, AbortController>());
  const state = campaignStates[campaign.id] ?? EMPTY_STATE;
  const updateCampaign = (campaignId: string, update: (current: ComposerState) => ComposerState) => {
    setCampaignStates((previous) => ({ ...previous, [campaignId]: update(previous[campaignId] ?? EMPTY_STATE) }));
  };

  useEffect(() => { setViewer(null); }, [campaign.id]);

  useEffect(() => {
    const campaignId = campaign.id;
    const controller = new AbortController();
    updateCampaign(campaignId, (current) => ({ ...current, loadStatus: 'loading', loadError: '' }));
    getJson<{ imagePromptSuggestion: string; jobs: CreativeImageJob[]; capabilities?: Partial<CreativeCapabilities>; headlines?: string[] }>(`/api/campaigns/${encodeURIComponent(campaignId)}/creative`, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (typeof result?.imagePromptSuggestion !== 'string' || !Array.isArray(result.jobs)) throw new Error('Creative settings could not be read.');
        const jobs = result.jobs.filter((job) => isCreativeJob(job, campaignId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const headlines = Array.isArray(result.headlines) ? result.headlines.filter((item) => typeof item === 'string') : [];
        updateCampaign(campaignId, (current) => ({
          ...current,
          loadStatus: 'ready',
          loadError: '',
          imagePromptSuggestion: result.imagePromptSuggestion,
          imagePrompt: current.promptEdited ? current.imagePrompt : result.imagePromptSuggestion,
          jobs,
          headlines: current.headlines.length >= 2 ? current.headlines : headlines,
          manualEditing: current.manualEditing || (current.headlines.length < 2 && headlines.length >= 2),
          capabilities: { image: result.capabilities?.image !== false, video: result.capabilities?.video === true },
        }));
        if (headlines.length >= 2) onHeadlinesChange?.(headlines);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) updateCampaign(campaignId, (current) => ({ ...current, loadStatus: 'error', loadError: error instanceof Error ? error.message : 'Creative drafts could not be loaded.' }));
      });
    return () => {
      controller.abort();
      const planController = planControllers.current.get(campaignId);
      planController?.abort();
      planControllers.current.delete(campaignId);
      if (planController) updateCampaign(campaignId, (current) => ({ ...current, planLoading: false }));
    };
  }, [campaign.id]);

  const fingerprint = useMemo(() => draftFingerprint(state.headlines, state.imagePrompt, state.mediaType, state.videoOptions), [state.headlines, state.imagePrompt, state.mediaType, state.videoOptions]);
  const matchingJob = state.jobs.find((job) => sameDraft(job, state.headlines, state.imagePrompt, state.mediaType, state.videoOptions));
  const activeJob = state.jobs.find((job) => job.status === 'submitting' || job.status === 'generating');
  const uncertainOtherJob = state.jobs.find((job) => job.status === 'uncertain' && !sameDraft(job, state.headlines, state.imagePrompt, state.mediaType, state.videoOptions));
  const sameDraftComplete = matchingJob?.status === 'ready';
  const headlinesValid = state.headlines.length >= 2 && state.headlines.length <= 3 &&
    state.headlines.every((headline) => headline.trim().length > 0 && headline.trim().length <= 120) &&
    new Set(state.headlines.map((headline) => headline.trim().toLocaleLowerCase())).size === state.headlines.length;
  const promptValid = state.imagePrompt.trim().length > 0 && state.imagePrompt.trim().length <= 4_000;
  const decisionReady = state.decision?.action === 'propose_test' || state.manualEditing;
  const unresolvedForDraft = matchingJob && (matchingJob.status === 'uncertain' || matchingJob.status === 'failed') && !storedRequest(campaign.id, fingerprint);
  const mediaAvailable = state.capabilities[state.mediaType];
  const videoOptionsValid = state.mediaType !== 'video' || !state.videoOptions.draft || state.videoOptions.resolution === 'hd';
  const canGenerate = decisionReady && headlinesValid && promptValid && videoOptionsValid && mediaAvailable && !state.generationLoading && !state.planLoading &&
    state.loadStatus === 'ready' && !activeJob && !uncertainOtherJob && !sameDraftComplete && !unresolvedForDraft;

  async function suggestHeadlines() {
    planControllers.current.get(campaign.id)?.abort();
    const controller = new AbortController();
    planControllers.current.set(campaign.id, controller);
    updateCampaign(campaign.id, (current) => ({ ...current, planLoading: true, planError: '', decision: null, metadata: null, headlines: [], manualEditing: false }));
    try {
      const result = await postJson<{ decision: unknown; metadata?: PlanMetadata }>(`/api/campaigns/${encodeURIComponent(campaign.id)}/creative/plan`, {}, controller.signal);
      if (controller.signal.aborted) return;
      const decision = parseDecision(result?.decision);
      updateCampaign(campaign.id, (current) => ({
        ...current,
        planLoading: false,
        planError: '',
        decision,
        metadata: result.metadata && typeof result.metadata === 'object' ? result.metadata : null,
        headlines: decision.action === 'propose_test' ? decision.headlines : [],
        manualEditing: false,
      }));
      if (decision.action === 'propose_test') onHeadlinesChange?.(decision.headlines);
    } catch (error) {
      if (!controller.signal.aborted) updateCampaign(campaign.id, (current) => ({ ...current, planLoading: false, planError: error instanceof Error ? error.message : 'Headline suggestions could not be loaded.' }));
    } finally {
      if (planControllers.current.get(campaign.id) === controller) planControllers.current.delete(campaign.id);
    }
  }

  async function refreshJobs() {
    const campaignId = campaign.id;
    const controller = new AbortController();
    updateCampaign(campaignId, (current) => ({ ...current, loadStatus: 'loading', loadError: '' }));
    try {
    const result = await getJson<{ imagePromptSuggestion: string; jobs: CreativeImageJob[]; capabilities?: Partial<CreativeCapabilities> }>(`/api/campaigns/${encodeURIComponent(campaignId)}/creative`, controller.signal);
      if (typeof result?.imagePromptSuggestion !== 'string' || !Array.isArray(result.jobs)) throw new Error('Creative settings could not be read.');
      const jobs = result.jobs.filter((job) => isCreativeJob(job, campaignId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      updateCampaign(campaignId, (current) => ({ ...current, loadStatus: 'ready', loadError: '', imagePromptSuggestion: result.imagePromptSuggestion, imagePrompt: current.promptEdited ? current.imagePrompt : result.imagePromptSuggestion, jobs, capabilities: { image: result.capabilities?.image !== false, video: result.capabilities?.video === true } }));
    } catch (error) {
      updateCampaign(campaignId, (current) => ({ ...current, loadStatus: 'error', loadError: error instanceof Error ? error.message : 'Creative drafts could not be loaded.' }));
    }
  }

  async function generateImage() {
    if (!canGenerate) return;
    const campaignId = campaign.id;
    const headlines = state.headlines.map((headline) => headline.trim());
    const imagePrompt = state.imagePrompt.trim();
    const mediaType = state.mediaType;
    const requestFingerprint = draftFingerprint(headlines, imagePrompt, mediaType, state.videoOptions);
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      updateCampaign(campaignId, (current) => ({ ...current, generationError: 'This browser cannot create a secure request ID.' }));
      return;
    }
    const requestId = createOrReuseRequestId(campaignId, requestFingerprint);
    updateCampaign(campaignId, (current) => ({ ...current, generationLoading: true, generationError: '' }));
    try {
      const path = mediaType === 'video' ? 'videos' : 'images';
      const body = mediaType === 'video' ? { requestId, headlines, imagePrompt, videoOptions: state.videoOptions } : { requestId, headlines, imagePrompt };
      const result = await postJson<{ job: CreativeImageJob }>(`/api/campaigns/${encodeURIComponent(campaignId)}/creative/${path}`, body);
      if (!isCreativeJob(result?.job, campaignId)) throw new Error('The creative request returned an invalid job. Refresh saved drafts before trying again.');
      updateCampaign(campaignId, (current) => ({
        ...current,
        generationLoading: false,
        generationError: result.job.error ?? '',
        jobs: [result.job, ...current.jobs.filter((job) => job.id !== result.job.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }));
      if (result.job.status === 'ready') clearStoredRequest(campaignId, requestFingerprint, requestId);
    } catch (error) {
      updateCampaign(campaignId, (current) => ({ ...current, generationLoading: false, generationError: error instanceof Error ? error.message : 'The creative request did not return a result. Reuse the same request to check its status.' }));
    }
  }

  function updateHeadline(index: number, value: string) {
    updateCampaign(campaign.id, (current) => {
      const headlines = current.headlines.map((headline, currentIndex) => currentIndex === index ? value : headline);
      onHeadlinesChange?.(headlines);
      return { ...current, generationError: '', headlines };
    });
  }

  function updatePrompt(value: string) {
    updateCampaign(campaign.id, (current) => ({ ...current, generationError: '', imagePrompt: value, promptEdited: true }));
  }

  const addHeadline = () => updateCampaign(campaign.id, (current) => {
    if (current.headlines.length >= 3) return current;
    const headlines = [...current.headlines, ''];
    onHeadlinesChange?.(headlines);
    return { ...current, headlines };
  });
  const removeHeadline = (index: number) => updateCampaign(campaign.id, (current) => {
    if (current.headlines.length <= 2) return current;
    const headlines = current.headlines.filter((_, currentIndex) => currentIndex !== index);
    onHeadlinesChange?.(headlines);
    return { ...current, headlines };
  });
  const mediaWord = state.mediaType === 'video' ? 'video' : 'image';
  const activeRequestMessage = state.generationLoading ? `Generating a campaign ${mediaWord} draft. This can take up to ${state.mediaType === 'video' ? 'five' : 'two'} minutes; reload saved jobs later to check its status.` :
    activeJob ? 'A creative request is still in progress for this campaign. Refresh saved jobs to check its status.' :
    uncertainOtherJob ? 'Another creative request has an uncertain result. Check saved jobs before starting a new visual draft.' :
    matchingJob?.status === 'uncertain' ? 'This request has an uncertain outcome. A manual retry will reuse the same request ID.' :
    matchingJob?.status === 'failed' ? 'This attempt failed. A manual retry will reuse the same request ID; edit the direction or copy to start a distinct draft.' :
    sameDraftComplete ? 'This exact creative draft is already saved. Edit a headline or visual direction to create a new draft.' : '';

  return (
    <section className="composer-panel" aria-labelledby="composer-title">
      <header className="composer-heading">
        <div>
          <span className="section-kicker">CREATIVE DRAFTS</span>
          <h2 id="composer-title">Build a creative concept</h2>
          <p>Review the copy and visual direction before making a paid creative request.</p>
        </div>
        <button className="button button-secondary composer-refresh" type="button" onClick={() => void refreshJobs()} disabled={state.loadStatus === 'loading'}>
          {state.loadStatus === 'loading' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Reload saved jobs
        </button>
      </header>

      {state.loadError && <div className="alert alert-error composer-alert" role="alert"><span>{state.loadError}</span><button className="text-button" type="button" onClick={() => void refreshJobs()}>Retry</button></div>}

      <div className="composer-grid">
        <div className="composer-form">
          <label className="composer-field media-type-field" htmlFor="creative-media-type"><span><b>Creative type</b></span>
            <select id="creative-media-type" value={state.mediaType} onChange={(event) => updateCampaign(campaign.id, (current) => ({ ...current, mediaType: event.target.value as CreativeMediaType, generationError: '' }))} disabled={state.generationLoading}>
              <option value="image" disabled={!state.capabilities.image}>Image</option>
              <option value="video" disabled={!state.capabilities.video}>Video</option>
            </select>
            {!state.capabilities.video && <small>Enable video in server configuration to use this option.</small>}
          </label>
          <div className="composer-step"><span>1</span><div><strong>Suggest and review headlines</strong><small>Suggestions use this saved campaign brief through Liquid.</small></div></div>
          <button className="button button-secondary" type="button" onClick={() => void suggestHeadlines()} disabled={state.planLoading || state.generationLoading || state.loadStatus !== 'ready'}>
            {state.planLoading ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} {state.planLoading ? 'Reviewing brief…' : 'Suggest headlines'}
          </button>
          {!decisionReady && <button className="composer-manual-button" type="button" onClick={() => updateCampaign(campaign.id, (current) => ({ ...current, planError: '', decision: null, headlines: ['', ''], manualEditing: true }))} disabled={state.generationLoading || state.loadStatus !== 'ready'}>Write headlines manually</button>}
          {state.planError && <div className="composer-error" role="alert"><AlertCircle size={15} /><span>{state.planError}</span></div>}
          {state.decision && <div className={`decision-note ${state.decision.action === 'wait' ? 'decision-wait' : ''}`} role="status">
            <strong>{state.decision.action === 'wait' ? 'Liquid recommends waiting' : 'Review these headline drafts'}</strong>
            {state.decision.explanation && <p>{state.decision.explanation}</p>}
            {state.decision.hypothesis && <small>Hypothesis · {state.decision.hypothesis}</small>}
            {state.metadata?.model && <small className="decision-meta">{state.metadata.model}{state.metadata.elapsedMs != null ? ` · ${Math.round(state.metadata.elapsedMs)} ms` : ''}</small>}
          </div>}

          {(state.decision?.action === 'propose_test' || state.manualEditing) && <div className="headline-editor" aria-label="Editable headline drafts">
            {state.headlines.map((headline, index) => <label className="composer-field" key={index}>
              <span><b>Version {variantLabel(index)}</b><small>{headline.trim().length}/120</small></span>
              <div className="headline-input-row">
                <input value={headline} maxLength={120} onChange={(event) => updateHeadline(index, event.target.value)} aria-label={`Version ${variantLabel(index)} headline`} />
                {state.headlines.length > 2 && <button type="button" className="icon-button composer-remove" aria-label={`Remove version ${variantLabel(index)}`} onClick={() => removeHeadline(index)}><X size={15} /></button>}
              </div>
            </label>)}
            {state.headlines.length < 3 && <button className="composer-add" type="button" onClick={addHeadline}><Plus size={14} /> Add another headline</button>}
          </div>}
          {state.manualEditing && <p className="composer-guidance" role="note">Manual draft — these headlines were not reviewed by Liquid. Keep them within the approved claims saved on this campaign: {campaign.approvedClaims.length ? campaign.approvedClaims.join(' · ') : 'no approved claims are saved; avoid product claims.'}</p>}

          <div className="composer-divider" />
          <div className="composer-step"><span>2</span><div><strong>Review {state.mediaType === 'video' ? 'video' : 'image'} direction</strong><small>BFL may interpret or expand this direction. The result is a draft concept, not a quality guarantee.</small></div></div>
          <label className="composer-field" htmlFor="creative-image-prompt"><span><b>Visual direction</b><small>{state.imagePrompt.length}/4000</small></span>
            <textarea id="creative-image-prompt" value={state.imagePrompt} maxLength={4000} rows={4} onChange={(event) => updatePrompt(event.target.value)} placeholder={state.loadStatus === 'loading' ? 'Loading campaign-grounded suggestion…' : 'Add a visual direction'} disabled={state.loadStatus !== 'ready' || state.generationLoading} />
          </label>
          {state.mediaType === 'video' && state.capabilities.video && <div className="video-options">
            <label className="composer-field"><span><b>Duration</b></span><input aria-label="Video duration in seconds" type="number" min={5} max={20} value={state.videoOptions.durationSeconds} onChange={(event) => updateCampaign(campaign.id, (current) => ({ ...current, videoOptions: { ...current.videoOptions, durationSeconds: Math.max(5, Math.min(20, Number(event.target.value) || 5)) }, generationError: '' }))} /></label>
            <label className="composer-field"><span><b>Resolution</b></span><select aria-label="Video resolution" value={state.videoOptions.resolution} onChange={(event) => updateCampaign(campaign.id, (current) => ({ ...current, videoOptions: { ...current.videoOptions, resolution: event.target.value as 'hd' | 'fhd', draft: event.target.value === 'fhd' ? false : current.videoOptions.draft }, generationError: '' }))}><option value="hd">HD</option><option value="fhd">Full HD</option></select></label>
            <label className="composer-field"><span><b>Aspect ratio</b></span><select aria-label="Video aspect ratio" value={state.videoOptions.aspectRatio} onChange={(event) => updateCampaign(campaign.id, (current) => ({ ...current, videoOptions: { ...current.videoOptions, aspectRatio: event.target.value as CreativeVideoOptions['aspectRatio'] }, generationError: '' }))}><option value="1:1">Square · 1:1</option><option value="16:9">Landscape · 16:9</option><option value="9:16">Portrait · 9:16</option></select></label>
            <label className="video-check"><input type="checkbox" checked={state.videoOptions.generateAudio} onChange={(event) => updateCampaign(campaign.id, (current) => ({ ...current, videoOptions: { ...current.videoOptions, generateAudio: event.target.checked }, generationError: '' }))} /> Generate audio</label>
            <label className="video-check"><input type="checkbox" checked={state.videoOptions.draft} disabled={state.videoOptions.resolution !== 'hd'} onChange={(event) => updateCampaign(campaign.id, (current) => ({ ...current, videoOptions: { ...current.videoOptions, draft: event.target.checked }, generationError: '' }))} /> Draft quality <small>HD only</small></label>
          </div>}
          {(state.generationError || matchingJob?.error) && <div className="composer-error" role="alert"><AlertCircle size={15} /><span>{state.generationError || matchingJob?.error}</span></div>}
          {activeRequestMessage && <p className="composer-status" role="status">{state.generationLoading && <LoaderCircle size={14} className="spin" />}{activeRequestMessage}</p>}
          <div className="composer-actions">
            <button className="button button-primary" type="button" onClick={() => void generateImage()} disabled={!canGenerate}>
              {state.generationLoading ? <LoaderCircle size={16} className="spin" /> : <ImagePlus size={16} />}
              {state.generationLoading ? `Generating ${mediaWord}…` : state.generationError || matchingJob?.status === 'uncertain' || matchingJob?.status === 'failed' ? 'Retry same request' : `Generate ${mediaWord}`}
            </button>
            <span>Uses BFL credits · one {state.mediaType} shared across all headline versions</span>
          </div>
          {!decisionReady && state.decision?.action === 'wait' && <p className="composer-guidance">Headline advice says to wait. No creative request can be made until Liquid suggests a test.</p>}
          {decisionReady && (!headlinesValid || !promptValid) && <p className="composer-guidance">Use 2–3 unique headlines and a non-empty visual direction to continue.</p>}
          {decisionReady && state.headlines.length >= 2 && <p className="composer-guidance">Only the {state.manualEditing ? 'manually entered' : 'reviewed'} copy is sent; the preview uses a fixed “Join the waitlist” call to action.</p>}
        </div>

        <aside className="composer-side-note">
          <span className="composer-side-icon"><ImagePlus size={18} /></span>
          <strong>A reviewable draft, not a live ad</strong>
          <p>Riff saves the generated {state.mediaType} concept with the reviewed headlines. It does not create an ad, publish anything, allocate traffic, or collect analytics.</p>
          <div><ArrowDownToLine size={14} /> Saved jobs can be reopened from this campaign.</div>
        </aside>
      </div>

      {state.jobs.length > 0 && <section className="image-job-list" aria-label="Saved creative drafts">
        <div className="image-job-heading"><h3>Saved creative drafts</h3><span>{state.jobs.length} {state.jobs.length === 1 ? 'job' : 'jobs'}</span></div>
        {state.jobs.map((job) => <article className="image-job" key={job.id}>
          <div className="image-job-top"><div><strong>{job.mediaType === 'video' ? 'Video draft' : 'Image draft'}</strong><span className={`job-status job-${job.status}`}><i />{job.status === 'ready' ? 'Ready' : job.status === 'failed' ? 'Failed' : job.status === 'uncertain' ? 'Outcome uncertain' : 'Generating'}</span></div><time dateTime={job.createdAt}>{formatTime(job.createdAt)}</time></div>
          {job.status === 'ready' ? <div className="image-ad-grid">{job.headlines.map((headline, index) => {
            const kind = job.mediaType;
            const src = kind === 'video' ? job.videoUrl ?? `/api/creative-assets/${encodeURIComponent(job.id)}` : `/api/creative-assets/${encodeURIComponent(job.id)}`;
            const title = `Version ${variantLabel(index)} ${kind} draft`;
            const alt = `${kind === 'video' ? 'Video' : 'Generated image'} draft shared with Version ${variantLabel(index)}`;
            return <article className="image-ad-card" key={`${job.id}-${index}`}>
              <div className="image-ad-label">Version {variantLabel(index)} <span>Draft concept</span></div>
              {kind === 'video' ? <video controls preload="metadata" src={src} aria-label={alt} /> : <img src={src} alt={alt} loading="lazy" />}
              <h4>{headline}</h4><div className="mock-cta">Join the waitlist</div>
              <p>Review before use · same {kind} across versions</p>
              <button className="media-open-button" type="button" aria-label={`${kind === 'video' ? 'Watch video' : 'View image'} for Version ${variantLabel(index)}`} onClick={() => {
                document.querySelectorAll<HTMLVideoElement>('.image-ad-card video').forEach((video) => video.pause());
                setViewer({ kind, src, title, alt });
              }}>{kind === 'video' ? <Play size={13} /> : <Eye size={13} />} {kind === 'video' ? 'Watch video' : 'View image'}</button>
            </article>;
          })}</div> : <div className="job-message">
            {job.status === 'failed' ? job.error || 'This creative request failed. Edit the visual direction or copy to start a distinct draft.' : job.status === 'uncertain' ? job.error || 'The creative service did not confirm whether it completed. Reload saved jobs before starting another draft.' : 'The creative request is still being processed. Reload saved jobs to check again.'}
          </div>}
          <details className="job-direction"><summary>Visual direction</summary><p>{job.imagePrompt}</p></details>
        </article>)}
      </section>}
      {viewer && <CreativeMediaViewer kind={viewer.kind} src={viewer.src} title={viewer.title} alt={viewer.alt} onClose={() => setViewer(null)} />}
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Saved draft';
}
