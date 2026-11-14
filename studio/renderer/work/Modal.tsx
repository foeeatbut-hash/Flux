import React, { useEffect, useRef } from 'react';

/** Простое модальное окно (`scoped` — только поверх ближайшего родителя с position: relative, например окна программы): свой диалог Flux (WindowDialog) завязан на рабочий стол Flux, которого в Studio нет */
export default function Modal({ title, onClose, children, wide, huge, scoped }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; huge?: boolean; scoped?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Кнопка с data-autofocus — безопасный ответ по умолчанию (например «Только сейчас»); иначе первое поле или кнопка
    (box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('input, select, textarea, button'))?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={`studio-modal-back studio-body${scoped ? ' scoped' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={`studio-modal${wide ? ' wide' : ''}${huge ? ' huge' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="studio-modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
