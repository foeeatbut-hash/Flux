/**
 * Показ отказа записи на экране «Справочник».
 *
 * Объяснённый отказ (изменили, удалили, открыт у коллеги) — общий `ConflictNotice` с
 * перечнем «было → стало». Отказ правки стоит над содержимым экрана и остаётся, пока
 * человек его не закроет или не начнёт новое действие: пока он стоит, строка правки с
 * набранным остаётся открытой. Отказ удаления и создания — окном, как у действий без
 * формы. Прочий сбой (нет связи, ошибка сервера) — тост: ставить в рамку каждое
 * «Ошибка сохранения» незачем.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Dialog, Btn } from '../ui';
import ConflictNotice from '../ui/ConflictNotice';
import type { DictRefusal } from './dictWrite';

function DictRefusalView({ refusal, className = '' }: { refusal: DictRefusal; className?: string }) {
  return <ConflictNotice message={refusal.message} className={className} changes={refusal.kind === 'conflict' ? refusal.changes : undefined} />;
}

export interface DictRefusalState {
  showRefusal: (refusal: DictRefusal, mode: 'edit' | 'dialog', title: string) => void;
  clearRefusal: () => void;
  /** Отказ правки над содержимым экрана */
  banner: ReactNode;
  /** Окно отказа удаления и создания */
  dialog: ReactNode;
}

export function useDictRefusal(toast: (text: string, kind: 'error') => void): DictRefusalState {
  const [inline, setInline] = useState<DictRefusal | null>(null);
  const [windowed, setWindowed] = useState<{ title: string; refusal: DictRefusal } | null>(null);

  const showRefusal = useCallback((refusal: DictRefusal, mode: 'edit' | 'dialog', title: string) => {
    if (refusal.kind === 'plain') { toast(refusal.message, 'error'); return; }
    if (mode === 'edit') setInline(refusal); else setWindowed({ title, refusal });
  }, [toast]);
  const clearRefusal = useCallback(() => setInline(null), []);

  const banner = inline && (
    <div data-dict-refusal className="shrink-0 flex items-start gap-3 px-6 pt-3">
      <DictRefusalView refusal={inline} className="flex-1 min-w-0" />
      <Btn onClick={() => setInline(null)}>Понятно</Btn>
    </div>
  );
  const dialog = windowed && (
    <Dialog title={windowed.title} onClose={() => setWindowed(null)} width="max-w-lg" label={windowed.title}
      footer={<Btn tone="primary" onClick={() => setWindowed(null)}>Понятно</Btn>}>
      <div data-refusal-dialog><DictRefusalView refusal={windowed.refusal} /></div>
    </Dialog>
  );
  return { showRefusal, clearRefusal, banner, dialog };
}
