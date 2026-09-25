// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CreativeComposer from '../src/CreativeComposer.js';
import type { Campaign } from '../shared/types.js';
import type { CreativeImageJob } from '../shared/creative.js';

const timestamp = '2026-09-25T18:00:00.000Z';
const campaign: Campaign = {
  id: 'campaign-image-test', name: 'Bottle launch', product: '750 ml bottle', audience: 'First-time visitors',
  goal: 'signups', approvedClaims: ['750 ml capacity', 'Stainless steel'], budgetCents: 5000, currency: 'USD',
  status: 'draft', createdAt: timestamp, updatedAt: timestamp,
};

function job(overrides: Partial<CreativeImageJob> = {}): CreativeImageJob {
  return {
    id: 'creative-job-1', campaignId: campaign.id, headlines: ['Edited headline A', 'Headline B'], imagePrompt: 'Warm studio image',
    mediaType: 'image', status: 'ready', imageUrl: '/api/creative-assets/creative-job-1', videoUrl: null, videoOptions: null,
    error: null, providerTaskId: null, createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

function installFetch(options: { decision?: unknown; job?: CreativeImageJob } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    let body: unknown;
    if (url.endsWith('/creative')) body = { imagePromptSuggestion: 'Bottle on a soft sage studio surface; leave clear space around it.', capabilities: { image: true, video: false }, jobs: [] };
    else if (url.endsWith('/creative/plan')) body = { decision: options.decision ?? { action: 'propose_test', explanation: 'Compare two factual headlines.', hypothesis: 'The capacity detail may help visitors understand the product.', headlines: ['A 750 ml bottle for every day', 'Steel, made for repeat use'], evidenceIds: [] }, metadata: { model: 'fixture', elapsedMs: 42 } };
    else if (url.endsWith('/creative/images')) body = { job: options.job ?? job() };
    else body = { error: { message: 'Unexpected test request.' } };
    return new Response(JSON.stringify(body), { status: url.includes('/unexpected') ? 404 : 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', { randomUUID: () => '8b46c732-5db7-4f54-a9e2-9d2a6436e5c1' });
  return calls;
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('creative composer', () => {
  it('waits for an explicit paid action and reuses one saved image across reviewed headlines', async () => {
    const calls = installFetch();
    render(<CreativeComposer campaign={campaign} />);
    await screen.findByRole('button', { name: 'Suggest headlines' });
    expect((screen.getByRole('button', { name: 'Generate image' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Suggest headlines' }));
    await screen.findByText('Review these headline drafts');
    expect(calls.filter((call) => call.url.endsWith('/creative/images'))).toHaveLength(0);

    fireEvent.change(screen.getByRole('textbox', { name: 'Version A headline' }), { target: { value: 'Edited headline A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    await screen.findByText('Saved creative drafts');

    const imageCall = calls.find((call) => call.url.endsWith('/creative/images'));
    expect(imageCall).toBeDefined();
    const body = JSON.parse(String(imageCall?.init?.body)) as { requestId: string; headlines: string[]; imagePrompt: string };
    expect(body.requestId).toBe('8b46c732-5db7-4f54-a9e2-9d2a6436e5c1');
    expect(body.headlines).toEqual(['Edited headline A', 'Steel, made for repeat use']);
    expect(body.imagePrompt).toContain('soft sage studio');
    const previews = screen.getAllByRole('img', { name: /Generated image draft shared/ });
    expect(previews).toHaveLength(2);
    expect(previews[0].getAttribute('src')).toBe('/api/creative-assets/creative-job-1');
    expect(previews[1].getAttribute('src')).toBe('/api/creative-assets/creative-job-1');
    expect(screen.getAllByText('Join the waitlist')).toHaveLength(2);
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
});
