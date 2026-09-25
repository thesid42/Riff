import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, Eye } from 'lucide-react';
import { drawFinishedAd, finishedAdPngBlob, loadFinishedAdImage } from './ad-image.js';
import './ad-images.css';

export interface AdImagePreviewProps {
  imageUrl: string;
  headline: string;
  versionLabel: string;
  onInspect: (previewUrl: string) => void;
  onInspectOriginal: () => void;
}

export default function AdImagePreview({ imageUrl, headline, versionLabel, onInspect, onInspectOriginal }: AdImagePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const descriptionId = useId();
  const requestVersion = useRef(0);
  const mounted = useRef(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestVersion.current += 1; };
  }, []);

  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    const canvas = canvasRef.current;
    if (!canvas || typeof CanvasRenderingContext2D === 'undefined') {
      setStatus('unavailable');
      setError('A finished preview needs canvas support. The original image remains available below.');
      return () => { active = false; };
    }
    setStatus('loading');
    setError('');
    void loadFinishedAdImage(imageUrl).then((image) => {
      if (!active || !mounted.current || version !== requestVersion.current) return;
      drawFinishedAd(canvas, image, headline);
      setStatus('ready');
    }).catch((renderError: unknown) => {
      if (!active || !mounted.current || version !== requestVersion.current) return;
      setStatus('unavailable');
      setError(renderError instanceof Error ? renderError.message : 'The finished preview could not be rendered. The original image remains available below.');
    });
    return () => { active = false; if (requestVersion.current === version) requestVersion.current += 1; };
  }, [imageUrl, headline]);

  async function downloadFinishedAd() {
    const canvas = canvasRef.current;
    if (!canvas || status !== 'ready') return;
    const version = requestVersion.current;
    try {
      const blob = await finishedAdPngBlob(canvas);
      if (!mounted.current || requestVersion.current !== version) return;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `riff-finished-ad-version-${versionLabel.toLowerCase()}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      setError('');
    } catch (downloadError) {
      if (!mounted.current || requestVersion.current !== version) return;
      setError(downloadError instanceof Error ? downloadError.message : 'The finished ad PNG could not be downloaded.');
    }
  }

  async function inspectFinishedAd() {
    const canvas = canvasRef.current;
    if (!canvas || status !== 'ready') return;
    const version = requestVersion.current;
    try {
      const blob = await finishedAdPngBlob(canvas);
      if (!mounted.current || requestVersion.current !== version) return;
      const objectUrl = URL.createObjectURL(blob);
      try {
        onInspect(objectUrl);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
      setError('');
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'The finished ad preview could not be opened.');
    }
  }

  return <section className="finished-ad-preview" aria-label={`Finished ad for Version ${versionLabel}`}>
    <div className="finished-ad-canvas-frame">
      <canvas ref={canvasRef} role="img" aria-label={`Portrait ad preview for Version ${versionLabel}`} aria-describedby={descriptionId}>
        Portrait ad for Version {versionLabel}. Headline: {headline}. Call to action: Join the waitlist.
      </canvas>
    </div>
    <p id={descriptionId} className="finished-ad-description">Finished 1080 by 1350 portrait ad. Headline: {headline}. Call to action: Join the waitlist. The complete original photo is fitted without cropping.</p>
    <div className="finished-ad-tools" aria-label={`Actions for Version ${versionLabel}`}>
      <button type="button" className="finished-ad-export" onClick={() => void inspectFinishedAd()} disabled={status !== 'ready'}>
        <Eye size={15} /> Inspect finished ad
      </button>
      <button type="button" className="finished-ad-export" onClick={() => void downloadFinishedAd()} disabled={status !== 'ready'}>
        <ArrowDownToLine size={15} /> {status === 'loading' ? 'Preparing…' : 'Download finished ad'}
      </button>
      <button type="button" className="finished-ad-source-link" aria-label={`Inspect original photo for Version ${versionLabel}`} onClick={onInspectOriginal}>
        Original photo
      </button>
    </div>
    {error && <p className="finished-ad-error" role="status">{error}</p>}
  </section>;
}
