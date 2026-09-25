import { ProviderError, boundedText, cancelBody, object, readBytesBounded, readJson, rejectRedirect, timeoutSignal, type FetchLike } from './common.js';

const BFL_API_HOST = /^api(?:\.[a-z0-9-]+)?\.bfl\.ai$/i;
const ALLOWED_STATUSES = new Set(['Pending', 'Reasoning', 'Generating', 'Ready', 'Error', 'Failed', 'Request Moderated', 'Content Moderated', 'Task not found']);
export type BflSubmission = { id: string; pollingUrl: string };
export type GeneratedImage = { bytes: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/webp' };

export class BflClient {
  private readonly apiKey: string;
  private readonly model: string;
  constructor(apiKey: string, private fetchImpl: FetchLike = fetch, model = 'flux-2-pro') {
    this.apiKey = boundedText(apiKey, 'BFL_API_KEY', 4096);
    this.model = boundedText(model, 'BFL_MODEL', 100);
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(this.model)) throw new ProviderError('BFL_MODEL must be a model endpoint name.', 'configuration');
  }

  async submit(prompt: string, width = 1024, height = 1024, signal?: AbortSignal): Promise<BflSubmission> {
    const cleanPrompt = boundedText(prompt, 'prompt', 4_000);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 256 || height < 256 || width > 2048 || height > 2048) throw new ProviderError('Image dimensions must be integers from 256 to 2048.', 'configuration');
    const timeout = timeoutSignal(30_000, signal);
    try {
      const body = this.model === 'flux-2-pro'
        ? { prompt: cleanPrompt, width, height, disable_pup: true }
        : { prompt: cleanPrompt, width, height };
      const response = await this.fetchImpl(`https://api.bfl.ai/v1/${this.model}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-key': this.apiKey }, body: JSON.stringify(body), redirect: 'error', signal: timeout.signal });
      await rejectRedirect(response);
      if (!response.ok) { await cancelBody(response); throw new ProviderError(`BFL request failed with HTTP ${response.status}.`); }
      const result = object(await readJson(response, 64_000, timeout.signal));
      const id = boundedText(result.id, 'BFL task ID', 200); const pollingUrl = boundedText(result.polling_url, 'BFL polling URL', 2_000);
      assertPollingUrl(pollingUrl, id);
      return { id, pollingUrl };
    } catch (e) { if (timeout.signal.aborted) throw new ProviderError(signal?.aborted ? 'BFL request was cancelled.' : 'BFL request timed out.', 'timeout'); if (e instanceof ProviderError) throw e; throw new ProviderError('BFL request failed.'); }
    finally { timeout.dispose(); }
  }

  async poll(submission: BflSubmission, signal?: AbortSignal): Promise<{ status: string; downloadImage?: () => Promise<GeneratedImage> }> {
    const id = boundedText(submission?.id, 'BFL task ID', 200);
    assertPollingUrl(submission?.pollingUrl, id);
    const timeout = timeoutSignal(15_000, signal);
    try {
      const response = await this.fetchImpl(submission.pollingUrl, { headers: { accept: 'application/json', 'x-key': this.apiKey }, redirect: 'error', signal: timeout.signal });
      await rejectRedirect(response);
      if (!response.ok) { await cancelBody(response); throw new ProviderError(`BFL polling failed with HTTP ${response.status}.`); }
      const result = object(await readJson(response, 64_000, timeout.signal));
      if (result.id !== id) throw new ProviderError('BFL returned a result for a different task.', 'response');
      if (typeof result.status !== 'string' || !ALLOWED_STATUSES.has(result.status)) throw new ProviderError('BFL returned an unknown task status.', 'response');
      if (result.status !== 'Ready') return { status: result.status };
      const sample = object(result.result).sample;
      if (typeof sample !== 'string') throw new ProviderError('BFL ready response did not include an image URL.', 'response');
      return { status: 'Ready', downloadImage: () => this.downloadImage(sample, signal) };
    } catch (e) { if (timeout.signal.aborted) throw new ProviderError(signal?.aborted ? 'BFL request was cancelled.' : 'BFL request timed out.', 'timeout'); if (e instanceof ProviderError) throw e; throw new ProviderError('BFL request failed.'); }
    finally { timeout.dispose(); }
  }

  private async downloadImage(rawUrl: string, signal?: AbortSignal): Promise<GeneratedImage> {
    let url: URL; try { url = new URL(rawUrl); } catch { throw new ProviderError('BFL image URL was invalid.', 'response'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^delivery\.[a-z0-9-]+\.bfl\.ai$/i.test(url.hostname)) throw new ProviderError('BFL image URL host was not allowed.', 'response');
    const timeout = timeoutSignal(20_000, signal);
    try {
      const response = await this.fetchImpl(url, { redirect: 'error', signal: timeout.signal });
      await rejectRedirect(response);
      if (!response.ok) { await cancelBody(response); throw new ProviderError(`BFL image download failed with HTTP ${response.status}.`); }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/webp') { await cancelBody(response); throw new ProviderError('BFL image had an unsupported content type.', 'response'); }
      const buffer = await readBytesBounded(response, 20 * 1024 * 1024, timeout.signal);
      if (buffer.byteLength === 0 || buffer.byteLength > 20 * 1024 * 1024) throw new ProviderError('BFL image exceeded the 20 MB limit or was empty.', 'response');
      const signatureOk = type === 'image/png' ? buffer.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => buffer[index] === byte)
        : type === 'image/jpeg' ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
          : buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
      if (!signatureOk) throw new ProviderError('BFL image bytes did not match the content type.', 'response');
      return { bytes: buffer, contentType: type };
    } catch (e) { if (timeout.signal.aborted) throw new ProviderError(signal?.aborted ? 'BFL request was cancelled.' : 'BFL image download timed out.', 'timeout'); if (e instanceof ProviderError) throw e; throw new ProviderError('BFL image download failed.'); }
    finally { timeout.dispose(); }
  }
}

function assertPollingUrl(raw: string, expectedId: string): void {
  let url: URL; try { url = new URL(raw); } catch { throw new ProviderError('BFL polling URL was invalid.', 'response'); }
  const ids = url.searchParams.getAll('id');
  if (url.protocol !== 'https:' || !BFL_API_HOST.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/v1/get_result' || ids.length !== 1 || ids[0] !== expectedId || [...url.searchParams.keys()].some(key => key !== 'id') || url.hash) {
    throw new ProviderError('BFL polling URL was invalid.', 'response');
  }
}
