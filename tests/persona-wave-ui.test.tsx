// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import PersonaWave from '../src/PersonaWave.js';
import { emptyWaveSnapshot, type WaveSnapshot } from '../shared/run.js';
import type { Campaign } from '../shared/types.js';
import { PERSONA_TEMPLATES, type PersonaTemplate } from '../shared/personas.js';

const stamp = '2026-09-25T18:00:00.000Z';
const headlines = ['A clearer way to plan your week', 'Make room for a calmer routine'];

function fixtureCampaign(id = 'campaign-1', customPersonas: PersonaTemplate[] = []): Campaign {
  return {
    id, name: 'Quiet Pages', product: 'Dotted notebook', audience: 'People planning a busy week', goal: 'signups',
    approvedClaims: ['160 dotted pages'], budgetCents: 10000, currency: 'USD', status: 'draft', runtime: 'idle',
    agentCount: 40, concurrency: 8, headlines: [], customPersonas, createdAt: stamp, updatedAt: stamp,
  };
}

function fixtureWave(overrides: Partial<WaveSnapshot> = {}): WaveSnapshot {
  return { ...emptyWaveSnapshot(), ...overrides };
}

function installApi() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    let body: unknown;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, method, body });

    if (url.endsWith('/run')) return jsonResponse({ wave: fixtureWave({
      runtime: 'running', agentCount: 16, concurrency: 4, experimentId: 'experiment-1', headlines: [...headlines],
      progress: { total: 16, pending: 14, running: 2, succeeded: 0, failed: 0 },
    }) });
    if (url.endsWith('/pause')) return jsonResponse({ wave: fixtureWave({
      runtime: 'paused', agentCount: 16, concurrency: 4, experimentId: 'experiment-1', headlines: [...headlines],
      progress: { total: 16, pending: 14, running: 0, succeeded: 2, failed: 0 },
    }) });
    if (url.endsWith('/resume')) return jsonResponse({ wave: fixtureWave({
      runtime: 'running', agentCount: 16, concurrency: 4, experimentId: 'experiment-1', headlines: [...headlines],
      progress: { total: 16, pending: 14, running: 2, succeeded: 2, failed: 0 },
    }) });
    return jsonResponse({ error: { message: 'Unexpected request.' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function WaveHarness({ initialCampaign = fixtureCampaign(), initialWave = null }: {
  initialCampaign?: Campaign;
  initialWave?: WaveSnapshot | null;
}) {
  const [campaign, setCampaign] = useState(initialCampaign);
  const [wave, setWave] = useState<WaveSnapshot | null>(initialWave);
  return (
    <>
      <button type="button" onClick={() => {
        setCampaign(fixtureCampaign('campaign-2', [
          { ...PERSONA_TEMPLATES[0], id: 'custom-austin', custom: true, label: 'Custom planner · Austin' },
        ]));
        setWave(null);
      }}>Switch campaign</button>
      <PersonaWave key={campaign.id} campaign={campaign} headlines={headlines} creativeJobId="creative-1"
        onClearCreative={vi.fn()} wave={wave} onWave={setWave} onCampaign={vi.fn()} />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('persona experiment setup', () => {
  it('keeps the brief and run action visible while optional settings stay closed', async () => {
    installApi();
    render(<WaveHarness />);

    expect(screen.getByRole('heading', { name: 'Experiment setup' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Next wave brief' })).toBeTruthy();
    expect(screen.getByText(headlines[0])).toBeTruthy();
    expect(screen.getByText(headlines[1])).toBeTruthy();
    expect(screen.getByText('Agents inspect the selected image or video with its headline, then simulate skipping, clicking, or signing up.')).toBeTruthy();
    expect(screen.getByText('A saved creative is selected for the next wave.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start wave' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start wave' }).hasAttribute('disabled')).toBe(false);
    for (const name of ['Next wave settings', 'Choose audience profiles', 'Add a custom persona']) {
      expect(screen.getByText(name, { exact: true }).closest('details')?.open).toBe(false);
    }
    expect(screen.getByLabelText('Number of persona agents').closest('details')?.open).toBe(false);
    expect(screen.getByText('No wave run yet')).toBeTruthy();
  });

  it('starts with the visible draft and settings, then exposes truthful pause and resume controls', async () => {
    const { calls } = installApi();
    const user = userEvent.setup();
    render(<WaveHarness />);

    await user.click(screen.getByText('Next wave settings', { exact: true }));
    fireEvent.change(screen.getByLabelText('Number of persona agents'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('Concurrent persona agents'), { target: { value: '4' } });
    await user.click(screen.getByRole('button', { name: 'Start wave' }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/run'))).toBe(true));
    expect(calls.find((call) => call.url.endsWith('/run'))).toMatchObject({
      url: '/api/campaigns/campaign-1/run', method: 'POST',
      body: { agentCount: 16, concurrency: 4, headlines, creativeJobId: 'creative-1' },
    });
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByText(/Headlines and audience/)).toBeTruthy();
    expect(screen.getByText('0 of 16 agents complete')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByText('2 of 16 agents complete')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(calls.map((call) => call.url)).toEqual([
      '/api/campaigns/campaign-1/run', '/api/campaigns/campaign-1/pause', '/api/campaigns/campaign-1/resume',
    ]);
  });

  it('shows saved wave progress without mislabeling its mutable headlines or an older review', () => {
    installApi();
    const wave = fixtureWave({
      runtime: 'idle', agentCount: 9, concurrency: 3, experimentId: 'experiment-current',
      headlines: ['Mutable draft copy from campaign'],
      progress: { total: 9, pending: 0, running: 0, succeeded: 8, failed: 1 },
      segments: [{
        segment: 'software-engineer-Berlin', label: 'Software engineer · Berlin', sampleSize: 1, views: 1,
        skips: 0, clicks: 1, signups: 1, medianDecideMs: 800, p90DecideMs: 900, medianDwellSeconds: 4,
        averageConfidence: 0.8, averageAttention: 0.7, averageTrust: 0.6, averageIntent: 0.7, topFriction: null,
        noticedFirst: { headline: 1 }, reasons: [],
      }],
      latestDecision: {
        id: 'decision-old', campaignId: 'campaign-1', experimentId: 'experiment-old', action: 'wait',
        explanation: 'This review belongs to an older wave.', hypothesis: '', headlines: [], evidenceIds: [], personaIds: [], needsNewCreative: false, creativeOutcome: null, createdAt: stamp,
      },
    });
    render(<WaveHarness initialWave={wave} />);

    expect(screen.getByText('Latest wave saved')).toBeTruthy();
    expect(screen.getByText('9 of 9 agents complete')).toBeTruthy();
    expect(screen.queryByText('Mutable draft copy from campaign')).toBeNull();
    expect(screen.queryByText('This review belongs to an older wave.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start wave' })).toBeTruthy();
    expect(screen.getByText('Detailed results', { exact: true }).closest('details')?.open).toBe(false);
  });

  it('keeps audience selection inside its disclosure and resets it when the keyed campaign changes', async () => {
    installApi();
    const user = userEvent.setup();
    render(<WaveHarness />);

    expect(screen.getByText('Choose audience profiles', { exact: true }).closest('details')?.open).toBe(false);
    await user.click(screen.getByText('Choose audience profiles', { exact: true }));
    const checkbox = screen.getAllByRole('checkbox')[0];
    await user.click(checkbox);
    expect(screen.getByText(new RegExp(`${PERSONA_TEMPLATES.length - 1} profiles · 40 agents`))).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Switch campaign' }));
    expect(screen.getByText(new RegExp(`${PERSONA_TEMPLATES.length + 1} profiles · 40 agents`))).toBeTruthy();
    expect(screen.getByText('Choose audience profiles', { exact: true }).closest('details')?.open).toBe(false);
  });
});
