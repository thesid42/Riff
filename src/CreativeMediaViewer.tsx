import { useEffect, useRef, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import './media-viewer.css';

export interface CreativeMediaViewerProps {
  kind: 'image' | 'video';
  src: string;
  title: string;
  alt: string;
  onClose: () => void;
  navigation?: {
    index: number;
    count: number;
    onPrevious: () => void;
    onNext: () => void;
  };
}

export default function CreativeMediaViewer({ kind, src, title, alt, onClose, navigation }: CreativeMediaViewerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;

  function move(direction: -1 | 1) {
    const current = navigationRef.current;
    if (!current || current.count < 2 || current.index + direction < 0 || current.index + direction >= current.count) return;
    mediaRef.current?.pause();
    const nextIndex = current.index + direction;
    const focused = document.activeElement;
    if ((nextIndex === 0 || nextIndex === current.count - 1) && focused instanceof HTMLButtonElement && focused.classList.contains('media-version-arrow')) closeRef.current?.focus();
    if (direction < 0) current.onPrevious();
    else current.onNext();
  }

  useEffect(() => {
    const media = mediaRef.current;
    return () => media?.pause();
  }, [kind, src, navigation?.index]);

  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && focused.disabled && dialogRef.current?.contains(focused)) closeRef.current?.focus();
  }, [navigation?.index]);

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    if (!dialog) return () => { document.body.style.overflow = previousBodyOverflow; };

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const target = event.target;
        if (target instanceof Element && target.closest('video, input, textarea, select, [contenteditable="true"], [role="slider"]')) return;
        if ((navigationRef.current?.count ?? 0) > 1) {
          event.preventDefault();
          move(event.key === 'ArrowLeft' ? -1 : 1);
        }
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
          <div className="media-viewer-controls">
            {navigation && navigation.count > 1 && <nav className="media-version-navigation" aria-label="Preview versions">
              <button className="media-version-arrow" type="button" aria-label="Previous version" aria-keyshortcuts="ArrowLeft" title="Previous version (←)" disabled={navigation.index <= 0} onClick={() => move(-1)}><ChevronLeft size={22} /></button>
              <span className="media-version-position" role="status" aria-live="polite" aria-atomic="true">{navigation.index + 1} of {navigation.count}</span>
              <button className="media-version-arrow" type="button" aria-label="Next version" aria-keyshortcuts="ArrowRight" title="Next version (→)" disabled={navigation.index >= navigation.count - 1} onClick={() => move(1)}><ChevronRight size={22} /></button>
            </nav>}
            <button ref={closeRef} className="icon-button" type="button" aria-label="Close media viewer" onClick={onClose}><X size={18} /></button>
          </div>
        </header>
        <div className="media-viewer-content">
          {kind === 'video'
            ? <video key={`${src}:${navigation?.index ?? 0}`} ref={mediaRef} className="media-viewer-video" src={src} controls preload="metadata" aria-label={alt} />
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
