// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.js';
import { emptyMetricsSnapshot, type Campaign, type IntegrationStatus } from '../shared/types.js';
import { emptyWaveSnapshot } from '../shared/run.js';

const createdAt = '2026-09-24T18:00:00.000Z';

function fixtureCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1', name: 'Weekend refill', product: 'Reusable bottle', audience: 'People who commute',
    goal: 'signups', approvedClaims: ['Made for repeat use'], budgetCents: 25000, currency: 'USD', status: 'draft',
    runtime: 'idle', agentCount: 40, concurrency: 8, headlines: [], customPersonas: [],
    createdAt, updatedAt: createdAt, ...overrides,
  };
}

function fixtureIntegration(): IntegrationStatus {
  return {
    id: 'liquid', name: 'Liquid AI', purpose: 'Experiment suggestions', status: 'not_configured', provider: 'Liquid AI',
    missing: ['LIQUID_BASE_URL'], message: 'Configure LIQUID_BASE_URL to enable this integration.',
  };
}

function installApi(options: {
  rejectCreate?: boolean;
  integrations?: IntegrationStatus[];
  campaigns?: Campaign[];
  runResponse?: () => Promise<Response>;
  creativeResponses?: Record<string, {
    imagePromptSuggestion: string;
    jobs: unknown[];
    headlines?: string[];
    capabilities?: { image?: boolean; video?: boolean };
  }>;
} = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const campaign = fixtureCampaign();
  const campaigns = options.campaigns ?? [campaign];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    let body: unknown;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, body });

    if (method === 'POST' && url === '/api/campaigns' && options.rejectCreate) {
      return jsonResponse({ error: { code: 'validation_error', message: 'Campaign details are invalid.' } }, 400);
    }
    if (method === 'POST' && url === '/api/campaigns') return jsonResponse({ campaign });
    if (method === 'POST' && /^\/api\/campaigns\/[^/]+\/run$/.test(url)) return options.runResponse ? options.runResponse() : jsonResponse({ wave: emptyWaveSnapshot() });
    if (url === '/api/campaigns') return jsonResponse({ campaigns: options.campaigns ?? [] });
    if (url === '/api/integrations') return jsonResponse({ integrations: options.integrations ?? [] });
    const creativeCampaign = campaigns.find((item) => url === `/api/campaigns/${item.id}/creative`);
    if (creativeCampaign) return jsonResponse(options.creativeResponses?.[creativeCampaign.id] ?? {
      imagePromptSuggestion: `Product photography for ${creativeCampaign.product}.`, jobs: [],
    });
    const selectedCampaign = campaigns.find((item) => url === `/api/campaigns/${item.id}`);
    if (selectedCampaign) return jsonResponse({ campaign: selectedCampaign, variants: [], experiments: [], lessons: [] });
    const metricsCampaign = campaigns.find((item) => url === `/api/campaigns/${item.id}/metrics`);
    if (metricsCampaign) return jsonResponse(emptyMetricsSnapshot(metricsCampaign.id));
    return jsonResponse({ error: { code: 'not_found', message: 'Unexpected request.' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

async function fillCampaignForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /Campaign name/ }), 'Weekend refill');
  await user.type(screen.getByRole('textbox', { name: /Product/ }), 'Reusable bottle');
  await user.type(screen.getByRole('textbox', { name: /Target audience/ }), 'People who commute');
  await user.type(screen.getByRole('textbox', { name: /Approved claims/ }), 'Made for repeat use');
  await user.type(screen.getByRole('spinbutton', { name: 'Demo budget in US dollars' }), '250');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Riff dashboard', () => {
  it('ignores a previous campaign’s pending wave response after switching campaigns', async () => {
    let finishRun!: (response: Response) => void;
    const first = fixtureCampaign({ headlines: ['First saved headline', 'Second saved headline'] });
    const second = fixtureCampaign({ id: 'campaign-2', name: 'Other campaign', headlines: ['Other headline A', 'Other headline B'] });
    const { calls } = installApi({ campaigns: [first, second], runResponse: () => new Promise((resolve) => { finishRun = resolve; }) });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Generate 2 images' });
    await user.click(screen.getByRole('button', { name: 'Experiments', exact: true }));
    await user.click(screen.getByRole('button', { name: 'Start wave' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/run'))).toBe(true));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Choose campaign' }), second.id);
    await waitFor(() => expect(calls.some((call) => call.url === '/api/campaigns/campaign-2')).toBe(true));
    await act(async () => finishRun(jsonResponse({ wave: { ...emptyWaveSnapshot(), experimentId: 'old-campaign-wave', headlines: first.headlines, progress: { total: 8, succeeded: 8, failed: 0, pending: 0, running: 0 } } })));
    expect(screen.getByText('No wave run yet')).toBeTruthy();
    expect(screen.queryByText('8 of 8 agents complete')).toBeNull();
    expect(screen.getByText(second.headlines[0])).toBeTruthy();
  });

  it('keeps the results-first empty dashboard and makes no campaign or provider actions automatically', async () => {
    const { calls } = installApi();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Start with a campaign brief.' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Campaign metrics' })).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('No wave results yet')).toBeTruthy();
    expect(screen.getByText('No campaign content yet')).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.url === '/api/integrations')).toBe(true));
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(calls.map((call) => call.url).sort()).toEqual(['/api/campaigns', '/api/integrations']);
  });

  it('saves a draft with integer cents and claim lines without starting generation', async () => {
    const { calls } = installApi();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create campaign draft' }));
    await fillCampaignForm(user);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await screen.findByRole('heading', { name: 'Your campaign draft is saved.' });
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post).toMatchObject({
      url: '/api/campaigns',
      method: 'POST',
      body: {
        name: 'Weekend refill', product: 'Reusable bottle', audience: 'People who commute', goal: 'signups',
        approvedClaims: ['Made for repeat use'], budgetCents: 25000, currency: 'USD',
      },
    });
    expect(calls.some((call) => /generate|simulate|launch|liquid|bfl/i.test(call.url))).toBe(false);
    expect(calls.some((call) => call.url === '/api/campaigns/campaign-1/metrics')).toBe(true);
  });

  it('keeps the form open and explains a failed save', async () => {
    installApi({ rejectCreate: true });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create campaign draft' }));
    await fillCampaignForm(user);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Campaign details are invalid.');
    expect(screen.getByRole('dialog', { name: 'Create a campaign draft' })).toBeTruthy();
  });

  it('keeps keyboard focus inside the setup drawer and restores the opener on Escape', async () => {
    installApi({ integrations: [fixtureIntegration()] });
    const user = userEvent.setup();
    render(<App />);
    const setupButton = await screen.findByRole('button', { name: 'Setup', exact: true });
    await user.click(setupButton);

    const closeButton = await screen.findByRole('button', { name: 'Close panel' });
    expect(document.activeElement).toBe(closeButton);
    await user.tab({ shift: true });
    const lastButton = screen.getByRole('button', { name: 'View connections' });
    expect(document.activeElement).toBe(lastButton);
    await user.tab();
    expect(document.activeElement).toBe(closeButton);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Setup status' })).toBeNull());
    expect(document.activeElement).toBe(setupButton);
  });

  it('reveals required setting names only after the user opens the details', async () => {
    installApi({ integrations: [fixtureIntegration()] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Connections' }));
    expect(await screen.findByText('Some required local settings are not present.')).toBeTruthy();
    expect(screen.queryByText('LIQUID_BASE_URL')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'View missing settings' }));
    expect(screen.getByText('LIQUID_BASE_URL')).toBeTruthy();
  });

  it('restores headlines from ready legacy jobs and keeps campaign drafts isolated while navigating', async () => {
    const imageHeadlines = ['A bottle for daily refills', 'Stay ready for the next refill'];
    const videoHeadlines = ['Water for the whole commute', 'Take a refill wherever you go'];
    const customPersona = {
      id: 'custom-commuter', ageBand: '25-34' as const, work: 'specialist' as const, job: 'commuter',
      country: 'United States', location: 'Seattle', language: 'English', device: 'phone' as const,
      household: 'partner' as const, label: '25–34 commuter · Seattle, United States',
      card: 'You commute by train and look for practical products.', custom: true,
    };
    const campaignOne = fixtureCampaign({ id: 'campaign-1', customPersonas: [customPersona] });
    const campaignTwo = fixtureCampaign({
      id: 'campaign-2', name: 'Desk refill', product: 'Insulated bottle', audience: 'Office workers', customPersonas: [],
    });
    const legacyImageJob = {
      id: 'legacy-image-job', campaignId: campaignOne.id, headlines: imageHeadlines,
      imagePrompt: 'An insulated bottle on a desk.', mediaType: 'image', status: 'ready',
      imageUrl: null, videoUrl: null, videoOptions: null, error: null, providerTaskId: null,
      createdAt, updatedAt: createdAt,
    };
    const legacyVideoJob = {
      id: 'legacy-video-job', campaignId: campaignTwo.id, headlines: videoHeadlines,
      imagePrompt: 'A short bottle video on a commute.', mediaType: 'video', status: 'ready',
      imageUrl: null, videoUrl: null, videoOptions: null, error: null, providerTaskId: null,
      createdAt, updatedAt: createdAt,
    };
    const { calls } = installApi({
      campaigns: [campaignOne, campaignTwo],
      creativeResponses: {
        [campaignOne.id]: {
          imagePromptSuggestion: 'A clean product photo of a reusable bottle.',
          headlines: [], jobs: [legacyImageJob], capabilities: { image: true, video: true },
        },
        [campaignTwo.id]: {
          imagePromptSuggestion: 'A clean product photo of an insulated bottle.',
          headlines: [], jobs: [legacyVideoJob], capabilities: { image: true, video: true },
        },
      },
    });
    const user = userEvent.setup();
    render(<App />);

    const versionsTitle = await screen.findByText('Versions', { exact: true });
    expect(versionsTitle.closest('details')?.open).toBe(false);
    expect((screen.getByRole('button', { name: 'Generate 2 images' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(versionsTitle);
    const firstHeadline = await screen.findByRole('textbox', { name: 'Version A headline' }) as HTMLInputElement;
    await waitFor(() => expect(firstHeadline.value).toBe(imageHeadlines[0]));
    expect((screen.getByRole('textbox', { name: 'Version B headline' }) as HTMLInputElement).value).toBe(imageHeadlines[1]);
    expect((screen.getByRole('button', { name: 'Generate 2 images' }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/creative/images'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Experiments', exact: true }));
    expect(within(await screen.findByRole('list', { name: 'Headlines for the next wave' })).getByText(imageHeadlines[0])).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start wave' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('1 saved on this campaign')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Campaign', exact: true }));
    await user.click(screen.getByText('Versions', { exact: true }));
    await user.clear(screen.getByRole('textbox', { name: 'Version A headline' }));
    await user.type(screen.getByRole('textbox', { name: 'Version A headline' }), 'A different unsaved caption');
    await user.click(screen.getByRole('button', { name: 'Select for experiment' }));
    expect(await screen.findByText(/A saved creative is selected for the next wave/)).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Headlines for the next wave' })).getByText(imageHeadlines[0])).toBeTruthy();
    expect(screen.queryByText('A different unsaved caption')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start wave' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/campaigns/campaign-1/run')).toBe(true));
    expect(calls.find((call) => call.method === 'POST' && call.url === '/api/campaigns/campaign-1/run')?.body).toMatchObject({
      headlines: imageHeadlines,
      creativeJobId: 'legacy-image-job',
    });

    await user.click(screen.getByRole('button', { name: 'Campaign', exact: true }));
    await user.click(screen.getByText('Versions', { exact: true }));
    const editedHeadline = 'Refill anywhere on the go';
    await user.clear(screen.getByRole('textbox', { name: 'Version A headline' }));
    await user.type(screen.getByRole('textbox', { name: 'Version A headline' }), editedHeadline);
    await user.click(screen.getByRole('button', { name: 'Experiments', exact: true }));
    expect(within(await screen.findByRole('list', { name: 'Headlines for the next wave' })).getByText(editedHeadline)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Campaign', exact: true }));
    await user.click(screen.getByText('Versions', { exact: true }));
    expect((screen.getByRole('textbox', { name: 'Version A headline' }) as HTMLInputElement).value).toBe(editedHeadline);
    await user.clear(screen.getByRole('textbox', { name: 'Version B headline' }));
    await user.click(screen.getByRole('button', { name: 'Experiments', exact: true }));
    expect(await screen.findByText('Add 2–3 unique, non-empty headlines of up to 60 characters in Campaign before starting.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start wave' }) as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Choose campaign' }), campaignTwo.id);
    await user.click(screen.getByRole('button', { name: 'Campaign', exact: true }));
    await user.click(screen.getByText('Versions', { exact: true }));
    const secondCampaignHeadline = await screen.findByRole('textbox', { name: 'Version A headline' }) as HTMLInputElement;
    await waitFor(() => expect(secondCampaignHeadline.value).toBe(videoHeadlines[0]));
    expect((screen.getByRole('textbox', { name: 'Version B headline' }) as HTMLInputElement).value).toBe(videoHeadlines[1]);
    expect(secondCampaignHeadline.value).not.toBe(editedHeadline);
    await user.click(screen.getByRole('button', { name: 'Experiments', exact: true }));
    expect(within(await screen.findByRole('list', { name: 'Headlines for the next wave' })).getByText(videoHeadlines[0])).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start wave' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
