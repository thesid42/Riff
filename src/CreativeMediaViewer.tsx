import { useEffect, useRef, type MouseEvent } from 'react';
import { ExternalLink, X } from 'lucide-react';

export interface CreativeMediaViewerProps {
  kind: 'image' | 'video';
  src: string;
  title: string;
  alt: string;
  onClose: () => void;
}

export default function CreativeMediaViewer({ kind, src, title, alt, onClose }: CreativeMediaViewerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const media = mediaRef.current;
    const dialog = dialogRef.current;
    if (!dialog) return () => { document.body.style.overflow = previousBodyOverflow; };

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) {
        event.preventDefault();
        closeRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      media?.pause();
      document.body.style.overflow = previousBodyOverflow;
      if (openerRef.current?.isConnected) openerRef.current.focus();
    };
  }, []);

  function closeOnBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onCloseRef.current();
  }

  return (
    <div className="media-viewer-backdrop" onMouseDown={closeOnBackdrop}>
      <div className="media-viewer" role="dialog" aria-modal="true" aria-labelledby="media-viewer-title" ref={dialogRef}>
        <header className="media-viewer-heading">
          <div><span className="section-kicker">CAMPAIGN DRAFT</span><h2 id="media-viewer-title">{title}</h2></div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="Close media viewer" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="media-viewer-content">
          {kind === 'video'
            ? <video ref={mediaRef} className="media-viewer-video" src={src} controls preload="metadata" aria-label={alt} />
            : <img className="media-viewer-image" src={src} alt={alt} />}
        </div>
        <footer className="media-viewer-footer">
          <span>{kind === 'video' ? 'Use the video controls to play and inspect this draft.' : 'Full image · fit to window · no crop applied.'}</span>
          <a href={src} target="_blank" rel="noopener noreferrer">Open original <ExternalLink size={14} /></a>
        </footer>
      </div>
    </div>
  );
}
