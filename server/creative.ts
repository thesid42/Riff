import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Campaign } from '../shared/types.js';
import type { CreativeImageJob, CreativeImageJobStatus, CreativeImageRequest, CreativeVideoOptions, CreativeVideoRequest } from '../shared/creative.js';
import { ProviderError, type BflClient, type LiquidClient } from './providers/index.js';
import { CampaignDatabase, type StoredCreativeImageJob } from './database.js';

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

  getCampaignCreative(campaign: Campaign): { imagePromptSuggestion: string; capabilities: { image: true; video: boolean }; jobs: CreativeImageJob[] } {
    return {
      imagePromptSuggestion: suggestImagePrompt(campaign),
      capabilities: { image: true, video: this.options.videoEnabled && !!this.options.video },
      jobs: this.options.database.listCreativeJobs(campaign.id),
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
      this.options.bflModel, IMAGE_WIDTH, IMAGE_HEIGHT, signal, (job, jobSignal) => this.runReservedImageJob(job, jobSignal));
  }

  async createVideoJob(campaign: Campaign, request: CreativeVideoRequest, signal?: AbortSignal): Promise<CreativeImageJob> {
    if (!this.options.videoEnabled || !this.options.video) throw new CreativeServiceError(503, 'video_provider_unavailable', 'Video generation is disabled or not configured.');
    if (this.closing) throw new CreativeServiceError(503, 'server_closing', 'The server is shutting down.');
    return this.reserveAndRun(campaign.id, request.requestId, request.headlines, request.imagePrompt, 'video', request.videoOptions,
      this.options.videoModel, 0, 0, signal, (job, jobSignal) => this.runReservedVideoJob(job, jobSignal));
  }

  private async reserveAndRun(campaignId: string, id: string, headlines: string[], imagePrompt: string, mediaType: 'image' | 'video',
    videoOptions: CreativeVideoOptions | null, model: string, width: number, height: number, signal: AbortSignal | undefined,
    run: (job: StoredCreativeImageJob, signal: AbortSignal) => Promise<StoredCreativeImageJob>): Promise<CreativeImageJob> {
    const now = new Date().toISOString();
    const requestHash = createHash('sha256').update(JSON.stringify({ campaignId, headlines, imagePrompt, mediaType, videoOptions, model, width, height })).digest('hex');
    const reserved = this.options.database.reserveCreativeJob({
      id, campaignId, requestHash, headlines, imagePrompt, mediaType, videoOptions, model, width, height,
      status: 'submitting', imageUrl: null, videoUrl: null, error: null, providerTaskId: null, pollingUrl: null,
      contentType: null, createdAt: now, updatedAt: now,
    });
    if (reserved.kind === 'existing') return publicCreativeJob(reserved.job);
    if (reserved.kind === 'conflict') throw new CreativeServiceError(409, 'idempotency_conflict', 'This request ID is already bound to different media job details.');
    if (reserved.kind === 'busy') throw new CreativeServiceError(409, 'campaign_media_job_active', 'This campaign already has a media job in progress or awaiting review.');

    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    this.activeControllers.add(controller);
    const task = Promise.resolve().then(() => run(reserved.job, controller.signal));
    this.activeTasks.add(task);
    try { return publicCreativeJob(await task); }
    finally {
      this.activeControllers.delete(controller);
      this.activeTasks.delete(task);
    }
  }

  async getAsset(jobId: string): Promise<CreativeAsset | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) return undefined;
    const job = this.options.database.getCreativeJob(jobId);
    if (!job || job.status !== 'ready' || !job.contentType) return undefined;
    if (job.mediaType === 'image' && (job.imageUrl !== `/api/creative-assets/${job.id}` || !isImageContentType(job.contentType))) return undefined;
    if (job.mediaType === 'video' && (job.videoUrl !== `/api/creative-assets/${job.id}` || job.contentType !== 'video/mp4')) return undefined;
    const ext = extensionForContentType(job.contentType);
    const path = resolve(this.assetDirectory, `${job.id}.${ext}`);
    if (!path.startsWith(`${this.assetDirectory}${sep}`)) return undefined;
    try {
      const info = await stat(path);
      const maxBytes = job.mediaType === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (info.size === 0 || info.size > maxBytes) return undefined;
      const bytes = await readFile(path);
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return undefined;
      return { bytes, contentType: job.contentType, mediaType: job.mediaType };
    } catch { return undefined; }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.activeControllers) controller.abort(new Error('Server shutdown'));
    await Promise.allSettled([...this.activeTasks]);
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
