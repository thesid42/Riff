import { afterEach, describe, expect, it, vi } from 'vitest';
import { BflVideoClient, type BflVideoOptions } from '../server/providers/bfl-video.js';
import { ProviderError, type FetchLike } from '../server/providers/common.js';

const taskId = 'video-task-123';
const pollingUrl = `https://api.bfl.ai/v1/get_result?id=${taskId}`;
const options: BflVideoOptions = {
  durationSeconds: 8,
  resolution: 'hd',
  aspectRatio: '16:9',
  generateAudio: true,
  draft: false,
};

afterEach(() => vi.useRealTimers());

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function captureFetch(result: (url: URL, init: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; calls: Array<{ url: URL; init: RequestInit }> } {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    return result(url, init);
  };
  return { fetch, calls };
}

function mp4Bytes(): Uint8Array {
  return new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]);
}

describe('BFL video adapter', () => {
  it('submits text-to-video with the documented FLUX 3 field names and validated options', async () => {
    const fixture = captureFetch(url => {
      expect(url.href).toBe('https://api.bfl.ai/v1/flux-3-video');
      return responseJson({ id: taskId, polling_url: pollingUrl });
    });
    const client = new BflVideoClient('bfl-video-secret', fixture.fetch);
    await expect(client.submit('A red fox running through dawn mist.', {
      durationSeconds: 20,
      resolution: 'fhd',
      aspectRatio: '9:16',
      generateAudio: false,
      draft: false,
    })).resolves.toEqual({ id: taskId, pollingUrl });
    const { init } = fixture.calls[0];
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', accept: 'application/json', 'x-key': 'bfl-video-secret' });
    expect(JSON.parse(String(init.body))).toEqual({
      mode: 't2v',
      prompt: 'A red fox running through dawn mist.',
      duration: 20,
      aspect_ratio: '9:16',
      resolution: 'fhd',
      generate_audio: false,
      draft: false,
    });
  });

  it('rejects invalid prompts, models, and generation options before fetching', async () => {
    const fixture = captureFetch(() => responseJson({ id: taskId, polling_url: pollingUrl }));
    const client = new BflVideoClient('bfl-secret', fixture.fetch);
    const invalidOptions: unknown[] = [
      { ...options, durationSeconds: 4 },
      { ...options, durationSeconds: 20.5 },
      { ...options, durationSeconds: 21 },
      { ...options, resolution: 'qhd' },
      { ...options, aspectRatio: '4:3' },
      { ...options, generateAudio: 'true' },
      { ...options, draft: true, resolution: 'fhd' },
      undefined,
    ];
    for (const invalid of invalidOptions) {
      await expect(client.submit('A fox in the forest.', invalid as BflVideoOptions)).rejects.toMatchObject({ code: 'configuration' });
    }
    await expect(client.submit('   ', options)).rejects.toMatchObject({ code: 'configuration' });
    await expect(client.submit('x'.repeat(4_001), options)).rejects.toMatchObject({ code: 'configuration' });
    expect(() => new BflVideoClient('key', fixture.fetch, 'flux-3-video-preview')).toThrow(ProviderError);
    expect(fixture.calls).toHaveLength(0);
  });

  it('rejects attacker-controlled polling URLs and mismatched task IDs before sending credentials', async () => {
    const fixture = captureFetch(() => responseJson({ id: taskId, status: 'Pending' }));
    const client = new BflVideoClient('bfl-secret', fixture.fetch);
    await expect(client.poll({ id: taskId, pollingUrl: 'https://evil.example/v1/get_result?id=video-task-123' })).rejects.toMatchObject({ code: 'response' });
    await expect(client.poll({ id: taskId, pollingUrl: 'https://api.bfl.ai.evil.example/v1/get_result?id=video-task-123' })).rejects.toMatchObject({ code: 'response' });
    await expect(client.poll({ id: taskId, pollingUrl: `https://api.bfl.ai/v1/get_result?id=someone-else` })).rejects.toMatchObject({ code: 'response' });
    await expect(client.poll({ id: `${taskId}\n`, pollingUrl })).rejects.toMatchObject({ code: 'response' });
    expect(fixture.calls).toHaveLength(0);
  });

  it('returns the signed MP4 downloader only for Ready tasks and does not forward the API key', async () => {
    const bytes = mp4Bytes();
    const signedUrl = 'https://delivery.us.bfl.ai/video.mp4?signature=short-lived';
    const fixture = captureFetch(url => url.pathname === '/v1/get_result'
      ? responseJson({ id: taskId, status: 'Ready', result: { sample: signedUrl } })
      : new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
    const client = new BflVideoClient('private-bfl-secret', fixture.fetch);
    const ready = await client.poll({ id: taskId, pollingUrl });
    expect(ready.status).toBe('Ready');
    await expect(ready.downloadVideo?.()).resolves.toEqual({ bytes, contentType: 'video/mp4' });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[0].init.headers).toMatchObject({ 'x-key': 'private-bfl-secret' });
    expect(fixture.calls[1].url.href).toBe(signedUrl);
    expect(fixture.calls[1].init.headers).toBeUndefined();
    expect(fixture.calls[1].init.redirect).toBe('error');
  });

  it('rejects unsupported video result hosts without making a download request', async () => {
    const fixture = captureFetch(() => responseJson({ id: taskId, status: 'Ready', result: { sample: 'https://delivery.bfl.ai/video.mp4' } }));
    const client = new BflVideoClient('bfl-secret', fixture.fetch);
    const ready = await client.poll({ id: taskId, pollingUrl });
    await expect(ready.downloadVideo?.()).rejects.toMatchObject({ code: 'response', message: 'BFL video URL host was not allowed.' });
    expect(fixture.calls).toHaveLength(1);
  });

  it('bounds MP4 downloads and checks content type plus ftyp signature', async () => {
    const signedUrl = 'https://delivery.us.bfl.ai/video.mp4';
    const tooLarge = new BflVideoClient('key', async input => {
      if (String(input).includes('/get_result')) return responseJson({ id: taskId, status: 'Ready', result: { sample: signedUrl } });
      return new Response(mp4Bytes(), { headers: { 'content-type': 'video/mp4', 'content-length': String(100 * 1024 * 1024 + 1) } });
    });
    const tooLargeReady = await tooLarge.poll({ id: taskId, pollingUrl });
    await expect(tooLargeReady.downloadVideo?.()).rejects.toMatchObject({ code: 'response', message: 'Provider response exceeded the size limit.' });

    const wrongType = new BflVideoClient('key', async input => String(input).includes('/get_result')
      ? responseJson({ id: taskId, status: 'Ready', result: { sample: signedUrl } })
      : new Response(mp4Bytes(), { headers: { 'content-type': 'application/octet-stream' } }));
    const wrongTypeReady = await wrongType.poll({ id: taskId, pollingUrl });
    await expect(wrongTypeReady.downloadVideo?.()).rejects.toMatchObject({ code: 'response', message: 'BFL video had an unsupported content type.' });

    const invalidMp4 = new BflVideoClient('key', async input => String(input).includes('/get_result')
      ? responseJson({ id: taskId, status: 'Ready', result: { sample: signedUrl } })
      : new Response(new Uint8Array(16), { headers: { 'content-type': 'video/mp4' } }));
    const invalidReady = await invalidMp4.poll({ id: taskId, pollingUrl });
    await expect(invalidReady.downloadVideo?.()).rejects.toMatchObject({ code: 'response', message: 'BFL video bytes did not match the MP4 content type.' });
  });

  it('returns terminal task statuses without a downloader and sanitizes terminal HTTP errors', async () => {
    let status = 'Request Moderated';
    const fixture = captureFetch(() => responseJson({ id: taskId, status, result: null }));
    const client = new BflVideoClient('bfl-secret', fixture.fetch);
    await expect(client.poll({ id: taskId, pollingUrl })).resolves.toEqual({ status: 'Request Moderated' });
    status = 'Failed';
    await expect(client.poll({ id: taskId, pollingUrl })).resolves.toEqual({ status: 'Failed' });
    status = 'Error';
    await expect(client.poll({ id: taskId, pollingUrl })).resolves.toEqual({ status: 'Error' });
    status = 'Unrecognized';
    await expect(client.poll({ id: taskId, pollingUrl })).rejects.toMatchObject({ code: 'response', message: 'BFL returned an unknown video task status.' });

    const failedResponse = new BflVideoClient('key', async () => new Response('raw private provider detail', { status: 503 }));
    await expect(failedResponse.poll({ id: taskId, pollingUrl })).rejects.toMatchObject({ message: 'BFL video polling failed with HTTP 503.' });
  });

  it('keeps the timeout active while consuming response bodies and cancels a stalled body', async () => {
    vi.useFakeTimers();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"video-task-123",')); },
      pull() { return new Promise<void>(() => {}); },
      cancel() { canceled = true; },
    });
    const client = new BflVideoClient('bfl-secret', async () => new Response(stream));
    const pending = client.submit('A fox runs through dawn mist.', options);
    const expectedTimeout = expect(pending).rejects.toMatchObject({ code: 'timeout', message: 'BFL video request timed out.' });
    await vi.advanceTimersByTimeAsync(30_000);
    await expectedTimeout;
    expect(canceled).toBe(true);
  });

  it('sanitizes network failures and rejects redirected API responses', async () => {
    const leaking = new BflVideoClient('bfl-secret', async () => { throw new TypeError('https://api.bfl.ai/private?key=bfl-secret'); });
    await expect(leaking.submit('A fox in dawn mist.', options)).rejects.toMatchObject({ message: 'BFL video request failed.' });

    const redirectedResponse = responseJson({ id: taskId, status: 'Pending' });
    Object.defineProperty(redirectedResponse, 'redirected', { value: true });
    const redirected = new BflVideoClient('bfl-secret', async () => redirectedResponse);
    await expect(redirected.poll({ id: taskId, pollingUrl })).rejects.toMatchObject({ code: 'response', message: 'Provider redirected a request unexpectedly.' });
  });
});
