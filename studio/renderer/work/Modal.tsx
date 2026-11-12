import React, { useEffect, useRef } from 'react';

/** Простое модальное окно: свой диалог Flux (WindowDialog) завязан на рабочий стол Flux, которого в Studio нет */
export default function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="studio-modal-back studio-body" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={`studio-modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="studio-modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
