// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CreativeComposer from '../src/CreativeComposer.js';
import PersonaWave from '../src/PersonaWave.js';
import type { Campaign } from '../shared/types.js';
import type { CreativeImageJob, CreativeVariantOutput } from '../shared/creative.js';

const timestamp = '2026-09-25T18:00:00.000Z';
const campaign: Campaign = {
  id: 'campaign-image-test', name: 'Bottle launch', product: '750 ml bottle', audience: 'First-time visitors',
  goal: 'signups', approvedClaims: ['750 ml capacity', 'Stainless steel'], budgetCents: 5000, currency: 'USD',
  status: 'draft', runtime: 'idle', agentCount: 40, concurrency: 8, headlines: [], customPersonas: [], createdAt: timestamp, updatedAt: timestamp,
};

function job(overrides: Partial<CreativeImageJob> = {}): CreativeImageJob {
  return {
    id: 'creative-job-1', campaignId: campaign.id, headlines: ['Edited headline A', 'Headline B'], imagePrompt: 'Warm studio image',
    mediaType: 'image', status: 'ready', imageUrl: '/api/creative-assets/creative-job-1', videoUrl: null, videoOptions: null,
    error: null, providerTaskId: null, createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

interface Submission { requestId: string; headlines: string[]; imagePrompt: string; variantPrompts: string[] }
let canvasSupportCleanup: (() => void) | null = null;

function output(overrides: Partial<CreativeVariantOutput> = {}) {
  return {
    id: 'creative-output-a', index: 0, headline: 'A reviewed headline', imagePrompt: 'Clean product hero', status: 'ready' as const,
    imageUrl: '/api/creative-assets/creative-output-a', videoUrl: null, error: null, providerTaskId: null,
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

function distinctJob(submission: Submission, status: CreativeImageJob['status'] = 'ready'): CreativeImageJob {
  return {
    id: 'creative-job-distinct', campaignId: campaign.id, headlines: submission.headlines, imagePrompt: submission.imagePrompt,
    mediaType: 'image', status, imageUrl: null, videoUrl: null, videoOptions: null, error: null, providerTaskId: null,
    createdAt: timestamp, updatedAt: timestamp, visualMode: 'distinct',
    outputs: submission.headlines.map((headline, index) => output({
      id: `creative-output-${index + 1}`, index, headline, imagePrompt: submission.variantPrompts[index]!,
      status: status === 'ready' ? 'ready' : 'generating', imageUrl: status === 'ready' ? `/api/creative-assets/creative-output-${index + 1}` : null,
    })),
  };
}

function installFetch(options: {
  decision?: unknown;
  job?: CreativeImageJob;
  jobs?: CreativeImageJob[];
  jobReads?: CreativeImageJob[][] | ((readIndex: number) => CreativeImageJob[]);
  imageResponses?: Array<(submission: Submission) => { job: CreativeImageJob; status?: number }>;
  videoEnabled?: boolean;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let creativeReads = 0;
  let imagePosts = 0;
  let requestIds = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    let body: unknown;
    let status = 200;
    if (url.endsWith('/creative')) {
      const index = creativeReads++;
      const jobs = typeof options.jobReads === 'function'
        ? options.jobReads(index)
        : options.jobReads?.[Math.min(index, (options.jobReads?.length ?? 1) - 1)] ?? options.jobs ?? [];
      body = { imagePromptSuggestion: 'Bottle on a soft sage studio surface; leave clear space around it.', capabilities: { image: true, video: options.videoEnabled ?? false }, jobs };
    }
    else if (url.endsWith('/creative/plan')) body = { decision: options.decision ?? { action: 'propose_test', explanation: 'Compare two factual headlines.', hypothesis: 'The capacity detail may help visitors understand the product.', headlines: ['A 750 ml bottle for every day', 'Steel, made for repeat use'], evidenceIds: [] }, metadata: { model: 'fixture', elapsedMs: 42 } };
    else if (url.endsWith('/creative/images')) {
      const submission = JSON.parse(String(init?.body ?? '{}')) as Submission;
      const response = options.imageResponses?.[imagePosts++];
      if (response) {
        const result = response(submission);
        body = { job: result.job };
        status = result.status ?? 200;
      } else {
        body = { job: options.job ?? job() };
      }
    }
    else body = { error: { message: 'Unexpected test request.' } };
    return new Response(JSON.stringify(body), { status: url.includes('/unexpected') ? 404 : status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', { randomUUID: () => requestIds++ === 0 ? '8b46c732-5db7-4f54-a9e2-9d2a6436e5c1' : 'c1476130-6ee4-47f8-a99b-9a44f50e9612' });
  return calls;
}

afterEach(() => { cleanup(); canvasSupportCleanup?.(); canvasSupportCleanup = null; document.body.style.overflow = ''; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function installCanvasPreviewSupport(deferDecodeAt = -1) {
  const urlsCreated: string[] = [];
  const urlsRevoked: string[] = [];
  let decodeCount = 0;
  let deferredDecodeStarted = false;
  let resolveDeferredDecode: (() => void) | null = null;
  const context = {
    fillRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), rect: vi.fn(), fill: vi.fn(), fillText: vi.fn(),
    measureText: (text: string) => ({ width: Array.from(text).length * 20 }),
    fillStyle: '', font: '', textAlign: 'left', textBaseline: 'top',
  } as unknown as CanvasRenderingContext2D;
  const previousGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  const previousToBlob = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob');
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => context });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', { configurable: true, value: (callback: BlobCallback) => callback(new Blob(['finished-ad'], { type: 'image/png' })) });
  vi.stubGlobal('CanvasRenderingContext2D', class CanvasRenderingContext2DMock {});
  vi.stubGlobal('Image', class ImageMock {
    naturalWidth = 800;
    naturalHeight = 800;
    decoding = 'async';
    src = '';
    decode() {
      decodeCount += 1;
      if (decodeCount === deferDecodeAt) return new Promise<void>((resolve) => { deferredDecodeStarted = true; resolveDeferredDecode = resolve; });
      return Promise.resolve();
    }
  });
  const NativeURL = URL;
  const MockURL = class extends NativeURL {};
  Object.assign(MockURL, {
    createObjectURL: vi.fn(() => {
      const url = `blob:finished-ad-${urlsCreated.length + 1}`;
      urlsCreated.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => { urlsRevoked.push(url); }),
  });
  vi.stubGlobal('URL', MockURL);
  canvasSupportCleanup = () => {
    if (previousGetContext) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', previousGetContext);
    else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext');
    if (previousToBlob) Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', previousToBlob);
    else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'toBlob');
  };
  return { urlsCreated, urlsRevoked, isDeferredDecodeStarted: () => deferredDecodeStarted, resolveDeferredDecode: () => resolveDeferredDecode?.() };
}

async function expandSavedDrafts() {
  const title = await screen.findByText('Saved creative drafts', { exact: true });
  const summary = title.closest('summary');
  const disclosure = title.closest('details');
  if (!summary || !disclosure) throw new Error('Saved draft disclosure was not rendered.');
  if (!disclosure.open) fireEvent.click(summary);
  return disclosure;
}

async function expandVersions() {
  const title = await screen.findByText('Versions', { exact: true });
  const summary = title.closest('summary');
  const disclosure = title.closest('details');
  if (!summary || !disclosure) throw new Error('Versions disclosure was not rendered.');
  if (!disclosure.open) fireEvent.click(summary);
  return disclosure;
}

describe('creative composer', () => {
  it('submits a distinct reviewed direction per headline only after an explicit paid action', async () => {
    const calls = installFetch({ imageResponses: [submission => ({ job: distinctJob(submission) })] });
    render(<CreativeComposer campaign={campaign} />);
    await screen.findByRole('button', { name: 'Suggest headlines' });
    expect((screen.getByRole('button', { name: 'Generate 0 images' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Suggest headlines' }));
    await screen.findByText('Review these headline drafts');
    expect(calls.filter((call) => call.url.endsWith('/creative/images'))).toHaveLength(0);

    await expandVersions();
    fireEvent.change(screen.getByRole('textbox', { name: 'Version A headline' }), { target: { value: 'Edited headline A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add another headline' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Version C headline' }), { target: { value: 'A clear view of 750 ml capacity' } });

    const defaults = ['A', 'B', 'C'].map((version) => (screen.getByRole('textbox', { name: `Version ${version} visual direction` }) as HTMLTextAreaElement).value);
    for (const prompt of defaults) {
      expect(prompt).toContain('750 ml bottle');
      expect(prompt).toContain('named colors, materials, and patterns on their named parts');
      expect(prompt).toMatch(/plain and unbranded/i);
      expect(prompt).toContain('Photography only');
      expect(prompt).toContain('Composition:');
      expect(prompt).toContain('Style:');
      expect(prompt).toContain('Lighting:');
      expect(prompt.length).toBeLessThanOrEqual(4_000);
    }
    expect(new Set(defaults).size).toBe(3);
    expect(defaults[0]).toMatch(/three-quarter hero/i);
    expect(defaults[1]).toMatch(/setting relevant to First-time visitors/i);
    expect(defaults[2]).toMatch(/elevated three-quarter tabletop view/i);

    const customDirection = `${defaults[0]} Add a subtle shift to the camera angle.`;
    fireEvent.change(screen.getByRole('textbox', { name: 'Version A visual direction' }), { target: { value: customDirection } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved jobs' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Generate 3 images' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('textbox', { name: 'Version A visual direction' }) as HTMLTextAreaElement).value).toBe(customDirection);

    fireEvent.click(screen.getByRole('button', { name: 'Generate 3 images' }));
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    expect(within(latest).getByText('3 of 3 separate visuals ready')).toBeTruthy();

    const imageCall = calls.find((call) => call.url.endsWith('/creative/images'));
    expect(imageCall).toBeDefined();
    const body = JSON.parse(String(imageCall?.init?.body)) as Submission;
    expect(body.requestId).toBe('8b46c732-5db7-4f54-a9e2-9d2a6436e5c1');
    expect(body.headlines).toEqual(['Edited headline A', 'Steel, made for repeat use', 'A clear view of 750 ml capacity']);
    expect(body.imagePrompt).toContain('soft sage studio');
    expect(body.variantPrompts).toHaveLength(3);
    expect(body.variantPrompts).toEqual([customDirection, defaults[1], defaults[2]]);
    expect((screen.getByRole('textbox', { name: 'Version A visual direction' }) as HTMLTextAreaElement).value).toBe(customDirection);
    expect(screen.getByText('Uses BFL credits · 3 separate image requests, one per version')).toBeTruthy();
    const previews = within(latest).getAllByRole('img', { name: /Portrait ad preview for Version/ });
    expect(previews).toHaveLength(3);
    expect(latest.querySelectorAll('img.image-ad-source')).toHaveLength(0);
    expect(latest.querySelectorAll('.mock-cta')).toHaveLength(0);
    expect(latest.querySelectorAll('.finished-ad-description')).toHaveLength(3);
    expect(latest.querySelector('.finished-ad-description')?.textContent).toContain('Join the waitlist');

    const savedDirection = [...latest.querySelectorAll<HTMLElement>('.image-job .job-direction summary')]
      .find((summary) => summary.textContent === 'Version A direction');
    expect(savedDirection).toBeDefined();
    fireEvent.click(savedDirection!);
    expect(savedDirection?.closest('.job-direction')?.querySelector('p')?.textContent).toBe(customDirection);
  });

  it('hydrates valid legacy headlines and enables generation without requiring Liquid provenance', async () => {
    const legacy = job({ headlines: ['Saved headline one', 'Saved headline two'] });
    const older = job({ id: 'older-job', headlines: ['Older saved headline one', 'Older saved headline two'], createdAt: '2026-09-24T18:00:00.000Z', updatedAt: '2026-09-24T18:00:00.000Z' });
    installFetch({ jobs: [legacy, older] });
    render(<CreativeComposer campaign={campaign} />);
    const generate = await screen.findByRole('button', { name: 'Generate 2 images' });
    expect((generate as HTMLButtonElement).disabled).toBe(false);
    const versionsTitle = screen.getByText('Versions', { exact: true });
    expect(versionsTitle.closest('details')?.open).toBe(false);
    expect(screen.getByText('Headlines and visual directions')).toBeTruthy();
    await expandVersions();
    expect((screen.getByRole('textbox', { name: 'Version A headline' }) as HTMLInputElement).value).toBe('Saved headline one');
    const latest = screen.getByRole('region', { name: 'Latest creative' });
    expect(within(latest).getByRole('button', { name: 'View image for Version A' })).toBeTruthy();
    const summaryTitle = screen.getByText('Saved creative drafts', { exact: true });
    const closedGallery = summaryTitle.closest('details');
    expect(closedGallery?.open).toBe(false);
    const gallery = await expandSavedDrafts();
    expect(gallery.open).toBe(true);
    expect(within(latest).getByText('One shared visual across versions')).toBeTruthy();
    expect(within(gallery).getByRole('button', { name: 'View image for Version A' })).toBeTruthy();
    expect(within(gallery).getByText('Older saved headline one')).toBeTruthy();
    expect(within(gallery).queryByText('Saved headline one')).toBeNull();
    expect(latest.querySelectorAll('.finished-ad-preview')).toHaveLength(2);
  });

  it('keeps over-limit legacy captions editable and blocks generation until shortened', async () => {
    const longLegacyHeadline = 'A'.repeat(61);
    const legacy = job({ headlines: [longLegacyHeadline, 'A saved alternate headline'] });
    installFetch({ jobs: [legacy] });
    render(<CreativeComposer campaign={campaign} />);

    const generate = await screen.findByRole('button', { name: 'Generate 2 images' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    const versions = screen.getByText('Versions', { exact: true }).closest('details');
    await waitFor(() => expect(versions?.open).toBe(true));
    expect(screen.getByText('Use 2–3 unique headlines, up to 60 characters each. Remove control characters and open Versions to fix them.')).toBeTruthy();

    const headlineInput = screen.getByRole('textbox', { name: 'Version A headline' }) as HTMLInputElement;
    expect(headlineInput.value).toBe(longLegacyHeadline);
    expect(headlineInput.hasAttribute('maxlength')).toBe(false);
    expect(headlineInput.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('61/60')).toBeTruthy();
    expect(screen.getByText('Shorten this headline to 60 characters or fewer.')).toBeTruthy();

    fireEvent.change(headlineInput, { target: { value: 'A shorter saved headline' } });
    await waitFor(() => expect(generate.disabled).toBe(false));

    const latest = screen.getByRole('region', { name: 'Latest creative' });
    expect(within(latest).getByRole('img', { name: 'Portrait ad preview for Version A' })).toBeTruthy();
    expect(screen.getAllByText(longLegacyHeadline)).toHaveLength(1);
    const select = within(latest).getByRole('button', { name: 'Select for experiment' }) as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByText('Saved captions exceed the current 60-character limit and cannot be attached to an experiment.')).toBeTruthy();
  });

  it('counts Unicode code points at the 60-character boundary without truncating UTF-16 input', async () => {
    const exactlySixtyCharacters = `${'A'.repeat(59)}😀`;
    const stored = ['A concise alternate', exactlySixtyCharacters];
    const legacy = job({ headlines: stored });
    installFetch({ jobs: [legacy] });
    render(<CreativeComposer campaign={campaign} />);

    const generate = await screen.findByRole('button', { name: 'Generate 2 images' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(false);
    const headlineInput = screen.getByRole('textbox', { name: 'Version B headline' }) as HTMLInputElement;
    expect(headlineInput.value).toBe(exactlySixtyCharacters);
    expect(headlineInput.hasAttribute('maxlength')).toBe(false);
    expect(screen.getByText('60/60')).toBeTruthy();
  });

  it('blocks experiment start when restored headline copy exceeds 60 characters', () => {
    render(<PersonaWave campaign={campaign} headlines={['A'.repeat(61), 'A concise alternate']} creativeJobId={null}
      onClearCreative={() => {}} wave={null} onWave={() => {}} onCampaign={() => {}} />);
    expect((screen.getByRole('button', { name: 'Start wave' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Shorten headlines to 60 characters or fewer in Campaign before starting.')).toHaveLength(2);
  });

  it('opens Versions for manual entry and keeps hidden invalid-field guidance visible', async () => {
    installFetch();
    render(<CreativeComposer campaign={campaign} />);
    await screen.findByRole('button', { name: 'Write headlines manually' });
    fireEvent.click(screen.getByRole('button', { name: 'Write headlines manually' }));

    const versionTitle = await screen.findByText('Versions', { exact: true });
    const versions = versionTitle.closest('details');
    expect(versions).not.toBeNull();
    await waitFor(() => expect(versions?.open).toBe(true));
    expect(versions.open).toBe(true);
    const first = screen.getByRole('textbox', { name: 'Version A headline' });
    const second = screen.getByRole('textbox', { name: 'Version B headline' });
    fireEvent.change(first, { target: { value: 'A manual headline' } });
    fireEvent.change(second, { target: { value: 'Another manual headline' } });
    expect((screen.getByRole('button', { name: 'Generate 2 images' }) as HTMLButtonElement).disabled).toBe(false);

    const direction = screen.getByRole('textbox', { name: 'Version A visual direction' });
    const validDirection = (direction as HTMLTextAreaElement).value;
    fireEvent.change(direction, { target: { value: '' } });
    expect(screen.getByText('One or more directions need attention. Open Versions to fix them before generating.')).toBeTruthy();
    fireEvent.click(versions.querySelector('summary')!);
    expect(versions.open).toBe(false);
    expect(screen.getByText('One or more directions need attention. Open Versions to fix them before generating.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Generate 2 images' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(versions.querySelector('summary')!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Version A visual direction' }), { target: { value: validDirection } });
    expect((screen.getByRole('button', { name: 'Generate 2 images' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('polls an accepted batch without another POST and uses a fresh key for an explicit regeneration', async () => {
    let polledJob: CreativeImageJob | null = null;
    const calls = installFetch({
      imageResponses: [
        (submission) => {
          polledJob = distinctJob(submission);
          return { job: distinctJob(submission, 'generating'), status: 202 };
        },
        (submission) => ({ job: distinctJob(submission) }),
      ],
      jobReads: (readIndex) => readIndex === 0 || !polledJob ? [] : [polledJob],
    });
    render(<CreativeComposer campaign={{ ...campaign, headlines: ['A 750 ml bottle for every day', 'Steel, made for repeat use'] }} />);
    await screen.findByRole('button', { name: 'Suggest headlines' });
    fireEvent.click(screen.getByRole('button', { name: 'Generate 2 images' }));
    expect(await screen.findByText(/Separate image outputs are processing/)).toBeTruthy();
    await screen.findByRole('button', { name: 'Generate again 2 images' }, { timeout: 5_000 });
    expect(calls.filter((call) => call.url.endsWith('/creative/images'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith('/creative'))).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Generate again 2 images' }));
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/creative/images'))).toHaveLength(2));
    const posts = calls.filter((call) => call.url.endsWith('/creative/images'));
    const first = JSON.parse(String(posts[0]?.init?.body)) as Submission;
    const second = JSON.parse(String(posts[1]?.init?.body)) as Submission;
    expect(second.requestId).not.toBe(first.requestId);
  }, 10_000);

  it('keeps ready variants reviewable when another version failed', async () => {
    const partial = job({
      status: 'failed', visualMode: 'distinct', imageUrl: null, headlines: ['Saved headline one', 'Saved headline two'],
      outputs: [
        output({ id: 'ready-variant', index: 0, headline: 'Saved headline one', imagePrompt: 'Hero', imageUrl: '/api/creative-assets/ready-variant' }),
        output({ id: 'failed-variant', index: 1, headline: 'Saved headline two', imagePrompt: 'Context', status: 'failed', imageUrl: null, error: 'Provider could not finish.' }),
      ],
    });
    installFetch({ jobs: [partial] });
    render(<CreativeComposer campaign={{ ...campaign, headlines: partial.headlines }} />);
    const latest = screen.getByRole('region', { name: 'Latest creative' });
    expect(await within(latest).findByRole('button', { name: 'View image for Version A' })).toBeTruthy();
    expect(within(latest).getByText('1 of 2 separate visuals ready')).toBeTruthy();
    expect(await within(latest).findByText('Provider could not finish.')).toBeTruthy();
  });

  it('keeps video disabled when the server capability is off and exposes invalid Liquid output without a paid call', async () => {
    const calls = installFetch({ decision: { action: 'unknown', headlines: ['unsupported'] } });
    render(<CreativeComposer campaign={campaign} />);
    await screen.findByRole('button', { name: 'Suggest headlines' });
    expect((screen.getByRole('option', { name: 'Video' }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest headlines' }));
    await screen.findByRole('alert');
    expect(document.body.contains(screen.getByText(/Liquid returned an invalid response/))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/creative/images') || call.url.endsWith('/creative/videos'))).toBe(false);
  });

  it('opens a full image in the focused viewer, opens the original separately, and restores focus on Escape without a provider call', async () => {
    const calls = installFetch({ jobs: [job()] });
    document.body.style.overflow = 'clip';
    render(<CreativeComposer campaign={campaign} />);
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    const openButton = within(latest).getByRole('button', { name: 'View image for Version A' });
    openButton.focus();
    fireEvent.click(openButton);

    const dialog = await screen.findByRole('dialog', { name: 'Version A image draft' });
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close media viewer' }));
    const image = dialog.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/api/creative-assets/creative-job-1');
    expect(image?.getAttribute('alt')).toContain('Version A');
    const previous = screen.getByRole('button', { name: 'Previous version' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next version' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    const original = screen.getByRole('link', { name: /Open original/ });
    expect(original.getAttribute('target')).toBe('_blank');
    expect(original.getAttribute('rel')).toContain('noopener');
    next.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(original);
    original.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(next);

    fireEvent.click(next);
    expect(dialog.querySelector('h2')?.textContent).toBe('Version B image draft');
    expect(dialog.querySelector('img')?.getAttribute('alt')).toContain('Version B');
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next version' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(previous);
    expect(dialog.querySelector('h2')?.textContent).toBe('Version A image draft');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openButton);
    expect(document.body.style.overflow).toBe('clip');
    expect(calls.some((call) => call.url.endsWith('/creative/images') || call.url.endsWith('/creative/videos'))).toBe(false);
  });

  it('opens a video with native controls and metadata-only preload, then closes without autoplay or generation', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const videoJob = job({
      id: 'creative-video-1',
      mediaType: 'video',
      imageUrl: null,
      videoUrl: '/api/creative-assets/creative-video-1',
      videoOptions: { durationSeconds: 5, resolution: 'hd', aspectRatio: '1:1', generateAudio: false, draft: true },
    });
    const calls = installFetch({ jobs: [videoJob], videoEnabled: true });
    render(<CreativeComposer campaign={campaign} />);
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    const openButton = within(latest).getByRole('button', { name: 'Watch video for Version A' });
    openButton.focus();
    fireEvent.click(openButton);

    const dialog = await screen.findByRole('dialog', { name: 'Version A video draft' });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    const video = dialog.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.controls).toBe(true);
    expect(video?.preload).toBe('metadata');
    expect(video?.autoplay).toBe(false);
    expect(video?.getAttribute('src')).toBe('/api/creative-assets/creative-video-1');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close media viewer' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close media viewer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openButton);
    expect(calls.some((call) => call.url.endsWith('/creative/images') || call.url.endsWith('/creative/videos'))).toBe(false);

  });

  it('navigates the clicked job’s ready A/B/C outputs in order and enforces gallery bounds', async () => {
    const currentJob = job({
      id: 'three-version-gallery-job', visualMode: 'distinct', imageUrl: null,
      headlines: ['Current version A', 'Current version B', 'Current version C'],
      outputs: [
        output({ id: 'three-a', index: 0, headline: 'Current version A', imageUrl: '/api/creative-assets/three-a' }),
        output({ id: 'three-b', index: 1, headline: 'Current version B', imageUrl: '/api/creative-assets/three-b' }),
        output({ id: 'three-c', index: 2, headline: 'Current version C', imageUrl: '/api/creative-assets/three-c' }),
      ],
    });
    const olderJob = job({ id: 'older-three-version-job', createdAt: '2026-09-24T18:00:00.000Z', headlines: ['Older A', 'Older B'] });
    const calls = installFetch({ jobs: [currentJob, olderJob] });
    render(<CreativeComposer campaign={{ ...campaign, headlines: currentJob.headlines }} />);
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    fireEvent.click(await within(latest).findByRole('button', { name: 'View image for Version C' }));

    const dialog = await screen.findByRole('dialog', { name: 'Version C image draft' });
    expect(screen.getByText('3 of 3')).toBeTruthy();
    const previous = screen.getByRole('button', { name: 'Previous version' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next version' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    fireEvent.click(previous);
    expect(dialog.querySelector('h2')?.textContent).toBe('Version B image draft');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/api/creative-assets/three-b');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(dialog.querySelector('h2')?.textContent).toBe('Version A image draft');
    expect((screen.getByRole('button', { name: 'Previous version' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(next);
    expect(dialog.querySelector('h2')?.textContent).toBe('Version B image draft');
    fireEvent.click(next);
    expect(dialog.querySelector('h2')?.textContent).toBe('Version C image draft');
    expect(calls.some((call) => call.url.endsWith('/creative/images') || call.url.endsWith('/creative/videos'))).toBe(false);
  });

  it('navigates only the clicked job’s ready A and C outputs, skipping failed B and enforcing bounds', async () => {
    const currentJob = job({
      id: 'current-gallery-job', status: 'failed', visualMode: 'distinct', imageUrl: null,
      headlines: ['Current version A', 'Current version B', 'Current version C'],
      outputs: [
        output({ id: 'current-a', index: 0, headline: 'Current version A', imageUrl: '/api/creative-assets/current-a' }),
        output({ id: 'current-b', index: 1, headline: 'Current version B', status: 'failed', imageUrl: null, error: 'B did not finish.' }),
        output({ id: 'current-c', index: 2, headline: 'Current version C', imageUrl: '/api/creative-assets/current-c' }),
      ],
    });
    const olderJob = job({ id: 'older-gallery-job', createdAt: '2026-09-24T18:00:00.000Z', headlines: ['Older A', 'Older B'] });
    const calls = installFetch({ jobs: [currentJob, olderJob] });
    render(<CreativeComposer campaign={{ ...campaign, headlines: currentJob.headlines }} />);
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    fireEvent.click(await within(latest).findByRole('button', { name: 'View image for Version C' }));

    const dialog = await screen.findByRole('dialog', { name: 'Version C image draft' });
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/api/creative-assets/current-c');
    const previous = screen.getByRole('button', { name: 'Previous version' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next version' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(true);

    fireEvent.click(previous);
    expect(dialog.querySelector('h2')?.textContent).toBe('Version A image draft');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/api/creative-assets/current-a');
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(next);
    expect(dialog.querySelector('h2')?.textContent).toBe('Version C image draft');
    expect(dialog.querySelector('img')?.getAttribute('alt')).toContain('Version C');
    expect(calls.some((call) => call.url.endsWith('/creative/images') || call.url.endsWith('/creative/videos'))).toBe(false);
  });

  it('keeps finished-ad mode across shared-photo headlines and revokes the whole gallery on close', async () => {
    const canvas = installCanvasPreviewSupport();
    const shared = job({
      id: 'shared-finished-job', imageUrl: '/api/creative-assets/shared-photo',
      headlines: ['Caption for version A', 'A different caption for version B'],
    });
    const calls = installFetch({ jobs: [shared] });
    render(<CreativeComposer campaign={{ ...campaign, headlines: shared.headlines }} />);
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    const firstPreview = latest.querySelector('.finished-ad-preview') as HTMLElement;
    const inspect = within(firstPreview).getByRole('button', { name: 'Inspect full size' });
    await waitFor(() => expect((inspect as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(inspect);

    const dialog = await screen.findByRole('dialog', { name: 'Finished ad for Version A' });
    await screen.findByText('1 of 2');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:finished-ad-1');
    expect(dialog.querySelector('img')?.getAttribute('alt')).toContain('Caption for version A');
    fireEvent.click(screen.getByRole('button', { name: 'Next version' }));
    expect(dialog.querySelector('h2')?.textContent).toBe('Finished ad for Version B');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:finished-ad-2');
    expect(dialog.querySelector('img')?.getAttribute('alt')).toContain('A different caption for version B');
    expect(canvas.urlsCreated).toEqual(['blob:finished-ad-1', 'blob:finished-ad-2']);

    fireEvent.click(screen.getByRole('button', { name: 'Close media viewer' }));
    expect(canvas.urlsRevoked).toContain('blob:finished-ad-1');
    expect(canvas.urlsRevoked).toContain('blob:finished-ad-2');
    expect(calls.some((call) => call.url.endsWith('/creative/images') || call.url.endsWith('/creative/videos'))).toBe(false);
  });

  it('ignores a finished gallery decode that completes after the viewer is closed', async () => {
    const canvas = installCanvasPreviewSupport(3);
    const shared = job({
      id: 'stale-finished-job', imageUrl: '/api/creative-assets/stale-photo',
      headlines: ['Stale test headline A', 'Stale test headline B'],
    });
    installFetch({ jobs: [shared] });
    render(<CreativeComposer campaign={{ ...campaign, headlines: shared.headlines }} />);
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    const firstPreview = latest.querySelector('.finished-ad-preview') as HTMLElement;
    const inspect = within(firstPreview).getByRole('button', { name: 'Inspect full size' });
    await waitFor(() => expect((inspect as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(inspect);
    const dialog = await screen.findByRole('dialog', { name: 'Finished ad for Version A' });
    await waitFor(() => expect(canvas.isDeferredDecodeStarted()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Close media viewer' }));
    await act(async () => {
      canvas.resolveDeferredDecode();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(canvas.urlsCreated).toEqual(['blob:finished-ad-1']);
    expect(canvas.urlsRevoked).toEqual(['blob:finished-ad-1']);
    expect(dialog.isConnected).toBe(false);
  });

  it('pins the accepted generation, exposes ready partial output immediately, and updates it during polling without opening the archive', async () => {
    const acceptedJob = job({
      id: 'accepted-latest', status: 'generating', visualMode: 'distinct', imageUrl: null,
      headlines: ['First approved headline', 'Second approved headline'],
      outputs: [
        output({ id: 'accepted-output-ready', index: 0, headline: 'First approved headline', imageUrl: '/api/creative-assets/accepted-output-ready' }),
        output({ id: 'accepted-output-working', index: 1, headline: 'Second approved headline', status: 'generating', imageUrl: null }),
      ],
    });
    const completedJob: CreativeImageJob = {
      ...acceptedJob, status: 'ready', updatedAt: '2026-09-25T18:02:00.000Z',
      outputs: acceptedJob.outputs?.map((item, index) => index === 1 ? { ...item, status: 'ready', imageUrl: '/api/creative-assets/accepted-output-working' } : item),
    };
    const older = job({ id: 'older-saved', createdAt: '2026-09-24T18:00:00.000Z' });
    const calls = installFetch({
      imageResponses: [() => ({ job: acceptedJob, status: 202 })],
      jobReads: (readIndex) => readIndex === 0 ? [older] : [older, completedJob],
    });
    render(<CreativeComposer campaign={{ ...campaign, headlines: acceptedJob.headlines }} />);
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    fireEvent.click(screen.getByRole('button', { name: 'Generate 2 images' }));

    expect(await within(latest).findByText('1 of 2 separate visuals ready')).toBeTruthy();
    expect(within(latest).getByRole('img', { name: 'Portrait ad preview for Version A' })).toBeTruthy();
    expect(within(latest).getAllByText('Generating').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Reload saved jobs' }).closest('details')).toBeNull();
    await waitFor(() => expect(within(latest).getByText('2 of 2 separate visuals ready')).toBeTruthy(), { timeout: 5_000 });
    expect(within(latest).getByRole('img', { name: 'Portrait ad preview for Version B' })).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith('/creative/images'))).toHaveLength(1);
    expect(screen.getByText('Saved creative drafts').closest('details')?.open).toBe(false);
    const archive = screen.getByText('Saved creative drafts').closest('details')!;
    expect(within(archive).queryByText('First approved headline')).toBeNull();
    expect(screen.getAllByText('First approved headline')).toHaveLength(1);
  }, 8_000);

  it('restores the current generation by campaign without duplicating it in the collapsed archive', async () => {
    const first = job({ id: 'first-campaign-job' });
    const secondCampaign: Campaign = { ...campaign, id: 'campaign-image-test-2', name: 'Notebook launch' };
    const second = job({ id: 'second-campaign-job', campaignId: secondCampaign.id, headlines: ['Notebook headline one', 'Notebook headline two'] });
    const olderSecond = job({ id: 'older-second-campaign-job', campaignId: secondCampaign.id, headlines: ['Old notebook one', 'Old notebook two'], createdAt: '2026-09-24T18:00:00.000Z' });
    installFetch({ jobReads: (readIndex) => readIndex === 0 ? [first] : [second, olderSecond] });
    const view = render(<CreativeComposer campaign={campaign} />);
    const firstLatest = await screen.findByRole('region', { name: 'Latest creative' });
    expect(await within(firstLatest).findByRole('button', { name: 'View image for Version A' })).toBeTruthy();
    view.rerender(<CreativeComposer campaign={secondCampaign} />);
    const secondLatest = await screen.findByRole('region', { name: 'Latest creative' });
    expect(within(secondLatest).getByText('Notebook headline one')).toBeTruthy();
    expect(await within(secondLatest).findByRole('button', { name: 'View image for Version A' })).toBeTruthy();
    const archive = screen.getByText('Saved creative drafts').closest('details')!;
    expect(archive.open).toBe(false);
    expect(within(archive).queryByText('Notebook headline one')).toBeNull();
  });

  it('features the newest saved request on reload even when an older request is still processing', async () => {
    const olderActive = job({
      id: 'older-active-job', status: 'generating', headlines: ['Older in-progress one', 'Older in-progress two'],
      createdAt: '2026-09-24T18:00:00.000Z', updatedAt: '2026-09-24T18:00:00.000Z',
    });
    const newestFailed = job({
      id: 'newest-failed-job', status: 'failed', headlines: ['Newest failed one', 'Newest failed two'],
      imageUrl: null, error: 'This latest request failed.',
    });
    const calls = installFetch({ jobs: [olderActive, newestFailed] });
    render(<CreativeComposer campaign={{ ...campaign, headlines: newestFailed.headlines }} />);
    const latest = await screen.findByRole('region', { name: 'Latest creative' });
    expect(within(latest).getByText('Needs attention')).toBeTruthy();
    expect(within(latest).getByText('This latest request failed.')).toBeTruthy();
    expect(screen.getByText('Saved creative drafts').closest('details')?.open).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/creative/images') || call.url.endsWith('/creative/videos'))).toBe(false);
  });
});
