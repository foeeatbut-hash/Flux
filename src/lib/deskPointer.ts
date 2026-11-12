import React from 'react';
import { isEmptyDeskTarget } from '../../workspace/deskFocus';
import { useDisplayStore } from '../store/displayStore';

/**
 * Окно сообщает главному процессу, стоит ли указатель над пустым столом
 * (windows-layer.md): пока Flux не активен, это решает, поднимет ли нажатие
 * Flux над Word. Наведение доходит и до неактивного окна, поэтому слежение
 * идёт всегда, а решает главный процесс по активности окна.
 *
 * Шлётся только смена значения. После потери активности главный процесс
 * забывает положение указателя, поэтому `blur` стирает и нашу память:
 * следующее движение отправит значение заново, даже если оно «то же».
 */
export function installDeskPointer(doc: Document, send: (overDesk: boolean) => void): () => void {
  const win = doc.defaultView;
  let last: boolean | null = null;
  const emit = (value: boolean) => { if (value === last) return; last = value; send(value); };
  const onMove = (event: Event) => emit(isEmptyDeskTarget(event.target as Element | null));
  // Указатель ушёл за окно (на Word, на панель Windows): стола под ним больше нет.
  const onOut = (event: MouseEvent) => { if (!event.relatedTarget) emit(false); };
  const onBlur = () => { last = null; };
  doc.addEventListener('pointermove', onMove, { capture: true, passive: true });
  doc.addEventListener('pointerout', onOut as EventListener, { capture: true, passive: true });
  doc.documentElement.addEventListener('pointerleave', () => emit(false), { passive: true });
  win?.addEventListener('blur', onBlur);
  return () => {
    doc.removeEventListener('pointermove', onMove, { capture: true } as EventListenerOptions);
    doc.removeEventListener('pointerout', onOut as EventListener, { capture: true } as EventListenerOptions);
    win?.removeEventListener('blur', onBlur);
    // Слежение снято: главный процесс не должен остаться с «над столом».
    emit(false);
  };
}

/** Слежение включено, пока режим доступен (Windows) и выключатель не снят. */
export function useDeskPointer() {
  const desk = useDisplayStore(s => s.desk);
  React.useEffect(() => {
    const api = (window as any).electron?.deskFocus;
    if (!api || !desk.available || !desk.enabled) return;
    return installDeskPointer(document, over => { try { api.pointer(over); } catch { /* канал закрыт — окно обычное */ } });
  }, [desk.available, desk.enabled]);
}
