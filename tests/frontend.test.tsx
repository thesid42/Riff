// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.js';
import { emptyMetricsSnapshot, type Campaign, type IntegrationStatus } from '../shared/types.js';

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

function installApi(options: { rejectCreate?: boolean; integrations?: IntegrationStatus[] } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const campaign = fixtureCampaign();
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
    if (url === '/api/campaigns') return jsonResponse({ campaigns: [] });
    if (url === '/api/integrations') return jsonResponse({ integrations: options.integrations ?? [] });
    if (url === `/api/campaigns/${campaign.id}`) return jsonResponse({ campaign, variants: [], experiments: [], lessons: [] });
    if (url === `/api/campaigns/${campaign.id}/metrics`) return jsonResponse(emptyMetricsSnapshot(campaign.id));
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
  it('keeps the results-first empty dashboard and makes no campaign or provider actions automatically', async () => {
    const { calls } = installApi();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Start with a campaign brief.' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Campaign metrics' })).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('No trend data yet')).toBeTruthy();
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
});
