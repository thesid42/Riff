import { ProviderError, boundedText, cancelBody, object, readBytesBounded, readJson, rejectRedirect, timeoutSignal, type FetchLike } from './common.js';

const API_HOST = /^api(?:\.[a-z0-9-]+)?\.bfl\.ai$/i;
const VIDEO_DELIVERY_HOST = /^delivery\.[a-z0-9-]+\.bfl\.ai$/i;
const ALLOWED_STATUSES = new Set(['Pending', 'Reasoning', 'Generating', 'Ready', 'Error', 'Request Moderated', 'Content Moderated', 'Task not found']);
const MAX_MP4_BYTES = 100 * 1024 * 1024;

export type BflVideoOptions = {
  durationSeconds: number;
  resolution: 'hd' | 'fhd';
  aspectRatio: '1:1' | '16:9' | '9:16';
  generateAudio: boolean;
  draft: boolean;
};

export type BflVideoSubmission = { id: string; pollingUrl: string };
export type GeneratedVideo = { bytes: Uint8Array; contentType: 'video/mp4' };
export type BflVideoPoll = { status: string; downloadVideo?: () => Promise<GeneratedVideo> };

/** Text-to-video client for the pinned FLUX 3 endpoint. */
export class BflVideoClient {
  private readonly apiKey: string;

  constructor(apiKey: string, private readonly fetchImpl: FetchLike = fetch, model = 'flux-3-video') {
    this.apiKey = boundedText(apiKey, 'BFL_API_KEY', 4096);
    const configuredModel = boundedText(model, 'BFL_VIDEO_MODEL', 100);
    if (configuredModel !== 'flux-3-video') {
      throw new ProviderError('BFL_VIDEO_MODEL must be flux-3-video until additional video request schemas are supported.', 'configuration');
    }
  }

  async submit(prompt: string, options: BflVideoOptions, signal?: AbortSignal): Promise<BflVideoSubmission> {
    const cleanPrompt = validatePrompt(prompt);
    const cleanOptions = validateOptions(options);
    const timeout = timeoutSignal(30_000, signal);
    try {
      const response = await this.fetchImpl('https://api.bfl.ai/v1/flux-3-video', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-key': this.apiKey },
        body: JSON.stringify({
          mode: 't2v',
          prompt: cleanPrompt,
          duration: cleanOptions.durationSeconds,
          aspect_ratio: cleanOptions.aspectRatio,
          resolution: cleanOptions.resolution,
          generate_audio: cleanOptions.generateAudio,
          draft: cleanOptions.draft,
        }),
        redirect: 'error',
        signal: timeout.signal,
      });
      await rejectRedirect(response);
      if (!response.ok) {
        await cancelBody(response);
        throw new ProviderError(`BFL video request failed with HTTP ${response.status}.`);
      }
      const result = object(await readJson(response, 64_000, timeout.signal));
      const id = taskId(result.id);
      const pollingUrl = boundedText(result.polling_url, 'BFL video polling URL', 2_000);
      assertPollingUrl(pollingUrl, id);
      return { id, pollingUrl };
    } catch (error) {
      if (timeout.signal.aborted) throw timeoutError(signal, 'BFL video request');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('BFL video request failed.');
    } finally {
      timeout.dispose();
    }
  }

  async poll(submission: BflVideoSubmission, signal?: AbortSignal): Promise<BflVideoPoll> {
    const id = taskId(submission?.id);
    assertPollingUrl(submission?.pollingUrl, id);
    const timeout = timeoutSignal(15_000, signal);
    try {
      const response = await this.fetchImpl(submission.pollingUrl, {
        headers: { accept: 'application/json', 'x-key': this.apiKey },
        redirect: 'error',
        signal: timeout.signal,
      });
      await rejectRedirect(response);
      if (!response.ok) {
        await cancelBody(response);
        throw new ProviderError(`BFL video polling failed with HTTP ${response.status}.`);
      }
      const result = object(await readJson(response, 64_000, timeout.signal));
      if (result.id !== id) throw new ProviderError('BFL returned a result for a different video task.', 'response');
      if (typeof result.status !== 'string' || !ALLOWED_STATUSES.has(result.status)) throw new ProviderError('BFL returned an unknown video task status.', 'response');
      if (result.status !== 'Ready') return { status: result.status };
      const videoUrl = object(result.result, 'BFL ready response did not include a video result.').sample;
      if (typeof videoUrl !== 'string') throw new ProviderError('BFL ready response did not include a video URL.', 'response');
      return { status: 'Ready', downloadVideo: () => this.downloadVideo(videoUrl, signal) };
    } catch (error) {
      if (timeout.signal.aborted) throw timeoutError(signal, 'BFL video polling');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('BFL video polling failed.');
    } finally {
      timeout.dispose();
    }
  }

  private async downloadVideo(rawUrl: string, signal?: AbortSignal): Promise<GeneratedVideo> {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new ProviderError('BFL video URL was invalid.', 'response'); }
    // FLUX 3 documents a signed MP4 result URL but does not publish its hostname.
    // Keep the existing narrow BFL delivery boundary until video-specific host support is verified.
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !VIDEO_DELIVERY_HOST.test(url.hostname)) {
      throw new ProviderError('BFL video URL host was not allowed.', 'response');
    }
    const timeout = timeoutSignal(60_000, signal);
    try {
      const response = await this.fetchImpl(url, { redirect: 'error', signal: timeout.signal });
      await rejectRedirect(response);
      if (!response.ok) {
        await cancelBody(response);
        throw new ProviderError(`BFL video download failed with HTTP ${response.status}.`);
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type !== 'video/mp4') {
        await cancelBody(response);
        throw new ProviderError('BFL video had an unsupported content type.', 'response');
      }
      const bytes = await readBytesBounded(response, MAX_MP4_BYTES, timeout.signal);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_MP4_BYTES) {
        throw new ProviderError('BFL video exceeded the 100 MB limit or was empty.', 'response');
      }
      if (!hasMp4Ftyp(bytes)) throw new ProviderError('BFL video bytes did not match the MP4 content type.', 'response');
      return { bytes, contentType: 'video/mp4' };
    } catch (error) {
      if (timeout.signal.aborted) throw timeoutError(signal, 'BFL video download');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('BFL video download failed.');
    } finally {
      timeout.dispose();
    }
  }
}

function validatePrompt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_000) {
    throw new ProviderError('prompt must be a non-empty string of at most 4000 characters.', 'configuration');
  }
  return value.trim();
}

function validateOptions(value: BflVideoOptions): BflVideoOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('BFL video options are required.', 'configuration');
  const { durationSeconds, resolution, aspectRatio, generateAudio, draft } = value;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 20) {
    throw new ProviderError('Video duration must be a whole number from 5 to 20 seconds.', 'configuration');
  }
  if (resolution !== 'hd' && resolution !== 'fhd') throw new ProviderError('Video resolution must be hd or fhd.', 'configuration');
  if (aspectRatio !== '1:1' && aspectRatio !== '16:9' && aspectRatio !== '9:16') {
    throw new ProviderError('Video aspect ratio must be 1:1, 16:9, or 9:16.', 'configuration');
  }
  if (typeof generateAudio !== 'boolean' || typeof draft !== 'boolean') {
    throw new ProviderError('generateAudio and draft must be booleans.', 'configuration');
  }
  if (draft && resolution !== 'hd') throw new ProviderError('BFL video draft mode is available only at hd resolution.', 'configuration');
  return { durationSeconds, resolution, aspectRatio, generateAudio, draft };
}

function assertPollingUrl(raw: unknown, expectedId: string): void {
  let url: URL;
  try { url = new URL(boundedText(raw, 'BFL video polling URL', 2_000)); } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('BFL video polling URL was invalid.', 'response');
  }
  const ids = url.searchParams.getAll('id');
  if (url.protocol !== 'https:' || !API_HOST.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/v1/get_result' || ids.length !== 1 || ids[0] !== expectedId || [...url.searchParams.keys()].some(key => key !== 'id') || url.hash) {
    throw new ProviderError('BFL video polling URL was invalid.', 'response');
  }
}

function taskId(value: unknown): string {
  const id = boundedText(value, 'BFL video task ID', 200);
  if (id !== value || /[\u0000-\u0020\u007f]/.test(id)) {
    throw new ProviderError('BFL video task ID was invalid.', 'response');
  }
  return id;
}

function hasMp4Ftyp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  return boxSize >= 12 && boxSize <= bytes.byteLength
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

function timeoutError(signal: AbortSignal | undefined, operation: string): ProviderError {
  return new ProviderError(signal?.aborted ? `${operation} was cancelled.` : `${operation} timed out.`, 'timeout');
}
