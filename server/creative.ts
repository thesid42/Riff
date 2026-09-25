import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Campaign } from '../shared/types.js';
import type { CreativeImageJob, CreativeImageJobStatus, CreativeImageRequest, CreativeVariantOutputStatus, CreativeVideoOptions, CreativeVideoRequest } from '../shared/creative.js';
import { ProviderError, type BflClient, type LiquidClient } from './providers/index.js';
import { CampaignDatabase, type StoredCreativeImageJob, type StoredCreativeVariantOutput } from './database.js';

const IMAGE_WIDTH = 1_024;
const IMAGE_HEIGHT = 1_024;
const IMAGE_TIMEOUT_MS = 120_000;
const VIDEO_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_500;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const TERMINAL_FAILURES = new Set(['Error', 'Failed', 'Request Moderated', 'Content Moderated', 'Task not found']);
const UNCERTAIN_MESSAGE = 'The provider task could not be confirmed. Review its status before starting another media job.';
const INTERRUPTED_MESSAGE = 'Generation was interrupted by a server restart. Review provider status before starting another job.';

export type CreativeLiquid = Pick<LiquidClient, 'proposeExperimentWithMetadata'>;
export type CreativeBfl = Pick<BflClient, 'submit' | 'poll'>;
export interface CreativeVideoProvider {
  submit(prompt: string, options: CreativeVideoOptions, signal?: AbortSignal): Promise<{ id: string; pollingUrl: string }>;
  poll(submission: { id: string; pollingUrl: string }, signal?: AbortSignal): Promise<{
    status: string;
    downloadVideo?: () => Promise<{ bytes: Uint8Array; contentType: 'video/mp4' }>;
  }>;
}

export interface CreativeServiceOptions {
  database: CampaignDatabase;
  assetDirectory: string;
  liquid?: CreativeLiquid;
  bfl?: CreativeBfl;
  video?: CreativeVideoProvider;
  videoEnabled: boolean;
  videoModel: string;
  bflModel: string;
}

export interface CreativeAsset {
  bytes: Uint8Array;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
  mediaType: 'image' | 'video';
}

export class CreativeService {
  private readonly assetDirectory: string;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeTasks = new Set<Promise<unknown>>();
  private closing = false;

  constructor(private readonly options: CreativeServiceOptions) {
    this.assetDirectory = resolve(options.assetDirectory);
  }

  getCampaignCreative(campaign: Campaign): { imagePromptSuggestion: string; capabilities: { image: true; video: boolean }; jobs: CreativeImageJob[]; headlines: string[] } {
    return {
      imagePromptSuggestion: suggestImagePrompt(campaign),
      capabilities: { image: true, video: this.options.videoEnabled && !!this.options.video },
      jobs: this.options.database.listCreativeJobs(campaign.id),
      headlines: campaign.headlines,
    };
  }

  async plan(campaign: Campaign, signal?: AbortSignal): Promise<{ decision: unknown; metadata: unknown }> {
    if (!this.options.liquid) throw new CreativeServiceError(503, 'liquid_unavailable', 'The experiment planner is not configured.');
    const brief = [
      `Campaign: ${campaign.name}`,
      `Product: ${campaign.product}`,
      `Audience: ${campaign.audience}`,
      `Goal: ${campaign.goal}`,
      `Approved claims: ${campaign.approvedClaims.length ? JSON.stringify(campaign.approvedClaims) : 'None supplied.'}`,
    ].join('\n');
    if (brief.length > 4_000) throw new CreativeServiceError(422, 'brief_too_long', 'Campaign details exceed the experiment planner limit. Shorten the campaign name, product, audience, or approved claims.');
    try {
      const result = await this.options.liquid.proposeExperimentWithMetadata({ brief, evidence: [], lessons: [], stage: 'initial' }, signal);
      if (result.decision.action === 'propose_test' && result.decision.headlines.length >= 2) {
        this.options.database.setHeadlines(campaign.id, result.decision.headlines, new Date().toISOString());
      }
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw new CreativeServiceError(error.code === 'configuration' ? 503 : 502, 'planner_failed', error.message);
      throw new CreativeServiceError(502, 'planner_failed', 'The experiment planner could not complete the request.');
    }
  }

  async createImageJob(campaign: Campaign, request: CreativeImageRequest, signal?: AbortSignal): Promise<CreativeImageJob> {
    if (!this.options.bfl) throw new CreativeServiceError(503, 'image_provider_unavailable', 'The image provider is not configured.');
    if (this.closing) throw new CreativeServiceError(503, 'server_closing', 'The server is shutting down.');
    return this.reserveAndRun(campaign.id, request.requestId, request.headlines, request.imagePrompt, 'image', null,
      this.options.bflModel, IMAGE_WIDTH, IMAGE_HEIGHT, signal, (job, jobSignal) => this.runReservedImageJob(job, jobSignal), request.variantPrompts);
  }

  async createVideoJob(campaign: Campaign, request: CreativeVideoRequest, signal?: AbortSignal): Promise<CreativeImageJob> {
    if (!this.options.videoEnabled || !this.options.video) throw new CreativeServiceError(503, 'video_provider_unavailable', 'Video generation is disabled or not configured.');
    if (this.closing) throw new CreativeServiceError(503, 'server_closing', 'The server is shutting down.');
    return this.reserveAndRun(campaign.id, request.requestId, request.headlines, request.imagePrompt, 'video', request.videoOptions,
      this.options.videoModel, 0, 0, signal, (job, jobSignal) => this.runReservedVideoJob(job, jobSignal), request.variantPrompts);
  }

  private async reserveAndRun(campaignId: string, id: string, headlines: string[], imagePrompt: string, mediaType: 'image' | 'video',
    videoOptions: CreativeVideoOptions | null, model: string, width: number, height: number, signal: AbortSignal | undefined,
    run: (job: StoredCreativeImageJob, signal: AbortSignal) => Promise<StoredCreativeImageJob>, variantPrompts?: string[]): Promise<CreativeImageJob> {
    const now = new Date().toISOString();
    const visualMode = variantPrompts ? 'distinct' : 'shared';
    const requestDetails = { campaignId, headlines, imagePrompt, mediaType, videoOptions, model, width, height };
    const requestHash = createHash('sha256').update(JSON.stringify(variantPrompts
      ? { ...requestDetails, visualMode, variantPrompts }
      : requestDetails)).digest('hex');
    const outputs = variantPrompts?.map((prompt, index) => ({ id: randomUUID(), index, headline: headlines[index]!, imagePrompt: prompt, status: 'queued' as const }));
    const reserved = this.options.database.reserveCreativeJob({
      id, campaignId, requestHash, headlines, imagePrompt, mediaType, videoOptions, model, width, height,
      status: 'submitting', imageUrl: null, videoUrl: null, error: null, providerTaskId: null, pollingUrl: null,
      contentType: null, createdAt: now, updatedAt: now, visualMode, outputs,
    });
    if (reserved.kind === 'existing') return publicCreativeJob(reserved.job);
    if (reserved.kind === 'conflict') throw new CreativeServiceError(409, 'idempotency_conflict', 'This request ID is already bound to different media job details.');
    if (reserved.kind === 'busy') throw new CreativeServiceError(409, 'campaign_media_job_active', 'This campaign already has a media job in progress or awaiting review.');

    if (visualMode === 'distinct') {
      const controller = new AbortController();
      this.activeControllers.add(controller);
      const task = Promise.resolve().then(() => this.runDistinctJob(reserved.job, controller.signal));
      this.activeTasks.add(task);
      void task.finally(() => {
        this.activeControllers.delete(controller);
        this.activeTasks.delete(task);
      }).catch(() => undefined);
      return publicCreativeJob(reserved.job);
    }

    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    this.activeControllers.add(controller);
    // The job runs detached so the HTTP response returns immediately. Callers poll
    // GET /api/campaigns/:id/creative for the stored status instead of holding the request open.
    const task = Promise.resolve().then(() => run(reserved.job, controller.signal)).catch(() => undefined);
    this.activeTasks.add(task);
    void task.finally(() => {
      this.activeControllers.delete(controller);
      this.activeTasks.delete(task);
    });
    return publicCreativeJob(reserved.job);
  }

  /** Resolves once every in-flight media job has settled. Used by tests and shutdown. */
  async waitForIdle(): Promise<void> {
    while (this.activeTasks.size > 0) await Promise.allSettled([...this.activeTasks]);
  }

  async getAsset(jobId: string): Promise<CreativeAsset | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) return undefined;
    const parent = this.options.database.getCreativeJob(jobId);
    const output = parent ? undefined : this.options.database.getCreativeOutput(jobId);
    const mediaType = parent?.mediaType ?? output?.mediaType;
    const status = parent?.status ?? output?.status;
    const contentType = parent?.contentType ?? output?.contentType;
    const imageUrl = parent?.imageUrl ?? output?.imageUrl;
    const videoUrl = parent?.videoUrl ?? output?.videoUrl;
    if (!mediaType || status !== 'ready' || !contentType) return undefined;
    if (mediaType === 'image' && (imageUrl !== `/api/creative-assets/${jobId}` || !isImageContentType(contentType))) return undefined;
    if (mediaType === 'video' && (videoUrl !== `/api/creative-assets/${jobId}` || contentType !== 'video/mp4')) return undefined;
    const ext = extensionForContentType(contentType);
    const path = resolve(this.assetDirectory, `${jobId}.${ext}`);
    if (!path.startsWith(`${this.assetDirectory}${sep}`)) return undefined;
    try {
      const info = await stat(path);
      const maxBytes = mediaType === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (info.size === 0 || info.size > maxBytes) return undefined;
      const bytes = await readFile(path);
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return undefined;
      return { bytes, contentType, mediaType };
    } catch { return undefined; }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.activeControllers) controller.abort(new Error('Server shutdown'));
    await this.waitForIdle();
  }

  private async runDistinctJob(job: StoredCreativeImageJob, signal: AbortSignal): Promise<StoredCreativeImageJob> {
    const maxDuration = job.mediaType === 'video' ? VIDEO_TIMEOUT_MS * job.outputs.length : IMAGE_TIMEOUT_MS * job.outputs.length;
    const timeout = AbortSignal.timeout(Math.min(maxDuration, 10 * 60_000));
    const combined = AbortSignal.any([signal, timeout]);
    for (const output of job.outputs) {
      if (combined.aborted) {
        this.options.database.updateCreativeOutput(output.id, { status: 'skipped', error: 'Skipped because the job was interrupted before this variant was submitted.' }, new Date().toISOString());
        return this.options.database.finishDistinctCreativeJob(job.id, 'failed', 'The batch stopped before every creative variant was submitted.', new Date().toISOString()) ?? job;
      }
      const result = await this.runDistinctOutput(job, output, combined);
      if (result.status !== 'ready') {
        const status: CreativeImageJobStatus = result.status === 'uncertain' ? 'uncertain' : 'failed';
        const message = result.error ?? (status === 'uncertain' ? UNCERTAIN_MESSAGE : 'A creative variant failed.');
        return this.options.database.finishDistinctCreativeJob(job.id, status, message, new Date().toISOString()) ?? job;
      }
    }
    return this.options.database.finishDistinctCreativeJob(job.id, 'ready', null, new Date().toISOString()) ?? job;
  }

  private async runDistinctOutput(job: StoredCreativeImageJob, output: StoredCreativeVariantOutput, signal: AbortSignal): Promise<StoredCreativeVariantOutput> {
    this.options.database.updateCreativeOutput(output.id, { status: 'submitting', error: null }, new Date().toISOString());
    const timeout = AbortSignal.timeout(job.mediaType === 'video' ? VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
    const itemSignal = AbortSignal.any([signal, timeout]);
    let providerTaskKnown = false;
    try {
      if (job.mediaType === 'image') {
        const submission = await this.options.bfl!.submit(output.imagePrompt, IMAGE_WIDTH, IMAGE_HEIGHT, itemSignal);
        providerTaskKnown = true;
        this.options.database.updateCreativeOutput(output.id, { status: 'generating', providerTaskId: submission.id, pollingUrl: submission.pollingUrl }, new Date().toISOString());
        this.options.database.updateCreativeJob(job.id, { status: 'generating' }, new Date().toISOString());
        while (!itemSignal.aborted) {
          const result = await this.options.bfl!.poll(submission, itemSignal);
          if (result.status === 'Ready') {
            if (!result.downloadImage) throw new Error('Ready result did not provide an image downloader.');
            const generated = await result.downloadImage();
            await this.persistAsset(output.id, generated.bytes, generated.contentType);
            return this.options.database.updateCreativeOutput(output.id, {
              status: 'ready', imageUrl: `/api/creative-assets/${output.id}`, videoUrl: null, contentType: generated.contentType,
            }, new Date().toISOString()) ?? { ...output, status: 'uncertain', error: UNCERTAIN_MESSAGE };
          }
          if (TERMINAL_FAILURES.has(result.status)) return this.options.database.updateCreativeOutput(output.id, {
            status: 'failed', error: terminalMessage(result.status),
          }, new Date().toISOString()) ?? { ...output, status: 'failed', error: terminalMessage(result.status) };
          await delay(POLL_INTERVAL_MS, itemSignal);
        }
      } else {
        if (!job.videoOptions) throw new Error('Video job options are missing.');
        const submission = await this.options.video!.submit(output.imagePrompt, job.videoOptions, itemSignal);
        providerTaskKnown = true;
        this.options.database.updateCreativeOutput(output.id, { status: 'generating', providerTaskId: submission.id, pollingUrl: submission.pollingUrl }, new Date().toISOString());
        this.options.database.updateCreativeJob(job.id, { status: 'generating' }, new Date().toISOString());
        while (!itemSignal.aborted) {
          const result = await this.options.video!.poll(submission, itemSignal);
          if (result.status === 'Ready') {
            if (!result.downloadVideo) throw new Error('Ready result did not provide a video downloader.');
            const generated = await result.downloadVideo();
            await this.persistAsset(output.id, generated.bytes, generated.contentType);
            return this.options.database.updateCreativeOutput(output.id, {
              status: 'ready', imageUrl: null, videoUrl: `/api/creative-assets/${output.id}`, contentType: generated.contentType,
            }, new Date().toISOString()) ?? { ...output, status: 'uncertain', error: UNCERTAIN_MESSAGE };
          }
          if (TERMINAL_FAILURES.has(result.status)) return this.options.database.updateCreativeOutput(output.id, {
            status: 'failed', error: terminalMessage(result.status, 'video'),
          }, new Date().toISOString()) ?? { ...output, status: 'failed', error: terminalMessage(result.status, 'video') };
          await delay(POLL_INTERVAL_MS, itemSignal);
        }
      }
      return this.options.database.updateCreativeOutput(output.id, {
        status: 'uncertain', error: timeout.aborted ? timeoutMessage(job.mediaType) : UNCERTAIN_MESSAGE,
      }, new Date().toISOString()) ?? { ...output, status: 'uncertain', error: UNCERTAIN_MESSAGE };
    } catch (error) {
      const rejectionStatus = providerTaskKnown ? undefined : preSubmitRejectionStatus(error);
      const status: CreativeVariantOutputStatus = rejectionStatus ? 'failed' : providerTaskKnown ? 'uncertain' : 'uncertain';
      const errorMessage = timeout.aborted ? timeoutMessage(job.mediaType)
        : rejectionStatus === 402 ? `The ${job.mediaType} provider reported insufficient credits (HTTP 402). No automatic retry was made.`
        : rejectionStatus === 401 ? `The ${job.mediaType} provider rejected its server-side credentials (HTTP 401). No automatic retry was made.`
          : rejectionStatus ? `The ${job.mediaType} provider rejected the request. No automatic retry was made.`
            : providerTaskKnown ? `The ${job.mediaType} task was submitted, but its result could not be confirmed. Review provider status before starting another job.` : UNCERTAIN_MESSAGE;
      return this.options.database.updateCreativeOutput(output.id, { status, error: errorMessage }, new Date().toISOString())
        ?? { ...output, status, error: errorMessage };
    }
  }

  private async runReservedImageJob(job: StoredCreativeImageJob, signal: AbortSignal): Promise<StoredCreativeImageJob> {
    const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    let providerTaskKnown = false;
    try {
      const submission = await this.options.bfl!.submit(job.imagePrompt, IMAGE_WIDTH, IMAGE_HEIGHT, combined);
      providerTaskKnown = true;
      const persisted = this.options.database.updateCreativeJob(job.id, {
        status: 'generating', providerTaskId: submission.id, pollingUrl: submission.pollingUrl, error: null,
      }, new Date().toISOString());
      if (!persisted) throw new Error('Creative job disappeared after provider submission.');

      while (!combined.aborted) {
        const result = await this.options.bfl!.poll(submission, combined);
        if (result.status === 'Ready') {
          if (!result.downloadImage) throw new Error('Ready result did not provide an image downloader.');
          const generated = await result.downloadImage();
          await this.persistAsset(job.id, generated.bytes, generated.contentType);
        const ready = this.options.database.updateCreativeJob(job.id, {
            status: 'ready', imageUrl: `/api/creative-assets/${job.id}`, videoUrl: null, contentType: generated.contentType, error: null,
          }, new Date().toISOString());
          if (!ready) throw new Error('Creative job disappeared while saving the image.');
          return ready;
        }
        if (TERMINAL_FAILURES.has(result.status)) {
          const failed = this.options.database.updateCreativeJob(job.id, {
            status: 'failed', error: terminalMessage(result.status),
          }, new Date().toISOString());
          return failed ?? { ...job, status: 'failed', error: terminalMessage(result.status), updatedAt: new Date().toISOString() };
        }
        await delay(POLL_INTERVAL_MS, combined);
      }
      return this.markUncertain(job.id, timeout.aborted ? 'Image generation exceeded the time limit. Review the provider task before starting another job.' : UNCERTAIN_MESSAGE);
    } catch (error) {
      const rejectionStatus = preSubmitRejectionStatus(error);
      const status: CreativeImageJobStatus = rejectionStatus ? 'failed' : 'uncertain';
      const message = rejectionStatus === 402 ? 'The image provider reported insufficient credits (HTTP 402). No automatic retry was made.'
        : rejectionStatus === 401 ? 'The image provider rejected its server-side credentials (HTTP 401). No automatic retry was made.'
          : rejectionStatus ? 'The image provider rejected the request. No automatic retry was made.'
        : providerTaskKnown ? 'The provider task was submitted, but its result could not be confirmed. Review provider status before starting another job.' : UNCERTAIN_MESSAGE;
      return this.options.database.updateCreativeJob(job.id, { status, error: message }, new Date().toISOString()) ?? {
        ...job, status, error: message, updatedAt: new Date().toISOString(),
      };
    }
  }

  private async runReservedVideoJob(job: StoredCreativeImageJob, signal: AbortSignal): Promise<StoredCreativeImageJob> {
    const timeout = AbortSignal.timeout(VIDEO_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    let providerTaskKnown = false;
    try {
      if (!job.videoOptions) throw new Error('Video job options are missing.');
      const submission = await this.options.video!.submit(job.imagePrompt, job.videoOptions, combined);
      providerTaskKnown = true;
      const persisted = this.options.database.updateCreativeJob(job.id, {
        status: 'generating', providerTaskId: submission.id, pollingUrl: submission.pollingUrl, error: null,
      }, new Date().toISOString());
      if (!persisted) throw new Error('Creative video job disappeared after provider submission.');

      while (!combined.aborted) {
        const result = await this.options.video!.poll(submission, combined);
        if (result.status === 'Ready') {
          if (!result.downloadVideo) throw new Error('Ready result did not provide a video downloader.');
          const generated = await result.downloadVideo();
          await this.persistAsset(job.id, generated.bytes, generated.contentType);
          const ready = this.options.database.updateCreativeJob(job.id, {
            status: 'ready', imageUrl: null, videoUrl: `/api/creative-assets/${job.id}`, contentType: generated.contentType, error: null,
          }, new Date().toISOString());
          if (!ready) throw new Error('Creative video job disappeared while saving the video.');
          return ready;
        }
        if (TERMINAL_FAILURES.has(result.status)) {
          const failed = this.options.database.updateCreativeJob(job.id, {
            status: 'failed', error: terminalMessage(result.status, 'video'),
          }, new Date().toISOString());
          return failed ?? { ...job, status: 'failed', error: terminalMessage(result.status, 'video'), updatedAt: new Date().toISOString() };
        }
        await delay(POLL_INTERVAL_MS, combined);
      }
      return this.markUncertain(job.id, timeout.aborted ? 'Video generation exceeded the time limit. Review the provider task before starting another job.' : UNCERTAIN_MESSAGE);
    } catch (error) {
      const rejectionStatus = preSubmitRejectionStatus(error);
      const status: CreativeImageJobStatus = rejectionStatus ? 'failed' : 'uncertain';
      const message = rejectionStatus === 402 ? 'The video provider reported insufficient credits (HTTP 402). No automatic retry was made.'
        : rejectionStatus === 401 ? 'The video provider rejected its server-side credentials (HTTP 401). No automatic retry was made.'
          : rejectionStatus ? 'The video provider rejected the request. No automatic retry was made.'
            : providerTaskKnown ? 'The video task was submitted, but its result could not be confirmed. Review provider status before starting another job.' : UNCERTAIN_MESSAGE;
      return this.options.database.updateCreativeJob(job.id, { status, error: message }, new Date().toISOString()) ?? {
        ...job, status, error: message, updatedAt: new Date().toISOString(),
      };
    }
  }

  private async persistAsset(jobId: string, bytes: Uint8Array, contentType: CreativeAsset['contentType']): Promise<void> {
    const maxBytes = contentType === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error('Creative asset exceeded the storage limit.');
    const ext = extensionForContentType(contentType);
    const path = resolve(this.assetDirectory, `${jobId}.${ext}`);
    if (!path.startsWith(`${this.assetDirectory}${sep}`)) throw new Error('Invalid creative asset path.');
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'wx', 0o600);
    let created = true;
    try { await handle.writeFile(bytes); }
    catch (error) {
      try { await handle.close(); } catch { /* Preserve the original write error. */ }
      if (created) try { await rm(path, { force: true }); } catch { /* Retain only an inaccessible partial orphan if cleanup fails. */ }
      created = false;
      throw error;
    } finally {
      if (created) await handle.close();
    }
  }

  private markUncertain(jobId: string, message: string): StoredCreativeImageJob {
    const current = this.options.database.getCreativeJob(jobId);
    const updated = this.options.database.updateCreativeJob(jobId, { status: 'uncertain', error: message }, new Date().toISOString());
    return updated ?? { ...current!, status: 'uncertain', error: message, updatedAt: new Date().toISOString() };
  }
}

export class CreativeServiceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

export function suggestImagePrompt(campaign: Campaign): string {
  return `Create a polished, factual advertising image for ${campaign.product}, intended for ${campaign.audience}. Show a plain unbranded product in an uncluttered composition against a clean neutral backdrop with soft studio lighting. Leave generous clear space for headline text to be added later; keep the scene accurate and free of unapproved claims.`;
}

function publicCreativeJob(job: StoredCreativeImageJob): CreativeImageJob {
  return {
    id: job.id,
    campaignId: job.campaignId,
    headlines: job.headlines,
    imagePrompt: job.imagePrompt,
    mediaType: job.mediaType,
    status: job.status,
    imageUrl: job.imageUrl,
    videoUrl: job.videoUrl,
    videoOptions: job.videoOptions,
    error: job.error,
    providerTaskId: job.providerTaskId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    outputs: job.outputs.map(({ pollingUrl: _pollingUrl, contentType: _contentType, mediaType: _mediaType, ...output }) => output),
    visualMode: job.visualMode,
  };
}

function extensionForContentType(contentType: CreativeAsset['contentType']): 'png' | 'jpg' | 'webp' | 'mp4' {
  return contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : 'mp4';
}

function isImageContentType(value: string): value is 'image/png' | 'image/jpeg' | 'image/webp' {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

function terminalMessage(status: string, mediaType: 'image' | 'video' = 'image'): string {
  if (status === 'Request Moderated' || status === 'Content Moderated') return `The ${mediaType} request was moderated and no asset was produced.`;
  if (status === 'Task not found') return `The provider could not find the submitted ${mediaType} task.`;
  return `The provider could not complete the ${mediaType} task.`;
}

function timeoutMessage(mediaType: 'image' | 'video'): string {
  return `${mediaType === 'image' ? 'Image' : 'Video'} generation exceeded the time limit. Review the provider task before starting another job.`;
}

function preSubmitRejectionStatus(error: unknown): number | undefined {
  if (!(error instanceof ProviderError) || error.code !== 'request') return undefined;
  const match = /^BFL(?: video)? request failed with HTTP (400|401|402|403|404|422)\.$/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
