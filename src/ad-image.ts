export const FINISHED_AD_WIDTH = 1_080;
export const FINISHED_AD_HEIGHT = 1_350;
export const FINISHED_AD_CTA = 'Join the waitlist';

export interface FinishedAdLineLayout {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  startY: number;
}

export interface ContainedImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function containImageRect(
  sourceWidth: number,
  sourceHeight: number,
  box: { x: number; y: number; width: number; height: number },
): ContainedImageRect {
  if (![sourceWidth, sourceHeight, box.width, box.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Image and preview dimensions must be positive.');
  }
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

export function layoutFinishedAdHeadline(
  context: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
  headline: string,
  maxWidth = 936,
  maxHeight = 184,
): FinishedAdLineLayout {
  const text = headline;
  for (let fontSize = 60; fontSize >= 30; fontSize -= 2) {
    context.font = `600 ${fontSize}px Georgia, 'Times New Roman', serif`;
    const lines = wrapHeadline(context, text, maxWidth);
    const lineHeight = Math.round(fontSize * 1.13);
    const blockHeight = lines.length * lineHeight;
    if (blockHeight <= maxHeight) {
      return { lines, fontSize, lineHeight, startY: 1_016 + Math.round((maxHeight - blockHeight) / 2) };
    }
  }
  context.font = "600 30px Georgia, 'Times New Roman', serif";
  const lines = wrapHeadline(context, text, maxWidth);
  const lineHeight = 34;
  if (lines.length * lineHeight > maxHeight) {
    throw new Error('This saved headline does not fit the portrait ad layout. The original image and full headline are still available.');
  }
  return { lines, fontSize: 30, lineHeight, startY: 1_016 + Math.round((maxHeight - lines.length * lineHeight) / 2) };
}

export function drawFinishedAd(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  headline: string,
  cta = FINISHED_AD_CTA,
): void {
  canvas.width = FINISHED_AD_WIDTH;
  canvas.height = FINISHED_AD_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable in this browser.');

  context.fillStyle = '#f7f5ef';
  context.fillRect(0, 0, FINISHED_AD_WIDTH, FINISHED_AD_HEIGHT);

  const stage = { x: 48, y: 48, width: 984, height: 936 };
  context.fillStyle = '#eeece5';
  context.fillRect(stage.x, stage.y, stage.width, stage.height);

  const imageArea = stage;
  const imageRect = containImageRect(image.naturalWidth, image.naturalHeight, imageArea);
  context.drawImage(image, imageRect.x, imageRect.y, imageRect.width, imageRect.height);

  context.fillStyle = '#b7c2b3';
  context.fillRect(72, 1_000, 74, 3);

  const layout = layoutFinishedAdHeadline(context, headline);
  context.fillStyle = '#222b24';
  context.textAlign = 'left';
  context.textBaseline = 'top';
  context.font = `600 ${layout.fontSize}px Georgia, 'Times New Roman', serif`;
  layout.lines.forEach((line, index) => context.fillText(line, 72, layout.startY + index * layout.lineHeight, 936));

  context.fillStyle = '#315c43';
  context.beginPath();
  if (typeof context.roundRect === 'function') context.roundRect(72, 1_234, 280, 64, 15);
  else context.rect(72, 1_234, 280, 64);
  context.fill();
  context.fillStyle = '#ffffff';
  context.font = '700 25px Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(cta, 212, 1_266, 250);
}

export async function loadFinishedAdImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  if (typeof image.decode === 'function') await image.decode();
  else await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The original image could not be loaded.'));
  });
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('The original image could not be loaded.');
  return image;
}

export function finishedAdPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The finished ad PNG could not be created.')), 'image/png');
  });
}

function wrapHeadline(context: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, maxWidth: number): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const characters = Array.from(paragraph);
    if (!characters.length) { lines.push(''); continue; }
    let start = 0;
    while (start < characters.length) {
      let end = start;
      let lastWhitespace = -1;
      while (end < characters.length) {
        const candidate = characters.slice(start, end + 1).join('');
        if (end > start && context.measureText(candidate).width > maxWidth) break;
        if (/\s/u.test(characters[end]!)) lastWhitespace = end;
        end += 1;
      }
      if (end < characters.length && lastWhitespace >= start) end = lastWhitespace + 1;
      if (end === start) end += 1;
      lines.push(characters.slice(start, end).join(''));
      start = end;
    }
  }
  return lines;
}
