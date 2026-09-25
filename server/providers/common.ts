export type FetchLike = typeof fetch;

export class ProviderError extends Error {
  constructor(message: string, readonly code: 'configuration' | 'request' | 'response' | 'timeout' = 'request') {
    super(message);
    this.name = 'ProviderError';
  }
}

export function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new ProviderError(`${name} must be a non-empty string of at most ${max} characters.`, 'response');
  }
  return value.trim();
}

export function safeBaseUrl(value: string, name: string, protocols: string[] = ['https:']): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError(`${name} must be a valid URL.`, 'configuration'); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError(`${name} must be an absolute ${protocols.join(' or ')} URL without credentials or query parameters.`, 'configuration');
  }
  return url;
}

export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Provider request timed out')), ms);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

export async function rejectRedirect(response: Response): Promise<void> {
  if (!response.redirected) return;
  await cancelBody(response);
  throw new ProviderError('Provider redirected a request unexpectedly.', 'response');
}

export async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* A response body may already be closed. */ }
}

export async function readJson(response: Response, maxBytes = 256_000, signal?: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { await cancelBody(response); throw new ProviderError('Provider response exceeded the size limit.', 'response'); }
  if (!response.body) throw new ProviderError('Provider returned an empty response.', 'response');
  const bytes = await readBytesBounded(response, maxBytes, signal);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new ProviderError('Provider returned malformed JSON.', 'response'); }
}

export async function readTextBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { await cancelBody(response); throw new ProviderError('Provider response exceeded the size limit.', 'response'); }
  if (!response.body) return '';
  const bytes = await readBytesBounded(response, maxBytes, signal);
  return new TextDecoder().decode(bytes);
}

export async function readBytesBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { await cancelBody(response); throw new ProviderError('Provider response exceeded the size limit.', 'response'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      size += value.byteLength; if (size > maxBytes) { await cancelReader(reader); throw new ProviderError('Provider response exceeded the size limit.', 'response'); }
      chunks.push(value);
    }
  } finally { try { reader.releaseLock(); } catch { /* A cancelled pending read can keep its lock briefly. */ } }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Provider request aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      void cancelReader(reader);
      reject(signal.reason ?? new Error('Provider request aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try { await reader.cancel(); } catch { /* The stream may already be errored or closed. */ }
}

export function object(value: unknown, message = 'Provider returned an invalid response.'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError(message, 'response');
  return value as Record<string, unknown>;
}

export function configStatus(value: string | undefined): boolean { return typeof value === 'string' && value.trim().length > 0; }
