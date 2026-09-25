import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Eye, ImagePlus, LoaderCircle, Play, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import type { Campaign } from '../shared/types.js';
import type { CreativeImageJob, CreativeVariantOutput, CreativeVideoOptions } from '../shared/creative.js';
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
  variantPrompts: string[];
  headlinesTouched: boolean;
  generationLoading: boolean;
  generationError: string;
  reloadVersion: number;
  manualEditing: boolean;
}

const EMPTY_STATE: ComposerState = {
  loadStatus: 'loading', loadError: '', imagePromptSuggestion: '', imagePrompt: '', promptEdited: false,
  jobs: [], capabilities: { image: true, video: false }, mediaType: 'image',
  videoOptions: { durationSeconds: 5, resolution: 'hd', aspectRatio: '1:1', generateAudio: false, draft: true },
  planLoading: false, planError: '', decision: null, metadata: null, headlines: [], variantPrompts: [], headlinesTouched: false,
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
    typeof job.createdAt === 'string' && typeof job.updatedAt === 'string' &&
    (job.visualMode === undefined || job.visualMode === 'shared' || job.visualMode === 'distinct') &&
    (job.outputs === undefined || (Array.isArray(job.outputs) && job.outputs.every(isCreativeOutput)));
}

function isCreativeOutput(value: unknown): value is CreativeVariantOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const output = value as Partial<CreativeVariantOutput>;
  return typeof output.id === 'string' && Number.isInteger(output.index) && typeof output.headline === 'string' &&
    typeof output.imagePrompt === 'string' && ['queued', 'submitting', 'generating', 'ready', 'failed', 'uncertain', 'skipped'].includes(output.status ?? '') &&
    (output.imageUrl === null || typeof output.imageUrl === 'string') && (output.videoUrl === null || typeof output.videoUrl === 'string') &&
    (output.error === null || typeof output.error === 'string') && typeof output.createdAt === 'string' && typeof output.updatedAt === 'string';
}

function variantDirection(campaign: Campaign, mediaType: CreativeMediaType, index: number): string {
  const product = campaign.product.trim() || 'the product in the saved brief';
  const audience = campaign.audience.trim() || 'the saved campaign audience';
  if (mediaType === 'video') {
    if (index === 0) return `Clean product hero: keep ${product} consistent with its saved description, centered on a simple warm-white or soft-sage studio surface; use a slow, steady push-in and generous clear space. No added features, text, or logos.`;
    if (index === 1) return `Everyday setting: show the same ${product}, with its saved appearance unchanged, in a restrained scene relevant to ${audience}; use a gentle lateral pan. Keep it uncluttered and add no implied benefits, text, or logos.`;
    return `Detail angle: a slow controlled pan across visible form and materials of the same ${product}, only as described in the saved brief; soft light, simple background, no added features, text, or logos.`;
  }
  const imageBase = `Polished factual commercial product photography of ${campaign.product.trim()}. Use a neutral seamless studio backdrop, distinct from the product's described color and material. Soft diffused key and fill lighting create balanced natural color and controlled highlights. A realistic contact shadow grounds plausible proportions and a natural perspective. Show one complete product with crisp edges and authentic texture grounded only in the description. Place each described pattern, material, and detail only on its named component; leave unspecified surfaces plain and unbranded. Deliver a photography-only image with blank negative space for layout. Campaign typography and graphic overlays will be composited later outside this image.`;
  if (index === 0) return `${imageBase} Composition A: a full-product three-quarter hero view, centered with the complete silhouette clearly readable and balanced breathing room around it.`;
  if (index === 1) return `${imageBase} Composition B: a wider off-center studio frame, with the complete product slightly left of center and generous clear space to its right for a later headline.`;
  return `${imageBase} Composition C: a closer alternate three-quarter angle, retaining the complete recognizable silhouette with clean space around its edges.`;
}

function defaultVariantPrompts(campaign: Campaign, mediaType: CreativeMediaType, count: number): string[] {
  return Array.from({ length: count }, (_, index) => variantDirection(campaign, mediaType, index));
}

function validHeadlines(value: string[]): boolean {
  return value.length >= 2 && value.length <= 3 && value.every((line) => line.trim().length > 0 && line.trim().length <= 120) &&
    new Set(value.map((line) => line.trim().toLocaleLowerCase())).size === value.length;
}

function validVariantPrompts(value: string[], count: number): boolean {
  return value.length === count && value.every((prompt) => prompt.trim().length > 0 && prompt.trim().length <= 4_000) &&
    new Set(value.map((prompt) => prompt.trim().toLocaleLowerCase())).size === value.length;
}

function restoredHeadlines(current: string[], response: string[] | undefined, jobs: CreativeImageJob[], campaign: Campaign, authoritative = false): string[] {
  if (authoritative) return current;
  if (validHeadlines(current)) return current;
  if (response && validHeadlines(response)) return response;
  if (validHeadlines(campaign.headlines)) return campaign.headlines;
  const saved = jobs.find((job) => job.status === 'ready' && validHeadlines(job.headlines));
  return saved?.headlines ?? [];
}

function hasActiveStatus(status: string | undefined): boolean {
  return status === 'queued' || status === 'submitting' || status === 'generating';
}

function jobIsActive(job: CreativeImageJob): boolean {
  return hasActiveStatus(job.status) || Boolean(job.outputs?.some((output) => hasActiveStatus(output.status)));
}

function jobIsReady(job: CreativeImageJob): boolean {
  if (job.visualMode === 'distinct') return Boolean(job.outputs?.length && job.outputs.every((output) => output.status === 'ready'));
  return job.status === 'ready';
}

function sameVideoOptions(first: CreativeVideoOptions | null, second: CreativeVideoOptions): boolean {
  return first != null && first.durationSeconds === second.durationSeconds && first.resolution === second.resolution &&
    first.aspectRatio === second.aspectRatio && first.generateAudio === second.generateAudio && first.draft === second.draft;
}

function draftFingerprint(headlines: string[], variantPrompts: string[], imagePrompt: string, mediaType: CreativeMediaType, videoOptions: CreativeVideoOptions): string {
  const text = JSON.stringify([headlines.map((line) => line.trim()), variantPrompts.map((prompt) => prompt.trim()), imagePrompt.trim(), mediaType, mediaType === 'video' ? videoOptions : null]);
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

function sameDraft(job: CreativeImageJob, headlines: string[], variantPrompts: string[], imagePrompt: string, mediaType: CreativeMediaType, videoOptions: CreativeVideoOptions): boolean {
  return job.mediaType === mediaType && (mediaType === 'image' || sameVideoOptions(job.videoOptions, videoOptions)) &&
    job.imagePrompt.trim() === imagePrompt.trim() && job.headlines.length === headlines.length &&
    job.headlines.every((headline, index) => headline.trim() === headlines[index]?.trim()) &&
    job.visualMode === 'distinct' && job.outputs?.length === variantPrompts.length &&
    job.outputs.every((output, index) => output.imagePrompt.trim() === variantPrompts[index]?.trim());
}

function variantLabel(index: number): string { return String.fromCharCode(65 + index); }

export default function CreativeComposer({ campaign, initialHeadlines, selectedCreativeJobId, onHeadlinesChange, onUseForExperiment }: {
  campaign: Campaign;
  initialHeadlines?: string[];
  selectedCreativeJobId?: string | null;
  onHeadlinesChange?: (headlines: string[]) => void;
  onUseForExperiment?: (job: CreativeImageJob, headlines: string[]) => void;
}) {
  const [campaignStates, setCampaignStates] = useState<Record<string, ComposerState>>({});
  const [viewer, setViewer] = useState<ViewerItem | null>(null);
  const versionsDisclosureRef = useRef<HTMLDetailsElement | null>(null);
  const planControllers = useRef(new Map<string, AbortController>());
  const seedHeadlines = initialHeadlines !== undefined ? initialHeadlines : validHeadlines(campaign.headlines) ? campaign.headlines : [];
  const seedState = seedHeadlines.length || initialHeadlines !== undefined ? { ...EMPTY_STATE, headlines: seedHeadlines, variantPrompts: defaultVariantPrompts(campaign, EMPTY_STATE.mediaType, seedHeadlines.length), headlinesTouched: initialHeadlines !== undefined || validHeadlines(campaign.headlines) } : EMPTY_STATE;
  const state = campaignStates[campaign.id] ?? seedState;
  const updateCampaign = (campaignId: string, update: (current: ComposerState) => ComposerState) => {
    setCampaignStates((previous) => ({ ...previous, [campaignId]: update(previous[campaignId] ?? (campaignId === campaign.id ? seedState : EMPTY_STATE)) }));
  };

  const onHeadlinesChangeRef = useRef(onHeadlinesChange);
  onHeadlinesChangeRef.current = onHeadlinesChange;
  useEffect(() => {
    if (state.loadStatus === 'ready' && (state.headlinesTouched || validHeadlines(state.headlines))) {
      onHeadlinesChangeRef.current?.(state.headlines);
    }
  }, [campaign.id, state.loadStatus, state.headlines, state.headlinesTouched]);

  useEffect(() => { setViewer(null); }, [campaign.id]);

  useEffect(() => {
    if (state.manualEditing && state.headlines.length >= 2 && versionsDisclosureRef.current) {
      versionsDisclosureRef.current.open = true;
    }
  }, [campaign.id, state.manualEditing, state.headlines.length]);

  useEffect(() => {
    const campaignId = campaign.id;
    const controller = new AbortController();
    updateCampaign(campaignId, (current) => ({ ...current, loadStatus: 'loading', loadError: '' }));
    getJson<{ imagePromptSuggestion: string; jobs: CreativeImageJob[]; capabilities?: Partial<CreativeCapabilities>; headlines?: string[] }>(`/api/campaigns/${encodeURIComponent(campaignId)}/creative`, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (typeof result?.imagePromptSuggestion !== 'string' || !Array.isArray(result.jobs)) throw new Error('Creative settings could not be read.');
        const jobs = result.jobs.filter((job) => isCreativeJob(job, campaignId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const responseHeadlines = Array.isArray(result.headlines) ? result.headlines.filter((item) => typeof item === 'string') : undefined;
        updateCampaign(campaignId, (current) => {
          const headlines = restoredHeadlines(current.headlines, responseHeadlines, jobs, campaign, current.headlinesTouched);
          return {
            ...current,
            loadStatus: 'ready',
            loadError: '',
            imagePromptSuggestion: result.imagePromptSuggestion,
            imagePrompt: current.promptEdited ? current.imagePrompt : result.imagePromptSuggestion,
            jobs,
            headlines,
            variantPrompts: current.variantPrompts.length === headlines.length ? current.variantPrompts : defaultVariantPrompts(campaign, current.mediaType, headlines.length),
            capabilities: { image: result.capabilities?.image !== false, video: result.capabilities?.video === true },
          };
        });
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

  const pollingRequired = state.jobs.some(jobIsActive);
  useEffect(() => {
    if (!pollingRequired) return;
    const campaignId = campaign.id;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const result = await getJson<{ jobs: CreativeImageJob[] }>(`/api/campaigns/${encodeURIComponent(campaignId)}/creative`, controller.signal);
        if (!Array.isArray(result.jobs)) return;
        const jobs = result.jobs.filter((job) => isCreativeJob(job, campaignId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        updateCampaign(campaignId, (current) => ({ ...current, jobs }));
      } catch {
        // Keep showing the latest saved output and let the next bounded poll retry.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 2_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [campaign.id, pollingRequired]);

  const promptsForState = state.variantPrompts.length === state.headlines.length ? state.variantPrompts : defaultVariantPrompts(campaign, state.mediaType, state.headlines.length);
  const fingerprint = useMemo(() => draftFingerprint(state.headlines, promptsForState, state.imagePrompt, state.mediaType, state.videoOptions), [state.headlines, promptsForState, state.imagePrompt, state.mediaType, state.videoOptions]);
  const matchingJob = state.jobs.find((job) => sameDraft(job, state.headlines, promptsForState, state.imagePrompt, state.mediaType, state.videoOptions));
  const activeJob = state.jobs.find(jobIsActive);
  const activeJobCount = state.jobs.filter(jobIsActive).length;
  const issueJobCount = state.jobs.filter((job) => job.status === 'failed' || job.status === 'uncertain' ||
    job.outputs?.some((output) => output.status === 'failed' || output.status === 'uncertain')).length;
  const readyJobCount = state.jobs.filter(jobIsReady).length;
  const uncertainOtherJob = state.jobs.find((job) => job.status === 'uncertain' && !sameDraft(job, state.headlines, promptsForState, state.imagePrompt, state.mediaType, state.videoOptions));
  const sameDraftComplete = matchingJob ? jobIsReady(matchingJob) : false;
  const headlinesValid = validHeadlines(state.headlines);
  const promptValid = state.imagePrompt.trim().length > 0 && state.imagePrompt.trim().length <= 4_000;
  const unresolvedForDraft = matchingJob && (matchingJob.status === 'uncertain' || matchingJob.status === 'failed') && !storedRequest(campaign.id, fingerprint);
  const mediaAvailable = state.capabilities[state.mediaType];
  const videoOptionsValid = state.mediaType !== 'video' || !state.videoOptions.draft || state.videoOptions.resolution === 'hd';
  const editingDisabled = state.generationLoading || Boolean(activeJob);
  const canGenerate = headlinesValid && validVariantPrompts(promptsForState, state.headlines.length) && promptValid && videoOptionsValid && mediaAvailable && !state.generationLoading && !state.planLoading &&
    state.loadStatus === 'ready' && !activeJob && !uncertainOtherJob && !unresolvedForDraft;

  async function suggestHeadlines() {
    planControllers.current.get(campaign.id)?.abort();
    const controller = new AbortController();
    planControllers.current.set(campaign.id, controller);
    updateCampaign(campaign.id, (current) => ({ ...current, planLoading: true, planError: '', decision: null, metadata: null, headlines: [], variantPrompts: [], headlinesTouched: true, manualEditing: false }));
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
        variantPrompts: decision.action === 'propose_test' ? defaultVariantPrompts(campaign, current.mediaType, decision.headlines.length) : [],
        headlinesTouched: true,
        manualEditing: false,
      }));
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
    const result = await getJson<{ imagePromptSuggestion: string; jobs: CreativeImageJob[]; capabilities?: Partial<CreativeCapabilities>; headlines?: string[] }>(`/api/campaigns/${encodeURIComponent(campaignId)}/creative`, controller.signal);
      if (typeof result?.imagePromptSuggestion !== 'string' || !Array.isArray(result.jobs)) throw new Error('Creative settings could not be read.');
      const jobs = result.jobs.filter((job) => isCreativeJob(job, campaignId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      updateCampaign(campaignId, (current) => {
        const restored = restoredHeadlines(current.headlines, result.headlines, jobs, campaign, current.headlinesTouched);
        const nextPrompts = current.variantPrompts.length === restored.length ? current.variantPrompts : defaultVariantPrompts(campaign, current.mediaType, restored.length);
        return { ...current, loadStatus: 'ready', loadError: '', imagePromptSuggestion: result.imagePromptSuggestion, imagePrompt: current.promptEdited ? current.imagePrompt : result.imagePromptSuggestion, jobs, headlines: restored, variantPrompts: nextPrompts, capabilities: { image: result.capabilities?.image !== false, video: result.capabilities?.video === true } };
      });
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
    const variantPrompts = promptsForState.map((prompt) => prompt.trim());
    const requestFingerprint = draftFingerprint(headlines, variantPrompts, imagePrompt, mediaType, state.videoOptions);
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      updateCampaign(campaignId, (current) => ({ ...current, generationError: 'This browser cannot create a secure request ID.' }));
      return;
    }
    // A completed draft is an explicit new paid attempt. If its earlier 202 request key
    // remained stored while polling, discard that completed key before creating the new one.
    if (sameDraftComplete) {
      const previous = storedRequest(campaignId, requestFingerprint);
      if (previous) clearStoredRequest(campaignId, requestFingerprint, previous.requestId);
    }
    const requestId = createOrReuseRequestId(campaignId, requestFingerprint);
    updateCampaign(campaignId, (current) => ({ ...current, generationLoading: true, generationError: '' }));
    try {
      const path = mediaType === 'video' ? 'videos' : 'images';
      const body = mediaType === 'video' ? { requestId, headlines, imagePrompt, variantPrompts, videoOptions: state.videoOptions } : { requestId, headlines, imagePrompt, variantPrompts };
      const result = await postJson<{ job: CreativeImageJob }>(`/api/campaigns/${encodeURIComponent(campaignId)}/creative/${path}`, body);
      if (!isCreativeJob(result?.job, campaignId)) throw new Error('The creative request returned an invalid job. Refresh saved drafts before trying again.');
      updateCampaign(campaignId, (current) => ({
        ...current,
        generationLoading: false,
        generationError: result.job.error ?? '',
        jobs: [result.job, ...current.jobs.filter((job) => job.id !== result.job.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }));
      if (jobIsReady(result.job)) clearStoredRequest(campaignId, requestFingerprint, requestId);
    } catch (error) {
      updateCampaign(campaignId, (current) => ({ ...current, generationLoading: false, generationError: error instanceof Error ? error.message : 'The creative request did not return a result. Reuse the same request to check its status.' }));
    }
  }

  function updateHeadline(index: number, value: string) {
    updateCampaign(campaign.id, (current) => {
      const headlines = current.headlines.map((headline, currentIndex) => currentIndex === index ? value : headline);
      return { ...current, generationError: '', headlines, headlinesTouched: true };
    });
  }

  const addHeadline = () => updateCampaign(campaign.id, (current) => {
    if (current.headlines.length >= 3) return current;
    const headlines = [...current.headlines, ''];
    return { ...current, headlines, headlinesTouched: true, variantPrompts: [...current.variantPrompts, variantDirection(campaign, current.mediaType, current.variantPrompts.length)] };
  });
  const removeHeadline = (index: number) => updateCampaign(campaign.id, (current) => {
    if (current.headlines.length <= 2) return current;
    const headlines = current.headlines.filter((_, currentIndex) => currentIndex !== index);
    return { ...current, headlines, headlinesTouched: true, variantPrompts: current.variantPrompts.filter((_, currentIndex) => currentIndex !== index) };
  });
  const updateVariantPrompt = (index: number, value: string) => updateCampaign(campaign.id, (current) => ({
    ...current,
    generationError: '',
    variantPrompts: current.variantPrompts.map((prompt, currentIndex) => currentIndex === index ? value : prompt),
  }));
  const mediaWord = state.mediaType === 'video' ? 'video' : 'image';
  const activeRequestMessage = state.generationLoading ? `Submitting ${state.headlines.length} separate ${mediaWord} requests. This takes 1 BFL generation per version.` :
    activeJob ? `Separate ${mediaWord} outputs are processing; check each version below. ${state.mediaType === 'video' ? 'Video jobs may take up to five minutes.' : 'Image jobs may take up to two minutes.'}` :
    uncertainOtherJob ? 'Another creative request has an uncertain result. Check saved jobs before starting a new visual draft.' :
    matchingJob?.status === 'uncertain' ? 'This request has an uncertain outcome. A manual retry will reuse the same request ID.' :
    matchingJob?.status === 'failed' ? 'This attempt failed. A manual retry will reuse the same request ID; edit the direction or copy to start a distinct draft.' :
    sameDraftComplete ? 'This exact draft is already saved. Generating it again uses BFL credits for a new set of outputs.' : '';

  return (
    <section className="composer-panel" aria-labelledby="composer-title">
      <header className="composer-heading">
        <div>
          <span className="section-kicker">CREATIVE DRAFTS</span>
          <h2 id="composer-title">Build a creative concept</h2>
          <p>Review the copy and visual direction before making a paid creative request.</p>
        </div>
        <button className="button button-secondary composer-refresh" type="button" onClick={() => void refreshJobs()} disabled={state.loadStatus === 'loading'} aria-busy={state.loadStatus === 'loading'}>
          {state.loadStatus === 'loading' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Reload saved jobs
        </button>
      </header>

      {state.loadError && <div className="alert alert-error composer-alert" role="alert"><span>{state.loadError}</span><button className="text-button" type="button" onClick={() => void refreshJobs()}>Retry</button></div>}

      <div className="composer-grid">
        <div className="composer-form">
          <label className="composer-field media-type-field" htmlFor="creative-media-type"><span><b>Creative type</b></span>
            <select id="creative-media-type" value={state.mediaType} onChange={(event) => updateCampaign(campaign.id, (current) => ({ ...current, mediaType: event.target.value as CreativeMediaType, variantPrompts: defaultVariantPrompts(campaign, event.target.value as CreativeMediaType, current.headlines.length), generationError: '' }))} disabled={editingDisabled}>
              <option value="image" disabled={!state.capabilities.image}>Image</option>
              <option value="video" disabled={!state.capabilities.video}>Video</option>
            </select>
            {!state.capabilities.video && <small>Enable video in server configuration to use this option.</small>}
          </label>
          <div className="composer-step"><span>1</span><div><strong>Suggest and review headlines</strong><small>Suggestions use this saved campaign brief through Liquid.</small></div></div>
          <button className="button button-secondary" type="button" onClick={() => void suggestHeadlines()} disabled={state.planLoading || editingDisabled || state.loadStatus !== 'ready'} aria-busy={state.planLoading}>
            {state.planLoading ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} {state.planLoading ? 'Reviewing brief…' : 'Suggest headlines'}
          </button>
          {state.headlines.length < 2 && <button className="composer-manual-button" type="button" onClick={() => updateCampaign(campaign.id, (current) => ({ ...current, planError: '', decision: null, headlines: ['', ''], variantPrompts: defaultVariantPrompts(campaign, current.mediaType, 2), headlinesTouched: true, manualEditing: true }))} disabled={editingDisabled || state.loadStatus !== 'ready'}>Write headlines manually</button>}
          {state.planError && <div className="composer-error" role="alert"><AlertCircle size={15} /><span>{state.planError}</span></div>}
          {state.decision && <div className={`decision-note ${state.decision.action === 'wait' ? 'decision-wait' : ''}`} role="status">
            <strong>{state.decision.action === 'wait' ? 'Liquid recommends waiting' : 'Review these headline drafts'}</strong>
            {state.decision.explanation && <p>{state.decision.explanation}</p>}
            {state.decision.hypothesis && <small>Hypothesis · {state.decision.hypothesis}</small>}
            {state.metadata?.model && <small className="decision-meta">{state.metadata.model}{state.metadata.elapsedMs != null ? ` · ${Math.round(state.metadata.elapsedMs)} ms` : ''}</small>}
          </div>}

          {state.headlines.length >= 2 && <details ref={versionsDisclosureRef} className="version-disclosure">
            <summary className="saved-creative-summary">
              <span className="saved-creative-summary-title">Versions</span>
              <span className="saved-creative-summary-count">{state.headlines.length}</span>
              <span className="saved-creative-summary-status">Headlines and visual directions</span>
            </summary>
            <div className="saved-creative-content version-disclosure-content">
              <div className="headline-editor" aria-label="Editable headline drafts">
                {state.headlines.map((headline, index) => <label className="composer-field" key={index}>
                  <span><b>Version {variantLabel(index)}</b><small>{headline.trim().length}/120</small></span>
                  <div className="headline-input-row">
                    <input value={headline} maxLength={120} onChange={(event) => updateHeadline(index, event.target.value)} aria-label={`Version ${variantLabel(index)} headline`} disabled={editingDisabled || state.loadStatus !== 'ready'} />
                    {state.headlines.length > 2 && <button type="button" className="icon-button composer-remove" aria-label={`Remove version ${variantLabel(index)}`} onClick={() => removeHeadline(index)} disabled={editingDisabled}><X size={15} /></button>}
                  </div>
                </label>)}
                {state.headlines.length < 3 && <button className="composer-add" type="button" onClick={addHeadline} disabled={editingDisabled}><Plus size={14} /> Add another headline</button>}
              </div>
              <fieldset className="variant-prompt-editor">
                <legend>Distinct direction for each version</legend>
                <p>Each version gets a separate {state.mediaType}. Keep product details consistent with the saved brief; review every direction before generation.</p>
                {state.headlines.map((_, index) => <label className="composer-field" key={index}>
                  <span><b>Version {variantLabel(index)} direction</b><small>{(promptsForState[index] ?? '').length}/4000</small></span>
                  <textarea aria-label={`Version ${variantLabel(index)} visual direction`} value={promptsForState[index] ?? ''} maxLength={4000} rows={3} onChange={(event) => updateVariantPrompt(index, event.target.value)} disabled={editingDisabled} />
                </label>)}
              </fieldset>
            </div>
          </details>}
          {state.manualEditing && <p className="composer-guidance" role="note">Manual draft — these headlines were not reviewed by Liquid. Keep them within the approved claims saved on this campaign: {campaign.approvedClaims.length ? campaign.approvedClaims.join(' · ') : 'no approved claims are saved; avoid product claims.'}</p>}

          <div className="composer-divider" />
          <div className="composer-step"><span>2</span><div><strong>Review {state.mediaType === 'video' ? 'video' : 'image'} directions</strong><small>Each editable version direction is submitted separately. BFL may interpret or expand it; generated media is a draft for human review.</small></div></div>
          <p className="composer-guidance">These directions are submitted as written. Change framing or motion while keeping product details grounded in the brief.</p>
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
            <button className="button button-primary" type="button" onClick={() => void generateImage()} disabled={!canGenerate} aria-busy={state.generationLoading}>
              {state.generationLoading ? <LoaderCircle size={16} className="spin" /> : <ImagePlus size={16} />}
              {state.generationLoading ? `Generating ${state.headlines.length} ${state.mediaType}s…` : state.generationError || matchingJob?.status === 'uncertain' || matchingJob?.status === 'failed' ? `Retry ${state.headlines.length} ${mediaWord} requests` : sameDraftComplete ? `Generate again ${state.headlines.length} ${state.mediaType}s` : `Generate ${state.headlines.length} ${state.mediaType}s`}
            </button>
            <span>Uses BFL credits · {state.headlines.length} separate {state.mediaType} requests, one per version</span>
          </div>
          {!headlinesValid && <p className="composer-guidance">Generation needs 2–3 unique, non-empty headlines. {state.headlines.length >= 2 ? 'Open Versions to fix them.' : 'Suggest them with Liquid or enter them manually.'}</p>}
          {headlinesValid && !validVariantPrompts(promptsForState, state.headlines.length) && <p className="composer-guidance">One or more directions need attention. Open Versions to fix them before generating.</p>}
          {headlinesValid && !promptValid && <p className="composer-guidance">The saved campaign visual context is missing. Reload creative settings before generating.</p>}
          {headlinesValid && <p className="composer-guidance">Review each headline before generation. When a ready creative is selected, persona experiments inspect the image or video together with the copy.</p>}
        </div>

        <aside className="composer-side-note">
          <span className="composer-side-icon"><ImagePlus size={18} /></span>
          <strong>A reviewable draft, not a live ad</strong>
          <p>Riff saves the generated {state.mediaType} concept with the reviewed headlines. It does not create an ad, publish anything, allocate traffic, or collect analytics.</p>
          <div><ArrowDownToLine size={14} /> Saved jobs can be reopened from this campaign.</div>
        </aside>
      </div>

      {state.jobs.length > 0 && <details className="image-job-list" aria-label="Saved creative drafts"
        onToggle={(event) => {
          if (!event.currentTarget.open) document.querySelectorAll<HTMLVideoElement>('.image-ad-card video').forEach((video) => video.pause());
        }}>
        <summary className="saved-creative-summary">
          <span className="saved-creative-summary-title">Saved creative drafts</span>
          <span className="saved-creative-summary-count">{state.jobs.length} {state.jobs.length === 1 ? 'job' : 'jobs'}</span>
          <span className="saved-creative-summary-status">
            {activeJobCount > 0 && <>{activeJobCount} processing{issueJobCount > 0 ? ' · ' : ''}</>}
            {issueJobCount > 0 ? `${issueJobCount} need attention` : activeJobCount === 0 ? `${readyJobCount} ready` : ''}
          </span>
        </summary>
        <div className="saved-creative-content">
          {state.jobs.map((job) => <SavedCreativeJob key={job.id} job={job} selected={selectedCreativeJobId === job.id}
            onUse={() => onUseForExperiment?.(job, job.headlines)}
            onOpen={(item) => {
              document.querySelectorAll<HTMLVideoElement>('.image-ad-card video').forEach((video) => video.pause());
              setViewer(item);
            }} />)}
        </div>
      </details>}
      {viewer && <CreativeMediaViewer kind={viewer.kind} src={viewer.src} title={viewer.title} alt={viewer.alt} onClose={() => setViewer(null)} />}
    </section>
  );
}

interface DraftVariant {
  index: number;
  headline: string;
  status: string;
  imagePrompt: string;
  imageUrl: string | null;
  videoUrl: string | null;
  error: string | null;
  assetId: string;
}

function SavedCreativeJob({ job, selected, onUse, onOpen }: {
  job: CreativeImageJob;
  selected: boolean;
  onUse?: () => void;
  onOpen: (item: ViewerItem) => void;
}) {
  const distinct = job.visualMode === 'distinct' && Array.isArray(job.outputs);
  const variants: DraftVariant[] = distinct
    ? (job.outputs ?? []).map((output) => ({ index: output.index, headline: output.headline, status: output.status, imagePrompt: output.imagePrompt, imageUrl: output.imageUrl, videoUrl: output.videoUrl, error: output.error, assetId: output.id }))
    : job.status === 'ready' ? job.headlines.map((headline, index) => ({
      index, headline, status: job.status, imagePrompt: job.imagePrompt,
      imageUrl: job.imageUrl, videoUrl: job.videoUrl, error: job.error, assetId: job.id,
    })) : [];
  const completedCount = variants.filter((variant) => variant.status === 'ready').length;
  const canUse = onUse && jobIsReady(job);
  return <article className="image-job">
    <div className="image-job-top">
      <div><strong>{job.mediaType === 'video' ? 'Video draft' : 'Image draft'}</strong><span className={`job-status job-${job.status}`}><i />{job.status === 'ready' ? 'Ready' : job.status === 'failed' ? 'Some requests failed' : job.status === 'uncertain' ? 'Outcome uncertain' : 'Generating'}</span></div>
      <time dateTime={job.createdAt}>{formatTime(job.createdAt)}</time>
    </div>
    <p className="visual-mode-note">{distinct ? `${completedCount} of ${variants.length} separate visuals ready` : 'One shared visual across versions'}</p>
    {variants.length > 0 ? <div className="image-ad-grid">{variants.map((variant) => {
      const kind = job.mediaType;
      const assetPath = `/api/creative-assets/${encodeURIComponent(variant.assetId)}`;
      const src = kind === 'video' ? variant.videoUrl ?? assetPath : variant.imageUrl ?? assetPath;
      const label = variantLabel(variant.index);
      const title = `Version ${label} ${kind} draft`;
      const alt = `${kind === 'video' ? 'Video' : 'Generated image'} draft for Version ${label}`;
      return <article className={`image-ad-card output-${variant.status}`} key={`${job.id}-${variant.index}`}>
        <div className="image-ad-label">Version {label} <span>{variant.status === 'ready' ? 'Draft concept' : outputStatusLabel(variant.status)}</span></div>
        {variant.status === 'ready' ? <>
          {kind === 'video' ? <video controls preload="metadata" src={src} aria-label={alt} /> : <img src={src} alt={alt} loading="lazy" />}
          <h4>{variant.headline}</h4><div className="mock-cta">Join the waitlist</div>
          <p>Review before use · {distinct ? 'distinct' : 'shared'} {kind}</p>
          <button className="media-open-button" type="button" aria-label={`${kind === 'video' ? 'Watch video' : 'View image'} for Version ${label}`} onClick={() => {
            document.querySelectorAll<HTMLVideoElement>('.image-ad-card video').forEach((video) => video.pause());
            onOpen({ kind, src, title, alt });
          }}>{kind === 'video' ? <Play size={13} /> : <Eye size={13} />} {kind === 'video' ? 'Watch video' : 'View image'}</button>
        </> : <div className="output-pending" role="status">
          <span>{outputStatusLabel(variant.status)}</span>
          {variant.error && <small>{variant.error}</small>}
        </div>}
        <details className="job-direction"><summary>Version {label} direction</summary><p>{variant.imagePrompt}</p></details>
      </article>;
    })}</div> : <div className="job-message">
      {job.status === 'failed' ? job.error || 'This creative request failed. Edit the visual direction or copy to start a distinct draft.' : job.status === 'uncertain' ? job.error || 'The creative service did not confirm whether it completed. Reload saved jobs before starting another draft.' : 'The creative request is still being processed. Reload saved jobs to check again.'}
    </div>}
    {!distinct && <details className="job-direction"><summary>Shared visual direction</summary><p>{job.imagePrompt}</p></details>}
    {canUse && <div className="creative-experiment-select">
      <button type="button" className={selected ? 'button button-secondary' : 'button button-primary'} aria-pressed={selected} onClick={onUse}>{selected ? 'Selected' : 'Select for experiment'}</button>
    </div>}
    {distinct && !jobIsReady(job) && <p className="composer-guidance">A partial result can be reviewed above. Wait until every version is ready before attaching it to an experiment.</p>}
  </article>;
}

function outputStatusLabel(status: string): string {
  switch (status) {
    case 'queued': return 'Queued';
    case 'submitting': return 'Submitting';
    case 'generating': return 'Generating';
    case 'failed': return 'Failed';
    case 'uncertain': return 'Outcome uncertain';
    case 'skipped': return 'Not submitted';
    default: return status;
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Saved draft';
}
