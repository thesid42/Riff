// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreativeMediaViewer from '../src/CreativeMediaViewer.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function GalleryHarness({ video = false, shared = false }: { video?: boolean; shared?: boolean }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const label = ['A', 'B', 'C'][index];
  return <><button type="button" onClick={() => setOpen(true)}>Open preview</button>{open && <CreativeMediaViewer
    kind={video ? 'video' : 'image'} src={shared ? '/same.mp4' : `/version-${label}.${video ? 'mp4' : 'jpg'}`} title={`Version ${label}`} alt={`Version ${label} preview`}
    onClose={() => setOpen(false)} navigation={{ index, count: 3, onPrevious: () => setIndex((i) => i - 1), onNext: () => setIndex((i) => i + 1) }}
  />}</>;
}

describe('expanded media navigation', () => {
  it('navigates by buttons and arrow keys, respects boundaries, and restores focus after Escape', async () => {
    const user = userEvent.setup();
    render(<GalleryHarness />);
    const opener = screen.getByRole('button', { name: 'Open preview' });
    await user.click(opener);
    expect((screen.getByRole('button', { name: 'Previous version' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('1 of 3');
    await user.click(screen.getByRole('button', { name: 'Next version' }));
    expect(screen.getByRole('dialog', { name: 'Version B' })).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('src')).toBe('/version-B.jpg');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('status').textContent).toBe('3 of 3');
    expect((screen.getByRole('button', { name: 'Next version' }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Version C' })).toBeTruthy();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'Version B' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(screen.getByRole('dialog', { name: 'Version A' })).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(opener);
  });

  it('preserves native video arrow controls and replaces even a shared video when the version changes', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<GalleryHarness video shared />);
    await user.click(screen.getByRole('button', { name: 'Open preview' }));
    const originalVideo = screen.getByLabelText('Version A preview') as HTMLVideoElement;
    fireEvent.keyDown(originalVideo, { key: 'ArrowRight' });
    expect(screen.getByRole('status').textContent).toBe('1 of 3');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close media viewer' }), { key: 'ArrowRight', ctrlKey: true });
    expect(screen.getByRole('status').textContent).toBe('1 of 3');
    await user.click(screen.getByRole('button', { name: 'Next version' }));
    expect(pause).toHaveBeenCalled();
    const nextVideo = screen.getByLabelText('Version B preview') as HTMLVideoElement;
    expect(nextVideo).not.toBe(originalVideo);
    expect(nextVideo.getAttribute('src')).toBe('/same.mp4');
    expect(nextVideo.autoplay).toBe(false);
  });

  it('keeps single media inspection unchanged without inactive gallery controls', () => {
    render(<CreativeMediaViewer kind="image" src="/single.jpg" title="Single image" alt="Single image" onClose={() => undefined} />);
    expect(screen.queryByRole('navigation', { name: 'Preview versions' })).toBeNull();
    expect(screen.getByRole('img').getAttribute('src')).toBe('/single.jpg');
  });
});
