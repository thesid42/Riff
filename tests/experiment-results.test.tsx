// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExperimentResults from '../src/ExperimentResults.js';
import { emptyMetricsSnapshot, type Experiment, type Variant } from '../shared/types.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const latest: Experiment = {
  id: 'latest', campaignId: 'campaign', hypothesis: 'Compare two headlines', status: 'completed',
  variantIds: ['new-b', 'new-a'], windowStart: null, windowEnd: null, createdAt: '2026-09-25T18:00:00Z',
};
function variant(id: string, experimentId: string, overrides: Partial<Variant> = {}): Variant {
  return { id, experimentId, campaignId: 'campaign', label: id.endsWith('a') ? 'A' : 'B', headline: `Saved ${id} headline`, offer: '', status: 'ready', imageUrl: null, videoUrl: null, parentId: null, createdAt: latest.createdAt, ...overrides };
}

describe('experiment results', () => {
  it('identifies text-only snapshots and keeps old waves separate from current metrics', async () => {
    const user = userEvent.setup();
    const older: Experiment = { ...latest, id: 'older', variantIds: ['old-a'], createdAt: '2026-09-24T18:00:00Z' };
    const metrics = emptyMetricsSnapshot('campaign');
    metrics.status = 'available';
    metrics.variants = [
      { variantId: 'new-a', totals: { impressions: 10, uniqueVisitors: 10, clicks: 7, signups: 4, spendCents: 0 } },
      { variantId: 'new-b', totals: { impressions: 8, uniqueVisitors: 8, clicks: 2, signups: 0, spendCents: 0 } },
    ];
    render(<ExperimentResults experiments={[older, latest]} variants={[variant('old-a', 'older'), variant('new-a', 'latest'), variant('new-b', 'latest')]} metrics={metrics} currentExperimentId="latest" />);
    expect(screen.getByText('Text-only experiment. No visual was selected when this wave started. Images generated later stay in Campaign.')).toBeTruthy();
    expect(screen.queryByText('No image attached')).toBeNull();
    const currentCards = screen.getAllByRole('article', { name: /Version .* result/ });
    expect(currentCards.map((card) => within(card).getByRole('heading').textContent)).toEqual(['Saved new-b headline', 'Saved new-a headline']);
    expect(within(currentCards[0]).getByText('0%')).toBeTruthy();
    expect(within(currentCards[1]).getByText('40%')).toBeTruthy();
    const history = screen.getByText('Previous experiments').closest('details');
    expect(history?.open).toBe(false);
    await user.click(screen.getByText('Previous experiments'));
    const oldCard = (await screen.findByRole('heading', { name: 'Saved old-a headline' })).closest('article')!;
    expect(within(oldCard).queryByText('Sign-ups')).toBeNull();
    expect(within(oldCard).getByText('Compare two headlines')).toBeTruthy();
    expect(oldCard.querySelector('details')).toBeNull();
    expect(history?.querySelectorAll('details')).toHaveLength(0);
  });

  it('does not show old metrics for a newly started wave that has not loaded yet', () => {
    const metrics = emptyMetricsSnapshot('campaign');
    metrics.status = 'available';
    metrics.variants = [{ variantId: 'new-a', totals: { impressions: 10, uniqueVisitors: 10, clicks: 7, signups: 4, spendCents: 0 } }];
    render(<ExperimentResults experiments={[latest]} variants={[variant('new-a', 'latest')]} metrics={metrics} currentExperimentId="pending-wave" />);
    expect(screen.getByText('Loading this wave’s versions…')).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Version A result' })).toBeNull();
    expect(screen.queryByText('40%')).toBeNull();
  });

  it('shows only the saved visual and opens it for individual inspection', async () => {
    const user = userEvent.setup();
    render(<ExperimentResults experiments={[latest]} variants={[variant('new-a', 'latest', { imageUrl: '/api/creative/image/saved.jpg' })]} metrics={null} currentExperimentId="latest" />);
    expect(screen.getByRole('img', { name: 'Version A saved visual' }).getAttribute('src')).toBe('/api/creative/image/saved.jpg');
    await user.click(screen.getByRole('button', { name: 'View image' }));
    const dialog = screen.getByRole('dialog', { name: 'Version A · saved visual' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/api/creative/image/saved.jpg');
    await user.click(within(dialog).getByRole('button', { name: 'Close media viewer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pauses inline video before opening an independent player', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<ExperimentResults experiments={[latest]} variants={[variant('new-a', 'latest', { videoUrl: '/api/creative/video/saved.mp4' })]} metrics={null} currentExperimentId="latest" />);
    await user.click(screen.getByRole('button', { name: 'Watch video' }));
    expect(pause).toHaveBeenCalledOnce();
    const dialog = screen.getByRole('dialog', { name: 'Version A · saved visual' });
    const player = dialog.querySelector('video')!;
    expect(player.getAttribute('src')).toBe('/api/creative/video/saved.mp4');
    expect(player.autoplay).toBe(false);
  });

  it('navigates only visuals from the opened experiment, skipping text-only versions', async () => {
    const user = userEvent.setup();
    const experiment = { ...latest, variantIds: ['new-a', 'new-b', 'new-c'] };
    render(<ExperimentResults experiments={[experiment]} variants={[
      variant('new-a', 'latest', { imageUrl: '/saved-a.jpg' }),
      variant('new-b', 'latest'),
      variant('new-c', 'latest', { label: 'C', imageUrl: '/saved-c.jpg' }),
      variant('other-a', 'other-wave', { imageUrl: '/other-wave.jpg' }),
    ]} metrics={null} currentExperimentId="latest" />);
    await user.click(screen.getAllByRole('button', { name: 'View image' })[0]);
    expect(screen.getByRole('status').textContent).toBe('1 of 2');
    await user.click(screen.getByRole('button', { name: 'Next version' }));
    const dialog = screen.getByRole('dialog', { name: 'Version C · saved visual' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/saved-c.jpg');
    expect(screen.getByRole('status').textContent).toBe('2 of 2');
    expect((screen.getByRole('button', { name: 'Next version' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
