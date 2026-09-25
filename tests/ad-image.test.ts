import { describe, expect, it, vi } from 'vitest';
import {
  containImageRect,
  drawFinishedAd,
  FINISHED_AD_CTA,
  FINISHED_AD_HEIGHT,
  FINISHED_AD_WIDTH,
  finishedAdPngBlob,
  layoutFinishedAdHeadline,
} from '../src/ad-image.js';

describe('finished ad canvas layout', () => {
  it('contains a complete source photo without cropping or distortion', () => {
    const rect = containImageRect(1_024, 1_024, { x: 48, y: 48, width: 984, height: 936 });
    expect(rect).toEqual({ x: 72, y: 48, width: 936, height: 936 });

    const wide = containImageRect(1_600, 900, { x: 0, y: 0, width: 984, height: 936 });
    expect(wide.width / wide.height).toBeCloseTo(1_600 / 900);
    expect(wide.width).toBeLessThanOrEqual(984);
    expect(wide.height).toBeLessThanOrEqual(936);
    expect(() => containImageRect(0, 900, { x: 0, y: 0, width: 984, height: 936 })).toThrow();
  });

  it('draws a portrait ad with the full image and exact headline text', () => {
    const textWidths: string[] = [];
    const context = {
      fillStyle: '', font: '', textAlign: 'left', textBaseline: 'top',
      fillRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), rect: vi.fn(), fill: vi.fn(),
      fillText: vi.fn((text: string) => textWidths.push(text)),
      measureText: (text: string) => ({ width: Array.from(text).length * (Number.parseInt(context.font.match(/(\d+)px/)?.[1] ?? '30', 10) * 0.5) }),
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
    const image = { naturalWidth: 1_024, naturalHeight: 1_024 } as HTMLImageElement;
    const headline = 'A carefully written café headline with every saved word.';

    drawFinishedAd(canvas, image, headline);

    expect(canvas.width).toBe(FINISHED_AD_WIDTH);
    expect(canvas.height).toBe(FINISHED_AD_HEIGHT);
    expect(context.drawImage).toHaveBeenCalledWith(image, 72, 48, 936, 936);
    expect(textWidths.slice(0, -1).join('')).toBe(headline);
    expect(textWidths.at(-1)).toBe(FINISHED_AD_CTA);
  });

  it('wraps full legacy Unicode captions into the safe headline area without dropping characters', () => {
    const context = {
      font: '',
      measureText: (text: string) => ({ width: Array.from(text).length * (Number.parseInt(context.font.match(/(\d+)px/)?.[1] ?? '30', 10) * 0.5) }),
    } as unknown as Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;
    const headline = 'É'.repeat(120);
    const layout = layoutFinishedAdHeadline(context, headline);

    expect(layout.lines.join('')).toBe(headline);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.fontSize).toBeGreaterThanOrEqual(30);
    expect(layout.fontSize).toBeLessThanOrEqual(60);
    expect(layout.startY + layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(1_200);
    expect(layout.lines.every((line) => context.measureText(line).width <= 936)).toBe(true);
  });

  it('keeps pathological historical multiline captions intact and reports when the portrait layout cannot fit them', () => {
    const context = {
      font: '',
      measureText: (text: string) => ({ width: Array.from(text).length * 12 }),
    } as unknown as Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;
    const headline = Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`).join('\n');
    expect(() => layoutFinishedAdHeadline(context, headline)).toThrow('This saved headline does not fit the portrait ad layout.');
  });

  it('creates a PNG blob from the same rendered canvas used for preview', async () => {
    const png = new Blob(['finished-ad'], { type: 'image/png' });
    const toBlob = vi.fn((callback: BlobCallback, type?: string) => callback(type === 'image/png' ? png : null));
    const canvas = { toBlob } as unknown as HTMLCanvasElement;
    await expect(finishedAdPngBlob(canvas)).resolves.toBe(png);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');

    const emptyCanvas = { toBlob: (callback: BlobCallback) => callback(null) } as unknown as HTMLCanvasElement;
    await expect(finishedAdPngBlob(emptyCanvas)).rejects.toThrow('The finished ad PNG could not be created.');
    expect(FINISHED_AD_WIDTH).toBe(1_080);
    expect(FINISHED_AD_HEIGHT).toBe(1_350);
    expect(FINISHED_AD_CTA).toBe('Join the waitlist');
  });
});
